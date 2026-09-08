import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatStorage,
  createApplicationChatNormalizedSnapshotRecord,
  createChatClient,
  createNormalizedChatCache,
  encodeApplicationChatStorageRecord,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";
import { typingStartEvent } from "./fixtures/ephemeral-signals.mjs";

const storageIdentity = (userId = "user-1", deviceId = "device-1") => ({
  tenantId: "tenant-1",
  userId,
  deviceId,
});
const cacheIdentity = (userId = "user-1", sessionId = "session-1") => ({
  tenantId: "tenant-1",
  userId,
  sessionId,
});
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { realtime: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const response = () => ({ ok: true, status: 200, async json() { return metadata; } });
const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};
const recordKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;

const createStorageHarness = (behavior = {}, { atomic = false } = {}) => {
  const rows = new Map();
  const reads = [];
  const replacements = [];
  const removals = [];
  const exchanges = [];
  const adapter = {
    async read(identity, kind) {
      reads.push({ identity, kind });
      if (behavior.read) return behavior.read(identity, kind, rows);
      return rows.get(recordKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      replacements.push({ identity, kind, encoded });
      if (behavior.replace) await behavior.replace(identity, kind, encoded, rows);
      else rows.set(recordKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      removals.push({ identity, kind });
      if (behavior.remove) await behavior.remove(identity, kind, rows);
      else rows.delete(recordKey(identity, kind));
    },
    async clearForLogout(identity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(recordKey(identity, kind));
      }
    },
  };
  if (atomic) {
    adapter.compareExchange = async (identity, kind, expected, replacement) => {
      exchanges.push({ identity, kind, expected, replacement });
      if (behavior.compareExchange) {
        return behavior.compareExchange(identity, kind, expected, replacement, rows);
      }
      const key = recordKey(identity, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    };
  }
  return {
    rows,
    reads,
    replacements,
    removals,
    exchanges,
    storage: createApplicationChatStorage(adapter),
  };
};

const makeClient = ({ cache, identity, storage, diagnostics = [], ...options }) =>
  createChatClient({
    endpoint: "https://provider-endpoint-secret.example/api/chat",
    getAccessToken: () => "access-token-secret",
    fetch: async () => response(),
    cache,
    normalizedCachePersistence: {
      storage,
      resolveIdentity: () => identity,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    ...options,
  });

test("reload hydrates the newest validated checkpoint and excludes transient material", async () => {
  const harness = createStorageHarness();
  const identity = storageIdentity();
  const cache = createNormalizedChatCache(cacheIdentity());
  const client = makeClient({ cache, identity, storage: harness.storage });
  assert.equal((await client.start()).state, "ready");

  cache.insertOptimisticMessage({
    id: "optimistic-message",
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    author: { type: "user", userId: "user-1" },
    sequence: 1,
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    revision: { revision: 1 },
    content: { format: "plain", text: "optimistic-content-secret" },
    isThreadRoot: false,
    reactions: [],
    attachmentMetadata: [],
    delivery: {
      state: "sending",
      clientMessageId: "optimistic-client-secret",
      idempotencyKey: "optimistic-idempotency-secret",
      retryable: false,
      attempt: 1,
    },
  });
  cache.failOptimisticMessage("optimistic-client-secret", "transport", true);
  cache.applyEphemeralSignal(typingStartEvent, Date.parse("2026-08-25T20:00:01.000Z"));
  cache.setHuddleState({
    status: "inactive",
    conversationId: "canonical-huddle-conversation",
  });
  cache.setRealtimeCursor({ eventId: "event-2" });

  await eventually(() =>
    harness.replacements.at(-1)?.encoded.includes("event-2") === true);
  const latest = harness.replacements.at(-1).encoded;
  assert.equal(latest.includes("event-2"), true);
  for (const excluded of [
    "access-token-secret",
    "provider-endpoint-secret",
    "event-typing-start",
    "optimistic-content-secret",
    "optimistic-client-secret",
    "optimistic-idempotency-secret",
  ]) assert.equal(latest.includes(excluded), false, excluded);

  client.close();
  const reloaded = makeClient({
    cache: createNormalizedChatCache(),
    identity,
    storage: harness.storage,
  });
  assert.equal((await reloaded.start()).state, "ready");
  assert.deepEqual(reloaded.cache.getState().identity, cacheIdentity());
  assert.equal(reloaded.cache.getState().metadata.realtimeCursor.eventId, "event-2");
  assert.deepEqual(reloaded.cache.getState().ephemeral, { typing: {}, presence: {} });
  assert.deepEqual(reloaded.cache.getState().huddles, {
    "canonical-huddle-conversation": {
      status: "inactive",
      conversationId: "canonical-huddle-conversation",
    },
  });
  assert.equal(reloaded.cache.getState().entities.messages["optimistic-message"], undefined);
  reloaded.close();
});

test("invalid records quarantine only the exact snapshot key", async () => {
  const harness = createStorageHarness();
  const identity = storageIdentity();
  const ownKey = recordKey(identity, ApplicationChatStorageRecordKind.normalizedSnapshot);
  const siblingKey = recordKey(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents);
  const siblingRecord = JSON.stringify({
    schemaVersion: 1,
    kind: ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    identity,
    payload: { intents: [] },
  });
  harness.rows.set(ownKey, "malformed-record-secret");
  harness.rows.set(siblingKey, siblingRecord);
  const diagnostics = [];
  const client = makeClient({
    cache: createNormalizedChatCache(),
    identity,
    storage: harness.storage,
    diagnostics,
  });
  assert.equal((await client.start()).state, "ready");
  assert.equal(harness.rows.has(ownKey), false);
  assert.equal(harness.rows.get(siblingKey), siblingRecord);
  assert.deepEqual(harness.removals, [
    { identity, kind: ApplicationChatStorageRecordKind.normalizedSnapshot },
  ]);
  assert.equal(diagnostics[0].code, "snapshot_rejected");
  assert.equal(JSON.stringify(diagnostics).includes("malformed-record-secret"), false);
  client.close();
});

test("read, replace, remove, resolver, and diagnostic observer failures fail open", async (t) => {
  await t.test("read", async () => {
    const diagnostics = [];
    const harness = createStorageHarness({
      read: async () => { throw new Error("read-thrown-secret"); },
    });
    const client = makeClient({
      cache: createNormalizedChatCache(cacheIdentity()),
      identity: storageIdentity(),
      storage: harness.storage,
      diagnostics,
    });
    assert.equal((await client.start()).state, "ready");
    assert.equal(diagnostics[0].code, "snapshot_read_failed");
    assert.equal(JSON.stringify(diagnostics).includes("read-thrown-secret"), false);
    client.close();
  });

  await t.test("replace", async () => {
    const diagnostics = [];
    const harness = createStorageHarness({
      replace: async () => { throw new Error("write-thrown-secret"); },
    });
    const client = makeClient({
      cache: createNormalizedChatCache(cacheIdentity()),
      identity: storageIdentity(),
      storage: harness.storage,
      diagnostics,
    });
    assert.equal((await client.start()).state, "ready");
    await eventually(() => diagnostics.some(({ code }) => code === "snapshot_checkpoint_failed"));
    assert.equal(JSON.stringify(diagnostics).includes("write-thrown-secret"), false);
    client.close();
  });

  await t.test("remove and observer", async () => {
    const harness = createStorageHarness({
      remove: async () => { throw new Error("remove-thrown-secret"); },
    });
    harness.rows.set(
      recordKey(storageIdentity(), ApplicationChatStorageRecordKind.normalizedSnapshot),
      "invalid",
    );
    const client = createChatClient({
      endpoint: "/api/chat",
      getAccessToken: () => "token",
      fetch: async () => response(),
      normalizedCachePersistence: {
        storage: harness.storage,
        resolveIdentity: () => storageIdentity(),
        onDiagnostic() { throw new Error("observer-thrown-secret"); },
      },
    });
    assert.equal((await client.start()).state, "ready");
    assert.equal(harness.removals.length, 1);
    client.close();
  });

  await t.test("resolver", async () => {
    const diagnostics = [];
    const harness = createStorageHarness();
    const client = makeClient({
      cache: createNormalizedChatCache(),
      identity: storageIdentity(),
      storage: harness.storage,
      diagnostics,
      normalizedCachePersistence: {
        storage: harness.storage,
        resolveIdentity: async () => { throw new Error("identity-thrown-secret"); },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    });
    assert.equal((await client.start()).state, "ready");
    assert.equal(diagnostics[0].code, "identity_resolution_failed");
    assert.equal(JSON.stringify(diagnostics).includes("identity-thrown-secret"), false);
    client.close();
  });
});

test("delayed reads cannot hydrate a newer identity generation", async () => {
  const oldRead = deferred();
  const oldIdentity = storageIdentity("user-old", "device-old");
  const newIdentity = storageIdentity("user-new", "device-new");
  const oldCache = createNormalizedChatCache(cacheIdentity("user-old", "session-old"));
  oldCache.setRealtimeCursor({ eventId: "old-event" });
  const newCache = createNormalizedChatCache(cacheIdentity("user-new", "session-new"));
  newCache.setRealtimeCursor({ eventId: "new-event" });
  let currentIdentity = oldIdentity;
  const harness = createStorageHarness({
    read: async (identity) => identity.userId === "user-old"
      ? oldRead.promise
      : JSON.stringify({
          schemaVersion: 1,
          kind: "normalized_snapshot",
          identity: newIdentity,
          payload: { snapshot: newCache.getState() },
        }),
  });
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch: async () => response(),
    cache: createNormalizedChatCache(),
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => currentIdentity,
    },
  });
  const firstStart = client.start();
  await eventually(() => harness.reads.length === 1);
  client.close();
  currentIdentity = newIdentity;
  assert.equal((await client.start()).state, "ready");
  assert.equal(client.cache.getState().metadata.realtimeCursor.eventId, "new-event");
  oldRead.resolve(JSON.stringify({
    schemaVersion: 1,
    kind: "normalized_snapshot",
    identity: oldIdentity,
    payload: { snapshot: oldCache.getState() },
  }));
  assert.equal((await firstStart).state, "idle");
  assert.equal(client.cache.getState().identity.userId, "user-new");
  assert.equal(client.cache.getState().metadata.realtimeCursor.eventId, "new-event");
  client.close();
});

test("serialized checkpoints keep a delayed prior close/start write older", async () => {
  const firstWrite = deferred();
  const completed = [];
  let writeCount = 0;
  const harness = createStorageHarness({
    replace: async (_identity, _kind, encoded, rows) => {
      writeCount += 1;
      if (writeCount === 1) await firstWrite.promise;
      rows.set(recordKey(storageIdentity(), ApplicationChatStorageRecordKind.normalizedSnapshot), encoded);
      completed.push(encoded);
    },
  });
  const cache = createNormalizedChatCache(cacheIdentity());
  const client = makeClient({ cache, identity: storageIdentity(), storage: harness.storage });
  assert.equal((await client.start()).state, "ready");
  await eventually(() => harness.replacements.length === 1);
  cache.setRealtimeCursor({ eventId: "old-generation-event" });
  client.close();
  cache.setRealtimeCursor({ eventId: "new-generation-event" });
  const restart = client.start();
  firstWrite.resolve();
  assert.equal((await restart).state, "ready");
  await eventually(() => completed.some((encoded) => encoded.includes("new-generation-event")));
  assert.equal(completed.at(-1).includes("new-generation-event"), true);
  client.close();
});

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
      if (!next) break;
      this.timers.delete(next[0]);
      this.current = next[1].at;
      next[1].callback();
    }
    this.current = target;
  }
}

