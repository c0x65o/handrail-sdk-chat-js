import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatQueuedConversationMembershipIntent,
  createApplicationChatQueuedConversationMembershipIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-membership-atomic";
const userId = "user-membership-atomic";
const targetUserId = "target-membership-atomic";
const deviceId = "device-membership-atomic";
const now = "2032-07-01T00:00:00.000Z";
const storageIdentity = { tenantId, userId, deviceId };
const cacheIdentity = { tenantId, userId, sessionId: "session-membership-atomic" };
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
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const member = (memberUserId, role = "member", state = "active") => ({
  userId: memberUserId,
  role,
  state,
  joinedAt: now,
  updatedAt: now,
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
    activeMemberUserIds: [userId, targetUserId],
    memberListRevision: 1,
    memberUserIds: [userId, targetUserId],
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
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: false },
      updatedAt: now,
    },
    members: [member(userId, "owner"), member(targetUserId)],
  },
  _meta: {
    ...metadata(),
    feature: { name: "conversation_snapshots", version: 1 },
  },
});

const seedCache = () => {
  const cache = createNormalizedChatCache(cacheIdentity);
  cache.hydrateConversationDetail(detail("conversation-a"));
  cache.hydrateConversationDetail(detail("conversation-b"));
  return cache;
};

const membershipResult = (request) => {
  const targeted = Object.hasOwn(request, "targetUserId");
  const actorState = request.intent === "leave" ? "left" : "active";
  const targetState = request.intent === "remove_member" ? "removed" : "active";
  const targetRole = request.intent === "change_member_role"
    ? request.requestedRole
    : "member";
  return {
    operation: request.operation,
    intent: request.intent,
    reconciliationStatus: "applied",
    conversationId: request.conversationId,
    expectedMemberListRevision: request.expectedMemberListRevision,
    memberListRevision: request.expectedMemberListRevision + 1,
    memberUserId: targeted ? request.targetUserId : userId,
    members: [
      member(userId, "owner", actorState),
      member(targetUserId, targetRole, targetState),
    ].sort((left, right) => left.userId.localeCompare(right.userId)),
    ...(targeted ? { targetUserId: request.targetUserId } : {}),
    ...(Object.hasOwn(request, "requestedRole")
      ? { requestedRole: request.requestedRole }
      : {}),
  };
};

function createSharedAtomicHarness() {
  const rows = new Map();
  const calls = [];
  let race;
  const createStorage = () => createApplicationChatStorage(adapter);

  const adapter = {
    async read(identity, kind) {
      calls.push({ operation: "read", identity, kind });
      return rows.get(storageKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity, kind, encoded });
      rows.set(storageKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity, kind });
      rows.delete(storageKey(identity, kind));
    },
    async compareExchange(identity, kind, expected, replacement) {
      const call = { operation: "compareExchange", identity, kind, expected, replacement };
      calls.push(call);
      if (
        race !== undefined &&
        kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents &&
        storageKey(identity, kind) === storageKey(storageIdentity, kind) &&
        race.arrivals < 2
      ) {
        const ticket = ++race.arrivals;
        if (ticket === 2) race.barrier.resolve();
        await race.barrier.promise;
        // Make the first proposal lose deterministically, then exercise mutate's retry.
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
        ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
      );
    },
  };
}

async function createFixture(harness, label, command = () => pendingForever) {
  const requests = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache: seedCache(),
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: { generateIdempotencyKey: () => `${label}-membership-key` },
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
    },
  });
  assert.equal((await client.start()).state, "ready");
  return { client, requests };
}

test("contended membership requests in distinct lanes both survive", async () => {
  const harness = createSharedAtomicHarness();
  const leaver = await createFixture(harness, "leaver");
  const roleChanger = await createFixture(harness, "role-changer");

  harness.armRace();
  void leaver.client.leaveConversation({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
  });
  await eventually(() => harness.raceArrivals() === 1);
  void roleChanger.client.changeConversationMemberRole({
    conversationId: "conversation-b",
    expectedMemberListRevision: 1,
    targetUserId,
    requestedRole: "moderator",
  });
  await eventually(async () => (await harness.readRecord())?.intents.length === 2);

  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.intent,
    request.idempotencyKey,
  ]), [
    [1, "change_member_role", "role-changer-membership-key"],
    [2, "leave", "leaver-membership-key"],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale membership proposal must retry",
  );
  await eventually(() => leaver.requests.length === 1 && roleChanger.requests.length === 1);
  leaver.client.close();
  roleChanger.client.close();
});

test("same-lane contention retains the first committed membership request", async () => {
  const harness = createSharedAtomicHarness();
  const stale = await createFixture(harness, "stale");
  const committed = await createFixture(harness, "committed");

  harness.armRace();
  const staleResult = stale.client.removeConversationMember({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
    targetUserId,
  });
  await eventually(() => harness.raceArrivals() === 1);
  void committed.client.removeConversationMember({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
    targetUserId,
  });
  await eventually(async () =>
    (await harness.readRecord())?.intents[0]?.request.idempotencyKey ===
      "committed-membership-key");

  const record = await harness.readRecord();
  assert.equal(record.intents.length, 1);
  assert.equal(record.intents[0].enqueueOrder, 1);
  assert.equal(record.intents[0].request.idempotencyKey, "committed-membership-key");
  assert.equal((await staleResult).status, "validation");
  await eventually(() => committed.requests.length === 1);
  assert.equal(stale.requests.length, 0);
  stale.client.close();
  committed.client.close();
});

test("exact settlement preserves concurrently retained membership work and key boundaries", async () => {
  const harness = createSharedAtomicHarness();
  const siblingIdentity = { ...storageIdentity, deviceId: "sibling-device" };
  const siblingRequest = {
    operation: "mutate_conversation_membership",
    intent: "join",
    conversationId: "sibling-conversation",
    expectedMemberListRevision: 1,
    idempotencyKey: "sibling-membership-key",
  };
  const siblingRecord = createApplicationChatQueuedConversationMembershipIntentsRecord(
    siblingIdentity,
    [createApplicationChatQueuedConversationMembershipIntent(siblingRequest, {
      enqueueOrder: 1,
      enqueuedAt: now,
    })],
  );
  await harness.createStorage().replace(siblingRecord);

  const settlement = deferred();
  const remover = await createFixture(harness, "remover", () => settlement.promise);
  const leaver = await createFixture(harness, "retained");
  const pending = remover.client.removeConversationMember({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
    targetUserId,
  });
  await eventually(() => remover.requests.length === 1);

  harness.armRace();
  settlement.resolve(response(200, membershipResult(remover.requests[0])));
  await eventually(() => harness.raceArrivals() === 1);
  void leaver.client.leaveConversation({
    conversationId: "conversation-b",
    expectedMemberListRevision: 1,
  });

  assert.equal((await pending).status, "success");
  await eventually(async () => {
    const record = await harness.readRecord();
    return record?.intents.length === 1 &&
      record.intents[0].request.idempotencyKey === "retained-membership-key";
  });
  assert.deepEqual(await harness.readRecord(siblingIdentity), siblingRecord);
  const atomicCalls = harness.raceCalls().filter(
    ({ operation }) => operation === "compareExchange",
  );
  assert.ok(atomicCalls.length >= 3, "the stale settlement proposal must retry");
  assert.ok(atomicCalls.every(({ identity, kind }) =>
    storageKey(identity, kind) === storageKey(
      storageIdentity,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    )));
  remover.client.close();
  leaver.client.close();
});
