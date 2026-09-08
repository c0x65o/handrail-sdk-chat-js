import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-saved-atomic";
const userId = "user-saved-atomic";
const deviceId = "device-saved-atomic";
const conversationId = "conversation-saved-atomic";
const firstMessageId = "message-saved-atomic-a";
const secondMessageId = "message-saved-atomic-b";
const now = "2038-01-02T03:04:05.000Z";
const storageIdentity = { tenantId, userId, deviceId };
const cacheIdentity = (label) => ({
  tenantId,
  userId,
  sessionId: `session-${label}`,
});
const storageKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const metadata = () => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
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
const pendingForever = new Promise(() => {});
const retainedWait = (_delayMs, signal) => new Promise((_resolve, reject) => {
  if (signal.aborted) {
    reject(new Error("aborted"));
    return;
  }
  signal.addEventListener("abort", () => reject(new Error("aborted")), {
    once: true,
  });
});
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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

  factory = (behavior = {}) => (name) => {
    const listeners = new Set();
    const channel = {
      name,
      closed: false,
      postMessage: (message) => {
        if (channel.closed) return;
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        if (behavior.postThrows) throw new Error("posting failed");
        for (const peer of [...this.channels]) {
          if (peer === channel || peer.closed || peer.name !== name) continue;
          for (const listener of peer.listeners) {
            listener({ data: structuredClone(cloned) });
          }
        }
      },
      listeners,
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
}

const crossTabTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

const detail = () => ({
  kind: "conversation_detail",
  conversation: {
    id: conversationId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: "Atomic saved messages",
    createdAt: now,
    updatedAt: now,
    latestSequence: 2,
    activityAt: now,
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: "member",
      state: "active",
      joinedAt: now,
      updatedAt: now,
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: 0,
      updatedAt: now,
    },
    memberUserIds: [userId],
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: now,
    },
  },
  _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
});

const timelineMessage = (id, sequence) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: "user-author" },
  sequence,
  createdAt: now,
  updatedAt: now,
  revision: { revision: 1 },
  content: { format: "plain", text: `message ${sequence}` },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
});

const seedCache = (label) => {
  const cache = createNormalizedChatCache(cacheIdentity(label));
  cache.hydrateConversationDetail(detail());
  cache.hydrateMessageTimeline({
    conversationId,
    messages: [
      timelineMessage(firstMessageId, 1),
      timelineMessage(secondMessageId, 2),
    ],
    pagination: { older: { available: false }, newer: { available: false } },
    replay: { resumeFrom: { eventId: `timeline-${label}` } },
  });
  return cache;
};

const savedPage = () => ({
  kind: "saved_message_list",
  privacy: "actor_private",
  items: [],
  page: { nextCursor: null },
});

const savedResult = (request) => ({
  operation: "set_saved_message",
  intent: request.intent,
  reconciliationStatus: "applied",
  messageId: request.messageId,
  expectedSavedMessageRevision: request.expectedSavedMessageRevision,
  idempotencyKey: request.idempotencyKey,
  savedMessageRevision: request.expectedSavedMessageRevision + 1,
  savedMessage: {
    messageId: request.messageId,
    isSaved: request.intent === "save",
    ...(request.intent === "save" && request.privateNote !== undefined
      ? { privateNote: request.privateNote }
      : {}),
  },
});

function createSharedAtomicHarness() {
  const rows = new Map();
  const calls = [];
  let race;
  const createStorage = () => createApplicationChatStorage(adapter);
  const adapter = {
    async read(identity, kind) {
      calls.push({ operation: "read", identity: { ...identity }, kind });
      return rows.get(storageKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity: { ...identity }, kind, encoded });
      rows.set(storageKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity: { ...identity }, kind });
      rows.delete(storageKey(identity, kind));
    },
    async compareExchange(identity, kind, expected, replacement) {
      calls.push({
        operation: "compareExchange",
        identity: { ...identity },
        kind,
        expected,
        replacement,
      });
      if (
        race !== undefined &&
        kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents &&
        storageKey(identity, kind) === storageKey(storageIdentity, kind) &&
        race.arrivals < 2
      ) {
        const ticket = ++race.arrivals;
        if (ticket === 2) race.barrier.resolve();
        await race.barrier.promise;
        if (ticket === 1) await new Promise((resolve) => setImmediate(resolve));
      }
      const key = storageKey(identity, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    },
    async clearForLogout(identity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(storageKey(identity, kind));
      }
    },
  };

  return {
    calls,
    createStorage,
    armRace() {
      race = { arrivals: 0, barrier: deferred(), initialCallCount: calls.length };
    },
    raceArrivals: () => race?.arrivals ?? 0,
    raceCalls: () => calls.slice(race?.initialCallCount ?? calls.length),
    readRecord() {
      return createStorage().read(
        storageIdentity,
        ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
      );
    },
  };
}

