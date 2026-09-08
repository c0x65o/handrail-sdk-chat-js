import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedConversationPreferenceIntent,
  createApplicationChatQueuedConversationPreferenceIntentsRecord,
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

const preferenceRequest = (suffix = "one", overrides = {}) => ({
  operation: "update_conversation_preference",
  conversationId: `conversation-${suffix}`,
  expectedPreferenceRevision: 4,
  idempotencyKey: `preference-${suffix}`,
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  ...overrides,
});

const preferenceIntent = (order, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedConversationPreferenceIntent(
    preferenceRequest(suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-04T05:${String(order).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const decodePreferences = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  );

test("conversation-preference storage exactly round-trips every notification and mute form", () => {
  const intents = [
    preferenceIntent(1, "all-unmuted", {
      request: { notificationPreference: "all", mute: { muted: false } },
    }),
    preferenceIntent(2, "mentions-indefinite", {
      request: {
        expectedPreferenceRevision: 0,
        notificationPreference: "mentions",
        isStarred: true,
        mute: { muted: true },
      },
    }),
    preferenceIntent(3, "none-timed", {
      request: {
        expectedPreferenceRevision: 900,
        notificationPreference: "none",
        mute: { muted: true, mutedUntil: "2026-10-01T13:45:30.123-05:00" },
      },
    }),
  ];
  const record = createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    intents,
  );
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(intents.map(toWireIntent)));
  assert.deepEqual(decodePreferences(encoded), record);
  assert.equal(record.intents[2].request.idempotencyKey, "preference-none-timed");
  assert.equal(record.intents[2].request.expectedPreferenceRevision, 900);
  assert.equal(record.intents[2].enqueueOrder, 3);
  assert.equal(record.intents[2].enqueuedAt, "2026-09-04T05:03:00Z");
});

test("conversation-preference coalescing keeps each latest exact state and unrelated FIFO order", () => {
  const firstA = preferenceIntent(1, "a", {
    request: { notificationPreference: "all" },
  });
  const onlyB = preferenceIntent(2, "b", {
    request: { notificationPreference: "mentions", isStarred: true },
  });
  const latestA = preferenceIntent(3, "a-latest", {
    request: {
      conversationId: firstA.request.conversationId,
      expectedPreferenceRevision: 7,
      idempotencyKey: "preference-a-latest-exact",
      notificationPreference: "none",
      isStarred: true,
      mute: { muted: true },
    },
    metadata: { enqueuedAt: "2026-09-04T06:03:00.999Z" },
  });
  const onlyC = preferenceIntent(4, "c", {
    request: { mute: { muted: true, mutedUntil: "2026-09-05T00:00:00Z" } },
  });
  const record = createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    [firstA, onlyB, latestA, onlyC],
  );

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.conversationId,
    intent.request.idempotencyKey,
  ]), [
    [1, "conversation-a", "preference-a-latest-exact"],
    [2, "conversation-b", "preference-b"],
    [4, "conversation-c", "preference-c"],
  ]);
  assert.deepEqual(record.intents[0].request, latestA.request);
  assert.equal(record.intents[0].enqueueOrder, firstA.enqueueOrder);
  assert.equal(record.intents[0].enqueuedAt, firstA.enqueuedAt);
});

test("conversation-preference storage rejects duplicate correlations and non-FIFO order", () => {
  const first = preferenceIntent(1, "first", {
    request: { idempotencyKey: "reused-preference-correlation" },
  });
  const duplicate = preferenceIntent(2, "second", {
    request: { idempotencyKey: "reused-preference-correlation" },
  });
  assert.throws(() => createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    [first, duplicate],
  ), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    [preferenceIntent(2, "later"), preferenceIntent(1, "earlier")],
  ), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    [preferenceIntent(1, "one"), preferenceIntent(1, "same-order")],
  ), /increasing FIFO order/);
});

test("conversation-preference validation rejects malformed shapes, revisions, identifiers, and mute values", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T05:00:00Z" };
  const invalidRequests = [
    { ...preferenceRequest("extra"), unexpected: true },
    { ...preferenceRequest("missing"), mute: undefined },
    { ...preferenceRequest("operation"), operation: "toggle_conversation_preference" },
    { ...preferenceRequest("revision-negative"), expectedPreferenceRevision: -1 },
    { ...preferenceRequest("revision-fraction"), expectedPreferenceRevision: 1.5 },
    { ...preferenceRequest("revision-max"), expectedPreferenceRevision: Number.MAX_SAFE_INTEGER },
    { ...preferenceRequest("notification"), notificationPreference: "important" },
    { ...preferenceRequest("starred"), isStarred: 1 },
    { ...preferenceRequest("mute-boolean"), mute: false },
    { ...preferenceRequest("mute-unmuted-until"), mute: { muted: false, mutedUntil: "2026-09-05T00:00:00Z" } },
    { ...preferenceRequest("mute-extra"), mute: { muted: true, reason: "later" } },
    { ...preferenceRequest("mute-date"), mute: { muted: true, mutedUntil: "2026-02-30T00:00:00Z" } },
    { ...preferenceRequest("trimmed"), conversationId: " conversation" },
    { ...preferenceRequest("control"), conversationId: "conversation\u0000bad" },
    { ...preferenceRequest("non-nfc"), conversationId: "e\u0301" },
    { ...preferenceRequest("blank-key"), idempotencyKey: " " },
    { ...preferenceRequest("long-id"), conversationId: "💥".repeat(64) },
    { ...preferenceRequest("long-key"), idempotencyKey: "💥".repeat(64) },
  ];
  for (const request of invalidRequests) {
    assert.throws(() => createApplicationChatQueuedConversationPreferenceIntent(
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
    assert.throws(() => createApplicationChatQueuedConversationPreferenceIntent(
      preferenceRequest("metadata"),
      badMetadata,
    ));
  }

  const wire = toWireIntent(preferenceIntent(1, "wire"));
  wire.contractVersion = 2;
  assert.throws(() => decodePreferences(JSON.stringify(wireEnvelope([wire]))), /contract version/);
  wire.contractVersion = APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION;
  wire.unexpected = true;
  assert.throws(() => decodePreferences(JSON.stringify(wireEnvelope([wire]))), /exactly/);
});

test("conversation-preference storage rejects secret, provider, and trusted-identity fields", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T05:00:00Z" };
  for (const request of [
    { ...preferenceRequest("secret"), secret: "do-not-store" },
    { ...preferenceRequest("token"), accessToken: "do-not-store" },
    { ...preferenceRequest("provider"), providerData: { opaque: true } },
    { ...preferenceRequest("tenant"), tenantId: "tenant-injected" },
    { ...preferenceRequest("user"), currentUserId: "user-injected" },
    { ...preferenceRequest("device"), deviceId: "device-injected" },
    { ...preferenceRequest("nested"), mute: { muted: true, actorId: "actor-injected" } },
  ]) {
    assert.throws(() => createApplicationChatQueuedConversationPreferenceIntent(
      request,
      metadata,
    ));
  }
});

