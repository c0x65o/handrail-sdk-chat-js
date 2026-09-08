import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedThreadFollowIntent,
  createApplicationChatQueuedThreadFollowIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserThreadFollowState,
} from "../dist/client/index.js";
import { CHAT_DURABLE_EVENT_TYPES, CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-thread-follow-recovery";
const actorId = "user-thread-follow-recovery";
const parentId = "conversation-thread-follow-parent";
const rootId = "message-thread-follow-root";
const threadId = "conversation-thread-follow-recovery";
const at = (offset = 0) =>
  new Date(Date.UTC(2038, 0, 2, 3, 4, offset)).toISOString();
const storageIdentity = (userId = actorId) => ({
  tenantId,
  userId,
  deviceId: `device-${userId}`,
});
const cacheIdentity = (userId = actorId) => ({
  tenantId,
  userId,
  sessionId: `session-${userId}`,
});
const storageKey = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
const metadata = (realtime = false) => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: realtime
    ? { realtime: true, conversation_snapshots: true }
    : { conversation_snapshots: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
});
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};
const retainedWait = (_delay, signal) => new Promise((_resolve, reject) => {
  if (signal.aborted) return reject(new Error("aborted"));
  signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});
const pendingForever = new Promise(() => {});

class FakeClock {
  current = 0;
  nextId = 1;
  timers = new Map();

  now = () => this.current;
  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.current + delayMs });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);

  tick(milliseconds) {
    const target = this.current + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.at;
      timer.callback();
    }
    this.current = target;
  }
}

class FakeChannelHub {
  channels = new Set();
  messages = [];
  pendingDeliveries = [];
  paused = false;

  factory = (_owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("construction failed");
    const listeners = new Set();
    const channel = {
      name,
      closed: false,
      listeners,
      postMessage: (message) => {
        if (channel.closed) return;
        if (behavior.postThrows) throw new Error("posting failed");
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        const deliver = () => {
          for (const peer of [...this.channels]) {
            if (peer === channel || peer.closed || peer.name !== name) continue;
            for (const listener of peer.listeners) {
              listener({ data: structuredClone(cloned) });
            }
          }
        };
        if (this.paused) this.pendingDeliveries.push(deliver);
        else deliver();
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => {
        channel.closed = true;
        this.channels.delete(channel);
      },
    };
    this.channels.add(channel);
    return channel;
  };

  flush() {
    this.paused = false;
    for (const deliver of this.pendingDeliveries.splice(0)) deliver();
  }
}

const crossTabTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

const detail = (conversation, userId = actorId) => ({
  kind: "conversation_detail",
  conversation: {
    ...conversation,
    latestSequence: 0,
    activityAt: at(0),
    unreadMentionCount: 0,
    activeMemberUserIds: [userId],
    memberUserIds: [userId],
    memberListRevision: 1,
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
    currentPreference: {
      conversationId: conversation.id,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: at(0),
    },
  },
  _meta: {
    ...metadata(),
    feature: { name: "conversation_snapshots", version: 1 },
  },
});

const followState = (isFollowing, second = 10) => ({
  target: { type: "thread", id: threadId },
  isFollowing,
  source: "manual",
  updatedAt: at(second),
});
const followEvent = (eventId, revision, follow, userId = actorId) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.threadFollowUpdated,
  occurredAt: at(20 + revision),
  payload: {
    operation: "set_thread_follow",
    target: { type: "thread", id: threadId },
    followRevision: revision,
    follow,
  },
});
const followRequest = (overrides = {}) => ({
  operation: "set_thread_follow",
  intent: "follow",
  target: { type: "thread", id: threadId },
  expectedFollowRevision: 0,
  idempotencyKey: "retained-thread-follow-key",
  ...overrides,
});
const followResult = (input, overrides = {}) => ({
  operation: "set_thread_follow",
  intent: input.intent,
  reconciliationStatus: "applied",
  target: input.target,
  expectedFollowRevision: input.expectedFollowRevision,
  idempotencyKey: input.idempotencyKey,
  followRevision: input.expectedFollowRevision + 1,
  follow: followState(input.intent === "follow", 30),
  ...overrides,
});

