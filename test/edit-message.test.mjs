import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

// Bundle the current public contract source; dist may belong to an older build.
const bundled = await build({
  entryPoints: [new URL("../src/contracts/message-mutations.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false,
});
const { parseEditMessageInput, parseEditMessageResult, MessageMutationParseError } =
  await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

const statuses = ["applied", "replayed", "revision_conflict"];
const reply = { messageId: "source-message", notifyAuthor: false };
const input = {
  operation: "edit", messageId: "message-1", expectedRevision: 2,
  content: { format: "plain", text: "Friday" }, idempotencyKey: "edit-1",
};
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const parseError = (code) => (error) =>
  error instanceof MessageMutationParseError && error.code === code;

function resultFixture(status, reference = {}) {
  return {
    operation: "edit", reconciliationStatus: status,
    expectedRevision: status === "revision_conflict" ? 1 : 2,
    message: {
      id: "message-1", tenantId: "tenant-1", conversationId: "conversation-1",
      author: { type: "user", userId: "bob" }, sequence: 7,
      createdAt: "2026-08-25T20:00:00.000Z", updatedAt: "2026-08-25T20:01:00.000Z",
      revision: { revision: 3, editedAt: "2026-08-25T20:01:00.000Z", editedByUserId: "bob" },
      content: input.content, ...reference,
    },
    canonicalRevision: 3,
  };
}

for (const status of statuses) {
  test(`${status} round-trips legacy and reply messages with both notification choices`, () => {
    const references = [{}, ...[false, true].flatMap((notifyAuthor) =>
      ["source-message", "source with space", "x".repeat(255), "é".repeat(127) + "a"]
        .map((messageId) => ({ replyTo: { messageId, notifyAuthor } })))];
    for (const reference of references) {
      const wire = resultFixture(status, reference);
      const parsed = parseEditMessageResult(wire);
      assert.strictEqual(parsed.message, wire.message);
      assert.deepEqual(roundTrip(parseEditMessageResult(roundTrip(wire))), wire);
      assert.equal(Object.hasOwn(parsed.message, "replyTo"), Object.hasOwn(reference, "replyTo"));
    }
  });

  test(`${status} rejects malformed reply metadata through canonical Message validation`, () => {
    const invalid = [null, undefined, [], "source-message", 42, true, {},
      { messageId: reply.messageId }, { notifyAuthor: false },
      ...[null, undefined, "false", 0, 1, {}, []].map((notifyAuthor) => ({ ...reply, notifyAuthor })),
      ...[null, undefined, 42, true, {}, [], "", " ", " source", "source ", "\u00a0source",
        "source\nline", "source\tline", "source\0", "source\u007f", "source\u0085",
        "source\u2028line", "source\u2029line", "x".repeat(256), "é".repeat(128)]
        .map((messageId) => ({ ...reply, messageId })),
      ...["tenantId", "actor", "actorId", "userId", "author", "authorId", "sourceMessageId",
        "originalAuthor", "originalCreatedAt", "displayName", "sourceDisplay", "source", "content", "unknown"]
        .map((field) => ({ ...reply, [field]: "injected" })),
    ];
    for (const replyTo of invalid) {
      assert.throws(() => parseEditMessageResult(resultFixture(status, { replyTo })),
        parseError("malformed_result"), JSON.stringify(replyTo));
    }
  });
}

test("edit requests reject reply targets at the top level and inside content", () => {
  assert.deepEqual(roundTrip(parseEditMessageInput(roundTrip(input))), input);
  for (const replyTo of [reply, { ...reply, notifyAuthor: true }, null, undefined]) {
    assert.throws(() => parseEditMessageInput({ ...input, replyTo }), parseError("malformed_input"));
    assert.throws(() => parseEditMessageInput({ ...input, content: { ...input.content, replyTo } }),
      parseError("malformed_content"));
  }
});

test("reply results retain revision and active-message reconciliation checks", () => {
  for (const status of statuses) {
    const wire = resultFixture(status, { replyTo: reply });
    assert.throws(() => parseEditMessageResult({ ...wire, canonicalRevision: 4 }), parseError("revision_mismatch"));
    assert.throws(() => parseEditMessageResult({ ...wire, expectedRevision: status === "revision_conflict" ? 3 : 1 }),
      parseError("revision_mismatch"));
    const deleted = { ...wire, message: { ...wire.message, content: null,
      deletedAt: "2026-08-25T20:02:00.000Z", deletedByUserId: "bob" } };
    if (status === "revision_conflict") {
      assert.deepEqual(roundTrip(parseEditMessageResult(roundTrip(deleted))), deleted);
    } else {
      assert.throws(() => parseEditMessageResult(deleted), parseError("malformed_result"));
    }
  }
});
