import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeMessageReminderSnapshotCursor,
  parseMessageReminderListSnapshot,
  parseMessageReminderListSnapshotInput,
} from "../dist/index.js";

const lastScheduledDueAt = "2099-01-01T12:00:00.000001Z";
const cancelled = {
  conversationId: "conversation-a",
  messageId: "message-a",
  reminderRevision: 4,
  lastScheduledDueAt,
  reminder: { privacy: "affected_authenticated_actor", state: "cancelled" },
};
const cursor = encodeMessageReminderSnapshotCursor({ dueAt: lastScheduledDueAt, messageId: cancelled.messageId });
const page = {
  kind: "message_reminder_list", privacy: "actor_private",
  items: [cancelled], page: { nextCursor: cursor },
};

test("cancelled authority is opt-in and preserves the precise pagination key", () => {
  const input = { limit: 1, includeCancelled: true };
  assert.deepEqual(parseMessageReminderListSnapshot(page, input), page);
  assert.throws(() => parseMessageReminderListSnapshot(page, { limit: 1 }));
  assert.throws(() => parseMessageReminderListSnapshot(page, { limit: 1, includeCancelled: false }));
  assert.throws(() => parseMessageReminderListSnapshotInput({ limit: 1, includeCancelled: "true" }));
  assert.throws(() => parseMessageReminderListSnapshot({ ...page, items: [{ ...cancelled, lastScheduledDueAt: undefined }] }, input));
  const scheduled = {
    conversationId: "conversation-a", messageId: "message-b", reminderRevision: 1,
    reminder: { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: lastScheduledDueAt },
  };
  const nextPage = { ...page, items: [scheduled], page: { nextCursor: null } };
  assert.deepEqual(parseMessageReminderListSnapshot(nextPage, { ...input, cursor }), nextPage);
  assert.throws(() => parseMessageReminderListSnapshot(page, { ...input, cursor }));
});
