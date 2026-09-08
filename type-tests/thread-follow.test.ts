import type {
  CanonicalFollowingThreadState,
  CanonicalManualThreadUnfollowState,
  SetThreadFollowInput,
  SetThreadFollowResult,
} from "../src/index.js";

const input: SetThreadFollowInput = {
  operation: "set_thread_follow",
  intent: "follow",
  target: { type: "thread", id: "thread-1" as never },
  expectedFollowRevision: 0,
  idempotencyKey: "thread-follow-1",
};

const autoFollow: CanonicalFollowingThreadState = {
  target: input.target,
  isFollowing: true,
  source: "mention",
  updatedAt: "2026-08-26T20:00:00.000Z" as never,
};

const manualUnfollow: CanonicalManualThreadUnfollowState = {
  target: input.target,
  isFollowing: false,
  source: "manual",
  updatedAt: "2026-08-26T20:00:00.000Z" as never,
};

const actorSpoof: SetThreadFollowInput = {
  ...input,
  // @ts-expect-error Actor identity is trusted server context.
  actorUserId: "user-spoof",
};
const callerSource: SetThreadFollowInput = {
  ...input,
  // @ts-expect-error Follow source is server-derived, not caller input.
  followSource: "reply",
};
const generalConversationTarget: SetThreadFollowInput = {
  ...input,
  // @ts-expect-error A follow target must be specifically a thread.
  target: { type: "channel", id: "channel-1" as never },
};
const invalidUnfollow: CanonicalManualThreadUnfollowState = {
  ...manualUnfollow,
  // @ts-expect-error An unfollow cannot claim an automatic source.
  source: "reply",
};

const result = {} as SetThreadFollowResult;
if (result.reconciliationStatus === "follow_revision_conflict") {
  result.followRevision;
  result.follow.updatedAt;
}

void [autoFollow, actorSpoof, callerSource, generalConversationTarget, invalidUnfollow];
