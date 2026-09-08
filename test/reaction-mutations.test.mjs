import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REACTION_IDEMPOTENCY_KEY_UTF8_BYTES,
  ReactionMutationParseError,
  parseAddReactionInput,
  parseAddReactionResult,
  parseReactionMutationInput,
  parseReactionMutationResult,
  parseRemoveReactionInput,
  parseRemoveReactionResult,
} from "../dist/index.js";

const validAdd = {
  operation: "add_reaction",
  messageId: "message-1",
  reactionKey: "👍",
  idempotencyKey: "reaction-attempt-1",
};

const validRemove = {
  ...validAdd,
  operation: "remove_reaction",
  idempotencyKey: "reaction-attempt-2",
};

function assertParseError(code) {
  return (error) =>
    error instanceof ReactionMutationParseError && error.code === code;
}

test("parses deterministic add and remove intents", () => {
  assert.deepEqual(parseAddReactionInput(validAdd), validAdd);
  assert.deepEqual(parseRemoveReactionInput(validRemove), validRemove);
  assert.equal(parseReactionMutationInput(validAdd).operation, "add_reaction");
  assert.equal(
    parseReactionMutationInput(validRemove).operation,
    "remove_reaction",
  );
});

test("rejects malformed and noncanonical reaction keys", () => {
  const malformedKeys = [
    "",
    " ",
    " 👍",
    "👍 ",
    "\tthumbsup",
    "thumbsup\n",
    "e\u0301",
    "x".repeat(65),
    "👍".repeat(17),
  ];

  for (const reactionKey of malformedKeys) {
    assert.throws(
      () => parseAddReactionInput({ ...validAdd, reactionKey }),
      assertParseError("malformed_reaction_key"),
      JSON.stringify(reactionKey),
    );
  }

  assert.equal(
    parseAddReactionInput({ ...validAdd, reactionKey: "é" }).reactionKey,
    "é",
  );
  assert.equal(
    parseAddReactionInput({ ...validAdd, reactionKey: "x".repeat(64) })
      .reactionKey.length,
    64,
  );
});

test("requires a nonblank bounded idempotency key on every intent", () => {
  for (const valid of [validAdd, validRemove]) {
    const { idempotencyKey: _, ...withoutKey } = valid;
    const invalid = [
      withoutKey,
      { ...valid, idempotencyKey: undefined },
      { ...valid, idempotencyKey: "" },
      { ...valid, idempotencyKey: " \t" },
      {
        ...valid,
        idempotencyKey: "x".repeat(
          MAX_REACTION_IDEMPOTENCY_KEY_UTF8_BYTES + 1,
        ),
      },
    ];

    for (const input of invalid) {
      assert.throws(
        () => parseReactionMutationInput(input),
        assertParseError("malformed_input"),
      );
    }
  }
});

test("rejects caller-authored trusted identity fields", () => {
  const spoofedFields = [
    ["tenantId", "tenant-spoof"],
    ["tenant_id", "tenant-spoof"],
    ["userId", "user-spoof"],
    ["actor", { userId: "user-spoof" }],
    ["actor-id", "user-spoof"],
    ["roles", ["admin"]],
  ];

  for (const input of [validAdd, validRemove]) {
    for (const [field, value] of spoofedFields) {
      assert.throws(
        () => parseReactionMutationInput({ ...input, [field]: value }),
        assertParseError("trusted_identity_field"),
        field,
      );
    }
  }
});

test("rejects ambiguous toggle semantics and extra desired-state fields", () => {
  assert.throws(
    () =>
      parseReactionMutationInput({
        ...validAdd,
        operation: "toggle_reaction",
      }),
    assertParseError("malformed_input"),
  );
  assert.throws(
    () => parseAddReactionInput({ ...validAdd, toggle: true }),
    assertParseError("malformed_input"),
  );
  assert.throws(
    () => parseRemoveReactionInput({ ...validRemove, desiredState: true }),
    assertParseError("malformed_input"),
  );
});

test("validates canonical aggregate results and current-user coherence", () => {
  const addResult = {
    operation: "add_reaction",
    reconciliationStatus: "applied",
    messageId: "message-1",
    reactionKey: "👍",
    count: 3,
    reactedByCurrentUser: true,
  };
  const removeResult = {
    operation: "remove_reaction",
    reconciliationStatus: "applied",
    messageId: "message-1",
    reactionKey: "👍",
    count: 2,
    reactedByCurrentUser: false,
  };

  assert.deepEqual(parseAddReactionResult(addResult), addResult);
  assert.deepEqual(parseRemoveReactionResult(removeResult), removeResult);
  assert.equal(parseReactionMutationResult(addResult).count, 3);
  assert.equal(parseReactionMutationResult(removeResult).count, 2);

  const invalidResults = [
    { ...addResult, count: -1 },
    { ...addResult, count: 1.5 },
    { ...addResult, count: Number.MAX_SAFE_INTEGER + 1 },
    { ...addResult, count: 0 },
    { ...addResult, reactedByCurrentUser: false },
    { ...removeResult, reactedByCurrentUser: true },
    { ...removeResult, reactionKey: "e\u0301" },
  ];

  for (const result of invalidResults) {
    assert.throws(() => parseReactionMutationResult(result));
  }

  assert.equal(
    parseRemoveReactionResult({ ...removeResult, count: 0 }).count,
    0,
  );
});

test("add/add and remove/remove replays preserve one canonical state", () => {
  const addApplied = parseAddReactionResult({
    operation: "add_reaction",
    reconciliationStatus: "applied",
    messageId: "message-1",
    reactionKey: "👍",
    count: 3,
    reactedByCurrentUser: true,
  });
  const addReplayed = parseAddReactionResult({
    ...addApplied,
    reconciliationStatus: "replayed",
  });
  const removeApplied = parseRemoveReactionResult({
    operation: "remove_reaction",
    reconciliationStatus: "applied",
    messageId: "message-1",
    reactionKey: "👍",
    count: 2,
    reactedByCurrentUser: false,
  });
  const removeReplayed = parseRemoveReactionResult({
    ...removeApplied,
    reconciliationStatus: "replayed",
  });

  const canonicalState = ({ reconciliationStatus: _, ...result }) => result;
  assert.deepEqual(canonicalState(addReplayed), canonicalState(addApplied));
  assert.equal(addReplayed.reactedByCurrentUser, true);
  assert.deepEqual(
    canonicalState(removeReplayed),
    canonicalState(removeApplied),
  );
  assert.equal(removeReplayed.reactedByCurrentUser, false);
});
