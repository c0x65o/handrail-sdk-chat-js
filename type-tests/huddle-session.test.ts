import {
  parseHuddleCommandResult,
  type ActiveHuddleState,
  type ConversationId,
  type HuddleCommandInput,
  type HuddleMediaJoinDescriptor,
  type HuddleSessionId,
  type JoinHuddleResult,
  type SetHuddleScreenShareInput,
  type StartHuddleInput,
  type UserId,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;
const huddleSessionId = "huddle-1" as HuddleSessionId;
const userId = "user-1" as UserId;

const startInput: StartHuddleInput = {
  operation: "start_huddle",
  conversationId,
  idempotencyKey: "start-1",
};
const shareInput: SetHuddleScreenShareInput = {
  operation: "set_huddle_screen_share",
  huddleSessionId,
  intent: "set",
  idempotencyKey: "share-1",
};

const tenantSpoof: StartHuddleInput = {
  ...startInput,
  // @ts-expect-error Tenant identity comes from trusted server context.
  tenantId: "tenant-spoof",
};
const actorSpoof: StartHuddleInput = {
  ...startInput,
  // @ts-expect-error Actor identity comes from trusted server context.
  actorUserId: "user-spoof",
};
const capabilitySpoof: StartHuddleInput = {
  ...startInput,
  // @ts-expect-error Capabilities are resolved by the trusted host adapter.
  capabilities: ["huddle.start"],
};
const providerSpoof: StartHuddleInput = {
  ...startInput,
  // @ts-expect-error Media-provider selection is server-derived.
  mediaProvider: "vendor",
};
const roomTokenSpoof: StartHuddleInput = {
  ...startInput,
  // @ts-expect-error Raw provider room tokens are never caller input.
  roomToken: "secret",
};
// @ts-expect-error Every huddle command requires an idempotency key.
const missingIdempotency: StartHuddleInput = {
  operation: "start_huddle",
  conversationId,
};
const toggleShare: SetHuddleScreenShareInput = {
  operation: "set_huddle_screen_share",
  huddleSessionId,
  // @ts-expect-error Screen sharing uses explicit set or clear intent.
  intent: "toggle",
  idempotencyKey: "share-2",
};

const activeState: ActiveHuddleState = {
  status: "active",
  conversationId,
  huddleSessionId,
  startedAt: "2026-08-25T20:00:00.000Z",
  participants: [
    {
      userId,
      status: "joined",
      joinedAt: "2026-08-25T20:00:10.000Z",
    },
  ],
  screenShareOwnerUserId: userId,
};
const mediaJoin: HuddleMediaJoinDescriptor = {
  kind: "opaque_media_join",
  descriptor: "opaque",
  expiresAt: "2026-08-25T20:04:00.000Z",
};
const joinResult: JoinHuddleResult = {
  operation: "join_huddle",
  outcome: "ok",
  reconciliationStatus: "applied",
  state: activeState,
  mediaJoin,
};

const endedWithOwner = {
  status: "ended",
  conversationId,
  huddleSessionId,
  startedAt: "2026-08-25T20:00:00.000Z",
  endedAt: "2026-08-25T20:05:00.000Z",
  endedByUserId: userId,
  participants: [],
  // @ts-expect-error Ended state cannot retain a screen-share owner.
  screenShareOwnerUserId: userId,
} satisfies import("../src/index.js").EndedHuddleState;

function operationNarrowing(input: HuddleCommandInput): HuddleSessionId | ConversationId {
  if (input.operation === "start_huddle") return input.conversationId;
  if (input.operation === "set_huddle_screen_share") {
    const intent: "set" | "clear" = input.intent;
    void intent;
  }
  return input.huddleSessionId;
}

parseHuddleCommandResult(
  joinResult,
  {
    operation: "join_huddle",
    huddleSessionId,
    idempotencyKey: "join-1",
  },
  { now: "2026-08-25T20:00:00.000Z" },
);
operationNarrowing(shareInput);

void [
  tenantSpoof,
  actorSpoof,
  capabilitySpoof,
  providerSpoof,
  roomTokenSpoof,
  missingIdempotency,
  toggleShare,
  endedWithOwner,
];
