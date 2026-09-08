import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatQueuedThreadFollowIntent,
  createApplicationChatQueuedThreadFollowIntentsRecord,
  createApplicationChatStorage,
  decodeApplicationChatStorageRecord,
  encodeApplicationChatStorageRecord,
} from "../dist/client/index.js";

const identity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
});

const threadFollowRequest = (suffix = "one", overrides = {}) => ({
  operation: "set_thread_follow",
  intent: "follow",
  target: { type: "thread", id: `thread-${suffix}` },
  expectedFollowRevision: 0,
  idempotencyKey: `thread-follow-${suffix}`,
  ...overrides,
});

const threadFollowIntent = (order, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedThreadFollowIntent(
    threadFollowRequest(suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-04T08:${String(order).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const decodeThreadFollows = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  );

test("thread-follow storage round-trips complete follow and unfollow requests", () => {
  const intents = [
    threadFollowIntent(1, "follow", {
      request: {
        expectedFollowRevision: 12,
        idempotencyKey: "follow-exact-key",
      },
    }),
    threadFollowIntent(2, "unfollow", {
      request: {
        intent: "unfollow",
        expectedFollowRevision: 900,
        idempotencyKey: "unfollow-exact-key",
      },
      metadata: { enqueuedAt: "2026-09-04T09:02:03.456-05:00" },
    }),
  ];
  const record = createApplicationChatQueuedThreadFollowIntentsRecord(identity, intents);
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(intents.map(toWireIntent)));
  assert.deepEqual(decodeThreadFollows(encoded), record);
  assert.equal(record.intents[0].request.idempotencyKey, "follow-exact-key");
  assert.equal(record.intents[0].request.expectedFollowRevision, 12);
  assert.equal(record.intents[1].request.intent, "unfollow");
  assert.equal(record.intents[1].request.expectedFollowRevision, 900);
});

test("thread-follow coalescing keeps the latest request at each thread's first FIFO position", () => {
  const firstA = threadFollowIntent(1, "a", {
    request: { expectedFollowRevision: 2, idempotencyKey: "a-first" },
  });
  const onlyB = threadFollowIntent(2, "b", {
    request: { intent: "unfollow", idempotencyKey: "b-only" },
  });
  const latestA = threadFollowIntent(3, "a-latest", {
    request: {
      intent: "unfollow",
      target: firstA.request.target,
      expectedFollowRevision: 7,
      idempotencyKey: "a-latest-exact",
    },
    metadata: { enqueuedAt: "2026-09-04T09:03:00.999Z" },
  });
  const onlyC = threadFollowIntent(4, "c");

  const record = createApplicationChatQueuedThreadFollowIntentsRecord(
    identity,
    [firstA, onlyB, latestA, onlyC],
  );

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.target.id,
    intent.request.intent,
    intent.request.idempotencyKey,
  ]), [
    [1, "thread-a", "unfollow", "a-latest-exact"],
    [2, "thread-b", "unfollow", "b-only"],
    [4, "thread-c", "follow", "thread-follow-c"],
  ]);
  assert.deepEqual(record.intents[0].request, latestA.request);
  assert.equal(record.intents[0].enqueueOrder, firstA.enqueueOrder);
  assert.equal(record.intents[0].enqueuedAt, firstA.enqueuedAt);
});

