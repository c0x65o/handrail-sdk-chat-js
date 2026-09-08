import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedMessageReminderIntent,
  createApplicationChatQueuedMessageReminderIntentsRecord,
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

const reminderRequest = (suffix = "one", overrides = {}) => {
  const request = {
    operation: "message_reminder.v1",
    intent: "set",
    conversationId: `conversation-${suffix}`,
    messageId: `message-${suffix}`,
    expectedReminderRevision: 0,
    idempotencyKey: `message-reminder-${suffix}`,
    dueAt: "2024-01-02T00:00:00Z",
    ...overrides,
  };
  if (request.intent === "cancel" && overrides.dueAt === undefined) delete request.dueAt;
  return request;
};

const reminderIntent = (order, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedMessageReminderIntent(
    reminderRequest(suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2024-01-01T00:${String(order).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const decodeReminders = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  );

test("message-reminder storage round-trips exact set, reschedule, and cancel requests", () => {
  const set = reminderIntent(1, "set", {
    request: {
      expectedReminderRevision: 0,
      idempotencyKey: "set-exact-key",
      dueAt: "2024-01-03T04:05:06.789-05:00",
    },
  });
  const reschedule = reminderIntent(2, "reschedule", {
    request: {
      expectedReminderRevision: 34,
      idempotencyKey: "reschedule-exact-key",
      dueAt: "2024-02-03T04:05:06Z",
    },
  });
  const cancel = reminderIntent(3, "cancel", {
    request: {
      intent: "cancel",
      expectedReminderRevision: 900,
      idempotencyKey: "cancel-exact-key",
      dueAt: undefined,
    },
    metadata: { enqueuedAt: "2024-01-01T09:02:03.456-05:00" },
  });
  const record = createApplicationChatQueuedMessageReminderIntentsRecord(
    identity,
    [set, reschedule, cancel],
  );
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(record.intents.map(toWireIntent)));
  assert.deepEqual(decodeReminders(encoded), record);
  assert.equal(record.intents[0].request.idempotencyKey, "set-exact-key");
  assert.equal(record.intents[0].request.dueAt, "2024-01-03T04:05:06.789-05:00");
  assert.equal(record.intents[1].request.expectedReminderRevision, 34);
  assert.equal(record.intents[1].request.dueAt, "2024-02-03T04:05:06Z");
  assert.equal(record.intents[2].request.intent, "cancel");
  assert.equal(record.intents[2].request.idempotencyKey, "cancel-exact-key");
  assert.equal(Object.hasOwn(record.intents[2].request, "dueAt"), false);
});

test("message-reminder validation uses the original enqueue boundary for persisted retries", () => {
  const historical = reminderIntent(1, "historical", {
    request: { dueAt: "2024-01-01T00:02:00Z" },
    metadata: { enqueuedAt: "2024-01-01T00:01:00Z" },
  });
  assert.deepEqual(
    decodeReminders(encodeApplicationChatStorageRecord(
      createApplicationChatQueuedMessageReminderIntentsRecord(identity, [historical]),
    )).intents[0].request,
    historical.request,
  );
  assert.throws(() => reminderIntent(1, "not-future", {
    request: { dueAt: "2024-01-01T00:01:00Z" },
    metadata: { enqueuedAt: "2024-01-01T00:01:00Z" },
  }), /future/);
});

test("message-reminder coalescing keeps the latest complete request at the message's first FIFO position", () => {
  const firstA = reminderIntent(1, "a", {
    request: { expectedReminderRevision: 2, idempotencyKey: "a-first" },
  });
  const onlyB = reminderIntent(2, "b", {
    request: { intent: "cancel", dueAt: undefined, idempotencyKey: "b-only" },
  });
  const latestA = reminderIntent(3, "a-latest", {
    request: {
      conversationId: firstA.request.conversationId,
      messageId: firstA.request.messageId,
      expectedReminderRevision: 7,
      idempotencyKey: "a-latest-exact",
      dueAt: "2024-03-04T05:06:07Z",
    },
    metadata: { enqueuedAt: "2024-01-01T01:03:00.999Z" },
  });
  const onlyC = reminderIntent(4, "c");

  const record = createApplicationChatQueuedMessageReminderIntentsRecord(
    identity,
    [firstA, onlyB, latestA, onlyC],
  );

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.messageId,
    intent.request.intent,
    intent.request.idempotencyKey,
  ]), [
    [1, "message-a", "set", "a-latest-exact"],
    [2, "message-b", "cancel", "b-only"],
    [4, "message-c", "set", "message-reminder-c"],
  ]);
  assert.deepEqual(record.intents[0].request, latestA.request);
  assert.equal(record.intents[0].enqueueOrder, firstA.enqueueOrder);
  assert.equal(record.intents[0].enqueuedAt, firstA.enqueuedAt);
});

