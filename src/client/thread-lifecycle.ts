import { validateThreadLifecycle, type ThreadLifecycle } from "../contracts/conversation.js";
import { parseKnownDurableEvent } from "../contracts/generated/durable-events.js";
import { CHAT_REPLY_THREAD_FEATURES } from "../contracts/generated/realtime-handshake.js";
import type { ConversationId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import {
  parseThreadLifecycleInput, parseThreadLifecycleResult,
  serializeThreadLifecycleBody, type ThreadLifecycleInput, type ThreadLifecycleIntent,
  type ThreadLifecycleResult,
} from "../contracts/thread-lifecycle.js";
import type { ChatCommandDispatcher } from "./command-dispatcher.js";
import type { NormalizedChatCache } from "./normalized-cache.js";
import type { ChatSnapshotReader } from "./snapshot-reader.js";

export interface ChatThreadLifecycleState {
  readonly threadId: ConversationId;
  readonly parentConversationId?: ConversationId;
  readonly status: "idle" | "loading" | "ready" | "updating" | "conflict" | "error" | "unavailable";
  /** Undefined for legacy open/unlocked metadata; never invent a revision. */
  readonly lifecycle?: ThreadLifecycle;
  readonly legacy: boolean;
  readonly actionsAvailable: boolean;
  readonly error?: string;
  readonly pendingInput?: ThreadLifecycleInput;
  readonly result?: ThreadLifecycleResult;
}
export interface ChatThreadLifecycle {
  getState(threadId: ConversationId): ChatThreadLifecycleState;
  subscribe(threadId: ConversationId, listener: () => void): () => void;
  /** Parent scope is explicit so a delayed response cannot select another parent. */
  load(threadId: ConversationId, parentConversationId: ConversationId): Promise<ChatThreadLifecycleState>;
  close(threadId: ConversationId): Promise<ChatThreadLifecycleState>;
  reopen(threadId: ConversationId): Promise<ChatThreadLifecycleState>;
  lock(threadId: ConversationId): Promise<ChatThreadLifecycleState>;
  unlock(threadId: ConversationId): Promise<ChatThreadLifecycleState>;
  /** Repeats the exact original intent/key/revision, including after conflict. */
  retry(threadId: ConversationId): Promise<ChatThreadLifecycleState>;
}
interface Entry {
  state: ChatThreadLifecycleState;
  generation: number;
  read?: AbortController;
  command?: AbortController;
  candidate?: ThreadLifecycle;
  release?: () => void;
}
interface Options {
  cache: NormalizedChatCache;
  /** Must not auto-hydrate the cache: this runtime validates scope before admission. */
  reader: ChatSnapshotReader;
  dispatch: ChatCommandDispatcher["dispatch"];
  enabledFeatures: () => Readonly<Record<string, boolean>>;
  online: () => boolean;
  generateIdempotencyKey: () => string;
  subscribeConversation?: (id: ConversationId) => (() => void) | undefined;
}

/** Shared lifecycle authority, intentionally independent of drafts, sends and reply style. */
export function createThreadLifecycleRuntime(options: Options) {
  const { cache } = options;
  const entries = new Map<ConversationId, Entry>();
  const listeners = new Map<ConversationId, Set<() => void>>();
  const revoked = new Set<ConversationId>();
  let session = 0;
  const entry = (id: ConversationId): Entry => {
    let found = entries.get(id);
    if (found === undefined) {
      found = { generation: 0, state: Object.freeze({
        threadId: id, status: "idle", legacy: false, actionsAvailable: false,
      }) };
      entries.set(id, found);
    }
    return found;
  };
  const allowed = (id: ConversationId, parent: ConversationId, reauthorizing = false): boolean => {
    const state = cache.getState();
    if (state.identity === null || (!reauthorizing && revoked.has(id)) || revoked.has(parent)) return false;
    for (const scope of [id, parent]) {
      const member = state.currentUser.memberships[scope];
      if (member !== undefined && (member.state !== "active" || member.userId !== state.identity.userId)) return false;
      const conversation = state.entities.conversations[scope];
      if (conversation !== undefined && conversation.tenantId !== state.identity.tenantId) return false;
    }
    const thread = state.entities.conversations[id];
    return thread === undefined || (thread.type === "thread" && thread.parentConversationId === parent);
  };
  const available = (state: ChatThreadLifecycleState): boolean => {
    const parent = state.parentConversationId;
    const conversations = cache.getState().entities.conversations;
    return parent !== undefined && allowed(state.threadId, parent) &&
      options.enabledFeatures()[CHAT_REPLY_THREAD_FEATURES.threadLifecycle] === true && options.online() &&
      state.lifecycle !== undefined && state.status !== "loading" && state.status !== "updating" &&
      conversations[state.threadId]?.archivedAt === undefined && conversations[parent]?.archivedAt === undefined;
  };
  const publish = (e: Entry, state: ChatThreadLifecycleState): ChatThreadLifecycleState => {
    const next = Object.freeze({ ...state, actionsAvailable: available(state) });
    if (JSON.stringify(next) === JSON.stringify(e.state)) return e.state;
    e.state = next;
    for (const listener of listeners.get(state.threadId) ?? []) {
      try { listener(); } catch { /* Observers cannot change reconciliation. */ }
    }
    return next;
  };
  const cancel = (e: Entry): void => {
    e.generation++;
    e.read?.abort(); delete e.read;
    e.command?.abort(); delete e.command;
    delete e.candidate;
  };
  const purge = (id: ConversationId): void => {
    const e = entry(id);
    cancel(e);
    e.release?.(); delete e.release;
    publish(e, { threadId: id, ...(e.state.parentConversationId === undefined ? {} :
      { parentConversationId: e.state.parentConversationId }), status: "unavailable",
      legacy: false, actionsAvailable: false, error: "access_revoked" });
  };
  const revoke = (id: ConversationId): void => {
    revoked.add(id);
    for (const [threadId, e] of entries) {
      if (id !== threadId && id !== e.state.parentConversationId) continue;
      revoked.add(threadId);
      purge(threadId);
      // Reuse existing history/reference cleanup; never clear drafts or queued sends here.
      cache.dispatch({ type: "threads/discard-history", threadId });
    }
  };
  const accept = (e: Entry, value: ThreadLifecycle | undefined): void => {
    if (value === undefined) {
      if (e.state.lifecycle === undefined) publish(e, { ...e.state, legacy: true });
      return;
    }
    const lifecycle = Object.freeze(validateThreadLifecycle(value));
    if (e.state.lifecycle !== undefined && lifecycle.revision <= e.state.lifecycle.revision) return;
    publish(e, { ...e.state, lifecycle, legacy: false });
  };
  const guard = (e: Entry, controller: AbortController) => {
    const generation = e.generation;
    const epoch = session;
    const identity = cache.getState().identity;
    const parent = e.state.parentConversationId!;
    return () => !controller.signal.aborted && epoch === session && generation === e.generation &&
      identity === cache.getState().identity && allowed(e.state.threadId, parent);
  };
  const load: ChatThreadLifecycle["load"] = async (id, parent) => {
    const e = entry(id);
    if (e.state.parentConversationId !== undefined && e.state.parentConversationId !== parent) {
      cancel(e);
      publish(e, { threadId: id, parentConversationId: parent, status: "idle", legacy: false, actionsAvailable: false });
    }
    e.read?.abort();
    const controller = new AbortController();
    e.read = controller;
    publish(e, { ...e.state, parentConversationId: parent });
    if (!allowed(id, parent)) return publish(e, { ...e.state, status: "unavailable", error: "access_revoked" });
    const current = guard(e, controller);
    const { error: _error, ...before } = e.state;
    publish(e, { ...before, status: "loading" });
    try {
      if (e.release === undefined) {
        const release = options.subscribeConversation?.(id);
        if (release !== undefined) e.release = release;
      }
      const result = await options.reader.getConversation({ conversationId: id }, { signal: controller.signal });
      if (!current()) return e.state;
      if (result.status !== "success") {
        if ("httpStatus" in result && [401, 403, 404].includes(result.httpStatus ?? 0)) {
          revoke(id); return e.state;
        }
        return publish(e, { ...e.state, status: "error", error: result.status });
      }
      const thread = result.value.conversation;
      const identity = cache.getState().identity!;
      if (thread.id !== id || thread.type !== "thread" || thread.parentConversationId !== parent ||
          thread.tenantId !== identity.tenantId || thread.currentMember.userId !== identity.userId ||
          thread.currentReadState.userId !== identity.userId || thread.currentMember.state !== "active") {
        return publish(e, { ...e.state, status: "error", error: "malformed_response" });
      }
      accept(e, thread.threadLifecycle);
      if (e.candidate !== undefined) { accept(e, e.candidate); delete e.candidate; }
      return publish(e, { ...e.state, status: e.command ? "updating" :
        e.state.result?.reconciliationStatus === "lifecycle_conflict" ? "conflict" : "ready" });
    } catch {
      return current() ? publish(e, { ...e.state, status: "error", error: "transport" }) : e.state;
    } finally {
      if (e.read === controller) delete e.read;
    }
  };
  const execute = async (e: Entry): Promise<ChatThreadLifecycleState> => {
    if (e.command !== undefined) return e.state;
    const input = e.state.pendingInput;
    if (!available(e.state) || input === undefined) return publish(e, { ...e.state, status: "unavailable",
      error: options.enabledFeatures()[CHAT_REPLY_THREAD_FEATURES.threadLifecycle] !== true ? "unsupported" :
        !options.online() ? "offline" : "not_hydrated" });
    const controller = new AbortController();
    e.command = controller;
    const current = guard(e, controller);
    const { error: _error, result: _result, ...before } = e.state;
    publish(e, { ...before, status: "updating" });
    try {
      const result = await options.dispatch({
        name: "thread.lifecycle.update", method: "PATCH", retry: "safe",
        path: `/conversations/${encodeURIComponent(input.threadId)}/lifecycle`,
        validateInput: serializeThreadLifecycleBody,
        parseResult: value => parseThreadLifecycleResult(value, input),
        parseErrorResult(value, status) {
          if (status !== 409 || value === null || typeof value !== "object" ||
              !("reconciliationStatus" in value) || value.reconciliationStatus !== "lifecycle_conflict") return undefined;
          return parseThreadLifecycleResult(value, input);
        },
      }, input, { idempotencyKey: input.idempotencyKey, signal: controller.signal });
      if (!current()) return e.state;
      if (result.status !== "success") {
        if ("httpStatus" in result && [401, 403, 404].includes(result.httpStatus ?? 0)) {
          revoke(input.threadId); return e.state;
        }
        return publish(e, { ...e.state, status: "error", error: result.status });
      }
      accept(e, result.value.threadLifecycle);
      return publish(e, { ...e.state, status: result.value.reconciliationStatus === "lifecycle_conflict" ? "conflict" : "ready",
        result: Object.freeze(result.value) });
    } catch {
      return current() ? publish(e, { ...e.state, status: "error", error: "transport" }) : e.state;
    } finally {
      if (e.command === controller) delete e.command;
    }
  };
  const action = (id: ConversationId, intent: ThreadLifecycleIntent) => {
    const e = entry(id);
    if (e.command !== undefined) return Promise.resolve(e.state);
    if (options.enabledFeatures()[CHAT_REPLY_THREAD_FEATURES.threadLifecycle] !== true || e.state.lifecycle === undefined ||
        e.state.parentConversationId === undefined || !allowed(id, e.state.parentConversationId)) return execute(e);
    try {
      const pendingInput = Object.freeze(parseThreadLifecycleInput({ operation: "update_thread_lifecycle",
        threadId: id, intent, expectedLifecycleRevision: e.state.lifecycle.revision,
        idempotencyKey: options.generateIdempotencyKey() }));
      publish(e, { ...e.state, pendingInput });
      return execute(e);
    } catch {
      return Promise.resolve(publish(e, { ...e.state, status: "error", error: "validation" }));
    }
  };
  const reset = () => {
    session++;
    revoked.clear();
    for (const [id, e] of entries) {
      cancel(e);
      e.release?.(); delete e.release;
      publish(e, { threadId: id, status: "idle", legacy: false, actionsAvailable: false });
    }
  };
  cache.subscribePrivateStateBoundary(reset);
  cache.subscribe(state => state, (state, previous) => {
    for (const [id, e] of entries) {
      const parent = e.state.parentConversationId;
      if (parent === undefined || revoked.has(id)) continue;
      if (!allowed(id, parent) || [id, parent].some(scope =>
        previous.entities.conversations[scope] !== undefined && state.entities.conversations[scope] === undefined)) {
        revoke(id); continue;
      }
      if ([id, parent].some(scope => state.currentUser.memberships[scope] !== previous.currentUser.memberships[scope])) {
        cancel(e);
        publish(e, { threadId: id, parentConversationId: parent, status: "idle", legacy: false, actionsAvailable: false });
        // The mounted hook does not reload on cache changes. Reauthorize after
        // invalidation so an allowed membership refresh cannot strand controls.
        void load(id, parent);
      }
      publish(e, e.state);
    }
  });
  const api: ChatThreadLifecycle = Object.freeze({
    getState: (id: ConversationId) => entry(id).state,
    subscribe(id: ConversationId, listener: () => void) {
      let set = listeners.get(id);
      if (set === undefined) { set = new Set(); listeners.set(id, set); }
      set.add(listener);
      return () => { set.delete(listener); };
    },
    load, close: (id: ConversationId) => action(id, "close"), reopen: (id: ConversationId) => action(id, "reopen"),
    lock: (id: ConversationId) => action(id, "lock"), unlock: (id: ConversationId) => action(id, "unlock"),
    retry: (id: ConversationId) => entry(id).state.pendingInput === undefined && entry(id).state.parentConversationId !== undefined
      ? load(id, entry(id).state.parentConversationId!) : execute(entry(id)),
  });
  return {
    api, revoke, closeActive: reset,
    /** Capture a denied entry before fresh reads; cache updates and late responses cannot restore it. */
    beginAuthorizedOpening(id: ConversationId): ((parent: ConversationId) => void) | undefined {
      if (!revoked.has(id)) return undefined;
      const e = entry(id);
      const generation = e.generation;
      const epoch = session;
      const identity = cache.getState().identity;
      return parent => {
        if (generation !== e.generation || epoch !== session || identity !== cache.getState().identity ||
            !revoked.has(id) || !allowed(id, parent, true)) return;
        const thread = cache.getState().entities.conversations[id];
        if (thread?.type !== "thread" || thread.parentConversationId !== parent) return;
        cancel(e);
        revoked.delete(id);
        publish(e, { threadId: id, parentConversationId: parent, status: "ready",
          legacy: thread.threadLifecycle === undefined, actionsAvailable: false,
          ...(thread.threadLifecycle === undefined ? {} : { lifecycle: thread.threadLifecycle }) });
      };
    },
    connectionChanged(connected: boolean): void {
      session++;
      for (const e of entries.values()) {
        cancel(e);
        publish(e, { ...e.state, ...(
          e.state.status === "updating" || e.state.status === "loading"
            ? { status: "error" as const, error: connected ? "aborted" : "offline" } : {}) });
      }
      if (connected) {
        // Bounded, sequential hydration, also on reconnect without missed events.
        void (async () => {
          const epoch = session;
          for (const [id, e] of entries) {
            if (epoch !== session) return;
            if (e.state.parentConversationId !== undefined && !revoked.has(id)) await load(id, e.state.parentConversationId);
          }
        })();
      }
    },
    handleCanonicalEvent(value: unknown): void {
      const identity = cache.getState().identity;
      if (identity === null || !options.online()) return;
      try {
        const event = parseKnownDurableEvent(value, identity);
        if (event.protocolVersion !== CHAT_PROTOCOL_VERSION ||
            (event.type !== "thread.lifecycle.updated" && event.type !== "thread.lifecycle.changed")) return;
        const { threadId, parentConversationId } = event.payload;
        const e = entries.get(threadId);
        if (e === undefined || e.state.parentConversationId !== parentConversationId ||
            !allowed(threadId, parentConversationId)) return;
        if (event.type === "thread.lifecycle.updated") {
          // An event cannot authorize initial hydration or restore a purged entry.
          if (e.state.lifecycle !== undefined || e.state.legacy) accept(e, event.payload.threadLifecycle);
          else if (e.read !== undefined && event.payload.threadLifecycle.revision > (e.candidate?.revision ?? 0)) {
            e.candidate = Object.freeze(validateThreadLifecycle(event.payload.threadLifecycle));
          }
        } else if (event.payload.revision > (e.state.lifecycle?.revision ?? 0)) {
          void load(threadId, parentConversationId);
        }
      } catch { /* Only canonical validated lifecycle payloads are admissible. */ }
    },
  };
}
