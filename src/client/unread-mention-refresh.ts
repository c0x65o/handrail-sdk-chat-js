import type { ConversationId } from "../contracts/identifiers.js";
import type { NormalizedChatCache, NormalizedChatCacheState } from "./normalized-cache.js";
import type { ChatSnapshotReader } from "./snapshot-reader.js";

/** Reconcile SQL-derived reply pings without guessing recipients or counting replays. */
export function createUnreadMentionRefresh(cache: NormalizedChatCache, reader: ChatSnapshotReader) {
  const pending = new Map<ConversationId, { dirty: boolean; running: boolean; controller: AbortController }>();
  let active = 0;
  let closed = false;
  let scheduled = false;
  const revoked = new Set<ConversationId>();

  const accessible = (state: NormalizedChatCacheState, id: ConversationId): boolean => {
    const conversation = state.entities.conversations[id];
    const member = state.currentUser.memberships[id];
    const parentId = conversation?.type === "thread" ? conversation.parentConversationId : undefined;
    return !revoked.has(id) && (parentId === undefined || !revoked.has(parentId)) &&
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
            if (result.status !== "success") return;
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
  cache.subscribePrivateStateBoundary(() => { revoked.clear(); invalidate(); });
  cache.subscribe((state) => state, (state, previous) => {
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
    connected(): void {
      invalidate();
      revoked.clear();
      closed = false;
      // Missed source deletions need reconciliation even with no loaded replies.
      for (const id of Object.keys(cache.getState().entities.conversations)) request(id as ConversationId);
    },
    closeActive(): void { closed = true; invalidate(); },
    revoke(id: ConversationId): void {
      revoked.add(id);
      for (const [conversationId, job] of pending) {
        if (!accessible(cache.getState(), conversationId)) {
          pending.delete(conversationId);
          job.controller.abort();
        }
      }
    },
  };
}