function seedCache({
  userId = actorId,
  revision = 0,
  isFollowing = false,
  threadIds = [threadId],
} = {}) {
  const cache = createNormalizedChatCache(cacheIdentity(userId));
  cache.hydrateConversationDetail(detail({
    id: parentId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: "Thread parent",
    createdAt: at(0),
    updatedAt: at(0),
  }, userId));
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
    pagination: { older: { available: false }, newer: { available: false } },
    replay: { resumeFrom: { eventId: `timeline-${userId}` } },
  });
  for (const currentThreadId of threadIds) {
    cache.hydrateConversationDetail(detail({
      id: currentThreadId,
      tenantId,
      type: "thread",
      visibility: "public",
      parentConversationId: parentId,
      rootMessageId: rootId,
      createdAt: at(0),
      updatedAt: at(0),
    }, userId));
  }
  for (let current = 1; current <= revision; current += 1) {
    cache.applyDurableEvent(followEvent(
      `seed-${userId}-${current}`,
      current,
      followState(isFollowing, current),
      userId,
    ));
  }
  return cache;
}

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let replaceGate;
  let gatedIdentity;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope: structuredClone(scope), kind, encoded });
      if (
        kind === ApplicationChatStorageRecordKind.queuedThreadFollowIntents &&
        replaceGate !== undefined &&
        (gatedIdentity === undefined || gatedIdentity === scope.userId)
      ) await replaceGate.promise;
      rows.set(storageKey(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
      rows.delete(storageKey(scope, kind));
    },
    async clearForLogout() {},
  });
  return {
    rows,
    calls,
    storage,
    gateReplaces(gate, userId) { replaceGate = gate; gatedIdentity = userId; },
    threadWrites(userId = actorId) {
      return calls.filter((call) =>
        call.operation === "replace" &&
        call.kind === ApplicationChatStorageRecordKind.queuedThreadFollowIntents &&
        call.scope.userId === userId);
    },
  };
}

function createAtomicStorageHarness() {
  const rows = new Map();
  const calls = [];
  let race;
  const adapter = {
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope: structuredClone(scope), kind, encoded });
      rows.set(storageKey(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
      rows.delete(storageKey(scope, kind));
    },
    async compareExchange(scope, kind, expected, replacement) {
      const call = {
        operation: "compareExchange",
        scope: structuredClone(scope),
        kind,
        expected,
        replacement,
        success: false,
      };
      calls.push(call);
      if (
        race !== undefined &&
        kind === ApplicationChatStorageRecordKind.queuedThreadFollowIntents &&
        storageKey(scope, kind) === storageKey(storageIdentity(), kind) &&
        race.arrivals < 2
      ) {
        const ticket = ++race.arrivals;
        if (ticket === 2) race.barrier.resolve();
        await race.barrier.promise;
        if (ticket === 1) await new Promise((resolve) => setImmediate(resolve));
      }
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      call.success = true;
      return true;
    },
    async clearForLogout(scope) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(storageKey(scope, kind));
      }
    },
  };
  const createStorage = () => createApplicationChatStorage(adapter);
  return {
    rows,
    calls,
    storage: createStorage(),
    createStorage,
    armRace() {
      race = { arrivals: 0, barrier: deferred(), initialCallCount: calls.length };
    },
    raceArrivals: () => race?.arrivals ?? 0,
    raceCalls: () => calls.slice(race?.initialCallCount ?? calls.length),
    readThreadRecord() {
      return createStorage().read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
      );
    },
  };
}

