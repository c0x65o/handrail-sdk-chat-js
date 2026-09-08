import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatCacheError,
  conversationSnapshotScopeKey,
  createConversationMessagesSelector,
  createNormalizedChatCache,
  selectConversation,
  selectConversationUnreadMentionCount,
  selectCurrentUserPreference,
  selectCurrentUserReadState,
  selectHuddleState,
} from "../dist/client/index.js";

const tenantId = "tenant-1";
const userId = "user-current";
const initialIdentity = { tenantId, userId, sessionId: "session-1" };
const metadata = {
  packageVersion: "0.1.3",
  protocolVersion: 4,
  schemaVersion: 1,
  enabledFeatures: { huddles: true, typing: true, presence: true },
  supportedProtocolRange: { minimumVersion: 3, maximumVersion: 4 },
  feature: { name: "conversation_snapshots", version: 1 },
};

function privateState(conversationId, overrides = {}) {
  return {
    latestSequence: 3,
    unreadMentionCount: 0,
    activityAt: "2026-08-25T20:03:00.000Z",
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: "member",
      state: "active",
      joinedAt: "2026-08-25T19:00:00.000Z",
      updatedAt: "2026-08-25T20:00:00.000Z",
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: 1,
      updatedAt: "2026-08-25T20:00:00.000Z",
    },
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: "2026-08-25T20:00:00.000Z",
    },
    ...overrides,
  };
}

function conversation(type, id, overrides = {}) {
  const common = {
    id,
    tenantId,
    type,
    visibility: type === "channel" ? "public" : "private",
    activeMemberUserIds: [userId, "user-other"],
    createdAt: "2026-08-25T19:00:00.000Z",
    updatedAt: "2026-08-25T20:03:00.000Z",
    ...privateState(id),
  };
  if (type === "channel") return { ...common, name: "Orders", ...overrides };
  if (type === "thread") {
    return {
      ...common,
      parentConversationId: "conversation-channel",
      rootMessageId: "message-root",
      ...overrides,
    };
  }
  return { ...common, ...overrides };
}

function listSnapshot(items, nextCursor) {
  return {
    kind: "conversation_list",
    scope: { type: "organization" },
    items,
    page: nextCursor === undefined ? {} : { nextCursor },
    _meta: metadata,
  };
}

function detailSnapshot(item) {
  return {
    kind: "conversation_detail",
    conversation: {
      ...item,
      memberUserIds: [userId, "user-other"],
      currentPreference: {
        conversationId: item.id,
        userId,
        notificationPreference: "mentions",
        mute: { muted: false },
        updatedAt: "2026-08-25T20:00:00.000Z",
      },
    },
    _meta: metadata,
  };
}

function message(conversationId, sequence, overrides = {}) {
  return {
    id: `${conversationId}-message-${sequence}`,
    tenantId,
    conversationId,
    author: { type: "user", userId: "user-other" },
    sequence,
    createdAt: `2026-08-25T20:00:0${sequence}.000Z`,
    updatedAt: `2026-08-25T20:00:0${sequence}.000Z`,
    revision: { revision: 1 },
    content: { format: "plain", text: `message ${sequence}` },
    isThreadRoot: false,
    reactions: [],
    attachmentMetadata: [],
    ...overrides,
  };
}

function page(conversationId, messages, overrides = {}) {
  return {
    conversationId,
    messages,
    pagination: {
      older: { available: false },
      newer: { available: false },
      ...overrides.pagination,
    },
    replay: { resumeFrom: { eventId: overrides.eventId ?? "event-1" } },
  };
}

function typingEvent() {
  return {
    eventId: "typing-event",
    protocolVersion: 4,
    tenantId,
    streamId: "conversation-channel",
    type: "typing.signal",
    occurredAt: "2026-08-25T20:00:00.000Z",
    payload: {
      capability: "typing",
      durability: "ephemeral",
      actorUserId: "user-other",
      deviceId: "device-1",
      sessionId: "other-session",
      sequence: 1,
      sentAt: "2026-08-25T20:00:00.000Z",
      expiresAt: "2026-08-25T20:00:10.000Z",
      state: "start",
      scope: {
        type: "conversation",
        conversationId: "conversation-channel",
        visibility: "public",
        audience: "active_participants",
      },
    },
  };
}

