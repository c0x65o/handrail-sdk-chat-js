import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-thread-client";
const userId = "user-thread-client";
const parentConversationId = "conversation-parent";
const rootMessageId = "message-root";
const threadConversationId = "conversation-thread";
const now = "2030-01-01T00:00:00.000Z";
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { realtime: true, thread_creation: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const snapshotMetadata = {
  ...metadata,
  feature: { name: "conversation_snapshots", version: 1 },
};

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  async json() { return body; },
});

const message = (conversationId, sequence, id = `${conversationId}-${sequence}`) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: "user-other" },
  sequence,
  createdAt: now,
  updatedAt: now,
  revision: { revision: 1 },
  content: { format: "plain", text: `message ${sequence}` },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
});

const timeline = (
  conversationId,
  messages,
  pagination = {
    older: { available: false },
    newer: { available: false },
  },
) => ({
  conversationId,
  messages,
  pagination,
  replay: { resumeFrom: { eventId: `snapshot-${conversationId}-${messages.length}` } },
});

const threadDetail = () => ({
  kind: "conversation_detail",
  conversation: {
    id: threadConversationId,
    tenantId,
    type: "thread",
    visibility: "private",
    parentConversationId,
    rootMessageId,
    currentThreadFollow: { followRevision: 0, follow: null },
    createdAt: now,
    updatedAt: now,
    activityAt: now,
    latestSequence: 2,
    unreadMentionCount: 0,
    activeMemberUserIds: [userId, "user-other"],
    currentMember: {
      tenantId,
      conversationId: threadConversationId,
      userId,
      role: "member",
      state: "active",
      joinedAt: now,
      updatedAt: now,
    },
    currentReadState: {
      conversationId: threadConversationId,
      userId,
      lastReadSequence: 0,
      updatedAt: now,
    },
    memberUserIds: [userId, "user-other"],
    currentPreference: {
      conversationId: threadConversationId,
      userId,
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: false },
      updatedAt: now,
    },
  },
  _meta: snapshotMetadata,
});

const threadResult = (reconciliationStatus = "created") => ({
  operation: "create_thread",
  reconciliationStatus,
  parentConversationId,
  rootMessageId,
  conversation: threadDetail(),
  rootThreadSummary: {
    threadId: threadConversationId,
    replyCount: 2,
    participantIds: ["user-other"],
    unreadCount: 2,
    lastReplyAt: now,
  },
});

const createCache = () => {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: "session-thread-client",
  });
  cache.hydrateMessageTimeline(timeline(parentConversationId, [
    message(parentConversationId, 1, rootMessageId),
  ]));
  return cache;
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

class FakeClock {
  sequence = 0;
  tasks = new Map();
  setTimeout(callback, delayMs) {
    const id = ++this.sequence;
    this.tasks.set(id, { callback, delayMs });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  runNext() {
    const entry = this.tasks.entries().next().value;
    assert.ok(entry, "expected a reconnect task");
    this.tasks.delete(entry[0]);
    entry[1].callback();
  }
}

class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  accept() {
    this.onmessage?.({ data: JSON.stringify({
      type: "chat.session.accepted",
      metadata,
      tenantId,
      actorStreamId: `user:${userId}`,
      deviceId: "device-thread-client",
      sessionId: "session-thread-client",
    }) });
  }
  disconnect() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" }); }
  close() { this.readyState = 3; }
}

const subscriptionIds = (socket, type = "chat.subscribe") =>
  socket.sent
    .filter((frame) => frame.type === type)
    .map((frame) => frame.streamId);

