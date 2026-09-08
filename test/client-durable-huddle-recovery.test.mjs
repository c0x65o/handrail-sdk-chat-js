import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedHuddleCommandIntent,
  createApplicationChatQueuedHuddleCommandIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-huddle-recovery";
const actorId = "user-huddle-recovery";
const conversationId = "conversation-huddle-recovery";
const sessionId = "session-huddle-recovery";
const descriptor = "OPAQUE_RECOVERY_DESCRIPTOR_MUST_NOT_PERSIST";
const accessToken = "PRIVATE_HUDDLE_ACCESS_TOKEN_MUST_NOT_COORDINATE";
const nowMs = Date.parse("2038-02-03T04:05:06.000Z");
const at = (second = 0) => `2038-02-03T04:05:${String(second).padStart(2, "0")}.000Z`;
const storageIdentity = (userId = actorId) => ({
  tenantId,
  userId,
  deviceId: `device-${userId}`,
});
const cacheIdentity = (userId = actorId) => ({
  tenantId,
  userId,
  sessionId: `browser-${userId}`,
});
const rowKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
const metadata = (realtime = false) => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: realtime ? { huddles: true, realtime: true } : { huddles: true },
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
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const inactive = { status: "inactive", conversationId };
const starting = {
  status: "starting",
  conversationId,
  huddleSessionId: sessionId,
  startedAt: at(1),
  participants: [],
  screenShareOwnerUserId: null,
};
const active = {
  ...starting,
  status: "active",
  participants: [{ userId: actorId, status: "joined", joinedAt: at(2) }],
};
const sharing = { ...active, screenShareOwnerUserId: actorId };
const left = {
  ...active,
  participants: [{
    userId: actorId,
    status: "left",
    joinedAt: at(2),
    leftAt: at(3),
  }],
};
const ended = {
  status: "ended",
  conversationId,
  huddleSessionId: sessionId,
  startedAt: at(1),
  endedAt: at(4),
  endedByUserId: actorId,
  participants: [{
    userId: actorId,
    status: "left",
    joinedAt: at(2),
    leftAt: at(4),
  }],
  screenShareOwnerUserId: null,
};
const mediaJoin = {
  kind: "opaque_media_join",
  descriptor,
  expiresAt: "2038-02-03T04:09:00.000Z",
};
const commandResult = (input, state) => ({
  operation: input.operation,
  outcome: "ok",
  reconciliationStatus: "applied",
  state,
  ...(input.operation === "start_huddle" || input.operation === "join_huddle"
    ? { mediaJoin }
    : {}),
});

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let replaceGate;
  let readGate;
  let replaceFailureKind;
  const adapter = {
    async read(identity, kind) {
      calls.push({ operation: "read", identity: { ...identity }, kind });
      if (readGate?.kind === kind && readGate.userId === identity.userId) {
        const gate = readGate;
        readGate = undefined;
        await gate.promise;
      }
      return rows.get(rowKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity: { ...identity }, kind, encoded });
      if (replaceFailureKind === kind) {
        replaceFailureKind = undefined;
        throw new Error("storage unavailable");
      }
      if (replaceGate?.kind === kind) {
        const gate = replaceGate;
        replaceGate = undefined;
        await gate.promise;
      }
      rows.set(rowKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity: { ...identity }, kind });
      rows.delete(rowKey(identity, kind));
    },
    async clearForLogout(identity) {
      const prefix = `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0`;
      for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key);
    },
  };
  return {
    rows,
    calls,
    storage: createApplicationChatStorage(adapter),
    gateReplace(kind, gate) { replaceGate = { kind, promise: gate.promise }; },
    gateRead(kind, userId, gate) { readGate = { kind, userId, promise: gate.promise }; },
    failNextReplace(kind) { replaceFailureKind = kind; },
  };
}

