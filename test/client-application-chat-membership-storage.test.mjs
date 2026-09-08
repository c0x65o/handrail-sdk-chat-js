import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION,
  APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENTS,
  MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
  createApplicationChatQueuedConversationMembershipIntent,
  createApplicationChatQueuedConversationMembershipIntentsRecord,
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

const membershipRequest = (intent, suffix = intent, overrides = {}) => ({
  operation: "mutate_conversation_membership",
  intent,
  conversationId: `conversation-${suffix}`,
  expectedMemberListRevision: 4,
  idempotencyKey: `membership-${suffix}`,
  ...(intent === "add_member" || intent === "remove_member" || intent === "change_member_role"
    ? { targetUserId: `target-${suffix}` }
    : {}),
  ...(intent === "add_member" || intent === "change_member_role"
    ? { requestedRole: intent === "add_member" ? "member" : "moderator" }
    : {}),
  ...overrides,
});

const membershipIntent = (order, intent, suffix = String(order), overrides = {}) =>
  createApplicationChatQueuedConversationMembershipIntent(
    membershipRequest(intent, suffix, overrides.request),
    {
      enqueueOrder: order,
      enqueuedAt: `2026-09-03T12:${String(order).padStart(2, "0")}:00Z`,
      ...overrides.metadata,
    },
  );

const wireEnvelope = (payload, envelopeIdentity = identity) => ({
  schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
  kind: ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  identity: envelopeIdentity,
  payload,
});

test("membership storage round-trips all five closed request variants exactly", () => {
  const intents = [
    membershipIntent(1, "join", "join"),
    membershipIntent(2, "leave", "leave"),
    membershipIntent(3, "add_member", "add"),
    membershipIntent(4, "remove_member", "remove"),
    membershipIntent(5, "change_member_role", "role"),
  ];
  const record = createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    intents,
  );
  const encoded = encodeApplicationChatStorageRecord(record);

  assert.deepEqual(JSON.parse(encoded).payload.intents, intents.map((intent) => ({
    contractVersion: APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  })));
  assert.deepEqual(decodeApplicationChatStorageRecord(
    encoded,
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), record);
});

test("membership storage isolates tenant, user, and device identities", () => {
  const encoded = encodeApplicationChatStorageRecord(
    createApplicationChatQueuedConversationMembershipIntentsRecord(
      identity,
      [membershipIntent(1, "join")],
    ),
  );
  for (const mismatch of [
    { ...identity, tenantId: "tenant-2" },
    { ...identity, userId: "user-2" },
    { ...identity, deviceId: "device-2" },
  ]) {
    assert.throws(() => decodeApplicationChatStorageRecord(
      encoded,
      mismatch,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ), /identity/);
  }
});

test("membership reads are deeply frozen and detached from caller-owned values", () => {
  const request = membershipRequest("add_member", "detached");
  const intent = createApplicationChatQueuedConversationMembershipIntent(request, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-03T12:01:00Z",
  });
  request.targetUserId = "mutated-target";
  const record = createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    [intent],
  );

  assert.equal(intent.request.targetUserId, "target-detached");
  assert.notEqual(record.intents[0], intent);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.identity));
  assert.ok(Object.isFrozen(record.intents));
  assert.ok(Object.isFrozen(record.intents[0]));
  assert.ok(Object.isFrozen(record.intents[0].request));
  assert.throws(() => {
    record.intents[0].request.targetUserId = "another-target";
  });
});