test("coalesces a newly created thread, publishes view state, and restores one subscription", async () => {
  const cache = createCache();
  const sockets = [];
  const clock = new FakeClock();
  let postCalls = 0;
  let resolvePost;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    fetch(url, init) {
      if (url === `/chat/conversations/${threadConversationId}`) return Promise.resolve(response(threadDetail()));
      if (url === "/chat/_meta") return Promise.resolve(response(metadata));
      if (url === `/chat/messages/${rootMessageId}/thread`) {
        postCalls += 1;
        return new Promise((resolve) => { resolvePost = resolve; });
      }
      if (url === `/chat/conversations/${threadConversationId}/messages?limit=50`) {
        return Promise.resolve(response(timeline(threadConversationId, [
          message(threadConversationId, 2),
        ], {
          older: { available: true, cursor: 2 },
          newer: { available: false },
        })));
      }
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
    realtime: {
      clock,
      random: () => 0.5,
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });
  const observed = [];
  client.subscribeThreadOpening(rootMessageId, (state) => observed.push(state.state));

  const first = client.openThread(rootMessageId);
  const second = client.openThread(rootMessageId);
  assert.equal(first, second);
  assert.equal(client.getThreadOpeningState(rootMessageId).state, "loading");
  await flush();
  assert.equal(postCalls, 1);
  resolvePost(response(threadResult("created"), { status: 201 }));
  const ready = await first;

  assert.deepEqual(observed, ["loading", "ready"]);
  assert.equal(ready.state, "ready");
  assert.equal(ready.threadConversationId, threadConversationId);
  assert.equal((await client.openThread(rootMessageId)), ready);
  assert.equal(postCalls, 1);
  assert.equal(cache.getState().entities.conversations[threadConversationId].type, "thread");
  assert.deepEqual(
    cache.getState().entities.messages[rootMessageId].threadSummary,
    threadResult().rootThreadSummary,
  );
  assert.deepEqual(cache.getState().timelines[parentConversationId].messageIds, [rootMessageId]);
  assert.deepEqual(cache.getState().timelines[threadConversationId].messageIds, [
    `${threadConversationId}-2`,
  ]);

  assert.equal((await client.start()).state, "ready");
  await flush();
  sockets[0].open();
  sockets[0].accept();
  await flush();
  assert.deepEqual(subscriptionIds(sockets[0]), [`user:${userId}`, threadConversationId]);
  sockets[0].disconnect();
  clock.runNext();
  await flush();
  sockets[1].open();
  sockets[1].accept();
  await flush();
  assert.deepEqual(subscriptionIds(sockets[1]), [`user:${userId}`, threadConversationId]);

  client.close();
  assert.deepEqual(subscriptionIds(sockets[1], "chat.unsubscribe"), [threadConversationId]);
  assert.equal(client.getThreadOpeningState(rootMessageId).state, "idle");
});

test("opens an existing thread and paginates only its independent timeline", async () => {
  const cache = createCache();
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url, init) {
      if (url === `/chat/conversations/${threadConversationId}`) return Promise.resolve(response(threadDetail()));
      requests.push(url);
      if (init.method === "POST") return response(threadResult("existing_for_root"));
      if (url.endsWith("?limit=50")) {
        return response(timeline(threadConversationId, [message(threadConversationId, 2)], {
          older: { available: true, cursor: 2 },
          newer: { available: false },
        }));
      }
      return response(timeline(threadConversationId, [message(threadConversationId, 1)], {
        older: { available: false },
        newer: { available: true, cursor: 1 },
      }));
    },
  });

  assert.equal((await client.openThread(rootMessageId)).reconciliationStatus, "existing_for_root");
  assert.equal((await client.getMessageTimeline({
    conversationId: threadConversationId,
    direction: "backward",
    cursor: 2,
    limit: 1,
  })).status, "success");
  assert.deepEqual(requests, [
    `/chat/messages/${rootMessageId}/thread`,
    `/chat/conversations/${threadConversationId}/messages?limit=50`,
    `/chat/conversations/${threadConversationId}/messages?before=2&limit=1`,
  ]);
  assert.deepEqual(cache.getState().timelines[threadConversationId].messageIds, [
    `${threadConversationId}-1`,
    `${threadConversationId}-2`,
  ]);
  assert.deepEqual(cache.getState().timelines[parentConversationId].messageIds, [rootMessageId]);
});

test("opening waits for current follow authority and preserves nonzero explicit unfollow on reload", async (t) => {
  for (const isFollowing of [true, false]) {
    await t.test(isFollowing ? "existing follow" : "reopened explicit unfollow", async () => {
      const cache = createCache();
      const parent = threadDetail();
      parent.conversation = {
        ...parent.conversation,
        id: parentConversationId,
        type: "channel",
        name: "Thread parent",
        currentMember: { ...parent.conversation.currentMember, conversationId: parentConversationId },
        currentReadState: { ...parent.conversation.currentReadState, conversationId: parentConversationId },
        currentPreference: { ...parent.conversation.currentPreference, conversationId: parentConversationId },
      };
      delete parent.conversation.currentThreadFollow;
      delete parent.conversation.parentConversationId;
      delete parent.conversation.rootMessageId;
      cache.hydrateConversationDetail(parent);
      let resolveDetail;
      let notifyDetailRequested;
      const detailRequested = new Promise((resolve) => { notifyDetailRequested = resolve; });
      const detail = threadDetail();
      detail.conversation.currentThreadFollow = {
        followRevision: 7,
        follow: {
          target: { type: "thread", id: threadConversationId },
          isFollowing,
          source: "manual",
          updatedAt: now,
        },
      };
      const requests = [];
      const client = createChatClient({
        endpoint: "/chat",
        cache,
        getAccessToken: () => "token",
        async fetch(url, init) {
          if (url === `/chat/conversations/${threadConversationId}`) {
            return new Promise((resolve) => {
              resolveDetail = resolve;
              notifyDetailRequested();
            });
          }
          if (init.method === "POST") return response(threadResult("existing_for_root"));
          if (init.method === "PATCH") {
            const input = JSON.parse(init.body);
            requests.push(input);
            return response({
              ...input,
              reconciliationStatus: "applied",
              followRevision: input.expectedFollowRevision + 1,
              follow: { ...detail.conversation.currentThreadFollow.follow, isFollowing: !isFollowing },
            });
          }
          return response(timeline(threadConversationId, [message(threadConversationId, 2)]));
        },
      });
      try {
        const opening = client.openThread(rootMessageId);
        await Promise.race([detailRequested, opening]);
        assert.equal(typeof resolveDetail, "function");
        assert.equal(client.getThreadOpeningState(rootMessageId).state, "loading");
        assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
        resolveDetail(response(detail));
        assert.equal((await opening).state, "ready");
        assert.equal(cache.getState().currentUser.threadFollowRevisions[threadConversationId], 7);
        assert.equal(cache.getState().currentUser.threadFollows[threadConversationId].isFollowing, isFollowing);
        const result = await (isFollowing
          ? client.unfollowThread(threadConversationId)
          : client.followThread(threadConversationId));
        assert.equal(result.status, "success");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].expectedFollowRevision, 7);
        assert.equal(cache.getState().currentUser.threadFollowRevisions[threadConversationId], 8);
      } finally {
        client.close();
      }
    });
  }
});