function presenceEvent() {
  return {
    eventId: "presence-event",
    protocolVersion: 4,
    tenantId,
    streamId: `user:${userId}`,
    type: "presence.signal",
    occurredAt: "2026-08-25T20:00:00.000Z",
    payload: {
      capability: "presence",
      durability: "ephemeral",
      actorUserId: "user-other",
      deviceId: "device-1",
      sessionId: "other-session",
      sequence: 1,
      sentAt: "2026-08-25T20:00:00.000Z",
      expiresAt: "2026-08-25T20:01:00.000Z",
      state: "online",
      scope: { type: "user_private", userId },
    },
  };
}

test("normalizes channel, direct, and thread snapshots while isolating private state", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const channel = conversation("channel", "conversation-channel");
  const direct = conversation("direct", "conversation-direct", {
    latestSequence: 8,
  });
  const thread = conversation("thread", "conversation-thread", {
    latestSequence: 2,
  });

  cache.hydrateConversationList(
    listSnapshot([channel, direct, thread], "next-conversation-page"),
  );
  cache.hydrateConversationDetail(detailSnapshot(thread));

  const state = cache.getState();
  assert.deepEqual(Object.keys(state.entities.conversations), [
    "conversation-channel",
    "conversation-direct",
    "conversation-thread",
  ]);
  assert.equal(selectConversation(state, "conversation-direct").type, "direct");
  assert.equal(
    selectConversation(state, "conversation-thread").parentConversationId,
    "conversation-channel",
  );
  assert.equal("currentMember" in selectConversation(state, "conversation-channel"), false);
  assert.equal("currentReadState" in selectConversation(state, "conversation-channel"), false);
  assert.equal(selectCurrentUserReadState(state, "conversation-direct").userId, userId);
  assert.equal(selectCurrentUserPreference(state, "conversation-thread").userId, userId);
  assert.deepEqual(
    state.entities.memberUserIdsByConversation["conversation-thread"],
    [userId, "user-other"],
  );
  assert.equal(
    state.metadata.conversationLists[
      conversationSnapshotScopeKey({ type: "organization" })
    ].nextCursor,
    "next-conversation-page",
  );
  assert.equal(state.metadata.conversations["conversation-direct"].latestSequence, 8);
});

test("keeps immutable list-summary participants distinct from authoritative detail membership", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const directId = "conversation-list-direct";
  const publicId = "conversation-list-public";
  const direct = conversation("direct", directId, {
    activeMemberUserIds: [userId, "user-list-participant"],
  });
  const discoverablePublic = conversation("channel", publicId, {
    activeMemberUserIds: [],
  });

  cache.hydrateConversationList(listSnapshot([direct, discoverablePublic]));

  let state = cache.getState();
  assert.deepEqual(state.metadata.conversationListParticipantUserIds[directId], [
    userId,
    "user-list-participant",
  ]);
  assert.deepEqual(
    state.metadata.conversationListParticipantUserIds[publicId],
    [],
  );
  assert.equal(Object.isFrozen(state.metadata), true);
  assert.equal(
    Object.isFrozen(state.metadata.conversationListParticipantUserIds),
    true,
  );
  assert.equal(
    Object.isFrozen(state.metadata.conversationListParticipantUserIds[directId]),
    true,
  );
  assert.equal(state.entities.memberUserIdsByConversation[directId], undefined);
  assert.equal(state.metadata.conversationDetails[directId], undefined);
  assert.equal(state.metadata.memberListRevisions[directId], undefined);
  assert.equal(
    state.metadata.conversationListParticipantUserIds["conversation-unknown"],
    undefined,
  );

  cache.hydrateConversationDetail({
    ...detailSnapshot(direct),
    conversation: {
      ...detailSnapshot(direct).conversation,
      memberUserIds: [userId, "user-authoritative"],
      memberListRevision: 7,
    },
  });
  state = cache.getState();
  assert.deepEqual(state.entities.memberUserIdsByConversation[directId], [
    userId,
    "user-authoritative",
  ]);
  assert.deepEqual(state.metadata.conversationListParticipantUserIds[directId], [
    userId,
    "user-list-participant",
  ]);
  assert.equal(state.metadata.memberListRevisions[directId], 7);

  const restored = createNormalizedChatCache(initialIdentity);
  assert.equal(
    restored.hydrateCanonicalState(JSON.parse(JSON.stringify(state))),
    true,
  );
  assert.equal(
    Object.isFrozen(
      restored.getState().metadata.conversationListParticipantUserIds[directId],
    ),
    true,
  );
  const invalid = JSON.parse(JSON.stringify(state));
  invalid.metadata.conversationListParticipantUserIds["conversation-unknown"] = [
    "user-private",
  ];
  assert.equal(restored.hydrateCanonicalState(invalid), false);

  cache.setIdentity({
    tenantId,
    userId: "user-replacement",
    sessionId: "session-replacement",
  });
  assert.deepEqual(cache.getState().metadata.conversationListParticipantUserIds, {});
});

