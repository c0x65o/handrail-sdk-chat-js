import type {
  AttachmentId,
  ConversationId,
  DeviceId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  SessionId,
  TenantId,
  TenantScopedId,
  UserId,
} from "../src/contracts/index.js";

const tenantId = "tenant-1" as TenantId;
const conversationId = "conversation-1" as ConversationId;
const messageId = "message-1" as MessageId;
const userId = "user-1" as UserId;
const attachmentId = "attachment-1" as AttachmentId;
const deviceId = "device-1" as DeviceId;
const sessionId = "session-1" as SessionId;
const timestamp: IsoTimestamp = "2026-08-26T12:00:00.000Z";
const sequence: MessageSequence = 42;

const scopedConversation: TenantScopedId<"conversation"> = conversationId;

// @ts-expect-error Distinct tenant-scoped kinds remain incompatible.
const messageFromConversation: MessageId = conversationId;
// @ts-expect-error Tenant IDs are not tenant-scoped entity IDs.
const conversationFromTenant: ConversationId = tenantId;
// @ts-expect-error Tenant-scoped entity IDs are not tenant IDs.
const tenantFromConversation: TenantId = conversationId;

void [
  tenantId,
  scopedConversation,
  messageId,
  userId,
  attachmentId,
  deviceId,
  sessionId,
  timestamp,
  sequence,
  messageFromConversation,
  conversationFromTenant,
  tenantFromConversation,
];
