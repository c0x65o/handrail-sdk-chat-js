import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES,
  MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES,
  SavedMessageMutationParseError,
  parseSaveMessageInput,
  parseSetSavedMessageInput,
  parseSetSavedMessageResult,
  parseUnsaveMessageInput,
} from "../dist/index.js";
import * as clientSavedMessageContracts from "../dist/client/index.js";
import * as serverSavedMessageContracts from "../dist/server/index.js";
import {
  conflictingSavedMessageResult,
  saveMessageInput,
  savedMessageInputs,
  settledSavedMessageResult,
  unsaveMessageInput,
} from "./fixtures/saved-message-mutations.mjs";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const assertParseError = (code) => (error) =>
  error instanceof SavedMessageMutationParseError && error.code === code;

test("explicit save and unsave inputs round-trip from every public contract entry", () => {
  assert.deepEqual(parseSaveMessageInput(roundTrip(saveMessageInput)), saveMessageInput);
  assert.deepEqual(
    parseUnsaveMessageInput(roundTrip(unsaveMessageInput)),
    unsaveMessageInput,
  );
  for (const input of savedMessageInputs) {
    assert.deepEqual(parseSetSavedMessageInput(roundTrip(input)), input);
  }

  assert.equal(
    clientSavedMessageContracts.parseSetSavedMessageInput,
    parseSetSavedMessageInput,
  );
  assert.equal(
    serverSavedMessageContracts.parseSetSavedMessageResult,
    parseSetSavedMessageResult,
  );
});

test("rejects missing idempotency, ambiguous toggles, and boolean desired-state aliases", () => {
  const { idempotencyKey: _idempotencyKey, ...withoutIdempotencyKey } =
    saveMessageInput;
  const invalid = [
    withoutIdempotencyKey,
    { ...saveMessageInput, operation: "toggle_saved_message" },
    { ...saveMessageInput, intent: "toggle" },
    { ...saveMessageInput, toggle: true },
    { ...saveMessageInput, toggleSaved: true },
    { ...saveMessageInput, toggleSavedMessage: true },
    { ...saveMessageInput, isSaved: false },
    { ...saveMessageInput, saved: true },
    { ...saveMessageInput, shouldSave: true },
    { ...saveMessageInput, desiredSavedState: true },
  ];

  for (const input of invalid) {
    assert.throws(
      () => parseSetSavedMessageInput(input),
      assertParseError("malformed_input"),
    );
  }
});

test("accepts one bounded private-note shape only for save intent", () => {
  assert.equal(
    parseSetSavedMessageInput(saveMessageInput).privateNote,
    "Follow up with the customer",
  );

  for (const privateNote of [
    "",
    "   ",
    "unsafe\u0000note",
    "e\u0301",
    "x".repeat(MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES + 1),
  ]) {
    assert.throws(
      () => parseSetSavedMessageInput({ ...saveMessageInput, privateNote }),
      assertParseError("malformed_private_note"),
    );
  }
  assert.throws(
    () => parseSetSavedMessageInput({ ...unsaveMessageInput, privateNote: "no" }),
    assertParseError("malformed_private_note"),
  );

  for (const [field, value] of [
    ["note", "remember this"],
    ["Private-Note", "private"],
    ["saved_message_note", "unsupported"],
    ["savedNotes", ["unsupported"]],
    ["annotation", "unsupported"],
    ["memo", "unsupported"],
  ]) {
    assert.throws(
      () => parseSetSavedMessageInput({ ...saveMessageInput, [field]: value }),
      assertParseError("unsupported_note_field"),
      field,
    );
  }
});

