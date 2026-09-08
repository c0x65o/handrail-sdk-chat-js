import type { ThreadLifecycle } from "../contracts/conversation.js";
import { parseKnownDurableEvent } from "../contracts/generated/durable-events.js";
import type { ConversationId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import {
  compareThreadListPositions, parseThreadListRequest, parseThreadListResult,
  type ResolvedThreadListRequest, type ThreadListItem, type ThreadListRequest, type ThreadListResult,
} from "../contracts/thread-list.js";
import { selectConversationUnreadMentionCount, type NormalizedChatCache } from "./normalized-cache.js";
import type { ChatSnapshotReader } from "./snapshot-reader.js";

/** Cursors belong to the runtime; callers select a parent, view and page size. */
export type ChatThreadListQuery = Omit<ThreadListRequest, "cursor">;
export interface ChatThreadListState extends ChatThreadListQuery {
  readonly status: "idle" | "loading" | "refreshing" | "loading_more" | "ready" | "error" | "unavailable";
  readonly items: readonly ThreadListItem[];
  readonly empty: boolean;
  readonly hasMore: boolean;
  readonly result?: ThreadListResult;
  /** Sanitized failure category; retry retains the failed page or refresh intent. */
  readonly error?: string;
}
export interface ChatThreadList {
  getState(query: ChatThreadListQuery): ChatThreadListState;
  /** The first observer loads; the last release cancels requests, timers and stream retention. */
  subscribe(query: ChatThreadListQuery, listener: () => void): () => void;
  refresh(query: ChatThreadListQuery): Promise<ChatThreadListState>;
  loadMore(query: ChatThreadListQuery): Promise<ChatThreadListState>;
  retry(query: ChatThreadListQuery): Promise<ChatThreadListState>;
}
export interface ChatThreadListScheduling {
  readonly now?: () => number;
  /** Schedule once and return a cancellation function. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}
interface Options extends ChatThreadListScheduling {
  cache: NormalizedChatCache;
  reader: Pick<ChatSnapshotReader, "listThreads">;
  online: () => boolean;
  subscribeConversation?: (id: ConversationId) => (() => void) | undefined;
}
interface Entry {
  query: ResolvedThreadListRequest;
  state: ChatThreadListState;
  listeners: Set<() => void>;
  generation: number;
  controller?: AbortController;
  task?: Promise<ChatThreadListState>;
  release?: () => void;
  cancelTimer?: () => void;
  deadline?: number;
  failedPage: boolean;
}

/** Discovery has no cache write, open, follow, read, draft or send side effects. */
export function createThreadListRuntime(options: Options) {
  const { cache } = options;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = globalThis.setTimeout(callback, delay);
    return () => globalThis.clearTimeout(timer);
  });
  const entries = new Map<string, Entry>();
  const revoked = new Set<ConversationId>();
  const revisions = new Map<string, number>();
  const lifecycles = new Map<string, ThreadLifecycle>();
  let epoch = 0;
  let disposed = false;
  const scopeKey = (parent: ConversationId, thread: ConversationId) => JSON.stringify([parent, thread]);
  const blank = (query: ChatThreadListQuery): ChatThreadListState => Object.freeze({
    ...query, status: "idle", items: Object.freeze([]), empty: false, hasMore: false,
  });
  const entry = (input: ChatThreadListQuery) => {
    const query = parseThreadListRequest(input);
    if (query.cursor !== undefined) throw new Error("Discovery cursors are runtime-owned.");
    const key = JSON.stringify([query.parentConversationId, query.view, query.limit]);
    let e = entries.get(key);
    if (e === undefined) {
      e = { query, state: blank(query), listeners: new Set(), generation: 0, failedPage: false };
      entries.set(key, e);
    }
    return e;
  };
  const allowed = (e: Entry) => {
    const state = cache.getState(), id = e.query.parentConversationId;
    const parent = state.entities.conversations[id], member = state.currentUser.memberships[id];
    return !disposed && state.identity !== null && !revoked.has(id) &&
      (parent === undefined || (parent.type === "channel" && parent.tenantId === state.identity.tenantId && parent.archivedAt === undefined)) &&
      (member === undefined || (member.tenantId === state.identity.tenantId && member.userId === state.identity.userId && member.state === "active"));
  };
  const publish = (e: Entry, state: ChatThreadListState) => {
    e.state = Object.freeze(state);
    for (const listener of e.listeners) { try { listener(); } catch { /* Observer isolation. */ } }
    return e.state;
  };
  const cancelTimer = (e: Entry) => { e.cancelTimer?.(); delete e.cancelTimer; };
  const cancel = (e: Entry) => {
    e.generation++; e.controller?.abort(); delete e.controller; delete e.task; cancelTimer(e);
  };
  const releaseStream = (e: Entry) => { e.release?.(); delete e.release; };
  const fail = (e: Entry, error: string) => publish(e, { ...e.state, status: "error", empty: false, error });
  const revoke = (id: ConversationId) => {
    revoked.add(id);
    for (const e of entries.values()) {
      if (e.query.parentConversationId === id) {
        cancel(e); releaseStream(e);
        publish(e, { ...blank(e.query), status: "unavailable", error: "access_revoked" });
      } else if (e.state.items.some(item => item.thread.id === id) || e.controller !== undefined) {
        // Cancel even an unknown child's pending page; it must never admit revoked IDs.
        cancel(e);
        const items = Object.freeze(e.state.items.filter(item => item.thread.id !== id));
        publish(e, { ...e.state, items, empty: items.length === 0, status: "ready" });
        if (e.listeners.size && allowed(e)) void request(e, false);
      }
    }
  };
  const project = (e: Entry, item: ThreadListItem): ThreadListItem | undefined => {
    const state = cache.getState(), id = item.thread.id;
    const cached = state.entities.conversations[id];
    const metadata = state.metadata.conversations[id];
    const mentions = selectConversationUnreadMentionCount(state, id);
    if (revoked.has(id) || cached?.archivedAt !== undefined) return undefined;
    if (cached !== undefined && (cached.type !== "thread" || cached.parentConversationId !== e.query.parentConversationId ||
        cached.tenantId !== state.identity?.tenantId)) return undefined;
    let lifecycle = item.thread.threadLifecycle;
    for (const fact of [cached?.threadLifecycle, lifecycles.get(scopeKey(e.query.parentConversationId, id))]) {
      if (fact !== undefined && fact.revision > (lifecycle?.revision ?? 0)) lifecycle = fact;
    }
    if (e.query.view === "active" && lifecycle?.closedAt !== undefined) return undefined;
    const privateState = state.currentUser;
    const read = privateState.readStates[id], member = privateState.memberships[id], preference = privateState.preferences[id];
    const followRevision = privateState.threadFollowRevisions[id];
    const pendingFollow = privateState.pendingThreadFollowUpdates[id];
    const canonicalFollow = pendingFollow === undefined ? privateState.threadFollows[id] : pendingFollow.authoritativeFollow;
    const follow = followRevision !== undefined && followRevision >= item.currentThreadFollow.followRevision
      ? { followRevision, follow: canonicalFollow ?? null } : item.currentThreadFollow;
    return Object.freeze({ ...item, currentThreadFollow: follow, thread: Object.freeze({ ...item.thread,
      ...(lifecycle === undefined ? {} : { threadLifecycle: lifecycle }),
      ...(metadata !== undefined && metadata.latestSequence >= item.thread.latestSequence ? {
        latestSequence: metadata.latestSequence,
        ...(mentions === undefined ? {} : { unreadMentionCount: mentions }),
      } : {}),
      ...(cached !== undefined && cached.updatedAt >= item.thread.updatedAt ? { name: cached.name } : {}),
      ...(read !== undefined && read.lastReadSequence >= item.thread.currentReadState.lastReadSequence ? { currentReadState: read } : {}),
      ...(member !== undefined && member.updatedAt >= item.thread.currentMember.updatedAt ? { currentMember: member } : {}),
      ...(preference !== undefined && preference.updatedAt >= (item.thread.currentPreference?.updatedAt ?? "") ? { currentPreference: preference } : {}),
    }) });
  };
  const arm = (e: Entry) => {
    cancelTimer(e);
    if (!e.listeners.size || !allowed(e) || !options.online() || e.deadline === undefined || e.state.status !== "ready") return;
    const remaining = e.deadline - now();
    // A response with an elapsed/tiny deadline may recur: floor to one second.
    e.cancelTimer = schedule(() => {
      delete e.cancelTimer;
      if (!e.listeners.size || !allowed(e)) return;
      if (e.deadline! > now()) arm(e); else void request(e, false);
    }, remaining <= 0 ? 1000 : Math.max(1, Math.min(2_147_483_647, remaining)));
  };
  const request = (e: Entry, page: boolean): Promise<ChatThreadListState> => {
    if (page && e.task !== undefined) return e.task;
    if (page && !e.state.result?.nextCursor) return Promise.resolve(e.state);
    cancel(e);
    e.failedPage = page;
    if (!allowed(e)) return Promise.resolve(publish(e, { ...blank(e.query), status: "unavailable", error: "access_revoked" }));
    if (!options.online()) return Promise.resolve(fail(e, "offline"));
    const controller = new AbortController(); e.controller = controller;
    const generation = e.generation, session = epoch, identity = cache.getState().identity!;
    const current = () => !controller.signal.aborted && generation === e.generation && epoch === session &&
      identity === cache.getState().identity && allowed(e);
    const input = { ...e.query, ...(page ? { cursor: e.state.result!.nextCursor! } : {}) };
    const task = Promise.resolve().then(async () => {
      if (!current()) return e.state;
      const { error: _error, ...before } = e.state;
      publish(e, { ...before, status: page ? "loading_more" : before.result ? "refreshing" : "loading", empty: false });
      if (!current()) return e.state;
      if (e.listeners.size && e.release === undefined) {
        const release = options.subscribeConversation?.(e.query.parentConversationId);
        if (release !== undefined) e.release = release;
      }
      const response = await options.reader.listThreads(input, { signal: controller.signal });
      if (!current()) return e.state;
      if (response.status !== "success") {
        if ("httpStatus" in response && [401, 403, 404].includes(response.httpStatus ?? 0)) {
          revoke(e.query.parentConversationId); return e.state;
        }
        return fail(e, response.status);
      }
      let result: ThreadListResult;
      try {
        result = parseThreadListResult(response.value, input);
        for (const { thread } of result.items) {
          if (thread.tenantId !== identity.tenantId || thread.currentMember.tenantId !== identity.tenantId ||
              thread.currentMember.userId !== identity.userId || thread.currentReadState.userId !== identity.userId ||
              (thread.currentPreference !== undefined && thread.currentPreference.userId !== identity.userId)) throw new Error();
        }
      } catch { return fail(e, "malformed_response"); }
      for (const item of result.items) {
        const key = scopeKey(e.query.parentConversationId, item.thread.id);
        const availableRevision = Math.max(item.thread.threadLifecycle?.revision ?? 0,
          lifecycles.get(key)?.revision ?? 0, cache.getState().entities.conversations[item.thread.id]?.threadLifecycle?.revision ?? 0);
        if ((revisions.get(key) ?? 0) > availableRevision) return fail(e, "stale_response");
      }
      const merged = new Map((page ? e.state.items : []).map(item => [item.thread.id, item]));
      for (const item of result.items) {
        const previous = merged.get(item.thread.id) ?? e.state.items.find(row => row.thread.id === item.thread.id);
        if (previous !== undefined && previous.thread.createdAt !== item.thread.createdAt) return fail(e, "malformed_response");
        const lifecycle = item.thread.threadLifecycle;
        const key = scopeKey(e.query.parentConversationId, item.thread.id);
        if (lifecycle !== undefined && lifecycle.revision > (lifecycles.get(key)?.revision ?? 0)) lifecycles.set(key, lifecycle);
        merged.set(item.thread.id, previous === undefined ? item : { ...item,
          currentThreadFollow: previous.currentThreadFollow.followRevision > item.currentThreadFollow.followRevision
            ? previous.currentThreadFollow : item.currentThreadFollow,
          thread: { ...item.thread, currentReadState: previous.thread.currentReadState.lastReadSequence > item.thread.currentReadState.lastReadSequence
            ? previous.thread.currentReadState : item.thread.currentReadState },
        });
      }
      const items = Object.freeze([...merged.values()].flatMap(item => {
        const projected = project(e, item); return projected === undefined ? [] : [projected];
      }).sort((a, b) => compareThreadListPositions({ createdAt: a.thread.createdAt, threadId: a.thread.id },
        { createdAt: b.thread.createdAt, threadId: b.thread.id })));
      const deadlines = result.items.flatMap(item => item.hideAt === null ? [] : [item.hideAt]);
      const deadline = e.query.view === "active" && result.inactivityPolicy && deadlines.length
        ? now() + Math.max(0, Math.min(...deadlines) - Date.parse(result.evaluatedAt)) : undefined;
      if (!page || !result.inactivityPolicy) delete e.deadline;
      if (deadline !== undefined) e.deadline = Math.min(e.deadline ?? Infinity, deadline);
      publish(e, { ...e.query, status: "ready", items, empty: items.length === 0,
        hasMore: result.nextCursor !== undefined, result: Object.freeze({ ...result, items }) });
      arm(e);
      return e.state;
    }).catch(() => current() ? fail(e, "transport") : e.state).finally(() => {
      if (e.task === task) { delete e.task; delete e.controller; }
    });
    e.task = task; return task;
  };
  const invalidate = (e: Entry) => {
    cancel(e);
    if (e.listeners.size && allowed(e)) void request(e, false);
    else publish(e, blank(e.query));
  };
  const reset = () => {
    epoch++; revoked.clear(); revisions.clear(); lifecycles.clear();
    for (const e of entries.values()) { cancel(e); releaseStream(e); delete e.deadline; publish(e, blank(e.query)); }
  };
  const unsubscribeBoundary = cache.subscribePrivateStateBoundary(() => {
    reset();
    for (const e of entries.values()) if (e.listeners.size && allowed(e) && options.online()) void request(e, false);
  });
  const unsubscribeCache = cache.subscribe(state => state, (state, previous) => {
    if (state.identity !== previous.identity) { reset(); return; }
    for (const e of entries.values()) {
      const parent = e.query.parentConversationId;
      if (!allowed(e) || (previous.entities.conversations[parent] !== undefined && state.entities.conversations[parent] === undefined)) {
        if (!revoked.has(parent)) revoke(parent);
        continue;
      }
      for (const conversation of Object.values(previous.entities.conversations)) {
        if (conversation.type === "thread" && conversation.parentConversationId === parent &&
            state.entities.conversations[conversation.id] === undefined && !revoked.has(conversation.id)) revoke(conversation.id);
      }
      const ids = new Set([parent, ...e.state.items.map(item => item.thread.id),
        ...Object.values(state.entities.conversations).filter(c => c.type === "thread" && c.parentConversationId === parent).map(c => c.id)]);
      if ([...ids].some(id => state.entities.conversations[id] !== previous.entities.conversations[id] ||
          state.currentUser.memberships[id] !== previous.currentUser.memberships[id] ||
          state.currentUser.readStates[id] !== previous.currentUser.readStates[id] ||
          state.currentUser.threadFollows[id] !== previous.currentUser.threadFollows[id] ||
          state.currentUser.preferences[id] !== previous.currentUser.preferences[id] ||
          state.metadata.conversations[id] !== previous.metadata.conversations[id] ||
          state.metadata.conversationListUnreadMentionCounts[id] !== previous.metadata.conversationListUnreadMentionCounts[id])) invalidate(e);
    }
  });
  const api: ChatThreadList = Object.freeze({
    getState: (query: ChatThreadListQuery) => entry(query).state,
    subscribe(query: ChatThreadListQuery, listener: () => void) {
      const e = entry(query); e.listeners.add(listener);
      if (e.listeners.size === 1 && !disposed) void request(e, false);
      let released = false;
      return () => {
        if (released) return; released = true; e.listeners.delete(listener);
        if (!e.listeners.size) { cancel(e); releaseStream(e); publish(e, blank(e.query)); }
      };
    },
    refresh: (query: ChatThreadListQuery) => request(entry(query), false),
    loadMore: (query: ChatThreadListQuery) => request(entry(query), true),
    retry: (query: ChatThreadListQuery) => { const e = entry(query); return request(e, e.failedPage); },
  });
  return { api, revoke, closeActive: reset,
    dispose() { disposed = true; reset(); unsubscribeBoundary(); unsubscribeCache(); entries.clear(); },
    connectionChanged(connected: boolean) {
      epoch++;
      for (const e of entries.values()) {
        cancel(e);
        if (!allowed(e)) continue;
        if (connected && e.listeners.size) void request(e, false);
        else if (!connected && e.listeners.size) fail(e, "offline");
      }
    },
    handleCanonicalEvent(value: unknown) {
      const identity = cache.getState().identity;
      if (identity === null || !options.online()) return;
      try {
        const event = parseKnownDurableEvent(value, identity);
        if (event.protocolVersion !== CHAT_PROTOCOL_VERSION) return;
        let parent: ConversationId | undefined;
        let child: ConversationId | undefined;
        if (event.type === "thread.lifecycle.changed" || event.type === "thread.lifecycle.updated") {
          parent = event.payload.parentConversationId; child = event.payload.threadId;
          if (revoked.has(parent) || revoked.has(child)) return;
          const key = scopeKey(parent, child);
          const revision = event.type === "thread.lifecycle.changed" ? event.payload.revision : event.payload.threadLifecycle.revision;
          const enriched = event.type === "thread.lifecycle.updated" && revision > (lifecycles.get(key)?.revision ?? 0) && revision >= (revisions.get(key) ?? 0);
          if (enriched && event.type === "thread.lifecycle.updated") lifecycles.set(key, event.payload.threadLifecycle);
          if (revision <= (revisions.get(key) ?? 0) && !enriched) return;
          revisions.set(key, revision);
        } else if (event.type === "conversation.created" || event.type === "thread.created") {
          const conversation = event.payload.conversation;
          if (conversation.type !== "thread") return;
          parent = conversation.parentConversationId;
        } else if (event.type === "message.thread_summary.updated") parent = event.payload.parentConversationId;
        else if (event.type === "thread.follow.updated") child = event.payload.target.id;
        else if (event.type === "message.created") child = event.payload.message.conversationId;
        else if (event.type === "conversation.archived" || event.type === "conversation.restored") child = event.payload.conversationId;
        else if (event.type === "conversation.read_cursor_updated" || event.type === "conversation.preference.updated" || event.type === "conversation.membership.updated") {
          // Private events may refer to unopened children: the cache reducer also narrows known scopes.
          for (const e of entries.values()) if (allowed(e)) invalidate(e);
          return;
        } else return;
        for (const e of entries.values()) if (allowed(e) && (e.query.parentConversationId === parent ||
          (child !== undefined && (child === e.query.parentConversationId || e.state.items.some(item => item.thread.id === child) ||
            cache.getState().entities.conversations[child]?.parentConversationId === e.query.parentConversationId)))) invalidate(e);
      } catch { /* Ignore noncanonical/wrong-tenant events. */ }
    },
  };
}
