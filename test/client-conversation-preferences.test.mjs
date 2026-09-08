import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventReductionError,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserPreference,
  selectCurrentUserPreferenceState,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-preference-client";
const userId = "user-preference-client";
const conversationId = "conversation-preference-client";
const identity = { tenantId, userId, sessionId: "session-preference-client" };
const at = (second) =>
  `2034-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;
const metadata = {
  packageVersion: "0.1.3",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const desired = (input) => ({
  notificationPreference: input.notificationPreference,
  isStarred: input.isStarred,
  mute: input.mute,
});

const result = (input, {
  reconciliationStatus = "applied",
  preferenceRevision = input.expectedPreferenceRevision + 1,
  preference = desired(input),
  updatedAt = at(preferenceRevision + 10),
} = {}) => ({
  operation: "update_conversation_preference",
  reconciliationStatus,
  conversationId: input.conversationId,
  expectedPreferenceRevision: input.expectedPreferenceRevision,
  idempotencyKey: input.idempotencyKey,
  requestedPreference: desired(input),
  preferenceRevision,
  preference: { ...preference, updatedAt },
});

const detail = (
  id = conversationId,
  actorUserId = userId,
  preferenceOverrides = {},
) => ({
  kind: "conversation_detail",
  conversation: {
    id,
    tenantId,
    type: "channel",
    visibility: "public",
    name: "Preference tests",
    createdAt: at(0),
    updatedAt: at(0),
    latestSequence: 0,
    activityAt: at(0),
    currentMember: {
      tenantId,
      conversationId: id,
      userId: actorUserId,
      role: "member",
      state: "active",
      joinedAt: at(0),
      updatedAt: at(0),
    },
    currentReadState: {
      conversationId: id,
      userId: actorUserId,
      lastReadSequence: 0,
      updatedAt: at(0),
    },
    memberUserIds: [actorUserId],
    currentPreference: {
      conversationId: id,
      userId: actorUserId,
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: false },
      updatedAt: at(0),
      ...preferenceOverrides,
    },
  },
  _meta: metadata,
});

const list = (preferenceOverrides = {}) => {
  const snapshot = detail(conversationId, userId, preferenceOverrides);
  const { memberUserIds: _memberUserIds, ...summary } = snapshot.conversation;
  return {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [{
      ...summary,
      unreadMentionCount: 0,
      hasActiveHuddle: false,
      activeMemberUserIds: [userId],
    }],
    page: {},
    _meta: metadata,
  };
};

const seed = (cacheIdentity = identity) => {
  const cache = createNormalizedChatCache(cacheIdentity);
  cache.hydrateConversationDetail(detail());
  return cache;
};

const preferenceEvent = (input, canonical, overrides = {}) => ({
  eventId: overrides.eventId ?? `event-${input.idempotencyKey}`,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: overrides.streamId ?? `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
  occurredAt: overrides.occurredAt ?? at(30),
  payload: {
    actorUserId: overrides.actorUserId ?? userId,
    input,
    result: canonical,
  },
});

test("projects star, notification, and mute state immediately and retries one stable request", async () => {
  const cache = seed();
  const requests = [];
  let keys = 0;
  let failFirst = true;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    conversationPreferences: {
      generateIdempotencyKey: () => `preference-key-${++keys}`,
      now: () => Date.parse(at(1)),
    },
    commands: { retry: { maxAttempts: 2, wait: async () => undefined } },
    async fetch(url, init) {
      const input = JSON.parse(init.body);
      requests.push({ url, input, key: init.headers["idempotency-key"] });
      if (failFirst) {
        failFirst = false;
        throw new Error("transient");
      }
      return response(result(input));
    },
  });

  assert.equal(
    selectCurrentUserPreference(cache.getState(), conversationId).isStarred,
    false,
  );
  const states = [
    { notificationPreference: "all", isStarred: true, mute: { muted: false } },
    { notificationPreference: "mentions", isStarred: false, mute: { muted: true } },
    {
      notificationPreference: "none",
      isStarred: true,
      mute: { muted: true, mutedUntil: "2035-02-03T04:05:06.000Z" },
    },
  ];
  for (const desiredState of states) {
    const pending = client.updateConversationPreference({
      conversationId,
      ...desiredState,
    });
    assert.deepEqual(
      {
        notificationPreference:
          selectCurrentUserPreference(cache.getState(), conversationId)
            .notificationPreference,
        isStarred:
          selectCurrentUserPreference(cache.getState(), conversationId)
            .isStarred,
        mute: selectCurrentUserPreference(cache.getState(), conversationId).mute,
      },
      desiredState,
    );
    assert.equal(
      selectCurrentUserPreferenceState(cache.getState(), conversationId).pending
        .state,
      "pending",
    );
    assert.equal((await pending).status, "success");
    assert.deepEqual(
      desired(selectCurrentUserPreference(cache.getState(), conversationId)),
      desiredState,
    );
  }

  assert.equal(requests[0].url, `/chat/conversations/${conversationId}/preference`);
  assert.equal(requests[0].key, "preference-key-1");
  assert.equal(requests[1].key, "preference-key-1");
  assert.equal(requests[0].input.idempotencyKey, requests[1].input.idempotencyKey);
  assert.deepEqual(requests.map(({ input }) => input.expectedPreferenceRevision), [0, 0, 1, 2]);
  assert.equal(
    selectCurrentUserPreferenceState(cache.getState(), conversationId)
      .authoritativeRevision,
    3,
  );
});