test("membership validation rejects reused correlations, malformed fields, and unsafe material", () => {
  const metadata = { enqueueOrder: 1, enqueuedAt: "2026-09-03T12:01:00Z" };
  assert.throws(() => createApplicationChatQueuedConversationMembershipIntent(
    membershipRequest("join", "bad-order"),
    { ...metadata, enqueueOrder: 0 },
  ), /positive safe integer/);
  for (const request of [
    membershipRequest("join", "revision", { expectedMemberListRevision: 0 }),
    membershipRequest("add_member", "role", { requestedRole: "administrator" }),
    { ...membershipRequest("leave", "unknown"), unexpected: true },
    { ...membershipRequest("join", "secret"), accessToken: "secret" },
    { ...membershipRequest("remove_member", "provider"), providerData: { opaque: true } },
    membershipRequest("invite", "unsupported"),
  ]) {
    assert.throws(() => createApplicationChatQueuedConversationMembershipIntent(
      request,
      metadata,
    ));
  }

  const first = membershipIntent(1, "join", "first", {
    request: { idempotencyKey: "reused-correlation" },
  });
  const conflicting = membershipIntent(2, "leave", "second", {
    request: { idempotencyKey: "reused-correlation" },
  });
  assert.throws(() => createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    [first, conflicting],
  ), /idempotencyKey/);
  assert.throws(() => createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    [membershipIntent(2, "join", "later"), membershipIntent(1, "leave", "earlier")],
  ), /increasing FIFO order/);

  const wire = JSON.parse(encodeApplicationChatStorageRecord(
    createApplicationChatQueuedConversationMembershipIntentsRecord(identity, [first]),
  ));
  wire.payload.intents[0].requestedRole = "member";
  assert.throws(() => decodeApplicationChatStorageRecord(
    JSON.stringify(wire),
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), /exactly/);
  delete wire.payload.intents[0].requestedRole;
  wire.payload.intents[0].contractVersion = 2;
  assert.throws(() => decodeApplicationChatStorageRecord(
    JSON.stringify(wire),
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), /contract version/);
});

test("membership storage enforces count, per-intent UTF-8, and total-record byte ceilings", () => {
  const oneIntent = membershipIntent(1, "join");
  assert.throws(() => createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    Array(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENTS + 1).fill(oneIntent),
  ), /at most/);

  const oversizedIntent = {
    contractVersion: APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION,
    enqueueOrder: 1,
    enqueuedAt: "2026-09-03T12:01:00Z",
    ...membershipRequest("join", "utf8", {
      conversationId: "\ud83d\udca5".repeat(
        Math.ceil(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENT_BYTES / 4),
      ),
    }),
  };
  assert.throws(() => decodeApplicationChatStorageRecord(
    JSON.stringify(wireEnvelope({ intents: [oversizedIntent] })),
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), /intent exceeds/);

  assert.throws(() => decodeApplicationChatStorageRecord(
    " ".repeat(MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES + 1),
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), /storage record exceeds/);
});

test("membership coalescing is deterministic and preserves unrelated FIFO work", () => {
  const original = membershipIntent(1, "join", "shared");
  const duplicate = membershipIntent(2, "join", "shared", {
    request: { idempotencyKey: "membership-shared-second-attempt" },
  });
  const unrelated = membershipIntent(3, "leave", "unrelated");
  const repeatedAfterUnrelatedWork = membershipIntent(4, "join", "shared", {
    request: { idempotencyKey: "membership-shared-third-attempt" },
  });
  const record = createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    [original, duplicate, unrelated, repeatedAfterUnrelatedWork],
  );

  assert.deepEqual(record.intents.map((intent) => [
    intent.enqueueOrder,
    intent.request.intent,
    intent.request.idempotencyKey,
  ]), [
    [1, "join", "membership-shared"],
    [3, "leave", "membership-unrelated"],
    [4, "join", "membership-shared-third-attempt"],
  ]);
});

test("membership quarantine removes only the malformed identity-and-kind record", async () => {
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
  const membership = createApplicationChatQueuedConversationMembershipIntentsRecord(
    identity,
    [membershipIntent(1, "join")],
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
      enqueuedAt: "2026-09-03T12:01:00Z",
    }),
  ]);
  const siblingIdentity = { ...identity, deviceId: "device-2" };
  const siblingMembership = createApplicationChatQueuedConversationMembershipIntentsRecord(
    siblingIdentity,
    [membershipIntent(1, "leave", "sibling")],
  );
  await storage.replace(membership);
  await storage.replace(send);
  await storage.replace(siblingMembership);
  rows.set(
    key(identity, ApplicationChatStorageRecordKind.queuedConversationMembershipIntents),
    "{malformed-membership-record",
  );

  await assert.rejects(() => storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ));
  assert.equal(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), null);
  assert.deepEqual(await storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  ), send);
  assert.deepEqual(await storage.read(
    siblingIdentity,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), siblingMembership);
});
