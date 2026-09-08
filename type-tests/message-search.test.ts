import {
  parseMessageSearchCursor,
  parseMessageSearchRequest,
  parseMessageSearchResponse,
  type ConversationId,
  type ConversationMessageSearchHit,
  type IsoTimestamp,
  type MessageId,
  type MessageMessageSearchHit,
  type MessageSearchHit,
  type MessageSearchRequest,
  type MessageSearchResponse,
  type UserId,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;
const messageId = "message-1" as MessageId;
const authorUserId = "user-1" as UserId;
const cursor = parseMessageSearchCursor("opaque-page-2");

const request: MessageSearchRequest = {
  query: "order updates",
  filters: {
    conversationIds: [conversationId],
    authorUserIds: [authorUserId],
    sentAfter: "2026-08-01T00:00:00Z" as IsoTimestamp,
    sentBefore: "2026-08-28T00:00:00Z" as IsoTimestamp,
  },
  pageSize: 25,
  cursor,
};

const tenantSpoof: MessageSearchRequest = {
  ...request,
  // @ts-expect-error Tenant identity comes only from trusted server context.
  tenantId: "tenant-spoof",
};
const roleSpoof: MessageSearchRequest = {
  ...request,
  // @ts-expect-error Roles come only from trusted server context.
  roles: ["admin"],
};
const nestedActorSpoof: MessageSearchRequest = {
  ...request,
  filters: {
    ...request.filters,
    // @ts-expect-error Current actor identity is not a supported filter.
    currentUserId: authorUserId,
  },
};

const conversationHit: ConversationMessageSearchHit = {
  type: "conversation",
  conversationId,
  title: "Orders",
  snippet: "Order coordination conversation",
};
const messageHit: MessageMessageSearchHit = {
  type: "message",
  conversationId,
  messageId,
  snippet: "The order is ready",
  authorUserId,
};
const conversationWithMessage: ConversationMessageSearchHit = {
  ...conversationHit,
  // @ts-expect-error Conversation hits cannot carry message identity.
  messageId,
};
// @ts-expect-error Message hits require a message ID.
const messageWithoutId: MessageMessageSearchHit = {
  type: "message",
  conversationId,
  snippet: "Missing identity",
};
const response: MessageSearchResponse = {
  hits: [messageHit, conversationHit],
  nextCursor: cursor,
};

function navigate(hit: MessageSearchHit): ConversationId | MessageId {
  return hit.type === "message" ? hit.messageId : hit.conversationId;
}

parseMessageSearchRequest(request);
parseMessageSearchResponse(response);

void [
  tenantSpoof,
  roleSpoof,
  nestedActorSpoof,
  conversationWithMessage,
  messageWithoutId,
  navigate(conversationHit),
  navigate(messageHit),
];
