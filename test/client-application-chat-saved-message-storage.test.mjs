import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedSavedMessageIntent,
  createApplicationChatQueuedSavedMessageIntentsRecord,
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

const savedMessageRequest = (suffix = "one", overrides = {}) => ({
  operation: "set_saved_message",
  intent: "save",
  messageId: `message-${suffix}`,
  expectedSavedMessageRevision: 0,
  idempotencyKey: `saved-message-${suffix}`,
  ...overrides,
});

const savedMessageIntent = (order, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedSavedMessageIntent(
    savedMessageRequest(suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-04T08:${String(order).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const decodeSavedMessages = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  );

test("saved-message storage round-trips save, save with note, and unsave requests", () => {
  const intents = [
    savedMessageIntent(1, "save", {
      request: {
        expectedSavedMessageRevision: 12,
        idempotencyKey: "save-exact-key",
      },
    }),
    savedMessageIntent(2, "save-note", {
      request: {
        expectedSavedMessageRevision: 34,
        idempotencyKey: "save-note-exact-key",
        privateNote: "Follow up with the launch team",
      },
    }),
    savedMessageIntent(3, "unsave", {
      request: {
        intent: "unsave",
        expectedSavedMessageRevision: 900,
        idempotencyKey: "unsave-exact-key",
      },
      metadata: { enqueuedAt: "2026-09-04T09:02:03.456-05:00" },
    }),
  ];
  const record = createApplicationChatQueuedSavedMessageIntentsRecord(identity, intents);
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(intents.map(toWireIntent)));
  assert.deepEqual(decodeSavedMessages(encoded), record);
  assert.equal(Object.hasOwn(record.intents[0].request, "privateNote"), false);
  assert.equal(record.intents[0].request.idempotencyKey, "save-exact-key");
  assert.equal(record.intents[0].request.expectedSavedMessageRevision, 12);
  assert.equal(record.intents[1].request.privateNote, "Follow up with the launch team");
  assert.equal(record.intents[1].request.expectedSavedMessageRevision, 34);
  assert.equal(record.intents[2].request.intent, "unsave");
  assert.equal(record.intents[2].request.idempotencyKey, "unsave-exact-key");
  assert.equal(record.intents[2].request.expectedSavedMessageRevision, 900);
  assert.equal(Object.hasOwn(record.intents[2].request, "privateNote"), false);
});

test("saved-message coalescing keeps the latest request at each message's first FIFO position", () => {
  const firstA = savedMessageIntent(1, "a", {
    request: { expectedSavedMessageRevision: 2, idempotencyKey: "a-first" },
  });
  const onlyB = savedMessageIntent(2, "b", {
    request: { intent: "unsave", idempotencyKey: "b-only" },
  });
  const latestA = savedMessageIntent(3, "a-latest", {
    request: {
      messageId: firstA.request.messageId,
      expectedSavedMessageRevision: 7,
      idempotencyKey: "a-latest-exact",
      privateNote: "latest desired note",
    },
    metadata: { enqueuedAt: "2026-09-04T09:03:00.999Z" },
  });
  const onlyC = savedMessageIntent(4, "c");

  const record = createApplicationChatQueuedSavedMessageIntentsRecord(
    identity,
    [firstA, onlyB, latestA, onlyC],
  );

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.messageId,
    intent.request.intent,
    intent.request.idempotencyKey,
  ]), [
    [1, "message-a", "save", "a-latest-exact"],
    [2, "message-b", "unsave", "b-only"],
    [4, "message-c", "save", "saved-message-c"],
  ]);
  assert.deepEqual(record.intents[0].request, latestA.request);
  assert.equal(record.intents[0].enqueueOrder, firstA.enqueueOrder);
  assert.equal(record.intents[0].enqueuedAt, firstA.enqueuedAt);
});

