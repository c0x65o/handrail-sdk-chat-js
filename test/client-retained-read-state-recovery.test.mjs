import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedReadCursorIntent,
  createApplicationChatQueuedReadCursorIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  createReadCursorUpdatedEvent,
} from "../dist/index.js";

const tenantId = "tenant-retained-read";
const conversationId = "conversation-retained-read";
const at = (second) => `2032-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const identity = (userId = "reader-a", deviceId = "device-a") => ({
  tenantId, userId, deviceId,
});
const cacheIdentity = (userId = "reader-a") => ({
  tenantId, userId, sessionId: `session-${userId}`,
});
const key = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { conversation_snapshots: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

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

  factory = (owner) => (name) => {
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      listeners,
      postMessage: (message) => {
        if (channel.closed) return;
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        for (const peer of [...this.channels]) {
          if (peer !== channel && !peer.closed && peer.name === name) {
            for (const listener of peer.listeners) listener({ data: structuredClone(cloned) });
          }
        }
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

  injectTo(owner, data) {
    for (const channel of this.channels) {
      if (channel.owner === owner) {
        for (const listener of channel.listeners) listener({ data: structuredClone(data) });
      }
    }
  }
}

const crossTabTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

const readState = (userId, lastReadSequence, second, manualUnreadFromSequence) => ({
  conversationId,
  userId,
  lastReadSequence,
  updatedAt: at(second),
  ...(manualUnreadFromSequence === undefined ? {} : { manualUnreadFromSequence }),
});
const summary = (userId, lastReadSequence = 1, second = 2) => ({
  id: conversationId,
  tenantId,
  type: "channel",
  visibility: "public",
  name: "Retained read recovery",
  createdAt: at(0),
  updatedAt: at(second),
  latestSequence: 5,
  unreadMentionCount: 0,
  activityAt: at(second),
  activeMemberUserIds: [userId],
  hasActiveHuddle: false,
  currentMember: {
    tenantId,
    conversationId,
    userId,
    role: "member",
    state: "active",
    joinedAt: at(0),
    updatedAt: at(second),
  },
  currentReadState: readState(userId, lastReadSequence, second),
  currentPreference: {
    conversationId,
    userId,
    isStarred: false,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: at(second),
  },
});
const listSnapshot = (userId, lastReadSequence = 1, second = 2) => ({
  kind: "conversation_list",
  scope: { type: "organization" },
  items: [summary(userId, lastReadSequence, second)],
  page: {},
  _meta: { ...metadata, feature: { name: "conversation_snapshots", version: 1 } },
});
const outcome = (request, userId, second = 8) => ({
  operation: request.operation,
  conversationId,
  readState: readState(
    userId,
    request.operation === "mark_read" ? request.throughSequence : 5,
    second,
    request.operation === "mark_unread" ? request.fromSequence : undefined,
  ),
  latestSequence: 5,
  unreadCount: request.operation === "mark_unread" ? 4 : 0,
  reconciliationStatus: "applied",
  idempotencyKey: request.idempotencyKey,
});

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let readGate;
  const adapter = {
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      if (kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents && readGate) {
        await readGate.promise;
      }
      return rows.get(key(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope, kind });
      rows.set(key(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope, kind });
      rows.delete(key(scope, kind));
    },
    async clearForLogout(scope) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(key(scope, kind));
      }
    },
  };
  return {
    rows,
    calls,
    adapter,
    storage: createApplicationChatStorage(adapter),
    setReadGate(gate) { readGate = gate; },
  };
}

async function seedIntents(harness, scope, specs) {
  const intents = specs.map((request, index) =>
    createApplicationChatQueuedReadCursorIntent(
      request,
      readState(scope.userId, request.operation === "mark_unread" ? 5 : 1, 0),
      { enqueueOrder: index + 1, enqueuedAt: at(index + 1) },
    ));
  await harness.storage.replace(
    createApplicationChatQueuedReadCursorIntentsRecord(scope, intents),
  );
}

function createNetwork(initiallyOnline) {
  let online = initiallyOnline;
  const listeners = { online: new Set(), offline: new Set() };
  return {
    isOnline: () => online,
    addEventListener(type, listener) { listeners[type].add(listener); },
    removeEventListener(type, listener) { listeners[type].delete(listener); },
    setOnline(next) {
      online = next;
      for (const listener of [...listeners[next ? "online" : "offline"]]) listener();
    },
  };
}

function createSockets(scope) {
  const sockets = [];
  return {
    sockets,
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
            metadata,
            tenantId: scope.tenantId,
            actorStreamId: `user:${scope.userId}`,
            deviceId: scope.deviceId,
            sessionId: `session-${scope.userId}`,
          }) });
        },
        event(value) { this.onmessage?.({ data: JSON.stringify(value) }); },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

function createWaitHarness() {
  const waits = [];
  return {
    waits,
    wait(delayMs, signal) {
      const gate = deferred();
      waits.push({ delayMs, signal, gate });
      signal.addEventListener("abort", () => gate.reject(new Error("aborted")), { once: true });
      return gate.promise;
    },
  };
}

function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: identity() },
  cache = createNormalizedChatCache(cacheIdentity(identityRef.current.userId)),
  command,
  network,
  sockets,
  wait,
  diagnostics = [],
  snapshot = () => listSnapshot(identityRef.current.userId),
  crossTab,
  generateIdempotencyKey = () => "unused-new-key",
} = {}) {
  const requests = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    fetch: async (url, init) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata);
      if (init.method === "GET") return response(200, snapshot());
      const body = JSON.parse(init.body);
      requests.push({ url, init, body, scope: identityRef.current });
      return command?.(body, requests.length) ?? response(200, outcome(
        body,
        identityRef.current.userId,
      ));
    },
    readState: {
      generateIdempotencyKey,
      retainedRecovery: {
        initialDelayMs: 10,
        maximumDelayMs: 20,
        multiplier: 2,
        ...(wait === undefined ? {} : { wait }),
      },
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    ...(network && sockets ? {
      realtime: {
        network,
        webSocketFactory: sockets.factory,
        retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
      },
    } : {}),
    ...(crossTab === undefined ? {} : { crossTab }),
  });
  return { client, cache, harness, identityRef, requests, diagnostics };
}

test("reload waits for an authoritative baseline, then preserves correlations and per-conversation ordering", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const requests = [
    { operation: "mark_unread", conversationId, fromSequence: 2, idempotencyKey: "retained-unread" },
    { operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "retained-read" },
  ];
  await seedIntents(harness, scope, requests);
  const persistedCache = createNormalizedChatCache(cacheIdentity());
  persistedCache.hydrateConversationList(listSnapshot(scope.userId, 5, 1));
  await harness.storage.replace(createApplicationChatNormalizedSnapshotRecord(
    scope,
    persistedCache.getState(),
  ));
  const first = deferred();
  const fixture = createFixture({
    harness,
    cache: createNormalizedChatCache(),
    command: (body, attempt) => attempt === 1
      ? first.promise
      : response(200, outcome(body, scope.userId, 9)),
  });

  assert.equal((await fixture.client.start()).state, "ready");
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.cache.getState().currentUser.readStates[conversationId].lastReadSequence, 5);
  assert.ok(await harness.storage.read(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents));

  assert.equal((await fixture.client.listConversations({ scope: { type: "organization" } })).status, "success");
  await eventually(() => fixture.requests.length === 1);
  assert.equal(fixture.requests[0].body.idempotencyKey, "retained-unread");
  assert.equal(fixture.requests[0].init.headers["idempotency-key"], "retained-unread");
  first.resolve(response(200, outcome(requests[0], scope.userId, 8)));
  await eventually(() => fixture.requests.length === 2);
  assert.deepEqual(fixture.requests.map(({ body }) => body.operation), ["mark_unread", "mark_read"]);
  assert.deepEqual(fixture.requests.map(({ body }) => body.idempotencyKey), [
    "retained-unread", "retained-read",
  ]);
  await eventually(async () =>
    await harness.storage.read(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents) === null);
  fixture.client.close();
});

test("transient retry pauses offline and resumes after reconnect with bounded backoff", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const retained = {
    operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "retained-retry",
  };
  await seedIntents(harness, scope, [retained]);
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.hydrateConversationList(listSnapshot(scope.userId));
  const network = createNetwork(true);
  const sockets = createSockets(scope);
  const clock = createWaitHarness();
  const fixture = createFixture({
    harness, cache, network, sockets, wait: clock.wait,
    command: (body, attempt) => attempt <= 3
      ? Promise.reject(new Error("offline"))
      : response(200, outcome(body, scope.userId)),
  });

  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => clock.waits.length === 1);
  assert.equal(clock.waits[0].delayMs, 10);
  clock.waits[0].gate.resolve();
  await eventually(() => clock.waits.length === 2);
  assert.equal(clock.waits[1].delayMs, 20);
  clock.waits[1].gate.resolve();
  await eventually(() => clock.waits.length === 3);
  assert.equal(clock.waits[2].delayMs, 20, "retry delay remains bounded");
  network.setOnline(false);
  await eventually(() => clock.waits[2].signal.aborted);
  assert.equal(fixture.requests.length, 3);
  network.setOnline(true);
  await eventually(() => sockets.sockets.length === 2);
  sockets.sockets[1].accept();
  await eventually(() => fixture.requests.length === 4);
  assert.equal(fixture.requests.every(({ body }) => body.idempotencyKey === "retained-retry"), true);
  await eventually(async () =>
    await harness.storage.read(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents) === null);
  fixture.client.close();
});

test("a matching canonical event settles an ambiguous in-flight retained request", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const retained = {
    operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "retained-event",
  };
  await seedIntents(harness, scope, [retained]);
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.hydrateConversationList(listSnapshot(scope.userId));
  const network = createNetwork(true);
  const sockets = createSockets(scope);
  const ambiguous = deferred();
  const fixture = createFixture({
    harness, cache, network, sockets, command: () => ambiguous.promise,
  });

  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => fixture.requests.length === 1);
  sockets.sockets[0].event(createReadCursorUpdatedEvent({
    eventId: "retained-read-event",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(8),
    result: {
      operation: "mark_read",
      conversationId,
      readState: readState(scope.userId, 5, 8),
      latestSequence: 5,
      unreadCount: 0,
    },
  }));
  await eventually(async () =>
    await harness.storage.read(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents) === null);
  ambiguous.resolve(response(503, { error: { code: "LATE", message: "late" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 1);
  fixture.client.close();
});

test("corrupt records are quarantined without preventing startup", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  harness.rows.set(key(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents), "{not-json");
  const diagnostics = [];
  const fixture = createFixture({ harness, diagnostics });
  assert.equal((await fixture.client.start()).state, "ready");
  assert.equal(
    harness.rows.has(key(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents)),
    false,
  );
  assert.deepEqual(diagnostics.map(({ code }) => code), ["read_intents_rejected"]);
  fixture.client.close();
});

test("close cancels retained backoff and leaves the exact record", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedIntents(harness, scope, [{
    operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "retained-close",
  }]);
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.hydrateConversationList(listSnapshot(scope.userId));
  const clock = createWaitHarness();
  const fixture = createFixture({
    harness, cache, wait: clock.wait, command: () => Promise.reject(new Error("offline")),
  });
  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => clock.waits.length === 1);
  fixture.client.close();
  assert.equal(clock.waits[0].signal.aborted, true);
  assert.equal(
    (await harness.storage.read(scope, ApplicationChatStorageRecordKind.queuedReadCursorIntents))
      .intents[0].request.idempotencyKey,
    "retained-close",
  );
});

test("identity switch invalidates a delayed retained read without cross-identity effects", async () => {
  const harness = createStorageHarness();
  const oldScope = identity("reader-a", "device-a");
  const nextScope = identity("reader-b", "device-b");
  await seedIntents(harness, oldScope, [{
    operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "old-intent",
  }]);
  await seedIntents(harness, nextScope, [{
    operation: "mark_read", conversationId, throughSequence: 4, idempotencyKey: "next-intent",
  }]);
  const oldRead = deferred();
  harness.setReadGate(oldRead);
  const identityRef = { current: oldScope };
  const fixture = createFixture({ harness, identityRef });
  const oldStart = fixture.client.start();
  await eventually(() => harness.calls.some(({ operation, scope, kind }) =>
    operation === "read" && scope.userId === "reader-a" &&
    kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents));
  fixture.client.close();
  identityRef.current = nextScope;
  fixture.cache.setIdentity(cacheIdentity("reader-b"));
  harness.setReadGate(undefined);
  assert.equal((await fixture.client.start()).state, "ready");
  fixture.cache.setIdentity(cacheIdentity("reader-b"));
  fixture.cache.hydrateConversationList(listSnapshot("reader-b", 1, 3));
  const nextIdentityReadsBeforeOldCompletion = harness.calls.filter(({ operation, scope, kind }) =>
    operation === "read" && scope.userId === "reader-b" &&
    kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length;
  oldRead.resolve();
  await oldStart;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.requests.some(({ scope }) => scope.userId === "reader-a"), false);
  assert.equal(fixture.cache.getState().identity.userId, "reader-b");
  assert.equal(
    fixture.cache.getState().currentUser.readStates[conversationId].lastReadSequence,
    1,
  );
  assert.equal(harness.calls.filter(({ operation, scope, kind }) =>
    operation === "read" && scope.userId === "reader-b" &&
    kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length,
  nextIdentityReadsBeforeOldCompletion);
  assert.equal(
    (await harness.storage.read(nextScope, ApplicationChatStorageRecordKind.queuedReadCursorIntents))
      .intents[0].request.idempotencyKey,
    "next-intent",
  );
  assert.equal(harness.calls.some(({ operation, scope }) =>
    operation === "remove" &&
    (scope.userId === "reader-a" || scope.userId === "reader-b")), false);
  fixture.client.close();
});

const createCrossTabFixture = ({
  tabId,
  hub,
  clock,
  harness,
  command,
  idempotencyKey,
  lastReadSequence = 1,
}) => {
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.hydrateConversationList(listSnapshot("reader-a", lastReadSequence));
  return createFixture({
    harness,
    cache,
    command,
    generateIdempotencyKey: () => idempotencyKey,
    crossTab: {
      sessionFingerprint: "retained-read-shared-session",
      tabId,
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory(tabId),
    },
  });
};

const startCrossTabPair = async (left, right, clock) => {
  await Promise.all([left.client.start(), right.client.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(left.client.coordination.role, "leader");
  assert.equal(right.client.coordination.role, "follower");
};

test("a follower announces a durable read intent, closes, and only the leader dispatches it", async () => {
  const harness = createStorageHarness();
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leader = createCrossTabFixture({
    tabId: "tab-a", hub, clock, harness, idempotencyKey: "leader-unused",
    lastReadSequence: 5,
  });
  const follower = createCrossTabFixture({
    tabId: "tab-b", hub, clock, harness, idempotencyKey: "follower-unread",
    lastReadSequence: 5,
  });
  await startCrossTabPair(leader, follower, clock);

  const pending = follower.client.markUnread({ conversationId, fromSequence: 2 });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.command === "conversation.mark_unread" &&
    message.payload.idempotencyKey === "follower-unread"));
  follower.client.close();
  assert.equal((await pending).status, "closed");

  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" && message.senderId === "tab-a" &&
    message.payload.idempotencyKey === "follower-unread"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => leader.requests.length === 1);
  assert.equal(follower.requests.length, 0);
  assert.equal(leader.requests[0].body.operation, "mark_unread");
  assert.equal(leader.requests[0].body.idempotencyKey, "follower-unread");
  await eventually(async () =>
    await harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    ) === null);
  assert.equal(JSON.stringify(hub.messages).includes("access-token"), false);
  leader.client.close();
});

test("leadership failover reloads retained read work before dispatch", async () => {
  const harness = createStorageHarness();
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const formerLeader = createCrossTabFixture({
    tabId: "tab-a", hub, clock, harness, idempotencyKey: "former-unused",
  });
  const successor = createCrossTabFixture({
    tabId: "tab-b", hub, clock, harness, idempotencyKey: "successor-unused",
  });
  await startCrossTabPair(formerLeader, successor, clock);
  await seedIntents(harness, identity(), [{
    operation: "mark_read",
    conversationId,
    throughSequence: 5,
    idempotencyKey: "failover-read",
  }]);
  const readsBeforeFailover = harness.calls.filter(({ operation, kind }) =>
    operation === "read" && kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length;

  formerLeader.client.close();
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(successor.client.coordination.role, "leader");
  await eventually(() => harness.calls.filter(({ operation, kind }) =>
    operation === "read" && kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length >
    readsBeforeFailover);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "failover-read"));
  assert.equal(successor.requests.length, 0, "reload precedes the command claim delay");
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => successor.requests.length === 1);
  assert.equal(successor.requests[0].body.idempotencyKey, "failover-read");
  await eventually(async () =>
    await harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    ) === null);
  successor.client.close();
});

test("unsupported, malformed, and nonmatching announcements cannot cross identity scope", async () => {
  const harness = createStorageHarness();
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leader = createCrossTabFixture({
    tabId: "tab-a", hub, clock, harness, idempotencyKey: "leader-unused",
  });
  const follower = createCrossTabFixture({
    tabId: "tab-b", hub, clock, harness, idempotencyKey: "follower-unused",
  });
  await startCrossTabPair(leader, follower, clock);
  const activeScope = identity();
  const foreignScope = { tenantId: "tenant-other", userId: "reader-other", deviceId: "device-other" };
  await seedIntents(harness, activeScope, [{
    operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "actual-read",
  }]);
  await seedIntents(harness, foreignScope, [{
    operation: "mark_read", conversationId, throughSequence: 5, idempotencyKey: "foreign-read",
  }]);
  const heartbeat = hub.messages.findLast((message) => message.kind === "heartbeat");
  assert.ok(heartbeat);
  const announcement = (command, idempotencyKey) => ({
    ...heartbeat,
    kind: "persisted-command-available",
    senderId: "tab-b",
    payload: { command, idempotencyKey },
  });
  const readsBefore = harness.calls.filter(({ operation, kind }) =>
    operation === "read" && kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length;
  hub.injectTo("tab-a", announcement("message.delete", "actual-read"));
  hub.injectTo("tab-a", announcement("conversation.mark_read", ""));
  assert.equal(harness.calls.filter(({ operation, kind }) =>
    operation === "read" && kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length,
  readsBefore);

  hub.injectTo("tab-a", announcement("conversation.mark_read", "missing-read"));
  await eventually(() => harness.calls.filter(({ operation, kind }) =>
    operation === "read" && kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents).length ===
    readsBefore + 1);
  clock.tick(crossTabTiming.commandClaimDelayMs);
  assert.equal(leader.requests.length + follower.requests.length, 0);
  assert.equal(leader.cache.getState().currentUser.readStates[conversationId].lastReadSequence, 1);
  const scopedReads = harness.calls.filter(({ operation, kind }) =>
    operation === "read" && kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents);
  assert.equal(scopedReads.every(({ scope }) =>
    scope.tenantId === activeScope.tenantId &&
    scope.userId === activeScope.userId &&
    scope.deviceId === activeScope.deviceId), true);
  assert.equal(
    (await harness.storage.read(
      foreignScope,
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    )).intents[0].request.idempotencyKey,
    "foreign-read",
  );
  leader.client.close();
  follower.client.close();
});

test("coordinated read results settle only the exactly matching correlation", async () => {
  const harness = createStorageHarness();
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const command = deferred();
  const leader = createCrossTabFixture({
    tabId: "tab-a", hub, clock, harness, idempotencyKey: "leader-unused",
    command: () => command.promise,
  });
  const follower = createCrossTabFixture({
    tabId: "tab-b", hub, clock, harness, idempotencyKey: "coordinated-read",
  });
  await startCrossTabPair(leader, follower, clock);
  const pending = follower.client.markRead({ conversationId, throughSequence: 5 });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" && message.senderId === "tab-a" &&
    message.payload.idempotencyKey === "coordinated-read"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => leader.requests.length === 1);
  const heartbeat = hub.messages.findLast((message) => message.kind === "heartbeat");
  hub.injectTo("tab-b", {
    ...heartbeat,
    kind: "command-result",
    senderId: "tab-a",
    payload: {
      command: "conversation.mark_read",
      idempotencyKey: "another-correlation",
      result: { status: "success", value: outcome({
        operation: "mark_read",
        conversationId,
        throughSequence: 5,
        idempotencyKey: "another-correlation",
      }, "reader-a") },
    },
  });
  assert.equal(
    (await harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    )).intents[0].request.idempotencyKey,
    "coordinated-read",
  );

  command.resolve(response(200, outcome(leader.requests[0].body, "reader-a")));
  assert.equal((await pending).status, "success");
  await eventually(async () =>
    await harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    ) === null);
  assert.equal(leader.requests.length, 1);
  assert.equal(follower.requests.length, 0);
  leader.client.close();
  follower.client.close();
});