test("a rejected transport restores the authoritative unstarred value", async () => {
  const cache = seed();
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    conversationPreferences: {
      generateIdempotencyKey: () => "rollback-key",
      now: () => Date.parse(at(2)),
    },
    commands: { retry: { maxAttempts: 1 } },
    async fetch() {
      throw new Error("offline");
    },
  });

  const pending = client.updateConversationPreference({
    conversationId,
    notificationPreference: "all",
    isStarred: true,
    mute: { muted: false },
  });
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  assert.equal((await pending).status, "transport");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, false);
  assert.equal(
    selectCurrentUserPreferenceState(cache.getState(), conversationId).pending,
    undefined,
  );
});

test("rapid replacement preserves the latest projection across a stale permanent failure", async () => {
  const cache = seed();
  const requests = [];
  let firstRelease;
  let keys = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    conversationPreferences: {
      generateIdempotencyKey: () => `rapid-key-${++keys}`,
      now: () => Date.parse(at(2)),
    },
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      requests.push(input);
      if (requests.length === 1) {
        return new Promise((resolve) => { firstRelease = resolve; });
      }
      return response(result(input));
    },
  });

  const stale = client.updateConversationPreference({
    conversationId,
    notificationPreference: "mentions",
    isStarred: false,
    mute: { muted: true },
  });
  const latest = client.updateConversationPreference({
    conversationId,
    notificationPreference: "none",
    isStarred: true,
    mute: { muted: false },
  });
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "none");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  await new Promise(setImmediate);
  assert.equal(requests.length, 1, "replacement waits for the earlier operation");
  firstRelease(response({ error: { code: "FORBIDDEN", message: "denied" } }, 403));
  const staleResult = await stale;
  assert.equal(staleResult.status, "rejected");
  assert.equal(staleResult.httpStatus, 403);
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "none");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  assert.equal((await latest).status, "success");
  assert.equal(requests[1].expectedPreferenceRevision, 0);
  assert.equal(selectCurrentUserPreferenceState(cache.getState(), conversationId).pending, undefined);
});

test("revision conflict adopts authoritative private state while an unauthorized latest update rolls back", async () => {
  const cache = seed();
  let call = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    conversationPreferences: {
      generateIdempotencyKey: () => `settle-key-${++call}`,
      now: () => Date.parse(at(3)),
    },
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      if (call === 1) {
        return response(result(input, {
          reconciliationStatus: "preference_revision_conflict",
          preferenceRevision: 4,
          preference: {
            notificationPreference: "mentions",
            isStarred: true,
            mute: { muted: true },
          },
        }), 409);
      }
      return response({ error: { code: "FORBIDDEN", message: "denied" } }, 403);
    },
  });

  assert.equal((await client.updateConversationPreference({
    conversationId,
    notificationPreference: "none",
    isStarred: false,
    mute: { muted: false },
  })).status, "success");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "mentions");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  assert.equal(selectCurrentUserPreferenceState(cache.getState(), conversationId).authoritativeRevision, 4);

  const unauthorized = client.updateConversationPreference({
    conversationId,
    notificationPreference: "all",
    isStarred: false,
    mute: { muted: false },
  });
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "all");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, false);
  const unauthorizedResult = await unauthorized;
  assert.equal(unauthorizedResult.status, "rejected");
  assert.equal(unauthorizedResult.httpStatus, 403);
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "mentions");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  assert.equal(selectCurrentUserPreferenceState(cache.getState(), conversationId).authoritativeRevision, 4);
});