test("projects paginated list mention counts, hydrates them canonically, and clears them at the latest read cursor", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const firstId = "conversation-mention-first";
  const laterId = "conversation-mention-later";
  const nextCursor = "opaque-mention-page";
  const first = conversation("channel", firstId, {
    latestSequence: 4,
    unreadMentionCount: 1,
  });
  const later = conversation("direct", laterId, {
    latestSequence: 8,
    unreadMentionCount: 128,
  });

  cache.hydrateConversationList(listSnapshot([first], nextCursor));
  assert.equal(selectConversationUnreadMentionCount(cache.getState(), firstId), 1);
  cache.hydrateConversationList(listSnapshot([later]), {
    requestCursor: nextCursor,
  });
  assert.equal(selectConversationUnreadMentionCount(cache.getState(), laterId), 128);
  assert.equal("unreadMentionCount" in selectConversation(cache.getState(), laterId), false);

  cache.hydrateConversationList(listSnapshot([{
    ...later,
    latestSequence: 9,
    unreadMentionCount: 7,
  }]), { requestCursor: nextCursor });
  assert.equal(selectConversationUnreadMentionCount(cache.getState(), laterId), 7);
  assert.equal(
    Object.isFrozen(cache.getState().metadata.conversationListUnreadMentionCounts),
    true,
  );

  const restored = createNormalizedChatCache(initialIdentity);
  assert.equal(
    restored.hydrateCanonicalState(JSON.parse(JSON.stringify(cache.getState()))),
    true,
  );
  assert.equal(selectConversationUnreadMentionCount(restored.getState(), laterId), 7);

  restored.reconcileCurrentUserReadState({
    operation: "mark_read",
    conversationId: laterId,
    readState: {
      conversationId: laterId,
      userId,
      lastReadSequence: 9,
      updatedAt: "2026-08-25T20:04:00.000Z",
    },
    latestSequence: 9,
    unreadCount: 0,
  });
  assert.equal(selectConversationUnreadMentionCount(restored.getState(), laterId), 0);
  assert.equal(
    restored.getState().metadata.conversationListUnreadMentionCounts[laterId],
    0,
  );

  restored.reset();
  assert.deepEqual(restored.getState().metadata.conversationListUnreadMentionCounts, {});
});

test("hydrates list preferences only into the current actor's private cache", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const defaultPreference = conversation("channel", "conversation-default");
  const mentionsOnly = conversation("direct", "conversation-mentions", {
    currentPreference: {
      conversationId: "conversation-mentions",
      userId,
      notificationPreference: "mentions",
      mute: { muted: false },
      updatedAt: "2026-08-25T20:01:00.000Z",
    },
  });
  const muted = conversation("group_direct", "conversation-muted", {
    currentPreference: {
      conversationId: "conversation-muted",
      userId,
      notificationPreference: "none",
      mute: {
        muted: true,
        mutedUntil: "2026-08-26T20:00:00.000Z",
      },
      updatedAt: "2026-08-25T20:02:00.000Z",
    },
  });

  cache.hydrateConversationList(
    listSnapshot([defaultPreference, mentionsOnly, muted]),
  );

  const state = cache.getState();
  assert.deepEqual(Object.keys(state.currentUser.preferences), [
    "conversation-default",
    "conversation-mentions",
    "conversation-muted",
  ]);
  assert.equal(
    state.currentUser.preferences["conversation-default"].notificationPreference,
    "all",
  );
  assert.equal(
    state.currentUser.preferences["conversation-mentions"].notificationPreference,
    "mentions",
  );
  assert.deepEqual(state.currentUser.preferences["conversation-muted"].mute, {
    muted: true,
    mutedUntil: "2026-08-26T20:00:00.000Z",
  });
  for (const conversationId of Object.keys(state.entities.conversations)) {
    assert.equal(
      "currentPreference" in state.entities.conversations[conversationId],
      false,
    );
  }
});