class FakeChannelHub {
  channels = new Set();
  messages = [];
  factory = (name) => {
    const listeners = new Set();
    const channel = {
      name,
      closed: false,
      postMessage: (message) => {
        this.messages.push(structuredClone(message));
        for (const peer of [...this.channels]) {
          if (peer !== channel && !peer.closed) {
            for (const listener of peer.listeners) listener({ data: structuredClone(message) });
          }
        }
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => { channel.closed = true; this.channels.delete(channel); },
      listeners,
    };
    this.channels.add(channel);
    return channel;
  };
  injectTo(name, message) {
    const channel = [...this.channels].find((candidate) => candidate.name === name);
    for (const listener of channel?.listeners ?? []) {
      listener({ data: structuredClone(message) });
    }
  }
}

test("cross-tab compare-exchange failures fail open with stable diagnostics", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const diagnostics = [];
  const harness = createStorageHarness(
    {
      compareExchange: async () => {
        throw new Error("compare-exchange-thrown-secret");
      },
    },
    { atomic: true },
  );
  const client = makeClient({
    cache: createNormalizedChatCache(cacheIdentity()),
    identity: storageIdentity(),
    storage: harness.storage,
    diagnostics,
    crossTab: {
      sessionFingerprint: "trusted-session-scope",
      tabId: "tab-a",
      channelFactory: () => hub.factory("tab-a"),
      clock,
      timing: {
        electionDelayMs: 10,
        heartbeatIntervalMs: 20,
        leaseDurationMs: 60,
        commandClaimDelayMs: 5,
        commandClaimLeaseMs: 50,
      },
    },
  });

  assert.equal((await client.start()).state, "ready");
  clock.tick(10);
  await eventually(() => diagnostics.length === 1);
  assert.equal(harness.replacements.length, 0);
  assert.equal(harness.removals.length, 0);
  assert.deepEqual(diagnostics, [{
    code: "snapshot_checkpoint_failed",
    message: "The normalized cache checkpoint could not be stored.",
  }]);
  assert.equal(JSON.stringify(diagnostics).includes("compare-exchange-thrown-secret"), false);
  client.close();
});

