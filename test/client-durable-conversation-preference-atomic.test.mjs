import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatQueuedConversationPreferenceIntent,
  createApplicationChatQueuedConversationPreferenceIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-preference-atomic";
const userId = "user-preference-atomic";
const deviceId = "device-preference-atomic";
const now = "2036-02-03T04:05:06.000Z";
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
  enabledFeatures: { conversation_snapshots: true },
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

const preference = (overrides = {}) => ({
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  ...overrides,
});

const detail = (conversationId) => ({
  kind: "conversation_detail",
  conversation: {
    id: conversationId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: conversationId,
    createdAt: now,
    updatedAt: now,
    latestSequence: 0,
    activityAt: now,
    unreadMentionCount: 0,
    activeMemberUserIds: [userId],
    memberUserIds: [userId],
    memberListRevision: 1,
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: "owner",
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
    currentPreference: {
      conversationId,
      userId,
      ...preference(),
      updatedAt: now,
    },
  },
  _meta: {
    ...metadata(),
    feature: { name: "conversation_snapshots", version: 1 },
  },
});

const seedCache = (label) => {
  const cache = createNormalizedChatCache(cacheIdentity(label));
  cache.hydrateConversationDetail(detail("conversation-a"));
  cache.hydrateConversationDetail(detail("conversation-b"));
  return cache;
};

const preferenceResult = (request) => ({
  operation: "update_conversation_preference",
  reconciliationStatus: "applied",
  conversationId: request.conversationId,
  expectedPreferenceRevision: request.expectedPreferenceRevision,
  idempotencyKey: request.idempotencyKey,
  requestedPreference: {
    notificationPreference: request.notificationPreference,
    isStarred: request.isStarred,
    mute: request.mute,
  },
  preferenceRevision: request.expectedPreferenceRevision + 1,
  preference: {
    notificationPreference: request.notificationPreference,
    isStarred: request.isStarred,
    mute: request.mute,
    updatedAt: now,
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
      const call = {
        operation: "compareExchange",
        identity: { ...identity },
        kind,
        expected,
        replacement,
      };
      calls.push(call);
      if (
        race !== undefined &&
        kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents &&
        storageKey(identity, kind) === storageKey(storageIdentity, kind) &&
        race.arrivals < 2
      ) {
        const ticket = ++race.arrivals;
        if (ticket === 2) race.barrier.resolve();
        await race.barrier.promise;
        // The first proposal resumes last, loses, and must be rebuilt from committed state.
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
    async readRecord(identity = storageIdentity) {
      return createStorage().read(
        identity,
        ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
      );
    },
  };
}

async function createFixture({
  harness,
  label,
  clock,
  command = () => pendingForever,
}) {
  const requests = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache: seedCache(label),
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationPreferences: {
      generateIdempotencyKey: () => `${label}-preference-key`,
      now: () => clock,
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
      if (init.method === "GET") {
        return response(200, detail(decodeURIComponent(String(url).split("/").at(-1))));
      }
      const body = JSON.parse(init.body);
      requests.push(body);
      return command(body, requests.length);
    },
    normalizedCachePersistence: {
      storage: harness.createStorage(),
      resolveIdentity: () => storageIdentity,
      retainedConversationPreferenceRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 2,
        wait: retainedWait,
      },
    },
  });
  assert.equal((await client.start()).state, "ready");
  return { client, requests };
}

const update = (client, conversationId, desiredPreference) =>
  client.updateConversationPreference({
    conversationId,
    ...desiredPreference,
  });

test("contended preferences for different conversations both survive", async () => {
  const harness = createSharedAtomicHarness();
  const first = await createFixture({ harness, label: "first", clock: 1_000 });
  const second = await createFixture({ harness, label: "second", clock: 2_000 });

  harness.armRace();
  const firstPending = update(first.client, "conversation-a", preference({ isStarred: true }));
  await eventually(() => harness.raceArrivals() === 1);
  const secondPending = update(
    second.client,
    "conversation-b",
    preference({ notificationPreference: "mentions" }),
  );
  await eventually(async () => (await harness.readRecord())?.intents.length === 2);

  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.conversationId,
    request.idempotencyKey,
    request.expectedPreferenceRevision,
  ]), [
    [1, "conversation-b", "second-preference-key", 0],
    [2, "conversation-a", "first-preference-key", 0],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale distinct-conversation proposal must retry",
  );

  first.client.close();
  second.client.close();
  await Promise.all([firstPending, secondPending]);
});

