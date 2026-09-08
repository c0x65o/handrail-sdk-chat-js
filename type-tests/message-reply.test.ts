import type { Message, MessageComposition, MessageContent, MessageReplyReference } from "../src/index.js";
import type { ConversationId, MessageId, MessageSequence, TenantId, UserId } from "../src/contracts/identifiers.js";

const messageId = "source" as MessageId;
const content: MessageContent = { format: "plain", text: "Friday" };
const legacy: MessageComposition = { content };
const reply: MessageReplyReference = { messageId, notifyAuthor: true };
const enabled: MessageComposition = { content, replyTo: reply };
const disabled: MessageComposition = { content, replyTo: { messageId, notifyAuthor: false } };
const active: Message = {
  id: "reply" as MessageId,
  tenantId: "tenant" as TenantId,
  conversationId: "channel" as ConversationId,
  author: { type: "user", userId: "user" as UserId },
  sequence: 2 as MessageSequence,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  revision: { revision: 1 },
  content,
  replyTo: reply,
};
const deleted: Message = { ...active, content: null, deletedAt: active.updatedAt, deletedByUserId: active.author.userId };

// @ts-expect-error A reference requires an explicit notification choice.
const missingBoolean: MessageComposition = { content, replyTo: { messageId } };
// @ts-expect-error A reference requires a source ID.
const missingId: MessageComposition = { content, replyTo: { notifyAuthor: true } };
// @ts-expect-error ID must use the identifier contract.
const invalidId: MessageComposition = { content, replyTo: { messageId: "source", notifyAuthor: true } };
// @ts-expect-error A boolean is not a string.
const invalidBoolean: MessageComposition = { content, replyTo: { messageId, notifyAuthor: "false" } };
// @ts-expect-error Explicit null is not omission.
const nullReply: MessageComposition = { content, replyTo: null };
// @ts-expect-error Explicit undefined is not omission with exact optional properties.
const undefinedReply: MessageComposition = { content, replyTo: undefined };
// @ts-expect-error Unknown source display cannot be supplied.
const sourceDisplay: MessageComposition = { content, replyTo: { messageId, notifyAuthor: true, sourceDisplay: "Alice" } };
const attributedReference = { ...reply, originalAuthor: { userId: "alice" as UserId, displayName: "Alice" } };
// @ts-expect-error Source attribution is rejected even through a predeclared variable.
const attributed: MessageComposition = { content, replyTo: attributedReference };
const actorReference = { ...reply, actorId: "spoofed" };
// @ts-expect-error Actor attribution cannot be nested in the reference.
const nestedActor: MessageComposition = { content, replyTo: actorReference };
const actorComposition = { ...enabled, authorId: "spoofed" };
// @ts-expect-error Existing server-owned actor exclusion still applies to variables.
const actor: MessageComposition = actorComposition;
// @ts-expect-error Existing server-owned tenant exclusion still applies.
const tenant: MessageComposition = { ...enabled, tenantId: "tenant" as TenantId };
// @ts-expect-error Reply metadata is outside editable content.
const contentReply: MessageContent = { ...content, replyTo: reply };
// @ts-expect-error A forwarded snapshot is not a reply reference.
const forwardedReply: MessageContent = { ...content, forwarded: reply };
// @ts-expect-error Composition metadata is readonly.
enabled.replyTo = reply;
// @ts-expect-error Source ID is readonly.
reply.messageId = messageId;
// @ts-expect-error Notification choice is readonly.
reply.notifyAuthor = false;
// @ts-expect-error Active message reply metadata is readonly.
active.replyTo = reply;
// @ts-expect-error Deleted message reply metadata is readonly.
deleted.replyTo = reply;

void [legacy, enabled, disabled, active, deleted, missingBoolean, missingId, invalidId,
  invalidBoolean, nullReply, undefinedReply, sourceDisplay, attributed, nestedActor,
  actor, tenant, contentReply, forwardedReply];
