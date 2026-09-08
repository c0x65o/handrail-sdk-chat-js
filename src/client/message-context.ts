import { parseKnownDurableEvent } from "../contracts/generated/durable-events.js";
import type { ConversationId, MessageId } from "../contracts/identifiers.js";
import { parseMessageContextRequest, parseMessageContextResult, type MessageContextRequest, type MessageContextResult } from "../contracts/message-context.js";
import type { MessageTimelineMessage, MessageTimelinePage } from "../contracts/message-timeline.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type { NormalizedChatCache } from "./normalized-cache.js";
import type { ChatSnapshotReader } from "./snapshot-reader.js";

export interface ChatMessageContextState extends MessageContextRequest {
  readonly status: "idle" | "loading" | "loading_window" | "available" | "deleted" | "unavailable" | "error";
  readonly result?: MessageContextResult;
  /** A contiguous window, including the source once; its cursors exclude its outer messages. */
  readonly window?: MessageTimelinePage;
  /** Redacted failure category. Only a successful server read establishes unavailable. */
  readonly error?: string;
}
export interface ChatMessageContext {
  getState(target: MessageContextRequest): ChatMessageContextState;
  subscribe(target: MessageContextRequest, listener: () => void): () => void;
  resolve(target: MessageContextRequest): Promise<ChatMessageContextState>;
  /** Fetches two pages of 25 messages in the original conversation; attachment sources may need one enrichment row. */
  loadSourceWindow(target: MessageContextRequest): Promise<ChatMessageContextState>;
  /** Retries the original lookup or window operation, without changing its target. */
  retry(target: MessageContextRequest): Promise<ChatMessageContextState>;
}
interface Entry {
  readonly target: MessageContextRequest;
  state: ChatMessageContextState;
  generation: number;
  requested: boolean;
  wantsWindow: boolean;
  controller: AbortController;
  resolveTask?: Promise<ChatMessageContextState>;
  windowTask?: Promise<ChatMessageContextState>;
  release?: () => void;
  /** Retained across ordinary invalidation so later access loss can purge all exposed content. */
  hydratedIds: MessageId[];
}
interface Options {
  cache: NormalizedChatCache;
  /** A reader without automatic cache hydration; admission happens after generation checks. */
  reader: ChatSnapshotReader;
  online: () => boolean;
  subscribeConversation?: (id: ConversationId) => (() => void) | undefined;
}