async function seedIntent(harness, scope, request) {
  await harness.storage.replace(createApplicationChatQueuedThreadFollowIntentsRecord(
    scope,
    [createApplicationChatQueuedThreadFollowIntent(request, {
      enqueueOrder: 1,
      enqueuedAt: at(5),
    })],
  ));
}
async function seedSnapshot(harness, scope, cache) {
  await harness.storage.replace(createApplicationChatNormalizedSnapshotRecord(
    scope,
    cache.getState(),
  ));
}

function createSockets(scope, initiallyOnline = true) {
  const sockets = [];
  const listeners = { online: new Set(), offline: new Set() };
  let online = initiallyOnline;
  return {
    sockets,
    network: {
      isOnline: () => online,
      addEventListener(type, listener) { listeners[type].add(listener); },
      removeEventListener(type, listener) { listeners[type].delete(listener); },
    },
    goOnline() {
      online = true;
      for (const listener of [...listeners.online]) listener();
    },
    factory() {
      const socket = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send() {},
        close() { this.readyState = 3; },
        accept() {
          this.readyState = 1;
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({
            type: "chat.session.accepted",
            metadata: metadata(true),
            tenantId: scope.tenantId,
            actorStreamId: `user:${scope.userId}`,
            deviceId: scope.deviceId,
            sessionId: `session-${scope.userId}`,
          }) });
        },
        disconnect() {
          this.readyState = 3;
          this.onclose?.({});
        },
        event(value) { this.onmessage?.({ data: JSON.stringify(value) }); },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

async function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: storageIdentity() },
  cache = seedCache({ userId: identityRef.current.userId }),
  command,
  authority,
  sockets,
  recovery = {},
  keys = ["generated-thread-follow-key"],
  crossTab,
} = {}) {
  const requests = [];
  const diagnostics = [];
  let keyIndex = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    threadFollows: {
      generateIdempotencyKey: () => keys[keyIndex++] ?? `generated-${keyIndex}`,
      now: () => Date.parse(at(10 + keyIndex)),
      retainedRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 4,
        wait: retainedWait,
        ...recovery,
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata(sockets !== undefined));
      if (init.method === "GET") {
        const observed = { kind: "authority", url, init };
        requests.push(observed);
        return authority?.(observed) ?? response(200, detail({
          id: threadId,
          tenantId,
          type: "thread",
          visibility: "public",
          parentConversationId: parentId,
          rootMessageId: rootId,
          createdAt: at(0),
          updatedAt: at(0),
        }, identityRef.current.userId));
      }
      const body = JSON.parse(init.body);
      const observed = {
        kind: "thread-follow",
        url,
        body,
        init,
        identity: structuredClone(identityRef.current),
      };
      requests.push(observed);
      return command?.(observed) ?? response(200, followResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.createStorage?.() ?? harness.storage,
      resolveIdentity: () => identityRef.current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    ...(crossTab === undefined ? {} : {
      crossTab: {
        sessionFingerprint: crossTab.fingerprint ??
          `${tenantId}:${identityRef.current.userId}:${identityRef.current.deviceId}`,
        tabId: crossTab.tabId,
        clock: crossTab.clock,
        timing: crossTabTiming,
        channelFactory: crossTab.hub.factory(
          crossTab.tabId,
          crossTab.behavior,
        ),
      },
    }),
    ...(sockets === undefined ? {} : {
      realtime: {
        network: sockets.network,
        webSocketFactory: sockets.factory,
        retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
      },
    }),
  });
  const started = await client.start();
  assert.equal(started.state, "ready");
  return { client, cache, harness, identityRef, requests, diagnostics };
}

const commands = (fixture) =>
  fixture.requests.filter((request) => request.kind === "thread-follow");

