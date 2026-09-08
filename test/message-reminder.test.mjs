import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_REMINDER_IDEMPOTENCY_KEY_UTF8_BYTES,
  MessageReminderParseError,
  parseCancelMessageReminderInput,
  parseMessageReminderInput,
  parseMessageReminderResult,
  parseSetMessageReminderInput,
} from "../src/contracts/generated/message-reminder.ts";

const referenceTime = "2026-08-28T12:00:00.000Z";
const parseOptions = { referenceTime };
const initialSet = {
  operation: "message_reminder.v1",
  intent: "set",
  conversationId: "conversation-alpha",
  messageId: "message-alpha",
  expectedReminderRevision: 0,
  idempotencyKey: "reminder:set:initial",
  dueAt: "2026-08-29T09:00:00.000Z",
};
const reschedule = {
  ...initialSet,
  expectedReminderRevision: 1,
  idempotencyKey: "reminder:set:reschedule",
  dueAt: "2026-08-30T15:30:00.000Z",
};
const cancel = {
  operation: "message_reminder.v1",
  intent: "cancel",
  conversationId: "conversation-alpha",
  messageId: "message-alpha",
  expectedReminderRevision: 2,
  idempotencyKey: "reminder:cancel",
};

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const hasCode = (code) => (error) => error instanceof MessageReminderParseError && error.code === code;
const canonical = (input) => input.intent === "set"
  ? { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: input.dueAt }
  : { privacy: "affected_authenticated_actor", state: "cancelled" };
const result = (input, reconciliationStatus, reminderRevision, reminder = canonical(input)) => ({
  operation: "message_reminder.v1",
  intent: input.intent,
  reconciliationStatus,
  conversationId: input.conversationId,
  messageId: input.messageId,
  expectedReminderRevision: input.expectedReminderRevision,
  idempotencyKey: input.idempotencyKey,
  reminderRevision,
  reminder,
});

test("initial set, reschedule, and cancel requests round-trip with an injected clock", () => {
  assert.deepEqual(parseSetMessageReminderInput(roundTrip(initialSet), parseOptions), initialSet);
  assert.deepEqual(parseSetMessageReminderInput(roundTrip(reschedule), parseOptions), reschedule);
  assert.deepEqual(parseCancelMessageReminderInput(roundTrip(cancel), parseOptions), cancel);
  for (const input of [initialSet, reschedule, cancel]) {
    assert.deepEqual(parseMessageReminderInput(roundTrip(input), parseOptions), input);
  }
});

test("every reconciliation status round-trips with authoritative actor-private state", () => {
  const cases = [
    [initialSet, result(initialSet, "applied", 1)],
    [reschedule, result(reschedule, "applied", 2)],
    [cancel, result(cancel, "applied", 3)],
    [initialSet, result(initialSet, "replayed", 1)],
    [reschedule, result(reschedule, "already-requested", 1)],
    [reschedule, result(reschedule, "revision-conflict", 7, { privacy: "affected_authenticated_actor", state: "cancelled" })],
    [cancel, result(cancel, "unavailable-source", null, null)],
  ];
  for (const [wireInput, wireResult] of cases) {
    const input = parseMessageReminderInput(wireInput, parseOptions);
    assert.deepEqual(parseMessageReminderResult(roundTrip(wireResult), input), wireResult);
  }
});

