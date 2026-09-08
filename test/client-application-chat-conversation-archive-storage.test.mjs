import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedConversationArchiveIntent,
  createApplicationChatQueuedConversationArchiveIntentsRecord,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatStorage,
  decodeApplicationChatStorageRecord,
  encodeApplicationChatStorageRecord,
} from "../dist/client/index.js";

const identity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
});

const archiveRequest = (suffix = "one", overrides = {}) => ({
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId: `conversation-${suffix}`,
  expectedLifecycleRevision: 1,
  idempotencyKey: `conversation-archive-${suffix}`,
  ...overrides,
});

const archiveIntent = (order, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedConversationArchiveIntent(
    archiveRequest(suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-04T08:${String(order).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const decodeArchives = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  );

test("conversation-archive storage round-trips complete archive and restore requests", () => {
  const intents = [
    archiveIntent(1, "archive", {
      request: {
        expectedLifecycleRevision: 12,
        idempotencyKey: "archive-exact-correlation",
      },
    }),
    archiveIntent(2, "restore", {
      request: {
        intent: "restore",
        expectedLifecycleRevision: 900,
        idempotencyKey: "restore-exact-correlation",
      },
      metadata: { enqueuedAt: "2026-09-04T09:02:03.456-05:00" },
    }),
  ];
  const record = createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    intents,
  );
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(intents.map(toWireIntent)));
  assert.deepEqual(decodeArchives(encoded), record);
  assert.equal(record.intents[0].request.operation, "set_conversation_archive");
  assert.equal(record.intents[0].request.intent, "archive");
  assert.equal(record.intents[0].request.expectedLifecycleRevision, 12);
  assert.equal(record.intents[0].request.idempotencyKey, "archive-exact-correlation");
  assert.equal(record.intents[1].request.intent, "restore");
  assert.equal(record.intents[1].request.expectedLifecycleRevision, 900);
  assert.equal(record.intents[1].request.idempotencyKey, "restore-exact-correlation");
});

test("conversation-archive coalescing keeps the latest request at each conversation's first FIFO position", () => {
  const firstA = archiveIntent(1, "a", {
    request: { expectedLifecycleRevision: 2, idempotencyKey: "a-first" },
  });
  const onlyB = archiveIntent(2, "b", {
    request: { intent: "restore", idempotencyKey: "b-only" },
  });
  const latestA = archiveIntent(3, "a-latest", {
    request: {
      intent: "restore",
      conversationId: firstA.request.conversationId,
      expectedLifecycleRevision: 7,
      idempotencyKey: "a-latest-exact",
    },
    metadata: { enqueuedAt: "2026-09-04T09:03:00.999Z" },
  });
  const onlyC = archiveIntent(4, "c");

  const record = createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [firstA, onlyB, latestA, onlyC],
  );

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.conversationId,
    intent.request.intent,
    intent.request.idempotencyKey,
  ]), [
    [1, "conversation-a", "restore", "a-latest-exact"],
    [2, "conversation-b", "restore", "b-only"],
    [4, "conversation-c", "archive", "conversation-archive-c"],
  ]);
  assert.deepEqual(record.intents[0].request, latestA.request);
  assert.equal(record.intents[0].enqueueOrder, firstA.enqueueOrder);
  assert.equal(record.intents[0].enqueuedAt, firstA.enqueuedAt);
});

test("conversation-archive storage rejects duplicate correlations, unsafe FIFO orders, and count overflow", () => {
  assert.throws(() => createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [
      archiveIntent(1, "one", { request: { idempotencyKey: "duplicate" } }),
      archiveIntent(2, "two", { request: { idempotencyKey: "duplicate" } }),
    ],
  ), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [archiveIntent(1, "one"), archiveIntent(1, "same-order")],
  ), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [archiveIntent(2, "later"), archiveIntent(1, "earlier")],
  ), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS + 1).fill(
      archiveIntent(1),
    ),
  ), /at most/);
});

test("conversation-archive storage rejects malformed, open, trusted, and secret-bearing values", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T08:00:00Z" };
  for (const request of [
    { ...archiveRequest("extra"), unexpected: true },
    { ...archiveRequest("toggle"), intent: "toggle" },
    { ...archiveRequest("operation"), operation: "archive_conversation" },
    { ...archiveRequest("zero"), expectedLifecycleRevision: 0 },
    { ...archiveRequest("fraction"), expectedLifecycleRevision: 1.5 },
    { ...archiveRequest("unsafe"), expectedLifecycleRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...archiveRequest("blank-id"), conversationId: "   " },
    { ...archiveRequest("long-id"), conversationId: "x".repeat(513) },
    { ...archiveRequest("long-key"), idempotencyKey: "x".repeat(513) },
    { ...archiveRequest("tenant"), tenantId: "tenant-injected" },
    { ...archiveRequest("user"), currentUserId: "user-injected" },
    { ...archiveRequest("authorization"), authorization: { roles: ["admin"] } },
    { ...archiveRequest("secret"), secret: "do-not-store" },
    { ...archiveRequest("credential"), credentials: { password: "do-not-store" } },
    { ...archiveRequest("provider"), providerConfiguration: { opaque: true } },
  ]) {
    assert.throws(() => createApplicationChatQueuedConversationArchiveIntent(
      request,
      metadata,
    ));
  }
  for (const badMetadata of [
    { enqueueOrder: 0, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1.5, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1, enqueuedAt: "not-a-timestamp" },
    { enqueueOrder: 1, enqueuedAt: "2026-02-30T00:00:00Z" },
    { enqueueOrder: 1, enqueuedAt: "2026-09-04T24:00:00Z" },
  ]) {
    assert.throws(() => createApplicationChatQueuedConversationArchiveIntent(
      archiveRequest("metadata"),
      badMetadata,
    ));
  }
});

