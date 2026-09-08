import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_HUDDLE_COMMAND_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedHuddleCommandIntent,
  createApplicationChatQueuedHuddleCommandIntentsRecord,
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

const requests = Object.freeze([
  {
    operation: "start_huddle",
    conversationId: "conversation-1",
    idempotencyKey: " start/idempotency:EXACT ",
  },
  {
    operation: "join_huddle",
    huddleSessionId: "huddle-1",
    idempotencyKey: "join-idempotency",
  },
  {
    operation: "leave_huddle",
    huddleSessionId: "huddle-1",
    idempotencyKey: "leave-idempotency",
  },
  {
    operation: "set_huddle_screen_share",
    huddleSessionId: "huddle-1",
    intent: "set",
    idempotencyKey: "screen-share-idempotency",
  },
  {
    operation: "end_huddle",
    huddleSessionId: "huddle-1",
    idempotencyKey: "end-idempotency",
  },
]);

const makeIntent = (order, request = requests[order - 1], metadata = {}) =>
  createApplicationChatQueuedHuddleCommandIntent(request, {
    enqueueOrder: order,
    enqueuedAt: `2026-09-04T10:${String(order).padStart(2, "0")}:00Z`,
    ...metadata,
  });

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_HUDDLE_COMMAND_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const decodeHuddles = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  );

const rowKey = (recordIdentity, kind) =>
  `${recordIdentity.tenantId}\u0000${recordIdentity.userId}\u0000${recordIdentity.deviceId}\u0000${kind}`;

function createMemoryStorage() {
  const rows = new Map();
  const storage = createApplicationChatStorage({
    async read(recordIdentity, kind) {
      return rows.get(rowKey(recordIdentity, kind)) ?? null;
    },
    async replace(recordIdentity, kind, encoded) {
      rows.set(rowKey(recordIdentity, kind), encoded);
    },
    async remove(recordIdentity, kind) {
      rows.delete(rowKey(recordIdentity, kind));
    },
    async clearForLogout(recordIdentity) {
      const prefix = `${recordIdentity.tenantId}\u0000${recordIdentity.userId}\u0000${recordIdentity.deviceId}\u0000`;
      for (const key of rows.keys()) {
        if (key.startsWith(prefix)) rows.delete(key);
      }
    },
  });
  return { rows, storage };
}

test("huddle-command storage exactly round-trips all five provider-neutral operations", async () => {
  const intents = requests.map((request, index) => makeIntent(index + 1, request));
  const record = createApplicationChatQueuedHuddleCommandIntentsRecord(identity, intents);
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(intents.map(toWireIntent)));
  assert.deepEqual(decodeHuddles(encoded), record);
  assert.deepEqual(
    record.intents.map((intent) => intent.request.idempotencyKey),
    requests.map((request) => request.idempotencyKey),
  );
  assert.equal(record.intents[0].request.idempotencyKey, " start/idempotency:EXACT ");

  const { storage } = createMemoryStorage();
  await storage.replace(record);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), record);
});

