import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_DURABLE_EVENT_TYPES,
  CHAT_PROTOCOL_VERSION,
} from "../dist/index.js";

const tenantId = "tenant-message-mutation-atomic";
const userId = "user-message-mutation-atomic";
const deviceId = "device-message-mutation-atomic";
const conversationId = "conversation-message-mutation-atomic";
const destinationConversationId = "conversation-message-mutation-destination";
const messageId = "message-message-mutation-atomic";
const now = "2032-06-01T00:00:00.000Z";
const storageIdentity = { tenantId, userId, deviceId };
const cacheIdentity = { tenantId, userId, sessionId: "session-message-mutation-atomic" };
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
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const message = (revision = 1, deleted = false) => ({
  id: messageId,
  tenantId,
  conversationId,
  author: { type: "user", userId },
  sequence: 1,
  createdAt: now,
  updatedAt: deleted ? "2032-06-01T00:00:02.000Z" : now,
  revision: { revision },
  content: deleted ? null : { format: "plain", text: "atomic mutation base" },
  ...(deleted
    ? {
        deletedAt: "2032-06-01T00:00:02.000Z",
        deletedByUserId: userId,
      }
    : {}),
});
const durable = (
  eventId,
  type,
  payload,
  streamId = conversationId,
  occurredAt = now,
) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId,
  type,
  occurredAt,
  payload,
});
const seedCache = () => {
  const cache = createNormalizedChatCache(cacheIdentity);
  for (const id of [conversationId, destinationConversationId]) {
    cache.applyDurableEvent(durable(
      `conversation-created-${id}`,
      CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: {
        id,
        tenantId,
        type: "channel",
        visibility: "public",
        name: id,
        createdAt: now,
        updatedAt: now,
      } },
      id,
    ));
  }
  cache.applyDurableEvent(durable(
    "message-created",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message() },
    conversationId,
    "2032-06-01T00:00:01.000Z",
  ));
  return cache;
};

function createSharedAtomicHarness() {
  const rows = new Map();
  const calls = [];
  let race;
  const compareCount = () => calls.filter(({ operation, kind }) =>
    operation === "compareExchange" &&
    kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents).length;
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
        kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents &&
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
      race = { arrivals: 0, barrier: deferred(), initialCompareCount: compareCount() };
    },
    raceArrivals: () => race?.arrivals ?? 0,
    raceCompareCount: () => compareCount() - (race?.initialCompareCount ?? 0),
    compareCount,
    async readRecord() {
      return createStorage().read(
        storageIdentity,
        ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
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
    commands: { retry: { maxAttempts: 1 } },
    optimisticEdits: { generateIdempotencyKey: () => `${label}-edit-key` },
    optimisticDeletes: { generateIdempotencyKey: () => `${label}-delete-key` },
    optimisticReactions: { generateIdempotencyKey: () => `${label}-reaction-key` },
    forwardMessages: {
      generateClientCorrelationId: () => `${label}-forward-correlation`,
      generateIdempotencyKey: () => `${label}-forward-key`,
    },
    fetch: async (url, init) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
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

test("contended edit and forward commits both survive and reload exactly once", async () => {
  const harness = createSharedAtomicHarness();
  const editor = await createFixture(harness, "editor");
  const forwarder = await createFixture(harness, "forwarder");

  harness.armRace();
  void editor.client.editMessage({
    messageId,
    expectedRevision: 1,
    content: { format: "plain", text: "contended edit" },
  });
  await eventually(() => harness.raceArrivals() === 1);
  void forwarder.client.forwardMessage({ sourceMessageId: messageId, destinationConversationId });
  await eventually(async () => (await harness.readRecord())?.intents.length === 2);

  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.operation,
  ]), [[1, "forward_message.v1"], [2, "edit"]]);
  assert.ok(harness.raceCompareCount() >= 3, "the stale edit proposal must retry");
  await eventually(() => editor.requests.length === 1 && forwarder.requests.length === 1);
  editor.client.close();
  forwarder.client.close();

  const leader = await createFixture(harness, "leader");
  await eventually(() => leader.requests.length === 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(leader.requests.length, 2);
  assert.deepEqual(
    new Set(leader.requests.map(({ idempotencyKey }) => idempotencyKey)),
    new Set(committed.intents.map(({ request }) => request.idempotencyKey)),
  );
  const committedForward = committed.intents.find(
    ({ request }) => request.operation === "forward_message.v1",
  ).request;
  assert.equal(
    leader.requests.find(({ operation }) => operation === "forward_message.v1")
      .clientCorrelationId,
    committedForward.clientCorrelationId,
  );
  leader.client.close();
});

test("contended reactions coalesce by the canonical adjacent-family rule", async () => {
  const harness = createSharedAtomicHarness();
  const first = await createFixture(harness, "first");
  const second = await createFixture(harness, "second");

  harness.armRace();
  void first.client.setReaction({ messageId, reactionKey: "eyes", reacted: true });
  await eventually(() => harness.raceArrivals() === 1);
  void second.client.setReaction({ messageId, reactionKey: "eyes", reacted: false });
  await eventually(async () => {
    const record = await harness.readRecord();
    return harness.raceCompareCount() >= 3 &&
      record?.intents[0]?.request.idempotencyKey === "first-reaction-key";
  });

  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => ({
    enqueueOrder,
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
  })), [{
    enqueueOrder: 1,
    operation: "add_reaction",
    idempotencyKey: "first-reaction-key",
  }]);
  assert.ok(harness.raceCompareCount() >= 3, "the stale reaction proposal must retry");
  first.client.close();
  second.client.close();
});

test("contended delete settlement preserves a concurrently committed forward", async () => {
  const harness = createSharedAtomicHarness();
  const deleteResponse = deferred();
  const deleter = await createFixture(harness, "deleter", (request) =>
    request.operation === "soft_delete" ? deleteResponse.promise : pendingForever);
  const forwarder = await createFixture(harness, "forwarder");
  const deletion = deleter.client.deleteMessage({ messageId, expectedRevision: 1 });
  await eventually(() => deleter.requests.length === 1);

  harness.armRace();
  const request = deleter.requests[0];
  deleteResponse.resolve(response(200, {
    operation: "soft_delete",
    reconciliationStatus: "applied",
    expectedRevision: request.expectedRevision,
    message: message(2, true),
    canonicalRevision: 2,
  }));
  await eventually(() => harness.raceArrivals() === 1);
  void forwarder.client.forwardMessage({ sourceMessageId: messageId, destinationConversationId });

  assert.equal((await deletion).status, "success");
  await eventually(async () => {
    const record = await harness.readRecord();
    return record?.intents.length === 1 &&
      record.intents[0].request.operation === "forward_message.v1";
  });
  const committed = await harness.readRecord();
  assert.equal(committed.intents[0].request.idempotencyKey, "forwarder-forward-key");
  assert.ok(harness.raceCompareCount() >= 3, "the stale settlement proposal must retry");
  deleter.client.close();
  forwarder.client.close();
});