test("rejects toggle shapes, due-time intent violations, unknown fields, and recursively normalized identity aliases", () => {
  const invalid = [
    [{ ...initialSet, operation: "toggle_message_reminder" }, "malformed_input"],
    [{ ...initialSet, intent: "toggle" }, "malformed_input"],
    [{ ...initialSet, toggle: true }, "toggle_semantics"],
    [{ ...initialSet, "Reminder-Enabled": true }, "toggle_semantics"],
    [{ ...cancel, dueAt: initialSet.dueAt }, "malformed_input"],
    [Object.fromEntries(Object.entries(initialSet).filter(([key]) => key !== "dueAt")), "malformed_input"],
    [{ ...initialSet, unexpected: true }, "malformed_input"],
    [{ ...initialSet, extra: { nested: { "Actor_User-ID": "spoofed" } } }, "trusted_identity_field"],
    [{ ...initialSet, extra: [{ "session.id": "spoofed" }] }, "trusted_identity_field"],
    [{ ...initialSet, authorization: "Bearer spoofed" }, "trusted_identity_field"],
  ];
  for (const [wire, code] of invalid) {
    assert.throws(() => parseMessageReminderInput(wire, parseOptions), hasCode(code), code);
  }
});

test("rejects malformed, numeric, non-finite, equal, and past due timestamps deterministically", () => {
  for (const [dueAt, code] of [
    ["not-a-time", "malformed_timestamp"],
    ["2026-02-30T09:00:00.000Z", "malformed_timestamp"],
    ["2026-08-29", "malformed_timestamp"],
    [Date.parse(initialSet.dueAt), "malformed_timestamp"],
    [Number.NaN, "malformed_timestamp"],
    [Number.POSITIVE_INFINITY, "malformed_timestamp"],
    [referenceTime, "due_time_not_future"],
    ["2026-08-28T11:59:59.999Z", "due_time_not_future"],
  ]) {
    assert.throws(
      () => parseMessageReminderInput({ ...initialSet, dueAt }, parseOptions),
      hasCode(code),
    );
  }
});

test("rejects invalid revisions and enforces bounded nonblank idempotency", () => {
  for (const expectedReminderRevision of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => parseMessageReminderInput({ ...initialSet, expectedReminderRevision }, parseOptions),
      hasCode("malformed_revision"),
    );
  }
  for (const idempotencyKey of [
    "",
    "   ",
    " surrounded ",
    "x".repeat(MAX_MESSAGE_REMINDER_IDEMPOTENCY_KEY_UTF8_BYTES + 1),
  ]) {
    assert.throws(
      () => parseMessageReminderInput({ ...initialSet, idempotencyKey }, parseOptions),
      hasCode("malformed_idempotency_key"),
    );
  }
});

test("result parsing enforces every correlation echo and status/revision/state rule", () => {
  const input = parseMessageReminderInput(initialSet, parseOptions);
  const applied = result(initialSet, "applied", 1);
  const mismatches = [
    { ...applied, intent: "cancel" },
    { ...applied, conversationId: "conversation-other" },
    { ...applied, messageId: "message-other" },
    { ...applied, expectedReminderRevision: 1 },
    { ...applied, idempotencyKey: "reminder:other" },
  ];
  for (const wire of mismatches) {
    assert.throws(() => parseMessageReminderResult(wire, input), hasCode("correlation_mismatch"));
  }

  const incoherent = [
    { ...applied, reminderRevision: 0 },
    { ...applied, reconciliationStatus: "replayed", reminderRevision: 0 },
    { ...applied, reconciliationStatus: "already-requested", reminderRevision: 1 },
    { ...applied, reconciliationStatus: "revision-conflict" },
    { ...applied, reminder: { privacy: "affected_authenticated_actor", state: "cancelled" } },
    { ...applied, reconciliationStatus: "unavailable-source", reminderRevision: 1, reminder: null },
    { ...applied, reconciliationStatus: "unavailable-source", reminderRevision: null },
  ];
  for (const wire of incoherent) {
    assert.throws(() => parseMessageReminderResult(wire, input), hasCode("incoherent_result"));
  }
  assert.throws(
    () => parseMessageReminderResult({ ...applied, actorUserId: "other-actor" }, input),
    hasCode("malformed_result"),
  );
  assert.throws(
    () => parseMessageReminderResult({ ...applied, reminder: { ...applied.reminder, userId: "other-actor" } }, input),
    hasCode("malformed_result"),
  );
});