async function createFixture({
  harness,
  label,
  clock,
  keys,
  command = () => pendingForever,
  authority = () => response(200, savedPage()),
  crossTab,
}) {
  const requests = [];
  const diagnostics = [];
  let keyIndex = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache: seedCache(label),
    commands: {
      retry: { maxAttempts: 1, maxAuthRefreshes: 0 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    savedMessages: {
      generateIdempotencyKey: () => keys[keyIndex++] ?? `${label}-saved-${keyIndex}`,
      now: () => clock,
      retainedRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 2,
        wait: retainedWait,
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
      if (init.method === "GET") return authority();
      const body = JSON.parse(init.body);
      requests.push(body);
      return command(body, requests.length);
    },
    normalizedCachePersistence: {
      storage: harness.createStorage(),
      resolveIdentity: () => storageIdentity,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    ...(crossTab === undefined ? {} : {
      crossTab: {
        sessionFingerprint: crossTab.fingerprint ??
          `${tenantId}:${userId}:${deviceId}`,
        tabId: label,
        clock: crossTab.clock,
        timing: crossTabTiming,
        channelFactory: crossTab.hub.factory({ postThrows: crossTab.postThrows }),
      },
    }),
  });
  assert.equal((await client.start()).state, "ready");
  return { client, diagnostics, requests };
}

test("contended saved-message writes for different messages both survive", async () => {
  const harness = createSharedAtomicHarness();
  const hub = new FakeChannelHub();
  const coordinationClock = new FakeClock();
  const firstSecret = "distinct-private-note-a";
  const secondSecret = "distinct-private-note-b";
  const first = await createFixture({
    harness,
    label: "tab-a",
    clock: 1_000,
    keys: ["first-saved-key"],
    crossTab: { hub, clock: coordinationClock },
  });
  const second = await createFixture({
    harness,
    label: "tab-b",
    clock: 2_000,
    keys: ["second-saved-key"],
    crossTab: { hub, clock: coordinationClock },
  });
  coordinationClock.tick(crossTabTiming.electionDelayMs);

  harness.armRace();
  const firstPending = first.client.saveMessage({
    messageId: firstMessageId,
    privateNote: firstSecret,
  });
  await eventually(() => harness.raceArrivals() === 1);
  const secondPending = second.client.saveMessage({
    messageId: secondMessageId,
    privateNote: secondSecret,
  });
  await eventually(async () => (await harness.readRecord())?.intents.length === 2);

  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.messageId,
    request.idempotencyKey,
  ]), [
    [1, secondMessageId, "second-saved-key"],
    [2, firstMessageId, "first-saved-key"],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale distinct-message proposal must retry",
  );
  assert.equal(JSON.stringify(hub.messages).includes(firstSecret), false);
  assert.equal(JSON.stringify(hub.messages).includes(secondSecret), false);
  assert.equal(JSON.stringify([...first.diagnostics, ...second.diagnostics]).includes(firstSecret), false);
  assert.equal(JSON.stringify([...first.diagnostics, ...second.diagnostics]).includes(secondSecret), false);

  first.client.close();
  second.client.close();
  await Promise.all([firstPending, secondPending]);
});