test("missing follow authority leaves opening retryable rather than publishing an actionable thread", async () => {
  const cache = createCache();
  let omitAuthority = true;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url, init) {
      if (url === `/chat/conversations/${threadConversationId}`) {
        const detail = threadDetail();
        if (omitAuthority) delete detail.conversation.currentThreadFollow;
        return response(detail);
      }
      if (init.method === "POST") return response(threadResult("existing_for_root"));
      return response(timeline(threadConversationId, [message(threadConversationId, 2)]));
    },
  });
  try {
    const failure = await client.openThread(rootMessageId);
    assert.equal(failure.state, "error");
    assert.equal(failure.code, "snapshot_failed");
    assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
    omitAuthority = false;
    assert.equal((await client.openThread(rootMessageId)).state, "ready");
    assert.equal(cache.getState().currentUser.threadFollowRevisions[threadConversationId], 0);
  } finally {
    client.close();
  }
});

test("retries after snapshot failure without partial cache state or a duplicate subscription", async () => {
  const cache = createCache();
  const sockets = [];
  let commandCalls = 0;
  let snapshotCalls = 0;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url, init) {
      if (url === `/chat/conversations/${threadConversationId}`) return Promise.resolve(response(threadDetail()));
      if (url === "/chat/_meta") return response(metadata);
      if (init.method === "POST") {
        commandCalls += 1;
        return response(threadResult(commandCalls === 1 ? "created" : "existing_for_root"));
      }
      snapshotCalls += 1;
      if (snapshotCalls === 1) return response({}, { ok: false, status: 503 });
      return response(timeline(threadConversationId, []));
    },
    realtime: {
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  assert.equal((await client.openThread(rootMessageId)).state, "error");
  assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
  assert.equal(cache.getState().entities.messages[rootMessageId].isThreadRoot, false);
  assert.equal(cache.getState().timelines[threadConversationId], undefined);
  assert.equal((await client.openThread(rootMessageId)).state, "ready");
  assert.equal(commandCalls, 2);

  await client.start();
  await flush();
  sockets[0].open();
  sockets[0].accept();
  await flush();
  assert.equal(subscriptionIds(sockets[0]).filter((id) => id === threadConversationId).length, 1);
});

test("an unauthorized open is retryable and never creates canonical thread state or a subscription", async () => {
  const cache = createCache();
  const sockets = [];
  let timelineCalls = 0;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url, init) {
      if (url === `/chat/conversations/${threadConversationId}`) return Promise.resolve(response(threadDetail()));
      if (url === "/chat/_meta") return response(metadata);
      if (init.method === "POST") {
        return response({ error: { code: "forbidden", message: "Forbidden" } }, {
          ok: false,
          status: 403,
        });
      }
      timelineCalls += 1;
      return response(timeline(threadConversationId, []));
    },
    realtime: {
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  const failure = await client.openThread(rootMessageId);
  assert.equal(failure.state, "error");
  assert.equal(failure.code, "command_failed");
  assert.equal(failure.httpStatus, 403);
  assert.equal(timelineCalls, 0);
  assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
  assert.equal(cache.getState().entities.messages[rootMessageId].isThreadRoot, false);

  await client.start();
  await flush();
  sockets[0].open();
  sockets[0].accept();
  await flush();
  assert.deepEqual(subscriptionIds(sockets[0]), [`user:${userId}`]);
});

