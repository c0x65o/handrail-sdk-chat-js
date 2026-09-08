import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_CODE,
  APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_MESSAGE,
  APPLICATION_CHAT_MESSAGE_MUTATION_CONTRACT_VERSION,
  APPLICATION_CHAT_READ_CURSOR_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageUnavailableError,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_STORAGE_MUTATION_ATTEMPTS,
  MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENTS,
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENTS,
  createApplicationChatQueuedMessageMutationIntent,
  createApplicationChatQueuedMessageMutationIntentsRecord,
  createApplicationChatQueuedReadCursorIntent,
  createApplicationChatQueuedReadCursorIntentsRecord,
  MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatStorage,
  createNormalizedChatCache,
  decodeApplicationChatStorageRecord,
  encodeApplicationChatStorageRecord,
  parseApplicationChatStorageIdentity,
} from "../dist/client/index.js";

const identity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
});

const siblingTenantIdentity = Object.freeze({
  tenantId: "tenant-2",
  userId: "user-1",
  deviceId: "device-1",
});

const siblingUserIdentity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-2",
  deviceId: "device-1",
});

const siblingDeviceIdentity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-2",
});

const makeRequest = (suffix = "1", overrides = {}) => ({
  operation: "send",
  conversationId: "conversation-1",
  content: { format: "plain", text: `message ${suffix}` },
  clientMessageId: `client-${suffix}`,
  idempotencyKey: `idempotency-${suffix}`,
  ...overrides,
});

