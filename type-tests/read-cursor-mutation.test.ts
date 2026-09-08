import {
  applyReadCursorMutation,
  createReadCursorMutationOutcome,
  createReadCursorUpdatedEvent,
  parseReadCursorMutationInput,
  parseReadCursorMutationOutcome,
  parseReadCursorMutationResult,
  parseReadCursorUpdatedEvent,
  type ConversationId,
  type ConversationReadState,
  type AppliedReadCursorMutationResult,
  type MarkReadInput,
  type MarkReadResult,
  type MarkUnreadInput,
  type MarkUnreadResult,
  type ReadCursorMutationInput,
  type ReadCursorMutationResult,
  type ReplayedReadCursorMutationResult,
  type ReadCursorUpdatedEvent,
  type TenantId,
  type UserId,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;
const userId = "user-1" as UserId;
const tenantId = "tenant-1" as TenantId;
const updatedAt = "2026-08-25T20:00:00.000Z";

const markRead: MarkReadInput = {
  operation: "mark_read",
  conversationId,
  throughSequence: 7,
  idempotencyKey: "read-attempt-1",
};
const markUnread: MarkUnreadInput = {
  operation: "mark_unread",
  conversationId,
  fromSequence: 5,
  idempotencyKey: "unread-attempt-1",
};

// @ts-expect-error Mark-read requires an idempotency key.
const readWithoutIdempotency: MarkReadInput = {
  operation: "mark_read",
  conversationId,
  throughSequence: 7,
};
// @ts-expect-error Mark-unread requires an idempotency key.
const unreadWithoutIdempotency: MarkUnreadInput = {
  operation: "mark_unread",
  conversationId,
  fromSequence: 5,
};

const tenantSpoof: MarkReadInput = {
  ...markRead,
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId,
};
const userSpoof: MarkUnreadInput = {
  ...markUnread,
  // @ts-expect-error User identity comes from the trusted host session.
  userId,
};
const actorSpoof: MarkReadInput = {
  ...markRead,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actor: { userId },
};
const sessionSpoof: MarkUnreadInput = {
  ...markUnread,
  // @ts-expect-error Session identity comes from the trusted host session.
  sessionId: "session-spoof",
};
const rolesSpoof: MarkReadInput = {
  ...markRead,
  // @ts-expect-error Roles come from the trusted host session.
  roles: ["admin"],
};

const editOperation: ReadCursorMutationInput = {
  // @ts-expect-error Message edits are a separate mutation contract.
  operation: "edit",
  conversationId,
  throughSequence: 7,
  idempotencyKey: "edit-attempt-1",
};
const revisionData: MarkReadInput = {
  ...markRead,
  // @ts-expect-error Message revision data is absent from read-state commands.
  expectedRevision: 1,
};

const readState: ConversationReadState = {
  conversationId,
  userId,
  lastReadSequence: 7,
  updatedAt,
};
const markReadResult: MarkReadResult = {
  operation: "mark_read",
  conversationId,
  readState,
  latestSequence: 10,
  unreadCount: 3,
};
const markUnreadResult: MarkUnreadResult = {
  operation: "mark_unread",
  conversationId,
  readState: { ...readState, manualUnreadFromSequence: 5 },
  latestSequence: 10,
  unreadCount: 6,
};

const applied: ReadCursorMutationResult = applyReadCursorMutation(markRead, {
  currentReadState: readState,
  latestSequence: 10,
  updatedAt,
});
const appliedOutcome: AppliedReadCursorMutationResult =
  createReadCursorMutationOutcome(applied, markRead, "applied");
const replayedOutcome: ReplayedReadCursorMutationResult =
  createReadCursorMutationOutcome(applied, markRead, "replayed");
const event: ReadCursorUpdatedEvent = createReadCursorUpdatedEvent({
  eventId: "event-1",
  protocolVersion: 4,
  tenantId,
  occurredAt: updatedAt,
  result: markReadResult,
});

parseReadCursorMutationInput(markRead);
parseReadCursorMutationInput(markUnread);
parseReadCursorMutationResult(markReadResult);
parseReadCursorMutationResult(markUnreadResult);
parseReadCursorMutationOutcome(appliedOutcome, markRead);
parseReadCursorMutationOutcome(replayedOutcome, markRead);
parseReadCursorUpdatedEvent(event, tenantId);

void [
  readWithoutIdempotency,
  unreadWithoutIdempotency,
  tenantSpoof,
  userSpoof,
  actorSpoof,
  sessionSpoof,
  rolesSpoof,
  editOperation,
  revisionData,
  applied,
  appliedOutcome,
  replayedOutcome,
];
