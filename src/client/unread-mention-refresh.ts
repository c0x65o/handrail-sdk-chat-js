import type { ConversationId } from "../contracts/identifiers.js";
import type { ConversationSnapshotCursor, ConversationSnapshotSummary } from "../contracts/conversation-snapshot.js";
import type { NormalizedChatCache, NormalizedChatCacheState } from "./normalized-cache.js";
import type { ChatSnapshotReader, ChatSnapshotQueryResult } from "./snapshot-reader.js";

/** Reconcile SQL-derived unread state without guessing recipients or counting replays. */
export function createUnreadMentionRefresh(cache: NormalizedChatCache, reader: ChatSnapshotReader) {
  const pending = new Map<ConversationId, { dirty: boolean; running: boolean; controller: AbortController }>();
  // One timer and one deduplicated queue per client, including socket followers.
  // Only mounted read-state consumers retain polling; no message stream is added.
  const observers = new Map<ConversationId, Set<object>>();
  // At most one list page and one detail start per five seconds, independent
  // of row count. Keep deadlines across release/close/reopen to bound remounts.
  let nextListAt = 0;
  let nextDetailAt = 0;
  let retryAt = 0;
  let listWanted = false;
  let listJob: AbortController | undefined;
  let cursor: ConversationSnapshotCursor | undefined;
  const seen = new Set<ConversationId>();
  const isListed = (id: ConversationId): boolean =>
    cache.getState().entities.conversations[id]?.type !== "thread";
  const cooldown = (result: ChatSnapshotQueryResult<unknown>): void => {
    if (result.status === "rejected" && result.httpStatus === 429) {
      // A late overlapping response must never shorten an earlier cooldown.
      retryAt = Math.max(retryAt, result.retryAt ?? Date.now() + 60_000);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = (): void => { clearTimeout(timer); timer = undefined; };
  const poll = (): void => {
    if (timer !== undefined || closed || (observers.size === 0 && pending.size === 0)) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const id of observers.keys()) {
        // A slow request already covers this tick; never accumulate timer work.
        if (isListed(id)) listWanted = true;
        else if (!pending.has(id)) request(id);
      }
      schedule();
      poll();
    }, 5_000);
    (timer as unknown as { unref?: () => void }).unref?.();
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
    listJob?.abort();
    listJob = undefined;
    listWanted = false;
    cursor = undefined;
    seen.clear();
    reader.closeActive();
  };
  const accepts = (current: NormalizedChatCacheState, item: ConversationSnapshotSummary): boolean => {
    const read = current.currentUser.readStates[item.id];
    return accessible(current, item.id) && item.tenantId === current.identity?.tenantId &&
      item.currentReadState.userId === current.identity?.userId &&
      item.currentMember.userId === current.identity?.userId && item.currentMember.state === "active" &&
      item.latestSequence >= (current.metadata.conversations[item.id]?.latestSequence ?? 0) &&
      (read === undefined || (item.currentReadState.lastReadSequence >= read.lastReadSequence &&
        (item.currentReadState.lastReadSequence !== read.lastReadSequence || item.currentReadState.updatedAt >= read.updatedAt)));
  };
  const refreshList = (): void => {
    if (!listWanted || listJob !== undefined || Date.now() < nextListAt) return;
    const ids = [...observers.keys()].filter(id => isListed(id) && accessible(cache.getState(), id));
    if (ids.length === 0) { listWanted = false; return; }
    const before = cache.getState();
    const captured = new Map(ids.map(id => [id, guard(before, id)]));
    const controller = new AbortController();
    listJob = controller;
    listWanted = false;
    nextListAt = Date.now() + 5_000;
    void reader.listConversations({ scope: { type: "organization" }, limit: 100,
      ...(cursor === undefined ? {} : { cursor }) }, { signal: controller.signal })
      .then(result => {
        cooldown(result);
        if (closed || listJob !== controller) return;
        if (result.status !== "success") {
          cursor = undefined; seen.clear();
          if ("httpStatus" in result && (result.httpStatus === 403 || result.httpStatus === 404)) {
            for (const id of ids) if (!pending.has(id)) request(id);
          }
          return;
        }
        const current = cache.getState();
        const items = result.value.items.filter(item => {
          seen.add(item.id);
          const values = captured.get(item.id);
          return observers.has(item.id) && values !== undefined && accepts(current, item) &&
            guard(current, item.id).every((value, index) => value === values[index]);
        });
        // List summaries are authoritative for counts, cursors, membership and
        // preferences. Never replace the host's discovery/pagination chain.
        if (items.length > 0) cache.hydrateConversationList({ ...result.value, items }, { preservePages: true });
        cursor = result.value.page.nextCursor;
        if (cursor === undefined || ids.every(id => seen.has(id))) {
          // Absence is not denial (archived rows and moving pages are possible).
          // Confirm missing observers through the bounded detail lane.
          for (const id of ids) if (!seen.has(id) && !pending.has(id)) request(id);
          cursor = undefined;
          seen.clear();
        }
      })
      .catch(() => { if (listJob === controller) { cursor = undefined; seen.clear(); } })
      .finally(() => { if (listJob === controller) listJob = undefined; poll(); });
  };
  const schedule = (): void => {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      if (Date.now() < retryAt) { poll(); return; }
      refreshList();
      for (const [id, job] of pending) {
        if (active >= 1 || Date.now() < nextDetailAt) break;
        if (job.running) continue;
        job.running = true;
        job.dirty = false;
        active += 1;
        nextDetailAt = Date.now() + 5_000;
        const before = cache.getState();
        const captured = guard(before, id);
        void reader.getConversation({ conversationId: id }, { signal: job.controller.signal })
          .then((result) => {
            cooldown(result);
            if (result.status === "rejected" && result.httpStatus === 429) job.dirty = true;
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
            if (!accepts(current, item)) return;
            cache.hydrateConversationDetail(result.value);
          })
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            if (pending.get(id) === job) {
              pending.delete(id);
              // Put dirty work at the back so hot conversations cannot starve
              // direct observers or membership-denial confirmations.
              if (job.dirty && accessible(cache.getState(), id)) {
                job.running = false;
                pending.set(id, job);
              }
            }
            schedule();
          });
      }
      poll();
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
    if (![...observers.keys()].some(isListed)) {
      listJob?.abort(); listJob = undefined; listWanted = false;
      cursor = undefined; seen.clear();
    }
    if (observers.size === 0 && pending.size === 0) stopTimer();
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
      if (owners.size === 1) {
        if (isListed(id)) { listWanted = true; schedule(); }
        else request(id);
      }
      poll();
      return () => {
        // A release from an old identity must not release a new identity's owner.
        if (observers.get(id) !== owners || !owners.delete(token)) return;
        if (owners.size !== 0) return;
        observers.delete(id);
        const job = pending.get(id);
        pending.delete(id);
        job?.controller.abort();
        if (observers.size === 0) {
          listJob?.abort(); listJob = undefined; listWanted = false;
          cursor = undefined; seen.clear();
          if (pending.size === 0) stopTimer();
        }
      };
    },
    connected(): void {
      invalidate();
      revoked.clear();
      closed = false;
      poll();
      // Missed source deletions need reconciliation even with no loaded replies.
      for (const id of Object.keys(cache.getState().entities.conversations)) {
        if (observers.has(id as ConversationId) && isListed(id as ConversationId)) listWanted = true;
        else request(id as ConversationId);
      }
      schedule();
    },
    closeActive(): void { closed = true; stopTimer(); observers.clear(); invalidate(); },
    revoke,
  };
}