function createAtomicStorageHarness() {
  const rows = new Map();
  const calls = [];
  let compareExchangeBarrier;
  let replacementAfterConditionalRemoval;
  const adapter = {
    async read(identity, kind) {
      calls.push({ operation: "read", identity: { ...identity }, kind });
      return rows.get(rowKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity: { ...identity }, kind, encoded });
      rows.set(rowKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity: { ...identity }, kind });
      rows.delete(rowKey(identity, kind));
    },
    async compareExchange(identity, kind, expected, replacement) {
      const call = {
        operation: "compareExchange",
        identity: { ...identity },
        kind,
        expected,
        replacement,
        success: undefined,
      };
      calls.push(call);
      const barrier = compareExchangeBarrier?.kind === kind
        ? compareExchangeBarrier
        : undefined;
      let barrierIndex;
      if (barrier !== undefined) {
        barrierIndex = barrier.arrivals;
        barrier.arrivals += 1;
        if (barrier.arrivals === barrier.count) {
          barrier.reached.resolve();
          barrier.turns[0].resolve();
        }
        await barrier.turns[barrierIndex].promise;
      }

      // The expected-value comparison and update are one synchronous critical
      // section, matching an atomic host storage primitive.
      const key = rowKey(identity, kind);
      const current = rows.get(key) ?? null;
      call.success = current === expected;
      if (call.success) {
        if (replacement === null) rows.delete(key);
        else rows.set(key, replacement);
        if (
          replacement === null &&
          replacementAfterConditionalRemoval?.kind === kind
        ) {
          rows.set(key, replacementAfterConditionalRemoval.encoded);
          replacementAfterConditionalRemoval = undefined;
        }
      }

      if (barrier !== undefined) {
        barrier.turns[barrierIndex + 1]?.resolve();
        if (barrierIndex + 1 === barrier.count && compareExchangeBarrier === barrier) {
          compareExchangeBarrier = undefined;
        }
      }
      return call.success;
    },
    async clearForLogout(identity) {
      const prefix = `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0`;
      for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key);
    },
  };
  return {
    rows,
    calls,
    storage: createApplicationChatStorage(adapter),
    replaceAfterNextConditionalRemoval(kind, encoded) {
      assert.equal(replacementAfterConditionalRemoval, undefined);
      replacementAfterConditionalRemoval = { kind, encoded };
    },
    interleaveNextCompareExchanges(kind, count = 2) {
      assert.equal(compareExchangeBarrier, undefined);
      const reached = deferred();
      compareExchangeBarrier = {
        kind,
        count,
        arrivals: 0,
        reached,
        turns: Array.from({ length: count }, deferred),
      };
      return reached.promise;
    },
  };
}

function createHostActivity(initiallyActive = true) {
  let active = initiallyActive;
  const listeners = { visibilitychange: new Set(), focus: new Set(), blur: new Set() };
  return {
    boundary: {
      isActive: () => active,
      addEventListener(type, listener) { listeners[type].add(listener); },
      removeEventListener(type, listener) { listeners[type].delete(listener); },
    },
    setActive(next) {
      active = next;
      for (const listener of [...listeners[next ? "focus" : "blur"]]) listener();
      for (const listener of [...listeners.visibilitychange]) listener();
    },
  };
}

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
  factory = (owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("construction failed");
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      listeners,
      postMessage: (message) => {
        if (behavior.postThrows) throw new Error("posting failed");
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

async function seedSnapshot(harness, identity, state) {
  const cache = createNormalizedChatCache(cacheIdentity(identity.userId));
  cache.setHuddleState(state);
  await harness.storage.replace(createApplicationChatNormalizedSnapshotRecord(
    identity,
    cache.getState(),
  ));
}

async function seedIntent(harness, identity, request) {
  await harness.storage.replace(createApplicationChatQueuedHuddleCommandIntentsRecord(
    identity,
    [createApplicationChatQueuedHuddleCommandIntent(request, {
      enqueueOrder: 1,
      enqueuedAt: at(5),
    })],
  ));
}

async function seedIntents(harness, identity, requests) {
  await harness.storage.replace(createApplicationChatQueuedHuddleCommandIntentsRecord(
    identity,
    requests.map((request, index) => createApplicationChatQueuedHuddleCommandIntent(
      request,
      { enqueueOrder: index + 1, enqueuedAt: at(5 + index) },
    )),
  ));
}

async function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: storageIdentity() },
  cache = createNormalizedChatCache(),
  authority = () => inactive,
  command,
  host = createHostActivity(),
  recovery = {},
  realtime,
  crossTab,
  idempotencyPrefix = "generated-huddle",
  start = true,
} = {}) {
  const requests = [];
  const diagnostics = [];
  let keySequence = 0;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => accessToken,
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    huddles: {
      generateIdempotencyKey: () => `${idempotencyPrefix}-${++keySequence}`,
      now: () => nowMs,
      hostActivity: host.boundary,
      retainedRecovery: {
        initialDelayMs: 2,
        maximumDelayMs: 4,
        wait: (_delay, signal) => new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
        ...recovery,
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata(realtime !== undefined));
      if (init.method === "GET") {
        requests.push({ kind: "authority", url: String(url), identity: { ...identityRef.current } });
        return response(200, authority());
      }
      const body = JSON.parse(init.body);
      const request = { kind: "command", url: String(url), init, body, identity: { ...identityRef.current } };
      requests.push(request);
      return command?.(request) ?? response(200, commandResult(body, starting));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      onDiagnostic: (value) => diagnostics.push(value),
    },
    ...(crossTab === undefined ? {} : { crossTab }),
    ...(realtime === undefined ? {} : { realtime }),
  });
  if (start) assert.equal((await client.start()).state, "ready");
  return { client, cache, harness, identityRef, requests, diagnostics, host };
}

const commandRequests = (fixture) => fixture.requests.filter(({ kind }) => kind === "command");