test("links list pages by opaque cursor identity even when pages hydrate out of order", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const cursor = "opaque-page-cursor";
  cache.hydrateConversationList(
    listSnapshot([conversation("channel", "conversation-second")]),
    { requestCursor: cursor },
  );
  assert.deepEqual(
    cache.getState().metadata.conversationLists.organization.conversationIds,
    [],
  );

  cache.hydrateConversationList(
    listSnapshot([conversation("channel", "conversation-first")], cursor),
  );
  assert.deepEqual(
    cache.getState().metadata.conversationLists.organization.conversationIds,
    ["conversation-first", "conversation-second"],
  );
  assert.equal(
    cache.getState().metadata.conversationLists.organization.nextCursor,
    undefined,
  );
});

test("merges timeline pages in stable sequence order, deduplicates, and keeps threads separate", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const parentId = "conversation-channel";
  const threadId = "conversation-thread";
  cache.hydrateConversationList(
    listSnapshot([
      conversation("channel", parentId),
      conversation("thread", threadId),
    ]),
  );

  const first = message(parentId, 1);
  const edited = message(parentId, 2, {
    revision: {
      revision: 2,
      editedAt: "2026-08-25T20:10:00.000Z",
      editedByUserId: userId,
    },
    updatedAt: "2026-08-25T20:10:00.000Z",
    content: { format: "plain", text: "edited" },
  });
  cache.hydrateMessageTimeline(
    page(parentId, [message(parentId, 2), first], {
      eventId: "event-parent-1",
      pagination: { older: { available: true, cursor: 1 } },
    }),
  );
  cache.hydrateMessageTimeline(
    page(parentId, [message(parentId, 3), edited], {
      eventId: "event-parent-2",
      pagination: { newer: { available: true, cursor: 3 } },
    }),
  );
  cache.hydrateMessageTimeline(
    page(threadId, [message(threadId, 1)], { eventId: "event-thread-1" }),
  );

  const state = cache.getState();
  assert.deepEqual(state.timelines[parentId].messageIds, [
    `${parentId}-message-1`,
    `${parentId}-message-2`,
    `${parentId}-message-3`,
  ]);
  assert.deepEqual(state.timelines[threadId].messageIds, [`${threadId}-message-1`]);
  assert.equal(state.entities.messages[`${parentId}-message-2`].revision.revision, 2);
  assert.equal(state.timelines[parentId].realtimeCursor.eventId, "event-parent-2");
  assert.deepEqual(state.timelines[parentId].pagination, {
    older: { available: true, cursor: 1 },
    newer: { available: true, cursor: 3 },
  });
});

test("preserves structural sharing and suppresses unchanged selector notifications", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const conversationId = "conversation-channel";
  cache.hydrateConversationList(
    listSnapshot([conversation("channel", conversationId)]),
  );
  cache.hydrateMessageTimeline(page(conversationId, [message(conversationId, 1)]));

  const before = cache.getState();
  const selectMessages = createConversationMessagesSelector(conversationId);
  const selectedBefore = selectMessages(before);
  const notifications = [];
  const unsubscribe = cache.subscribe(selectMessages, (next, previous) => {
    notifications.push({ next, previous });
  });

  cache.setHuddleState({ status: "inactive", conversationId });
  cache.setRealtimeCursor({ eventId: "event-global" });
  const afterUnrelated = cache.getState();
  assert.equal(selectHuddleState(afterUnrelated, conversationId).status, "inactive");
  assert.equal(afterUnrelated.entities, before.entities);
  assert.equal(afterUnrelated.timelines, before.timelines);
  assert.equal(selectMessages(afterUnrelated), selectedBefore);
  assert.equal(notifications.length, 0);

  cache.hydrateMessageTimeline(
    page(conversationId, [message(conversationId, 2)], { eventId: "event-2" }),
  );
  assert.equal(notifications.length, 1);
  assert.deepEqual(
    notifications[0].next.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.deepEqual(
    notifications[0].previous.map(({ sequence }) => sequence),
    [1],
  );
  unsubscribe();
  cache.hydrateMessageTimeline(
    page(conversationId, [message(conversationId, 3)], { eventId: "event-3" }),
  );
  assert.equal(notifications.length, 1);
});

