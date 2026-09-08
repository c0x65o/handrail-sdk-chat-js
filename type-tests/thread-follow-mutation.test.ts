import {
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  type CanonicalThreadFollowState,
  type ConversationId,
  type ServerDerivedThreadParticipationAutoFollow,
  type SetThreadFollowInput,
  type SetThreadFollowResult,
  type ThreadFollowMutationReconciliationStatus,
  type ThreadFollowTarget,
} from "../src/index.js";

const threadId = "thread-1" as ConversationId;
const target: ThreadFollowTarget = { type: "thread", id: threadId };
const followInput: SetThreadFollowInput = {
  operation: "set_thread_follow",
  intent: "follow",
  target,
  expectedFollowRevision: 4,
  idempotencyKey: "thread-follow:thread-1:5",
};
const unfollowInput: SetThreadFollowInput = {
  ...followInput,
  intent: "unfollow",
};

const toggleIntent: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Toggle intent is ambiguous and unsupported.
  intent: "toggle",
};
const booleanToggle: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Explicit follow or unfollow intent replaces boolean state.
  isFollowing: true,
};
const channelTarget: SetThreadFollowInput = {
  ...followInput,
  target: {
    // @ts-expect-error A parent channel cannot be a thread-follow target.
    type: "channel",
    id: threadId,
  },
};
const generalConversationTarget: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error An opaque general conversation id does not prove thread type.
  conversationId: threadId,
};
const parentTarget: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Parent-channel identity is not accepted by this command.
  parentConversationId: "channel-parent" as ConversationId,
};
const tenantSpoof: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Tenant identity comes from trusted server context.
  tenantId: "tenant-spoof",
};
const actorSpoof: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Actor identity comes from trusted server context.
  actorUserId: "user-spoof",
};
const sessionSpoof: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Authentication context is never caller-authored.
  sessionId: "session-spoof",
};
const permissionSpoof: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Authorization remains server-derived.
  permissions: ["thread-follow:any"],
};
const callerReplySource: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Reply auto-follow is derived by server participation policy.
  source: "reply",
};
const callerMentionSource: SetThreadFollowInput = {
  ...followInput,
  // @ts-expect-error Mention auto-follow is derived by server participation policy.
  followSource: "mention",
};

const canonicalFollow: CanonicalThreadFollowState = {
  target,
  isFollowing: true,
  source: "reply",
  updatedAt: "2026-08-26T06:30:00.000Z" as never,
};
const canonicalUnfollow: CanonicalThreadFollowState = {
  target,
  isFollowing: false,
  source: "manual",
  updatedAt: "2026-08-26T06:31:00.000Z" as never,
};
// @ts-expect-error Auto-follow sources cannot masquerade as explicit unfollow.
const invalidAutoUnfollow: CanonicalThreadFollowState = {
  target,
  isFollowing: false,
  source: "mention",
  updatedAt: "2026-08-26T06:31:00.000Z" as never,
};

const autoFollowPolicy: ServerDerivedThreadParticipationAutoFollow = {
  origin: "server_policy",
  source: "reply",
  whenExplicitlyUnfollowed: "preserve_explicit_unfollow",
};
const callerAuthoredPolicy: ServerDerivedThreadParticipationAutoFollow = {
  origin: "server_policy",
  source: "mention",
  whenExplicitlyUnfollowed: "preserve_explicit_unfollow",
  // @ts-expect-error Participation policy is not caller-authored intent.
  callerAuthored: true,
};

const applied: SetThreadFollowResult = {
  operation: "set_thread_follow",
  intent: "follow",
  reconciliationStatus: "applied",
  target,
  expectedFollowRevision: 4,
  idempotencyKey: followInput.idempotencyKey,
  followRevision: 5,
  follow: { ...canonicalFollow, source: "manual" },
};
const conflict: SetThreadFollowResult = {
  ...applied,
  intent: "unfollow",
  reconciliationStatus: "follow_revision_conflict",
  followRevision: 8,
  follow: canonicalFollow,
};
const invalidStatus: SetThreadFollowResult = {
  ...applied,
  // @ts-expect-error Result statuses are closed and deterministic.
  reconciliationStatus: "conflict",
};

function reconcile(result: SetThreadFollowResult): number {
  const status: ThreadFollowMutationReconciliationStatus =
    result.reconciliationStatus;
  void status;
  return result.followRevision;
}

parseSetThreadFollowInput(followInput);
parseSetThreadFollowInput(unfollowInput);
parseSetThreadFollowResult(applied, followInput);
reconcile(conflict);

void [
  toggleIntent,
  booleanToggle,
  channelTarget,
  generalConversationTarget,
  parentTarget,
  tenantSpoof,
  actorSpoof,
  sessionSpoof,
  permissionSpoof,
  callerReplySource,
  callerMentionSource,
  canonicalUnfollow,
  invalidAutoUnfollow,
  autoFollowPolicy,
  callerAuthoredPolicy,
  invalidStatus,
];