test("a follower persists only a huddle correlation and the leader dispatches it once", async () => {
  const harness = createAtomicStorageHarness();
  const identity = storageIdentity();
  await seedSnapshot(harness, identity, inactive);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  let authorityState = inactive;
  const makeTab = (tabId) => createFixture({
    harness,
    authority: () => authorityState,
    command: ({ body }) => {
      authorityState = starting;
      return response(200, commandResult(body, starting));
    },
    crossTab: {
      sessionFingerprint: "tenant-huddle:user-huddle:device-huddle",
      channelFactory: hub.factory(tabId),
      clock,
      tabId,
      timing: crossTabTiming,
    },
  });
  const leader = await makeTab("tab-a");
  const follower = await makeTab("tab-b");
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination.role, "leader");
  assert.equal(follower.client.coordination.role, "follower");

  const action = follower.client.startHuddle(conversationId);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.command === "huddle.command"));
  const announcement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.command === "huddle.command");
  assert.deepEqual(announcement.payload, {
    command: "huddle.command",
    idempotencyKey: "generated-huddle-1",
  });
  const persisted = await harness.storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  );
  assert.equal(persisted.intents[0].request.idempotencyKey, "generated-huddle-1");
  assert.equal(commandRequests(follower).length, 0);

  // Re-observing the same retained correlation cannot create another request.
  hub.injectTo("tab-a", announcement);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.command === "huddle.command"));
  await eventually(() => {
    clock.tick(crossTabTiming.commandClaimDelayMs);
    return hub.messages.some((message) =>
      message.kind === "command-result" &&
      message.payload.command === "huddle.command");
  }, "the leader did not fan out huddle completion");
  const result = await action;
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.state.status, "starting");
  assert.equal(commandRequests(leader).length, 1);
  assert.equal(commandRequests(follower).length, 0);
  assert.equal(
    commandRequests(leader)[0].body.idempotencyKey,
    "generated-huddle-1",
  );

  const huddleEnvelopes = hub.messages.filter((message) =>
    message.payload?.command === "huddle.command");
  const serialized = JSON.stringify(huddleEnvelopes);
  const relayedResult = huddleEnvelopes.findLast((message) =>
    message.kind === "command-result");
  assert.deepEqual(relayedResult.payload.result, {
    status: "success",
    value: { authorityRefresh: true },
  });
  for (const prohibited of [
    conversationId,
    sessionId,
    actorId,
    descriptor,
    accessToken,
    "start_huddle",
    "screenShareOwnerUserId",
    "participants",
    "mediaJoin",
    "provider",
    "accessToken",
    "opaque_media_join",
  ]) assert.equal(serialized.includes(prohibited), false);
  assert.equal(
    await harness.storage.read(
      identity,
      ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    ),
    null,
  );
  leader.client.close();
  follower.client.close();
});

test("simultaneous runtimes atomically retain commands for different conversations", async () => {
  const harness = createAtomicStorageHarness();
  const firstConversationId = "conversation-concurrent-first";
  const secondConversationId = "conversation-concurrent-second";
  const firstCache = createNormalizedChatCache(cacheIdentity());
  const secondCache = createNormalizedChatCache(cacheIdentity());
  firstCache.setHuddleState({ status: "inactive", conversationId: firstConversationId });
  secondCache.setHuddleState({ status: "inactive", conversationId: secondConversationId });
  const neverRespond = () => new Promise(() => {});
  const first = await createFixture({
    harness,
    cache: firstCache,
    command: neverRespond,
    idempotencyPrefix: "concurrent-first",
  });
  const second = await createFixture({
    harness,
    cache: secondCache,
    command: neverRespond,
    idempotencyPrefix: "concurrent-second",
  });
  const kind = ApplicationChatStorageRecordKind.queuedHuddleCommandIntents;
  const interleaved = harness.interleaveNextCompareExchanges(kind);

  const firstAction = first.client.startHuddle(firstConversationId);
  const secondAction = second.client.startHuddle(secondConversationId);
  await eventually(() => harness.calls.filter(({ operation, kind: callKind }) =>
    operation === "compareExchange" && callKind === kind).length >= 2,
  "both runtimes did not reach compare/exchange");
  await interleaved;
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    kind,
  ))?.intents.length === 2);

  const persisted = await harness.storage.read(storageIdentity(), kind);
  assert.deepEqual(
    persisted.intents.map(({ request }) => request.conversationId).sort(),
    [firstConversationId, secondConversationId],
  );
  assert.deepEqual(
    persisted.intents.map(({ request }) => request.idempotencyKey).sort(),
    ["concurrent-first-1", "concurrent-second-1"],
  );
  assert.ok(harness.calls.some(({ operation, kind: callKind, success }) =>
    operation === "compareExchange" && callKind === kind && success === false));

  first.client.close();
  second.client.close();
  await Promise.all([firstAction, secondAction]);
});