test("message-reminder storage rejects duplicate correlations, unsafe order, and count overflow", () => {
  assert.throws(() => createApplicationChatQueuedMessageReminderIntentsRecord(identity, [
    reminderIntent(1, "one", { request: { idempotencyKey: "duplicate" } }),
    reminderIntent(2, "two", { request: { idempotencyKey: "duplicate" } }),
  ]), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedMessageReminderIntentsRecord(identity, [
    reminderIntent(1, "one"),
    reminderIntent(1, "same-order"),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedMessageReminderIntentsRecord(identity, [
    reminderIntent(2, "later"),
    reminderIntent(1, "earlier"),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedMessageReminderIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS + 1).fill(
      reminderIntent(1),
    ),
  ), /at most/);
});

test("message-reminder storage rejects malformed, oversized, toggle, trusted, and secret-bearing values", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2024-01-01T00:00:00Z" };
  const setWithoutDueAt = reminderRequest("missing-due");
  delete setWithoutDueAt.dueAt;
  for (const request of [
    { ...reminderRequest("extra"), unexpected: true },
    { ...reminderRequest("toggle"), intent: "toggle" },
    { ...reminderRequest("toggle-field"), toggleReminder: true },
    { ...reminderRequest("operation"), operation: "set_message_reminder" },
    setWithoutDueAt,
    { ...reminderRequest("cancel-due"), intent: "cancel" },
    { ...reminderRequest("invalid-due"), dueAt: "2024-02-30T00:00:00Z" },
    { ...reminderRequest("negative"), expectedReminderRevision: -1 },
    { ...reminderRequest("fraction"), expectedReminderRevision: 1.5 },
    { ...reminderRequest("max"), expectedReminderRevision: Number.MAX_SAFE_INTEGER },
    { ...reminderRequest("utf8-conversation"), conversationId: "💥".repeat(64) },
    { ...reminderRequest("utf8-message"), messageId: "💥".repeat(64) },
    { ...reminderRequest("utf8-key"), idempotencyKey: "💥".repeat(64) },
    { ...reminderRequest("tenant"), tenantId: "tenant-injected" },
    { ...reminderRequest("user"), currentUserId: "user-injected" },
    { ...reminderRequest("secret"), secret: "do-not-store" },
    { ...reminderRequest("credential"), credentials: { password: "do-not-store" } },
    { ...reminderRequest("provider"), providerData: { opaque: true } },
    { ...reminderRequest("diagnostic"), diagnostics: { stack: "raw" } },
  ]) {
    assert.throws(() => createApplicationChatQueuedMessageReminderIntent(request, metadata));
  }
  for (const badMetadata of [
    { enqueueOrder: 0, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: Number.MAX_SAFE_INTEGER + 1, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1, enqueuedAt: "not-a-timestamp" },
    { enqueueOrder: 1, enqueuedAt: "2024-02-30T00:00:00Z" },
  ]) {
    assert.throws(() => createApplicationChatQueuedMessageReminderIntent(
      reminderRequest("metadata"),
      badMetadata,
    ));
  }

  const validWireIntent = toWireIntent(reminderIntent(1, "wire"));
  for (const invalidWire of [
    wireEnvelope([{ ...validWireIntent, contractVersion: 2 }]),
    wireEnvelope([{ ...validWireIntent, unexpected: true }]),
    wireEnvelope([{ ...validWireIntent, intent: "cancel" }]),
    wireEnvelope([{ ...validWireIntent, providerDescriptor: { opaque: true } }]),
    { ...wireEnvelope([validWireIntent]), unexpected: true },
    { ...wireEnvelope([validWireIntent]), payload: { intents: [validWireIntent], unexpected: true } },
  ]) {
    assert.throws(() => decodeReminders(JSON.stringify(invalidWire)));
  }
  assert.throws(() => decodeReminders(JSON.stringify(wireEnvelope([{
    ...validWireIntent,
    oversized: "💥".repeat(MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES),
  }]))), /intent exceeds/);
  const oversizedRecord = JSON.stringify({
    ...wireEnvelope([validWireIntent]),
    padding: "💥".repeat(MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES),
  });
  assert.ok(new TextEncoder().encode(oversizedRecord).byteLength >
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES);
  assert.throws(() => decodeReminders(oversizedRecord), /storage record exceeds/);
});

test("message-reminder records and requests are detached and deeply immutable", () => {
  const request = reminderRequest("mutable");
  const intent = createApplicationChatQueuedMessageReminderIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2024-01-01T00:00:00Z",
  });
  request.messageId = "changed-after-construction";
  request.dueAt = "2024-06-01T00:00:00Z";
  const record = createApplicationChatQueuedMessageReminderIntentsRecord(identity, [intent]);

  assert.equal(intent.request.messageId, "message-mutable");
  assert.equal(record.intents[0].request.dueAt, "2024-01-02T00:00:00Z");
  assert.notEqual(record.intents[0], intent);
  assert.notEqual(record.intents[0].request, intent.request);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.identity));
  assert.ok(Object.isFrozen(record.intents));
  assert.ok(Object.isFrozen(record.intents[0]));
  assert.ok(Object.isFrozen(record.intents[0].request));
  assert.throws(() => {
    record.intents[0].request.messageId = "mutation-attempt";
  });
});

test("message-reminder identity isolation and quarantine affect only one identity-and-kind row", async () => {
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
  const ownRecord = createApplicationChatQueuedMessageReminderIntentsRecord(
    identity,
    [reminderIntent(1, "own")],
  );
  const siblingRecords = siblingIdentities.map((siblingIdentity, index) =>
    createApplicationChatQueuedMessageReminderIntentsRecord(
      siblingIdentity,
      [reminderIntent(1, `sibling-${index}`)],
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
      enqueuedAt: "2024-01-01T00:00:00Z",
    }),
  ]);

  await storage.replace(ownRecord);
  for (const siblingRecord of siblingRecords) await storage.replace(siblingRecord);
  await storage.replace(sendRecord);

  const encoded = encodeApplicationChatStorageRecord(ownRecord);
  for (const siblingIdentity of siblingIdentities) {
    assert.throws(() => decodeReminders(encoded, siblingIdentity));
  }
  const restored = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  );
  assert.deepEqual(restored, ownRecord);
  assert.notEqual(restored, ownRecord);
  assert.ok(Object.isFrozen(restored));
  assert.ok(Object.isFrozen(restored.intents));
  assert.ok(Object.isFrozen(restored.intents[0].request));

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedMessageReminderIntents),
    "{corrupt-message-reminder-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), sendRecord);
  for (let index = 0; index < siblingIdentities.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblingIdentities[index],
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    ), siblingRecords[index]);
  }
});