const makeIntent = (order = 1, overrides = {}) =>
  createApplicationChatQueuedSendMessageIntent(
    makeRequest(String(order), overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-02T12:00:${String(order).padStart(2, "0")}Z`,
      ...overrides.metadata,
    },
  );

const makeReadBaseline = (overrides = {}) => ({
  conversationId: "conversation-1",
  userId: identity.userId,
  lastReadSequence: 10,
  updatedAt: "2026-09-02T11:59:00Z",
  ...overrides,
});

const makeReadIntent = (
  order = 1,
  operation = "mark_read",
  sequence = order,
  overrides = {},
) => createApplicationChatQueuedReadCursorIntent(
  {
    operation,
    conversationId: "conversation-1",
    ...(operation === "mark_read"
      ? { throughSequence: sequence }
      : { fromSequence: sequence }),
    idempotencyKey: `read-idempotency-${order}`,
    ...overrides.request,
  },
  makeReadBaseline(overrides.baseline),
  {
    enqueueOrder: order,
    enqueuedAt: "2026-09-02T12:00:00Z",
    ...overrides.metadata,
  },
);

const makeMutationRequest = (operation, suffix = "1", overrides = {}) => {
  let request;
  switch (operation) {
    case "forward_message.v1":
      request = {
        operation,
        sourceMessageId: `source-${suffix}`,
        destinationConversationId: `destination-${suffix}`,
        clientCorrelationId: `correlation-${suffix}`,
        idempotencyKey: `mutation-idempotency-${suffix}`,
      };
      break;
    case "edit":
      request = {
        operation,
        messageId: `message-${suffix}`,
        expectedRevision: 1,
        content: { format: "plain", text: `edited ${suffix}` },
        idempotencyKey: `mutation-idempotency-${suffix}`,
      };
      break;
    case "soft_delete":
      request = {
        operation,
        messageId: `message-${suffix}`,
        expectedRevision: 1,
        idempotencyKey: `mutation-idempotency-${suffix}`,
      };
      break;
    case "add_reaction":
    case "remove_reaction":
      request = {
        operation,
        messageId: `message-${suffix}`,
        reactionKey: `reaction-${suffix}`,
        idempotencyKey: `mutation-idempotency-${suffix}`,
      };
      break;
    default:
      throw new Error(`Unsupported test operation: ${operation}`);
  }
  return { ...request, ...overrides };
};

const makeMutationIntent = (
  order,
  operation,
  suffix = String(order),
  overrides = {},
) => createApplicationChatQueuedMessageMutationIntent(
  makeMutationRequest(operation, suffix, overrides.request),
  {
    enqueueOrder: order,
    enqueuedAt: `2026-09-02T13:${String(order).padStart(2, "0")}:00Z`,
    ...overrides.metadata,
  },
);

const makeSnapshot = (cacheIdentity = {
  tenantId: identity.tenantId,
  userId: identity.userId,
  sessionId: "session-1",
}) => JSON.parse(JSON.stringify(createNormalizedChatCache(cacheIdentity).getState()));

const makeNumericSnapshot = () => {
  const snapshot = makeSnapshot();
  snapshot.currentUser.readStates["conversation-1"] = makeReadBaseline();
  snapshot.metadata.lifecycleRevisions["conversation-1"] = 7;
  snapshot.metadata.memberListRevisions["conversation-1"] = 3;
  return snapshot;
};

const wireEnvelope = (kind, payload, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind,
  identity: envelopeIdentity,
  payload,
});

const decodeWire = (wire, expectedIdentity = identity, expectedKind = wire.kind) =>
  decodeApplicationChatStorageRecord(
    JSON.stringify(wire),
    expectedIdentity,
    expectedKind,
  );

test("normalized snapshots and FIFO send intents encode and decode exactly", () => {
  const snapshotRecord = createApplicationChatNormalizedSnapshotRecord(
    identity,
    makeSnapshot(),
  );
  const restoredSnapshot = decodeApplicationChatStorageRecord(
    encodeApplicationChatStorageRecord(snapshotRecord),
    identity,
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(restoredSnapshot, snapshotRecord);
  assert.equal(snapshotRecord.schemaVersion, 2);
  assert.equal(JSON.parse(encodeApplicationChatStorageRecord(snapshotRecord)).schemaVersion, 2);

  const queueRecord = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(1), makeIntent(2)],
  );
  const encodedQueue = encodeApplicationChatStorageRecord(queueRecord);
  assert.deepEqual(JSON.parse(encodedQueue).payload.intents[0], {
    contractVersion: 1,
    enqueueOrder: 1,
    enqueuedAt: "2026-09-02T12:00:01Z",
    conversationId: "conversation-1",
    content: { format: "plain", text: "message 1" },
    clientMessageId: "client-1",
    idempotencyKey: "idempotency-1",
  });
  assert.deepEqual(
    decodeApplicationChatStorageRecord(
      encodedQueue,
      identity,
      ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ),
    queueRecord,
  );
});

test("literal version-1 numeric snapshots migrate to version 2 without changing identity or facts", () => {
  const snapshot = makeNumericSnapshot();
  const legacy = {
    schemaVersion: 1,
    kind: "normalized_snapshot",
    identity,
    payload: { snapshot },
  };
  const migrated = decodeWire(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.identity, identity);
  assert.deepEqual(migrated.snapshot, snapshot);
  assert.equal(migrated.snapshot.currentUser.readStates["conversation-1"].lastReadSequence, 10);
  assert.equal(migrated.snapshot.metadata.lifecycleRevisions["conversation-1"], 7);
  assert.equal(migrated.snapshot.metadata.memberListRevisions["conversation-1"], 3);
  const encoded = encodeApplicationChatStorageRecord(migrated);
  assert.deepEqual(JSON.parse(encoded), { ...legacy, schemaVersion: 2 });
  const fresh = createApplicationChatNormalizedSnapshotRecord(identity, snapshot);
  assert.equal(fresh.schemaVersion, 2);
  assert.equal(encodeApplicationChatStorageRecord(fresh), encoded);
  assert.deepEqual(decodeWire(JSON.parse(encoded)), fresh);
  assert.throws(() => decodeWire({ ...legacy, schemaVersion: 3 }), /Unsupported.*schema version: 3/);
});

test("queued read-cursor intents encode, normalize, and decode exactly", () => {
  const queueRecord = createApplicationChatQueuedReadCursorIntentsRecord(identity, [
    makeReadIntent(1, "mark_read", 10),
    makeReadIntent(2, "mark_read", 12),
    makeReadIntent(3, "mark_unread", 4),
    makeReadIntent(4, "mark_read", 14),
  ]);
  assert.deepEqual(
    queueRecord.intents.map((intent) => [
      intent.enqueueOrder,
      intent.request.operation,
      intent.request.idempotencyKey,
    ]),
    [
      [1, "mark_read", "read-idempotency-1"],
      [3, "mark_unread", "read-idempotency-3"],
      [4, "mark_read", "read-idempotency-4"],
    ],
  );

  const encoded = encodeApplicationChatStorageRecord(queueRecord);
  assert.deepEqual(JSON.parse(encoded).payload.intents[0], {
    contractVersion: APPLICATION_CHAT_READ_CURSOR_CONTRACT_VERSION,
    enqueueOrder: 1,
    enqueuedAt: "2026-09-02T12:00:00Z",
    operation: "mark_read",
    conversationId: "conversation-1",
    throughSequence: 12,
    idempotencyKey: "read-idempotency-1",
    acknowledgedReadState: makeReadBaseline(),
  });
  assert.deepEqual(
    decodeApplicationChatStorageRecord(
      encoded,
      identity,
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    ),
    queueRecord,
  );
  assert.throws(() => decodeApplicationChatStorageRecord(
    encoded,
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ));
});

test("all queued message-mutation variants encode and decode exactly", () => {
  const intents = [
    makeMutationIntent(1, "forward_message.v1"),
    makeMutationIntent(2, "edit"),
    makeMutationIntent(3, "soft_delete"),
    makeMutationIntent(4, "add_reaction"),
    makeMutationIntent(5, "remove_reaction"),
  ];
  const record = createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    intents,
  );
  const encoded = encodeApplicationChatStorageRecord(record);
  assert.deepEqual(JSON.parse(encoded).payload.intents, intents.map((intent) => ({
    contractVersion: APPLICATION_CHAT_MESSAGE_MUTATION_CONTRACT_VERSION,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  })));
  assert.deepEqual(
    decodeApplicationChatStorageRecord(
      encoded,
      identity,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ),
    record,
  );
  for (const mismatch of [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ]) {
    assert.throws(() => decodeApplicationChatStorageRecord(
      encoded,
      mismatch,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ));
  }
});

test("message-mutation lanes coalesce in place while reactions stop at intervening work", () => {
  const record = createApplicationChatQueuedMessageMutationIntentsRecord(identity, [
    makeMutationIntent(1, "edit", "shared-message", {
      request: { idempotencyKey: "edit-original" },
    }),
    makeMutationIntent(2, "forward_message.v1", "shared-forward", {
      request: { idempotencyKey: "forward-original", clientCorrelationId: "forward-correlation-1" },
    }),
    makeMutationIntent(3, "add_reaction", "shared-reaction", {
      request: { idempotencyKey: "reaction-original" },
    }),
    makeMutationIntent(4, "soft_delete", "shared-message", {
      request: { idempotencyKey: "delete-replacement", expectedRevision: 2 },
    }),
    makeMutationIntent(5, "forward_message.v1", "shared-forward", {
      request: { idempotencyKey: "forward-replacement", clientCorrelationId: "forward-correlation-2" },
    }),
    makeMutationIntent(6, "remove_reaction", "shared-reaction", {
      request: { idempotencyKey: "reaction-replacement" },
    }),
    makeMutationIntent(7, "edit", "other-message"),
  ]);

  assert.deepEqual(record.intents.map((intent) => ({
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    operation: intent.request.operation,
    idempotencyKey: intent.request.idempotencyKey,
  })), [
    {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-02T13:01:00Z",
      operation: "soft_delete",
      idempotencyKey: "delete-replacement",
    },
    {
      enqueueOrder: 2,
      enqueuedAt: "2026-09-02T13:02:00Z",
      operation: "forward_message.v1",
      idempotencyKey: "forward-replacement",
    },
    {
      enqueueOrder: 3,
      enqueuedAt: "2026-09-02T13:03:00Z",
      operation: "add_reaction",
      idempotencyKey: "reaction-original",
    },
    {
      enqueueOrder: 6,
      enqueuedAt: "2026-09-02T13:06:00Z",
      operation: "remove_reaction",
      idempotencyKey: "reaction-replacement",
    },
    {
      enqueueOrder: 7,
      enqueuedAt: "2026-09-02T13:07:00Z",
      operation: "edit",
      idempotencyKey: "mutation-idempotency-other-message",
    },
  ]);
  assert.equal(record.intents[1].request.clientCorrelationId, "forward-correlation-2");
});

test("message-mutation queues reject duplicate correlations, keys, and FIFO order", () => {
  assert.throws(() => createApplicationChatQueuedMessageMutationIntentsRecord(identity, [
    makeMutationIntent(2, "edit"),
    makeMutationIntent(1, "soft_delete"),
  ]), /strictly increasing FIFO/);
  assert.throws(() => createApplicationChatQueuedMessageMutationIntentsRecord(identity, [
    makeMutationIntent(1, "forward_message.v1", "one", {
      request: { clientCorrelationId: "duplicate-correlation" },
    }),
    makeMutationIntent(2, "forward_message.v1", "two", {
      request: { clientCorrelationId: "duplicate-correlation" },
    }),
  ]), /clientCorrelationId values must be unique/);
  assert.throws(() => createApplicationChatQueuedMessageMutationIntentsRecord(identity, [
    makeMutationIntent(1, "edit", "one", {
      request: { idempotencyKey: "duplicate-key" },
    }),
    makeMutationIntent(2, "add_reaction", "two", {
      request: { idempotencyKey: "duplicate-key" },
    }),
  ]), /idempotencyKey values must be unique/);
});

test("queued read-cursor wire parsing rejects identity, version, keys, and payload drift", () => {
  const record = createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    [makeReadIntent(1, "mark_unread", 4)],
  );
  const wire = JSON.parse(encodeApplicationChatStorageRecord(record));
  for (const mismatch of [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ]) {
    assert.throws(() => decodeWire(wire, mismatch));
  }
  for (const invalid of [
    { ...wire, schemaVersion: 2 },
    { ...wire, kind: "queued_send_message_intents" },
    { ...wire, unexpected: true },
    { ...wire, payload: { ...wire.payload, unexpected: true } },
    { ...wire, payload: { intents: {} } },
    {
      ...wire,
      payload: {
        intents: [{ ...wire.payload.intents[0], contractVersion: 2 }],
      },
    },
    {
      ...wire,
      payload: {
        intents: [{ ...wire.payload.intents[0], throughSequence: 5 }],
      },
    },
    {
      ...wire,
      payload: {
        intents: [{
          ...wire.payload.intents[0],
          acknowledgedReadState: {
            ...wire.payload.intents[0].acknowledgedReadState,
            rawError: "no",
          },
        }],
      },
    },
  ]) {
    assert.throws(() => decodeWire(invalid));
  }
  assert.throws(() => createApplicationChatQueuedReadCursorIntent(
    { ...makeReadIntent(1, "mark_read", 10).request, unexpected: true },
    makeReadBaseline(),
    { enqueueOrder: 1, enqueuedAt: "2026-09-02T12:00:00Z" },
  ));
  assert.throws(() => createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    [makeReadIntent(1, "mark_read", 10, { baseline: { userId: "user-2" } })],
  ));
  assert.throws(() => encodeApplicationChatStorageRecord({
    ...record,
    unexpected: true,
  }));
  assert.throws(() => createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    [{ ...makeReadIntent(1, "mark_read", 10), unexpected: true }],
  ));
});

test("record parsing rejects non-JSON, versions, kinds, keys, and payload shapes", () => {
  assert.throws(() =>
    decodeApplicationChatStorageRecord(
      "not-json",
      identity,
      ApplicationChatStorageRecordKind.normalizedSnapshot,
    ),
  );

  const validPayload = { snapshot: makeSnapshot() };
  const invalid = [
    { ...wireEnvelope("normalized_snapshot", validPayload), schemaVersion: 3 },
    wireEnvelope("future_record_kind", validPayload),
    { ...wireEnvelope("normalized_snapshot", validPayload), unexpected: true },
    wireEnvelope("normalized_snapshot", { ...validPayload, unexpected: true }),
    wireEnvelope("normalized_snapshot", {}),
    wireEnvelope("queued_send_message_intents", { intents: {} }),
    wireEnvelope("queued_send_message_intents", {
      intents: [{
        contractVersion: 2,
        enqueueOrder: 1,
        enqueuedAt: "2026-09-02T12:00:01Z",
        conversationId: "conversation-1",
        content: { format: "plain", text: "hello" },
        clientMessageId: "client-1",
        idempotencyKey: "idempotency-1",
      }],
    }),
    wireEnvelope("queued_send_message_intents", {
      intents: [{
        contractVersion: 1,
        enqueueOrder: 1,
        enqueuedAt: "2026-09-02T12:00:01Z",
        conversationId: "conversation-1",
        content: { format: "plain", text: "hello" },
        clientMessageId: "client-1",
        idempotencyKey: "idempotency-1",
        unknown: true,
      }],
    }),
  ];
  for (const candidate of invalid) {
    assert.throws(() => decodeWire(candidate));
  }
});

test("tenant, user, device, and snapshot identities are isolated", () => {
  const encoded = encodeApplicationChatStorageRecord(
    createApplicationChatNormalizedSnapshotRecord(identity, makeSnapshot()),
  );
  for (const mismatch of [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ]) {
    assert.throws(() =>
      decodeApplicationChatStorageRecord(
        encoded,
        mismatch,
        ApplicationChatStorageRecordKind.normalizedSnapshot,
      ),
    );
  }
  assert.throws(() =>
    createApplicationChatNormalizedSnapshotRecord(
      identity,
      makeSnapshot({ tenantId: "tenant-2", userId: "user-1", sessionId: "session-1" }),
    ),
  );
  assert.throws(() =>
    createApplicationChatNormalizedSnapshotRecord(
      identity,
      makeSnapshot({ tenantId: "tenant-1", userId: "user-2", sessionId: "session-1" }),
    ),
  );
  assert.throws(() => parseApplicationChatStorageIdentity({ ...identity, accessToken: "no" }));
  assert.throws(() => parseApplicationChatStorageIdentity({ ...identity, deviceId: " " }));
});

test("validated values are deeply frozen and detached from mutable input", () => {
  const mutableSnapshot = makeSnapshot();
  const snapshotRecord = createApplicationChatNormalizedSnapshotRecord(identity, mutableSnapshot);
  mutableSnapshot.identity.userId = "changed-user";
  assert.equal(snapshotRecord.snapshot.identity.userId, identity.userId);
  assert.ok(Object.isFrozen(snapshotRecord));
  assert.ok(Object.isFrozen(snapshotRecord.identity));
  assert.ok(Object.isFrozen(snapshotRecord.snapshot.entities));

  const request = makeRequest("detached", {
    content: {
      format: "plain",
      text: "before",
      blocks: [{ type: "safe", data: { label: "before" } }],
    },
  });
  const intent = createApplicationChatQueuedSendMessageIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-02T12:00:01Z",
  });
  request.content.text = "after";
  request.content.blocks[0].data.label = "after";
  assert.equal(intent.request.content.text, "before");
  assert.equal(intent.request.content.blocks[0].data.label, "before");
  assert.ok(Object.isFrozen(intent.request.content.blocks[0].data));
  assert.throws(() => {
    intent.request.content.blocks[0].data.label = "mutated";
  });

  const readRequest = {
    operation: "mark_unread",
    conversationId: "conversation-1",
    fromSequence: 4,
    idempotencyKey: "read-detached",
  };
  const baseline = makeReadBaseline({ manualUnreadFromSequence: 6 });
  const readIntent = createApplicationChatQueuedReadCursorIntent(
    readRequest,
    baseline,
    { enqueueOrder: 1, enqueuedAt: "2026-09-02T12:00:00Z" },
  );
  readRequest.idempotencyKey = "mutated";
  baseline.lastReadSequence = 99;
  assert.equal(readIntent.request.idempotencyKey, "read-detached");
  assert.equal(readIntent.acknowledgedReadState.lastReadSequence, 10);
  assert.ok(Object.isFrozen(readIntent));
  assert.ok(Object.isFrozen(readIntent.request));
  assert.ok(Object.isFrozen(readIntent.acknowledgedReadState));
  assert.throws(() => {
    readIntent.acknowledgedReadState.lastReadSequence = 20;
  });
});

test("message-mutation values are deeply frozen and detached", () => {
  const request = makeMutationRequest("edit", "detached", {
    content: {
      format: "plain",
      text: "before",
      blocks: [{ type: "safe", data: { label: "before" } }],
    },
  });
  const intent = createApplicationChatQueuedMessageMutationIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-02T13:01:00Z",
  });
  request.content.text = "after";
  request.content.blocks[0].data.label = "after";
  const record = createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    [intent],
  );

  assert.equal(intent.request.content.text, "before");
  assert.equal(intent.request.content.blocks[0].data.label, "before");
  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(intent.request));
  assert.ok(Object.isFrozen(intent.request.content.blocks[0].data));
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.intents));
  assert.notEqual(record.intents[0], intent);
  assert.throws(() => {
    record.intents[0].request.content.blocks[0].data.label = "mutated";
  });
});

test("message-mutation count, per-intent, and total-record byte limits are enforced", () => {
  const oneIntent = makeMutationIntent(1, "edit");
  assert.throws(() => createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENTS + 1).fill(oneIntent),
  ), /at most/);

  const validWire = JSON.parse(encodeApplicationChatStorageRecord(
    createApplicationChatQueuedMessageMutationIntentsRecord(identity, [oneIntent]),
  ));
  validWire.payload.intents[0].content.text = "x".repeat(
    MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENT_BYTES,
  );
  assert.throws(() => decodeWire(validWire), /intent exceeds/);

  const aggregate = Array.from({ length: 60 }, (_, index) =>
    makeMutationIntent(index + 1, "edit", `aggregate-${index}`, {
      request: {
        content: { format: "plain", text: "x".repeat(90_000) },
      },
      metadata: { enqueuedAt: "2026-09-02T13:00:00Z" },
    }));
  assert.throws(() => createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    aggregate,
  ), /storage record exceeds/);
});

test("message-mutation inputs reject malformed, secret-bearing, and non-command material", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-02T13:01:00Z" };
  for (const request of [
    { ...makeMutationRequest("forward_message.v1"), accessToken: "secret" },
    { ...makeMutationRequest("forward_message.v1"), userId: "trusted-user" },
    { ...makeMutationRequest("soft_delete"), diagnostics: { stack: "raw" } },
    { ...makeMutationRequest("add_reaction"), providerData: { name: "external" } },
    { ...makeMutationRequest("remove_reaction"), unexpected: true },
    {
      ...makeMutationRequest("edit"),
      content: {
        format: "plain",
        text: "unsafe",
        blocks: [{ type: "unsafe", data: { providerData: { opaque: true } } }],
      },
    },
    {
      ...makeMutationRequest("edit"),
      content: {
        format: "plain",
        text: "unsafe",
        blocks: [{ type: "unsafe", data: { attachmentBytes: [0, 1, 2] } }],
      },
    },
    { operation: "toggle_reaction", messageId: "message-1" },
  ]) {
    assert.throws(() => createApplicationChatQueuedMessageMutationIntent(
      request,
      metadata,
    ));
  }

  const record = createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    [makeMutationIntent(1, "soft_delete")],
  );
  assert.throws(() => createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    [{ ...record.intents[0], accessToken: "secret" }],
  ));
  const wire = JSON.parse(encodeApplicationChatStorageRecord(record));
  wire.payload.intents[0].credentials = { password: "secret" };
  assert.throws(() => decodeWire(wire));
});

test("the adapter round trip, quarantine, and logout clear stay exactly scoped", async () => {
  const rows = new Map();
  const clearCalls = [];
  const key = (recordIdentity, kind) =>
    `${recordIdentity.tenantId}\u0000${recordIdentity.userId}\u0000${recordIdentity.deviceId}\u0000${kind}`;
  const identityPrefix = (recordIdentity) =>
    `${recordIdentity.tenantId}\u0000${recordIdentity.userId}\u0000${recordIdentity.deviceId}\u0000`;
  const adapter = {
    async read(recordIdentity, kind) {
      return rows.get(key(recordIdentity, kind)) ?? null;
    },
    async replace(recordIdentity, kind, encoded) {
      rows.set(key(recordIdentity, kind), encoded);
    },
    async remove(recordIdentity, kind) {
      rows.delete(key(recordIdentity, kind));
    },
    async clearForLogout(recordIdentity) {
      clearCalls.push(recordIdentity);
      const prefix = identityPrefix(recordIdentity);
      for (const rowKey of rows.keys()) {
        if (rowKey.startsWith(prefix)) rows.delete(rowKey);
      }
    },
  };
  const storage = createApplicationChatStorage(adapter);
  const snapshot = createApplicationChatNormalizedSnapshotRecord(identity, makeNumericSnapshot());
  const ownQueue = createApplicationChatQueuedSendMessageIntentsRecord(identity, [makeIntent(1), makeIntent(2)]);
  const siblingUserQueue = createApplicationChatQueuedSendMessageIntentsRecord(
    siblingUserIdentity,
    [makeIntent(1)],
  );
  const siblingDeviceQueue = createApplicationChatQueuedSendMessageIntentsRecord(
    siblingDeviceIdentity,
    [makeIntent(1)],
  );
  const ownReadQueue = createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    [
      makeReadIntent(1, "mark_read", 10),
      makeReadIntent(2, "mark_read", 12),
      makeReadIntent(3, "mark_unread", 4),
      makeReadIntent(4, "mark_read", 14),
    ],
  );
  const siblingReadQueue = createApplicationChatQueuedReadCursorIntentsRecord(
    siblingUserIdentity,
    [makeReadIntent(1, "mark_read", 10, { baseline: { userId: siblingUserIdentity.userId } })],
  );
  await storage.replace(snapshot);
  await storage.replace(ownQueue);
  await storage.replace(siblingUserQueue);
  await storage.replace(siblingDeviceQueue);
  await storage.replace(ownReadQueue);
  await storage.replace(siblingReadQueue);

  const queueEncodings = [ownQueue, ownReadQueue].map((record) => {
    const encoded = encodeApplicationChatStorageRecord(record);
    const wire = JSON.parse(encoded);
    assert.equal(record.schemaVersion, 1);
    assert.equal(wire.schemaVersion, 1);
    assert.throws(() => decodeWire({ ...wire, schemaVersion: 2 }), /Unsupported.*schema version: 2/);
    return encoded;
  });
  assert.deepEqual(ownQueue.intents, [makeIntent(1), makeIntent(2)]);
  // Adjacent mark_read intents coalesce using the first retry key and order.
  assert.deepEqual(ownReadQueue.intents, [
    makeReadIntent(1, "mark_read", 12),
    makeReadIntent(3, "mark_unread", 4),
    makeReadIntent(4, "mark_read", 14),
  ]);
  const assertQueuesUnchanged = async () => {
    for (const [index, record] of [ownQueue, ownReadQueue].entries()) {
      assert.equal(rows.get(key(identity, record.kind)), queueEncodings[index]);
      assert.deepEqual(decodeApplicationChatStorageRecord(
        queueEncodings[index], identity, record.kind,
      ), record);
      assert.deepEqual(await storage.read(identity, record.kind), record);
      assert.equal(rows.get(key(identity, record.kind)), queueEncodings[index]);
    }
  };
  await assertQueuesUnchanged();

  const siblingSnapshots = [siblingTenantIdentity, siblingUserIdentity, siblingDeviceIdentity]
    .map((recordIdentity) => createApplicationChatNormalizedSnapshotRecord(
      recordIdentity,
      makeSnapshot({
        tenantId: recordIdentity.tenantId,
        userId: recordIdentity.userId,
        sessionId: "session-1",
      }),
    ));
  for (const record of siblingSnapshots) await storage.replace(record);
  const snapshotKey = key(identity, snapshot.kind);
  const legacyWire = {
    schemaVersion: 1,
    kind: snapshot.kind,
    identity,
    payload: { snapshot: snapshot.snapshot },
  };
  rows.set(snapshotKey, JSON.stringify(legacyWire));
  const migrated = await storage.read(identity, snapshot.kind);
  assert.deepEqual(migrated, snapshot);
  await assertQueuesUnchanged();
  await storage.replace(migrated);
  assert.equal(JSON.parse(rows.get(snapshotKey)).schemaVersion, 2);
  assert.deepEqual(await storage.read(identity, snapshot.kind), snapshot);
  await assertQueuesUnchanged();

  const rowsBeforeRejection = new Map(rows);
  rowsBeforeRejection.delete(snapshotKey);
  rows.set(snapshotKey, JSON.stringify({ ...legacyWire, schemaVersion: 3 }));
  await assert.rejects(() => storage.read(identity, snapshot.kind), /record failed validation/);
  assert.equal(await storage.read(identity, snapshot.kind), null);
  assert.deepEqual(rows, rowsBeforeRejection);
  await assertQueuesUnchanged();
  for (const record of siblingSnapshots) {
    assert.deepEqual(await storage.read(record.identity, record.kind), record);
  }
  await storage.replace(snapshot);
  await assertQueuesUnchanged();
  assert.deepEqual(
    await storage.read(identity, ApplicationChatStorageRecordKind.normalizedSnapshot),
    snapshot,
  );
  const restoredReadQueue = await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  );
  assert.deepEqual(restoredReadQueue, ownReadQueue);
  assert.ok(Object.isFrozen(restoredReadQueue));
  assert.ok(Object.isFrozen(restoredReadQueue.intents));
  assert.ok(Object.isFrozen(restoredReadQueue.intents[0].acknowledgedReadState));

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
    encodeApplicationChatStorageRecord(siblingUserQueue),
  );
  await assert.rejects(() =>
    storage.read(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
  );
  assert.equal(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
    null,
  );
  assert.deepEqual(
    await storage.read(identity, ApplicationChatStorageRecordKind.normalizedSnapshot),
    snapshot,
  );
  assert.deepEqual(
    await storage.read(
      siblingUserIdentity,
      ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ),
    siblingUserQueue,
  );
  await storage.replace(ownQueue);

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents),
    "{corrupt-read-cursor-record",
  );
  await assert.rejects(() =>
    storage.read(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents),
  );
  assert.equal(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents),
    null,
  );
  assert.deepEqual(
    await storage.read(identity, ApplicationChatStorageRecordKind.normalizedSnapshot),
    snapshot,
  );
  assert.deepEqual(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
    ownQueue,
  );
  assert.deepEqual(
    await storage.read(
      siblingUserIdentity,
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    ),
    siblingReadQueue,
  );
  await storage.replace(ownReadQueue);
  await storage.remove(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents);
  assert.equal(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents),
    null,
  );
  assert.deepEqual(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
    ownQueue,
  );

  const mutableLogoutIdentity = { ...identity };
  await storage.clearForLogout(mutableLogoutIdentity);
  mutableLogoutIdentity.userId = "mutated-after-clear";

  assert.equal(clearCalls.length, 1);
  assert.deepEqual(clearCalls[0], identity);
  assert.notEqual(clearCalls[0], mutableLogoutIdentity);
  assert.ok(Object.isFrozen(clearCalls[0]));
  assert.equal(
    await storage.read(identity, ApplicationChatStorageRecordKind.normalizedSnapshot),
    null,
  );
  assert.equal(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
    null,
  );
  assert.equal(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents),
    null,
  );
  assert.deepEqual(
    await storage.read(
      siblingUserIdentity,
      ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ),
    siblingUserQueue,
  );
  assert.deepEqual(
    await storage.read(
      siblingDeviceIdentity,
      ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ),
    siblingDeviceQueue,
  );
  assert.deepEqual(
    await storage.read(
      siblingUserIdentity,
      ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    ),
    siblingReadQueue,
  );
  assert.equal("clear" in storage, false);
  assert.equal("compareExchange" in storage, false);
});

test("compareExchange commits exact matches and remains isolated by identity and kind", async () => {
  const rows = new Map();
  const calls = [];
  const key = (recordIdentity, kind) =>
    `${recordIdentity.tenantId}\u0000${recordIdentity.userId}\u0000${recordIdentity.deviceId}\u0000${kind}`;
  const adapter = {
    async read(recordIdentity, kind) {
      return rows.get(key(recordIdentity, kind)) ?? null;
    },
    async replace(recordIdentity, kind, encoded) {
      rows.set(key(recordIdentity, kind), encoded);
    },
    async remove(recordIdentity, kind) {
      rows.delete(key(recordIdentity, kind));
    },
    async compareExchange(
      recordIdentity,
      kind,
      expectedEncodedRecord,
      replacementEncodedRecord,
    ) {
      calls.push({
        identity: recordIdentity,
        kind,
        expectedEncodedRecord,
        replacementEncodedRecord,
      });
      const rowKey = key(recordIdentity, kind);
      const current = rows.get(rowKey) ?? null;
      if (current !== expectedEncodedRecord) return false;
      if (replacementEncodedRecord === null) rows.delete(rowKey);
      else rows.set(rowKey, replacementEncodedRecord);
      return true;
    },
    async clearForLogout() {},
  };
  const storage = createApplicationChatStorage(adapter);
  assert.equal(typeof storage.compareExchange, "function");

  const identities = [
    identity,
    siblingTenantIdentity,
    siblingUserIdentity,
    siblingDeviceIdentity,
  ];
  const queues = identities.map((recordIdentity) =>
    createApplicationChatQueuedSendMessageIntentsRecord(
      recordIdentity,
      [makeIntent(1)],
    ));
  const ownReplacement = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(2)],
  );
  const ownReadQueue = createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    [makeReadIntent(1, "mark_read", 10)],
  );
  for (const queue of queues) await storage.replace(queue);
  await storage.replace(ownReadQueue);

  const ownExpectedEncoded = encodeApplicationChatStorageRecord(queues[0]);
  const ownReplacementEncoded = encodeApplicationChatStorageRecord(ownReplacement);
  assert.equal(await storage.compareExchange(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ownExpectedEncoded,
    ownReplacementEncoded,
  ), true);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), ownReplacement);

  assert.equal(await storage.compareExchange(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ownExpectedEncoded,
    null,
  ), false);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), ownReplacement);

  for (let index = 1; index < identities.length; index += 1) {
    assert.deepEqual(await storage.read(
      identities[index],
      ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ), queues[index]);
  }
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  ), ownReadQueue);

  assert.equal(await storage.compareExchange(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    ownReplacementEncoded,
    null,
  ), true);
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), null);

  assert.equal(await storage.compareExchange(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    null,
    ownExpectedEncoded,
  ), true);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), queues[0]);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].identity, identity);
  assert.notEqual(calls[0].identity, identity);
  assert.ok(Object.isFrozen(calls[0].identity));
  assert.equal(calls[0].expectedEncodedRecord, ownExpectedEncoded);
  assert.equal(calls[0].replacementEncodedRecord, ownReplacementEncoded);
});

test("compareExchange rejects malformed arguments privately before adapter invocation", async () => {
  let compareExchangeCallCount = 0;
  assert.throws(() => createApplicationChatStorage({
    async read() { return null; },
    async replace() {},
    async remove() {},
    compareExchange: false,
    async clearForLogout() {},
  }), /adapter\.compareExchange must be a function when provided/);

  const storage = createApplicationChatStorage({
    async read() { return null; },
    async replace() {},
    async remove() {},
    async compareExchange() {
      compareExchangeCallCount += 1;
      return true;
    },
    async clearForLogout() {},
  });
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const validEncoded = encodeApplicationChatStorageRecord(
    createApplicationChatQueuedSendMessageIntentsRecord(identity, [makeIntent(1)]),
  );
  const siblingEncoded = encodeApplicationChatStorageRecord(
    createApplicationChatQueuedSendMessageIntentsRecord(
      siblingUserIdentity,
      [makeIntent(1)],
    ),
  );
  const secret = "private-record-content-do-not-echo";
  const invalidCalls = [
    () => storage.compareExchange({ ...identity, unexpected: true }, kind, null, null),
    () => storage.compareExchange(identity, "unknown-kind", null, null),
    () => storage.compareExchange(identity, kind, undefined, null),
    () => storage.compareExchange(identity, kind, null, { encoded: validEncoded }),
    () => storage.compareExchange(identity, kind, `{\"secret\":\"${secret}\"}`, null),
    () => storage.compareExchange(identity, kind, null, `{\"secret\":\"${secret}\"}`),
    () => storage.compareExchange(identity, kind, siblingEncoded, null),
  ];
  for (const invoke of invalidCalls) {
    await assert.rejects(invoke, (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(validEncoded), false);
      assert.equal(error.message.includes(siblingEncoded), false);
      return true;
    });
  }
  assert.equal(compareExchangeCallCount, 0);
});

