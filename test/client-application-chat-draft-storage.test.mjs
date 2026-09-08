import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS,
  MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES,
  createApplicationChatQueuedDraftIntent,
  createApplicationChatQueuedDraftIntentsRecord,
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
const siblingUserIdentity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-2",
  deviceId: "device-1",
});
const siblingTenantIdentity = Object.freeze({
  tenantId: "tenant-2",
  userId: "user-1",
  deviceId: "device-1",
});
const siblingDeviceIdentity = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-2",
});

const makeRequest = (suffix, overrides = {}) => ({
  operation: "synchronize_draft",
  intent: "replace",
  conversationId: `conversation-${suffix}`,
  baseRevision: 1,
  deviceMutationId: `device-mutation-${suffix}`,
  idempotencyKey: `draft-idempotency-${suffix}`,
  content: {
    format: "markdown",
    text: `draft ${suffix}`,
    mentions: [{ type: "user", userId: "mentioned-user" }],
    attachments: [{ attachmentId: `attachment-${suffix}` }],
  },
  ...overrides,
});

const makeIntent = (order, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedDraftIntent(
    makeRequest(suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-03T12:${String(order % 60).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const decodeDraft = (encoded, expectedIdentity = identity) =>
  decodeApplicationChatStorageRecord(
    encoded,
    expectedIdentity,
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  );

test("queued replace and clear drafts round trip exactly and retain each conversation's latest order", () => {
  const firstConversationVersion = makeIntent(1, "shared");
  const otherConversation = makeIntent(2, "other");
  const latestConversationVersion = createApplicationChatQueuedDraftIntent(
    {
      operation: "synchronize_draft",
      intent: "clear",
      conversationId: "conversation-shared",
      baseRevision: 7,
      deviceMutationId: "device-mutation-shared-clear",
      idempotencyKey: "draft-idempotency-shared-clear",
    },
    { enqueueOrder: 3, enqueuedAt: "2026-09-03T12:03:00Z" },
  );

  const record = createApplicationChatQueuedDraftIntentsRecord(identity, [
    firstConversationVersion,
    otherConversation,
    latestConversationVersion,
  ]);

  assert.deepEqual(record.intents.map((intent) => ({
    conversationId: intent.request.conversationId,
    intent: intent.request.intent,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    deviceMutationId: intent.request.deviceMutationId,
    idempotencyKey: intent.request.idempotencyKey,
  })), [
    {
      conversationId: "conversation-other",
      intent: "replace",
      enqueueOrder: 2,
      enqueuedAt: "2026-09-03T12:02:00Z",
      deviceMutationId: "device-mutation-other",
      idempotencyKey: "draft-idempotency-other",
    },
    {
      conversationId: "conversation-shared",
      intent: "clear",
      enqueueOrder: 3,
      enqueuedAt: "2026-09-03T12:03:00Z",
      deviceMutationId: "device-mutation-shared-clear",
      idempotencyKey: "draft-idempotency-shared-clear",
    },
  ]);

  const encoded = encodeApplicationChatStorageRecord(record);
  const wire = JSON.parse(encoded);
  assert.deepEqual(wire, {
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: "queued_draft_intents",
    identity,
    payload: {
      intents: [
        {
          contractVersion: APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION,
          enqueueOrder: 2,
          enqueuedAt: "2026-09-03T12:02:00Z",
          ...otherConversation.request,
        },
        {
          contractVersion: APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION,
          enqueueOrder: 3,
          enqueuedAt: "2026-09-03T12:03:00Z",
          operation: "synchronize_draft",
          intent: "clear",
          conversationId: "conversation-shared",
          baseRevision: 7,
          deviceMutationId: "device-mutation-shared-clear",
          idempotencyKey: "draft-idempotency-shared-clear",
        },
      ],
    },
  });
  assert.deepEqual(decodeDraft(encoded), record);
});

test("draft records reject wrong keys, malformed payloads, and ambiguous correlations", () => {
  const record = createApplicationChatQueuedDraftIntentsRecord(identity, [
    makeIntent(1),
  ]);
  const encoded = encodeApplicationChatStorageRecord(record);
  for (const mismatchedIdentity of [
    siblingTenantIdentity,
    siblingUserIdentity,
    siblingDeviceIdentity,
  ]) {
    assert.throws(
      () => decodeDraft(encoded, mismatchedIdentity),
      /identity does not match/,
    );
  }
  assert.throws(() => decodeApplicationChatStorageRecord(
    encoded,
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), /kind does not match/);

  const wire = JSON.parse(encoded);
  for (const malformed of [
    { ...wire, unexpected: true },
    { ...wire, payload: { ...wire.payload, unexpected: true } },
    { ...wire, kind: "queued_drafts" },
    {
      ...wire,
      payload: {
        intents: [{ ...wire.payload.intents[0], contractVersion: 2 }],
      },
    },
    {
      ...wire,
      payload: {
        intents: [{ ...wire.payload.intents[0], baseRevision: -1 }],
      },
    },
    {
      ...wire,
      payload: {
        intents: [{ ...wire.payload.intents[0], unexpected: true }],
      },
    },
  ]) {
    assert.throws(() => decodeDraft(JSON.stringify(malformed)));
  }

  assert.throws(() => createApplicationChatQueuedDraftIntentsRecord(identity, [
    makeIntent(1, "one"),
    makeIntent(2, "two", {
      request: { deviceMutationId: "device-mutation-one" },
    }),
  ]), /deviceMutationId values must be unique/);
  assert.throws(() => createApplicationChatQueuedDraftIntentsRecord(identity, [
    makeIntent(1, "one"),
    makeIntent(2, "two", {
      request: { idempotencyKey: "draft-idempotency-one" },
    }),
  ]), /idempotencyKey values must be unique/);
});

test("draft conversation, per-intent, and five-MiB record bounds are enforced", () => {
  const tooManyConversations = Array.from(
    { length: MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS + 1 },
    (_, index) => makeIntent(index + 1, `count-${index}`),
  );
  assert.throws(
    () => createApplicationChatQueuedDraftIntentsRecord(identity, tooManyConversations),
    /at most .* conversations/,
  );

  const oneWire = JSON.parse(encodeApplicationChatStorageRecord(
    createApplicationChatQueuedDraftIntentsRecord(identity, [makeIntent(1)]),
  ));
  oneWire.payload.intents[0].padding = "x".repeat(
    MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES,
  );
  assert.throws(
    () => decodeDraft(JSON.stringify(oneWire)),
    /Queued draft intent exceeds/,
  );

  const largeIntents = Array.from({ length: 81 }, (_, index) => makeIntent(
    index + 1,
    `large-${index}`,
    { request: { content: { format: "plain", text: "x".repeat(65_536), attachments: [] } } },
  ));
  assert.throws(
    () => createApplicationChatQueuedDraftIntentsRecord(identity, largeIntents),
    /Application chat storage record exceeds/,
  );
});

test("draft intents reject secrets and unknown fields and detach deeply immutable values", () => {
  for (const unsafe of [
    { accessToken: "token" },
    { uploadCredentials: { secret: "secret" } },
    { providerData: { provider: "unsafe" } },
    { diagnostics: { stackTrace: "unsafe" } },
  ]) {
    assert.throws(() => createApplicationChatQueuedDraftIntent(
      makeRequest("unsafe", unsafe),
      { enqueueOrder: 1, enqueuedAt: "2026-09-03T12:00:00Z" },
    ), /not permitted/);
  }
  assert.throws(() => createApplicationChatQueuedDraftIntent(
    makeRequest("unknown", { unexpected: true }),
    { enqueueOrder: 1, enqueuedAt: "2026-09-03T12:00:00Z" },
  ));
  assert.throws(() => createApplicationChatQueuedDraftIntent(
    makeRequest("bytes", {
      content: {
        format: "plain",
        text: "draft",
        attachments: [{ attachmentId: "attachment-bytes", bytes: [1, 2, 3] }],
      },
    }),
    { enqueueOrder: 1, enqueuedAt: "2026-09-03T12:00:00Z" },
  ));

  const mutableIdentity = { ...identity };
  const mutableRequest = makeRequest("detached", {
    content: {
      format: "markdown",
      text: "original",
      mentions: [{ type: "entity", entity: { type: "ticket", id: "123" } }],
      attachments: [{ attachmentId: "attachment-detached" }],
    },
  });
  const intent = createApplicationChatQueuedDraftIntent(mutableRequest, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-03T12:00:00Z",
  });
  const record = createApplicationChatQueuedDraftIntentsRecord(mutableIdentity, [intent]);
  mutableIdentity.deviceId = "mutated-device";
  mutableRequest.content.text = "mutated";
  mutableRequest.content.mentions[0].entity.id = "mutated";
  mutableRequest.content.attachments[0].attachmentId = "mutated";

  assert.equal(record.identity.deviceId, identity.deviceId);
  assert.equal(record.intents[0].request.content.text, "original");
  assert.equal(record.intents[0].request.content.mentions[0].entity.id, "123");
  assert.equal(
    record.intents[0].request.content.attachments[0].attachmentId,
    "attachment-detached",
  );
  for (const value of [
    record,
    record.identity,
    record.intents,
    record.intents[0],
    record.intents[0].request,
    record.intents[0].request.content,
    record.intents[0].request.content.mentions,
    record.intents[0].request.content.mentions[0],
    record.intents[0].request.content.mentions[0].entity,
    record.intents[0].request.content.attachments,
    record.intents[0].request.content.attachments[0],
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }

  const decoded = decodeDraft(encodeApplicationChatStorageRecord(record));
  assert.notEqual(decoded, record);
  assert.notEqual(decoded.identity, record.identity);
  assert.notEqual(decoded.intents[0].request, record.intents[0].request);
  assert.equal(Object.isFrozen(decoded.intents[0].request.content), true);
});

test("adapter quarantine and logout clearing affect only the exact identity and kind", async () => {
  const rows = new Map();
  const key = (recordIdentity, kind) => JSON.stringify([
    recordIdentity.tenantId,
    recordIdentity.userId,
    recordIdentity.deviceId,
    kind,
  ]);
  const adapter = {
    async read(recordIdentity, kind) {
      return rows.get(key(recordIdentity, kind)) ?? null;
    },
    async replace(recordIdentity, kind, encodedRecord) {
      rows.set(key(recordIdentity, kind), encodedRecord);
    },
    async remove(recordIdentity, kind) {
      rows.delete(key(recordIdentity, kind));
    },
    async clearForLogout(recordIdentity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(key(recordIdentity, kind));
      }
    },
  };
  const storage = createApplicationChatStorage(adapter);
  const ownDraft = createApplicationChatQueuedDraftIntentsRecord(identity, [makeIntent(1)]);
  const siblingUserDraft = createApplicationChatQueuedDraftIntentsRecord(
    siblingUserIdentity,
    [makeIntent(1)],
  );
  const siblingDeviceDraft = createApplicationChatQueuedDraftIntentsRecord(
    siblingDeviceIdentity,
    [makeIntent(1)],
  );
  const siblingTenantDraft = createApplicationChatQueuedDraftIntentsRecord(
    siblingTenantIdentity,
    [makeIntent(1)],
  );
  const ownSendKind = createApplicationChatQueuedSendMessageIntentsRecord(identity, []);
  await storage.replace(ownDraft);
  await storage.replace(siblingUserDraft);
  await storage.replace(siblingDeviceDraft);
  await storage.replace(siblingTenantDraft);
  await storage.replace(ownSendKind);

  assert.deepEqual(
    await storage.read(identity, ApplicationChatStorageRecordKind.queuedDraftIntents),
    ownDraft,
  );
  rows.set(key(identity, ApplicationChatStorageRecordKind.queuedDraftIntents), "{malformed");
  await assert.rejects(
    storage.read(identity, ApplicationChatStorageRecordKind.queuedDraftIntents),
    /invalid JSON/,
  );
  assert.equal(rows.has(key(identity, ApplicationChatStorageRecordKind.queuedDraftIntents)), false);
  assert.equal(rows.has(key(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents)), true);
  assert.equal(rows.has(key(siblingUserIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);
  assert.equal(rows.has(key(siblingDeviceIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);
  assert.equal(rows.has(key(siblingTenantIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);

  await storage.remove(
    siblingDeviceIdentity,
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  );
  assert.equal(rows.has(key(siblingDeviceIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), false);
  assert.equal(rows.has(key(siblingUserIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);
  assert.equal(rows.has(key(siblingTenantIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);

  await storage.clearForLogout(identity);
  assert.equal(rows.has(key(identity, ApplicationChatStorageRecordKind.queuedSendMessageIntents)), false);
  assert.equal(rows.has(key(siblingUserIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);
  assert.equal(rows.has(key(siblingTenantIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);
});

test("reply draft storage clones immutable requests and round trips optional targets within identity", () => {
  for (const replyTo of [undefined, { messageId: "source-a", notifyAuthor: false }, { messageId: "source-b", notifyAuthor: true }]) {
    const request = makeRequest("reply");
    if (replyTo !== undefined) request.content.replyTo = { ...replyTo };
    const expected = structuredClone(request);
    const intent = createApplicationChatQueuedDraftIntent(request, {
      enqueueOrder: 1, enqueuedAt: "2026-09-03T12:01:00Z",
    });
    request.content.text = "mutated";
    request.content.attachments[0].attachmentId = "mutated";
    if (request.content.replyTo) request.content.replyTo.notifyAuthor = !replyTo.notifyAuthor;
    assert.deepEqual(intent.request, expected);
    const record = createApplicationChatQueuedDraftIntentsRecord(identity, [intent]);
    const encoded = encodeApplicationChatStorageRecord(record);
    const decoded = decodeDraft(encoded);
    assert.deepEqual(decoded, record);
    assert.deepEqual(decoded.intents[0].request, expected);
    assert.equal(Object.hasOwn(decoded.intents[0].request.content, "replyTo"), replyTo !== undefined);
    if (replyTo !== undefined) {
      assert.equal(Object.isFrozen(intent.request.content.replyTo), true);
      assert.equal(Object.isFrozen(decoded.intents[0].request.content.replyTo), true);
      assert.throws(() => { decoded.intents[0].request.content.replyTo.messageId = "mutated"; }, TypeError);
    }
    for (const sibling of [siblingTenantIdentity, siblingUserIdentity, siblingDeviceIdentity]) {
      assert.throws(() => decodeDraft(encoded, sibling), /identity does not match/);
    }
  }
});
