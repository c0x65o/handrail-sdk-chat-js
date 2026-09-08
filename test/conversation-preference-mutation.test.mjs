import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationPreferenceMutationParseError,
  MAX_CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_UTF8_BYTES,
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
} from "../dist/index.js";
import * as clientPreferenceContracts from "../dist/client/index.js";
import * as serverPreferenceContracts from "../dist/server/index.js";
import {
  allUnmutedInput,
  conflictingPreferenceResult,
  mentionsIndefinitelyMutedInput,
  noneMutedUntilInput,
  preferenceMutationInputs,
  settledPreferenceResult,
} from "./fixtures/conversation-preference-mutations.mjs";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const assertParseError = (code) => (error) =>
  error instanceof ConversationPreferenceMutationParseError &&
  error.code === code;

test("all supported notification, starred, and explicit mute states round-trip from public entries", () => {
  for (const input of preferenceMutationInputs) {
    assert.deepEqual(
      parseUpdateConversationPreferenceInput(roundTrip(input)),
      input,
    );
  }

  assert.equal(
    clientPreferenceContracts.parseUpdateConversationPreferenceInput,
    parseUpdateConversationPreferenceInput,
  );
  assert.equal(
    serverPreferenceContracts.parseUpdateConversationPreferenceResult,
    parseUpdateConversationPreferenceResult,
  );
});

test("rejects toggles, invalid notification levels, and unknown input fields", () => {
  const { idempotencyKey: _idempotencyKey, ...withoutIdempotencyKey } =
    allUnmutedInput;
  const { isStarred: _isStarred, ...withoutIsStarred } = allUnmutedInput;

  for (const [invalid, code] of [
    [withoutIdempotencyKey, "malformed_input"],
    [withoutIsStarred, "malformed_input"],
    [{ ...allUnmutedInput, operation: "toggle_conversation_preference" }, "malformed_input"],
    [{ ...allUnmutedInput, notificationPreference: "important" }, "malformed_preference"],
    [{ ...allUnmutedInput, isStarred: "true" }, "malformed_preference"],
    [{ ...allUnmutedInput, isStarred: 1 }, "malformed_preference"],
    [{ ...allUnmutedInput, toggleMute: true }, "malformed_input"],
    [{ ...allUnmutedInput, toggleStar: true }, "malformed_input"],
    [{ ...allUnmutedInput, toggleIsStarred: true }, "malformed_input"],
    [{ ...allUnmutedInput, muted: false }, "malformed_input"],
    [{ ...allUnmutedInput, notificationPreferenceToggle: true }, "malformed_input"],
  ]) {
    assert.throws(
      () => parseUpdateConversationPreferenceInput(invalid),
      assertParseError(code),
    );
  }
});

test("rejects impossible mute shapes and malformed finite timestamps", () => {
  const invalidMutes = [
    {},
    { muted: "yes" },
    { muted: false, mutedUntil: "2030-02-03T04:05:06.000Z" },
    { muted: true, mutedUntil: null },
    { muted: true, mutedUntil: "forever" },
    { muted: true, mutedUntil: "2030-02-30T04:05:06.000Z" },
    { muted: true, mutedUntil: "2030-02-03T04:05:06" },
    { muted: true, mutedUntil: "2030-02-03T04:05:06.000Z", forever: false },
  ];

  for (const mute of invalidMutes) {
    assert.throws(
      () =>
        parseUpdateConversationPreferenceInput({
          ...allUnmutedInput,
          mute,
        }),
      (error) =>
        error instanceof ConversationPreferenceMutationParseError &&
        (error.code === "malformed_preference" ||
          error.code === "malformed_timestamp"),
    );
  }
});

test("enforces advanceable revisions and bounded nonblank idempotency keys", () => {
  for (const expectedPreferenceRevision of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        parseUpdateConversationPreferenceInput({
          ...allUnmutedInput,
          expectedPreferenceRevision,
        }),
      assertParseError("malformed_revision"),
    );
  }

  for (const idempotencyKey of [
    "",
    "   ",
    " surrounded ",
    "x".repeat(MAX_CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_UTF8_BYTES + 1),
  ]) {
    assert.throws(
      () =>
        parseUpdateConversationPreferenceInput({
          ...allUnmutedInput,
          idempotencyKey,
        }),
      assertParseError("malformed_input"),
    );
  }

  assert.equal(
    parseUpdateConversationPreferenceInput({
      ...allUnmutedInput,
      idempotencyKey: "x".repeat(
        MAX_CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_UTF8_BYTES,
      ),
    }).idempotencyKey.length,
    MAX_CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_UTF8_BYTES,
  );
});