test("close aborts active thread opening work", async () => {
  const cache = createCache();
  let commandSignal;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    fetch(_url, init) {
      commandSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("closed")), {
          once: true,
        });
      });
    },
  });
  const opening = client.openThread(rootMessageId);
  await flush();
  client.close();
  assert.equal(commandSignal.aborted, true);
  assert.equal((await opening).state, "idle");
  assert.equal(client.getThreadOpeningState(rootMessageId).state, "idle");
});

test("reopens a ready thread evicted by sibling canonical hydration and coalesces recovery", async () => {
  const cache = createCache();
  let failDetail = false;
  let detailCalls = 0;
  const client = createChatClient({
    endpoint: "/chat", cache, getAccessToken: () => "token",
    async fetch(url, init) {
      if (init.method === "POST") return response(threadResult("existing_for_root"));
      if (url === `/chat/conversations/${threadConversationId}`) {
        detailCalls += 1;
        return failDetail ? response({}, { ok: false, status: 503 }) : response(threadDetail());
      }
      return response(timeline(threadConversationId, [message(threadConversationId, 2)]));
    },
  });
  try {
    assert.equal((await client.openThread(rootMessageId)).state, "ready");
    const sibling = createCache().getState();
    assert.equal(cache.hydrateCanonicalState(sibling), true);
    assert.equal(client.getThreadOpeningState(rootMessageId).state, "ready");
    const first = client.openThread(rootMessageId);
    assert.equal(client.openThread(rootMessageId), first);
    assert.equal((await first).state, "ready");
    assert.equal(detailCalls, 2);
    assert.ok(cache.getState().entities.conversations[threadConversationId]);
    assert.deepEqual(cache.getState().timelines[threadConversationId].messageIds, [`${threadConversationId}-2`]);

    failDetail = true;
    assert.equal(cache.hydrateCanonicalState(sibling), true);
    const failed = await client.openThread(rootMessageId);
    assert.equal(failed.state, "error");
    assert.equal(failed.code, "snapshot_failed");
    failDetail = false;
    assert.equal((await client.openThread(rootMessageId)).state, "ready");
  } finally {
    client.close();
  }
});

for (const evictDuringOpening of [false, true]) {
  test(`recovers canonical root and detail eviction ${evictDuringOpening ? "during opening" : "after ready"} with bounded Retry`, async () => {
    const cache = createCache();
    const sibling = createNormalizedChatCache({ tenantId, userId, sessionId: "session-thread-client" }).getState();
    let evict = false;
    let failRoot = false;
    let rootCalls = 0;
    const client = createChatClient({
      endpoint: "/chat", cache, getAccessToken: () => "token",
      async fetch(url, init) {
        if (init.method === "POST") return response(threadResult("existing_for_root"));
        if (url === `/chat/conversations/${threadConversationId}`) {
          if (evict) cache.hydrateCanonicalState(sibling);
          return response(threadDetail());
        }
        if (url.includes(`/conversations/${parentConversationId}/`)) {
          rootCalls += 1;
          assert.match(url, /after=0/);
          assert.match(url, /limit=1/);
          return failRoot ? response({}, { ok: false, status: 503 })
            : response(timeline(parentConversationId, [message(parentConversationId, 1, rootMessageId)]));
        }
        return response(timeline(threadConversationId, [message(threadConversationId, 2)]));
      },
    });
    try {
      evict = evictDuringOpening;
      assert.equal((await client.openThread(rootMessageId)).state, "ready");
      evict = false;
      cache.hydrateCanonicalState(sibling);
      failRoot = true;
      const failed = await client.openThread(rootMessageId);
      assert.equal(failed.code, "snapshot_failed");
      assert.equal(failed.parentConversationId, parentConversationId);
      const callsAfterFailure = rootCalls;
      await flush();
      assert.equal(rootCalls, callsAfterFailure);
      failRoot = false;
      const retry = client.openThread(rootMessageId);
      assert.equal(client.openThread(rootMessageId), retry);
      assert.equal((await retry).state, "ready");
      assert.equal(rootCalls, callsAfterFailure + 1);
      assert.ok(cache.getState().entities.messages[rootMessageId]);
      assert.ok(cache.getState().entities.conversations[threadConversationId]);
      assert.equal(cache.getState().currentUser.threadFollows[threadConversationId], undefined);
    } finally { client.close(); }
  });
}

