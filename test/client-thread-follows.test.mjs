import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventReductionError,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserThreadFollow,
  selectCurrentUserThreadFollowState,
  selectIsCurrentUserFollowingThread,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-thread-follow-client";
const userId = "user-thread-follow-client";
const parentId = "conversation-thread-parent";
const rootId = "message-thread-root";
const threadId = "conversation-thread-follow";
const identity = { tenantId, userId, sessionId: "session-thread-follow-client" };
const at = (second) =>
  `2037-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;
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

const detail = (conversation) => ({
  kind: "conversation_detail",
  conversation: {
    ...conversation,
    latestSequence: 0,
    activityAt: at(0),
    currentMember: {
      tenantId,
      conversationId: conversation.id,
      userId,
      role: "member",
      state: "active",
      joinedAt: at(0),
      updatedAt: at(0),
    },
    currentReadState: {
      conversationId: conversation.id,
      userId,
      lastReadSequence: 0,
      updatedAt: at(0),
    },
    memberUserIds: [userId],
    currentPreference: {
      conversationId: conversation.id,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: at(0),
    },
  },
  _meta: metadata,
});

const seed = ({ includeRoot = true } = {}) => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationDetail(detail({
    id: parentId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: "Thread parent",
    createdAt: at(0),
    updatedAt: at(0),
  }));
  if (includeRoot) {
    cache.hydrateMessageTimeline({
      conversationId: parentId,
      messages: [{
        id: rootId,
        tenantId,
        conversationId: parentId,
        author: { type: "user", userId: "user-other" },
        sequence: 1,
        createdAt: at(0),
        updatedAt: at(0),
        revision: { revision: 1 },
        content: { format: "plain", text: "root" },
        isThreadRoot: true,
        reactions: [],
        attachmentMetadata: [],
      }],
      pagination: {
        older: { available: false },
        newer: { available: false },
      },
      replay: { resumeFrom: { eventId: "thread-follow-snapshot" } },
    });
  }
  cache.hydrateConversationDetail(detail({
    id: threadId,
    tenantId,
    type: "thread",
    visibility: "public",
    parentConversationId: parentId,
    rootMessageId: rootId,
    createdAt: at(0),
    updatedAt: at(0),
  }));
  return cache;
};

const followState = (isFollowing, source = "manual", second = 10) => ({
  target: { type: "thread", id: threadId },
  isFollowing,
  source,
  updatedAt: at(second),
});

const result = (input, {
  reconciliationStatus = "applied",
  followRevision = input.expectedFollowRevision + 1,
  follow = followState(input.intent === "follow", "manual", followRevision + 10),
} = {}) => ({
  operation: "set_thread_follow",
  intent: input.intent,
  reconciliationStatus,
  target: input.target,
  expectedFollowRevision: input.expectedFollowRevision,
  idempotencyKey: input.idempotencyKey,
  followRevision,
  follow,
});

const followEvent = (eventId, revision, follow, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: overrides.tenantId ?? tenantId,
  streamId: overrides.streamId ?? `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.threadFollowUpdated,
  occurredAt: overrides.occurredAt ?? at(revision + 20),
  payload: {
    operation: "set_thread_follow",
    target: { type: "thread", id: threadId },
    followRevision: revision,
    follow,
  },
});

const flush = async () => {
  await new Promise(setImmediate);
};

test("follow and unfollow use explicit PATCH intent and stable safe-retry identity", async () => {
  const cache = seed();
  const requests = [];
  let key = 0;
  let transient = true;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    threadFollows: {
      generateIdempotencyKey: () => `thread-follow-key-${++key}`,
      now: () => Date.parse(at(1)),
    },
    commands: { retry: { maxAttempts: 2, wait: async () => undefined } },
    async fetch(url, init) {
      const input = JSON.parse(init.body);
      requests.push({ url, input, key: init.headers["idempotency-key"] });
      if (transient) {
        transient = false;
        throw new Error("temporary");
      }
      return response(result(input));
    },
  });

  const following = client.followThread(threadId);
  assert.equal(selectIsCurrentUserFollowingThread(cache.getState(), threadId), true);
  assert.equal(selectCurrentUserThreadFollowState(cache.getState(), threadId).pending.intent, "follow");
  assert.equal((await following).status, "success");
  assert.equal(requests[0].url, `/chat/conversations/${threadId}/follow`);
  assert.equal(requests[0].key, "thread-follow-key-1");
  assert.equal(requests[1].key, "thread-follow-key-1");
  assert.deepEqual(requests.slice(0, 2).map(({ input }) => input), [requests[0].input, requests[0].input]);

  assert.equal((await client.unfollowThread(threadId)).status, "success");
  assert.deepEqual(requests.map(({ input }) => [input.intent, input.expectedFollowRevision]), [
    ["follow", 0], ["follow", 0], ["unfollow", 1],
  ]);
  const selected = selectCurrentUserThreadFollowState(cache.getState(), threadId);
  assert.equal(selected.follow.isFollowing, false);
  assert.equal(selected.follow.source, "manual");
  assert.equal(selected.authoritativeRevision, 2);
  assert.equal(selected.pending, undefined);
});