test("mutate creates, updates, and removes a validated record with an atomic adapter", async () => {
  let encoded = null;
  const adapter = {
    async read() { return encoded; },
    async replace(_identity, _kind, replacement) { encoded = replacement; },
    async remove() { encoded = null; },
    async compareExchange(_identity, _kind, expected, replacement) {
      if (encoded !== expected) return false;
      encoded = replacement;
      return true;
    },
    async clearForLogout() {},
  };
  const storage = createApplicationChatStorage(adapter);
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;

  const created = await storage.mutate(identity, kind, (current) => {
    assert.equal(current, null);
    return createApplicationChatQueuedSendMessageIntentsRecord(identity, [makeIntent(1)]);
  });
  assert.deepEqual(created.intents, [makeIntent(1)]);

  const updated = await storage.mutate(identity, kind, (current) =>
    createApplicationChatQueuedSendMessageIntentsRecord(
      identity,
      [...current.intents, makeIntent(2)],
    ));
  assert.deepEqual(updated.intents, [makeIntent(1), makeIntent(2)]);

  assert.equal(await storage.mutate(identity, kind, () => null), null);
  assert.equal(encoded, null);
});

test("two tabs sharing storage retry compare/exchange and preserve distinct intents", async () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  let encoded = encodeApplicationChatStorageRecord(
    createApplicationChatQueuedSendMessageIntentsRecord(identity, [makeIntent(1)]),
  );
  let firstReadCount = 0;
  let releaseFirstReads;
  const firstReads = new Promise((resolve) => { releaseFirstReads = resolve; });
  const adapter = {
    async read() {
      const captured = encoded;
      firstReadCount += 1;
      if (firstReadCount <= 2) {
        if (firstReadCount === 2) releaseFirstReads();
        await firstReads;
      }
      return captured;
    },
    async replace(_identity, _kind, replacement) { encoded = replacement; },
    async remove() { encoded = null; },
    async compareExchange(_identity, _kind, expected, replacement) {
      if (encoded !== expected) return false;
      encoded = replacement;
      return true;
    },
    async clearForLogout() {},
  };
  const tabAStorage = createApplicationChatStorage(adapter);
  const tabBStorage = createApplicationChatStorage(adapter);
  const append = (intent) => (current) =>
    createApplicationChatQueuedSendMessageIntentsRecord(
      identity,
      [...current.intents, intent].sort(
        (left, right) => left.enqueueOrder - right.enqueueOrder,
      ),
    );

  await Promise.all([
    tabAStorage.mutate(identity, kind, append(makeIntent(2))),
    tabBStorage.mutate(identity, kind, append(makeIntent(3))),
  ]);

  const restored = await tabAStorage.read(identity, kind);
  assert.deepEqual(restored.intents, [makeIntent(1), makeIntent(2), makeIntent(3)]);
  assert.equal(firstReadCount, 4);
});

