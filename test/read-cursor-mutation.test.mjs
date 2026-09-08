import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_READ_CURSOR_IDEMPOTENCY_KEY_UTF8_BYTES,
  ReadCursorMutationError,
  applyReadCursorMutation,
  createReadCursorMutationOutcome,
  createReadCursorUpdatedEvent,
  parseMarkReadInput,
  parseMarkUnreadInput,
  parseReadCursorMutationInput,
  parseReadCursorMutationOutcome,
  parseReadCursorMutationResult,
  parseReadCursorUpdatedEvent,
} from "../dist/index.js";

const currentReadState = {
  conversationId: "conversation-1",
  userId: "user-from-session",
  lastReadSequence: 7,
  manualUnreadFromSequence: 5,
  updatedAt: "2026-08-25T20:00:00.000Z",
};

const context = {
  currentReadState,
  latestSequence: 10,
  updatedAt: "2026-08-25T20:01:00.000Z",
};

const markReadInput = {
  operation: "mark_read",
  conversationId: "conversation-1",
  throughSequence: 9,
  idempotencyKey: "read-attempt-1",
};

const markUnreadInput = {
  operation: "mark_unread",
  conversationId: "conversation-1",
  fromSequence: 6,
  idempotencyKey: "unread-attempt-1",
};

function assertContractError(code) {
  return (error) =>
    error instanceof ReadCursorMutationError && error.code === code;
}

test("parses distinct exact mark-read and mark-unread commands", () => {
  assert.deepEqual(parseMarkReadInput(markReadInput), markReadInput);
  assert.deepEqual(parseMarkUnreadInput(markUnreadInput), markUnreadInput);
  assert.equal(
    parseReadCursorMutationInput(markReadInput).operation,
    "mark_read",
  );
  assert.equal(
    parseReadCursorMutationInput(markUnreadInput).operation,
    "mark_unread",
  );
});

test("requires nonblank idempotency keys within 255 UTF-8 bytes", () => {
  for (const valid of [markReadInput, markUnreadInput]) {
    const { idempotencyKey: _, ...withoutKey } = valid;
    const invalid = [
      withoutKey,
      { ...valid, idempotencyKey: undefined },
      { ...valid, idempotencyKey: "" },
      { ...valid, idempotencyKey: " \t\n" },
      {
        ...valid,
        idempotencyKey: "x".repeat(
          MAX_READ_CURSOR_IDEMPOTENCY_KEY_UTF8_BYTES + 1,
        ),
      },
      { ...valid, idempotencyKey: "🙂".repeat(64) },
    ];

    for (const input of invalid) {
      assert.throws(
        () => parseReadCursorMutationInput(input),
        assertContractError("malformed_input"),
      );
    }
  }

  assert.equal(
    parseMarkReadInput({
      ...markReadInput,
      idempotencyKey: "é".repeat(127) + "x",
    }).idempotencyKey.length,
    128,
  );
});

test("rejects every caller-authored trusted identity spelling", () => {
  const spoofedFields = [
    ["tenantId", "tenant-spoof"],
    ["organization_id", "tenant-spoof"],
    ["userId", "user-spoof"],
    ["current-user-id", "user-spoof"],
    ["actor", { userId: "user-spoof" }],
    ["actor_id", "user-spoof"],
    ["session", { id: "session-spoof" }],
    ["session-id", "session-spoof"],
    ["roles", ["admin"]],
    ["authorization", "spoofed"],
  ];

  for (const valid of [markReadInput, markUnreadInput]) {
    for (const [field, value] of spoofedFields) {
      assert.throws(
        () => parseReadCursorMutationInput({ ...valid, [field]: value }),
        assertContractError("trusted_identity_field"),
        field,
      );
    }
  }
});

test("rejects negative, noninteger, and unsafe command sequences", () => {
  const invalidReadSequences = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];
  for (const throughSequence of invalidReadSequences) {
    assert.throws(
      () => parseMarkReadInput({ ...markReadInput, throughSequence }),
      assertContractError("invalid_sequence"),
    );
  }

  const invalidUnreadSequences = [
    -1,
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const fromSequence of invalidUnreadSequences) {
    assert.throws(
      () => parseMarkUnreadInput({ ...markUnreadInput, fromSequence }),
      assertContractError("invalid_sequence"),
    );
  }
});

test("rejects cursor regression and mark-read beyond the latest sequence", () => {
  assert.throws(
    () =>
      applyReadCursorMutation(
        { ...markReadInput, throughSequence: 6 },
        context,
      ),
    assertContractError("cursor_regression"),
  );
  assert.throws(
    () =>
      applyReadCursorMutation(
        { ...markReadInput, throughSequence: 11 },
        context,
      ),
    assertContractError("sequence_out_of_range"),
  );
});

test("mark-unread accepts only an existing already-read/latest sequence", () => {
  const unreadFutureContext = {
    ...context,
    currentReadState: {
      ...currentReadState,
      lastReadSequence: 10,
      manualUnreadFromSequence: undefined,
    },
    latestSequence: 7,
  };

  assert.throws(
    () =>
      applyReadCursorMutation(
        { ...markUnreadInput, fromSequence: 8 },
        context,
      ),
    assertContractError("sequence_out_of_range"),
  );
  assert.throws(
    () =>
      applyReadCursorMutation(
        { ...markUnreadInput, fromSequence: 8 },
        unreadFutureContext,
      ),
    assertContractError("sequence_out_of_range"),
  );
  assert.throws(
    () =>
      applyReadCursorMutation(
        { ...markUnreadInput, conversationId: "conversation-other" },
        context,
      ),
    assertContractError("read_state_mismatch"),
  );
});