test("durable follow persists before projection/fetch and checkpoints only canonical state", async () => {
  const gate = deferred();
  const command = deferred();
  const fixture = await createFixture({ command: () => command.promise });
  fixture.harness.gateReplaces(gate, actorId);
  let projected = false;
  const unsubscribe = fixture.cache.subscribe(
    (state) => state.currentUser.pendingThreadFollowUpdates[threadId],
    (pending) => { if (pending !== undefined) projected = true; },
  );

  const pending = fixture.client.followThread(threadId);
  await eventually(() => fixture.harness.threadWrites().length === 1);
  assert.equal(projected, false);
  assert.equal(commands(fixture).length, 0);
  gate.resolve();
  await eventually(() => commands(fixture).length === 1);
  const request = commands(fixture)[0].body;
  assert.equal(request.idempotencyKey, "generated-thread-follow-key");
  assert.equal(commands(fixture)[0].init.headers["idempotency-key"], request.idempotencyKey);
  const stored = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  );
  assert.deepEqual(stored.intents[0].request, request);
  assert.equal(selectCurrentUserThreadFollowState(
    fixture.cache.getState(),
    threadId,
  ).pending.idempotencyKey, request.idempotencyKey);
  await eventually(async () => {
    const checkpoint = await fixture.harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.normalizedSnapshot,
    );
    return checkpoint?.snapshot.currentUser.pendingThreadFollowUpdates !== undefined;
  });
  const checkpoint = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(checkpoint.snapshot.currentUser.pendingThreadFollowUpdates, {});
  assert.equal(checkpoint.snapshot.currentUser.threadFollows[threadId], undefined);
  command.resolve(response(200, followResult(request)));
  assert.equal((await pending).status, "success");
  await eventually(async () => await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ) === null);
  unsubscribe();
  fixture.client.close();
});

test("reload handles older, equal, matching, and newer divergent authority", async (t) => {
  await t.test("older authority waits without changing the retained request", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = followRequest({ expectedFollowRevision: 2 });
    const cache = seedCache({ revision: 1, isFollowing: false });
    await seedIntent(harness, scope, request);
    await seedSnapshot(harness, scope, cache);
    const delays = [];
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
      recovery: { wait: (delay, signal) => {
        delays.push(delay);
        return retainedWait(delay, signal);
      } },
    });
    await eventually(() => fixture.requests.some((item) => item.kind === "authority"));
    await eventually(() => delays.length === 1);
    assert.equal(commands(fixture).length, 0);
    assert.equal((await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    )).intents[0].request.idempotencyKey, request.idempotencyKey);
    fixture.client.close();
  });

  await t.test("equal divergent authority replays the exact original key", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = followRequest({ expectedFollowRevision: 1 });
    const cache = seedCache({ revision: 1, isFollowing: false });
    await seedIntent(harness, scope, request);
    await seedSnapshot(harness, scope, cache);
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
    });
    await eventually(() => commands(fixture).length === 1);
    assert.deepEqual(commands(fixture)[0].body, request);
    await eventually(async () => await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    ) === null);
    fixture.client.close();
  });

  for (const [name, revision] of [["equal", 1], ["newer", 2]]) {
    await t.test(`${name} matching authority settles without dispatch`, async () => {
      const harness = createStorageHarness();
      const scope = storageIdentity();
      const request = followRequest({ expectedFollowRevision: 1 });
      const cache = seedCache({ revision, isFollowing: true });
      await seedIntent(harness, scope, request);
      await seedSnapshot(harness, scope, cache);
      const fixture = await createFixture({
        harness,
        cache: createNormalizedChatCache(cacheIdentity()),
      });
      await eventually(async () => await harness.storage.read(
        scope,
        ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
      ) === null);
      assert.equal(commands(fixture).length, 0);
      fixture.client.close();
    });
  }

  await t.test("newer divergent authority preserves a non-replaying conflict", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = followRequest({ expectedFollowRevision: 1 });
    const cache = seedCache({ revision: 2, isFollowing: false });
    await seedIntent(harness, scope, request);
    await seedSnapshot(harness, scope, cache);
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
    });
    await eventually(() => selectCurrentUserThreadFollowState(
      fixture.cache.getState(),
      threadId,
    ).pending?.state === "conflict");
    assert.equal(commands(fixture).length, 0);
    assert.notEqual(await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    ), null);
    assert.equal(selectCurrentUserThreadFollowState(
      fixture.cache.getState(),
      threadId,
    ).follow.isFollowing, false);
    fixture.client.close();
  });
});