test("a conditional mutation removal cannot erase a concurrent replacement", async () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const original = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(1)],
  );
  const replacement = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(2)],
  );
  const originalEncoded = encodeApplicationChatStorageRecord(original);
  const replacementEncoded = encodeApplicationChatStorageRecord(replacement);
  let encoded = originalEncoded;
  let compareCount = 0;
  const storage = createApplicationChatStorage({
    async read() { return encoded; },
    async replace(_identity, _kind, value) { encoded = value; },
    async remove() { encoded = null; },
    async compareExchange(_identity, _kind, expected, value) {
      compareCount += 1;
      if (compareCount === 1) encoded = replacementEncoded;
      if (encoded !== expected) return false;
      encoded = value;
      return true;
    },
    async clearForLogout() {},
  });

  const result = await storage.mutate(identity, kind, (current) =>
    current?.intents[0]?.request.clientMessageId === "client-1" ? null : current);

  assert.deepEqual(result, replacement);
  assert.deepEqual(await storage.read(identity, kind), replacement);
  assert.equal(compareCount, 2);
});

test("atomic corrupt quarantine preserves a valid concurrent replacement", async () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const malformed = '{"private":"malformed-record-content"';
  const valid = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(1)],
  );
  const validEncoded = encodeApplicationChatStorageRecord(valid);
  let encoded = malformed;
  let removeCount = 0;
  let expectedQuarantineValue;
  const storage = createApplicationChatStorage({
    async read() { return encoded; },
    async replace(_identity, _kind, value) { encoded = value; },
    async remove() { removeCount += 1; encoded = null; },
    async compareExchange(_identity, _kind, expected, value) {
      expectedQuarantineValue = expected;
      encoded = validEncoded;
      if (encoded !== expected) return false;
      encoded = value;
      return true;
    },
    async clearForLogout() {},
  });

  await assert.rejects(
    () => storage.read(identity, kind),
    (error) => {
      assert.equal(error.name, "ApplicationChatStorageValidationError");
      assert.equal(error.message, "Application chat storage record failed validation");
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
  assert.equal(expectedQuarantineValue, malformed);
  assert.equal(removeCount, 0);
  assert.deepEqual(await storage.read(identity, kind), valid);
});