test("a follower checkpoints only after accepting leader canonical hydration", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leaderHarness = createStorageHarness({}, { atomic: true });
  const followerHarness = createStorageHarness({}, { atomic: true });
  const leaderCache = createNormalizedChatCache(cacheIdentity());
  const followerCache = createNormalizedChatCache(cacheIdentity());
  leaderCache.setRealtimeCursor({ eventId: "leader-canonical-event" });
  followerCache.setRealtimeCursor({ eventId: "follower-stale-event" });
  const crossTab = (tabId) => ({
    sessionFingerprint: "trusted-session-scope",
    tabId,
    channelFactory: () => hub.factory(tabId),
    clock,
    timing: {
      electionDelayMs: 10,
      heartbeatIntervalMs: 20,
      leaseDurationMs: 60,
      commandClaimDelayMs: 5,
      commandClaimLeaseMs: 50,
    },
  });
  const leader = makeClient({
    cache: leaderCache,
    identity: storageIdentity(),
    storage: leaderHarness.storage,
    crossTab: crossTab("tab-a"),
  });
  const follower = makeClient({
    cache: followerCache,
    identity: storageIdentity(),
    storage: followerHarness.storage,
    crossTab: crossTab("tab-b"),
  });
  await Promise.all([leader.start(), follower.start()]);
  assert.equal(followerHarness.exchanges.length, 0);
  clock.tick(10);
  await eventually(() => followerHarness.exchanges.length > 0);
  assert.equal(follower.coordination.role, "follower");
  assert.equal(
    followerHarness.exchanges.every(({ replacement }) =>
      replacement.includes("leader-canonical-event") &&
      !replacement.includes("follower-stale-event")),
    true,
  );
  leader.close();
  follower.close();
});