test("realtime event settles first, removes storage, and aborts redundant HTTP work", async () => {
  const scope = storageIdentity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({ sockets, command: () => command.promise });
  const pending = fixture.client.followThread(threadId);
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(commands(fixture).length, 0);
  sockets.sockets[0].accept();
  await eventually(() => commands(fixture).length === 1);
  sockets.sockets[0].event(followEvent("event-first", 1, followState(true)));
  assert.equal((await pending).status, "success");
  await eventually(async () => await fixture.harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ) === null);
  assert.equal(selectCurrentUserThreadFollowState(
    fixture.cache.getState(),
    threadId,
  ).pending, undefined);
  command.resolve(response(200, followResult(commands(fixture)[0].body)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands(fixture).length, 1);
  fixture.client.close();
});

test("transient failures retain and retry with bounded injectable backoff", async () => {
  const waits = [];
  const waiters = [];
  const fixture = await createFixture({
    command: () => { throw new Error("ambiguous transport"); },
    recovery: {
      initialDelayMs: 2,
      maximumDelayMs: 3,
      multiplier: 10,
      wait: (delay, signal) => {
        waits.push(delay);
        const waiter = deferred();
        waiters.push(waiter);
        signal.addEventListener("abort", () => waiter.reject(new Error("aborted")), {
          once: true,
        });
        return waiter.promise;
      },
    },
  });
  const pending = fixture.client.followThread(threadId);
  await eventually(() => waits.length === 1);
  assert.equal((await pending).status, "transport");
  assert.deepEqual(waits, [2]);
  assert.notEqual(await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ), null);
  waiters[0].resolve();
  await eventually(() => commands(fixture).length === 2);
  await eventually(() => waits.length === 2);
  assert.deepEqual(waits, [2, 3]);
  assert.equal(commands(fixture).length, 2);
  fixture.client.close();
});

test("rate limits, server failures, and malformed responses remain durable", async (t) => {
  const cases = [
    ["rate limit", () => response(429, { error: { code: "RATE_LIMITED", message: "later" } }), "transport"],
    ["server failure", () => response(503, { error: { code: "UNAVAILABLE", message: "later" } }), "transport"],
    ["malformed response", () => response(200, { malformed: true }), "malformed_response"],
  ];
  for (const [name, command, expectedStatus] of cases) {
    await t.test(name, async () => {
      const waits = [];
      const fixture = await createFixture({
        command,
        recovery: { wait: (delay, signal) => {
          waits.push(delay);
          return retainedWait(delay, signal);
        } },
      });
      const result = await fixture.client.followThread(threadId);
      assert.equal(result.status, expectedStatus);
      await eventually(() => waits.length === 1);
      assert.notEqual(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
      ), null);
      fixture.client.close();
    });
  }
});

test("terminal validation/auth/permission outcomes remove retained intents", async (t) => {
  const terminal = [
    ["authentication", 401, "UNAUTHORIZED"],
    ["permission", 403, "PERMISSION_DENIED"],
    ["validation", 400, "INVALID_REQUEST"],
  ];
  for (const [name, status, code] of terminal) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        command: () => response(status, { error: { code, message: name } }),
      });
      const result = await fixture.client.followThread(threadId);
      assert.ok(["authentication", "rejected"].includes(result.status));
      await eventually(async () => await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
      ) === null);
      assert.equal(selectCurrentUserThreadFollowState(
        fixture.cache.getState(),
        threadId,
      ).pending, undefined);
      fixture.client.close();
    });
  }
});