test("mutate retains single-writer behavior without compareExchange", async () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  let encoded = null;
  let replaceCount = 0;
  let removeCount = 0;
  const storage = createApplicationChatStorage({
    async read() { return encoded; },
    async replace(_identity, _kind, value) { replaceCount += 1; encoded = value; },
    async remove() { removeCount += 1; encoded = null; },
    async clearForLogout() {},
  });
  const record = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(1)],
  );

  assert.deepEqual(await storage.mutate(identity, kind, () => record), record);
  assert.deepEqual(await storage.mutate(identity, kind, (current) => current), record);
  assert.equal(await storage.mutate(identity, kind, () => null), null);
  assert.equal(replaceCount, 2);
  assert.equal(removeCount, 1);
});

test("mutate rejects wrong keys, asynchronous results, and invalid results before writing", async () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const ownRecord = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(1)],
  );
  const wrongIdentity = createApplicationChatQueuedSendMessageIntentsRecord(
    siblingUserIdentity,
    [makeIntent(1)],
  );
  const wrongKind = createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    [makeReadIntent(1, "mark_read", 10)],
  );
  let writeCount = 0;
  const storage = createApplicationChatStorage({
    async read() { return null; },
    async replace() { writeCount += 1; },
    async remove() { writeCount += 1; },
    async compareExchange() { writeCount += 1; return true; },
    async clearForLogout() {},
  });

  const invalidUpdaters = [
    () => wrongIdentity,
    () => wrongKind,
    async () => ownRecord,
    () => ({ then() {}, record: ownRecord }),
    () => undefined,
    () => 42,
  ];
  for (const updater of invalidUpdaters) {
    await assert.rejects(() => storage.mutate(identity, kind, updater));
  }
  await assert.rejects(() => storage.mutate(identity, kind, null));
  assert.equal(writeCount, 0);
});

