import assert from "node:assert/strict";
import test from "node:test";

import { build } from "esbuild";

// Exercise the current generated contracts, independent of stale dist output.
const bundled = await build({
  entryPoints: [new URL("../src/contracts/message-mutations.ts", import.meta.url).pathname],
  bundle: true, format: "esm", platform: "node", target: "node22", write: false,
});
const {
  MessageMutationParseError,
  parseEditMessageInput,
  parseEditMessageResult,
  parseSendMessageInput,
  parseSendMessageResult,
  parseSoftDeleteMessageInput,
  parseSoftDeleteMessageResult,
} = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));

const content = {
  format: "markdown",
  text: "Order **42** is ready",
  mentions: [
    { type: "user", userId: "user-2" },
    { type: "conversation", conversationId: "conversation-2" },
    { type: "entity", entity: { type: "order", id: "42" } },
  ],
  attachments: [{ attachmentId: "attachment-1" }],
  blocks: [{ type: "order", data: { orderId: "42" } }],
};

function canonicalMessage(revision = 1, overrides = {}) {
  return {
    id: "message-1",
    tenantId: "tenant-from-session",
    conversationId: "conversation-1",
    author: { type: "user", userId: "user-from-session" },
    sequence: 7,
    createdAt: "2026-08-25T20:00:00.000Z",
    updatedAt: "2026-08-25T20:00:00.000Z",
    revision: { revision },
    content,
    ...overrides,
  };
}

function assertParseError(code) {
  return (error) =>
    error instanceof MessageMutationParseError && error.code === code;
}

test("parses distinct valid send, edit, and soft-delete inputs", () => {
  const send = parseSendMessageInput({
    operation: "send",
    conversationId: "conversation-1",
    clientMessageId: "optimistic-1",
    idempotencyKey: "send-attempt-1",
    content,
  });
  const edit = parseEditMessageInput({
    operation: "edit",
    messageId: "message-1",
    expectedRevision: 1,
    idempotencyKey: "edit-attempt-1",
    content: { format: "plain", text: "Edited" },
  });
  const deleted = parseSoftDeleteMessageInput({
    operation: "soft_delete",
    messageId: "message-1",
    expectedRevision: 2,
    idempotencyKey: "delete-attempt-1",
  });

  assert.equal(send.clientMessageId, "optimistic-1");
  assert.equal(send.content.mentions[0].userId, "user-2");
  assert.equal(edit.expectedRevision, 1);
  assert.equal(deleted.expectedRevision, 2);
});

test("rejects missing, blank, and misplaced mutation identities", () => {
  const validSend = {
    operation: "send",
    conversationId: "conversation-1",
    clientMessageId: "optimistic-1",
    idempotencyKey: "send-attempt-1",
    content: { format: "plain", text: "Hello" },
  };
  const validEdit = {
    operation: "edit",
    messageId: "message-1",
    expectedRevision: 1,
    idempotencyKey: "edit-attempt-1",
    content: { format: "plain", text: "Edited" },
  };
  const validDelete = {
    operation: "soft_delete",
    messageId: "message-1",
    expectedRevision: 1,
    idempotencyKey: "delete-attempt-1",
  };

  const invalid = [
    () => parseSendMessageInput({ ...validSend, conversationId: " " }),
    () => parseSendMessageInput({ ...validSend, clientMessageId: "\t" }),
    () => parseSendMessageInput({ ...validSend, idempotencyKey: "" }),
    () => {
      const { idempotencyKey: _, ...withoutKey } = validSend;
      return parseSendMessageInput(withoutKey);
    },
    () =>
      parseSendMessageInput({
        ...validSend,
        idempotencyKey: undefined,
        content: { ...validSend.content, idempotencyKey: "misplaced" },
      }),
    () => parseEditMessageInput({ ...validEdit, expectedRevision: 0 }),
    () => parseEditMessageInput({ ...validEdit, expectedRevision: 1.5 }),
    () => parseEditMessageInput({ ...validEdit, idempotencyKey: " " }),
    () => {
      const { expectedRevision: _, ...withoutRevision } = validEdit;
      return parseEditMessageInput(withoutRevision);
    },
    () => parseSoftDeleteMessageInput({ ...validDelete, idempotencyKey: "\n" }),
    () => parseSoftDeleteMessageInput({ ...validDelete, expectedRevision: -1 }),
    () => {
      const { idempotencyKey: _, ...withoutKey } = validDelete;
      return parseSoftDeleteMessageInput({
        ...withoutKey,
        mutation: { idempotencyKey: "misplaced" },
      });
    },
  ];

  for (const parse of invalid) {
    assert.throws(parse, assertParseError("malformed_input"));
  }
});

