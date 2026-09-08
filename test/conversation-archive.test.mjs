import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationArchiveParseError,
  parseConversationArchiveInput,
  parseConversationArchiveResult,
} from "../dist/index.js";
import * as clientArchiveContracts from "../dist/client/index.js";
import * as serverArchiveContracts from "../dist/server/index.js";

const archivedAt = "2026-08-25T22:00:00.000Z";
const archiveInput = {
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId: "conversation-1",
  expectedLifecycleRevision: 4,
  idempotencyKey: "archive-conversation-1",
};
const restoreInput = {
  operation: "set_conversation_archive",
  intent: "restore",
  conversationId: "conversation-1",
  expectedLifecycleRevision: 9,
  idempotencyKey: "restore-conversation-1",
};

const archivedState = {
  status: "archived",
  archivedAt,
  archivedByUserId: "user-from-session",
};
const activeState = { status: "active" };

function resultFor(input, reconciliationStatus, lifecycleRevision, archiveState) {
  return {
    operation: "set_conversation_archive",
    intent: input.intent,
    reconciliationStatus,
    conversationId: input.conversationId,
    expectedLifecycleRevision: input.expectedLifecycleRevision,
    lifecycleRevision,
    archiveState,
  };
}

function assertParseError(code) {
  return (error) =>
    error instanceof ConversationArchiveParseError && error.code === code;
}

test("archive and restore inputs survive JSON round trips across every public entry point", () => {
  for (const input of [archiveInput, restoreInput]) {
    const roundTripped = JSON.parse(JSON.stringify(input));
    assert.deepEqual(parseConversationArchiveInput(roundTripped), input);
  }

  assert.equal(
    clientArchiveContracts.parseConversationArchiveInput,
    parseConversationArchiveInput,
  );
  assert.equal(
    serverArchiveContracts.parseConversationArchiveResult,
    parseConversationArchiveResult,
  );
});

test("rejects toggle-style, missing, blank, invalid, and unknown input fields", () => {
  const { idempotencyKey: _idempotency, ...withoutIdempotency } = archiveInput;
  const { expectedLifecycleRevision: _revision, ...withoutRevision } = archiveInput;

  for (const invalid of [
    withoutIdempotency,
    withoutRevision,
    { ...archiveInput, idempotencyKey: " \n" },
    { ...archiveInput, expectedLifecycleRevision: 0 },
    { ...archiveInput, expectedLifecycleRevision: -1 },
    { ...archiveInput, expectedLifecycleRevision: 1.5 },
    { ...archiveInput, expectedLifecycleRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...archiveInput, intent: "toggle" },
    { ...archiveInput, operation: "toggle_conversation_archive" },
    { ...archiveInput, toggle: true },
    { ...archiveInput, archived: true },
    { ...archiveInput, membership: { state: "removed" } },
    { ...archiveInput, route: "/conversations/1/archive" },
    { ...archiveInput, persistedAt: archivedAt },
  ]) {
    assert.throws(
      () => parseConversationArchiveInput(invalid),
      assertParseError("malformed_input"),
    );
  }
});

test("rejects normalized tenant, actor, session, authorization, role, capability, permission, and entity spoofing", () => {
  const spoofed = [
    ["tenant-id", "tenant-spoof"],
    ["organization.id", "organization-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["current-user", { id: "user-spoof" }],
    ["session id", "session-spoof"],
    ["authorization", "Bearer spoof"],
    ["role", "admin"],
    ["roles", ["admin"]],
    ["capability", "chat.archive"],
    ["capabilities", ["chat.archive"]],
    ["permission", "archive:any"],
    ["permissions", ["archive:any"]],
    ["entity", { type: "invoice", id: "invoice-1" }],
    ["host-entity-authorization", true],
  ];

  for (const [field, value] of spoofed) {
    assert.throws(
      () => parseConversationArchiveInput({ ...archiveInput, [field]: value }),
      assertParseError("trusted_identity_field"),
      field,
    );
  }
});

test("applied, replayed, already-requested-state, and lifecycle-conflict results are deterministic", () => {
  const archiveCases = [
    ["applied", 5, archivedState],
    ["replayed", 5, archivedState],
    ["already_requested_state", 8, archivedState],
    ["lifecycle_conflict", 7, activeState],
  ];
  const restoreCases = [
    ["applied", 10, activeState],
    ["replayed", 10, activeState],
    ["already_requested_state", 12, activeState],
    ["lifecycle_conflict", 11, archivedState],
  ];

  for (const [input, cases] of [
    [archiveInput, archiveCases],
    [restoreInput, restoreCases],
  ]) {
    const parsed = cases.map(([status, revision, state]) =>
      parseConversationArchiveResult(
        JSON.parse(JSON.stringify(resultFor(input, status, revision, state))),
        input,
      ),
    );

    for (const [index, value] of parsed.entries()) {
      assert.equal(value.reconciliationStatus, cases[index][0]);
      assert.equal(value.intent, input.intent);
      assert.equal(value.conversationId, input.conversationId);
      assert.equal(value.expectedLifecycleRevision, input.expectedLifecycleRevision);
      assert.deepEqual(Object.keys(value).sort(), Object.keys(parsed[0]).sort());
    }
  }
});

test("rejects results whose request identity, intent, or revision does not match", () => {
  const valid = resultFor(archiveInput, "applied", 5, archivedState);

  for (const incoherent of [
    { ...valid, intent: "restore" },
    { ...valid, conversationId: "conversation-other" },
    { ...valid, expectedLifecycleRevision: 3 },
  ]) {
    assert.throws(
      () => parseConversationArchiveResult(incoherent, archiveInput),
      assertParseError("incoherent_result"),
    );
  }
});

test("rejects result revision and archive state inconsistent with its outcome", () => {
  for (const incoherent of [
    resultFor(archiveInput, "applied", 4, archivedState),
    resultFor(archiveInput, "applied", 5, activeState),
    resultFor(archiveInput, "replayed", 5, activeState),
    resultFor(archiveInput, "already_requested_state", 6, activeState),
    resultFor(archiveInput, "lifecycle_conflict", 4, activeState),
    resultFor(archiveInput, "lifecycle_conflict", 6, archivedState),
    resultFor(restoreInput, "applied", 10, archivedState),
    resultFor(restoreInput, "lifecycle_conflict", 11, activeState),
  ]) {
    const input = incoherent.intent === "archive" ? archiveInput : restoreInput;
    assert.throws(
      () => parseConversationArchiveResult(incoherent, input),
      assertParseError("incoherent_result"),
    );
  }
});

test("rejects malformed, incomplete, and non-canonical result shapes", () => {
  const valid = resultFor(archiveInput, "applied", 5, archivedState);
  const { lifecycleRevision: _lifecycleRevision, ...withoutLifecycleRevision } =
    valid;

  for (const malformed of [
    withoutLifecycleRevision,
    { ...valid, reconciliationStatus: "conflict" },
    { ...valid, lifecycleRevision: 0 },
    { ...valid, serverRoute: "/internal/archive" },
    { ...valid, archiveState: { status: "active", archivedAt } },
    { ...valid, archiveState: { status: "archived", archivedAt } },
    {
      ...valid,
      archiveState: { ...archivedState, archivedAt: "not-a-timestamp" },
    },
    {
      ...valid,
      archiveState: { ...archivedState, archivedByUserId: " " },
    },
  ]) {
    assert.throws(
      () => parseConversationArchiveResult(malformed, archiveInput),
      assertParseError("malformed_result"),
    );
  }
});