test("mutate has a fixed contention limit and a stable sanitized error", async () => {
  const secret = "private-record-content-do-not-echo";
  let readCount = 0;
  let compareCount = 0;
  let updaterCount = 0;
  const storage = createApplicationChatStorage({
    async read() { readCount += 1; return null; },
    async replace() {},
    async remove() {},
    async compareExchange() { compareCount += 1; return false; },
    async clearForLogout() {},
  });

  await assert.rejects(
    () => storage.mutate(
      identity,
      ApplicationChatStorageRecordKind.queuedSendMessageIntents,
      () => {
        updaterCount += 1;
        return createApplicationChatQueuedSendMessageIntentsRecord(
          identity,
          [makeIntent(1, { request: { content: { format: "plain", text: secret } } })],
        );
      },
    ),
    (error) => {
      assert.ok(error instanceof ApplicationChatStorageUnavailableError);
      assert.equal(error.code, APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_CODE);
      assert.equal(error.message, APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_MESSAGE);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  assert.equal(readCount, MAX_APPLICATION_CHAT_STORAGE_MUTATION_ATTEMPTS);
  assert.equal(compareCount, MAX_APPLICATION_CHAT_STORAGE_MUTATION_ATTEMPTS);
  assert.equal(updaterCount, MAX_APPLICATION_CHAT_STORAGE_MUTATION_ATTEMPTS);
});

test("message-mutation removal and corrupt-record quarantine affect one identity-and-kind key", async () => {
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
  const ownMutations = createApplicationChatQueuedMessageMutationIntentsRecord(
    identity,
    [makeMutationIntent(1, "edit")],
  );
  const siblingMutations = createApplicationChatQueuedMessageMutationIntentsRecord(
    siblingUserIdentity,
    [makeMutationIntent(1, "soft_delete")],
  );
  const ownSendQueue = createApplicationChatQueuedSendMessageIntentsRecord(
    identity,
    [makeIntent(1)],
  );
  await storage.replace(ownMutations);
  await storage.replace(siblingMutations);
  await storage.replace(ownSendQueue);

  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedMessageMutationIntents),
    "{corrupt-message-mutation-record",
  );
  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  assert.deepEqual(await storage.read(
    siblingUserIdentity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), siblingMutations);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), ownSendQueue);

  await storage.replace(ownMutations);
  await storage.remove(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  assert.deepEqual(await storage.read(
    siblingUserIdentity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), siblingMutations);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), ownSendQueue);
});