test("offline startup gates replay until reconnect and close-after-dispatch remains durable", async () => {
  const scope = storageIdentity();
  const harness = createStorageHarness();
  const cache = seedCache();
  const request = followRequest();
  await seedIntent(harness, scope, request);
  await seedSnapshot(harness, scope, cache);
  const sockets = createSockets(scope, false);
  const command = deferred();
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
    sockets,
    command: () => command.promise,
  });
  assert.equal(commands(fixture).length, 0);
  assert.equal(sockets.sockets.length, 0);
  sockets.goOnline();
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(commands(fixture).length, 0);
  sockets.sockets[0].accept();
  await eventually(() => commands(fixture).length === 1);
  sockets.sockets[0].disconnect();
  await eventually(() => sockets.sockets.length === 2);
  assert.equal(commands(fixture).length, 1);
  sockets.sockets[1].accept();
  await eventually(() => commands(fixture).length === 2);
  fixture.client.close();
  assert.notEqual(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ), null);
  command.resolve(response(200, followResult(request)));
});

test("corrupt active-identity rows quarantine without harming other identity/kind rows", async () => {
  const harness = createStorageHarness();
  const own = storageIdentity();
  const sibling = storageIdentity("user-sibling");
  const ownCache = seedCache();
  const siblingCache = seedCache({ userId: sibling.userId });
  await seedSnapshot(harness, own, ownCache);
  await seedSnapshot(harness, sibling, siblingCache);
  await seedIntent(harness, sibling, followRequest({ idempotencyKey: "sibling-key" }));
  harness.rows.set(
    storageKey(own, ApplicationChatStorageRecordKind.queuedThreadFollowIntents),
    "{corrupt-thread-follow-row",
  );
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
  });
  assert.equal(await harness.storage.read(
    own,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ), null);
  assert.notEqual(await harness.storage.read(
    own,
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  ), null);
  assert.notEqual(await harness.storage.read(
    sibling,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ), null);
  assert.equal(fixture.diagnostics.at(-1).code, "thread_follow_intents_rejected");
  fixture.client.close();
});

test("delayed old-identity persistence cannot project or dispatch in the new identity", async () => {
  const oldUser = actorId;
  const newUser = "user-next";
  const oldScope = storageIdentity(oldUser);
  const newScope = storageIdentity(newUser);
  const harness = createStorageHarness();
  const identityRef = { current: oldScope };
  await seedSnapshot(harness, oldScope, seedCache({ userId: oldUser }));
  await seedSnapshot(harness, newScope, seedCache({ userId: newUser }));
  await seedIntent(harness, newScope, followRequest({ idempotencyKey: "new-user-key" }));
  const gate = deferred();
  const fixture = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(cacheIdentity(oldUser)),
  });
  harness.gateReplaces(gate, oldUser);
  const oldPending = fixture.client.followThread(threadId);
  await eventually(() => harness.threadWrites(oldUser).length >= 1);
  fixture.client.close();
  identityRef.current = newScope;
  const restarted = fixture.client.start();
  gate.resolve();
  assert.equal((await oldPending).status, "validation");
  assert.equal((await restarted).state, "ready");
  await eventually(() => commands(fixture).some((request) =>
    request.body.idempotencyKey === "new-user-key"));
  assert.equal(commands(fixture).some((request) =>
    request.body.idempotencyKey === "generated-thread-follow-key"), false);
  assert.equal(fixture.cache.getState().identity.userId, newUser);
  assert.equal(selectCurrentUserThreadFollowState(
    fixture.cache.getState(),
    threadId,
  ).pending.idempotencyKey, "new-user-key");
  fixture.client.close();
});