test("rejects normalized trusted identity and authorization spoofing variants", () => {
  const spoofedFields = [
    ["tenant-id", "tenant-spoof"],
    ["organization.id", "organization-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["current user", { id: "user-spoof" }],
    ["session-id", "session-spoof"],
    ["authentication", { user: "user-spoof" }],
    ["authorization", "Bearer spoof"],
    ["roles", ["admin"]],
    ["capabilities", ["chat.preference.write"]],
    ["permissions", ["preference:any"]],
  ];

  for (const input of preferenceMutationInputs) {
    for (const [field, value] of spoofedFields) {
      assert.throws(
        () =>
          parseUpdateConversationPreferenceInput({
            ...input,
            [field]: value,
          }),
        assertParseError("trusted_identity_field"),
        field,
      );
    }
  }
});

test("canonical applied, replayed, and already-realized states round-trip exactly", () => {
  const cases = [
    settledPreferenceResult(allUnmutedInput, "applied"),
    settledPreferenceResult(mentionsIndefinitelyMutedInput, "replayed"),
    settledPreferenceResult(noneMutedUntilInput, "already_requested_state"),
  ];

  for (const [index, result] of cases.entries()) {
    const input = preferenceMutationInputs[index];
    assert.deepEqual(
      parseUpdateConversationPreferenceResult(roundTrip(result), input),
      result,
    );
  }
});

test("a revision conflict deterministically carries authoritative private state", () => {
  const conflict = conflictingPreferenceResult(
    noneMutedUntilInput,
    12,
    { notificationPreference: "mentions", isStarred: true, mute: { muted: true } },
  );
  const first = parseUpdateConversationPreferenceResult(
    roundTrip(conflict),
    noneMutedUntilInput,
  );
  const second = parseUpdateConversationPreferenceResult(
    roundTrip(conflict),
    noneMutedUntilInput,
  );

  assert.equal(first.reconciliationStatus, "preference_revision_conflict");
  assert.equal(first.preferenceRevision, 12);
  assert.deepEqual(second, first);
});

test("rejects request/result mismatches, incoherent statuses, and malformed canonical state", () => {
  const applied = settledPreferenceResult(mentionsIndefinitelyMutedInput);
  const mismatches = [
    { ...applied, conversationId: "conversation-other" },
    { ...applied, expectedPreferenceRevision: 3 },
    { ...applied, idempotencyKey: "preference:other" },
    {
      ...applied,
      requestedPreference: { ...applied.requestedPreference, notificationPreference: "none" },
    },
    {
      ...applied,
      requestedPreference: { ...applied.requestedPreference, isStarred: false },
    },
    { ...applied, preferenceRevision: 4 },
    {
      ...applied,
      preference: { ...applied.preference, notificationPreference: "none" },
    },
    {
      ...applied,
      preference: { ...applied.preference, isStarred: false },
    },
    {
      ...applied,
      preference: { ...applied.preference, updatedAt: "not-a-timestamp" },
    },
    { ...applied, actorUserId: "user-spoof" },
  ];

  for (const result of mismatches) {
    assert.throws(
      () =>
        parseUpdateConversationPreferenceResult(
          result,
          mentionsIndefinitelyMutedInput,
        ),
      (error) =>
        error instanceof ConversationPreferenceMutationParseError &&
        (error.code === "incoherent_result" ||
          error.code === "malformed_result"),
    );
  }

  const conflictWithRequestedState = {
    ...applied,
    reconciliationStatus: "preference_revision_conflict",
    preferenceRevision: 7,
  };
  assert.equal(
    parseUpdateConversationPreferenceResult(
      conflictWithRequestedState,
      mentionsIndefinitelyMutedInput,
    ).preferenceRevision,
    7,
  );
  assert.equal(
    parseUpdateConversationPreferenceResult(
      { ...conflictWithRequestedState, preferenceRevision: 0 },
      mentionsIndefinitelyMutedInput,
    ).preferenceRevision,
    0,
  );
});
