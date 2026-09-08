import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedConversationCreationIntent,
  createApplicationChatQueuedConversationCreationIntentsRecord,
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

const channelRequest = (suffix = "one", overrides = {}) => ({
  operation: "create_conversation",
  type: "channel",
  name: `Channel ${suffix}`,
  visibility: "public",
  idempotencyKey: `create-${suffix}`,
  clientRequestId: `request-${suffix}`,
  ...overrides,
});

const directRequest = (suffix = "one", overrides = {}) => ({
  operation: "create_conversation",
  type: "direct",
  visibility: "private",
  intendedMemberUserIds: [`member-${suffix}`],
  idempotencyKey: `create-${suffix}`,
  clientRequestId: `request-${suffix}`,
  ...overrides,
});

const groupDirectRequest = (suffix = "one", overrides = {}) => ({
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: [`member-z-${suffix}`, `member-a-${suffix}`],
  idempotencyKey: `create-${suffix}`,
  clientRequestId: `request-${suffix}`,
  ...overrides,
});

const creationIntent = (order, request) =>
  createApplicationChatQueuedConversationCreationIntent(request, {
    enqueueOrder: order,
    enqueuedAt: "2026-09-04T05:00:00.123Z",
  });

const wireEnvelope = (intents, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  identity: envelopeIdentity,
  payload: { intents },
});

const toWireIntent = (intent) => ({
  contractVersion: APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION,
  enqueueOrder: intent.enqueueOrder,
  enqueuedAt: intent.enqueuedAt,
  ...intent.request,
});

const decodeCreation = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  );

test("conversation-creation storage round-trips channel, direct, and group-direct intents", () => {
  const intents = [
    creationIntent(1, channelRequest("channel", {
      visibility: "private",
      entity: { type: "project", id: "project-42" },
    })),
    creationIntent(2, directRequest("direct")),
    creationIntent(3, groupDirectRequest("group")),
  ];
  const record = createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    intents,
  );
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded), wireEnvelope(record.intents.map(toWireIntent)));
  assert.deepEqual(decodeCreation(encoded), record);
  assert.deepEqual(record.intents[2].request.intendedMemberUserIds, [
    "member-a-group",
    "member-z-group",
  ]);
  assert.equal(record.intents[0].request.clientRequestId, "request-channel");
  assert.equal(record.intents[0].request.idempotencyKey, "create-channel");
  assert.equal(record.intents[0].enqueueOrder, 1);
  assert.equal(record.intents[0].enqueuedAt, "2026-09-04T05:00:00.123Z");
});

test("creation logical keys canonicalize participants and include every channel-defining field", () => {
  const originalChannel = creationIntent(1, channelRequest("shared", {
    entity: { type: "project", id: "entity-1" },
  }));
  const duplicateChannel = creationIntent(2, channelRequest("duplicate-correlation", {
    name: "Channel shared",
    entity: { type: "project", id: "entity-1" },
  }));
  const privateChannel = creationIntent(3, channelRequest("private", {
    name: "Channel shared",
    visibility: "private",
    entity: { type: "project", id: "entity-1" },
  }));
  const differentEntity = creationIntent(4, channelRequest("entity", {
    name: "Channel shared",
    entity: { type: "project", id: "entity-2" },
  }));
  const group = creationIntent(5, groupDirectRequest("first", {
    intendedMemberUserIds: ["user-z", "user-a", "user-m"],
  }));
  const reorderedGroup = creationIntent(6, groupDirectRequest("second", {
    intendedMemberUserIds: ["user-m", "user-z", "user-a"],
  }));
  const distinctGroup = creationIntent(7, groupDirectRequest("third", {
    intendedMemberUserIds: ["user-a", "user-n", "user-z"],
  }));

  const record = createApplicationChatQueuedConversationCreationIntentsRecord(identity, [
    originalChannel,
    duplicateChannel,
    privateChannel,
    differentEntity,
    group,
    reorderedGroup,
    distinctGroup,
  ]);

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.clientRequestId,
  ]), [
    [1, "request-shared"],
    [3, "request-private"],
    [4, "request-entity"],
    [5, "request-first"],
    [7, "request-third"],
  ]);
  assert.deepEqual(record.intents[3].request.intendedMemberUserIds, [
    "user-a",
    "user-m",
    "user-z",
  ]);
});

