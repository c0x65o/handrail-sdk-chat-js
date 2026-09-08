import {
  createChatClient,
  createNormalizedChatCache,
  selectConversationUnreadCount,
  selectDirectMessageOtherUserRead,
  selectFirstUnreadMessage,
  selectFirstUnreadSequence,
  selectManualUnreadFromSequence,
  type ChatClient,
  type ApplicationChatStorage,
  type ApplicationChatStorageIdentity,
  type ChatDeleteMessageResult,
  type ChatEditMessageResult,
  type ChatForwardMessageResult,
  type ChatCreateChannelResult,
  type ChatCreateDirectResult,
  type ChatCreateGroupDirectResult,
  type ChatArchiveConversationResult,
  type ChatRestoreConversationResult,
  type ChatJoinConversationResult,
  type ChatLeaveConversationResult,
  type ChatAddConversationMemberResult,
  type ChatRemoveConversationMemberResult,
  type ChatChangeConversationMemberRoleResult,
  type ChatMarkReadResult,
  type ChatMarkUnreadResult,
  type ChatSetReactionResult,
  type ChatClientLifecycleListener,
  type ChatClientLifecycleState,
  type ChatNormalizedCachePersistenceDiagnosticCode,
  type ChatSnapshotQueryResult,
  type ConversationDetailSnapshot,
  type ConversationListSnapshot,
  type CreateChatClientConfig,
  type MessageTimelinePage,
  type MessageEditProjection,
  type PendingMessageDeleteProjection,
  type OfflineSendMessageQueueState,
} from "../src/client/index.js";
import type {
  AttachmentId,
  ConversationId,
  MessageId,
  MessageSequence,
  SessionId,
  TenantId,
  UserId,
} from "../src/contracts/identifiers.js";
import type { ConversationReadState } from "../src/contracts/member-read-state.js";
import type { ChatSendMessageResult } from "../src/client/index.js";

type Feature = "attachments" | "notifications" | "realtime";

const config = {
  endpoint: "/api/chat",
  async getAccessToken() {
    return "access-token";
  },
  features: {
    attachments: true,
    notifications: false,
    realtime: true,
  },
} satisfies CreateChatClientConfig<Feature>;

const client: ChatClient<Feature> = createChatClient(config);
declare const applicationStorage: ApplicationChatStorage;
const persistedClient = createChatClient({
  ...config,
  normalizedCachePersistence: {
    storage: applicationStorage,
    async resolveIdentity(): Promise<ApplicationChatStorageIdentity> {
      return {
        tenantId: "tenant" as TenantId,
        userId: "user" as UserId,
        deviceId: "device" as import("../src/contracts/identifiers.js").DeviceId,
      };
    },
    onDiagnostic(diagnostic) {
      const code: ChatNormalizedCachePersistenceDiagnosticCode = diagnostic.code;
      void code;
    },
  },
});
void persistedClient;
declare const atomicApplicationStorage: ApplicationChatStorage & {
  readonly compareExchange: NonNullable<ApplicationChatStorage["compareExchange"]>;
};
const crossTabPersistedClient = createChatClient({
  ...config,
  crossTab: { sessionFingerprint: "trusted-non-secret-scope" },
  normalizedCachePersistence: {
    storage: atomicApplicationStorage,
    resolveIdentity: async (): Promise<ApplicationChatStorageIdentity> => ({
      tenantId: "tenant" as TenantId,
      userId: "user" as UserId,
      deviceId: "device" as import("../src/contracts/identifiers.js").DeviceId,
    }),
  },
});
void crossTabPersistedClient;
// @ts-expect-error Persistence diagnostic codes are a closed public union.
const unknownPersistenceDiagnosticCode: ChatNormalizedCachePersistenceDiagnosticCode =
  "unknown_diagnostic_code";
void unknownPersistenceDiagnosticCode;
const queuedSendState: OfflineSendMessageQueueState =
  persistedClient.getSendMessageQueueState();
const unsubscribeQueuedSends: () => void =
  persistedClient.subscribeSendMessageQueue((state) => {
    const observed: OfflineSendMessageQueueState = state;
    void observed;
  });
const cancelledQueuedSend: Promise<boolean> =
  persistedClient.cancelQueuedMessage("client-message-id");
void queuedSendState;
void unsubscribeQueuedSends;
void cancelledQueuedSend;
const lifecycle: ChatClientLifecycleState<Feature> = client.state;
const lifecycleListener: ChatClientLifecycleListener<Feature> = (state) => {
  const observedLifecycle: ChatClientLifecycleState<Feature> = state;
  void observedLifecycle;
};
const unsubscribeLifecycle: () => void =
  client.subscribeLifecycle(lifecycleListener);
