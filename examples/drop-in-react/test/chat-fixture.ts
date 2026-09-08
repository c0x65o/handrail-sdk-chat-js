import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
  type ChatClient,
  type ConversationDetailSnapshotConversation,
  type ConversationListSnapshotSummary,
} from "@handrail/chat/client";

type NonArchivedChannelListSummary = Extract<
  ConversationListSnapshotSummary,
  { readonly type: "channel"; readonly archivedAt?: never }
>;
type NonArchivedChannelDetailConversation = Extract<
  ConversationDetailSnapshotConversation,
  { readonly type: "channel"; readonly archivedAt?: never }
>;

const now = "2038-05-06T07:08:09.000Z";
const tenantId = "tenant-drop-in" as never;
const userId = "user-current" as never;
const otherUserId = "user-avery" as never;
const organizationConversationId = "conversation-organization" as never;
const recordConversationId = "conversation-sales-order" as never;
const organizationScope = { type: "organization" } as const;
const recordScope = {
  type: "entity",
  entity: { type: "sales-order", id: "SO-1042" },
} as const;
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: 4,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: { minimumVersion: 4, maximumVersion: 4 },
  feature: { name: "conversation_snapshots", version: 1 },
} as const;

const membership = (conversationId: typeof organizationConversationId) => ({
  tenantId,
  conversationId,
  userId,
  role: "member" as const,
  state: "active" as const,
  joinedAt: now,
  updatedAt: now,
});
const readState = (conversationId: typeof organizationConversationId) => ({
  conversationId,
  userId,
  lastReadSequence: 0,
  updatedAt: now,
});
const preference = (conversationId: typeof organizationConversationId) => ({
  conversationId,
  userId,
  notificationPreference: "all" as const,
  mute: { muted: false as const },
  updatedAt: now,
});
const conversation = (
  id: typeof organizationConversationId,
  name: string,
  entity?: typeof recordScope.entity,
): NonArchivedChannelListSummary => ({
  id,
  tenantId,
  type: "channel" as const,
  name,
  visibility: "public" as const,
  ...(entity === undefined ? {} : { entity }),
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 1,
  unreadMentionCount: 0,
  currentMember: membership(id),
  currentReadState: readState(id),
  currentPreference: preference(id),
  activeMemberUserIds: [otherUserId],
  hasActiveHuddle: false,
});

const organizationConversation = conversation(
  organizationConversationId,
  "Organization operations",
);
const recordConversation = conversation(
  recordConversationId,
  "Sales order SO-1042",
  recordScope.entity,
);
const directoryUser = {
  kind: "active",
  userId: otherUserId,
  displayName: "Avery Example",
  avatar: { kind: "initials", initials: "AE" },
} as const;

const detail = (item: NonArchivedChannelListSummary) => {
  const { hasActiveHuddle: _hasActiveHuddle, ...conversationSummary } = item;
  return {
    kind: "conversation_detail" as const,
    conversation: {
      ...conversationSummary,
      memberUserIds: [otherUserId],
    } satisfies NonArchivedChannelDetailConversation,
    _meta: metadata,
  };
};
const timeline = (conversationId: typeof organizationConversationId, text: string) => ({
  conversationId,
  messages: [{
    id: `message-${String(conversationId)}` as never,
    tenantId,
    conversationId,
    author: { type: "user" as const, userId: otherUserId },
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    revision: { revision: 1 },
    content: {
      format: "plain" as const,
      text,
      blocks: [{
        type: "entity_reference",
        data: {
          entity: { type: "sales-order", id: "SO-1042" },
          label: "Sales order SO-1042",
          description: "Northwind renewal",
        },
      }, {
        type: "system_event",
        data: {
          kind: "approval_requested",
          summary: "Approval requested",
          details: { source: "sales-order" },
        },
      }],
    },
    isThreadRoot: false as const,
    reactions: [],
    attachmentMetadata: [{
      attachmentId: `attachment-${String(conversationId)}` as never,
      fileName: "approval-notes.txt",
      contentType: "text/plain" as const,
      sizeBytes: 42,
      downloadUrl: "/files/approval-notes.txt",
    }],
  }],
  pagination: {
    older: { available: false as const },
    newer: { available: false as const },
  },
  replay: { resumeFrom: { eventId: `event-${String(conversationId)}` as never } },
});

export interface DropInFixtureOptions {
  readonly onSendMessage?: (
    input: Parameters<ChatClient["sendMessage"]>[0],
  ) => void;
}

export function createDropInFixture(
  options: DropInFixtureOptions = {},
): ChatClient {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: "session-drop-in" as never,
  });
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: organizationScope,
    items: [organizationConversation, recordConversation],
    page: {},
    _meta: metadata,
  });
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: recordScope,
    items: [recordConversation],
    page: {},
    _meta: metadata,
  });
  cache.hydrateConversationDetail(detail(organizationConversation));
  cache.hydrateConversationDetail(detail(recordConversation));
  cache.hydrateMessageTimeline(timeline(
    organizationConversationId,
    "The full-screen workspace is ready.",
  ));
  cache.hydrateMessageTimeline(timeline(
    recordConversationId,
    "Approval notes are attached to this record.",
  ));

  const drafts = new Map([
    organizationConversationId,
    recordConversationId,
  ].map((conversationId) => [conversationId, {
    conversationId,
    status: "ready" as const,
    authoritativeRevision: 0,
    dirty: false,
  }]));
  const threadOpenings = new Map<unknown, object>();
  const huddles = new Map<unknown, object>();
  const success = () => Promise.resolve({ status: "success", value: {} });
  const client = {
    endpoint: "/api/chat",
    state: {
      state: "ready",
      clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
      protocolVersion: 4,
      metadata,
      enabledFeatures: {},
    },
    cache,
    start: async () => undefined,
    close() {},
    subscribeLifecycle: () => () => undefined,
    listConversations: success,
    getConversation: success,
    getMessageTimeline: success,
    selectDirectoryUser: (selectedUserId: unknown) =>
      selectedUserId === otherUserId ? directoryUser : undefined,
    hydrateDirectoryUsers: async () => ({
      status: "success",
      value: { users: [directoryUser] },
    }),
    selectConversationDraft: (conversationId: typeof organizationConversationId) =>
      drafts.get(conversationId),
    subscribeConversationDraft: () => () => undefined,
    openConversationDraft: async (conversationId: typeof organizationConversationId) =>
      drafts.get(conversationId),
    replaceConversationDraft: () => undefined,
    clearConversationDraft: () => undefined,
    flushConversationDraft: success,
    retryConversationDraft: success,
    closeConversationDraft: success,
    startTyping: () => true,
    stopTyping() {},
    sendMessage: (input: Parameters<ChatClient["sendMessage"]>[0]) => {
      options.onSendMessage?.(input);
      return success();
    },
    retryMessage: success,
    markRead: success,
    getThreadOpeningState(rootMessageId: unknown) {
      let opening = threadOpenings.get(rootMessageId);
      if (opening === undefined) {
        opening = Object.freeze({ state: "idle", rootMessageId });
        threadOpenings.set(rootMessageId, opening);
      }
      return opening;
    },
    subscribeThreadOpening: () => () => undefined,
    getHuddleState(conversationId: unknown) {
      let huddle = huddles.get(conversationId);
      if (huddle === undefined) {
        huddle = Object.freeze({
          conversationId,
          hydrationStatus: "ready",
          media: Object.freeze({ state: "idle" }),
        });
        huddles.set(conversationId, huddle);
      }
      return huddle;
    },
    subscribeHuddle: () => () => undefined,
  };
  return client as unknown as ChatClient;
}