for (const legacyFirst of [false, true]) {
  test(`named creation coalesces competing names and legacy open (${legacyFirst ? "legacy" : "named"} first)`, async () => {
    const cache = createCache();
    const requests = [];
    let resolvePost;
    const canonical = threadResult("existing_for_root");
    canonical.conversation.conversation.name = "Canonical discussion";
    const client = createChatClient({
      endpoint: "/chat", cache, getAccessToken: () => "token",
      async fetch(url, init) {
        if (init.method === "POST") {
          requests.push(JSON.parse(init.body));
          return new Promise((resolve) => { resolvePost = resolve; });
        }
        if (url === `/chat/conversations/${threadConversationId}`) return response(canonical.conversation);
        return response(timeline(threadConversationId, []));
      },
    });
    try {
      const input = { rootMessageId, name: "Requested discussion" };
      const first = legacyFirst ? client.openThread(rootMessageId) : client.createThread(input);
      input.name = "Caller mutation";
      assert.equal(client.createThread({ rootMessageId, name: "Competing name" }), first);
      assert.equal(client.openThread(rootMessageId), first);
      await flush();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].name, legacyFirst ? undefined : "Requested discussion");
      resolvePost(response(canonical));
      const ready = await first;
      assert.equal(ready.state, "ready");
      assert.equal(ready.reconciliationStatus, "existing_for_root");
      assert.equal(ready.threadConversationId, threadConversationId);
      assert.equal(cache.getState().entities.conversations[threadConversationId].name, "Canonical discussion");
      assert.equal(await client.createThread({ rootMessageId, name: "Never rename" }), ready);
      assert.equal(requests.length, 1);
    } finally { client.close(); }
  });
}

for (const failAt of ["command", "timeline", "detail"]) {
  test(`named creation retains the first key and name after ${failAt} failure`, async () => {
    const cache = createCache();
    const requests = [];
    let fail = true;
    const canonical = threadResult("replayed");
    canonical.conversation.conversation.name = "First name";
    const client = createChatClient({
      endpoint: "/chat", cache, getAccessToken: () => "token",
      commands: { retry: { maxAttempts: 1 } },
      async fetch(url, init) {
        const stage = init.method === "POST" ? "command" : url.endsWith(`/conversations/${threadConversationId}`) ? "detail" : "timeline";
        if (stage === "command") requests.push(JSON.parse(init.body));
        if (stage === failAt && fail) return response({}, { ok: false, status: 503 });
        if (stage === "command") return response(canonical);
        if (stage === "detail") return response(canonical.conversation);
        return response(timeline(threadConversationId, []));
      },
    });
    try {
      assert.equal((await client.createThread({ rootMessageId, name: "First name" })).state, "error");
      fail = false;
      const retry = client.createThread({ rootMessageId, name: "Changed on retry" });
      assert.equal(client.openThread(rootMessageId), retry);
      const ready = await retry;
      assert.equal(ready.state, "ready");
      assert.equal(ready.threadConversationId, threadConversationId);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1], requests[0]);
      assert.equal(requests[1].name, "First name");
      assert.ok(requests[1].idempotencyKey);
      assert.equal(cache.getState().entities.conversations[threadConversationId].name, "First name");
    } finally { client.close(); }
  });
}

test("named creation validates names and rejects nested creation without dispatch", async () => {
  const cache = createCache();
  let calls = 0;
  const client = createChatClient({
    endpoint: "/chat", cache, getAccessToken: () => "token",
    async fetch() { calls += 1; throw new Error("unexpected request"); },
  });
  try {
    for (const name of ["", " ", "x".repeat(101), 42]) {
      const failure = await client.createThread({ rootMessageId, name });
      assert.equal(failure.state, "error");
      assert.equal(failure.code, "command_failed");
    }
    cache.hydrateConversationDetail(threadDetail());
    cache.hydrateMessageTimeline(timeline(threadConversationId, [message(threadConversationId, 1, "nested-root")]));
    assert.equal((await client.createThread({ rootMessageId: "nested-root", name: "Nested" })).code, "command_failed");
    assert.equal(calls, 0);
  } finally { client.close(); }
});

const readOnlyClient = ({ cache = createCache(), detail = threadDetail(), rootMessages = [], fetchOverride, realtime } = {}) => {
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat", cache, getAccessToken: () => "token",
    ...(realtime === undefined ? {} : { realtime }),
    async fetch(url, init) {
      requests.push({ url, method: init.method });
      assert.equal(init.method, "GET", "opening must never issue creation, participation, or read writes");
      const overridden = await fetchOverride?.(url, init);
      if (overridden !== undefined) return overridden;
      if (url === "/chat/_meta") return response(metadata);
      if (url === `/chat/conversations/${threadConversationId}`) return response(detail);
      if (url.startsWith(`/chat/conversations/${parentConversationId}/messages?`)) return response(timeline(parentConversationId, rootMessages));
      if (url.startsWith(`/chat/conversations/${threadConversationId}/messages?`)) return response(timeline(threadConversationId, [message(threadConversationId, 2)]));
      throw new Error(`Unexpected read ${url}`);
    },
  });
  return { client, cache, requests };
};