test("simultaneous same-conversation commands receive deterministic FIFO order", async () => {
  const harness = createAtomicStorageHarness();
  const firstCache = createNormalizedChatCache(cacheIdentity());
  const secondCache = createNormalizedChatCache(cacheIdentity());
  firstCache.setHuddleState(inactive);
  secondCache.setHuddleState(inactive);
  const neverRespond = () => new Promise(() => {});
  const first = await createFixture({
    harness,
    cache: firstCache,
    command: neverRespond,
    idempotencyPrefix: "fifo-first",
  });
  const second = await createFixture({
    harness,
    cache: secondCache,
    command: neverRespond,
    idempotencyPrefix: "fifo-second",
  });
  const kind = ApplicationChatStorageRecordKind.queuedHuddleCommandIntents;
  const interleaved = harness.interleaveNextCompareExchanges(kind);

  const firstAction = first.client.startHuddle(conversationId);
  const secondAction = second.client.startHuddle(conversationId);
  await eventually(() => harness.calls.filter(({ operation, kind: callKind }) =>
    operation === "compareExchange" && callKind === kind).length >= 2,
  "both same-conversation commands did not reach compare/exchange");
  await interleaved;
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    kind,
  ))?.intents.length === 2);

  const persisted = await harness.storage.read(storageIdentity(), kind);
  assert.deepEqual(
    persisted.intents.map(({ enqueueOrder, request }) => ({
      enqueueOrder,
      idempotencyKey: request.idempotencyKey,
    })),
    [
      { enqueueOrder: 1, idempotencyKey: "fifo-first-1" },
      { enqueueOrder: 2, idempotencyKey: "fifo-second-1" },
    ],
  );
  assert.ok(harness.calls.some(({ operation, kind: callKind, success }) =>
    operation === "compareExchange" && callKind === kind && success === false));

  first.client.close();
  second.client.close();
  await Promise.all([firstAction, secondAction]);
});

test("exact settlement preserves later and concurrently appended intents", async () => {
  const harness = createAtomicStorageHarness();
  const laterConversationId = "conversation-settlement-later";
  const concurrentConversationId = "conversation-settlement-concurrent";
  const settlingCache = createNormalizedChatCache(cacheIdentity());
  settlingCache.setHuddleState(inactive);
  const appendingCache = createNormalizedChatCache(cacheIdentity());
  appendingCache.setHuddleState({ status: "inactive", conversationId: laterConversationId });
  appendingCache.setHuddleState({ status: "inactive", conversationId: concurrentConversationId });
  const settlementResponse = deferred();
  const neverRespond = () => new Promise(() => {});
  const settling = await createFixture({
    harness,
    cache: settlingCache,
    command: () => settlementResponse.promise,
    idempotencyPrefix: "settling",
  });
  const appending = await createFixture({
    harness,
    cache: appendingCache,
    command: neverRespond,
    idempotencyPrefix: "appended",
  });
  const kind = ApplicationChatStorageRecordKind.queuedHuddleCommandIntents;

  const settlingAction = settling.client.startHuddle(conversationId);
  await eventually(() => commandRequests(settling).length === 1);
  const laterAction = appending.client.startHuddle(laterConversationId);
  await eventually(() => commandRequests(appending).length === 1);
  assert.deepEqual(
    (await harness.storage.read(storageIdentity(), kind)).intents.map(
      ({ request }) => request.idempotencyKey,
    ),
    ["settling-1", "appended-1"],
  );

  const previousCallCount = harness.calls.length;
  const previousAttemptCount = harness.calls.filter(({ operation, kind: callKind }) =>
    operation === "compareExchange" && callKind === kind).length;
  const interleaved = harness.interleaveNextCompareExchanges(kind);
  const concurrentAction = appending.client.startHuddle(concurrentConversationId);
  settlementResponse.resolve(response(200, commandResult(
    commandRequests(settling)[0].body,
    starting,
  )));
  await eventually(() => harness.calls.filter(({ operation, kind: callKind }) =>
    operation === "compareExchange" && callKind === kind).length >= previousAttemptCount + 2,
  "settlement and append did not contend at compare/exchange");
  await interleaved;
  assert.equal((await settlingAction).status, "success");
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    kind,
  ))?.intents.length === 2);

  const persisted = await harness.storage.read(storageIdentity(), kind);
  assert.deepEqual(
    persisted.intents.map(({ enqueueOrder, request }) => ({
      enqueueOrder,
      idempotencyKey: request.idempotencyKey,
    })),
    [
      { enqueueOrder: 2, idempotencyKey: "appended-1" },
      { enqueueOrder: 3, idempotencyKey: "appended-2" },
    ],
  );
  assert.ok(harness.calls.slice(previousCallCount).some(
    ({ operation, kind: callKind, success }) =>
      operation === "compareExchange" && callKind === kind && success === false,
  ));

  settling.client.close();
  appending.client.close();
  await Promise.all([laterAction, concurrentAction]);
});

test("huddle persistence remains fail-open when cross-tab coordination is unavailable", async () => {
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.setHuddleState(inactive);
  const fixture = await createFixture({
    harness: createAtomicStorageHarness(),
    cache,
    crossTab: {
      sessionFingerprint: "tenant-huddle:user-huddle:device-huddle",
      channelFactory: () => { throw new Error("BroadcastChannel unavailable"); },
      tabId: "fallback-tab",
    },
  });
  assert.equal(fixture.client.coordination.role, "fallback");
  const result = await fixture.client.startHuddle(conversationId);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(commandRequests(fixture).length, 1);
  assert.equal(
    commandRequests(fixture)[0].body.idempotencyKey,
    "generated-huddle-1",
  );
  fixture.client.close();
});

