import type {
  AttachmentId,
  Conversation,
  ConversationId,
  Message,
  MessageComposition,
  MessageContent,
  MessageId,
  TenantId,
  UserId,
} from "../src/index.js";

const tenantId = "tenant-1" as TenantId;
const channelId = "conversation-channel" as ConversationId;
const threadId = "conversation-thread" as ConversationId;
const messageId = "message-1" as MessageId;
const userId = "user-1" as UserId;
const attachmentId = "attachment-1" as AttachmentId;

const publicChannel: Conversation = {
  id: channelId,
  tenantId,
  type: "channel",
  name: "Orders",
  visibility: "public",
  entity: { type: "order", id: "order-42" },
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const privateChannel: Conversation = {
  id: "conversation-private" as ConversationId,
  tenantId,
  type: "channel",
  name: "Finance",
  visibility: "private",
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const direct: Conversation = {
  id: "conversation-direct" as ConversationId,
  tenantId,
  type: "direct",
  visibility: "private",
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const groupDirect: Conversation = {
  id: "conversation-group" as ConversationId,
  tenantId,
  type: "group_direct",
  visibility: "private",
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const thread: Conversation = {
  id: threadId,
  tenantId,
  type: "thread",
  visibility: "public",
  parentConversationId: channelId,
  rootMessageId: messageId,
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const content: MessageContent = {
  format: "markdown",
  text: "Hello **team**",
  mentions: [{ type: "user", userId }],
  attachments: [{ attachmentId }],
  blocks: [{ type: "order.preview", data: { orderId: "order-42" } }],
};

const rootMessage: Message = {
  id: messageId,
  tenantId,
  conversationId: channelId,
  author: { type: "user", userId },
  sequence: 12,
  content,
  revision: { revision: 1 },
  threadSummary: {
    threadId,
    replyCount: 2,
    participantIds: [userId],
    unreadCount: 1,
    lastReplyAt: "2026-08-25T20:01:00.000Z",
  },
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const composition: MessageComposition = { content };

// @ts-expect-error Threads require parentConversationId and rootMessageId.
const malformedThread: Conversation = {
  id: threadId,
  tenantId,
  type: "thread",
  visibility: "private",
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

// @ts-expect-error Non-thread conversations cannot carry thread linkage.
const linkedChannel: Conversation = {
  id: channelId,
  tenantId,
  type: "channel",
  name: "Invalid",
  visibility: "public",
  parentConversationId: channelId,
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

// @ts-expect-error Direct conversations cannot accept channel-only fields.
const namedDirect: Conversation = {
  id: "conversation-direct" as ConversationId,
  tenantId,
  type: "direct",
  visibility: "private",
  name: "Not a channel",
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const htmlContent: MessageContent = {
  text: "<strong>unsafe</strong>",
  // @ts-expect-error Arbitrary HTML is not a supported message format.
  format: "html",
};

// @ts-expect-error Every conversation is explicitly tenant-scoped.
const unscopedConversation: Conversation = {
  id: channelId,
  type: "channel",
  name: "Missing tenant",
  visibility: "public",
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

// @ts-expect-error Every message is explicitly tenant-scoped.
const unscopedMessage: Message = {
  id: messageId,
  conversationId: channelId,
  author: { type: "user", userId },
  sequence: 11,
  content,
  revision: { revision: 1 },
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

// @ts-expect-error Every message requires its ordered conversation sequence.
const unorderedMessage: Message = {
  id: messageId,
  tenantId,
  conversationId: channelId,
  author: { type: "user", userId },
  content,
  revision: { revision: 1 },
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const tenantSpoof: MessageComposition = {
  content,
  // @ts-expect-error Tenant context is supplied by the trusted server session.
  tenantId,
};

const authorSpoof: MessageComposition = {
  content,
  // @ts-expect-error Author identity is supplied by the trusted server session.
  author: { type: "user", userId },
};

const userSpoof: MessageComposition = {
  content,
  // @ts-expect-error User identity is supplied by the trusted server session.
  userId,
};

void [
  publicChannel,
  privateChannel,
  direct,
  groupDirect,
  thread,
  rootMessage,
  composition,
  malformedThread,
  linkedChannel,
  namedDirect,
  htmlContent,
  unscopedConversation,
  unscopedMessage,
  unorderedMessage,
  tenantSpoof,
  authorSpoof,
  userSpoof,
];