for (const failureStatus of [undefined, 403, 503]) {
  test(`root opening reads archived history without creation, including retry after ${failureStatus ?? "no failure"}`, async () => {
    const cache = createCache();
    const root = { ...message(parentConversationId, 1, rootMessageId), revision: { revision: 2 },
      isThreadRoot: true, threadSummary: threadResult().rootThreadSummary };
    cache.hydrateMessageTimeline(timeline(parentConversationId, [root]));
    const detail = threadDetail();
    detail.conversation.archivedAt = now;
    detail.conversation.archivedByUserId = userId;
    let fail = failureStatus !== undefined;
    const { client, requests } = readOnlyClient({ cache, detail, rootMessages: [root],
      fetchOverride(url) {
        if (fail && url === `/chat/conversations/${threadConversationId}`) {
          return response({}, { ok: false, status: failureStatus });
        }
      },
    });
    const observed = [];
    const unsubscribe = client.subscribeThreadOpening(rootMessageId, next => observed.push(next.state));
    try {
      if (fail) {
        assert.equal((await client.openThread(rootMessageId)).state, "error");
        fail = false;
      }
      const opening = client.openThread(rootMessageId);
      assert.equal(client.openThread(rootMessageId), opening);
      assert.deepEqual(await opening, {
        state: "ready", rootMessageId, parentConversationId, threadConversationId,
        reconciliationStatus: "existing_for_root",
      });
      assert.equal(cache.getState().entities.conversations[threadConversationId].archivedAt, now);
      assert.ok(cache.getState().entities.messages[`${threadConversationId}-2`]);
      assert.ok(requests.every(request => request.method === "GET"));
      assert.deepEqual(observed, failureStatus === undefined ? ["loading", "ready"] : ["loading", "error", "loading", "ready"]);
    } finally { unsubscribe(); client.close(); }
  });
}

for (const rootStatus of ["deleted", "unavailable", "available"]) {
  test(`read-only opening exposes ${rootStatus} root context and reads archived history while unfollowed`, async () => {
    const detail = threadDetail();
    detail.conversation.name = "Canonical name";
    detail.conversation.archivedAt = now;
    detail.conversation.archivedByUserId = userId;
    detail.conversation.currentThreadFollow = {
      followRevision: 7,
      follow: { target: { type: "thread", id: threadConversationId }, isFollowing: false, source: "manual", updatedAt: now },
    };
    const freshRoot = message(parentConversationId, 1, rootMessageId);
    freshRoot.revision = { revision: 2 };
    freshRoot.content = { format: "plain", text: "Fresh source" };
    if (rootStatus === "deleted") Object.assign(freshRoot, { deletedAt: now, deletedByUserId: userId, content: null });
    const { client, cache, requests } = readOnlyClient({
      detail, rootMessages: rootStatus === "unavailable" ? [] : [freshRoot],
    });
    const observed = [];
    const unsubscribe = client.subscribeExistingThreadOpening(threadConversationId, (next) => observed.push(next.state));
    try {
      const opening = client.openExistingThread(threadConversationId);
      assert.equal(client.openExistingThread(threadConversationId), opening);
      const ready = await opening;
      assert.deepEqual(ready, {
        state: "ready", threadConversationId, parentConversationId, rootMessageId,
        rootContext: rootStatus, name: "Canonical name",
      });
      assert.equal("reconciliationStatus" in ready, false);
      assert.equal(cache.getState().entities.conversations[threadConversationId].archivedAt, now);
      assert.equal(cache.getState().currentUser.threadFollows[threadConversationId].isFollowing, false);
      assert.equal(cache.getState().entities.messages[`${threadConversationId}-2`].conversationId, threadConversationId);
      assert.equal(cache.getState().entities.messages[rootMessageId]?.content?.text, rootStatus === "available" ? "Fresh source" : undefined);
      assert.deepEqual(observed, ["loading", "ready"]);
      assert.equal(requests.length, 3);
    } finally { unsubscribe(); client.close(); }
  });
}

test("read-only opening works with no cached root and no follow authority", async () => {
  const detail = threadDetail();
  delete detail.conversation.currentThreadFollow;
  const { client, cache } = readOnlyClient({
    detail, cache: createNormalizedChatCache({ tenantId, userId, sessionId: "session-thread-client" }),
  });
  try {
    assert.equal((await client.openExistingThread(threadConversationId)).rootContext, "unavailable");
    assert.ok(cache.getState().timelines[threadConversationId]);
    assert.equal(cache.getState().entities.messages[rootMessageId], undefined);
  } finally { client.close(); }
});