test("queued leader checkpoints are invalidated across follower role changes", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const firstWrite = deferred();
  const completed = [];
  let writeCount = 0;
  const harness = createStorageHarness(
    {
      compareExchange: async (identity, kind, expected, replacement, rows) => {
        writeCount += 1;
        if (writeCount === 1) await firstWrite.promise;
        const key = recordKey(identity, kind);
        if ((rows.get(key) ?? null) !== expected) return false;
        if (replacement === null) rows.delete(key);
        else rows.set(key, replacement);
        completed.push(replacement);
        return true;
      },
    },
    { atomic: true },
  );
  const cache = createNormalizedChatCache(cacheIdentity());
  const client = makeClient({
    cache,
    identity: storageIdentity(),
    storage: harness.storage,
    crossTab: {
      sessionFingerprint: "trusted-session-scope",
      tabId: "tab-b",
      channelFactory: () => hub.factory("tab-b"),
      clock,
      timing: {
        electionDelayMs: 10,
        heartbeatIntervalMs: 20,
        leaseDurationMs: 60,
        commandClaimDelayMs: 5,
        commandClaimLeaseMs: 50,
      },
    },
  });

  assert.equal((await client.start()).state, "ready");
  clock.tick(10);
  assert.equal(client.coordination.role, "leader");
  await eventually(() => harness.exchanges.length === 1);

  cache.setRealtimeCursor({ eventId: "stale-leader-checkpoint" });
  const heartbeat = hub.messages.findLast((message) => message.kind === "heartbeat");
  const replacementLeaderHeartbeat = {
    ...heartbeat,
    senderId: "tab-a",
    leaderId: "tab-a",
    term: heartbeat.term + 1,
    payload: { leaseUntil: clock.current + 60 },
  };
  hub.injectTo("tab-b", replacementLeaderHeartbeat);
  assert.equal(client.coordination.role, "follower");

  cache.setRealtimeCursor({ eventId: "fresh-leader-checkpoint" });
  hub.injectTo("tab-b", {
    ...replacementLeaderHeartbeat,
    kind: "leader-close",
    payload: {},
  });
  clock.tick(10);
  assert.equal(client.coordination.role, "leader");

  firstWrite.resolve();
  await eventually(() =>
    completed.some((encoded) => encoded.includes("fresh-leader-checkpoint")));
  assert.equal(harness.exchanges.length, 2);
  assert.equal(
    harness.exchanges.some(({ replacement }) =>
      replacement.includes("stale-leader-checkpoint")),
    false,
  );
  assert.equal(completed.at(-1).includes("fresh-leader-checkpoint"), true);
  client.close();
});