test("a follower announces only a retained follow correlation for leader dispatch and bounded result settlement", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const dispatched = deferred();
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    command: () => dispatched.promise,
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    command: () => { throw new Error("follower must not dispatch"); },
    keys: ["cross-tab-thread-follow-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination?.role, "leader");
  assert.equal(follower.client.coordination?.role, "follower");

  const pending = follower.client.followThread(threadId);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "cross-tab-thread-follow-key"));
  const announcement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available");
  assert.deepEqual(announcement.payload, {
    command: "thread.follow.set",
    idempotencyKey: "cross-tab-thread-follow-key",
  });
  assert.equal(JSON.stringify(announcement).includes(threadId), false);
  assert.equal(JSON.stringify(announcement).includes("access-token"), false);

  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-thread-follow-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => commands(leader).length === 1);
  assert.equal(commands(follower).length, 0);
  assert.equal(
    commands(leader)[0].body.idempotencyKey,
    "cross-tab-thread-follow-key",
  );
  assert.equal(commands(leader)[0].init.signal.aborted, false);

  dispatched.resolve(response(200, followResult(commands(leader)[0].body)));
  assert.equal((await pending).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ) === null);
  assert.equal(commands(leader).length + commands(follower).length, 1);
  assert.equal(hub.messages.filter((message) =>
    message.kind === "command-result" &&
    message.payload.idempotencyKey === "cross-tab-thread-follow-key").length, 1);
  assert.equal(selectCurrentUserThreadFollowState(
    follower.cache.getState(),
    threadId,
  ).pending, undefined);

  leader.client.close();
  follower.client.close();
});

test("follow then unfollow coalesces before leader reload to the latest retained correlation", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    keys: ["follow-first-key", "unfollow-latest-key"],
    command: () => { throw new Error("follower must not dispatch"); },
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  hub.paused = true;

  const first = follower.client.followThread(threadId);
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ))?.intents[0]?.request.idempotencyKey === "follow-first-key");
  const latest = follower.client.unfollowThread(threadId);
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ))?.intents[0]?.request.idempotencyKey === "unfollow-latest-key");
  assert.equal((await first).status, "closed");

  hub.flush();
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "unfollow-latest-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  assert.equal((await latest).status, "success");
  assert.deepEqual(commands(leader).map(({ body }) => ({
    intent: body.intent,
    idempotencyKey: body.idempotencyKey,
  })), [{ intent: "unfollow", idempotencyKey: "unfollow-latest-key" }]);
  assert.equal(commands(follower).length, 0);

  leader.client.close();
  follower.client.close();
});

test("leadership transfer preserves the retained key and dispatches it once", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const firstLeader = await createFixture({
    harness,
    cache: seedCache(),
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const successor = await createFixture({
    harness,
    cache: seedCache(),
    keys: ["leadership-transfer-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);

  const pending = successor.client.followThread(threadId);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-a" &&
    message.payload.idempotencyKey === "leadership-transfer-key"));
  firstLeader.client.close();
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(successor.client.coordination?.role, "leader");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-b" &&
    message.payload.idempotencyKey === "leadership-transfer-key"));
  clock.tick(crossTabTiming.commandClaimLeaseMs + crossTabTiming.commandClaimDelayMs);
  assert.equal((await pending).status, "success");
  assert.equal(commands(firstLeader).length, 0);
  assert.deepEqual(commands(successor).map(({ body }) => body.idempotencyKey), [
    "leadership-transfer-key",
  ]);

  successor.client.close();
});

test("unavailable coordination fails open and recovers the retained follow locally", async () => {
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const fixture = await createFixture({
    keys: ["fallback-thread-follow-key"],
    crossTab: {
      hub,
      clock,
      tabId: "tab-fallback",
      behavior: { constructThrows: true },
    },
  });
  assert.equal(fixture.client.coordination?.role, "fallback");
  assert.equal((await fixture.client.followThread(threadId)).status, "success");
  assert.deepEqual(commands(fixture).map(({ body }) => body.idempotencyKey), [
    "fallback-thread-follow-key",
  ]);
  assert.equal(await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ), null);
  fixture.client.close();
});