test("the elected tab preserves retained huddle ordering when both tabs reload", async () => {
  const harness = createAtomicStorageHarness();
  const identity = storageIdentity();
  await seedSnapshot(harness, identity, active);
  await seedIntents(harness, identity, [
    {
      operation: "set_huddle_screen_share",
      huddleSessionId: sessionId,
      intent: "set",
      idempotencyKey: "ordered-huddle-set",
    },
    {
      operation: "set_huddle_screen_share",
      huddleSessionId: sessionId,
      intent: "clear",
      idempotencyKey: "ordered-huddle-clear",
    },
  ]);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  let authorityState = active;
  const makeTab = (tabId) => createFixture({
    harness,
    authority: () => authorityState,
    command: ({ body }) => {
      authorityState = body.intent === "set" ? sharing : active;
      return response(200, commandResult(body, authorityState));
    },
    crossTab: {
      sessionFingerprint: "tenant-huddle:user-huddle:device-huddle",
      channelFactory: hub.factory(tabId),
      clock,
      tabId,
      timing: crossTabTiming,
    },
  });
  const a = await makeTab("tab-a");
  const b = await makeTab("tab-b");
  clock.tick(crossTabTiming.electionDelayMs);
  await eventually(() => {
    clock.tick(crossTabTiming.commandClaimDelayMs);
    return commandRequests(a).length + commandRequests(b).length === 2;
  }, "the retained huddle lane did not drain in order");
  const dispatched = [...commandRequests(a), ...commandRequests(b)];
  assert.deepEqual(dispatched.map(({ body }) => body.idempotencyKey), [
    "ordered-huddle-set",
    "ordered-huddle-clear",
  ]);
  assert.equal(commandRequests(b).length, 0);
  await eventually(async () => await harness.storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ) === null);
  a.client.close();
  b.client.close();
});

test("leadership transfer reloads and dispatches the retained huddle correlation", async () => {
  const harness = createAtomicStorageHarness();
  const identity = storageIdentity();
  const retainedRequest = {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "transferred-huddle-key",
  };
  await seedSnapshot(harness, identity, inactive);
  await seedIntent(harness, identity, retainedRequest);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  let authorityState = inactive;
  const makeTab = (tabId) => createFixture({
    harness,
    authority: () => authorityState,
    command: ({ body }) => {
      authorityState = starting;
      return response(200, commandResult(body, starting));
    },
    crossTab: {
      sessionFingerprint: "tenant-huddle:user-huddle:device-huddle",
      channelFactory: hub.factory(tabId),
      clock,
      tabId,
      timing: crossTabTiming,
    },
  });
  const oldLeader = await makeTab("tab-a");
  const successor = await makeTab("tab-b");
  clock.tick(crossTabTiming.electionDelayMs);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-a" &&
    message.payload.idempotencyKey === retainedRequest.idempotencyKey));
  assert.equal(commandRequests(oldLeader).length, 0);

  oldLeader.client.close();
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(successor.client.coordination.role, "leader");
  for (let attempt = 0; attempt < 400 && commandRequests(successor).length === 0; attempt += 1) {
    clock.tick(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(commandRequests(successor).length, 1, JSON.stringify({
    status: successor.client.coordination,
    requests: successor.requests,
    storage: await harness.storage.read(
      identity,
      ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    ),
    messages: hub.messages.filter((message) =>
      message.payload?.command === "huddle.command").map((message) => ({
        senderId: message.senderId,
        term: message.term,
        kind: message.kind,
        payload: message.payload,
      })),
  }));
  assert.equal(commandRequests(oldLeader).length, 0);
  assert.equal(
    commandRequests(successor)[0].body.idempotencyKey,
    retainedRequest.idempotencyKey,
  );
  await eventually(async () => await harness.storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ) === null);
  successor.client.close();
});

test("persists a complete command before pending view or transport and keeps checkpoints canonical", async () => {
  const harness = createStorageHarness();
  const persistGate = deferred();
  const commandGate = deferred();
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.setHuddleState(inactive);
  const fixture = await createFixture({
    harness,
    cache,
    command: () => commandGate.promise,
  });
  harness.gateReplace(ApplicationChatStorageRecordKind.queuedHuddleCommandIntents, persistGate);
  const pending = fixture.client.startHuddle(conversationId);
  await eventually(() => harness.calls.some(({ operation, kind }) =>
    operation === "replace" && kind === ApplicationChatStorageRecordKind.queuedHuddleCommandIntents));
  assert.equal(commandRequests(fixture).length, 0);
  assert.equal(fixture.client.getHuddleState(conversationId).pendingOperation, undefined);
  persistGate.resolve();
  await eventually(() => commandRequests(fixture).length === 1);
  assert.equal(fixture.client.getHuddleState(conversationId).pendingOperation, "start_huddle");
  const stored = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  );
  assert.deepEqual(stored.intents[0].request, commandRequests(fixture)[0].body);
  assert.equal(stored.intents[0].request.idempotencyKey, "generated-huddle-1");
  assert.equal(JSON.stringify(stored).includes(descriptor), false);
  commandGate.resolve(response(200, commandResult(stored.intents[0].request, starting)));
  assert.equal((await pending).status, "success");
  await eventually(() => harness.calls.some(({ kind }) =>
    kind === ApplicationChatStorageRecordKind.normalizedSnapshot));
  const checkpoint = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(checkpoint.snapshot.huddles[conversationId], starting);
  assert.equal(JSON.stringify(checkpoint).includes("pendingOperation"), false);
  assert.equal(Object.hasOwn(checkpoint.snapshot, "recovery"), false);
  assert.equal(JSON.stringify(checkpoint).includes(descriptor), false);
  fixture.client.close();
});