test("rejects cross-command and reused command shapes", () => {
  const send = {
    operation: "send",
    conversationId: "conversation-1",
    clientMessageId: "optimistic-1",
    idempotencyKey: "same-key-shape",
    content: { format: "plain", text: "Hello" },
  };
  const edit = {
    operation: "edit",
    messageId: "message-1",
    expectedRevision: 1,
    idempotencyKey: "same-key-shape",
    content: { format: "plain", text: "Edited" },
  };
  const deleted = {
    operation: "soft_delete",
    messageId: "message-1",
    expectedRevision: 1,
    idempotencyKey: "same-key-shape",
  };

  assert.throws(() => parseEditMessageInput(send), assertParseError("malformed_input"));
  assert.throws(
    () => parseSoftDeleteMessageInput(edit),
    assertParseError("malformed_input"),
  );
  assert.throws(() => parseSendMessageInput(deleted), assertParseError("malformed_input"));
});

test("rejects client attempts to spoof trusted identity", () => {
  const valid = {
    operation: "send",
    conversationId: "conversation-1",
    clientMessageId: "optimistic-1",
    idempotencyKey: "send-attempt-1",
    content: { format: "plain", text: "Hello" },
  };
  const spoofedFields = [
    ["tenantId", "tenant-spoof"],
    ["organization_id", "organization-spoof"],
    ["actor", { userId: "actor-spoof" }],
    ["userId", "user-spoof"],
    ["author", { type: "user", userId: "author-spoof" }],
    ["principalId", "principal-spoof"],
    ["session_id", "session-spoof"],
  ];

  for (const [field, value] of spoofedFields) {
    assert.throws(
      () => parseSendMessageInput({ ...valid, [field]: value }),
      assertParseError("trusted_identity_field"),
      field,
    );
  }
});

test("parses applied and replayed results with canonical revisions", () => {
  const editedMessage = canonicalMessage(2, {
    updatedAt: "2026-08-25T20:01:00.000Z",
    revision: {
      revision: 2,
      editedAt: "2026-08-25T20:01:00.000Z",
      editedByUserId: "user-from-session",
    },
    content: { format: "plain", text: "Edited" },
  });
  const applied = parseEditMessageResult({
    operation: "edit",
    reconciliationStatus: "applied",
    expectedRevision: 1,
    message: editedMessage,
    canonicalRevision: 2,
  });
  const replayed = parseEditMessageResult({
    operation: "edit",
    reconciliationStatus: "replayed",
    expectedRevision: 1,
    message: editedMessage,
    canonicalRevision: 2,
  });
  const deletedMessage = canonicalMessage(3, {
    content: null,
    updatedAt: "2026-08-25T20:02:00.000Z",
    revision: { revision: 3 },
    deletedAt: "2026-08-25T20:02:00.000Z",
    deletedByUserId: "user-from-session",
  });
  const deleted = parseSoftDeleteMessageResult({
    operation: "soft_delete",
    reconciliationStatus: "applied",
    expectedRevision: 2,
    message: deletedMessage,
    canonicalRevision: 3,
  });

  assert.equal(applied.reconciliationStatus, "applied");
  assert.equal(replayed.reconciliationStatus, "replayed");
  assert.equal(deleted.message.content, null);
  assert.equal(deleted.canonicalRevision, 3);
});

test("returns deterministic edit and soft-delete revision conflicts", () => {
  const canonical = canonicalMessage(4, {
    updatedAt: "2026-08-25T20:03:00.000Z",
    revision: {
      revision: 4,
      editedAt: "2026-08-25T20:03:00.000Z",
      editedByUserId: "other-user",
    },
    content: { format: "plain", text: "Newer canonical content" },
  });
  const editConflict = parseEditMessageResult({
    operation: "edit",
    reconciliationStatus: "revision_conflict",
    expectedRevision: 2,
    message: canonical,
    canonicalRevision: 4,
  });
  const deleteConflict = parseSoftDeleteMessageResult({
    operation: "soft_delete",
    reconciliationStatus: "revision_conflict",
    expectedRevision: 3,
    message: canonical,
    canonicalRevision: 4,
  });

  assert.equal(editConflict.reconciliationStatus, "revision_conflict");
  assert.equal(editConflict.expectedRevision, 2);
  assert.equal(editConflict.message.content.text, "Newer canonical content");
  assert.equal(deleteConflict.reconciliationStatus, "revision_conflict");
  assert.equal(deleteConflict.canonicalRevision, 4);

  assert.throws(
    () =>
      parseEditMessageResult({
        operation: "edit",
        reconciliationStatus: "revision_conflict",
        expectedRevision: 4,
        message: canonical,
        canonicalRevision: 4,
      }),
    assertParseError("revision_mismatch"),
  );
});