test("same-message save and unsave contention retains the later atomic commit", async () => {
  const harness = createSharedAtomicHarness();
  const hub = new FakeChannelHub();
  const coordinationClock = new FakeClock();
  const privateNote = "same-message-private-note";
  const save = await createFixture({
    harness,
    label: "save-tab",
    clock: 1_000,
    keys: ["save-later-commit-key"],
    crossTab: { hub, clock: coordinationClock },
  });
  const unsave = await createFixture({
    harness,
    label: "unsave-tab",
    clock: 2_000,
    keys: ["unsave-first-commit-key"],
    crossTab: { hub, clock: coordinationClock },
  });
  coordinationClock.tick(crossTabTiming.electionDelayMs);

  harness.armRace();
  const savePending = save.client.saveMessage({
    messageId: firstMessageId,
    privateNote,
  });
  await eventually(() => harness.raceArrivals() === 1);
  const unsavePending = unsave.client.unsaveMessage({ messageId: firstMessageId });
  await eventually(async () =>
    (await harness.readRecord())?.intents[0]?.request.idempotencyKey ===
      "save-later-commit-key");

  const committed = await harness.readRecord();
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].enqueueOrder, 1);
  assert.equal(committed.intents[0].enqueuedAt, new Date(2_000).toISOString());
  assert.equal(committed.intents[0].request.intent, "save");
  assert.equal(committed.intents[0].request.idempotencyKey, "save-later-commit-key");
  assert.equal(committed.intents[0].request.privateNote, privateNote);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale same-message proposal must retry and become the later commit",
  );
  assert.equal(JSON.stringify(hub.messages).includes(privateNote), false);
  assert.equal(JSON.stringify([...save.diagnostics, ...unsave.diagnostics]).includes(privateNote), false);

  save.client.close();
  unsave.client.close();
  await Promise.all([savePending, unsavePending]);
});

test("stale exact settlement preserves newer same-message and unrelated intents", async () => {
  const harness = createSharedAtomicHarness();
  const hub = new FakeChannelHub();
  const coordinationClock = new FakeClock();
  const settlement = deferred();
  let authorityAvailable = true;
  const authority = () => authorityAvailable
    ? response(200, savedPage())
    : response(503, { error: { code: "UNAVAILABLE", message: "later" } });
  const oldSecret = "stale-settlement-private-note";
  const unrelatedSecret = "unrelated-private-note";
  const old = await createFixture({
    harness,
    label: "old",
    clock: 1_000,
    keys: ["old-saved-key"],
    authority,
    command: (request) => request.idempotencyKey === "old-saved-key"
      ? settlement.promise
      : pendingForever,
    crossTab: {
      hub,
      clock: coordinationClock,
      postThrows: true,
    },
  });
  const newer = await createFixture({
    harness,
    label: "newer",
    clock: 2_000,
    keys: ["unrelated-saved-key", "newer-unsave-key"],
    authority,
    crossTab: {
      hub,
      clock: coordinationClock,
      postThrows: true,
    },
  });
  coordinationClock.tick(crossTabTiming.electionDelayMs);

  const oldPending = old.client.saveMessage({
    messageId: firstMessageId,
    privateNote: oldSecret,
  });
  await eventually(() => old.requests.length === 1);
  authorityAvailable = false;
  const unrelatedPending = newer.client.saveMessage({
    messageId: secondMessageId,
    privateNote: unrelatedSecret,
  });
  await eventually(async () => (await harness.readRecord())?.intents.length === 2);

  harness.armRace();
  settlement.resolve(response(200, savedResult(old.requests[0])));
  await eventually(() => harness.raceArrivals() === 1);
  const newerPending = newer.client.unsaveMessage({ messageId: firstMessageId });

  assert.equal(
    (await oldPending).status,
    "closed",
    "the concurrently superseded caller must not observe the stale result as canonical",
  );
  await eventually(async () => {
    const intents = (await harness.readRecord())?.intents ?? [];
    return intents.some(({ request }) =>
      request.messageId === firstMessageId &&
      request.idempotencyKey === "newer-unsave-key") &&
      intents.some(({ request }) =>
        request.messageId === secondMessageId &&
        request.idempotencyKey === "unrelated-saved-key");
  });
  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ request }) => [
    request.messageId,
    request.idempotencyKey,
  ]), [
    [firstMessageId, "newer-unsave-key"],
    [secondMessageId, "unrelated-saved-key"],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale settlement proposal must retry against the newer record",
  );
  assert.equal(JSON.stringify([...old.diagnostics, ...newer.diagnostics]).includes(oldSecret), false);
  assert.equal(JSON.stringify([...old.diagnostics, ...newer.diagnostics]).includes(unrelatedSecret), false);
  assert.equal(JSON.stringify(hub.messages).includes(oldSecret), false);
  assert.equal(JSON.stringify(hub.messages).includes(unrelatedSecret), false);

  old.client.close();
  newer.client.close();
  await Promise.all([unrelatedPending, newerPending]);
});