test("a persistence failure does not project or dispatch the command", async () => {
  const harness = createStorageHarness();
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.setHuddleState(inactive);
  const fixture = await createFixture({ harness, cache });
  harness.failNextReplace(ApplicationChatStorageRecordKind.queuedHuddleCommandIntents);
  const result = await fixture.client.startHuddle(conversationId);
  assert.equal(result.status, "error");
  assert.equal(result.code, "transport");
  assert.equal(commandRequests(fixture).length, 0);
  assert.equal(fixture.client.getHuddleState(conversationId).pendingOperation, undefined);
  assert.equal(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  assert.ok(fixture.diagnostics.some(({ code }) => code === "huddle_intents_write_failed"));
  fixture.client.close();
});

test("reload replays every operation with its exact key and recovered joins require fresh media", async () => {
  const cases = [
    [{ operation: "start_huddle", conversationId, idempotencyKey: "exact-start" }, inactive, starting],
    [{ operation: "join_huddle", huddleSessionId: sessionId, idempotencyKey: "exact-join" }, starting, active],
    [{ operation: "leave_huddle", huddleSessionId: sessionId, idempotencyKey: "exact-leave" }, active, left],
    [{ operation: "set_huddle_screen_share", huddleSessionId: sessionId, intent: "set", idempotencyKey: "exact-set" }, active, sharing],
    [{ operation: "set_huddle_screen_share", huddleSessionId: sessionId, intent: "clear", idempotencyKey: "exact-clear" }, sharing, active],
    [{ operation: "end_huddle", huddleSessionId: sessionId, idempotencyKey: "exact-end" }, active, ended],
  ];
  for (const [request, before, after] of cases) {
    const harness = createStorageHarness();
    await seedSnapshot(harness, storageIdentity(), before);
    await seedIntent(harness, storageIdentity(), request);
    const fixture = await createFixture({
      harness,
      authority: () => before,
      command: ({ body }) => response(200, commandResult(body, after)),
    });
    await eventually(() => commandRequests(fixture).length === 1, request.operation);
    assert.deepEqual(commandRequests(fixture)[0].body, request);
    assert.equal(commandRequests(fixture)[0].init.headers["idempotency-key"], request.idempotencyKey);
    await eventually(
      () => fixture.cache.getState().huddles[conversationId] === after ||
        JSON.stringify(fixture.cache.getState().huddles[conversationId]) === JSON.stringify(after),
      `${request.operation} did not apply: ${JSON.stringify({
        view: fixture.client.getHuddleState(conversationId),
        diagnostics: fixture.diagnostics,
      })}`,
    );
    await eventually(async () => await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    ) === null, `${request.operation} intent did not settle`);
    if (request.operation === "start_huddle" || request.operation === "join_huddle") {
      assert.equal(fixture.client.getHuddleMediaJoinDescriptor(conversationId), undefined);
      assert.equal(fixture.client.getHuddleState(conversationId).media.state, "rejoin_required");
    }
    assert.equal(JSON.stringify([...harness.rows.values()]).includes(descriptor), false);
    fixture.client.close();
  }
});

