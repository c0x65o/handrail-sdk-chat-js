import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationMembershipParseError,
  parseAddConversationMemberInput,
  parseChangeConversationMemberRoleInput,
  parseConversationMembershipMutationInput,
  parseConversationMembershipMutationResult,
  parseJoinConversationInput,
  parseLeaveConversationInput,
  parseRemoveConversationMemberInput,
} from "../dist/index.js";
import * as clientMembershipContracts from "../dist/client/index.js";
import * as serverMembershipContracts from "../dist/server/index.js";
import {
  appliedMembershipResult,
  membershipInputs,
  timestamp,
  validMembershipCases,
} from "./fixtures/conversation-membership-mutations.mjs";

function assertParseError(code) {
  return (error) =>
    error instanceof ConversationMembershipParseError && error.code === code;
}

test("parses every explicit self and targeted membership intent", () => {
  assert.deepEqual(parseJoinConversationInput(membershipInputs.join), membershipInputs.join);
  assert.deepEqual(parseLeaveConversationInput(membershipInputs.leave), membershipInputs.leave);
  assert.deepEqual(
    parseAddConversationMemberInput(membershipInputs.addMember),
    membershipInputs.addMember,
  );
  assert.deepEqual(
    parseRemoveConversationMemberInput(membershipInputs.removeMember),
    membershipInputs.removeMember,
  );
  assert.deepEqual(
    parseChangeConversationMemberRoleInput(membershipInputs.changeRole),
    membershipInputs.changeRole,
  );

  for (const { input } of validMembershipCases) {
    assert.deepEqual(
      parseConversationMembershipMutationInput(JSON.parse(JSON.stringify(input))),
      input,
    );
  }
  assert.equal(
    clientMembershipContracts.parseConversationMembershipMutationInput,
    parseConversationMembershipMutationInput,
  );
  assert.equal(
    serverMembershipContracts.parseConversationMembershipMutationResult,
    parseConversationMembershipMutationResult,
  );
});

test("each intent accepts exactly its applicable target and role fields", () => {
  const invalid = [
    { ...membershipInputs.join, targetUserId: "user-actor" },
    { ...membershipInputs.join, requestedRole: "owner" },
    { ...membershipInputs.leave, targetUserId: "user-actor" },
    { ...membershipInputs.addMember, targetUserId: undefined },
    { ...membershipInputs.addMember, requestedRole: undefined },
    { ...membershipInputs.removeMember, requestedRole: "owner" },
    { ...membershipInputs.changeRole, requestedRole: undefined },
    { ...membershipInputs.changeRole, targetUserId: " " },
    { ...membershipInputs.addMember, requestedRole: "administrator" },
  ];
  for (const input of invalid) {
    assert.throws(
      () => parseConversationMembershipMutationInput(input),
      (error) => error instanceof ConversationMembershipParseError,
    );
  }
});

test("rejects ambiguous toggles, duplicate target shapes, and missing idempotency", () => {
  const { idempotencyKey: _idempotencyKey, ...withoutIdempotency } =
    membershipInputs.addMember;
  const invalid = [
    withoutIdempotency,
    { ...membershipInputs.addMember, idempotencyKey: " \n" },
    { ...membershipInputs.addMember, intent: "toggle" },
    { ...membershipInputs.addMember, operation: "toggle_membership" },
    { ...membershipInputs.addMember, toggle: true },
    { ...membershipInputs.addMember, member: true },
    { ...membershipInputs.addMember, state: "active" },
    {
      ...membershipInputs.addMember,
      targetUserIds: ["user-c", "user-c"],
    },
    {
      ...membershipInputs.removeMember,
      targetUserIds: ["user-c", "user-c"],
    },
    { ...membershipInputs.join, targetUserId: "user-other" },
  ];
  for (const input of invalid) {
    assert.throws(
      () => parseConversationMembershipMutationInput(input),
      assertParseError("malformed_input"),
    );
  }
});