test("thread-follow storage rejects duplicate correlations, duplicate orders, and count overflow", () => {
  assert.throws(() => createApplicationChatQueuedThreadFollowIntentsRecord(identity, [
    threadFollowIntent(1, "one", { request: { idempotencyKey: "duplicate" } }),
    threadFollowIntent(2, "two", { request: { idempotencyKey: "duplicate" } }),
  ]), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedThreadFollowIntentsRecord(identity, [
    threadFollowIntent(1, "one"),
    threadFollowIntent(1, "same-order"),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedThreadFollowIntentsRecord(identity, [
    threadFollowIntent(2, "later"),
    threadFollowIntent(1, "earlier"),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedThreadFollowIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS + 1).fill(
      threadFollowIntent(1),
    ),
  ), /at most/);
});

test("thread-follow storage rejects malformed, open, oversized, and forbidden material", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T08:00:00Z" };
  for (const request of [
    { ...threadFollowRequest("extra"), unexpected: true },
    { ...threadFollowRequest("toggle"), intent: "toggle" },
    { ...threadFollowRequest("parent"), target: { type: "channel", id: "channel-1" } },
    { ...threadFollowRequest("target-extra"), target: { type: "thread", id: "thread-1", extra: true } },
    { ...threadFollowRequest("negative"), expectedFollowRevision: -1 },
    { ...threadFollowRequest("fraction"), expectedFollowRevision: 1.5 },
    { ...threadFollowRequest("max"), expectedFollowRevision: Number.MAX_SAFE_INTEGER },
    { ...threadFollowRequest("utf8-id"), target: { type: "thread", id: "💥".repeat(64) } },
    { ...threadFollowRequest("utf8-key"), idempotencyKey: "💥".repeat(64) },
    { ...threadFollowRequest("secret"), secret: "do-not-store" },
    { ...threadFollowRequest("credential"), credentials: { password: "do-not-store" } },
    { ...threadFollowRequest("provider"), providerData: { opaque: true } },
    { ...threadFollowRequest("diagnostic"), diagnostics: { stack: "raw" } },
    { ...threadFollowRequest("tenant"), tenantId: "tenant-injected" },
    { ...threadFollowRequest("user"), currentUserId: "user-injected" },
  ]) {
    assert.throws(() => createApplicationChatQueuedThreadFollowIntent(request, metadata));
  }
  for (const badMetadata of [
    { enqueueOrder: 0, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1.5, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1, enqueuedAt: "not-a-timestamp" },
    { enqueueOrder: 1, enqueuedAt: "2026-02-30T00:00:00Z" },
    { enqueueOrder: 1, enqueuedAt: "2026-09-04T24:00:00Z" },
  ]) {
    assert.throws(() => createApplicationChatQueuedThreadFollowIntent(
      threadFollowRequest("metadata"),
      badMetadata,
    ));
  }

  const validWireIntent = toWireIntent(threadFollowIntent(1, "wire"));
  for (const invalidWire of [
    wireEnvelope([{ ...validWireIntent, contractVersion: 2 }]),
    wireEnvelope([{ ...validWireIntent, unexpected: true }]),
    wireEnvelope([{ ...validWireIntent, target: { ...validWireIntent.target, unexpected: true } }]),
    { ...wireEnvelope([validWireIntent]), unexpected: true },
    { ...wireEnvelope([validWireIntent]), payload: { intents: [validWireIntent], unexpected: true } },
  ]) {
    assert.throws(() => decodeThreadFollows(JSON.stringify(invalidWire)));
  }
  assert.throws(() => decodeThreadFollows(JSON.stringify(wireEnvelope([{
    ...validWireIntent,
    oversized: "💥".repeat(MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES),
  }]))), /intent exceeds/);
});

test("thread-follow records and nested requests are detached and deeply immutable", () => {
  const request = threadFollowRequest("mutable");
  const intent = createApplicationChatQueuedThreadFollowIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
  request.target.id = "changed-after-construction";
  request.idempotencyKey = "changed-after-construction";
  const record = createApplicationChatQueuedThreadFollowIntentsRecord(identity, [intent]);

  assert.equal(intent.request.target.id, "thread-mutable");
  assert.equal(record.intents[0].request.idempotencyKey, "thread-follow-mutable");
  assert.notEqual(record.intents[0], intent);
  assert.notEqual(record.intents[0].request, intent.request);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.identity));
  assert.ok(Object.isFrozen(record.intents));
  assert.ok(Object.isFrozen(record.intents[0]));
  assert.ok(Object.isFrozen(record.intents[0].request));
  assert.ok(Object.isFrozen(record.intents[0].request.target));
  assert.throws(() => {
    record.intents[0].request.target.id = "mutation-attempt";
  });
});

test("thread-follow identity isolation and quarantine affect only one identity-and-kind row", async () => {
  const rows = new Map();
  const key = (recordIdentity, kind) =>
    `${recordIdentity.tenantId}\u0000${recordIdentity.userId}\u0000${recordIdentity.deviceId}\u0000${kind}`;
  const storage = createApplicationChatStorage({
    async read(recordIdentity, kind) {
      return rows.get(key(recordIdentity, kind)) ?? null;
    },
    async replace(recordIdentity, kind, encoded) {
      rows.set(key(recordIdentity, kind), encoded);
    },
    async remove(recordIdentity, kind) {
      rows.delete(key(recordIdentity, kind));
    },
    async clearForLogout() {},
  });
  const siblingIdentities = [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ];
  const ownRecord = createApplicationChatQueuedThreadFollowIntentsRecord(
    identity,
    [threadFollowIntent(1, "own")],
  );
  const siblingRecords = siblingIdentities.map((siblingIdentity, index) =>
    createApplicationChatQueuedThreadFollowIntentsRecord(
      siblingIdentity,
      [threadFollowIntent(1, `sibling-${index}`)],
    ));
  const sendRecord = createApplicationChatQueuedSendMessageIntentsRecord(identity, [
    createApplicationChatQueuedSendMessageIntent({
      operation: "send",
      conversationId: "conversation-1",
      content: { format: "plain", text: "preserve this kind" },
      clientMessageId: "client-1",
      idempotencyKey: "send-1",
    }, {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-04T08:00:00Z",
    }),
  ]);

  await storage.replace(ownRecord);
  for (const siblingRecord of siblingRecords) await storage.replace(siblingRecord);
  await storage.replace(sendRecord);

  const encoded = encodeApplicationChatStorageRecord(ownRecord);
  for (const siblingIdentity of siblingIdentities) {
    assert.throws(() => decodeThreadFollows(encoded, siblingIdentity));
  }
  const restored = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  );
  assert.deepEqual(restored, ownRecord);
  assert.ok(Object.isFrozen(restored.intents[0].request.target));

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedThreadFollowIntents),
    "{corrupt-thread-follow-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), sendRecord);
  for (let index = 0; index < siblingIdentities.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblingIdentities[index],
      ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    ), siblingRecords[index]);
  }
});
