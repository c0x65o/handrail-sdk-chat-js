import {
  createConversationSnapshotMetadata,
  encodeConversationSnapshotCursor,
  parseConversationDetailSnapshotInput,
  parseConversationListSnapshotInput,
  type ConversationDetailSnapshot,
  type ConversationDetailSnapshotInput,
  type ConversationId,
  type ConversationListSnapshot,
  type ConversationListSnapshotInput,
  type ConversationListSnapshotSummary,
  type ConversationSnapshotScope,
  type ConversationSnapshotSummary,
  type MessageId,
  type TenantId,
  type UserId,
} from "../src/index.js";

const tenantId = "tenant-1" as TenantId;
const userId = "user-1" as UserId;
const conversationId = "conversation-1" as ConversationId;
const rootMessageId = "message-1" as MessageId;
const now = "2026-08-25T20:00:00.000Z";

const organizationScope: ConversationSnapshotScope = { type: "organization" };
const entityScope: ConversationSnapshotScope = {
  type: "entity",
  entity: { type: "order", id: "order-42" },
};
const cursor = encodeConversationSnapshotCursor({
  isStarred: false,
  navigationRank: 0,
  activityAt: now,
  conversationId,
});

// @ts-expect-error New v3 cursors require a bounded navigation rank.
encodeConversationSnapshotCursor({
  isStarred: false,
  activityAt: now,
  conversationId,
});

const listInput: ConversationListSnapshotInput = {
  scope: entityScope,
  cursor,
  limit: 25,
};
const detailInput: ConversationDetailSnapshotInput = { conversationId };

const tenantSpoof: ConversationListSnapshotInput = {
  scope: organizationScope,
  // @ts-expect-error Tenant context is resolved from the trusted server session.
  tenantId,
};
const actorSpoof: ConversationDetailSnapshotInput = {
  conversationId,
  // @ts-expect-error Actor context is resolved from the trusted server session.
  actor: { userId },
};
const userSpoof: ConversationDetailSnapshotInput = {
  conversationId,
  // @ts-expect-error User identity is resolved from the trusted server session.
  user: { id: userId },
};
const roleSpoof: ConversationListSnapshotInput = {
  scope: organizationScope,
  // @ts-expect-error Authorization roles are resolved from trusted server context.
  role: "owner",
};
const nestedUserSpoof: ConversationListSnapshotInput = {
  scope: {
    type: "entity",
    entity: {
      type: "order",
      id: "order-42",
      // @ts-expect-error Host entity scopes carry only opaque type and ID values.
      userId,
    },
  },
};

parseConversationListSnapshotInput(listInput);
parseConversationDetailSnapshotInput(detailInput);

const currentState = {
  latestSequence: 4,
  activityAt: now,
  unreadMentionCount: 1,
  hasActiveHuddle: true,
  activeMemberUserIds: [userId],
  currentMember: {
    tenantId,
    conversationId,
    userId,
    role: "member" as const,
    state: "active" as const,
    joinedAt: now,
    updatedAt: now,
  },
  currentReadState: {
    conversationId,
    userId,
    lastReadSequence: 3,
    updatedAt: now,
  },
  currentPreference: {
    conversationId,
    userId,
    notificationPreference: "all" as const,
    isStarred: false,
    mute: { muted: false as const },
    updatedAt: now,
  },
};

const publicChannel: ConversationListSnapshotSummary = {
  id: conversationId,
  tenantId,
  type: "channel",
  name: "Orders",
  visibility: "public",
  createdAt: now,
  updatedAt: now,
  ...currentState,
};

const direct: ConversationListSnapshotSummary = {
  id: conversationId,
  tenantId,
  type: "direct",
  visibility: "private",
  createdAt: now,
  updatedAt: now,
  ...currentState,
};

const thread: ConversationListSnapshotSummary = {
  id: conversationId,
  tenantId,
  type: "thread",
  visibility: "public",
  parentConversationId: "parent" as ConversationId,
  rootMessageId,
  createdAt: now,
  updatedAt: now,
  ...currentState,
};

function proveDiscrimination(summary: ConversationSnapshotSummary): string {
  switch (summary.type) {
    case "channel":
      return summary.name;
    case "direct":
      // @ts-expect-error Direct snapshots do not expose a channel name.
      return summary.name;
    case "group_direct":
      return summary.visibility;
    case "thread":
      return `${summary.parentConversationId}:${summary.rootMessageId}`;
  }
}

const metadata = createConversationSnapshotMetadata({
  packageVersion: "0.1.2",
  protocolVersion: 1,
  schemaVersion: 0,
  enabledFeatures: { threads: true },
});
const listSnapshot: ConversationListSnapshot<"threads"> = {
  kind: "conversation_list",
  scope: organizationScope,
  items: [publicChannel, direct, thread],
  page: { nextCursor: cursor },
  _meta: metadata,
};
const detailSnapshot: ConversationDetailSnapshot<"threads"> = {
  kind: "conversation_detail",
  conversation: {
    ...thread,
    memberUserIds: [userId],
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: false },
      updatedAt: now,
    },
  },
  _meta: metadata,
};

void [
  tenantSpoof,
  actorSpoof,
  userSpoof,
  roleSpoof,
  nestedUserSpoof,
  listSnapshot,
  detailSnapshot,
  proveDiscrimination(publicChannel),
];