test("rejects invalid identifiers and revisions", () => {
  for (const input of [
    { ...membershipInputs.join, conversationId: "" },
    { ...membershipInputs.join, conversationId: " conversation-1" },
    { ...membershipInputs.addMember, targetUserId: "user-c " },
    { ...membershipInputs.join, expectedMemberListRevision: 0 },
    { ...membershipInputs.join, expectedMemberListRevision: -1 },
    { ...membershipInputs.join, expectedMemberListRevision: 1.5 },
    {
      ...membershipInputs.join,
      expectedMemberListRevision: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    assert.throws(
      () => parseConversationMembershipMutationInput(input),
      (error) =>
        error instanceof ConversationMembershipParseError &&
        (error.code === "malformed_identifier" ||
          error.code === "malformed_revision"),
    );
  }
});

test("rejects tenant, actor, authorization, role-escalation, visibility, and entity spoofing", () => {
  const spoofed = [
    ["tenant-id", "tenant-spoof"],
    ["organization.id", "organization-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["current-user", { id: "user-spoof" }],
    ["session id", "session-spoof"],
    ["authorization", "Bearer spoof"],
    ["role", "owner"],
    ["actorRole", "owner"],
    ["roles", ["admin"]],
    ["capabilities", ["chat.members.manage"]],
    ["permissions", ["membership:grant-owner"]],
    ["visibility", "public"],
    ["visibility-authorization", true],
    ["host-entity-authorization", true],
    ["entity", { type: "invoice", id: "invoice-1" }],
  ];

  for (const [field, value] of spoofed) {
    assert.throws(
      () =>
        parseConversationMembershipMutationInput({
          ...membershipInputs.changeRole,
          [field]: value,
        }),
      assertParseError("server_derived_field"),
      field,
    );
  }
});

test("parses canonical applied results for every intent and preserves member-list revisions", () => {
  for (const { input, result } of validMembershipCases) {
    const parsed = parseConversationMembershipMutationResult(
      JSON.parse(JSON.stringify(result)),
      input,
    );
    assert.deepEqual(parsed, result);
    assert.equal(parsed.expectedMemberListRevision, input.expectedMemberListRevision);
    assert.equal(parsed.memberListRevision, input.expectedMemberListRevision + 1);
  }
});

test("parses deterministic replay, already-realized, and member-list conflict outcomes", () => {
  const input = membershipInputs.addMember;
  const applied = appliedMembershipResult(input);
  const replayed = { ...applied, reconciliationStatus: "replayed" };
  const alreadyRequested = {
    ...applied,
    reconciliationStatus: "already_requested_state",
    memberListRevision: input.expectedMemberListRevision,
  };
  const conflict = {
    ...applied,
    reconciliationStatus: "member_list_conflict",
    memberListRevision: input.expectedMemberListRevision + 3,
  };

  for (const result of [replayed, alreadyRequested, conflict]) {
    const parsed = parseConversationMembershipMutationResult(result, input);
    assert.equal(parsed.reconciliationStatus, result.reconciliationStatus);
    assert.equal(parsed.memberListRevision, result.memberListRevision);
  }
});

test("parses typed last-owner and last-active-member safety outcomes", () => {
  const lastOwner = {
    operation: "mutate_conversation_membership",
    intent: "change_member_role",
    reconciliationStatus: "safety_rejected",
    conversationId: "conversation-1",
    expectedMemberListRevision: 8,
    memberListRevision: 8,
    memberUserId: "user-b",
    members: [
      {
        userId: "user-actor",
        role: "member",
        state: "active",
        joinedAt: timestamp,
        updatedAt: timestamp,
      },
      {
        userId: "user-b",
        role: "owner",
        state: "active",
        joinedAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    targetUserId: "user-b",
    requestedRole: "moderator",
    safetyError: {
      code: "last_owner",
      message: "A conversation must retain an owner.",
    },
  };
  const lastMember = {
    operation: "mutate_conversation_membership",
    intent: "leave",
    reconciliationStatus: "safety_rejected",
    conversationId: "conversation-1",
    expectedMemberListRevision: 5,
    memberListRevision: 5,
    memberUserId: "user-actor",
    members: [
      {
        userId: "user-actor",
        role: "owner",
        state: "active",
        joinedAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    safetyError: {
      code: "last_active_member",
      message: "The last active member cannot leave.",
    },
  };

  assert.equal(
    parseConversationMembershipMutationResult(lastOwner, membershipInputs.changeRole)
      .safetyError?.code,
    "last_owner",
  );
  assert.equal(
    parseConversationMembershipMutationResult(lastMember, membershipInputs.leave)
      .safetyError?.code,
    "last_active_member",
  );
});

test("rejects duplicate, noncanonical, malformed, and request-incoherent results", () => {
  const input = membershipInputs.addMember;
  const valid = appliedMembershipResult(input);
  const reversedMembers = [...valid.members].reverse();
  const duplicateMembers = [...valid.members, valid.members.at(-1)];
  const invalid = [
    [{ ...valid, members: duplicateMembers }, "duplicate_member"],
    [{ ...valid, members: reversedMembers }, "noncanonical_member_order"],
    [{ ...valid, targetUserId: "user-other" }, "incoherent_result"],
    [{ ...valid, memberUserId: "user-other" }, "incoherent_result"],
    [{ ...valid, requestedRole: "owner" }, "incoherent_result"],
    [{ ...valid, conversationId: "conversation-other" }, "incoherent_result"],
    [{ ...valid, expectedMemberListRevision: 5 }, "incoherent_result"],
    [{ ...valid, memberListRevision: 6 }, "incoherent_result"],
    [{ ...valid, toggle: true }, "malformed_result"],
    [{ ...valid, members: valid.members.map((member) => ({ ...member, tenantId: "spoof" })) }, "malformed_result"],
  ];

  for (const [result, code] of invalid) {
    assert.throws(
      () => parseConversationMembershipMutationResult(result, input),
      assertParseError(code),
    );
  }
});

test("rejects safety results that do not prove the safety invariant", () => {
  const base = {
    operation: "mutate_conversation_membership",
    intent: "leave",
    reconciliationStatus: "safety_rejected",
    conversationId: "conversation-1",
    expectedMemberListRevision: 5,
    memberListRevision: 5,
    memberUserId: "user-actor",
    members: [
      {
        userId: "user-actor",
        role: "owner",
        state: "active",
        joinedAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    safetyError: { code: "last_owner", message: "Owner required." },
  };

  for (const result of [
    { ...base, intent: "join" },
    { ...base, members: [{ ...base.members[0], state: "left" }] },
    {
      ...base,
      safetyError: { code: "last_active_member", message: "Member required." },
      members: [
        ...base.members,
        {
          userId: "user-b",
          role: "member",
          state: "active",
          joinedAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  ]) {
    assert.throws(
      () => parseConversationMembershipMutationResult(result, membershipInputs.leave),
      assertParseError("incoherent_result"),
    );
  }
});