for (const [rejectedStage, rejectionStatus] of [
  ["detail", 403], ["timeline", 403], ["root", 403], ["root", 404], ["detail", 401], ["timeline", 401],
]) {
  test(`revoked parent access at ${rejectedStage} (${rejectionStatus}) clears cached history and releases the subscription`, async () => {
    const sockets = [];
    let revoked = false;
    const detail = threadDetail();
    detail.conversation.archivedAt = now;
    detail.conversation.archivedByUserId = userId;
    const { client, cache } = readOnlyClient({
      detail,
      realtime: { webSocketFactory() { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
      fetchOverride(url) {
        const stage = url === `/chat/conversations/${threadConversationId}` ? "detail" :
          url.includes(`/conversations/${parentConversationId}/`) ? "root" : "timeline";
        if (revoked && stage === rejectedStage) return response({}, { ok: false, status: rejectionStatus });
      },
    });
    try {
      await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
      assert.equal((await client.openExistingThread(threadConversationId)).state, "ready");
      await client.threadLifecycle.load(threadConversationId, parentConversationId);
      assert.ok(cache.getState().entities.messages[`${threadConversationId}-2`]);
      const publishedHistory = [];
      const unsubscribe = cache.subscribe((state) => state.timelines[threadConversationId], (next) => publishedHistory.push(next));
      revoked = true;
      const result = await client.openExistingThread(threadConversationId);
      unsubscribe();
      assert.equal(result.state, "error");
      assert.equal(result.httpStatus, rejectionStatus);
      assert.equal(cache.getState().timelines[threadConversationId], undefined);
      assert.equal(cache.getState().entities.messages[`${threadConversationId}-2`], undefined);
      assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
      assert.equal(client.threadLifecycle.getState(threadConversationId).error, "access_revoked");
      assert.ok(publishedHistory.every((next) => next === undefined));
      assert.deepEqual(subscriptionIds(sockets[0], "chat.unsubscribe"), [threadConversationId]);
      revoked = false;
      assert.equal((await client.openExistingThread(threadConversationId)).state, "ready");
      assert.ok(cache.getState().entities.messages[`${threadConversationId}-2`]);
      assert.equal(cache.getState().entities.conversations[threadConversationId].archivedAt, now);
      assert.equal(client.threadLifecycle.getState(threadConversationId).error, undefined);
      assert.equal(client.threadLifecycle.getState(threadConversationId).status, "ready");
      assert.equal(client.threadLifecycle.getState(threadConversationId).actionsAvailable, false);
    } finally { client.close(); }
  });
}

test("read-only retries, eviction recovery, reconnect, and close retain exactly one subscription", async () => {
  const sockets = [];
  const clock = new FakeClock();
  let failTimeline = true;
  const { client, cache } = readOnlyClient({
    realtime: { clock, random: () => 0.5, webSocketFactory() { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
    fetchOverride(url) {
      if (failTimeline && url.includes(`/conversations/${threadConversationId}/messages`)) return response({}, { ok: false, status: 503 });
    },
  });
  try {
    assert.equal((await client.openExistingThread(threadConversationId)).code, "snapshot_failed");
    assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
    failTimeline = false;
    assert.equal((await client.openExistingThread(threadConversationId)).state, "ready");
    await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
    assert.equal(cache.hydrateCanonicalState(createCache().getState()), true);
    const recovery = client.openExistingThread(threadConversationId);
    assert.equal(client.openExistingThread(threadConversationId), recovery);
    assert.equal((await recovery).state, "ready");
    assert.deepEqual(subscriptionIds(sockets[0]).filter((id) => id === threadConversationId), [threadConversationId]);
    sockets[0].disconnect(); clock.runNext(); await flush(); sockets[1].open(); sockets[1].accept(); await flush();
    assert.deepEqual(subscriptionIds(sockets[1]).filter((id) => id === threadConversationId), [threadConversationId]);
    client.close();
    assert.equal(client.getExistingThreadOpeningState(threadConversationId).state, "idle");
    assert.deepEqual(subscriptionIds(sockets[1], "chat.unsubscribe"), [threadConversationId]);
  } finally { client.close(); }
});

test("close cancels read-only opening without publishing delayed history", async () => {
  let resolveDetail;
  let signal;
  const { client, cache } = readOnlyClient({
    fetchOverride(url, init) {
      if (url === `/chat/conversations/${threadConversationId}`) {
        signal = init.signal;
        return new Promise((resolve) => { resolveDetail = resolve; });
      }
    },
  });
  const pending = client.openExistingThread(threadConversationId);
  await flush();
  client.close();
  assert.equal(signal.aborted, true);
  resolveDetail(response(threadDetail()));
  assert.equal((await pending).state, "idle");
  assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
});

test("canonical existing-thread conversation and message search links open after root deletion", async () => {
  const { parseMessageSearchResponse } = await import("../dist/contracts/message-search.js");
  const links = parseMessageSearchResponse({ hits: [
    { type: "conversation", conversationId: threadConversationId, title: "Thread", snippet: "Discussion" },
    { type: "message", conversationId: threadConversationId, messageId: `${threadConversationId}-2`, snippet: "Reply" },
  ] }).hits;
  const { client, cache, requests } = readOnlyClient();
  try {
    for (const link of links) {
      const opened = await client.openExistingThread(link.conversationId);
      assert.equal(opened.state, "ready");
      assert.equal(opened.threadConversationId, link.conversationId);
      assert.equal(opened.rootContext, "unavailable");
      if (link.type === "message") {
        assert.ok(cache.getState().timelines[link.conversationId].messageIds.includes(link.messageId));
        assert.equal(cache.getState().entities.messages[link.messageId].conversationId, link.conversationId);
      }
    }
    assert.ok(requests.every((request) => request.method === "GET"));
  } finally { client.close(); }
});

test("named creation and concurrent read-only opening resolve one canonical name and subscription", async () => {
  const cache = createCache();
  const sockets = [];
  const result = threadResult("created");
  result.conversation.conversation.name = "Launch";
  let postCalls = 0;
  const client = createChatClient({
    endpoint: "/chat", cache, getAccessToken: () => "token",
    realtime: { webSocketFactory() { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
    async fetch(url, init) {
      if (url === "/chat/_meta") return response(metadata);
      if (init.method === "POST") {
        postCalls += 1;
        assert.equal(JSON.parse(init.body).name, "Launch");
        return response(result);
      }
      assert.equal(init.method, "GET");
      if (url === `/chat/conversations/${threadConversationId}`) return response(result.conversation);
      if (url.includes(`/conversations/${parentConversationId}/messages`)) return response(timeline(parentConversationId, [message(parentConversationId, 1, rootMessageId)]));
      return response(timeline(threadConversationId, [message(threadConversationId, 2)]));
    },
  });
  try {
    const creation = client.createThread({ rootMessageId, name: "Launch" });
    const existing = client.openExistingThread(threadConversationId);
    const [created, opened] = await Promise.all([creation, existing]);
    assert.equal(created.reconciliationStatus, "created");
    assert.equal(opened.rootContext, "available");
    assert.equal(created.threadConversationId, opened.threadConversationId);
    assert.equal(opened.name, "Launch");
    assert.equal(cache.getState().entities.conversations[threadConversationId].name, "Launch");
    assert.equal(cache.getState().entities.messages[rootMessageId].threadSummary.threadId, threadConversationId);
    assert.equal(await client.openThread(rootMessageId), created, "legacy live-root links retain their opening state");
    assert.equal(postCalls, 1);
    await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
    assert.deepEqual(subscriptionIds(sockets[0]).filter((id) => id === threadConversationId), [threadConversationId]);
  } finally { client.close(); }
});

test("fresh root lookup cannot resurrect a newer deleted source", async () => {
  const cache = createCache();
  const tombstone = { ...message(parentConversationId, 1, rootMessageId),
    revision: { revision: 3 }, deletedAt: now, deletedByUserId: userId, content: null };
  const { client } = readOnlyClient({
    cache, rootMessages: [message(parentConversationId, 1, rootMessageId)],
    fetchOverride(url) {
      if (url.includes(`/conversations/${parentConversationId}/messages`)) {
        cache.hydrateMessageTimeline(timeline(parentConversationId, [tombstone]));
      }
    },
  });
  try {
    assert.equal((await client.openExistingThread(threadConversationId)).rootContext, "deleted");
    assert.equal(cache.getState().entities.messages[rootMessageId].content, null);
    assert.equal(cache.getState().entities.messages[rootMessageId].revision.revision, 3);
  } finally { client.close(); }
});

test("read-only reconciliation failure is atomic and releases its newly acquired subscription", async () => {
  const sockets = [];
  let wrongTenant = true;
  const { client, cache } = readOnlyClient({
    realtime: { webSocketFactory() { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
    fetchOverride(url) {
      if (wrongTenant && url.includes(`/conversations/${threadConversationId}/messages`)) {
        return response(timeline(threadConversationId, [{ ...message(threadConversationId, 2), tenantId: "other-tenant" }]));
      }
    },
  });
  try {
    await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
    const result = await client.openExistingThread(threadConversationId);
    assert.equal(result.code, "cache_reconciliation_failed");
    assert.equal(cache.getState().entities.conversations[threadConversationId], undefined);
    assert.ok(cache.getState().entities.messages[rootMessageId], "failed atomic hydration must not remove root context");
    assert.deepEqual(subscriptionIds(sockets[0], "chat.unsubscribe"), [threadConversationId]);
    wrongTenant = false;
    assert.equal((await client.openExistingThread(threadConversationId)).state, "ready");
  } finally { client.close(); }
});