test("rapid follow→unfollow and unfollow→follow preserve the newest projection", async () => {
  for (const [initial, firstIntent, latestIntent] of [
    [undefined, "follow", "unfollow"],
    [followState(true, "manual", 10), "unfollow", "follow"],
  ]) {
    const cache = seed();
    if (initial !== undefined) {
      cache.applyDurableEvent(followEvent("initial-follow", 1, initial));
    }
    const requests = [];
    let releaseFirst;
    let key = 0;
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "token",
      cache,
      threadFollows: {
        generateIdempotencyKey: () => `rapid-${firstIntent}-${++key}`,
        now: () => Date.parse(at(2)),
      },
      async fetch(_url, init) {
        const input = JSON.parse(init.body);
        requests.push(input);
        if (requests.length === 1) {
          return new Promise((resolve) => { releaseFirst = () => resolve(response(result(input))); });
        }
        return response(result(input));
      },
    });
    const first = client.setThreadFollow({ threadId, intent: firstIntent });
    const latest = client.setThreadFollow({ threadId, intent: latestIntent });
    assert.equal(
      selectIsCurrentUserFollowingThread(cache.getState(), threadId),
      latestIntent === "follow",
    );
    await flush();
    assert.equal(requests.length, 1);
    releaseFirst();
    assert.equal((await first).status, "success");
    assert.equal(
      selectIsCurrentUserFollowingThread(cache.getState(), threadId),
      latestIntent === "follow",
    );
    assert.equal((await latest).status, "success");
    assert.deepEqual(requests.map(({ expectedFollowRevision }) => expectedFollowRevision),
      initial === undefined ? [0, 1] : [1, 2]);
    assert.equal(selectCurrentUserThreadFollowState(cache.getState(), threadId).pending, undefined);
  }
});

