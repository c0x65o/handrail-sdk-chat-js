import {
  parseConversationMembershipMutationInput,
  parseConversationMembershipMutationResult,
  type AddConversationMemberInput,
  type AddConversationMemberResult,
  type CanonicalConversationMemberState,
  type ChangeConversationMemberRoleInput,
  type ChangeConversationMemberRoleResult,
  type ConversationId,
  type ConversationMembershipMutationInput,
  type ConversationMembershipMutationResult,
  type JoinConversationInput,
  type LeaveConversationInput,
  type LeaveConversationResult,
  type RemoveConversationMemberInput,
  type UserId,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;
const actorUserId = "user-actor" as UserId;
const targetUserId = "user-target" as UserId;

const join: JoinConversationInput = {
  operation: "mutate_conversation_membership",
  intent: "join",
  conversationId,
  expectedMemberListRevision: 1,
  idempotencyKey: "join-1",
};
const leave: LeaveConversationInput = {
  ...join,
  intent: "leave",
  idempotencyKey: "leave-1",
};
const add: AddConversationMemberInput = {
  ...join,
  intent: "add_member",
  targetUserId,
  requestedRole: "moderator",
  idempotencyKey: "add-1",
};
const remove: RemoveConversationMemberInput = {
  ...join,
  intent: "remove_member",
  targetUserId,
  idempotencyKey: "remove-1",
};
const changeRole: ChangeConversationMemberRoleInput = {
  ...join,
  intent: "change_member_role",
  targetUserId,
  requestedRole: "owner",
  idempotencyKey: "role-1",
};

// @ts-expect-error Every membership mutation requires an idempotency key.
const missingIdempotency: ConversationMembershipMutationInput = {
  operation: "mutate_conversation_membership",
  intent: "join",
  conversationId,
  expectedMemberListRevision: 1,
};
const joinWithTarget: JoinConversationInput = {
  ...join,
  // @ts-expect-error Self join derives its user from the trusted actor.
  targetUserId,
};
const leaveWithRole: LeaveConversationInput = {
  ...leave,
  // @ts-expect-error Self leave cannot request a role.
  requestedRole: "owner",
};
// @ts-expect-error Targeted add requires a target user.
const addWithoutTarget: AddConversationMemberInput = {
  ...join,
  intent: "add_member",
  requestedRole: "member",
};
const removeWithRole: RemoveConversationMemberInput = {
  ...remove,
  // @ts-expect-error Remove has no role semantics.
  requestedRole: "owner",
};
const toggleIntent: ConversationMembershipMutationInput = {
  ...join,
  // @ts-expect-error Toggle is ambiguous; callers must choose an explicit intent.
  intent: "toggle",
};
const tenantSpoof: AddConversationMemberInput = {
  ...add,
  // @ts-expect-error Tenant comes from the trusted host session.
  tenantId: "tenant-spoof",
};
const actorSpoof: AddConversationMemberInput = {
  ...add,
  // @ts-expect-error Actor comes from the trusted host session.
  actorUserId,
};
const roleEscalationSpoof: AddConversationMemberInput = {
  ...add,
  // @ts-expect-error Actor roles come from trusted server context.
  actorRole: "owner",
};
const capabilitySpoof: AddConversationMemberInput = {
  ...add,
  // @ts-expect-error Capabilities come from trusted server context.
  capabilities: ["chat.members.manage"],
};
const visibilitySpoof: AddConversationMemberInput = {
  ...add,
  // @ts-expect-error Visibility authorization is server-derived.
  visibility: "public",
};
const entitySpoof: AddConversationMemberInput = {
  ...add,
  // @ts-expect-error Host-entity authorization is server-derived.
  entity: { type: "invoice", id: "invoice-1" },
};

const member: CanonicalConversationMemberState = {
  userId: targetUserId,
  role: "moderator",
  state: "active",
  joinedAt: "2026-08-26T04:30:00.000Z",
  updatedAt: "2026-08-26T04:30:00.000Z",
};
const addResult: AddConversationMemberResult = {
  operation: "mutate_conversation_membership",
  intent: "add_member",
  reconciliationStatus: "applied",
  conversationId,
  targetUserId,
  requestedRole: "moderator",
  expectedMemberListRevision: 1,
  memberListRevision: 2,
  memberUserId: targetUserId,
  members: [member],
};
const lastMemberResult: LeaveConversationResult = {
  operation: "mutate_conversation_membership",
  intent: "leave",
  reconciliationStatus: "safety_rejected",
  conversationId,
  expectedMemberListRevision: 1,
  memberListRevision: 1,
  memberUserId: actorUserId,
  members: [{ ...member, userId: actorUserId, role: "owner" }],
  safetyError: {
    code: "last_active_member",
    message: "The last member cannot leave.",
  },
};
const changeRoleSafetyResult: ChangeConversationMemberRoleResult = {
  operation: "mutate_conversation_membership",
  intent: "change_member_role",
  reconciliationStatus: "safety_rejected",
  conversationId,
  targetUserId,
  requestedRole: "member",
  expectedMemberListRevision: 1,
  memberListRevision: 1,
  memberUserId: targetUserId,
  members: [{ ...member, role: "owner" }],
  safetyError: {
    code: "last_owner",
    message: "The conversation must retain an owner.",
  },
};
const invalidChangeRoleSafety: ChangeConversationMemberRoleResult = {
  ...changeRoleSafetyResult,
  safetyError: {
    // @ts-expect-error Role changes cannot trigger last-active-member protection.
    code: "last_active_member",
    message: "Invalid safety outcome.",
  },
};

function reconcile(result: ConversationMembershipMutationResult): number {
  if (result.reconciliationStatus === "safety_rejected") {
    return result.safetyError.code === "last_owner"
      ? result.memberListRevision
      : result.expectedMemberListRevision;
  }
  return result.memberListRevision;
}

for (const input of [join, leave, add, remove, changeRole]) {
  parseConversationMembershipMutationInput(input);
}
parseConversationMembershipMutationResult(addResult, add);
reconcile(lastMemberResult);
reconcile(changeRoleSafetyResult);

void [
  missingIdempotency,
  joinWithTarget,
  leaveWithRole,
  addWithoutTarget,
  removeWithRole,
  toggleIntent,
  tenantSpoof,
  actorSpoof,
  roleEscalationSpoof,
  capabilitySpoof,
  visibilitySpoof,
  entitySpoof,
  invalidChangeRoleSafety,
];
