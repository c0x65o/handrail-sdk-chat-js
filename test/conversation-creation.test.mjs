import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationCreationParseError,
  createConversationSnapshotMetadata,
  deriveCanonicalParticipantIdentity,
  parseChannelConversationCreationResult,
  parseConversationCreationInput,
  parseConversationCreationResult,
  parseCreateChannelConversationInput,
  parseCreateDirectConversationInput,
  parseCreateGroupDirectConversationInput,
  parseDirectConversationCreationResult,
  parseGroupDirectConversationCreationResult,
} from "../dist/index.js";
import * as serverCreationContracts from "../dist/server/index.js";

const now = "2026-08-25T20:00:00.000Z";
const actorUserId = "user-actor";
const metadata = createConversationSnapshotMetadata({
  packageVersion: "0.1.3",
  protocolVersion: 1,
  schemaVersion: 1,
  enabledFeatures: { conversationCreation: true },
});

const channelInput = {
  operation: "create_conversation",
  type: "channel",
  name: "Order coordination",
  visibility: "private",
  entity: { type: "erp.order", id: "order/42" },
  idempotencyKey: "create-channel-1",
  clientRequestId: "request-channel-1",
};
const directInput = {
  operation: "create_conversation",
  type: "direct",
  visibility: "private",
  intendedMemberUserIds: ["user-b"],
  idempotencyKey: "create-direct-1",
  clientRequestId: "request-direct-1",
};
const groupInput = {
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: ["user-c", "user-b"],
  idempotencyKey: "create-group-1",
  clientRequestId: "request-group-1",
};

function conversationDetail(type, id) {
  const conversation = {
    id,
    tenantId: "tenant-from-session",
    type,
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    activityAt: now,
    latestSequence: 0,
    currentMember: {
      tenantId: "tenant-from-session",
      conversationId: id,
      userId: actorUserId,
      role: "owner",
      state: "active",
      joinedAt: now,
      updatedAt: now,
    },
    currentReadState: {
      conversationId: id,
      userId: actorUserId,
      lastReadSequence: 0,
      updatedAt: now,
    },
    memberUserIds: [actorUserId],
    currentPreference: {
      conversationId: id,
      userId: actorUserId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: now,
    },
  };
  if (type === "channel") conversation.name = "Order coordination";
  return { kind: "conversation_detail", conversation, _meta: metadata };
}

function assertParseError(code) {
  return (error) =>
    error instanceof ConversationCreationParseError && error.code === code;
}

test("parses valid channel, direct, and group-direct creation inputs", () => {
  assert.deepEqual(parseCreateChannelConversationInput(channelInput), channelInput);
  assert.deepEqual(parseCreateDirectConversationInput(directInput), directInput);
  assert.deepEqual(parseCreateGroupDirectConversationInput(groupInput), groupInput);
  assert.deepEqual(
    [channelInput, directInput, groupInput].map(
      (input) => parseConversationCreationInput(input).type,
    ),
    ["channel", "direct", "group_direct"],
  );
  assert.equal(
    serverCreationContracts.parseConversationCreationInput,
    parseConversationCreationInput,
  );
});

test("requires nonblank idempotency and client request IDs for every kind", () => {
  for (const valid of [channelInput, directInput, groupInput]) {
    const { idempotencyKey: _idempotency, ...withoutIdempotency } = valid;
    const { clientRequestId: _request, ...withoutRequest } = valid;
    for (const invalid of [
      withoutIdempotency,
      withoutRequest,
      { ...valid, idempotencyKey: " \t" },
      { ...valid, clientRequestId: "\n" },
    ]) {
      assert.throws(
        () => parseConversationCreationInput(invalid),
        assertParseError("malformed_input"),
      );
    }
  }
});

test("rejects trusted identity and authorization fields recursively", () => {
  const spoofed = [
    ["tenantId", "tenant-spoof"],
    ["organization_id", "organization-spoof"],
    ["actor", { userId: "actor-spoof" }],
    ["currentUserId", "user-spoof"],
    ["session-id", "session-spoof"],
    ["roles", ["admin"]],
    ["capabilities", ["chat.admin"]],
    ["authorization", "Bearer spoof"],
  ];
  for (const [field, value] of spoofed) {
    assert.throws(
      () => parseConversationCreationInput({ ...channelInput, [field]: value }),
      assertParseError("trusted_identity_field"),
      field,
    );
  }
  assert.throws(
    () =>
      parseCreateChannelConversationInput({
        ...channelInput,
        entity: { ...channelInput.entity, nested: { actorId: "spoof" } },
      }),
    assertParseError("trusted_identity_field"),
  );
});

test("enforces channel names, visibility, complete entities, and kind isolation", () => {
  const invalid = [
    { ...channelInput, name: " " },
    { ...channelInput, visibility: "members_only" },
    { ...channelInput, entity: { type: "erp.order" } },
    { ...channelInput, entity: { type: "", id: "42" } },
    { ...channelInput, entity: { type: "erp.order", id: " " } },
    { ...channelInput, intendedMemberUserIds: ["user-b"] },
    { ...channelInput, parentConversationId: "parent-1" },
    { ...channelInput, rootMessageId: "message-1" },
  ];
  for (const input of invalid) {
    assert.throws(() => parseCreateChannelConversationInput(input));
  }
});