test("conversation-preference storage enforces count, per-intent UTF-8, and total byte ceilings", () => {
  const oneIntent = preferenceIntent(1, "count");
  assert.throws(() => createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS + 1).fill(oneIntent),
  ), /at most/);

  const oversizedWireIntent = {
    ...toWireIntent(oneIntent),
    conversationId: "💥".repeat(
      Math.ceil(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES / 4),
    ),
  };
  assert.throws(() => decodePreferences(
    JSON.stringify(wireEnvelope([oversizedWireIntent])),
  ), /intent exceeds/);
  assert.throws(() => decodePreferences(
    " ".repeat(MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES + 1),
  ), /storage record exceeds/);
});

test("conversation-preference storage isolates tenant, user, and device", () => {
  const encoded = encodeApplicationChatStorageRecord(
    createApplicationChatQueuedConversationPreferenceIntentsRecord(
      identity,
      [preferenceIntent(1, "isolation")],
    ),
  );
  for (const mismatch of [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ]) {
    assert.throws(() => decodePreferences(encoded, mismatch), /identity/);
  }
});

test("conversation-preference reads are deeply immutable and detached", async () => {
  const request = preferenceRequest("detached", {
    notificationPreference: "mentions",
    isStarred: true,
    mute: { muted: true, mutedUntil: "2026-09-05T00:00:00Z" },
  });
  const intent = createApplicationChatQueuedConversationPreferenceIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T05:00:00Z",
  });
  request.notificationPreference = "none";
  request.mute.mutedUntil = "2027-01-01T00:00:00Z";
  const record = createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    [intent],
  );
  const rows = new Map();
  const storage = createApplicationChatStorage({
    async read(recordIdentity, kind) {
      return rows.get(JSON.stringify([recordIdentity, kind])) ?? null;
    },
    async replace(recordIdentity, kind, encoded) {
      rows.set(JSON.stringify([recordIdentity, kind]), encoded);
    },
    async remove(recordIdentity, kind) {
      rows.delete(JSON.stringify([recordIdentity, kind]));
    },
    async clearForLogout() {},
  });
  await storage.replace(record);
  const read = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  );

  assert.notEqual(record.intents[0], intent);
  assert.notEqual(read, record);
  assert.equal(read.intents[0].request.notificationPreference, "mentions");
  assert.equal(read.intents[0].request.mute.mutedUntil, "2026-09-05T00:00:00Z");
  assert.ok(Object.isFrozen(read));
  assert.ok(Object.isFrozen(read.identity));
  assert.ok(Object.isFrozen(read.intents));
  assert.ok(Object.isFrozen(read.intents[0]));
  assert.ok(Object.isFrozen(read.intents[0].request));
  assert.ok(Object.isFrozen(read.intents[0].request.mute));
  assert.throws(() => {
    read.intents[0].request.mute.mutedUntil = "2028-01-01T00:00:00Z";
  });
});

test("conversation-preference quarantine removes only the corrupt identity-and-kind record", async () => {
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
  const preference = createApplicationChatQueuedConversationPreferenceIntentsRecord(
    identity,
    [preferenceIntent(1, "quarantine")],
  );
  const send = createApplicationChatQueuedSendMessageIntentsRecord(identity, [
    createApplicationChatQueuedSendMessageIntent({
      operation: "send",
      conversationId: "conversation-1",
      content: { format: "plain", text: "safe" },
      clientMessageId: "client-1",
      idempotencyKey: "send-1",
    }, {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-04T05:00:00Z",
    }),
  ]);
  const siblingIdentity = { ...identity, deviceId: "device-2" };
  const siblingPreference = createApplicationChatQueuedConversationPreferenceIntentsRecord(
    siblingIdentity,
    [preferenceIntent(1, "sibling")],
  );
  await storage.replace(preference);
  await storage.replace(send);
  await storage.replace(siblingPreference);
  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents),
    "{corrupt-preference-record",
  );

  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), send);
  assert.deepEqual(await storage.read(
    siblingIdentity,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ), siblingPreference);
});