test("logout clear rejects non-exact identities before invoking the adapter", async () => {
  let clearCallCount = 0;
  assert.throws(
    () => createApplicationChatStorage({
      async read() { return null; },
      async replace() {},
      async remove() {},
    }),
    /adapter\.clearForLogout must be a function/,
  );
  const storage = createApplicationChatStorage({
    async read() { return null; },
    async replace() {},
    async remove() {},
    async clearForLogout() { clearCallCount += 1; },
  });

  for (const invalidIdentity of [
    undefined,
    null,
    {},
    { ...identity, unexpected: true },
    { ...identity, tenantId: "*" },
    { ...identity, userId: "user-*" },
    { ...identity, deviceId: " " },
  ]) {
    await assert.rejects(() => storage.clearForLogout(invalidIdentity));
  }
  assert.equal(clearCallCount, 0);
});

test("logout clear propagates adapter rejection without reporting success", async () => {
  const adapterFailure = new Error("adapter clear failed");
  let reportedSuccess = false;
  let clearCallCount = 0;
  const storage = createApplicationChatStorage({
    async read() { return null; },
    async replace() {},
    async remove() {},
    async clearForLogout() {
      clearCallCount += 1;
      throw adapterFailure;
    },
  });

  await assert.rejects(
    storage.clearForLogout(identity).then(() => { reportedSuccess = true; }),
    adapterFailure,
  );
  assert.equal(clearCallCount, 1);
  assert.equal(reportedSuccess, false);
});