test("equal-cursor mark-read clears a marker and returns canonical unread", () => {
  const result = applyReadCursorMutation(
    { ...markReadInput, throughSequence: 7 },
    context,
  );

  assert.deepEqual(result, {
    operation: "mark_read",
    conversationId: "conversation-1",
    readState: {
      conversationId: "conversation-1",
      userId: "user-from-session",
      lastReadSequence: 7,
      updatedAt: "2026-08-25T20:01:00.000Z",
    },
    latestSequence: 10,
    unreadCount: 3,
  });
  assert.deepEqual(parseReadCursorMutationResult(result), result);
});

test("repeated explicit commands retain one outcome without a new transition", () => {
  const readOnce = applyReadCursorMutation(markReadInput, context);
  const readTwice = applyReadCursorMutation(markReadInput, {
    ...context,
    currentReadState: readOnce.readState,
    updatedAt: "2026-08-25T20:02:00.000Z",
  });
  assert.equal(readOnce.readState.lastReadSequence, 9);
  assert.equal(readTwice.readState.lastReadSequence, 9);
  assert.equal(readTwice.readState.updatedAt, readOnce.readState.updatedAt);
  assert.equal(readTwice.unreadCount, 1);

  const unreadOnce = applyReadCursorMutation(markUnreadInput, context);
  const unreadTwice = applyReadCursorMutation(markUnreadInput, {
    ...context,
    currentReadState: unreadOnce.readState,
    updatedAt: "2026-08-25T20:02:00.000Z",
  });
  assert.equal(unreadOnce.readState.lastReadSequence, 7);
  assert.equal(unreadOnce.readState.manualUnreadFromSequence, 6);
  assert.equal(unreadTwice.readState.manualUnreadFromSequence, 6);
  assert.equal(unreadTwice.readState.updatedAt, unreadOnce.readState.updatedAt);
  assert.equal(unreadTwice.unreadCount, 5);

  assert.equal(
    JSON.stringify(parseReadCursorMutationResult(unreadTwice)),
    JSON.stringify(unreadTwice),
  );
});

test("models applied and replayed HTTP outcomes with deterministic request correlation", () => {
  const canonical = applyReadCursorMutation(markReadInput, context);
  const applied = createReadCursorMutationOutcome(
    canonical,
    markReadInput,
    "applied",
  );
  const replayed = createReadCursorMutationOutcome(
    canonical,
    markReadInput,
    "replayed",
  );

  assert.equal(applied.reconciliationStatus, "applied");
  assert.equal(replayed.reconciliationStatus, "replayed");
  assert.deepEqual(
    { ...replayed, reconciliationStatus: "applied" },
    applied,
  );
  assert.deepEqual(
    parseReadCursorMutationOutcome(replayed, markReadInput),
    replayed,
  );

  for (const invalid of [
    { ...applied, reconciliationStatus: "cached" },
    { ...applied, idempotencyKey: "another-key" },
    { ...applied, unreadCount: 99 },
    { ...applied, throughSequence: 9 },
  ]) {
    assert.throws(
      () => parseReadCursorMutationOutcome(invalid, markReadInput),
      assertContractError("malformed_result"),
    );
  }
});

test("cross-device envelopes name the affected user and read-cursor semantics", () => {
  const result = applyReadCursorMutation(markUnreadInput, context);
  const event = createReadCursorUpdatedEvent({
    eventId: "event-1",
    protocolVersion: 4,
    tenantId: "tenant-from-session",
    occurredAt: "2026-08-25T20:01:00.000Z",
    result,
  });

  assert.equal(event.type, "conversation.read_cursor_updated");
  assert.equal(event.streamId, "user:user-from-session");
  assert.equal(event.payload.kind, "conversation_read_cursor");
  assert.equal(event.payload.actorUserId, "user-from-session");
  assert.equal(event.payload.conversationId, "conversation-1");
  assert.equal(event.payload.operation, "mark_unread");
  assert.equal(event.payload.readState.manualUnreadFromSequence, 6);
  assert.equal(event.payload.unreadCount, 5);
  assert.deepEqual(
    parseReadCursorUpdatedEvent(event, "tenant-from-session"),
    event,
  );

  assert.throws(
    () =>
      parseReadCursorUpdatedEvent(
        { ...event, streamId: "conversation:conversation-1" },
        "tenant-from-session",
      ),
    assertContractError("malformed_event"),
  );
  assert.throws(
    () =>
      parseReadCursorUpdatedEvent(
        {
          ...event,
          payload: { ...event.payload, actorUserId: "user-other" },
        },
        "tenant-from-session",
      ),
    assertContractError("malformed_event"),
  );
});

test("message edit and revision data are never read-state commands", () => {
  const edit = {
    operation: "edit",
    messageId: "message-1",
    expectedRevision: 1,
    idempotencyKey: "edit-attempt-1",
    content: { format: "plain", text: "Edited" },
  };

  assert.throws(
    () => parseReadCursorMutationInput(edit),
    assertContractError("malformed_input"),
  );
  assert.throws(
    () =>
      parseMarkReadInput({
        ...markReadInput,
        messageId: "message-1",
        revision: 2,
      }),
    assertContractError("malformed_input"),
  );
});