test("manual unfollow stays distinct from reply and mention auto-follow", async () => {
  const cache = seed();
  cache.applyDurableEvent(followEvent("reply-follow", 1, followState(true, "reply", 21)));
  assert.equal(selectCurrentUserThreadFollow(cache.getState(), threadId).source, "reply");

  let request;
  let release;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    threadFollows: {
      generateIdempotencyKey: () => "manual-unfollow",
      now: () => Date.parse(at(3)),
    },
    async fetch(_url, init) {
      request = JSON.parse(init.body);
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const pending = client.unfollowThread(threadId);
  await flush();
  cache.applyDurableEvent(followEvent("mention-follow", 2, followState(true, "mention", 22)));
  assert.equal(selectCurrentUserThreadFollow(cache.getState(), threadId).isFollowing, false);
  assert.equal(selectCurrentUserThreadFollow(cache.getState(), threadId).source, "manual");
  release(response(result(request)));
  assert.equal((await pending).status, "success");
  assert.equal(selectCurrentUserThreadFollowState(cache.getState(), threadId).authoritativeRevision, 2);

  const before = selectCurrentUserThreadFollow(cache.getState(), threadId);
  cache.applyDurableEvent(followEvent("reply-after-manual", 3, followState(true, "reply", 23)));
  assert.equal(selectCurrentUserThreadFollow(cache.getState(), threadId), before);
  assert.equal(selectCurrentUserThreadFollowState(cache.getState(), threadId).authoritativeRevision, 2);
});

test("private event and HTTP response converge in either order without duplicate settlement", async () => {
  for (const ordering of ["event-first", "response-first"]) {
    const cache = seed();
    let request;
    let release;
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "token",
      cache,
      threadFollows: {
        generateIdempotencyKey: () => `${ordering}-key`,
        now: () => Date.parse(at(4)),
      },
      async fetch(_url, init) {
        request = JSON.parse(init.body);
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const pending = client.followThread(threadId);
    await flush();
    const canonical = result(request);
    const event = followEvent(`${ordering}-event`, 1, canonical.follow);
    if (ordering === "event-first") {
      cache.applyDurableEvent(event);
      assert.equal(selectCurrentUserThreadFollowState(cache.getState(), threadId).pending.idempotencyKey, `${ordering}-key`);
      release(response(canonical));
      assert.equal((await pending).status, "success");
    } else {
      release(response(canonical));
      assert.equal((await pending).status, "success");
      const before = cache.getState();
      cache.applyDurableEvent(event);
      assert.equal(selectCurrentUserThreadFollow(cache.getState(), threadId), selectCurrentUserThreadFollow(before, threadId));
    }
    const selected = selectCurrentUserThreadFollowState(cache.getState(), threadId);
    assert.equal(selected.authoritativeRevision, 1, ordering);
    assert.equal(selected.pending, undefined, ordering);
  }
});

test("conflict adopts canonical state, authorization rolls back, and invalid targets never mutate the network", async () => {
  const cache = seed();
  let call = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    threadFollows: {
      generateIdempotencyKey: () => `settle-${++call}`,
      now: () => Date.parse(at(5)),
    },
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      if (call === 1) {
        return response(result(input, {
          reconciliationStatus: "follow_revision_conflict",
          followRevision: 4,
          follow: followState(false, "manual", 24),
        }), 409);
      }
      return response({ error: { code: "FORBIDDEN", message: "denied" } }, 403);
    },
  });
  assert.equal((await client.followThread(threadId)).status, "success");
  assert.equal(selectIsCurrentUserFollowingThread(cache.getState(), threadId), false);
  assert.equal(selectCurrentUserThreadFollowState(cache.getState(), threadId).authoritativeRevision, 4);
  assert.equal((await client.followThread(threadId)).status, "authentication");
  assert.equal(selectIsCurrentUserFollowingThread(cache.getState(), threadId), false);

  let networkCalls = 0;
  const invalidCache = seed({ includeRoot: false });
  const invalidClient = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache: invalidCache,
    async fetch() { networkCalls += 1; return response({}); },
  });
  assert.equal((await invalidClient.followThread(parentId)).status, "validation");
  assert.equal((await invalidClient.followThread(threadId)).status, "validation");
  assert.equal(networkCalls, 0);
  assert.deepEqual(invalidCache.getState().currentUser.threadFollows, {});
});

test("malformed responses and exhausted transport failures roll back only their matching intent", async () => {
  for (const failure of ["malformed_response", "transport"]) {
    const cache = seed();
    cache.applyDurableEvent(followEvent(`${failure}-seed`, 1, followState(true, "reply", 25)));
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "token",
      cache,
      threadFollows: {
        generateIdempotencyKey: () => `${failure}-key`,
        now: () => Date.parse(at(6)),
      },
      commands: { retry: { maxAttempts: 1 } },
      async fetch() {
        if (failure === "transport") throw new Error("offline");
        return response({ malformed: true });
      },
    });
    const pending = client.unfollowThread(threadId);
    assert.equal(selectIsCurrentUserFollowingThread(cache.getState(), threadId), false);
    assert.equal((await pending).status, failure);
    const selected = selectCurrentUserThreadFollowState(cache.getState(), threadId);
    assert.equal(selected.follow.isFollowing, true);
    assert.equal(selected.follow.source, "reply");
    assert.equal(selected.pending, undefined);
    assert.equal(selected.authoritativeRevision, 1);
  }
});

test("identity changes and tenant/user private-stream mismatches cannot leak follow state", async () => {
  const cache = seed();
  cache.applyDurableEvent(followEvent("private-follow", 1, followState(true, "manual", 25)));
  const hydrated = createNormalizedChatCache(identity);
  assert.equal(
    hydrated.hydrateCanonicalState(JSON.parse(JSON.stringify(cache.getState()))),
    true,
  );
  assert.equal(selectIsCurrentUserFollowingThread(hydrated.getState(), threadId), true);
  cache.setIdentity({ tenantId, userId: "user-next", sessionId: "session-next" });
  assert.deepEqual(cache.getState().currentUser.threadFollows, {});
  assert.deepEqual(cache.getState().currentUser.threadFollowRevisions, {});
  assert.deepEqual(cache.getState().currentUser.pendingThreadFollowUpdates, {});

  const isolated = seed();
  for (const invalidEvent of [
    followEvent("wrong-user", 1, followState(true), { streamId: "user:user-other" }),
    followEvent("wrong-tenant", 1, followState(true), { tenantId: "tenant-other" }),
  ]) {
    const before = isolated.getState();
    assert.throws(
      () => isolated.applyDurableEvent(invalidEvent),
      (error) => error instanceof DurableEventReductionError,
    );
    assert.equal(isolated.getState(), before);
  }
});