const startResult: Promise<ChatClientLifecycleState<Feature>> = client.start();
const closeResult: void = client.close();
const cache = createNormalizedChatCache({
  tenantId: "tenant" as TenantId,
  userId: "user" as UserId,
  sessionId: "session" as SessionId,
});
const conversationId = "conversation" as ConversationId;
const hydratedClient = createChatClient({ ...config, cache });
const listResult: Promise<ChatSnapshotQueryResult<ConversationListSnapshot<Feature>>> =
  hydratedClient.listConversations({ scope: { type: "organization" }, limit: 25 });
const detailResult: Promise<ChatSnapshotQueryResult<ConversationDetailSnapshot<Feature>>> =
  hydratedClient.getConversation({ conversationId });
const timelineResult: Promise<ChatSnapshotQueryResult<MessageTimelinePage>> =
  hydratedClient.getMessageTimeline({
    conversationId,
    direction: "forward",
    cursor: 4,
    limit: 50,
  });
const sendResult: Promise<ChatSendMessageResult> = hydratedClient.sendMessage({
  conversationId,
  content: {
    format: "markdown",
    text: "Hello",
    mentions: [{ type: "user", userId: "user" as UserId }],
    attachments: [{ attachmentId: "attachment" as AttachmentId }],
  },
});
const retryResult: Promise<ChatSendMessageResult> =
  hydratedClient.retryMessage("client-message-id");
const forwardResult: Promise<ChatForwardMessageResult> =
  hydratedClient.forwardMessage({
    sourceMessageId: "source-message" as MessageId,
    destinationConversationId: conversationId,
  });
const editResult: Promise<ChatEditMessageResult> = hydratedClient.editMessage({
  messageId: "message" as MessageId,
  expectedRevision: 1,
  content: { format: "plain", text: "Edited" },
});
const deleteResult: Promise<ChatDeleteMessageResult> = hydratedClient.deleteMessage({
  messageId: "message" as MessageId,
  expectedRevision: 1,
});
const createChannelResult: Promise<ChatCreateChannelResult> =
  hydratedClient.createChannel({ name: "General", visibility: "public" });
const createDirectResult: Promise<ChatCreateDirectResult> =
  hydratedClient.createDirect({ intendedMemberUserIds: ["other" as UserId] });
const createGroupDirectResult: Promise<ChatCreateGroupDirectResult> =
  hydratedClient.createGroupDirect({
    intendedMemberUserIds: ["other" as UserId, "third" as UserId],
  });
const archiveResult: Promise<ChatArchiveConversationResult> =
  hydratedClient.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
const restoreResult: Promise<ChatRestoreConversationResult> =
  hydratedClient.restoreConversation({
    conversationId,
    expectedLifecycleRevision: 2,
  });
const joinResult: Promise<ChatJoinConversationResult> =
  hydratedClient.joinConversation({ conversationId, expectedMemberListRevision: 1 });
const leaveResult: Promise<ChatLeaveConversationResult> =
  hydratedClient.leaveConversation({ conversationId, expectedMemberListRevision: 2 });
const addMemberResult: Promise<ChatAddConversationMemberResult> =
  hydratedClient.addConversationMember({
    conversationId,
    expectedMemberListRevision: 3,
    targetUserId: "other" as UserId,
    requestedRole: "member",
  });
const removeMemberResult: Promise<ChatRemoveConversationMemberResult> =
  hydratedClient.removeConversationMember({
    conversationId,
    expectedMemberListRevision: 4,
    targetUserId: "other" as UserId,
  });
const changeRoleResult: Promise<ChatChangeConversationMemberRoleResult> =
  hydratedClient.changeConversationMemberRole({
    conversationId,
    expectedMemberListRevision: 5,
    targetUserId: "other" as UserId,
    requestedRole: "moderator",
  });

hydratedClient.createChannel({
  name: "Invalid identity",
  visibility: "private",
  // @ts-expect-error Trusted actor identity is server-derived.
  actorUserId: "actor" as UserId,
});
hydratedClient.joinConversation({
  conversationId,
  expectedMemberListRevision: 1,
  // @ts-expect-error Tenant identity is server-derived.
  tenantId: "tenant" as TenantId,
});
const markReadResult: Promise<ChatMarkReadResult> = hydratedClient.markRead({
  conversationId,
  throughSequence: 7 as MessageSequence,
});
const markUnreadResult: Promise<ChatMarkUnreadResult> = hydratedClient.markUnread({
  conversationId,
  fromSequence: 5 as MessageSequence,
});
const cacheState = cache.getState();
const unreadCount: number | undefined =
  selectConversationUnreadCount(cacheState, conversationId);
const firstUnreadSequence: MessageSequence | undefined =
  selectFirstUnreadSequence(cacheState, conversationId);
const firstUnreadMessage = selectFirstUnreadMessage(cacheState, conversationId);
const manualUnreadSequence: MessageSequence | undefined =
  selectManualUnreadFromSequence(cacheState, conversationId);
