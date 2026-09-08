import {
  parseMessageReminderInput,
  parseMessageReminderResult,
  type CancelMessageReminderInput,
  type ConversationId,
  type MessageId,
  type MessageReminderResult,
  type SetMessageReminderInput,
} from "../src/index.js";

const conversationId = "conversation-alpha" as ConversationId;
const messageId = "message-alpha" as MessageId;
const setInput: SetMessageReminderInput = {
  operation: "message_reminder.v1",
  intent: "set",
  conversationId,
  messageId,
  expectedReminderRevision: 0,
  idempotencyKey: "reminder:set",
  dueAt: "2030-01-01T00:00:00.000Z",
};
const cancelInput: CancelMessageReminderInput = {
  operation: "message_reminder.v1",
  intent: "cancel",
  conversationId,
  messageId,
  expectedReminderRevision: 1,
  idempotencyKey: "reminder:cancel",
};
const invalidCancel: CancelMessageReminderInput = {
  ...cancelInput,
  // @ts-expect-error Cancel explicitly forbids due-time data.
  dueAt: "2030-01-01T00:00:00.000Z",
};
const identitySpoof: SetMessageReminderInput = {
  ...setInput,
  // @ts-expect-error Actor identity comes only from trusted server context.
  actorUserId: "spoofed",
};
const toggleSpoof: SetMessageReminderInput = {
  ...setInput,
  // @ts-expect-error Toggle semantics are not supported.
  toggleReminder: true,
};
// @ts-expect-error Set requires an explicit dueAt.
const missingDueAt: SetMessageReminderInput = {
  operation: "message_reminder.v1",
  intent: "set",
  conversationId,
  messageId,
  expectedReminderRevision: 0,
  idempotencyKey: "reminder:missing-due",
};

const result: MessageReminderResult = {
  operation: "message_reminder.v1",
  intent: "set",
  reconciliationStatus: "applied",
  conversationId,
  messageId,
  expectedReminderRevision: 0,
  idempotencyKey: "reminder:set",
  reminderRevision: 1,
  reminder: {
    privacy: "affected_authenticated_actor",
    state: "scheduled",
    dueAt: setInput.dueAt,
  },
};

parseMessageReminderInput(setInput, { referenceTime: "2029-01-01T00:00:00.000Z" });
parseMessageReminderResult(result, setInput);
void [cancelInput, invalidCancel, identitySpoof, toggleSpoof, missingDueAt];