for (const [clock, occurredAt] of [
  ["tied", "2026-08-26T06:00:01.123Z"],
  ["decreasing", "2026-08-26T06:00:01.122Z"],
]) {
  const highWater = "2026-08-26T06:00:01.123Z";

  test(`thread follows reconcile two threads with ${clock} stream clocks`, () => {
    const cache = seed();
    const secondThreadId = "conversation-thread-b";
    cache.hydrateConversationDetail(detail({
      id: secondThreadId,
      tenantId,
      type: "thread",
      visibility: "public",
      parentConversationId: parentId,
      rootMessageId: rootId,
      createdAt: at(0),
      updatedAt: at(0),
    }));
    const firstFollow = followState(true);
    const secondFollow = {
      ...followState(true),
      target: { type: "thread", id: secondThreadId },
    };
    const first = followEvent("thread-a-revision-1", 1, firstFollow, { occurredAt: highWater });
    const second = followEvent("thread-b-revision-1", 1, secondFollow, { occurredAt });
    second.payload.target = secondFollow.target;

    assert.equal(cache.applyDurableEvent(first).status, "applied");
    assert.equal(cache.applyDurableEvent(second).status, "applied");
    const state = cache.getState();
    assert.deepEqual(state.currentUser.threadFollows, {
      [threadId]: firstFollow,
      [secondThreadId]: secondFollow,
    });
    assert.deepEqual(state.currentUser.threadFollowRevisions, {
      [threadId]: 1,
      [secondThreadId]: 1,
    });
    assert.deepEqual(state.metadata.realtimeCursor, { eventId: second.eventId });
    assert.deepEqual(state.metadata.durableStreams[first.streamId], {
      lastEventId: second.eventId,
      lastOccurredAt: highWater,
      recentEventIds: [first.eventId, second.eventId],
    });
    for (const replay of [first, second]) {
      assert.equal(cache.applyDurableEvent(replay).status, "duplicate");
      assert.equal(cache.getState(), state);
    }
  });

  test(`thread follow revision and validation guards survive ${clock} stream clocks`, () => {
    const cache = seed();
    const canonical = followState(true);
    cache.applyDurableEvent(followEvent("canonical-revision-2", 2, canonical, { occurredAt: highWater }));
    const older = followEvent("older-revision-1", 1, followState(false), { occurredAt });
    assert.equal(cache.applyDurableEvent(older).status, "applied");
    assert.deepEqual(cache.getState().currentUser.threadFollows[threadId], canonical);
    assert.equal(cache.getState().currentUser.threadFollowRevisions[threadId], 2);
    assert.deepEqual(cache.getState().metadata.realtimeCursor, { eventId: older.eventId });
    assert.equal(cache.getState().metadata.durableStreams[older.streamId].lastOccurredAt, highWater);

    // Seed the wrong stream's clock too, so stream ordering cannot mask identity validation.
    const snapshot = JSON.parse(JSON.stringify(cache.getState()));
    snapshot.metadata.durableStreams["user:user-other"] = snapshot.metadata.durableStreams[older.streamId];
    assert.equal(cache.hydrateCanonicalState(snapshot), true);
    const malformed = followEvent("malformed-follow", 3, followState(false), { occurredAt });
    malformed.payload.followRevision = "3";
    const unknownTarget = followEvent("unknown-thread", 3, {
      ...followState(false), target: { type: "thread", id: "unknown-thread" },
    }, { occurredAt });
    unknownTarget.payload.target = unknownTarget.payload.follow.target;
    for (const [invalid, code] of [
      [followEvent("wrong-private-stream", 3, followState(false), { occurredAt, streamId: "user:user-other" }), "private_stream_mismatch"],
      [malformed, "incoherent_payload"],
      [unknownTarget, "ordering_gap"],
      [followEvent("equal-revision-conflict", 2, followState(false), { occurredAt }), "incoherent_payload"],
    ]) {
      const before = cache.getState();
      assert.throws(
        () => cache.applyDurableEvent(invalid),
        (error) => error instanceof DurableEventReductionError && error.diagnostic.code === code,
      );
      assert.equal(cache.getState(), before);
    }
  });
}
