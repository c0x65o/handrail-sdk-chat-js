import {
  parseSoftDeleteMessageInput,
  parseSoftDeleteMessageResult,
  type SoftDeleteMessageInput,
  type SoftDeleteMessageResult,
} from "../src/contracts/message-mutations.js";
import type {
  ConversationId,
  MessageId,
  TenantId,
  UserId,
} from "../src/contracts/identifiers.js";

const request: SoftDeleteMessageInput = {
  operation: "soft_delete",
  messageId: "message-1" as MessageId,
  expectedRevision: 2,
  idempotencyKey: "delete-attempt-1",
};

// @ts-expect-error Soft-delete requires the revision observed by the caller.
const missingRevision: SoftDeleteMessageInput = {
  operation: "soft_delete",
  messageId: "message-1" as MessageId,
  idempotencyKey: "delete-attempt-1",
};

const spoofedActor: SoftDeleteMessageInput = {
  ...request,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actorUserId: "spoofed",
};

const tombstone = {
  id: "message-1" as MessageId,
  tenantId: "tenant-1" as TenantId,
  conversationId: "conversation-1" as ConversationId,
  author: { type: "user" as const, userId: "user-1" as UserId },
  sequence: 7,
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:02:00.000Z",
  revision: { revision: 3 },
  content: null,
  deletedAt: "2026-08-25T20:02:00.000Z",
  deletedByUserId: "user-1" as UserId,
};

const applied: SoftDeleteMessageResult = {
  operation: "soft_delete",
  reconciliationStatus: "applied",
  expectedRevision: 2,
  message: tombstone,
  canonicalRevision: 3,
};
const replayed: SoftDeleteMessageResult = {
  ...applied,
  reconciliationStatus: "replayed",
};
const conflict: SoftDeleteMessageResult = {
  ...applied,
  reconciliationStatus: "revision_conflict",
  expectedRevision: 1,
};

const parsedInput: SoftDeleteMessageInput = parseSoftDeleteMessageInput(request);
const parsedResult: SoftDeleteMessageResult = parseSoftDeleteMessageResult(applied);

void [
  missingRevision,
  spoofedActor,
  replayed,
  conflict,
  parsedInput,
  parsedResult,
];

// Results reuse the canonical optional reference; deletion cannot retarget it.
const replyTo = { messageId: "source-message" as MessageId, notifyAuthor: false };
const requestWithReply: SoftDeleteMessageInput = {
  ...request,
  // @ts-expect-error replyTo is message metadata, never deletion input.
  replyTo,
};
const { deletedAt, deletedByUserId, ...liveMessage } = tombstone;
const replyResults: readonly SoftDeleteMessageResult[] = [
  { ...applied, message: { ...tombstone, replyTo } },
  { ...replayed, message: { ...tombstone, replyTo: { ...replyTo, notifyAuthor: true } } },
  { ...conflict, message: { ...tombstone, replyTo } },
  {
    ...conflict,
    message: {
      ...liveMessage,
      content: { format: "plain", text: "Friday" },
      replyTo,
    },
  },
];
for (const result of replyResults) {
  const reference: import("../src/contracts/message.js").MessageReplyReference | undefined =
    parseSoftDeleteMessageResult(result).message.replyTo;
  const notifyAuthor: boolean | undefined = reference?.notifyAuthor;
  const messageId: MessageId | undefined = reference?.messageId;
  void [notifyAuthor, messageId];
}
const malformedReply: SoftDeleteMessageResult = {
  ...applied,
  message: {
    ...tombstone,
    // @ts-expect-error A reply reference requires explicit boolean notifyAuthor.
    replyTo: { messageId: "source-message" as MessageId },
  },
};
void [requestWithReply, malformedReply];