const suppliedOtherCursor: ConversationReadState = {
  conversationId,
  userId: "other" as UserId,
  lastReadSequence: 7 as MessageSequence,
  updatedAt: "2030-01-01T00:00:00.000Z",
};
const directReceipt: boolean | undefined = selectDirectMessageOtherUserRead(
  cacheState,
  {
    conversationId,
    otherMemberReadState: suppliedOtherCursor,
    messageSequence: 6 as MessageSequence,
  },
);
const reactionResult: Promise<ChatSetReactionResult> = hydratedClient.setReaction({
  messageId: "message" as MessageId,
  reactionKey: "👍",
  reacted: true,
});

const describeEdit = async (): Promise<string> => {
  const result = await editResult;
  if (result.status !== "success") return result.status;
  return result.value.reconciliationStatus === "revision_conflict"
    ? `${result.value.expectedRevision}:${result.value.canonicalRevision}`
    : result.value.reconciliationStatus;
};

const describeEditProjection = (message: MessageEditProjection): string =>
  message.editState.state === "pending"
    ? message.editState.idempotencyKey
    : `${message.editState.expectedRevision}:${message.editState.canonicalRevision}`;

const describeDeleteProjection = (
  message: PendingMessageDeleteProjection,
): string => `${message.deleteState.idempotencyKey}:${message.deleteState.expectedRevision}`;

hydratedClient.sendMessage({
  conversationId,
  content: {
    format: "plain",
    text: "invalid mention",
    // @ts-expect-error Mention types have strict identifier shapes.
    mentions: [{ type: "user", conversationId }],
  },
});

hydratedClient.editMessage({
  messageId: "message" as MessageId,
  // @ts-expect-error Expected revisions are numeric optimistic-concurrency values.
  expectedRevision: "1",
  content: { format: "plain", text: "invalid revision" },
});

hydratedClient.deleteMessage({
  messageId: "message" as MessageId,
  // @ts-expect-error Expected revisions are numeric optimistic-concurrency values.
  expectedRevision: "1",
});

hydratedClient.markRead({
  conversationId,
  // @ts-expect-error Read targets are conversation-local numeric sequences.
  throughSequence: "7",
});

hydratedClient.markUnread({
  conversationId,
  // @ts-expect-error Manual unread targets are explicit numeric sequences.
  fromSequence: "5",
});

hydratedClient.setReaction({
  messageId: "message" as MessageId,
  reactionKey: "👍",
  // @ts-expect-error Reaction state is an explicit boolean, never toggle semantics.
  reacted: "toggle",
});

const describeState = (state: ChatClientLifecycleState<Feature>): string => {
  switch (state.state) {
    case "idle":
      return "idle";
    case "starting":
      return "starting";
    case "ready":
      return `${state.clientPackageVersion}:${state.enabledFeatures.realtime}`;
    case "refresh_required":
      return `${state.reason}:${state.requestedProtocolVersion}`;
    case "error":
      return state.diagnostic.code;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

createChatClient<Feature>({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  features: {
    attachments: true,
    notifications: false,
    // @ts-expect-error Declared client features must use boolean values.
    realtime: "enabled",
  },
});

createChatClient({
  // @ts-expect-error The endpoint is a string URL or path.
  endpoint: 42,
  getAccessToken: () => "token",
});

void [
  lifecycle,
  lifecycleListener,
  unsubscribeLifecycle,
  startResult,
  closeResult,
  listResult,
  detailResult,
  timelineResult,
  sendResult,
  retryResult,
  forwardResult,
  editResult,
  deleteResult,
  createChannelResult,
  createDirectResult,
  createGroupDirectResult,
  archiveResult,
  restoreResult,
  joinResult,
  leaveResult,
  addMemberResult,
  removeMemberResult,
  changeRoleResult,
  markReadResult,
  markUnreadResult,
  unreadCount,
  firstUnreadSequence,
  firstUnreadMessage,
  manualUnreadSequence,
  directReceipt,
  reactionResult,
  describeEdit,
  describeEditProjection,
  describeDeleteProjection,
  describeState,
];

hydratedClient.sendMessage({
  conversationId,
  content: { format: "plain", text: "inline reply" },
  replyTo: { messageId: "source" as MessageId, notifyAuthor: false },
});
hydratedClient.sendMessage({
  conversationId,
  content: { format: "plain", text: "bad ping" },
  // @ts-expect-error Reply ping is a boolean.
  replyTo: { messageId: "source" as MessageId, notifyAuthor: "yes" },
});
hydratedClient.sendMessage({
  conversationId,
  content: { format: "plain", text: "no source snapshots" },
  // @ts-expect-error Reply references cannot carry invented source attribution.
  replyTo: { messageId: "source" as MessageId, notifyAuthor: true, authorId: "actor" },
});