test("private event before response and response before event converge without preference regression", async () => {
  for (const ordering of ["event-first", "response-first"]) {
    const cache = seed();
    let release;
    let request;
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "token",
      cache,
      conversationPreferences: {
        generateIdempotencyKey: () => `${ordering}-key`,
        now: () => Date.parse(at(4)),
      },
      async fetch(_url, init) {
        request = JSON.parse(init.body);
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const pending = client.updateConversationPreference({
      conversationId,
      notificationPreference: "none",
      isStarred: true,
      mute: { muted: true, mutedUntil: "2036-01-01T00:00:00.000Z" },
    });
    await new Promise(setImmediate);
    const canonical = result(request);
    if (ordering === "event-first") {
      cache.applyDurableEvent(preferenceEvent(request, canonical));
      release(response(canonical));
      assert.equal((await pending).status, "success");
    } else {
      release(response(canonical));
      assert.equal((await pending).status, "success");
      const beforeEvent = selectCurrentUserPreference(cache.getState(), conversationId);
      cache.applyDurableEvent(preferenceEvent(request, canonical));
      assert.equal(selectCurrentUserPreference(cache.getState(), conversationId), beforeEvent);
    }
    const selected = selectCurrentUserPreferenceState(cache.getState(), conversationId);
    assert.equal(selected.preference.notificationPreference, "none", ordering);
    assert.equal(selected.preference.isStarred, true, ordering);
    assert.equal(selected.authoritativeRevision, 1, ordering);
    assert.equal(selected.pending, undefined, ordering);
  }
});

test("stale results, older durable events, and duplicate events cannot regress a newer star", () => {
  const cache = seed();
  const newerInput = {
    operation: "update_conversation_preference",
    conversationId,
    expectedPreferenceRevision: 1,
    idempotencyKey: "newer-star",
    notificationPreference: "mentions",
    isStarred: true,
    mute: { muted: false },
  };
  const newerResult = result(newerInput);
  const newerEvent = preferenceEvent(newerInput, newerResult, {
    eventId: "newer-star-event",
    occurredAt: at(32),
  });

  assert.equal(cache.applyDurableEvent(newerEvent).status, "applied");
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  assert.equal(
    selectCurrentUserPreferenceState(cache.getState(), conversationId)
      .authoritativeRevision,
    2,
  );
  const afterNewer = cache.getState();
  assert.equal(cache.applyDurableEvent(newerEvent).status, "duplicate");
  assert.equal(cache.getState(), afterNewer);

  const olderInput = {
    operation: "update_conversation_preference",
    conversationId,
    expectedPreferenceRevision: 0,
    idempotencyKey: "older-unstar",
    notificationPreference: "all",
    isStarred: false,
    mute: { muted: false },
  };
  const olderResult = result(olderInput);
  assert.equal(cache.applyDurableEvent(preferenceEvent(olderInput, olderResult, {
    eventId: "older-unstar-event",
    occurredAt: at(31),
  })).status, "applied");
  const afterOlder = cache.getState();
  assert.equal(afterOlder.metadata.realtimeCursor.eventId, "older-unstar-event");
  const privateStream = afterOlder.metadata.durableStreams[`user:${userId}`];
  assert.equal(privateStream.lastEventId, "older-unstar-event");
  assert.deepEqual(privateStream.recentEventIds, ["newer-star-event", "older-unstar-event"]);
  assert.equal(privateStream.lastOccurredAt, newerEvent.occurredAt);
  const newerPreference = { ...newerResult.preference, conversationId, userId };
  assert.deepEqual(selectCurrentUserPreference(afterOlder, conversationId), newerPreference);
  assert.equal(
    selectCurrentUserPreferenceState(afterOlder, conversationId).authoritativeRevision,
    2,
  );

  cache.reconcileCurrentUserConversationPreference(olderInput, olderResult);
  assert.equal(cache.getState(), afterOlder);
  assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).isStarred, true);
  assert.equal(
    selectCurrentUserPreferenceState(cache.getState(), conversationId)
      .authoritativeRevision,
    2,
  );

  const pendingCache = seed();
  const pendingInput = {
    ...olderInput,
    idempotencyKey: "pending-stale-unstar",
  };
  pendingCache.beginOptimisticConversationPreference(pendingInput, at(21));
  assert.equal(
    selectCurrentUserPreferenceState(pendingCache.getState(), conversationId)
      .pending.desiredPreference.isStarred,
    false,
  );
  pendingCache.applyDurableEvent(newerEvent);
  assert.equal(
    selectCurrentUserPreference(pendingCache.getState(), conversationId).isStarred,
    false,
    "the pending intent remains projected until its own request settles",
  );
  pendingCache.reconcileCurrentUserConversationPreference(
    pendingInput,
    result(pendingInput),
  );
  const settled = selectCurrentUserPreferenceState(
    pendingCache.getState(),
    conversationId,
  );
  assert.equal(settled.preference.isStarred, true);
  assert.deepEqual(settled.preference, newerPreference);
  assert.equal(settled.authoritativeRevision, 2);
  assert.equal(settled.pending, undefined);
});

