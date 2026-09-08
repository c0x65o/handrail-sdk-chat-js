import type {
  ChannelConversation,
  Conversation,
  DirectConversation,
  GroupDirectConversation,
  ThreadConversation,
} from "../src/contracts/conversation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  TenantId,
  UserId,
} from "../src/contracts/identifiers.js";

const id = "conversation-1" as ConversationId;
const tenantId = "tenant-1" as TenantId;
const createdAt = "2026-08-26T10:00:00.000Z" as IsoTimestamp;
const updatedAt = "2026-08-26T11:00:00.000Z" as IsoTimestamp;
const archivedAt = "2026-08-26T12:00:00.000Z" as IsoTimestamp;
const archivedByUserId = "user-1" as UserId;

const channel = {
  id,
  tenantId,
  createdAt,
  updatedAt,
  type: "channel",
  name: "Support",
  visibility: "public",
  entity: { type: "case", id: "case-1" },
} satisfies ChannelConversation;

const direct = {
  id,
  tenantId,
  createdAt,
  updatedAt,
  type: "direct",
  visibility: "private",
} satisfies DirectConversation;

const group = {
  id,
  tenantId,
  createdAt,
  updatedAt,
  archivedAt,
  archivedByUserId,
  type: "group_direct",
  visibility: "private",
} satisfies GroupDirectConversation;

const thread = {
  id,
  tenantId,
  createdAt,
  updatedAt,
  archivedAt,
  archivedByUserId,
  type: "thread",
  visibility: "private",
  parentConversationId: "conversation-parent" as ConversationId,
  rootMessageId: "message-root" as MessageId,
} satisfies ThreadConversation;

const conversations: readonly Conversation[] = [channel, direct, group, thread];
void conversations;

// @ts-expect-error active conversations cannot provide only archivedAt
const unpairedArchive: ChannelConversation = { ...channel, archivedAt };
void unpairedArchive;

// @ts-expect-error active conversations cannot provide only archivedByUserId
const unpairedArchiver: DirectConversation = { ...direct, archivedByUserId };
void unpairedArchiver;

// @ts-expect-error direct conversations are always private
const publicDirect: DirectConversation = { ...direct, visibility: "public" };
void publicDirect;

const threadedChannel: ChannelConversation = {
  ...channel,
  // @ts-expect-error channel conversations exclude thread parent fields
  parentConversationId: id,
};
void threadedChannel;

// @ts-expect-error direct conversations exclude names
const namedDirect: DirectConversation = { ...direct, name: "Not allowed" };
void namedDirect;

const entityGroup: GroupDirectConversation = {
  ...group,
  // @ts-expect-error group direct conversations exclude host entities
  entity: { type: "case", id: "case-1" },
};
void entityGroup;

const namedThread: ThreadConversation = { ...thread, name: "Launch 🚀" };
void namedThread;

// @ts-expect-error supplied thread names must be strings
const malformedName: ThreadConversation = { ...thread, name: 42 };
void malformedName;
// @ts-expect-error supplied JSON null is not absence
const nullName: ThreadConversation = { ...thread, name: null };
void nullName;
// @ts-expect-error supplied undefined is not absence
const undefinedName: ThreadConversation = { ...thread, name: undefined };
void undefinedName;
// @ts-expect-error group direct conversations exclude names
const namedGroup: GroupDirectConversation = { ...group, name: "Not allowed" };
void namedGroup;
// @ts-expect-error group direct conversations are private
const publicGroup: GroupDirectConversation = { ...group, visibility: "public" };
void publicGroup;
const { name: channelName, ...channelWithoutName } = channel;
// @ts-expect-error channel names remain required
const namelessChannel: ChannelConversation = channelWithoutName;
void namelessChannel;
void channelName;
const { rootMessageId, ...threadWithoutRoot } = thread;
// @ts-expect-error thread roots remain required
const rootlessThread: ThreadConversation = threadWithoutRoot;
void rootlessThread;
void rootMessageId;
const { parentConversationId, ...threadWithoutParent } = thread;
// @ts-expect-error thread parents remain required
const parentlessThread: ThreadConversation = threadWithoutParent;
void parentlessThread;
void parentConversationId;
// @ts-expect-error thread entities remain forbidden
const entityThread: ThreadConversation = { ...thread, entity: { type: "case", id: "1" } };
void entityThread;
// @ts-expect-error thread identity must remain a ConversationId
const invalidIdentity: ThreadConversation = { ...thread, id: thread.rootMessageId };
void invalidIdentity;

const openThread: ThreadConversation = { ...thread, threadLifecycle: { revision: 1, locked: false } };
const closedThread: ThreadConversation = { ...thread, threadLifecycle: { revision: 2, locked: false, closedAt: archivedAt, closedByUserId: archivedByUserId } };
const lockedThread: ThreadConversation = { ...thread, threadLifecycle: { revision: 3, locked: true, closedAt: archivedAt, closedByUserId: archivedByUserId } };
void [openThread, closedThread, lockedThread];
// @ts-expect-error lifecycle is thread-only
const lifecycleChannel: ChannelConversation = { ...channel, threadLifecycle: { revision: 1, locked: false } };
// @ts-expect-error lifecycle is thread-only
const lifecycleDirect: DirectConversation = { ...direct, threadLifecycle: { revision: 1, locked: false } };
// @ts-expect-error lifecycle is thread-only
const lifecycleGroup: GroupDirectConversation = { ...group, threadLifecycle: { revision: 1, locked: false } };
// @ts-expect-error locked requires closure
const lockedOpen: ThreadConversation = { ...thread, threadLifecycle: { revision: 1, locked: true } };
// @ts-expect-error closure requires an actor
const noCloser: ThreadConversation = { ...thread, threadLifecycle: { revision: 1, locked: false, closedAt: archivedAt } };
// @ts-expect-error closure requires a timestamp
const noClosedAt: ThreadConversation = { ...thread, threadLifecycle: { revision: 1, locked: false, closedByUserId: archivedByUserId } };
// @ts-expect-error revision must be numeric (runtime additionally enforces positive safe integer)
const stringRevision: ThreadConversation = { ...thread, threadLifecycle: { revision: "1", locked: false } };
// @ts-expect-error revision is required
const missingRevision: ThreadConversation = { ...thread, threadLifecycle: { locked: false } };
// @ts-expect-error lock flag is required
const missingLock: ThreadConversation = { ...thread, threadLifecycle: { revision: 1 } };
// @ts-expect-error null is not absence
const nullLifecycle: ThreadConversation = { ...thread, threadLifecycle: null };
// @ts-expect-error undefined is not absence
const undefinedLifecycle: ThreadConversation = { ...thread, threadLifecycle: undefined };
// @ts-expect-error hiding is not stored lifecycle state
const hiddenLifecycle: ThreadConversation = { ...thread, threadLifecycle: { revision: 1, locked: false, hidden: true } };
void [lifecycleChannel, lifecycleDirect, lifecycleGroup, lockedOpen, noCloser, noClosedAt, stringRevision, missingRevision, missingLock, nullLifecycle, undefinedLifecycle, hiddenLifecycle];