test("reset and every identity boundary clear public, private, ephemeral, and huddle data", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const conversationId = "conversation-channel";
  const hydrateAll = () => {
    cache.hydrateConversationDetail(
      detailSnapshot(conversation("channel", conversationId)),
    );
    cache.hydrateMessageTimeline(page(conversationId, [message(conversationId, 1)]));
    cache.applyEphemeralSignal(typingEvent(), Date.parse("2026-08-25T20:00:01.000Z"));
    cache.applyEphemeralSignal(presenceEvent(), Date.parse("2026-08-25T20:00:01.000Z"));
    cache.setHuddleState({ status: "inactive", conversationId });
    cache.setRealtimeCursor({ eventId: "event-global" });
  };
  const assertEmpty = () => {
    const state = cache.getState();
    assert.deepEqual(state.entities.conversations, {});
    assert.deepEqual(state.entities.messages, {});
    assert.deepEqual(state.currentUser.memberships, {});
    assert.deepEqual(state.currentUser.readStates, {});
    assert.deepEqual(state.currentUser.preferences, {});
    assert.deepEqual(state.ephemeral.typing, {});
    assert.deepEqual(state.ephemeral.presence, {});
    assert.deepEqual(state.huddles, {});
    assert.deepEqual(state.metadata.conversationLists, {});
    assert.equal(state.metadata.realtimeCursor, undefined);
  };

  hydrateAll();
  cache.reset();
  assertEmpty();

  const identities = [
    { tenantId, userId, sessionId: "session-2" },
    { tenantId, userId: "user-next", sessionId: "session-2" },
    { tenantId: "tenant-2", userId: "user-next", sessionId: "session-2" },
  ];
  for (const identity of identities) {
    cache.setIdentity(initialIdentity);
    hydrateAll();
    cache.setIdentity(identity);
    assert.deepEqual(cache.getState().identity, identity);
    assertEmpty();
  }
});

test("rejects cross-identity private state without changing the cache", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const before = cache.getState();
  const wrongUser = conversation("direct", "conversation-direct", {
    currentReadState: {
      conversationId: "conversation-direct",
      userId: "user-other",
      lastReadSequence: 0,
      updatedAt: "2026-08-25T20:00:00.000Z",
    },
  });

  assert.throws(
    () => cache.hydrateConversationList(listSnapshot([wrongUser])),
    (error) =>
      error instanceof ChatCacheError && error.code === "current_user_mismatch",
  );
  assert.equal(cache.getState(), before);
  assert.equal(selectHuddleState(cache.getState(), "conversation-direct"), undefined);

  const wrongPreferenceActor = conversation("direct", "conversation-direct", {
    currentPreference: {
      conversationId: "conversation-direct",
      userId: "user-other",
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: "2026-08-25T20:00:00.000Z",
    },
  });
  assert.throws(
    () => cache.hydrateConversationList(listSnapshot([wrongPreferenceActor])),
    (error) =>
      error instanceof ChatCacheError && error.code === "current_user_mismatch",
  );
  assert.equal(cache.getState(), before);
});

test("stale list preferences preserve newer canonical and pending optimistic state", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const conversationId = "conversation-preference-freshness";
  const canonical = conversation("channel", conversationId, {
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "mentions",
      mute: { muted: false },
      updatedAt: "2026-08-25T21:00:00.000Z",
    },
  });
  cache.hydrateConversationList(listSnapshot([canonical]));
  const canonicalPreference = cache.getState().currentUser.preferences[conversationId];

  const stale = conversation("channel", conversationId, {
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: "2026-08-25T20:00:00.000Z",
    },
  });
  cache.hydrateConversationList(listSnapshot([stale]));
  assert.equal(
    cache.getState().currentUser.preferences[conversationId],
    canonicalPreference,
  );

  cache.beginOptimisticConversationPreference(
    {
      operation: "update_conversation_preference",
      conversationId,
      expectedPreferenceRevision: 0,
      idempotencyKey: "preference-pending",
      notificationPreference: "none",
      mute: { muted: true },
    },
    "2026-08-25T22:00:00.000Z",
  );
  const projectedPreference = cache.getState().currentUser.preferences[conversationId];
  const pendingPreference =
    cache.getState().currentUser.pendingPreferenceUpdates[conversationId];

  cache.hydrateConversationList(listSnapshot([stale]));
  const state = cache.getState();
  assert.equal(state.currentUser.preferences[conversationId], projectedPreference);
  assert.equal(
    state.currentUser.pendingPreferenceUpdates[conversationId],
    pendingPreference,
  );
  assert.equal(
    state.currentUser.pendingPreferenceUpdates[conversationId]
      .authoritativePreference,
    canonicalPreference,
  );
});