test("uses the exact echoed clientMessageId to replace one optimistic send", () => {
  const result = parseSendMessageResult({
    operation: "send",
    reconciliationStatus: "replayed",
    clientMessageId: "optimistic-2",
    message: canonicalMessage(),
    canonicalRevision: 1,
  });
  const optimistic = new Map([
    ["optimistic-1", { text: "First pending message" }],
    ["optimistic-2", { text: "Order **42** is ready" }],
  ]);

  assert.equal(optimistic.delete(result.clientMessageId), true);
  assert.deepEqual([...optimistic.keys()], ["optimistic-1"]);
  assert.equal(result.clientMessageId, "optimistic-2");
  assert.equal(result.message.id, "message-1");
});

test("rejects malformed canonical result revisions", () => {
  assert.throws(
    () =>
      parseSendMessageResult({
        operation: "send",
        reconciliationStatus: "applied",
        clientMessageId: "optimistic-1",
        message: canonicalMessage(2),
        canonicalRevision: 2,
      }),
    assertParseError("revision_mismatch"),
  );
  assert.throws(
    () =>
      parseEditMessageResult({
        operation: "edit",
        reconciliationStatus: "applied",
        expectedRevision: 1,
        message: canonicalMessage(2),
        canonicalRevision: 3,
      }),
    assertParseError("revision_mismatch"),
  );
});


const sendWire = {
  operation: "send", conversationId: "conversation-1", content,
  clientMessageId: "optimistic-1", idempotencyKey: "send-attempt-1",
};
const sendResultWire = (message, reconciliationStatus = "applied") => ({
  operation: "send", reconciliationStatus, clientMessageId: sendWire.clientMessageId,
  message, canonicalRevision: 1,
});
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

test("send request and applied/replayed results preserve omitted and explicit reply references", () => {
  for (const replyTo of [undefined, ...[true, false].flatMap((notifyAuthor) =>
    ["source-message", "x".repeat(255), "é".repeat(127) + "a", "source with space"].map((messageId) => ({ messageId, notifyAuthor })))]) {
    const reference = replyTo === undefined ? {} : { replyTo };
    const wire = { ...sendWire, ...reference };
    assert.deepEqual(roundTrip(parseSendMessageInput(roundTrip(wire))), wire);
    assert.equal(parseSendMessageInput(wire).conversationId, sendWire.conversationId);
    for (const status of ["applied", "replayed"]) {
      const result = sendResultWire(canonicalMessage(1, reference), status);
      assert.deepEqual(roundTrip(parseSendMessageResult(roundTrip(result))), result);
    }
  }
});

test("send requests and canonical results reject malformed or enriched reply references", () => {
  const valid = { messageId: "source-message", notifyAuthor: false };
  const invalid = [null, undefined, [], "source-message", 42, true, {},
    { messageId: valid.messageId }, { notifyAuthor: true },
    ...[null, undefined, "true", 0, 1, {}, []].map((notifyAuthor) => ({ ...valid, notifyAuthor })),
    ...[null, undefined, 42, true, {}, [], "", " ", " source", "source ", "\u00a0source",
      "source\u00a0", "source\nline", "source\tline", "source\0", "source\u007f", "source\u0085",
      "source\u2028line", "source\u2029line", "x".repeat(256), "é".repeat(128)]
      .map((messageId) => ({ ...valid, messageId })),
    ...["tenantId", "actor", "actorId", "userId", "author", "authorId", "sourceMessageId",
      "originalAuthor", "originalCreatedAt", "displayName", "sourceDisplay", "source", "content", "unknown"]
      .map((field) => ({ ...valid, [field]: "injected" })),
  ];
  for (const replyTo of invalid) {
    assert.throws(() => parseSendMessageInput({ ...sendWire, replyTo }), assertParseError("malformed_input"));
    for (const status of ["applied", "replayed"]) {
      assert.throws(() => parseSendMessageResult(sendResultWire(canonicalMessage(1, { replyTo }), status)),
        assertParseError("malformed_result"));
    }
  }
  assert.throws(() => parseSendMessageInput({ ...sendWire, content: { ...content, replyTo: valid } }),
    assertParseError("malformed_content"));
  assert.throws(() => parseSendMessageResult(sendResultWire(canonicalMessage(1, {
    content: { ...content, replyTo: valid },
  }))), assertParseError("malformed_content"));
});

test("edit and delete canonical results preserve reply references through the shared parser", () => {
  const replyTo = { messageId: "source-message", notifyAuthor: false };
  for (const status of ["applied", "replayed"]) {
    const edited = {
      operation: "edit", reconciliationStatus: status, expectedRevision: 1,
      message: canonicalMessage(2, { replyTo }), canonicalRevision: 2,
    };
    assert.deepEqual(roundTrip(parseEditMessageResult(edited)), edited);
    const deleted = {
      operation: "soft_delete", reconciliationStatus: status, expectedRevision: 2,
      message: canonicalMessage(3, { replyTo, content: null,
        deletedAt: "2026-08-25T20:00:00.000Z", deletedByUserId: "user-from-session" }),
      canonicalRevision: 3,
    };
    assert.deepEqual(roundTrip(parseSoftDeleteMessageResult(deleted)), deleted);
  }
});
