import {
  parseForwardMessageInput,
  parseForwardMessageResult,
  type ConversationId,
  type ForwardMessageInput,
  type ForwardMessageResult,
  type Message,
  type MessageId,
} from "../src/index.js";

const sourceMessageId = "message-source" as MessageId;
const destinationConversationId = "conversation-destination" as ConversationId;
const input: ForwardMessageInput = {
  operation: "forward_message.v1",
  sourceMessageId,
  destinationConversationId,
  clientCorrelationId: "forward-client-1",
  idempotencyKey: "forward-attempt-1",
};

const authorSpoof: ForwardMessageInput = {
  ...input,
  // @ts-expect-error Destination author comes only from the authenticated actor.
  author: { type: "user", userId: "spoofed" },
};
const messageIdentitySpoof: ForwardMessageInput = {
  ...input,
  // @ts-expect-error Canonical destination message identity is server-authored.
  destinationMessageId: "caller-message",
};
const contentSpoof: ForwardMessageInput = {
  ...input,
  // @ts-expect-error Snapshot content and attribution are server-authored.
  content: { format: "plain", text: "caller copy" },
};

const message = {
  id: "message-destination" as MessageId,
  tenantId: "tenant-1",
  conversationId: destinationConversationId,
  author: { type: "user", userId: "forwarding-user" },
  sequence: 1,
  createdAt: "2026-08-28T16:00:00.000Z",
  updatedAt: "2026-08-28T16:00:00.000Z",
  revision: { revision: 1 },
  content: {
    format: "plain",
    text: "Frozen source",
    forwarded: {
      sourceMessageId,
      originalAuthor: { userId: "original-user", displayName: "Original" },
      originalCreatedAt: "2026-08-20T12:30:00.000Z",
    },
  },
} as Message;

const result: ForwardMessageResult = {
  operation: "forward_message.v1",
  reconciliationStatus: "applied",
  clientCorrelationId: input.clientCorrelationId,
  destinationConversationId,
  message,
  canonicalRevision: 1,
};

parseForwardMessageInput(input);
parseForwardMessageResult(result, input);
void [authorSpoof, messageIdentitySpoof, contentSpoof];