test("rejects normalized tenant, user, actor, session, role, and authorization spoofing", () => {
  const spoofedFields = [
    ["tenant-id", "tenant-spoof"],
    ["organization.id", "organization-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["current user", { id: "user-spoof" }],
    ["user-id", "user-spoof"],
    ["session_id", "session-spoof"],
    ["authentication", { user: "user-spoof" }],
    ["authorization", "Bearer spoof"],
    ["roles", ["admin"]],
    ["capabilities", ["chat.saved-message.write"]],
    ["permissions", ["saved-message:any"]],
  ];

  for (const [field, value] of spoofedFields) {
    assert.throws(
      () => parseSetSavedMessageInput({ ...saveMessageInput, [field]: value }),
      assertParseError("trusted_identity_field"),
      field,
    );
  }
});

test("enforces advanceable revisions and bounded nonblank idempotency keys", () => {
  for (const expectedSavedMessageRevision of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        parseSetSavedMessageInput({
          ...saveMessageInput,
          expectedSavedMessageRevision,
        }),
      assertParseError("malformed_revision"),
    );
  }

  for (const idempotencyKey of [
    "",
    "   ",
    " surrounded ",
    "x".repeat(MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES + 1),
  ]) {
    assert.throws(
      () => parseSetSavedMessageInput({ ...saveMessageInput, idempotencyKey }),
      assertParseError("malformed_input"),
    );
  }

  assert.equal(
    parseSetSavedMessageInput({
      ...saveMessageInput,
      idempotencyKey: "x".repeat(
        MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES,
      ),
    }).idempotencyKey.length,
    MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES,
  );
});

test("save and unsave results round-trip for every deterministic settled status", () => {
  const cases = [
    [saveMessageInput, settledSavedMessageResult(saveMessageInput, "applied")],
    [saveMessageInput, settledSavedMessageResult(saveMessageInput, "replayed")],
    [unsaveMessageInput, settledSavedMessageResult(unsaveMessageInput, "applied")],
    [
      unsaveMessageInput,
      settledSavedMessageResult(unsaveMessageInput, "already_requested_state"),
    ],
  ];

  for (const [input, result] of cases) {
    assert.deepEqual(parseSetSavedMessageResult(roundTrip(result), input), result);
  }
});

test("revision conflicts deterministically carry the different authoritative private state", () => {
  const saveConflict = conflictingSavedMessageResult(saveMessageInput, 8);
  const unsaveConflict = conflictingSavedMessageResult(unsaveMessageInput, 11);

  const first = parseSetSavedMessageResult(roundTrip(saveConflict), saveMessageInput);
  const second = parseSetSavedMessageResult(roundTrip(saveConflict), saveMessageInput);
  assert.deepEqual(second, first);
  assert.deepEqual(
    parseSetSavedMessageResult(roundTrip(unsaveConflict), unsaveMessageInput),
    unsaveConflict,
  );
});

test("rejects incoherent request echoes and revision/state combinations", () => {
  const applied = settledSavedMessageResult(saveMessageInput);
  const invalid = [
    [{ ...applied, intent: "unsave" }, "incoherent_result"],
    [{ ...applied, messageId: "message-other" }, "incoherent_result"],
    [
      { ...applied, expectedSavedMessageRevision: 1 },
      "incoherent_result",
    ],
    [{ ...applied, idempotencyKey: "saved-message:other" }, "incoherent_result"],
    [
      {
        ...applied,
        savedMessageRevision: saveMessageInput.expectedSavedMessageRevision,
      },
      "incoherent_result",
    ],
    [
      { ...applied, reconciliationStatus: "already_requested_state" },
      "incoherent_result",
    ],
    [
      {
        ...applied,
        savedMessage: { ...applied.savedMessage, messageId: "message-other" },
      },
      "incoherent_result",
    ],
    [
      {
        ...applied,
        savedMessage: { ...applied.savedMessage, isSaved: false },
      },
      "incoherent_result",
    ],
    [{ ...applied, savedMessageRevision: -1 }, "malformed_revision"],
    [{ ...applied, actorUserId: "user-spoof" }, "trusted_identity_field"],
    [{ ...applied, conversationId: "conversation-public" }, "malformed_result"],
  ];

  for (const [result, code] of invalid) {
    assert.throws(
      () => parseSetSavedMessageResult(result, saveMessageInput),
      assertParseError(code),
    );
  }
});