test("enforces direct/group privacy, unnamed shapes, cardinality, and unique members", () => {
  const invalid = [
    { ...directInput, visibility: "public" },
    { ...directInput, intendedMemberUserIds: [] },
    { ...directInput, intendedMemberUserIds: ["user-b", "user-c"] },
    { ...directInput, intendedMemberUserIds: [" "] },
    { ...directInput, name: "DM" },
    { ...directInput, entity: { type: "order", id: "42" } },
    { ...directInput, rootMessageId: "message-1" },
    { ...groupInput, visibility: "public" },
    { ...groupInput, intendedMemberUserIds: ["user-b"] },
    { ...groupInput, intendedMemberUserIds: ["user-b", ""] },
    { ...groupInput, intendedMemberUserIds: ["user-b", "user-b"] },
    { ...groupInput, parentConversationId: "parent-1" },
  ];
  for (const input of invalid) {
    assert.throws(() => parseConversationCreationInput(input));
  }
  assert.throws(
    () => parseConversationCreationInput({ ...directInput, type: "thread" }),
    assertParseError("malformed_input"),
  );
});

test("derives order-independent identity from members plus separately trusted actor", () => {
  const forward = deriveCanonicalParticipantIdentity(actorUserId, [
    "user-b",
    "user-c",
  ]);
  const reversed = deriveCanonicalParticipantIdentity(actorUserId, [
    "user-c",
    "user-b",
  ]);

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.participantUserIds, [
    "user-actor",
    "user-b",
    "user-c",
  ]);
  assert.match(forward.key, /^handrail-participants\.v1\./);
  assert.equal("actor" in groupInput, false);
  assert.throws(
    () => deriveCanonicalParticipantIdentity(actorUserId, [actorUserId]),
    assertParseError("duplicate_member_id"),
  );
  assert.throws(
    () => deriveCanonicalParticipantIdentity(actorUserId, ["user-b", "user-b"]),
    assertParseError("duplicate_member_id"),
  );
});

test("JSON-round-trips created, existing-equivalent, and replayed canonical results", () => {
  const channelCreated = {
    operation: "create_conversation",
    type: "channel",
    reconciliationStatus: "created",
    clientRequestId: channelInput.clientRequestId,
    conversation: conversationDetail("channel", "conversation-channel"),
  };
  const directExisting = {
    operation: "create_conversation",
    type: "direct",
    reconciliationStatus: "existing_equivalent",
    clientRequestId: directInput.clientRequestId,
    conversation: conversationDetail("direct", "conversation-direct"),
    participantIdentity: deriveCanonicalParticipantIdentity(
      actorUserId,
      directInput.intendedMemberUserIds,
    ),
  };
  const groupReplayed = {
    operation: "create_conversation",
    type: "group_direct",
    reconciliationStatus: "replayed",
    clientRequestId: groupInput.clientRequestId,
    conversation: conversationDetail("group_direct", "conversation-group"),
    participantIdentity: deriveCanonicalParticipantIdentity(
      actorUserId,
      groupInput.intendedMemberUserIds,
    ),
  };

  for (const [result, input] of [
    [channelCreated, channelInput],
    [directExisting, directInput],
    [groupReplayed, groupInput],
  ]) {
    assert.deepEqual(
      parseConversationCreationResult(
        JSON.parse(JSON.stringify(result)),
        input,
      ),
      result,
    );
  }
  assert.deepEqual(
    parseChannelConversationCreationResult(channelCreated, channelInput),
    channelCreated,
  );
  assert.deepEqual(
    parseDirectConversationCreationResult(directExisting, directInput),
    directExisting,
  );
  assert.deepEqual(
    parseGroupDirectConversationCreationResult(groupReplayed, groupInput),
    groupReplayed,
  );
});

test("rejects malformed and mismatched canonical result shapes", () => {
  const identity = deriveCanonicalParticipantIdentity(actorUserId, ["user-b"]);
  const valid = {
    operation: "create_conversation",
    type: "direct",
    reconciliationStatus: "created",
    clientRequestId: directInput.clientRequestId,
    conversation: conversationDetail("direct", "conversation-direct"),
    participantIdentity: identity,
  };
  const invalid = [
    { ...valid, extra: true },
    { ...valid, operation: "create_thread" },
    { ...valid, reconciliationStatus: "applied" },
    { ...valid, clientRequestId: " " },
    { ...valid, participantIdentity: undefined },
    {
      ...valid,
      participantIdentity: {
        ...identity,
        participantUserIds: [...identity.participantUserIds].reverse(),
      },
    },
    { ...valid, participantIdentity: { ...identity, key: "wrong" } },
    { ...valid, conversation: conversationDetail("group_direct", "conversation-group") },
  ];
  for (const result of invalid) {
    assert.throws(() => parseConversationCreationResult(result));
  }

  assert.throws(
    () => parseConversationCreationResult(valid, { ...directInput, clientRequestId: "other" }),
    assertParseError("incoherent_result"),
  );
  assert.throws(
    () =>
      parseConversationCreationResult(valid, {
        ...directInput,
        intendedMemberUserIds: ["user-c"],
      }),
    assertParseError("incoherent_result"),
  );
  assert.throws(
    () =>
      parseConversationCreationResult({
        operation: "create_conversation",
        type: "channel",
        reconciliationStatus: "existing_equivalent",
        clientRequestId: channelInput.clientRequestId,
        conversation: conversationDetail("channel", "conversation-channel"),
      }),
    assertParseError("incoherent_result"),
  );
  assert.throws(
    () =>
      parseConversationCreationResult({
        operation: "create_conversation",
        type: "channel",
        reconciliationStatus: "created",
        clientRequestId: channelInput.clientRequestId,
        conversation: conversationDetail("channel", "conversation-channel"),
        participantIdentity: identity,
      }),
    assertParseError("malformed_result"),
  );
});
