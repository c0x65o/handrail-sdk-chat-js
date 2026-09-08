import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";

const bundled = await build({
  entryPoints: [resolve("src/contracts/message-mutations.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const moduleUrl =
  "data:text/javascript;base64," +
  Buffer.from(bundled.outputFiles[0].text).toString("base64");
const {
  MessageMutationParseError,
  parseSoftDeleteMessageInput,
  parseSoftDeleteMessageResult,
} = await import(moduleUrl);

const requestWire = {
  operation: "soft_delete",
  messageId: "message-1",
  expectedRevision: 2,
  idempotencyKey: "delete-attempt-1",
};

function canonicalMessage(revision, overrides = {}) {
  return {
    id: "message-1",
    tenantId: "tenant-from-session",
    conversationId: "conversation-1",
    author: { type: "user", userId: "user-from-session" },
    sequence: 7,
    createdAt: "2026-08-25T20:00:00.000Z",
    updatedAt: "2026-08-25T20:02:00.000Z",
    revision: { revision },
    content: { format: "plain", text: "Current canonical content" },
    ...overrides,
  };
}

function tombstone(revision = 3, overrides = {}) {
  return canonicalMessage(revision, {
    content: null,
    deletedAt: "2026-08-25T20:02:00.000Z",
    deletedByUserId: "user-from-session",
    ...overrides,
  });
}

function resultWire(reconciliationStatus, overrides = {}) {
  return {
    operation: "soft_delete",
    reconciliationStatus,
    expectedRevision: reconciliationStatus === "revision_conflict" ? 1 : 2,
    message: tombstone(3),
    canonicalRevision: 3,
    ...overrides,
  };
}

function parseError(code) {
  return (error) =>
    error instanceof MessageMutationParseError && error.code === code;
}

test("soft-delete input and all result statuses preserve exact wire JSON", () => {
  assert.deepEqual(parseSoftDeleteMessageInput(structuredClone(requestWire)), requestWire);

  for (const status of ["applied", "replayed", "revision_conflict"]) {
    const wire = resultWire(status);
    assert.deepEqual(parseSoftDeleteMessageResult(structuredClone(wire)), wire);
  }
});

test("soft-delete input rejects normalized trusted identity aliases", () => {
  for (const alias of [
    "tenant-id",
    "organization_id",
    "Actor_User_ID",
    "current-user",
    "userId",
    "author",
    "principal-id",
    "subject_id",
    "authenticated-user-id",
    "session-id",
    "authentication",
    "authorization",
    "role",
  ]) {
    assert.throws(
      () => parseSoftDeleteMessageInput({ ...requestWire, [alias]: "spoofed" }),
      parseError("trusted_identity_field"),
      alias,
    );
  }
});

test("soft-delete rejects malformed revisions and unknown envelope fields", () => {
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => parseSoftDeleteMessageInput({ ...requestWire, expectedRevision: revision }),
      parseError("malformed_input"),
    );
    assert.throws(
      () =>
        parseSoftDeleteMessageResult(
          resultWire("applied", { canonicalRevision: revision }),
        ),
      parseError("malformed_result"),
    );
  }
  assert.throws(
    () => parseSoftDeleteMessageInput({ ...requestWire, actorContextHint: true }),
    parseError("malformed_input"),
  );
  assert.throws(
    () => parseSoftDeleteMessageResult({ ...resultWire("applied"), messageId: "message-1" }),
    parseError("malformed_result"),
  );
});

test("soft-delete validates canonical tombstones and revision coherence", () => {
  assert.throws(
    () =>
      parseSoftDeleteMessageResult(
        resultWire("applied", { message: canonicalMessage(3) }),
      ),
    parseError("malformed_result"),
  );
  assert.throws(
    () =>
      parseSoftDeleteMessageResult(
        resultWire("applied", {
          message: tombstone(3, {
            content: { format: "plain", text: "must be redacted" },
          }),
        }),
      ),
    parseError("malformed_result"),
  );
  assert.throws(
    () =>
      parseSoftDeleteMessageResult(
        resultWire("applied", {
          message: tombstone(3, { deletedByUserId: undefined }),
        }),
      ),
    parseError("malformed_result"),
  );
  assert.throws(
    () => parseSoftDeleteMessageResult(resultWire("applied", { canonicalRevision: 4 })),
    parseError("revision_mismatch"),
  );
  assert.throws(
    () => parseSoftDeleteMessageResult(resultWire("replayed", { expectedRevision: 1 })),
    parseError("revision_mismatch"),
  );
  assert.throws(
    () =>
      parseSoftDeleteMessageResult(
        resultWire("revision_conflict", { expectedRevision: 3 }),
      ),
    parseError("revision_mismatch"),
  );
});

test("stale conflicts may carry the current active server message", () => {
  const wire = resultWire("revision_conflict", {
    message: canonicalMessage(4),
    canonicalRevision: 4,
  });
  assert.deepEqual(parseSoftDeleteMessageResult(structuredClone(wire)), wire);
});

// Exercise the deletion parser directly: durable message deletion uses this path
// independently of the durable-event parser.
function deletionResultVariants() {
  return [
    ...["applied", "replayed", "revision_conflict"].map((status) => resultWire(status)),
    resultWire("revision_conflict", { message: canonicalMessage(3) }),
  ];
}

const replyReference = { messageId: "source-message", notifyAuthor: false };
const jsonRoundTrip = (value) => JSON.parse(JSON.stringify(value));

test("all soft-delete result shapes round-trip replies and legacy omission", () => {
  for (const wire of deletionResultVariants()) {
    const legacy = parseSoftDeleteMessageResult(jsonRoundTrip(wire));
    assert.deepEqual(jsonRoundTrip(legacy), wire);
    assert.equal(Object.hasOwn(legacy.message, "replyTo"), false);

    for (const notifyAuthor of [false, true]) {
      for (const messageId of ["source-message", "a".repeat(255), "é".repeat(127) + "a"]) {
        const replyWire = {
          ...wire,
          message: { ...wire.message, replyTo: { messageId, notifyAuthor } },
        };
        const parsed = parseSoftDeleteMessageResult(jsonRoundTrip(replyWire));
        assert.deepEqual(parsed.message.replyTo, { messageId, notifyAuthor });
        assert.deepEqual(jsonRoundTrip(parsed), replyWire);
        assert.deepEqual(parseSoftDeleteMessageResult(jsonRoundTrip(parsed)), parsed);
      }
    }
  }
});

test("all soft-delete result shapes reject malformed MessageReplyReference values", () => {
  const invalidReferences = [
    null, false, 1, "source", [], {},
    { messageId: "source" }, { notifyAuthor: true },
    ...[null, true, 42, {}, [], "", " source", "source ", "a\n", "a\u007f", "a\u0085", "a\u2028", "a".repeat(256), "é".repeat(128)]
      .map((messageId) => ({ messageId, notifyAuthor: true })),
    ...[null, "true", "false", 0, 1, {}, []]
      .map((notifyAuthor) => ({ messageId: "source", notifyAuthor })),
    ...["tenantId", "actor", "actorId", "userId", "author", "authorId", "sourceMessageId", "originalAuthor", "originalCreatedAt", "displayName", "sourceDisplay", "source", "content", "unexpected"]
      .map((field) => ({ ...replyReference, [field]: "spoofed" })),
  ];
  for (const wire of deletionResultVariants()) {
    for (const replyTo of invalidReferences) {
      assert.throws(
        () => parseSoftDeleteMessageResult(jsonRoundTrip({
          ...wire, message: { ...wire.message, replyTo },
        })),
        parseError("malformed_result"),
        JSON.stringify({ status: wire.reconciliationStatus, replyTo }),
      );
    }
  }
});

test("replyTo remains forbidden on deletion requests, including null", () => {
  for (const replyTo of [replyReference, { ...replyReference, notifyAuthor: true }, null]) {
    assert.throws(
      () => parseSoftDeleteMessageInput(jsonRoundTrip({ ...requestWire, replyTo })),
      parseError("malformed_input"),
    );
  }
});

test("reply shells still enforce redaction, deletion metadata, and revisions", () => {
  for (const status of ["applied", "replayed", "revision_conflict"]) {
    for (const overrides of [
      { content: { format: "plain", text: "must be redacted" } },
      { deletedByUserId: undefined },
      { deletedAt: undefined },
    ]) {
      assert.throws(
        () => parseSoftDeleteMessageResult(jsonRoundTrip(resultWire(status, {
          message: tombstone(3, { replyTo: replyReference, ...overrides }),
        }))),
        parseError("malformed_result"),
      );
    }
    assert.throws(
      () => parseSoftDeleteMessageResult(resultWire(status, {
        message: tombstone(3, { replyTo: replyReference }), canonicalRevision: 4,
      })),
      parseError("revision_mismatch"),
    );
  }
});
