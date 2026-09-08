import {
  deriveCanonicalParticipantIdentity,
  parseConversationCreationInput,
  parseConversationCreationResult,
  type ChannelConversationCreationResult,
  type ChannelConversationSnapshotSummary,
  type ConversationCreationInput,
  type ConversationCreationResult,
  type ConversationSnapshotMetadata,
  type CreateChannelConversationInput,
  type CreateDirectConversationInput,
  type CreateGroupDirectConversationInput,
  type DirectConversationCreationResult,
  type DirectConversationSnapshotSummary,
  type GroupDirectConversationCreationResult,
  type GroupDirectConversationSnapshotSummary,
  type TenantId,
  type UserId,
} from "../src/index.js";

const actorUserId = "user-actor" as UserId;
const otherUserId = "user-other" as UserId;
const thirdUserId = "user-third" as UserId;

const channel: CreateChannelConversationInput = {
  operation: "create_conversation",
  type: "channel",
  name: "Orders",
  visibility: "public",
  entity: { type: "erp.order", id: "42" },
  idempotencyKey: "channel-attempt-1",
  clientRequestId: "channel-request-1",
};
const direct: CreateDirectConversationInput = {
  operation: "create_conversation",
  type: "direct",
  visibility: "private",
  intendedMemberUserIds: [otherUserId],
  idempotencyKey: "direct-attempt-1",
  clientRequestId: "direct-request-1",
};
const group: CreateGroupDirectConversationInput = {
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: [otherUserId, thirdUserId],
  idempotencyKey: "group-attempt-1",
  clientRequestId: "group-request-1",
};

// @ts-expect-error Every creation request requires an idempotency key.
const channelWithoutIdempotency: CreateChannelConversationInput = {
  operation: "create_conversation",
  type: "channel",
  name: "Orders",
  visibility: "public",
  clientRequestId: "channel-request-1",
};
// @ts-expect-error Every creation request requires a client request ID.
const directWithoutRequestId: CreateDirectConversationInput = {
  operation: "create_conversation",
  type: "direct",
  visibility: "private",
  intendedMemberUserIds: [otherUserId],
  idempotencyKey: "direct-attempt-1",
};
const directWithTwoMembers: CreateDirectConversationInput = {
  ...direct,
  // @ts-expect-error A direct request identifies exactly one other member.
  intendedMemberUserIds: [otherUserId, thirdUserId],
};
const groupWithOneMember: CreateGroupDirectConversationInput = {
  ...group,
  // @ts-expect-error A group-direct request identifies at least two other members.
  intendedMemberUserIds: [otherUserId],
};
const publicDirect: CreateDirectConversationInput = {
  ...direct,
  // @ts-expect-error Direct conversations are always private.
  visibility: "public",
};
const namedDirect: CreateDirectConversationInput = {
  ...direct,
  // @ts-expect-error Direct conversations are unnamed.
  name: "Not allowed",
};
const threadedChannel: CreateChannelConversationInput = {
  ...channel,
  // @ts-expect-error Thread fields are absent from conversation creation.
  parentConversationId: "parent",
};

const tenantSpoof: CreateChannelConversationInput = {
  ...channel,
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId: "tenant-spoof",
};
const actorSpoof: CreateDirectConversationInput = {
  ...direct,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actor: { userId: actorUserId },
};
const sessionSpoof: CreateGroupDirectConversationInput = {
  ...group,
  // @ts-expect-error Session identity comes from the trusted host session.
  sessionId: "session-spoof",
};
const roleSpoof: CreateChannelConversationInput = {
  ...channel,
  // @ts-expect-error Roles come from the trusted host session.
  roles: ["admin"],
};
const capabilitySpoof: CreateChannelConversationInput = {
  ...channel,
  // @ts-expect-error Capabilities come from the trusted host session.
  capabilities: ["chat.admin"],
};
const entityActorSpoof: CreateChannelConversationInput = {
  ...channel,
  entity: {
    type: "order",
    id: "42",
    // @ts-expect-error Opaque host entities cannot carry trusted identity.
    actorId: actorUserId,
  },
};

function discriminateInput(input: ConversationCreationInput): string {
  switch (input.type) {
    case "channel":
      return input.name;
    case "direct":
      return input.intendedMemberUserIds[0];
    case "group_direct":
      return input.intendedMemberUserIds[1];
  }
}

const metadata = {} as ConversationSnapshotMetadata;
const channelSummary = {} as ChannelConversationSnapshotSummary;
const directSummary = {} as DirectConversationSnapshotSummary;
const groupSummary = {} as GroupDirectConversationSnapshotSummary;
const participantIdentity = deriveCanonicalParticipantIdentity(actorUserId, [
  otherUserId,
]);

const createdChannel: ChannelConversationCreationResult = {
  operation: "create_conversation",
  type: "channel",
  reconciliationStatus: "created",
  clientRequestId: channel.clientRequestId,
  conversation: {
    kind: "conversation_detail",
    conversation: channelSummary,
    _meta: metadata,
  },
};
const existingDirect: DirectConversationCreationResult = {
  operation: "create_conversation",
  type: "direct",
  reconciliationStatus: "existing_equivalent",
  clientRequestId: direct.clientRequestId,
  conversation: {
    kind: "conversation_detail",
    conversation: directSummary,
    _meta: metadata,
  },
  participantIdentity,
};
const replayedGroup: GroupDirectConversationCreationResult = {
  operation: "create_conversation",
  type: "group_direct",
  reconciliationStatus: "replayed",
  clientRequestId: group.clientRequestId,
  conversation: {
    kind: "conversation_detail",
    conversation: groupSummary,
    _meta: metadata,
  },
  participantIdentity: deriveCanonicalParticipantIdentity(actorUserId, [
    otherUserId,
    thirdUserId,
  ]),
};
const equivalentChannel: ChannelConversationCreationResult = {
  ...createdChannel,
  // @ts-expect-error Existing-equivalent reconciliation is only meaningful for participant identities.
  reconciliationStatus: "existing_equivalent",
};
const channelWithParticipants: ChannelConversationCreationResult = {
  ...createdChannel,
  // @ts-expect-error Channel results do not expose participant identity.
  participantIdentity,
};

function discriminateResult(result: ConversationCreationResult): string {
  if (result.type === "channel") {
    return result.conversation.conversation.name;
  }
  return result.participantIdentity.key;
}

parseConversationCreationInput(channel);
parseConversationCreationInput(direct);
parseConversationCreationInput(group);
parseConversationCreationResult(createdChannel, channel);
parseConversationCreationResult(existingDirect, direct);
parseConversationCreationResult(replayedGroup, group);

void [
  channelWithoutIdempotency,
  directWithoutRequestId,
  directWithTwoMembers,
  groupWithOneMember,
  publicDirect,
  namedDirect,
  threadedChannel,
  tenantSpoof,
  actorSpoof,
  sessionSpoof,
  roleSpoof,
  capabilitySpoof,
  entityActorSpoof,
  equivalentChannel,
  channelWithParticipants,
  discriminateInput(channel),
  discriminateResult(existingDirect),
  "tenant" as TenantId,
];
