import type { ConversationId, MessageId } from "../src/contracts/identifiers.js";
import type { MessageReplyReference } from "../src/contracts/message.js";
import {
  parseSendMessageInput,
  parseSendMessageResult,
} from "../src/contracts/generated/send-message.js";
import type { SendMessageInput } from "../src/contracts/generated/send-message.js";

const legacy: SendMessageInput = {
  operation: "send",
  conversationId: "conversation-1" as ConversationId,
  content: { format: "plain", text: "Friday" },
  clientMessageId: "client-1",
  idempotencyKey: "send-1",
};
const reference: MessageReplyReference = {
  messageId: "source-1" as MessageId,
  notifyAuthor: false,
};
const reply: SendMessageInput = { ...legacy, replyTo: reference };
const ping: SendMessageInput = { ...legacy, replyTo: { ...reference, notifyAuthor: true } };
const parsed: MessageReplyReference | undefined = parseSendMessageInput(reply).replyTo;
const resultReference: MessageReplyReference | undefined = parseSendMessageResult({}).message.replyTo;

// @ts-expect-error Explicit null is not omission.
const nullReply: SendMessageInput = { ...legacy, replyTo: null };
// @ts-expect-error A reply must include the explicit notification choice.
const missingNotify: SendMessageInput = { ...legacy, replyTo: { messageId: reference.messageId } };
// @ts-expect-error Strings are not boolean notification choices.
const nonBoolean: SendMessageInput = { ...legacy, replyTo: { ...reference, notifyAuthor: "false" } };
// @ts-expect-error Actor attribution is server-owned.
const actor: SendMessageInput = { ...legacy, replyTo: { ...reference, actorId: "actor-1" } };
// @ts-expect-error Replies cannot contain source display snapshots.
const snapshot: SendMessageInput = { ...legacy, replyTo: { ...reference, displayName: "Alice" } };
// @ts-expect-error Reply references live outside content.
const misplaced: SendMessageInput = { ...legacy, content: { ...legacy.content, replyTo: reference } };
// @ts-expect-error Existing trusted-identity rejection remains intact.
const identity: SendMessageInput = { ...reply, userId: "actor-1" };

void [ping, parsed, resultReference, nullReply, missingNotify, nonBoolean, actor, snapshot, misplaced, identity];