test("list and detail snapshot hydration expose the same starred selector value", () => {
  const canonical = {
    notificationPreference: "mentions",
    isStarred: true,
    mute: { muted: false },
    updatedAt: at(20),
  };
  const listCache = createNormalizedChatCache(identity);
  const detailCache = createNormalizedChatCache(identity);

  listCache.hydrateConversationList(list(canonical));
  detailCache.hydrateConversationDetail(detail(conversationId, userId, canonical));
  assert.deepEqual(
    selectCurrentUserPreference(listCache.getState(), conversationId),
    selectCurrentUserPreference(detailCache.getState(), conversationId),
  );
  assert.equal(
    selectCurrentUserPreference(listCache.getState(), conversationId).isStarred,
    true,
  );

  listCache.hydrateConversationDetail(detail(conversationId, userId, canonical));
  detailCache.hydrateConversationList(list(canonical));
  assert.deepEqual(
    selectCurrentUserPreference(listCache.getState(), conversationId),
    selectCurrentUserPreference(detailCache.getState(), conversationId),
  );
});

test("identity changes and mismatched private events cannot leak preference state", async () => {
  const cache = seed();
  let release;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    conversationPreferences: {
      generateIdempotencyKey: () => "identity-key",
      now: () => Date.parse(at(5)),
    },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      return new Promise((resolve) => {
        release = () => resolve(response(result(input)));
      });
    },
  });
  const pending = client.updateConversationPreference({
    conversationId,
    notificationPreference: "none",
    isStarred: true,
    mute: { muted: true },
  });
  await new Promise(setImmediate);
  cache.setIdentity({ tenantId, userId: "user-next", sessionId: "session-next" });
  release();
  assert.equal((await pending).status, "success");
  assert.deepEqual(cache.getState().currentUser.preferences, {});
  assert.deepEqual(cache.getState().currentUser.preferenceRevisions, {});
  assert.deepEqual(cache.getState().currentUser.pendingPreferenceUpdates, {});

  const before = cache.getState();
  assert.throws(
    () => cache.applyDurableEvent(preferenceEvent(
      {
        operation: "update_conversation_preference",
        conversationId,
        expectedPreferenceRevision: 0,
        idempotencyKey: "mismatch-key",
        notificationPreference: "all",
        isStarred: false,
        mute: { muted: false },
      },
      result({
        operation: "update_conversation_preference",
        conversationId,
        expectedPreferenceRevision: 0,
        idempotencyKey: "mismatch-key",
        notificationPreference: "all",
        isStarred: false,
        mute: { muted: false },
      }),
      { eventId: "mismatch", streamId: `user:${userId}` },
    )),
    (error) => error instanceof DurableEventReductionError,
  );
  assert.equal(cache.getState(), before);

  const hydrated = seed();
  const crossUserState = JSON.parse(JSON.stringify(hydrated.getState()));
  crossUserState.currentUser.preferences[conversationId].userId = "user-other";
  assert.equal(hydrated.hydrateCanonicalState(crossUserState), false);
  assert.equal(
    hydrated.getState().currentUser.preferences[conversationId].userId,
    userId,
  );
});

for (const hydration of ["detail", "list"]) {
  test(`${hydration} hydrates preference revisions for the first save and rejects stale snapshots`, async () => {
    const cache = createNormalizedChatCache(identity);
    const hydrate = (preference) => hydration === "detail"
      ? cache.hydrateConversationDetail(detail(conversationId, userId, preference))
      : cache.hydrateConversationList(list(preference));
    hydrate({ preferenceRevision: 1 });
    const requests = [];
    const client = createChatClient({
      endpoint: "/chat", getAccessToken: () => "token", cache,
      async fetch(_url, init) {
        const input = JSON.parse(init.body);
        requests.push(input);
        return response(result(input));
      },
    });
    try {
      const saved = await client.updateConversationPreference({
        conversationId, notificationPreference: "mentions", isStarred: false, mute: { muted: false },
      });
      assert.equal(saved.status, "success");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].expectedPreferenceRevision, 1);
      assert.equal(cache.getState().currentUser.preferenceRevisions[conversationId], 2);
      hydrate({ preferenceRevision: 1, updatedAt: at(50) });
      assert.equal(cache.getState().currentUser.preferenceRevisions[conversationId], 2);
      assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "mentions");
      hydrate({ preferenceRevision: 3, notificationPreference: "none", updatedAt: at(0) });
      assert.equal(cache.getState().currentUser.preferenceRevisions[conversationId], 3);
      assert.equal(selectCurrentUserPreference(cache.getState(), conversationId).notificationPreference, "none");
    } finally { client.close(); }
  });
}
