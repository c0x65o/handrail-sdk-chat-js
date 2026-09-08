import {
  parseEditMessageInput,
  parseEditMessageResult,
  parseSendMessageInput,
  parseSendMessageResult,
  parseSoftDeleteMessageInput,
  parseSoftDeleteMessageResult,
  type ConversationId,
  type EditMessageInput,
  type EditMessageResult,
  type Message,
  type MessageId,
  type SendMessageInput,
  type SendMessageResult,
  type SoftDeleteMessageInput,
  type SoftDeleteMessageResult,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;
const messageId = "message-1" as MessageId;
const content = { format: "plain", text: "Hello" } as const;

const send: SendMessageInput = {
  operation: "send",
  conversationId,
  clientMessageId: "optimistic-1",
  idempotencyKey: "send-attempt-1",
  content,
};
const edit: EditMessageInput = {
  operation: "edit",
  messageId,
  expectedRevision: 1,
  idempotencyKey: "edit-attempt-1",
  content,
};
const deleted: SoftDeleteMessageInput = {
  operation: "soft_delete",
  messageId,
  expectedRevision: 1,
  idempotencyKey: "delete-attempt-1",
};

// @ts-expect-error Send requires a client-generated optimistic identity.
const sendWithoutClientId: SendMessageInput = {
  operation: "send",
  conversationId,
  idempotencyKey: "send-attempt-1",
  content,
};
// @ts-expect-error Send requires an idempotency key.
const sendWithoutIdempotency: SendMessageInput = {
  operation: "send",
  conversationId,
  clientMessageId: "optimistic-1",
  content,
};
// @ts-expect-error Edit requires the revision the caller observed.
const editWithoutRevision: EditMessageInput = {
  operation: "edit",
  messageId,
  idempotencyKey: "edit-attempt-1",
  content,
};
// @ts-expect-error Edit requires an operation-scoped idempotency key.
const editWithoutIdempotency: EditMessageInput = {
  operation: "edit",
  messageId,
  expectedRevision: 1,
  content,
};
// @ts-expect-error Soft-delete requires the revision the caller observed.
const deleteWithoutRevision: SoftDeleteMessageInput = {
  operation: "soft_delete",
  messageId,
  idempotencyKey: "delete-attempt-1",
};
// @ts-expect-error Soft-delete requires an operation-scoped idempotency key.
const deleteWithoutIdempotency: SoftDeleteMessageInput = {
  operation: "soft_delete",
  messageId,
  expectedRevision: 1,
};

const tenantSpoof: SendMessageInput = {
  ...send,
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId: "tenant-spoof",
};
const actorSpoof: EditMessageInput = {
  ...edit,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actor: { userId: "actor-spoof" },
};
const userSpoof: SoftDeleteMessageInput = {
  ...deleted,
  // @ts-expect-error User identity comes from the trusted host session.
  userId: "user-spoof",
};
const authorSpoof: SendMessageInput = {
  ...send,
  // @ts-expect-error Author identity comes from the trusted host session.
  author: { type: "user", userId: "author-spoof" },
};

const canonicalMessage = {
  id: messageId,
  tenantId: "tenant-1",
  conversationId,
  author: { type: "user", userId: "user-1" },
  sequence: 1,
  createdAt: "2026-08-25T20:00:00.000Z",
  updatedAt: "2026-08-25T20:00:00.000Z",
  revision: { revision: 1 },
  content,
} as Message;

const sendApplied: SendMessageResult = {
  operation: "send",
  reconciliationStatus: "applied",
  clientMessageId: send.clientMessageId,
  message: canonicalMessage,
  canonicalRevision: 1,
};
const sendReplayed: SendMessageResult = {
  ...sendApplied,
  reconciliationStatus: "replayed",
};
const editConflict: EditMessageResult = {
  operation: "edit",
  reconciliationStatus: "revision_conflict",
  expectedRevision: 1,
  message: { ...canonicalMessage, revision: { revision: 2 } },
  canonicalRevision: 2,
};
const deleteConflict: SoftDeleteMessageResult = {
  operation: "soft_delete",
  reconciliationStatus: "revision_conflict",
  expectedRevision: 1,
  message: { ...canonicalMessage, revision: { revision: 2 } },
  canonicalRevision: 2,
};

function reconcileEdit(result: EditMessageResult): Message {
  if (result.reconciliationStatus === "revision_conflict") {
    return result.message;
  }
  const status: "applied" | "replayed" = result.reconciliationStatus;
  void status;
  return result.message;
}

parseSendMessageInput(send);
parseEditMessageInput(edit);
parseSoftDeleteMessageInput(deleted);
parseSendMessageResult(sendApplied);
parseEditMessageResult(editConflict);
parseSoftDeleteMessageResult(deleteConflict);

void [
  sendWithoutClientId,
  sendWithoutIdempotency,
  editWithoutRevision,
  editWithoutIdempotency,
  deleteWithoutRevision,
  deleteWithoutIdempotency,
  tenantSpoof,
  actorSpoof,
  userSpoof,
  authorSpoof,
  sendReplayed,
  reconcileEdit(editConflict),
];
