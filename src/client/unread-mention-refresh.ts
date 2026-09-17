import type { ConversationId } from "../contracts/identifiers.js";
import type { NormalizedChatCache, NormalizedChatCacheState } from "./normalized-cache.js";
import type { ChatSnapshotReader } from "./snapshot-reader.js";

/** Reconcile SQL-derived unread state without guessing recipients or counting replays. */
export function createUnreadMentionRefresh(cache: NormalizedChatCache, reader: ChatSnapshotReader) {
  const pending = new Map<ConversationId, { dirty: boolean; running: boolean; controller: AbortController }>();
  // One timer and one deduplicated queue per client, including socket followers.
  // Only mounted read-state consumers retain polling; no message stream is added.
  const observers = new Map<ConversationId, Set<object>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = (): void => { clearTimeout(timer); timer = undefined; };
  const poll = (): void => {
    if (timer !== undefined || closed || observers.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const id of observers.keys()) {
        // A slow request already covers this tick; never accumulate timer work.
        if (!pending.has(id)) request(id);
      }
      poll();
    }, 5_000);
    timer.unref?.();
  };
  let active = 0;
  let closed = false;
  let scheduled = false;
  const revoked = new Set<ConversationId>();

  const accessible = (state: NormalizedChatCacheState, id: ConversationId): boolean => {
    const conversation = state.entities.conversations[id];
    const member = state.currentUser.memberships[id];
    const parentId = conversation?.type === "thread" ? conversation.parentConversationId : undefined;
    const parentMember = parentId === undefined ? undefined : state.currentUser.memberships[parentId];
    return (parentMember === undefined || parentMember.state === "active") && !revoked.has(id) && (parentId === undefined || !revoked.has(parentId)) &&
      state.identity !== null && conversation !== undefined &&
      conversation.tenantId === state.identity.tenantId &&
      (member === undefined || (member.state === "active" && member.userId === state.identity.userId));
  };
  const guard = (state: NormalizedChatCacheState, id: ConversationId): readonly unknown[] => {
    const conversation = state.entities.conversations[id];
    const parent = conversation?.type === "thread" ? conversation.parentConversationId : undefined;
    return [state.identity, conversation, state.currentUser.memberships[id],
      state.currentUser.readStates[id], state.entities.memberUserIdsByConversation[id],
      state.metadata.durableStreams[id],
      ...(parent === undefined ? [] : [state.entities.conversations[parent], state.currentUser.memberships[parent]])];
  };
  const invalidate = (): void => {
    for (const job of pending.values()) job.controller.abort();
    pending.clear();
    reader.closeActive();
  };
  const schedule = (): void => {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const [id, job] of pending) {
        if (active >= 4) break;
        if (job.running) continue;
        job.running = true;
        job.dirty = false;
        active += 1;
        const before = cache.getState();
        const captured = guard(before, id);
        void reader.getConversation({ conversationId: id }, { signal: job.controller.signal })
          .then((result) => {
            const current = cache.getState();
            if (closed || pending.get(id) !== job || !accessible(current, id)) return;
            if (job.dirty || guard(current, id).some((value, index) => value !== captured[index])) {
              job.dirty = true;
              return;
            }
            if (result.status !== "success") {
              if ("httpStatus" in result && (result.httpStatus === 403 || result.httpStatus === 404)) {
                revoke(id);
              }
              return;
            }
            const item = result.value.conversation;
            const read = current.currentUser.readStates[id];
            if (item.tenantId !== current.identity?.tenantId ||
                item.currentReadState.userId !== current.identity?.userId ||
                item.currentMember.userId !== current.identity?.userId ||
                item.currentMember.state !== "active" ||
                item.latestSequence < (current.metadata.conversations[id]?.latestSequence ?? 0) ||
                (read !== undefined && (item.currentReadState.lastReadSequence < read.lastReadSequence ||
                  (item.currentReadState.lastReadSequence === read.lastReadSequence &&
                    item.currentReadState.updatedAt < read.updatedAt)))) return;
            cache.hydrateConversationDetail(result.value);
          })
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            if (pending.get(id) === job) {
              if (job.dirty && accessible(cache.getState(), id)) job.running = false;
              else pending.delete(id);
            }
            schedule();
          });
      }
    });
  };
  const request = (id: ConversationId): void => {
    if (closed || !accessible(cache.getState(), id)) return;
    const job = pending.get(id);
    if (job !== undefined) job.dirty = true;
    else pending.set(id, { dirty: false, running: false, controller: new AbortController() });
    schedule();
  };
  const revoke = (id: ConversationId): void => {
    revoked.add(id);
    for (const [conversationId, job] of pending) {
      if (!accessible(cache.getState(), conversationId)) {
        pending.delete(conversationId);
        job.controller.abort();
      }
    }
    for (const conversationId of observers.keys()) {
      if (!accessible(cache.getState(), conversationId)) observers.delete(conversationId);
    }
    if (observers.size === 0) stopTimer();
    cache.dispatch({ type: "conversations/discard-access", conversationId: id });
  };
  cache.subscribePrivateStateBoundary(() => {
    stopTimer(); observers.clear(); revoked.clear(); invalidate();
  });
  cache.subscribe((state) => state, (state, previous) => {
    // A discarded row can return through fresh authorized discovery. Keep the
    // denial until that happens; a reconnect alone never recreates the row.
    for (const id of revoked) {
      if (previous.entities.conversations[id] === undefined && state.entities.conversations[id] !== undefined &&
          state.currentUser.memberships[id]?.state === "active") revoked.delete(id);
    }
    // Actor-private membership events can remove an offscreen row even when
    // this tab has no conversation socket (and therefore no revoke frame).
    for (const id of observers.keys()) {
      const conversation = state.entities.conversations[id];
      const scopes = conversation?.type === "thread" ? [id, conversation.parentConversationId] : [id];
      for (const scope of scopes) {
        if (!revoked.has(scope) && state.entities.conversations[scope]?.visibility === "private" &&
            state.currentUser.memberships[scope]?.state !== undefined &&
            state.currentUser.memberships[scope]?.state !== "active") revoke(scope);
      }
    }
    for (const [id, job] of pending) {
      if (!accessible(state, id)) {
        pending.delete(id);
        job.controller.abort();
      }
    }
    if (closed || state.entities.messages === previous.entities.messages) return;
    for (const message of Object.values(state.entities.messages)) {
      if ("delivery" in message || "deleteState" in message || "editState" in message) continue;
      const old = previous.entities.messages[message.id];
      if (old !== undefined && message.revision.revision <= old.revision.revision) continue;
      // Any canonical deletion may invalidate a source whose replies are outside
      // the loaded page. Missing source context must use snapshot authority too.
      if (message.deletedAt !== undefined) {
        request(message.conversationId);
      } else if (message.replyTo?.notifyAuthor === true) {
        const source = state.entities.messages[message.replyTo.messageId];
        if (source === undefined || source.author.userId === state.identity?.userId) {
          request(message.conversationId);
        }
      }
    }
  });
  return {
    retain(id: ConversationId): () => void {
      const token = {};
      const owners = observers.get(id) ?? new Set<object>();
      observers.set(id, owners);
      owners.add(token);
      closed = false;
      if (owners.size === 1) request(id);
      poll();
      return () => {
        // A release from an old identity must not release a new identity's owner.
        if (observers.get(id) !== owners || !owners.delete(token)) return;
        if (owners.size !== 0) return;
        observers.delete(id);
        const job = pending.get(id);
        pending.delete(id);
        job?.controller.abort();
        if (observers.size === 0) stopTimer();
      };
    },
    connected(): void {
      invalidate();
      revoked.clear();
      closed = false;
      poll();
      // Missed source deletions need reconciliation even with no loaded replies.
      for (const id of Object.keys(cache.getState().entities.conversations)) request(id as ConversationId);
    },
    closeActive(): void { closed = true; stopTimer(); observers.clear(); invalidate(); },
    revoke,
  };
}