test("saved-message storage rejects duplicate correlations, duplicate orders, and count overflow", () => {
  assert.throws(() => createApplicationChatQueuedSavedMessageIntentsRecord(identity, [
    savedMessageIntent(1, "one", { request: { idempotencyKey: "duplicate" } }),
    savedMessageIntent(2, "two", { request: { idempotencyKey: "duplicate" } }),
  ]), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedSavedMessageIntentsRecord(identity, [
    savedMessageIntent(1, "one"),
    savedMessageIntent(1, "same-order"),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedSavedMessageIntentsRecord(identity, [
    savedMessageIntent(2, "later"),
    savedMessageIntent(1, "earlier"),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedSavedMessageIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS + 1).fill(
      savedMessageIntent(1),
    ),
  ), /at most/);
});

test("saved-message storage rejects malformed, open, overlong, and forbidden material", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T08:00:00Z" };
  for (const request of [
    { ...savedMessageRequest("extra"), unexpected: true },
    { ...savedMessageRequest("toggle"), intent: "toggle" },
    { ...savedMessageRequest("operation"), operation: "save_message" },
    { ...savedMessageRequest("negative"), expectedSavedMessageRevision: -1 },
    { ...savedMessageRequest("fraction"), expectedSavedMessageRevision: 1.5 },
    { ...savedMessageRequest("max"), expectedSavedMessageRevision: Number.MAX_SAFE_INTEGER },
    { ...savedMessageRequest("utf8-id"), messageId: "💥".repeat(64) },
    { ...savedMessageRequest("utf8-key"), idempotencyKey: "💥".repeat(64) },
    { ...savedMessageRequest("blank-note"), privateNote: "   " },
    { ...savedMessageRequest("invalid-note"), privateNote: "unsafe\u0000note" },
    { ...savedMessageRequest("nfd-note"), privateNote: "e\u0301" },
    { ...savedMessageRequest("long-note"), privateNote: "💥".repeat(1_025) },
    { ...savedMessageRequest("unsave-note"), intent: "unsave", privateNote: "not allowed" },
    { ...savedMessageRequest("note-alias"), note: "not canonical" },
    { ...savedMessageRequest("private-note-alias"), private_note: "not canonical" },
    { ...savedMessageRequest("secret"), secret: "do-not-store" },
    { ...savedMessageRequest("credential"), credentials: { password: "do-not-store" } },
    { ...savedMessageRequest("provider"), providerData: { opaque: true } },
    { ...savedMessageRequest("diagnostic"), diagnostics: { stack: "raw" } },
    { ...savedMessageRequest("tenant"), tenantId: "tenant-injected" },
    { ...savedMessageRequest("user"), currentUserId: "user-injected" },
  ]) {
    assert.throws(() => createApplicationChatQueuedSavedMessageIntent(request, metadata));
  }
  for (const badMetadata of [
    { enqueueOrder: 0, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1.5, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1, enqueuedAt: "not-a-timestamp" },
    { enqueueOrder: 1, enqueuedAt: "2026-02-30T00:00:00Z" },
    { enqueueOrder: 1, enqueuedAt: "2026-09-04T24:00:00Z" },
  ]) {
    assert.throws(() => createApplicationChatQueuedSavedMessageIntent(
      savedMessageRequest("metadata"),
      badMetadata,
    ));
  }
});

test("saved-message wire decoding rejects malformed and oversized records and intents", () => {
  const validWireIntent = toWireIntent(savedMessageIntent(1, "wire"));
  for (const invalidWire of [
    wireEnvelope([{ ...validWireIntent, contractVersion: 2 }]),
    wireEnvelope([{ ...validWireIntent, unexpected: true }]),
    wireEnvelope([{ ...validWireIntent, intent: "unsave", privateNote: "not allowed" }]),
    wireEnvelope([{ ...validWireIntent, providerDescriptor: { opaque: true } }]),
    { ...wireEnvelope([validWireIntent]), unexpected: true },
    { ...wireEnvelope([validWireIntent]), payload: { intents: [validWireIntent], unexpected: true } },
  ]) {
    assert.throws(() => decodeSavedMessages(JSON.stringify(invalidWire)));
  }
  assert.throws(() => decodeSavedMessages(JSON.stringify(wireEnvelope([{
    ...validWireIntent,
    oversized: "💥".repeat(MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES),
  }]))), /intent exceeds/);
  const oversizedRecord = JSON.stringify(wireEnvelope(Array.from(
    { length: 700 },
    (_, index) => ({
      ...validWireIntent,
      enqueueOrder: index + 1,
      messageId: `message-${index}`,
      idempotencyKey: `saved-message-${index}`,
      privateNote: `x${"\n".repeat(4_095)}`,
    }),
  )));
  assert.ok(new TextEncoder().encode(oversizedRecord).byteLength >
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES);
  assert.throws(() => decodeSavedMessages(oversizedRecord), /storage record exceeds/);
});

test("saved-message records and requests are detached and deeply immutable", () => {
  const request = savedMessageRequest("mutable", { privateNote: "original note" });
  const intent = createApplicationChatQueuedSavedMessageIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
  request.messageId = "changed-after-construction";
  request.privateNote = "changed-after-construction";
  const record = createApplicationChatQueuedSavedMessageIntentsRecord(identity, [intent]);

  assert.equal(intent.request.messageId, "message-mutable");
  assert.equal(record.intents[0].request.privateNote, "original note");
  assert.notEqual(record.intents[0], intent);
  assert.notEqual(record.intents[0].request, intent.request);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.identity));
  assert.ok(Object.isFrozen(record.intents));
  assert.ok(Object.isFrozen(record.intents[0]));
  assert.ok(Object.isFrozen(record.intents[0].request));
  assert.throws(() => {
    record.intents[0].request.privateNote = "mutation-attempt";
  });
});

test("saved-message identity isolation and quarantine affect only one identity-and-kind row", async () => {
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
  const ownRecord = createApplicationChatQueuedSavedMessageIntentsRecord(
    identity,
    [savedMessageIntent(1, "own")],
  );
  const siblingRecords = siblingIdentities.map((siblingIdentity, index) =>
    createApplicationChatQueuedSavedMessageIntentsRecord(
      siblingIdentity,
      [savedMessageIntent(1, `sibling-${index}`)],
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
    assert.throws(() => decodeSavedMessages(encoded, siblingIdentity));
  }
  const restored = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  );
  assert.deepEqual(restored, ownRecord);
  assert.ok(Object.isFrozen(restored.intents[0].request));

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedSavedMessageIntents),
    "{corrupt-saved-message-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), sendRecord);
  for (let index = 0; index < siblingIdentities.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblingIdentities[index],
      ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    ), siblingRecords[index]);
  }
});