test("same-conversation contention retains the request from the later atomic commit", async () => {
  const harness = createSharedAtomicHarness();
  const laterCommit = await createFixture({
    harness,
    label: "later-commit",
    clock: 1_000,
  });
  const firstCommit = await createFixture({
    harness,
    label: "first-commit",
    clock: 2_000,
  });

  harness.armRace();
  const laterPending = update(
    laterCommit.client,
    "conversation-a",
    preference({ notificationPreference: "none", isStarred: true }),
  );
  await eventually(() => harness.raceArrivals() === 1);
  const firstPending = update(
    firstCommit.client,
    "conversation-a",
    preference({ notificationPreference: "mentions", isStarred: false }),
  );
  await eventually(async () =>
    (await harness.readRecord())?.intents[0]?.request.idempotencyKey ===
      "later-commit-preference-key");

  const committed = await harness.readRecord();
  assert.equal(committed.intents.length, 1, "the conversation lane must coalesce");
  const retained = committed.intents[0];
  assert.equal(retained.enqueueOrder, 1);
  assert.equal(retained.enqueuedAt, new Date(2_000).toISOString());
  assert.equal(retained.request.idempotencyKey, "later-commit-preference-key");
  assert.equal(retained.request.expectedPreferenceRevision, 0);
  assert.equal(retained.request.notificationPreference, "none");
  assert.equal(retained.request.isStarred, true);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale same-conversation proposal must retry",
  );

  laterCommit.client.close();
  firstCommit.client.close();
  await Promise.all([laterPending, firstPending]);
});

test("stale exact settlement preserves a newer preference intent and sibling identity", async () => {
  const harness = createSharedAtomicHarness();
  const siblingIdentity = { ...storageIdentity, deviceId: "sibling-device" };
  const siblingRequest = {
    operation: "update_conversation_preference",
    conversationId: "sibling-conversation",
    expectedPreferenceRevision: 7,
    idempotencyKey: "sibling-preference-key",
    ...preference({ isStarred: true }),
  };
  const siblingRecord = createApplicationChatQueuedConversationPreferenceIntentsRecord(
    siblingIdentity,
    [createApplicationChatQueuedConversationPreferenceIntent(siblingRequest, {
      enqueueOrder: 1,
      enqueuedAt: now,
    })],
  );
  await harness.createStorage().replace(siblingRecord);

  const settlement = deferred();
  const old = await createFixture({
    harness,
    label: "old",
    clock: 1_000,
    command: () => settlement.promise,
  });
  const newer = await createFixture({ harness, label: "newer", clock: 2_000 });
  const oldPending = update(
    old.client,
    "conversation-a",
    preference({ isStarred: true }),
  );
  await eventually(() => old.requests.length === 1);

  harness.armRace();
  settlement.resolve(response(200, preferenceResult(old.requests[0])));
  await eventually(() => harness.raceArrivals() === 1);
  const newerPending = update(
    newer.client,
    "conversation-a",
    preference({ notificationPreference: "none", isStarred: false }),
  );

  assert.equal(
    (await oldPending).status,
    "closed",
    "the concurrently superseded caller must not observe the stale result as canonical",
  );
  await eventually(async () =>
    (await harness.readRecord())?.intents[0]?.request.idempotencyKey ===
      "newer-preference-key");
  const committed = await harness.readRecord();
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].request.expectedPreferenceRevision, 0);
  assert.equal(committed.intents[0].request.notificationPreference, "none");
  assert.deepEqual(await harness.readRecord(siblingIdentity), siblingRecord);

  const atomicCalls = harness.raceCalls().filter(
    ({ operation }) => operation === "compareExchange",
  );
  assert.ok(atomicCalls.length >= 3, "the stale settlement proposal must retry");
  assert.ok(atomicCalls.every(({ identity, kind }) =>
    storageKey(identity, kind) === storageKey(
      storageIdentity,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    )));

  old.client.close();
  newer.client.close();
  await newerPending;
});