test("huddle-command ordering and coalescing retain every distinct in-flight correlation", () => {
  const firstRetry = makeIntent(1, {
    operation: "start_huddle",
    conversationId: "conversation-shared",
    idempotencyKey: "same-retry-correlation",
  });
  const distinctSameConversation = makeIntent(2, {
    operation: "start_huddle",
    conversationId: "conversation-shared",
    idempotencyKey: "distinct-correlation",
  });
  const latestRetry = makeIntent(3, firstRetry.request, {
    enqueuedAt: "2026-09-04T11:03:04.567-05:00",
  });
  const distinctSameSession = makeIntent(4, {
    operation: "leave_huddle",
    huddleSessionId: "huddle-shared",
    idempotencyKey: "leave-correlation",
  });
  const anotherSameSession = makeIntent(5, {
    operation: "end_huddle",
    huddleSessionId: "huddle-shared",
    idempotencyKey: "end-correlation",
  });

  const record = createApplicationChatQueuedHuddleCommandIntentsRecord(identity, [
    firstRetry,
    distinctSameConversation,
    latestRetry,
    distinctSameSession,
    anotherSameSession,
  ]);

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.idempotencyKey,
  ]), [
    [2, "distinct-correlation"],
    [3, "same-retry-correlation"],
    [4, "leave-correlation"],
    [5, "end-correlation"],
  ]);
  assert.equal(record.intents[1].enqueuedAt, latestRetry.enqueuedAt);

  assert.throws(() => createApplicationChatQueuedHuddleCommandIntentsRecord(identity, [
    firstRetry,
    makeIntent(2, {
      operation: "start_huddle",
      conversationId: "different-conversation",
      idempotencyKey: firstRetry.request.idempotencyKey,
    }),
  ]), /cannot identify different commands/);
  assert.throws(() => createApplicationChatQueuedHuddleCommandIntentsRecord(identity, [
    makeIntent(2, requests[0]),
    makeIntent(1, requests[1]),
  ]), /increasing FIFO order/);
  assert.throws(() => createApplicationChatQueuedHuddleCommandIntentsRecord(
    identity,
    Array.from(
      { length: MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENTS + 1 },
      (_, index) => makeIntent(index + 1, {
        operation: "start_huddle",
        conversationId: `conversation-${index}`,
        idempotencyKey: `idempotency-${index}`,
      }, { enqueuedAt: "2026-09-04T10:00:00Z" }),
    ),
  ), /at most/);
});

test("huddle-command public and wire shapes reject malformed, secret, descriptor, and oversized data", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T10:00:00Z" };
  const base = requests[0];
  for (const extra of [
    { mediaJoin: { kind: "opaque_media_join", descriptor: "do-not-store" } },
    { descriptor: "do-not-store" },
    { mediaProviderUrl: "https://provider.invalid/room" },
    { headers: { authorization: "Bearer do-not-store" } },
    { credentials: { password: "do-not-store" } },
    { accessToken: "do-not-store" },
    { refreshToken: "do-not-store" },
    { roomToken: "do-not-store" },
    { socketFrame: { type: "private" } },
    { participantDiagnostics: { userId: "private-user" } },
    { serverState: { huddleSessionId: "server-derived" } },
  ]) {
    assert.throws(() => createApplicationChatQueuedHuddleCommandIntent(
      { ...base, ...extra },
      metadata,
    ));
  }
  for (const request of [
    { ...base, unexpected: true },
    { ...base, operation: "restart_huddle" },
    { ...base, conversationId: " " },
    { ...base, idempotencyKey: "x".repeat(256) },
    { operation: "join_huddle", conversationId: "conversation-1", idempotencyKey: "wrong-target" },
    { operation: "set_huddle_screen_share", huddleSessionId: "huddle-1", intent: "toggle", idempotencyKey: "toggle" },
  ]) {
    assert.throws(() => createApplicationChatQueuedHuddleCommandIntent(request, metadata));
  }
  for (const badMetadata of [
    { enqueueOrder: 0, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1.5, enqueuedAt: metadata.enqueuedAt },
    { enqueueOrder: 1, enqueuedAt: "not-a-timestamp" },
    { enqueueOrder: 1, enqueuedAt: "2026-02-30T00:00:00Z" },
  ]) {
    assert.throws(() => createApplicationChatQueuedHuddleCommandIntent(base, badMetadata));
  }

  const validIntent = makeIntent(1);
  assert.throws(() => createApplicationChatQueuedHuddleCommandIntentsRecord(
    identity,
    [{ ...validIntent, unexpected: true }],
  ));
  assert.throws(() => encodeApplicationChatStorageRecord({
    ...createApplicationChatQueuedHuddleCommandIntentsRecord(identity, [validIntent]),
    unexpected: true,
  }));

  const validWire = toWireIntent(validIntent);
  for (const invalidEnvelope of [
    wireEnvelope([{ ...validWire, contractVersion: 2 }]),
    wireEnvelope([{ ...validWire, unexpected: true }]),
    wireEnvelope([{ ...validWire, descriptor: "do-not-store" }]),
    wireEnvelope([{ ...validWire, huddleSessionId: "wrong-shape" }]),
    { ...wireEnvelope([validWire]), unexpected: true },
    { ...wireEnvelope([validWire]), payload: { intents: [validWire], unexpected: true } },
  ]) {
    assert.throws(() => decodeHuddles(JSON.stringify(invalidEnvelope)));
  }

  const oversizedIntent = {
    ...validWire,
    idempotencyKey: "💥".repeat(5_000),
  };
  const encodedIntent = JSON.stringify(oversizedIntent);
  assert.ok(encodedIntent.length <= MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENT_BYTES);
  assert.ok(new TextEncoder().encode(encodedIntent).byteLength >
    MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENT_BYTES);
  assert.throws(
    () => decodeHuddles(JSON.stringify(wireEnvelope([oversizedIntent]))),
    /intent exceeds/,
  );

  const oversizedRecord = `${" ".repeat(MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES)}{}`;
  assert.throws(() => decodeHuddles(oversizedRecord), /storage record exceeds/);
});