test("event-first and already-equal authority settle while divergent authority retains a conflict", async () => {
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.setHuddleState(inactive);
  const gate = deferred();
  const eventFirst = await createFixture({ cache, command: () => gate.promise });
  const pending = eventFirst.client.startHuddle(conversationId);
  await eventually(() => commandRequests(eventFirst).length === 1);
  cache.setHuddleState(starting);
  assert.equal((await pending).status, "success");
  assert.equal(await eventFirst.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  eventFirst.client.close();

  const equalHarness = createStorageHarness();
  await seedSnapshot(equalHarness, storageIdentity(), starting);
  await seedIntent(equalHarness, storageIdentity(), {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "already-equal",
  });
  const equal = await createFixture({ harness: equalHarness, authority: () => starting });
  await eventually(async () => await equalHarness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ) === null);
  assert.equal(commandRequests(equal).length, 0);
  assert.equal(equal.client.getHuddleState(conversationId).media.state, "rejoin_required");
  equal.client.close();

  const conflictHarness = createStorageHarness();
  await seedSnapshot(conflictHarness, storageIdentity(), left);
  await seedIntent(conflictHarness, storageIdentity(), {
    operation: "join_huddle",
    huddleSessionId: sessionId,
    idempotencyKey: "divergent-join",
  });
  const conflict = await createFixture({ harness: conflictHarness, authority: () => left });
  await eventually(() => conflict.client.getHuddleState(conversationId).recovery?.state === "conflict");
  assert.notEqual(await conflictHarness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  assert.equal(commandRequests(conflict).length, 0);
  conflict.client.close();
});

test("ambiguous outcomes retain with capped retry while terminal permission removes", async () => {
  const harness = createStorageHarness();
  await seedSnapshot(harness, storageIdentity(), inactive);
  await seedIntent(harness, storageIdentity(), {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "transient-start",
  });
  const delays = [];
  const fixture = await createFixture({
    harness,
    authority: () => inactive,
    command: () => response(200, { malformed: true }),
    recovery: {
      multiplier: 3,
      wait: async (delay, signal) => {
        delays.push(delay);
        if (delays.length < 3) return;
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    },
  });
  await eventually(() => delays.length === 3);
  assert.deepEqual(delays, [2, 4, 4]);
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  fixture.client.close();

  const terminalHarness = createStorageHarness();
  await seedSnapshot(terminalHarness, storageIdentity(), inactive);
  await seedIntent(terminalHarness, storageIdentity(), {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "terminal-start",
  });
  const terminal = await createFixture({
    harness: terminalHarness,
    authority: () => inactive,
    command: () => response(403, {
      error: { code: "CHAT_PERMISSION_DENIED", message: "denied" },
    }),
  });
  await eventually(async () => await terminalHarness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ) === null);
  assert.equal(commandRequests(terminal).length, 1);
  terminal.client.close();
});

test("visibility and realtime-online gates pause recovery until both are ready", async () => {
  const harness = createStorageHarness();
  await seedSnapshot(harness, storageIdentity(), inactive);
  await seedIntent(harness, storageIdentity(), {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "gated-start",
  });
  const host = createHostActivity(false);
  const listeners = { online: new Set(), offline: new Set() };
  let online = false;
  const sockets = [];
  const realtime = {
    network: {
      isOnline: () => online,
      addEventListener(type, listener) { listeners[type].add(listener); },
      removeEventListener(type, listener) { listeners[type].delete(listener); },
    },
    retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
    webSocketFactory: () => {
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
            tenantId,
            actorStreamId: `user:${actorId}`,
            deviceId: storageIdentity().deviceId,
            sessionId: "realtime-gated",
          }) });
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
  const fixture = await createFixture({ harness, authority: () => inactive, host, realtime });
  assert.equal(commandRequests(fixture).length, 0);
  online = true;
  for (const listener of [...listeners.online]) listener();
  await eventually(() => sockets.length === 1);
  sockets[0].accept();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandRequests(fixture).length, 0, "hidden host must remain gated");
  host.setActive(true);
  await eventually(() => commandRequests(fixture).length === 1);
  fixture.client.close();
});