export function createMessageContextRuntime({ cache, reader, online, subscribeConversation }: Options) {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const revoked = new Set<ConversationId>();
  const selectedWindows = new Map<ConversationId, Entry>();
  let epoch = 0;
  let changingCache = false;
  const key = (target: MessageContextRequest) => JSON.stringify([target.conversationId, target.messageId]);
  const entry = (input: MessageContextRequest): Entry => {
    const target = Object.freeze(parseMessageContextRequest(input));
    const id = key(target);
    let e = entries.get(id);
    if (e === undefined) {
      e = { target, state: Object.freeze({ ...target, status: "idle" }), generation: 0,
        requested: false, wantsWindow: false, controller: new AbortController(), hydratedIds: [] };
      entries.set(id, e);
    }
    return e;
  };
  const publish = (e: Entry, state: ChatMessageContextState) => {
    e.state = Object.freeze(state);
    for (const listener of listeners.get(key(e.target)) ?? []) {
      try { listener(); } catch { /* Observers cannot affect admission. */ }
    }
    return e.state;
  };
  const allowed = (e: Entry) => {
    const state = cache.getState();
    if (state.identity === null) return false;
    const conversation = state.entities.conversations[e.target.conversationId];
    const scopes = [e.target.conversationId, ...(conversation?.type === "thread" ? [conversation.parentConversationId] : [])];
    return scopes.every(id => {
      const member = state.currentUser.memberships[id];
      const value = state.entities.conversations[id];
      return !revoked.has(id) && (value === undefined || value.tenantId === state.identity!.tenantId) &&
        (member === undefined || (member.state === "active" && member.userId === state.identity!.userId));
    });
  };
  const guard = (e: Entry) => {
    const generation = e.generation, session = epoch, identity = cache.getState().identity;
    return () => generation === e.generation && session === epoch && identity === cache.getState().identity &&
      !e.controller.signal.aborted && allowed(e);
  };
  const purge = (e: Entry) => {
    const ids = e.hydratedIds; e.hydratedIds = [];
    changingCache = true;
    try { if (ids.length) cache.dispatch({ type: "messages/forget-context", messageIds: ids }); }
    finally { changingCache = false; }
  };
  const invalidate = (e: Entry, error?: string, evict = false) => {
    e.generation++;
    e.controller.abort(); e.controller = new AbortController();
    delete e.resolveTask; delete e.windowTask;
    // A refreshed canonical source (including threadSummary) invalidates derived
    // context and pending windows, but does not withdraw access to the message.
    if (evict) purge(e);
    publish(e, { ...e.target, status: error === undefined ? "idle" : "error", ...(error === undefined ? {} : { error }) });
  };
  const revoke = (id: ConversationId) => {
    revoked.add(id);
    for (const e of entries.values()) {
      const conversation = cache.getState().entities.conversations[e.target.conversationId];
      // Unknown conversation metadata cannot establish that the revoked scope is unrelated.
      if (conversation === undefined || e.target.conversationId === id ||
          (conversation.type === "thread" && conversation.parentConversationId === id)) {
        revoked.add(e.target.conversationId);
        invalidate(e, "access_revoked", true);
        e.release?.(); delete e.release;
      }
    }
  };
  const fail = (e: Entry, error: string) => {
    // A connectivity failure cannot withdraw previously authorized history.
    // Keep the source/window IDs tracked so an actual access loss can purge them.
    if (error !== "offline" && error !== "transport") purge(e);
    return publish(e, { ...e.target, status: "error", error });
  };
  const canonicalPage = (page: MessageTimelinePage): boolean => {
    try {
      for (const { isThreadRoot: _root, reactions: _reactions, attachmentMetadata: _attachments, ...message } of page.messages) {
        if (message.tenantId !== cache.getState().identity?.tenantId) return false;
        const target = { conversationId: page.conversationId, messageId: message.id };
        parseMessageContextResult({ ...target, status: message.deletedAt === undefined ? "available" : "deleted",
          sequence: message.sequence, message }, target);
      }
      return true;
    } catch { return false; }
  };
  const resolveEntry = (e: Entry): Promise<ChatMessageContextState> => {
    e.requested = true;
    if (e.resolveTask !== undefined) return e.resolveTask;
    if (!allowed(e)) return Promise.resolve(fail(e, "access_revoked"));
    if (!online()) return Promise.resolve(fail(e, "offline"));
    if (e.state.result !== undefined) return Promise.resolve(e.state);
    const current = guard(e);
    // Schedule transport after storing the shared promise, including for reentrant observers.
    const task = Promise.resolve().then(async () => {
      if (!current()) return e.state;
      publish(e, { ...e.target, status: "loading" });
      if (!current()) return e.state;
      if (e.release === undefined) {
        const release = subscribeConversation?.(e.target.conversationId);
        if (release !== undefined) e.release = release;
      }
      const response = await reader.getMessageContext(e.target, { signal: e.controller.signal });
      if (!current()) return e.state;
      if (response.status !== "success") return fail(e, response.status);
      const result = response.value;
      const cached = cache.getState().entities.messages[e.target.messageId];
      if (result.status !== "unavailable" && cached !== undefined &&
          (cached.revision.revision > result.message.revision.revision ||
            (cached.deletedAt !== undefined && result.status === "available"))) {
        invalidate(e, "stale_source");
        return e.state;
      }
      if (result.status !== "unavailable" && result.message.tenantId !== cache.getState().identity!.tenantId) return fail(e, "malformed_response");
      if (result.status !== "available") {
        purge(e);
        changingCache = true;
        try { cache.dispatch({ type: "messages/forget-context", messageIds: [e.target.messageId] }); }
        finally { changingCache = false; }
      }
      if (result.status === "available") e.hydratedIds = [...new Set([...e.hydratedIds, e.target.messageId])];
      return publish(e, { ...e.target, status: result.status, result });
    }).catch(() => current() ? fail(e, "transport") : e.state).finally(() => {
      if (e.resolveTask === task) delete e.resolveTask;
    });
    e.resolveTask = task;
    return task;
  };
  const loadWindow = (e: Entry): Promise<ChatMessageContextState> => {
    const previous = selectedWindows.get(e.target.conversationId);
    if (previous !== undefined && previous !== e) {
      previous.wantsWindow = false;
      invalidate(previous);
    }
    selectedWindows.set(e.target.conversationId, e);
    e.wantsWindow = true;
    if (e.windowTask !== undefined) return e.windowTask;
    if (e.state.window !== undefined) return Promise.resolve(e.state);
    const current = guard(e);
    const task = Promise.resolve().then(async () => {
      const resolved = await resolveEntry(e);
      if (!current() || resolved.result?.status !== "available") return e.state;
      const result = resolved.result;
      publish(e, { ...e.target, status: "loading_window", result });
      if (!current()) return e.state;
      const query = { conversationId: e.target.conversationId, cursor: result.sequence, limit: 25 };
      const [older, newer] = await Promise.all([
        reader.getMessageTimeline({ ...query, direction: "backward" }, { signal: e.controller.signal }),
        reader.getMessageTimeline({ ...query, direction: "forward" }, { signal: e.controller.signal }),
      ]);
      if (!current()) return e.state;
      if (older.status !== "success") return fail(e, older.status);
      if (newer.status !== "success") return fail(e, newer.status);
      if (!canonicalPage(older.value) || !canonicalPage(newer.value)) return fail(e, "malformed_response");
      const { threadSummary, ...message } = result.message;
      // Context returns canonical content, not signed attachment transport metadata.
      // Fetch exactly one source row when enrichment is needed, never invent URLs
      // or insert an invalid timeline message with missing attachment metadata.
      let attachmentMetadata: MessageTimelineMessage["attachmentMetadata"] = [];
      let reactions: MessageTimelineMessage["reactions"] = [];
      if ((message.content.attachments?.length ?? 0) > 0) {
        const enriched = await reader.getMessageTimeline({ conversationId: e.target.conversationId,
          direction: "forward", cursor: result.sequence - 1, limit: 1 }, { signal: e.controller.signal });
        if (!current()) return e.state;
        if (enriched.status !== "success") return fail(e, enriched.status);
        if (!canonicalPage(enriched.value)) return fail(e, "malformed_response");
        const row = enriched.value.messages[0];
        if (row === undefined || row.id !== message.id || row.sequence !== message.sequence ||
            row.tenantId !== message.tenantId || row.revision.revision !== message.revision.revision ||
            row.deletedAt !== undefined || JSON.stringify(row.content) !== JSON.stringify(message.content)) return fail(e, "stale_source");
        attachmentMetadata = row.attachmentMetadata;
        reactions = row.reactions;
      }
      const source: MessageTimelineMessage = { ...message, reactions, attachmentMetadata,
        ...(threadSummary === undefined ? { isThreadRoot: false as const } :
          { isThreadRoot: true as const, threadSummary }) };
      const window: MessageTimelinePage = {
        conversationId: e.target.conversationId,
        messages: [...older.value.messages, source, ...newer.value.messages],
        pagination: { older: older.value.pagination.older, newer: newer.value.pagination.newer },
        replay: older.value.replay,
      };
      if (new Set(window.messages.map(message => message.id)).size !== window.messages.length) return fail(e, "malformed_response");
      e.hydratedIds = [...new Set([...e.hydratedIds, ...window.messages.map(message => message.id)])];
      changingCache = true;
      try { cache.dispatch({ type: "messages/hydrate-context-window", page: window }); }
      finally { changingCache = false; }
      if (!current()) return e.state;
      return publish(e, { ...e.target, status: "available", result, window });
    }).catch(() => current() ? fail(e, "transport") : e.state).finally(() => {
      if (e.windowTask === task) delete e.windowTask;
    });
    e.windowTask = task;
    return task;
  };
  const reset = () => {
    epoch++; revoked.clear(); selectedWindows.clear();
    for (const e of entries.values()) {
      e.requested = false; e.wantsWindow = false;
      e.release?.(); delete e.release;
      invalidate(e, undefined, true);
    }
  };
  cache.subscribePrivateStateBoundary(reset);
  cache.subscribe(state => state, (state, previous) => {
    if (state.identity !== previous.identity) { reset(); return; }
    if (changingCache) return;
    for (const e of entries.values()) {
      const id = e.target.conversationId;
      const conversation = previous.entities.conversations[id];
      const scopes = [id, ...(conversation?.type === "thread" ? [conversation.parentConversationId] : [])];
      if (!allowed(e) || scopes.some(scope => previous.entities.conversations[scope] !== undefined && state.entities.conversations[scope] === undefined)) {
        if (!revoked.has(id)) revoke(id);
      } else if (scopes.some(scope => state.currentUser.memberships[scope] !== previous.currentUser.memberships[scope]) ||
          state.entities.messages[e.target.messageId] !== previous.entities.messages[e.target.messageId]) {
        const source = state.entities.messages[e.target.messageId];
        invalidate(e, undefined, source === undefined || source.deletedAt !== undefined);
      }
    }
  });
  const api: ChatMessageContext = Object.freeze({
    getState: (target: MessageContextRequest) => entry(target).state,
    subscribe(target: MessageContextRequest, listener: () => void) {
      const id = key(entry(target).target);
      let set = listeners.get(id);
      if (set === undefined) { set = new Set(); listeners.set(id, set); }
      set.add(listener); return () => { set.delete(listener); };
    },
    resolve: (target: MessageContextRequest) => resolveEntry(entry(target)),
    loadSourceWindow: (target: MessageContextRequest) => loadWindow(entry(target)),
    retry(target: MessageContextRequest) {
      const e = entry(target);
      if (e.windowTask) return e.windowTask;
      if (e.resolveTask) return e.resolveTask;
      invalidate(e);
      return e.wantsWindow ? loadWindow(e) : resolveEntry(e);
    },
  });
  return { api, revoke, closeActive: reset,
    connectionChanged(connected: boolean) {
      epoch++;
      const requested = [...entries.values()].filter(e => e.requested);
      // Revalidate derived previews after reconnect without removing canonical
      // timeline rows: resolving an inline preview does not hydrate them again.
      for (const e of requested) invalidate(e, connected ? undefined : "offline");
      if (connected) void (async () => {
        const session = epoch;
        for (const e of requested) {
          if (session !== epoch) return;
          if (allowed(e)) await (e.wantsWindow ? loadWindow(e) : resolveEntry(e));
        }
      })();
    },
    handleCanonicalEvent(value: unknown) {
      const identity = cache.getState().identity;
      if (identity === null) return;
      try {
        const event = parseKnownDurableEvent(value, identity);
        if (event.protocolVersion !== CHAT_PROTOCOL_VERSION ||
            (event.type !== "message.updated" && event.type !== "message.deleted")) return;
        // Also cancel pages containing an edited/deleted neighbour, even if not cached yet.
        for (const e of entries.values()) if (e.target.conversationId === event.payload.message.conversationId) {
          invalidate(e, undefined, event.type === "message.deleted");
        }
      } catch { /* Only validated canonical events can invalidate source work. */ }
    },
  };
}