test("older conversation snapshots cannot overwrite newer conversation or private state", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const conversationId = "conversation-freshness";
  const newer = conversation("channel", conversationId, {
    name: "Realtime name",
    latestSequence: 12,
    activityAt: "2026-08-25T22:00:00.000Z",
    updatedAt: "2026-08-25T22:00:00.000Z",
    currentMember: {
      ...privateState(conversationId).currentMember,
      role: "moderator",
      updatedAt: "2026-08-25T22:00:00.000Z",
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: 11,
      updatedAt: "2026-08-25T22:00:00.000Z",
    },
  });
  cache.hydrateConversationDetail({
    ...detailSnapshot(newer),
    conversation: {
      ...detailSnapshot(newer).conversation,
      memberUserIds: [userId, "new-member"],
      currentPreference: {
        ...detailSnapshot(newer).conversation.currentPreference,
        notificationPreference: "none",
        mute: { muted: true, mutedUntil: "2026-08-26T00:00:00.000Z" },
        updatedAt: "2026-08-25T22:00:00.000Z",
      },
    },
  });

  const older = conversation("channel", conversationId, {
    name: "Stale snapshot name",
    latestSequence: 3,
    activityAt: "2026-08-25T20:03:00.000Z",
    updatedAt: "2026-08-25T20:03:00.000Z",
  });
  cache.hydrateConversationList(listSnapshot([older]));
  cache.hydrateConversationDetail(detailSnapshot(older));

  const state = cache.getState();
  assert.equal(state.entities.conversations[conversationId].name, "Realtime name");
  assert.equal(state.metadata.conversations[conversationId].latestSequence, 12);
  assert.equal(state.metadata.conversations[conversationId].activityAt, "2026-08-25T22:00:00.000Z");
  assert.equal(state.currentUser.memberships[conversationId].role, "moderator");
  assert.equal(state.currentUser.readStates[conversationId].lastReadSequence, 11);
  assert.equal(state.currentUser.preferences[conversationId].notificationPreference, "none");
  assert.deepEqual(state.entities.memberUserIdsByConversation[conversationId], [
    userId,
    "new-member",
  ]);
});

test("older timeline snapshots preserve message revisions and the newer realtime baseline", () => {
  const cache = createNormalizedChatCache(initialIdentity);
  const conversationId = "conversation-replay";
  cache.hydrateConversationList(
    listSnapshot([conversation("channel", conversationId, { latestSequence: 8 })]),
  );
  const mutationDerived = message(conversationId, 8, {
    revision: {
      revision: 3,
      editedAt: "2026-08-25T22:00:00.000Z",
      editedByUserId: userId,
    },
    updatedAt: "2026-08-25T22:00:00.000Z",
    content: { format: "plain", text: "new mutation value" },
  });
  cache.hydrateMessageTimeline(
    page(conversationId, [mutationDerived], { eventId: "snapshot-before-realtime" }),
  );
  cache.setRealtimeCursor({ eventId: "realtime-newer" });
  cache.hydrateMessageTimeline(
    page(conversationId, [message(conversationId, 8, {
      revision: { revision: 3 },
      content: { format: "plain", text: "stale equal revision" },
    })], { eventId: "snapshot-stale" }),
  );

  const state = cache.getState();
  assert.equal(state.entities.messages[`${conversationId}-message-8`].content.text, "new mutation value");
  assert.equal(state.timelines[conversationId].realtimeCursor.eventId, "realtime-newer");
  assert.equal(state.metadata.realtimeCursor.eventId, "realtime-newer");
  assert.equal(state.metadata.conversations[conversationId].latestSequence, 8);
});