test("huddle-command records and adapter reads return detached deeply immutable values", async () => {
  const mutableRequest = {
    operation: "set_huddle_screen_share",
    huddleSessionId: "huddle-mutable",
    intent: "clear",
    idempotencyKey: "immutable-correlation",
  };
  const intent = makeIntent(1, mutableRequest);
  mutableRequest.huddleSessionId = "changed-after-construction";
  mutableRequest.idempotencyKey = "changed-after-construction";
  const record = createApplicationChatQueuedHuddleCommandIntentsRecord(identity, [intent]);
  const { storage } = createMemoryStorage();
  await storage.replace(record);
  const restored = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  );

  assert.equal(intent.request.huddleSessionId, "huddle-mutable");
  assert.equal(record.intents[0].request.idempotencyKey, "immutable-correlation");
  assert.notEqual(record.intents[0], intent);
  assert.notEqual(record.intents[0].request, intent.request);
  assert.notEqual(restored, record);
  assert.notEqual(restored.intents[0].request, record.intents[0].request);
  for (const value of [
    restored,
    restored.identity,
    restored.intents,
    restored.intents[0],
    restored.intents[0].request,
  ]) assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    restored.intents[0].request.intent = "set";
  });
});

test("huddle quarantine, removal, and logout clearing stay within the exact identity boundary", async () => {
  const { rows, storage } = createMemoryStorage();
  const siblings = [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ];
  const ownRecord = createApplicationChatQueuedHuddleCommandIntentsRecord(
    identity,
    [makeIntent(1)],
  );
  const siblingRecords = siblings.map((sibling, index) =>
    createApplicationChatQueuedHuddleCommandIntentsRecord(sibling, [
      makeIntent(1, {
        operation: "start_huddle",
        conversationId: `sibling-conversation-${index}`,
        idempotencyKey: `sibling-idempotency-${index}`,
      }),
    ]));
  const siblingKind = createApplicationChatQueuedSendMessageIntentsRecord(identity, [
    createApplicationChatQueuedSendMessageIntent({
      operation: "send",
      conversationId: "conversation-1",
      content: { format: "plain", text: "preserve sibling kind" },
      clientMessageId: "client-message-1",
      idempotencyKey: "send-idempotency-1",
    }, {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-04T10:00:00Z",
    }),
  ]);

  await storage.replace(ownRecord);
  await storage.replace(siblingKind);
  for (const siblingRecord of siblingRecords) await storage.replace(siblingRecord);

  const encoded = encodeApplicationChatStorageRecord(ownRecord);
  for (const sibling of siblings) assert.throws(() => decodeHuddles(encoded, sibling));

  rows.set(
    rowKey(identity, ApplicationChatStorageRecordKind.queuedHuddleCommandIntents),
    "{corrupt-huddle-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), siblingKind);
  for (let index = 0; index < siblings.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblings[index],
      ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    ), siblingRecords[index]);
  }

  await storage.replace(ownRecord);
  await storage.remove(identity, ApplicationChatStorageRecordKind.queuedHuddleCommandIntents);
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), siblingKind);

  await storage.replace(ownRecord);
  await storage.clearForLogout(identity);
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
  ), null);
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), null);
  for (let index = 0; index < siblings.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblings[index],
      ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    ), siblingRecords[index]);
  }
});
