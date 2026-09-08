import {
  deriveUnreadCount,
  hasDirectMessageRecipientRead,
  isMonotonicMarkRead,
  markRead,
  markUnread,
  type ConversationId,
  type ConversationMember,
  type ConversationMemberPreference,
  type ConversationReadState,
  type FollowedThreadState,
  type Message,
  type MessageId,
  type TenantId,
  type UserId,
} from "../src/index.js";

const tenantId = "tenant-1" as TenantId;
const conversationId = "conversation-1" as ConversationId;
const userId = "user-1" as UserId;
const updatedAt = "2026-08-25T20:00:00.000Z";

const member: ConversationMember = {
  tenantId,
  conversationId,
  userId,
  role: "moderator",
  state: "active",
  joinedAt: updatedAt,
  updatedAt,
};

const readState: ConversationReadState = {
  conversationId,
  userId,
  lastReadSequence: 7,
  manualUnreadFromSequence: 5,
  updatedAt,
};

const followedThread: FollowedThreadState = {
  conversationId,
  userId,
  isFollowing: true,
  updatedAt,
};

const preferences: ConversationMemberPreference = {
  conversationId,
  userId,
  notificationPreference: "mentions",
  isStarred: false,
  mute: { muted: true, mutedUntil: "2026-08-26T20:00:00.000Z" },
  updatedAt,
};

const message: Message = {
  id: "message-1" as MessageId,
  tenantId,
  conversationId,
  author: { type: "user", userId },
  sequence: 7,
  content: { format: "plain", text: "hello" },
  revision: { revision: 1 },
  createdAt: updatedAt,
  updatedAt,
};

const unreadCount: number = deriveUnreadCount(message.sequence, readState);
const recipientHasRead: boolean = hasDirectMessageRecipientRead(
  readState,
  message,
);
const monotonic: boolean = isMonotonicMarkRead(
  readState.lastReadSequence,
  message.sequence,
);
const unreadAgain: ConversationReadState = markUnread(
  readState,
  message.sequence,
  updatedAt,
);
const readAgain: ConversationReadState = markRead(
  unreadAgain,
  message.sequence,
  updatedAt,
);

const invalidRole: ConversationMember = {
  ...member,
  // @ts-expect-error Membership roles are a closed public contract.
  role: "administrator",
};

const invalidNotification: ConversationMemberPreference = {
  ...preferences,
  // @ts-expect-error Notification preferences are a closed public contract.
  notificationPreference: "important",
};

const invalidUnmutedState: ConversationMemberPreference = {
  ...preferences,
  // @ts-expect-error An unmuted state cannot carry a mute expiry.
  mute: { muted: false, mutedUntil: updatedAt },
};

void [
  member,
  readState,
  followedThread,
  preferences,
  message,
  unreadCount,
  recipientHasRead,
  monotonic,
  unreadAgain,
  readAgain,
  invalidRole,
  invalidNotification,
  invalidUnmutedState,
];