test("validation quarantine preserves a concurrent valid huddle replacement", async () => {
  const harness = createAtomicStorageHarness();
  const identity = storageIdentity();
  const kind = ApplicationChatStorageRecordKind.queuedHuddleCommandIntents;
  const key = rowKey(identity, kind);
  const replacementRequest = {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "replacement-after-quarantine",
  };
  await seedSnapshot(harness, identity, inactive);
  const siblingSnapshotKey = rowKey(
    identity,
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  const siblingSnapshot = harness.rows.get(siblingSnapshotKey);
  await seedIntent(harness, identity, replacementRequest);
  const validReplacement = harness.rows.get(key);
  assert.equal(typeof validReplacement, "string");
  assert.equal(validReplacement.includes(accessToken), false);
  assert.equal(validReplacement.includes(descriptor), false);

  const malformed = "{MALFORMED_HUDDLE_RECORD_MUST_BE_REDACTED";
  harness.rows.set(key, malformed);
  harness.replaceAfterNextConditionalRemoval(kind, validReplacement);
  const initial = await createFixture({
    harness,
    host: createHostActivity(false),
  });
  await eventually(() => initial.diagnostics.some(
    ({ code }) => code === "huddle_intents_rejected",
  ));

  assert.deepEqual(
    initial.diagnostics,
    [{
      code: "huddle_intents_rejected",
      message: "The stored huddle-command intents were rejected and quarantined.",
    }],
  );
  assert.ok(harness.calls.some((call) =>
    call.operation === "compareExchange" &&
    call.kind === kind &&
    call.expected === malformed &&
    call.replacement === null &&
    call.success === true));
  assert.equal(harness.calls.some((call) =>
    call.operation === "remove" && call.kind === kind), false);
  assert.equal(harness.rows.get(key), validReplacement);
  assert.equal(harness.rows.get(siblingSnapshotKey), siblingSnapshot);
  assert.equal(JSON.stringify([...harness.rows.values()]).includes(accessToken), false);
  assert.equal(JSON.stringify([...harness.rows.values()]).includes(descriptor), false);
  assert.equal(JSON.stringify(initial.diagnostics).includes(accessToken), false);
  assert.equal(JSON.stringify(initial.diagnostics).includes(descriptor), false);
  assert.equal(JSON.stringify(initial.diagnostics).includes(malformed), false);
  initial.client.close();

  const recovered = await createFixture({ harness });
  await eventually(() => commandRequests(recovered).length === 1);
  assert.deepEqual(commandRequests(recovered)[0].body, replacementRequest);
  await eventually(async () => await harness.storage.read(identity, kind) === null);
  assert.equal(JSON.stringify([...harness.rows.values()]).includes(accessToken), false);
  assert.equal(JSON.stringify([...harness.rows.values()]).includes(descriptor), false);
  assert.equal(JSON.stringify(recovered.diagnostics).includes(accessToken), false);
  assert.equal(JSON.stringify(recovered.diagnostics).includes(descriptor), false);
  recovered.client.close();
});

test("corrupt rows quarantine and close-after-dispatch retains ambiguity", async () => {
  const corruptHarness = createStorageHarness();
  corruptHarness.rows.set(
    rowKey(storageIdentity(), ApplicationChatStorageRecordKind.queuedHuddleCommandIntents),
    "{not-json",
  );
  const corrupt = await createFixture({ harness: corruptHarness });
  await eventually(() => corrupt.diagnostics.some(({ code }) => code === "huddle_intents_rejected"));
  assert.equal(corruptHarness.rows.has(rowKey(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  )), false);
  corrupt.client.close();

  const cache = createNormalizedChatCache(cacheIdentity());
  cache.setHuddleState(inactive);
  const gate = deferred();
  const ambiguous = await createFixture({ cache, command: () => gate.promise });
  const pending = ambiguous.client.startHuddle(conversationId);
  await eventually(() => commandRequests(ambiguous).length === 1);
  ambiguous.client.close();
  const closed = await pending;
  assert.equal(closed.status, "error");
  assert.equal(closed.code, "closed");
  assert.notEqual(await ambiguous.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);

  const cancellationHarness = createStorageHarness();
  await seedSnapshot(cancellationHarness, storageIdentity(), inactive);
  await seedIntent(cancellationHarness, storageIdentity(), {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "cancelled-recovery",
  });
  const cancellationHost = createHostActivity(true);
  const cancellationGate = deferred();
  const cancellation = await createFixture({
    harness: cancellationHarness,
    authority: () => inactive,
    host: cancellationHost,
    command: () => cancellationGate.promise,
  });
  await eventually(() => commandRequests(cancellation).length === 1);
  cancellationHost.setActive(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(await cancellationHarness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  cancellation.client.close();
});

test("a delayed old-identity read cannot project, dispatch, or remove the new identity row", async () => {
  const harness = createStorageHarness();
  const oldIdentity = storageIdentity("old-user");
  const newIdentity = storageIdentity("new-user");
  await seedSnapshot(harness, oldIdentity, inactive);
  await seedSnapshot(harness, newIdentity, inactive);
  await seedIntent(harness, oldIdentity, {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "old-huddle-key",
  });
  await seedIntent(harness, newIdentity, {
    operation: "start_huddle",
    conversationId,
    idempotencyKey: "new-huddle-key",
  });
  const gate = deferred();
  harness.gateRead(
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    oldIdentity.userId,
    gate,
  );
  const identityRef = { current: oldIdentity };
  const fixture = await createFixture({ harness, identityRef, start: false, authority: () => inactive });
  const oldStart = fixture.client.start();
  await eventually(() => harness.calls.some(({ operation, kind, identity }) =>
    operation === "read" &&
    kind === ApplicationChatStorageRecordKind.queuedHuddleCommandIntents &&
    identity.userId === oldIdentity.userId));
  fixture.client.close();
  identityRef.current = newIdentity;
  const newStart = fixture.client.start();
  gate.resolve();
  assert.equal((await oldStart).state, "idle");
  assert.equal((await newStart).state, "ready");
  await eventually(() => commandRequests(fixture).length === 1);
  assert.equal(commandRequests(fixture)[0].body.idempotencyKey, "new-huddle-key");
  assert.equal(commandRequests(fixture)[0].identity.userId, newIdentity.userId);
  assert.notEqual(await harness.storage.read(
    oldIdentity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  fixture.client.close();
});


test("event-first live joins retain the HTTP credential instead of requiring another join", async () => {
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.setHuddleState(starting);
  const gate = deferred();
  const fixture = await createFixture({ cache, command: () => gate.promise });
  const pending = fixture.client.joinHuddle(conversationId);
  await eventually(() => commandRequests(fixture).length === 1);
  cache.setHuddleState(active);
  gate.resolve(response(200, commandResult(commandRequests(fixture)[0].body, active)));
  assert.equal((await pending).status, "success");
  assert.equal(fixture.client.getHuddleMediaJoinDescriptor(conversationId).descriptor, descriptor);
  fixture.client.close();
});