test("creation storage rejects duplicate correlations and non-increasing FIFO order", () => {
  const first = creationIntent(1, channelRequest("first"));
  const duplicateClientRequest = creationIntent(2, directRequest("second", {
    clientRequestId: first.request.clientRequestId,
  }));
  const duplicateIdempotency = creationIntent(2, directRequest("third", {
    idempotencyKey: first.request.idempotencyKey,
  }));

  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    [first, duplicateClientRequest],
  ), /clientRequestId/);
  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    [first, duplicateIdempotency],
  ), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    [creationIntent(2, channelRequest("later")), creationIntent(1, directRequest("earlier"))],
  ), /increasing FIFO order/);
});

test("creation validation rejects malformed, duplicate-member, trusted, unsafe, and non-JSON inputs", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-04T05:00:00Z" };
  const requests = [
    groupDirectRequest("duplicates", { intendedMemberUserIds: ["user-a", "user-a"] }),
    { ...channelRequest("unknown"), unexpected: true },
    { ...channelRequest("trusted"), tenantId: "tenant-injected" },
    { ...channelRequest("nested-trusted"), entity: { type: "project", id: "one", userId: "user-2" } },
    { ...channelRequest("secret"), secret: "do-not-store" },
    { ...channelRequest("authorization"), authorization: "Bearer do-not-store" },
    { ...channelRequest("diagnostic"), diagnostic: { trace: "do-not-store" } },
    { ...directRequest("provider"), providerData: { opaque: true } },
    { ...directRequest("binary"), rawBytes: [1, 2, 3] },
    { ...directRequest("bytes"), intendedMemberUserIds: [1, 2] },
    { ...directRequest("function"), clientRequestId: () => "not-json" },
    { ...channelRequest("thread"), type: "thread" },
  ];
  for (const request of requests) {
    assert.throws(() => createApplicationChatQueuedConversationCreationIntent(
      request,
      metadata,
    ));
  }
  assert.throws(() => createApplicationChatQueuedConversationCreationIntent(
    directRequest("bad-order"),
    { ...metadata, enqueueOrder: 0 },
  ), /positive safe integer/);
  for (const request of [
    channelRequest("long-name", { name: "n".repeat(4_097) }),
    channelRequest("long-key", { idempotencyKey: "i".repeat(513) }),
    channelRequest("long-request", { clientRequestId: "r".repeat(513) }),
    channelRequest("long-entity", { entity: { type: "t".repeat(513), id: "one" } }),
    directRequest("long-member", { intendedMemberUserIds: ["m".repeat(513)] }),
  ]) {
    assert.throws(() => createApplicationChatQueuedConversationCreationIntent(
      request,
      metadata,
    ), /at most/);
  }

  const cyclic = directRequest("cyclic");
  cyclic.loop = cyclic;
  assert.throws(() => createApplicationChatQueuedConversationCreationIntent(
    cyclic,
    metadata,
  ), /circular/);
});

test("creation wire decoding requires exact versions, shapes, and canonical member order", () => {
  const record = createApplicationChatQueuedConversationCreationIntentsRecord(identity, [
    creationIntent(1, groupDirectRequest("wire", {
      intendedMemberUserIds: ["user-z", "user-a"],
    })),
  ]);
  const valid = JSON.parse(encodeApplicationChatStorageRecord(record));
  const malformedValues = [];

  const unsupportedSchema = structuredClone(valid);
  unsupportedSchema.schemaVersion = 2;
  malformedValues.push(unsupportedSchema);
  const unsupportedContract = structuredClone(valid);
  unsupportedContract.payload.intents[0].contractVersion = 2;
  malformedValues.push(unsupportedContract);
  const unknownWireField = structuredClone(valid);
  unknownWireField.payload.intents[0].diagnostic = "unsafe";
  malformedValues.push(unknownWireField);
  const nestedPublicShape = structuredClone(valid);
  nestedPublicShape.payload.intents[0] = {
    contractVersion: 1,
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T05:00:00Z",
    request: groupDirectRequest("nested"),
  };
  malformedValues.push(nestedPublicShape);
  const noncanonicalMembers = structuredClone(valid);
  noncanonicalMembers.payload.intents[0].intendedMemberUserIds = ["user-z", "user-a"];
  malformedValues.push(noncanonicalMembers);

  for (const malformed of malformedValues) {
    assert.throws(() => decodeCreation(JSON.stringify(malformed)));
  }

  const publicIntentWithUnknownField = {
    ...record.intents[0],
    unknown: true,
  };
  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    [publicIntentWithUnknownField],
  ), /exactly/);
});