test("conversation-archive wire decoding rejects malformed, unsupported, and UTF-8 oversized data", () => {
  const validWireIntent = toWireIntent(archiveIntent(1, "wire"));
  for (const invalidWire of [
    wireEnvelope([{ ...validWireIntent, contractVersion: 2 }]),
    wireEnvelope([{ ...validWireIntent, unexpected: true }]),
    wireEnvelope([{ ...validWireIntent, intent: "toggle" }]),
    wireEnvelope([{ ...validWireIntent, expectedLifecycleRevision: 0 }]),
    wireEnvelope([{ ...validWireIntent, providerDescriptor: { opaque: true } }]),
    { ...wireEnvelope([validWireIntent]), unexpected: true },
    {
      ...wireEnvelope([validWireIntent]),
      payload: { intents: [validWireIntent], unexpected: true },
    },
  ]) {
    assert.throws(() => decodeArchives(JSON.stringify(invalidWire)));
  }

  const utf8OversizedIntent = {
    ...validWireIntent,
    idempotencyKey: "💥".repeat(5_000),
  };
  const encodedIntent = JSON.stringify(utf8OversizedIntent);
  assert.ok(encodedIntent.length <= MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES);
  assert.ok(new TextEncoder().encode(encodedIntent).byteLength >
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES);
  assert.throws(() => decodeArchives(JSON.stringify(wireEnvelope([
    utf8OversizedIntent,
  ]))), /intent exceeds/);

  const oversizedRecord = JSON.stringify({
    ...wireEnvelope([validWireIntent]),
    padding: "💥".repeat(MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES),
  });
  assert.ok(new TextEncoder().encode(oversizedRecord).byteLength >
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES);
  assert.throws(() => decodeArchives(oversizedRecord), /storage record exceeds/);
});

test("conversation-archive records and storage reads are detached and deeply immutable", async () => {
  const request = archiveRequest("mutable");
  const intent = createApplicationChatQueuedConversationArchiveIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
  request.conversationId = "changed-after-construction";
  request.idempotencyKey = "changed-after-construction";
  const record = createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [intent],
  );
  let encoded = null;
  const storage = createApplicationChatStorage({
    async read() { return encoded; },
    async replace(_identity, _kind, nextEncoded) { encoded = nextEncoded; },
    async remove() { encoded = null; },
    async clearForLogout() { encoded = null; },
  });
  await storage.replace(record);
  const restored = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  );

  assert.equal(intent.request.conversationId, "conversation-mutable");
  assert.equal(record.intents[0].request.idempotencyKey, "conversation-archive-mutable");
  assert.notEqual(record.intents[0], intent);
  assert.notEqual(record.intents[0].request, intent.request);
  assert.notEqual(restored, record);
  assert.notEqual(restored.intents[0].request, record.intents[0].request);
  assert.ok(Object.isFrozen(restored));
  assert.ok(Object.isFrozen(restored.identity));
  assert.ok(Object.isFrozen(restored.intents));
  assert.ok(Object.isFrozen(restored.intents[0]));
  assert.ok(Object.isFrozen(restored.intents[0].request));
  assert.throws(() => {
    restored.intents[0].request.intent = "restore";
  });
});

test("conversation-archive identity isolation and quarantine affect only one identity-and-kind row", async () => {
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
  const ownRecord = createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [archiveIntent(1, "own")],
  );
  const siblingRecords = siblingIdentities.map((siblingIdentity, index) =>
    createApplicationChatQueuedConversationArchiveIntentsRecord(
      siblingIdentity,
      [archiveIntent(1, `sibling-${index}`)],
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
    assert.throws(() => decodeArchives(encoded, siblingIdentity));
  }
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ), ownRecord);

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedConversationArchiveIntents),
    "{corrupt-conversation-archive-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), sendRecord);
  for (let index = 0; index < siblingIdentities.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblingIdentities[index],
      ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
    ), siblingRecords[index]);
  }
});