test("queued reply wire records preserve optional metadata and use canonical validation", () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const record = createApplicationChatQueuedSendMessageIntentsRecord(identity, [
    makeIntent(1, { request: { replyTo: { messageId: "source-1", notifyAuthor: false } } }),
    makeIntent(2, { request: { replyTo: { messageId: "source-2", notifyAuthor: true } } }),
    makeIntent(3),
  ]);
  const wire = JSON.parse(encodeApplicationChatStorageRecord(record));
  assert.equal(wire.schemaVersion, 1);
  for (const [index, intent] of record.intents.entries()) {
    assert.equal(wire.payload.intents[index].contractVersion, 1);
    assert.deepEqual(wire.payload.intents[index].replyTo, intent.request.replyTo);
  }
  assert.equal(Object.hasOwn(wire.payload.intents[2], "replyTo"), false);
  assert.deepEqual(decodeWire(wire), record);
  // Existing version-1 envelopes without replyTo still hydrate unchanged.
  const legacy = { ...wire, schemaVersion: 1, payload: { intents: [wire.payload.intents[2]] } };
  assert.deepEqual(decodeWire(legacy).intents, [record.intents[2]]);

  for (const replyTo of [null, {}, [], "source", { messageId: "source" },
    { messageId: "source", notifyAuthor: "false" },
    { messageId: "", notifyAuthor: false },
    { messageId: "source", notifyAuthor: true, conversationId: "other" }]) {
    assert.throws(() => makeIntent(1, { request: { replyTo } }));
    const malformed = structuredClone(wire);
    malformed.payload.intents[0].replyTo = replyTo;
    assert.throws(() => decodeWire(malformed, identity, kind));
  }
});

test("queued send intents enforce bounds, uniqueness, and deterministic FIFO order", () => {
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntentsRecord(identity, [makeIntent(2), makeIntent(1)]),
  );
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntentsRecord(identity, [makeIntent(1), makeIntent(1)]),
  );
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntentsRecord(identity, [
      makeIntent(1),
      makeIntent(2, { request: { clientMessageId: "client-1" } }),
    ]),
  );
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntentsRecord(identity, [
      makeIntent(1),
      makeIntent(2, { request: { idempotencyKey: "idempotency-1" } }),
    ]),
  );
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntentsRecord(
      identity,
      Array(MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS + 1).fill(makeIntent(1)),
    ),
  );
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntent(
      makeRequest("large", {
        content: { format: "plain", text: "x".repeat(100_001) },
      }),
      { enqueueOrder: 1, enqueuedAt: "2026-09-02T12:00:01Z" },
    ),
  );
  const individuallyBoundedButOversizedQueue = Array.from({ length: 60 }, (_, index) =>
    createApplicationChatQueuedSendMessageIntent(
      makeRequest(`aggregate-${index}`, {
        content: { format: "plain", text: "x".repeat(90_000) },
      }),
      {
        enqueueOrder: index + 1,
        enqueuedAt: "2026-09-02T12:00:01Z",
      },
    ),
  );
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntentsRecord(
      identity,
      individuallyBoundedButOversizedQueue,
    ),
  );
});

test("queued read-cursor intents enforce ordering, correlation, count, entry, and aggregate bounds", () => {
  assert.throws(() => createApplicationChatQueuedReadCursorIntentsRecord(identity, [
    makeReadIntent(2, "mark_read", 12),
    makeReadIntent(1, "mark_read", 11),
  ]));
  assert.throws(() => createApplicationChatQueuedReadCursorIntentsRecord(identity, [
    makeReadIntent(1, "mark_read", 10),
    makeReadIntent(2, "mark_unread", 4, {
      request: { idempotencyKey: "read-idempotency-1" },
    }),
  ]));
  assert.throws(() => createApplicationChatQueuedReadCursorIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENTS + 1).fill(
      makeReadIntent(1, "mark_read", 10),
    ),
  ));

  const validWire = JSON.parse(encodeApplicationChatStorageRecord(
    createApplicationChatQueuedReadCursorIntentsRecord(
      identity,
      [makeReadIntent(1, "mark_read", 10)],
    ),
  ));
  validWire.payload.intents[0].oversized = "x".repeat(
    MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENT_BYTES,
  );
  assert.throws(() => decodeWire(validWire), /intent exceeds/);

  const aggregateIdentity = {
    ...identity,
    userId: `u${"\0".repeat(511)}`,
  };
  const conversationId = `c${"\0".repeat(511)}`;
  const aggregate = Array.from(
    { length: MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENTS },
    (_, index) => makeReadIntent(
      index + 1,
      index % 2 === 0 ? "mark_read" : "mark_unread",
      index % 2 === 0 ? 10 : 4,
      {
        request: {
          conversationId,
          idempotencyKey: `read-aggregate-${index}-`.padEnd(255, "i"),
        },
        baseline: {
          conversationId,
          userId: aggregateIdentity.userId,
        },
      },
    ),
  );
  assert.throws(() => createApplicationChatQueuedReadCursorIntentsRecord(
    aggregateIdentity,
    aggregate,
  ), /storage record exceeds/);
});

test("secret-bearing, diagnostic, provider, attachment-byte, and non-JSON values are rejected", () => {
  for (const data of [
    { accessToken: "token" },
    { authorization: "Bearer token" },
    { credentials: { password: "secret" } },
    { providerDescriptor: { endpoint: "https://example.invalid" } },
    { huddleMediaToken: "media-token" },
    { diagnostics: { stackTrace: "raw stack" } },
    { attachmentByteSource: [0, 1, 2] },
    [0, 1, 2, 255],
    new Uint8Array([0, 1, 2]),
  ]) {
    assert.throws(() =>
      createApplicationChatQueuedSendMessageIntent(
        makeRequest("unsafe", {
          content: {
            format: "plain",
            text: "unsafe",
            blocks: [{ type: "unsafe", data }],
          },
        }),
        { enqueueOrder: 1, enqueuedAt: "2026-09-02T12:00:01Z" },
      ),
    );
  }
  assert.throws(() =>
    createApplicationChatQueuedSendMessageIntent(
      makeRequest("unknown", { unknown: true }),
      { enqueueOrder: 1, enqueuedAt: "2026-09-02T12:00:01Z" },
    ),
  );
});