test("two clients atomically retain follow intents for different threads", async () => {
  const harness = createAtomicStorageHarness();
  const otherThreadId = "conversation-thread-follow-concurrent";
  const threadIds = [threadId, otherThreadId];
  const first = await createFixture({
    harness,
    cache: seedCache({ threadIds }),
    keys: ["atomic-first-thread-key"],
    command: () => pendingForever,
  });
  const second = await createFixture({
    harness,
    cache: seedCache({ threadIds }),
    keys: ["atomic-second-thread-key"],
    command: () => pendingForever,
  });

  harness.armRace();
  const firstPending = first.client.followThread(threadId);
  await eventually(() => harness.raceArrivals() === 1);
  const secondPending = second.client.followThread(otherThreadId);
  await eventually(async () => (await harness.readThreadRecord())?.intents.length === 2);

  const committed = await harness.readThreadRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.target.id,
    request.idempotencyKey,
    request.expectedFollowRevision,
  ]), [
    [1, otherThreadId, "atomic-second-thread-key", 0],
    [2, threadId, "atomic-first-thread-key", 0],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale different-thread proposal must retry against committed storage",
  );

  first.client.close();
  second.client.close();
  await Promise.all([firstPending, secondPending]);
});

test("follow and unfollow contention retains the latest atomically committed request", async () => {
  const harness = createAtomicStorageHarness();
  const latestCommit = await createFixture({
    harness,
    cache: seedCache(),
    keys: ["atomic-latest-follow-key"],
    command: () => pendingForever,
  });
  const firstCommit = await createFixture({
    harness,
    cache: seedCache({ revision: 1, isFollowing: true }),
    keys: ["atomic-first-unfollow-key"],
    command: () => pendingForever,
  });
  firstCommit.cache.applyDurableEvent(followEvent(
    "atomic-first-unfollow-authority",
    1,
    followState(true),
  ));

  harness.armRace();
  const followPending = latestCommit.client.followThread(threadId);
  await eventually(() => harness.raceArrivals() === 1);
  const unfollowPending = firstCommit.client.unfollowThread(threadId);
  await eventually(async () =>
    (await harness.readThreadRecord())?.intents[0]?.request.idempotencyKey ===
      "atomic-latest-follow-key");

  const committed = await harness.readThreadRecord();
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].enqueueOrder, 1);
  assert.equal(committed.intents[0].request.intent, "follow");
  assert.equal(committed.intents[0].request.idempotencyKey, "atomic-latest-follow-key");
  assert.equal(committed.intents[0].request.expectedFollowRevision, 0);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale same-thread proposal must retry and become the latest commit",
  );

  latestCommit.client.close();
  firstCommit.client.close();
  await Promise.all([followPending, unfollowPending]);
});

test("stale completion cannot remove a replacement thread-follow correlation", async () => {
  const harness = createAtomicStorageHarness();
  const oldResponse = deferred();
  const old = await createFixture({
    harness,
    cache: seedCache(),
    keys: ["atomic-old-follow-key"],
    command: () => oldResponse.promise,
  });
  const replacement = await createFixture({
    harness,
    cache: seedCache({ revision: 1, isFollowing: true }),
    keys: ["atomic-replacement-unfollow-key"],
    command: () => pendingForever,
  });
  replacement.cache.applyDurableEvent(followEvent(
    "atomic-replacement-unfollow-authority",
    1,
    followState(true),
  ));
  const oldPending = old.client.followThread(threadId);
  await eventually(() => commands(old).length === 1);

  harness.armRace();
  oldResponse.resolve(response(200, followResult(commands(old)[0].body)));
  await eventually(() => harness.raceArrivals() === 1);
  const replacementPending = replacement.client.unfollowThread(threadId);
  await eventually(async () =>
    (await harness.readThreadRecord())?.intents[0]?.request.idempotencyKey ===
      "atomic-replacement-unfollow-key");
  await oldPending;

  const committed = await harness.readThreadRecord();
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].request.intent, "unfollow");
  assert.equal(
    committed.intents[0].request.idempotencyKey,
    "atomic-replacement-unfollow-key",
  );
  assert.equal(committed.intents[0].request.expectedFollowRevision, 1);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale completion must retry without deleting the replacement",
  );

  old.client.close();
  replacement.client.close();
  await replacementPending;
});