test("a delayed cross-tab checkpoint cannot replace a newer checkpoint", async () => {
  const identity = storageIdentity();
  const kind = ApplicationChatStorageRecordKind.normalizedSnapshot;
  const key = recordKey(identity, kind);
  const baselineCache = createNormalizedChatCache(cacheIdentity());
  baselineCache.setRealtimeCursor({ eventId: "shared-baseline-event" });
  const baseline = encodeApplicationChatStorageRecord(
    createApplicationChatNormalizedSnapshotRecord(identity, baselineCache.getState()),
  );
  const tabAEnteredExchange = deferred();
  const releaseTabA = deferred();
  const harness = createStorageHarness(
    {
      compareExchange: async (
        candidateIdentity,
        candidateKind,
        expected,
        replacement,
        rows,
      ) => {
        if (replacement?.includes("tab-a-stale-event")) {
          tabAEnteredExchange.resolve();
          await releaseTabA.promise;
        }
        const candidateKey = recordKey(candidateIdentity, candidateKind);
        if ((rows.get(candidateKey) ?? null) !== expected) return false;
        if (replacement === null) rows.delete(candidateKey);
        else rows.set(candidateKey, replacement);
        return true;
      },
    },
    { atomic: true },
  );
  harness.rows.set(key, baseline);

  const tabAClock = new FakeClock();
  const tabBClock = new FakeClock();
  const isolatedCrossTab = (tabId, clock) => {
    const hub = new FakeChannelHub();
    return {
      sessionFingerprint: "trusted-session-scope",
      tabId,
      channelFactory: () => hub.factory(tabId),
      clock,
      timing: {
        electionDelayMs: 10,
        heartbeatIntervalMs: 20,
        leaseDurationMs: 60,
        commandClaimDelayMs: 5,
        commandClaimLeaseMs: 50,
      },
    };
  };
  const tabADiagnostics = [];
  const tabACache = createNormalizedChatCache();
  const tabBCache = createNormalizedChatCache();
  const tabA = makeClient({
    cache: tabACache,
    identity,
    storage: harness.storage,
    diagnostics: tabADiagnostics,
    crossTab: isolatedCrossTab("tab-a", tabAClock),
  });
  const tabB = makeClient({
    cache: tabBCache,
    identity,
    storage: harness.storage,
    crossTab: isolatedCrossTab("tab-b", tabBClock),
  });

  await Promise.all([tabA.start(), tabB.start()]);
  tabAClock.tick(10);
  tabBClock.tick(10);
  assert.equal(tabA.coordination.role, "leader");
  assert.equal(tabB.coordination.role, "leader");
  await eventually(() => harness.exchanges.filter(({ kind: callKind }) =>
    callKind === kind).length === 2);
  harness.exchanges.length = 0;

  tabACache.setRealtimeCursor({ eventId: "tab-a-stale-event" });
  await tabAEnteredExchange.promise;
  tabBCache.setRealtimeCursor({ eventId: "tab-b-newer-event" });
  await eventually(() => harness.rows.get(key)?.includes("tab-b-newer-event") === true);
  releaseTabA.resolve();
  await eventually(() => tabADiagnostics.length === 1);

  const normalizedExchanges = harness.exchanges.filter(({ kind: callKind }) =>
    callKind === kind);
  assert.equal(normalizedExchanges.length, 2);
  assert.deepEqual(
    normalizedExchanges.map(({ identity: callIdentity, expected }) => ({
      identity: callIdentity,
      expected,
    })),
    [
      { identity, expected: baseline },
      { identity, expected: baseline },
    ],
  );
  assert.equal(harness.replacements.length, 0);
  assert.equal(harness.removals.length, 0);
  assert.equal(harness.rows.get(key).includes("tab-b-newer-event"), true);
  assert.equal(harness.rows.get(key).includes("tab-a-stale-event"), false);
  assert.deepEqual(tabADiagnostics, [{
    code: "snapshot_checkpoint_failed",
    message: "The normalized cache checkpoint could not be stored.",
  }]);
  assert.equal(
    JSON.stringify(tabADiagnostics).includes("tab-a-stale-event"),
    false,
  );

  tabA.close();
  tabB.close();
});