test("creation storage enforces member, count, per-intent UTF-8, and total-record bounds", () => {
  const tooManyMembers = Array.from(
    { length: MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS + 1 },
    (_, index) => `member-${index}`,
  );
  assert.throws(() => creationIntent(1, groupDirectRequest("members", {
    intendedMemberUserIds: tooManyMembers,
  })), /at most/);

  const oneIntent = creationIntent(1, directRequest("count"));
  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS + 1).fill(oneIntent),
  ), /at most/);

  const utf8Members = Array.from(
    { length: MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS },
    (_, index) => `m${String(index).padStart(3, "0")}-${"\ud83d\udca5".repeat(250)}`,
  );
  assert.throws(() => creationIntent(1, groupDirectRequest("utf8", {
    intendedMemberUserIds: utf8Members,
  })), new RegExp(`intent exceeds ${MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES}`));

  const largeIntents = Array.from(
    { length: MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS },
    (_, index) => {
      const prefix = `Channel ${String(index).padStart(4, "0")}`;
      return creationIntent(index + 1, channelRequest(`large-${index}`, {
        name: prefix + "x".repeat(4_096 - prefix.length),
        entity: { type: "t".repeat(512), id: "i".repeat(512) },
      }));
    },
  );
  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    identity,
    largeIntents,
  ), new RegExp(`record exceeds ${MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES}`));
});

test("creation intents are deeply immutable and detached from caller-owned values", () => {
  const request = groupDirectRequest("detached", {
    intendedMemberUserIds: ["user-z", "user-a"],
  });
  const originalMembers = request.intendedMemberUserIds;
  const intent = creationIntent(1, request);
  request.intendedMemberUserIds.push("user-mutated");
  originalMembers[0] = "user-changed";
  const record = createApplicationChatQueuedConversationCreationIntentsRecord(
    { ...identity },
    [intent],
  );

  assert.deepEqual(intent.request.intendedMemberUserIds, ["user-a", "user-z"]);
  assert.notEqual(record.intents[0], intent);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.identity));
  assert.ok(Object.isFrozen(record.intents));
  assert.ok(Object.isFrozen(record.intents[0]));
  assert.ok(Object.isFrozen(record.intents[0].request));
  assert.ok(Object.isFrozen(record.intents[0].request.intendedMemberUserIds));
  assert.throws(() => record.intents[0].request.intendedMemberUserIds.push("user-x"));

  const channelIntent = creationIntent(2, channelRequest("frozen-entity", {
    entity: { type: "project", id: "project-1" },
  }));
  assert.ok(Object.isFrozen(channelIntent.request.entity));
});

test("creation storage isolates identities and quarantines/removes only the exact creation key", async () => {
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
  const creation = createApplicationChatQueuedConversationCreationIntentsRecord(identity, [
    creationIntent(1, channelRequest("owned")),
  ]);
  const send = createApplicationChatQueuedSendMessageIntentsRecord(identity, [
    createApplicationChatQueuedSendMessageIntent({
      operation: "send",
      conversationId: "conversation-1",
      content: { format: "plain", text: "safe" },
      clientMessageId: "client-1",
      idempotencyKey: "send-1",
    }, { enqueueOrder: 1, enqueuedAt: "2026-09-04T05:00:00Z" }),
  ]);
  const siblingIdentities = [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ];
  const siblingRecords = siblingIdentities.map((siblingIdentity, index) =>
    createApplicationChatQueuedConversationCreationIntentsRecord(siblingIdentity, [
      creationIntent(1, channelRequest(`sibling-${index}`)),
    ]));
  await storage.replace(creation);
  await storage.replace(send);
  for (const sibling of siblingRecords) await storage.replace(sibling);

  const encoded = encodeApplicationChatStorageRecord(creation);
  for (const siblingIdentity of siblingIdentities) {
    assert.throws(() => decodeCreation(encoded, siblingIdentity), /identity/);
  }
  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedConversationCreationIntents),
    "{malformed-creation-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), send);
  for (let index = 0; index < siblingIdentities.length; index += 1) {
    assert.deepEqual(await storage.read(
      siblingIdentities[index],
      ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
    ), siblingRecords[index]);
  }

  await storage.replace(creation);
  await storage.remove(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  );
  assert.equal(rows.has(key(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  )), false);
  assert.equal(rows.has(key(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents)), true);
  for (const siblingIdentity of siblingIdentities) {
    assert.equal(rows.has(key(
      siblingIdentity,
      ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
    )), true);
  }
});
