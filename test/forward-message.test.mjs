import assert from "node:assert/strict";
import test from "node:test";

import {
  ForwardMessageParseError,
  parseForwardMessageInput,
  parseForwardMessageResult,
} from "../src/contracts/generated/forward-message.ts";

const requestWire = {
  operation: "forward_message.v1",
  sourceMessageId: "message-source",
  destinationConversationId: "conversation-destination",
  clientCorrelationId: "forward-client-1",
  idempotencyKey: "forward-attempt-1",
};

function resultWire(status = "applied") {
  return {
    operation: "forward_message.v1",
    reconciliationStatus: status,
    clientCorrelationId: "forward-client-1",
    destinationConversationId: "conversation-destination",
    message: {
      id: "message-destination",
      tenantId: "tenant-from-session",
      conversationId: "conversation-destination",
      author: { type: "user", userId: "forwarding-user" },
      sequence: 42,
      createdAt: "2026-08-28T16:00:00.000Z",
      updatedAt: "2026-08-28T16:00:00.000Z",
      revision: { revision: 1 },
      content: {
        format: "markdown",
        text: "Frozen **source** text",
        mentions: [{ type: "user", userId: "mentioned-user" }],
        forwarded: {
          sourceMessageId: "message-source",
          originalAuthor: { userId: "original-user", displayName: "Original Author" },
          originalCreatedAt: "2026-08-20T12:30:00.000Z",
        },
      },
    },
    canonicalRevision: 1,
  };
}

const hasCode = (code) => (error) => error instanceof ForwardMessageParseError && error.code === code;

test("valid request and applied/replayed authoritative results round-trip", () => {
  const request = parseForwardMessageInput(JSON.parse(JSON.stringify(requestWire)));
  assert.deepEqual(request, requestWire);
  for (const status of ["applied", "replayed"]) {
    const wire = resultWire(status);
    const result = parseForwardMessageResult(JSON.parse(JSON.stringify(wire)), request);
    assert.deepEqual(result, wire);
    assert.equal(result.message.author.userId, "forwarding-user");
    assert.equal(result.message.content.forwarded.originalAuthor.displayName, "Original Author");
  }
});

test("snapshot parsing creates a durable display copy independent of later source changes", () => {
  const request = parseForwardMessageInput(requestWire);
  const wire = resultWire();
  const parsed = parseForwardMessageResult(wire, request);
  wire.message.content.text = "later edited source text";
  wire.message.content.forwarded.originalAuthor.displayName = "later renamed author";
  assert.equal(parsed.message.content.text, "Frozen **source** text");
  assert.equal(parsed.message.content.forwarded.originalAuthor.displayName, "Original Author");
});

test("request recursively rejects trusted identity and server-authored destination fields", () => {
  for (const [field, value, code] of [
    ["tenant-id", "spoofed", "trusted_identity_field"],
    ["author", { userId: "spoofed" }, "trusted_identity_field"],
    ["destinationMessageId", "caller-message", "server_owned_field"],
    ["content", { text: "caller copy" }, "server_owned_field"],
  ]) {
    assert.throws(
      () => parseForwardMessageInput({ ...requestWire, [field]: value }),
      hasCode(code),
      field,
    );
  }
  assert.throws(
    () => parseForwardMessageInput({
      ...requestWire,
      extra: { nested: { "session-id": "spoofed" } },
    }),
    hasCode("trusted_identity_field"),
  );
});

test("result deterministically rejects attachment state and unsafe snapshot fields", () => {
  const request = parseForwardMessageInput(requestWire);
  for (const attachments of [[], [{ attachmentId: "attachment-source" }]]) {
    const wire = resultWire();
    wire.message.content.attachments = attachments;
    assert.throws(
      () => parseForwardMessageResult(wire, request),
      hasCode("source_attachments_unsupported"),
    );
  }
  for (const extra of [
    { session: { token: "secret" } },
    { authorization: "private" },
    { rawHtml: "<b>unsafe</b>" },
  ]) {
    const wire = resultWire();
    Object.assign(wire.message.content.forwarded, extra);
    assert.throws(
      () => parseForwardMessageResult(wire, request),
      hasCode("malformed_attribution"),
    );
  }
});

test("result enforces correlation, destination, source, authoritativeness, and revision one", () => {
  const request = parseForwardMessageInput(requestWire);
  const cases = [
    ["correlation_mismatch", (wire) => { wire.clientCorrelationId = "other"; }],
    ["destination_conversation_mismatch", (wire) => { wire.destinationConversationId = "other"; }],
    ["destination_conversation_mismatch", (wire) => { wire.message.conversationId = "other"; }],
    ["source_message_mismatch", (wire) => { wire.message.content.forwarded.sourceMessageId = "other"; }],
    ["noncanonical_destination", (wire) => { wire.canonicalRevision = 2; wire.message.revision.revision = 2; }],
  ];
  for (const [code, mutate] of cases) {
    const wire = resultWire();
    mutate(wire);
    assert.throws(() => parseForwardMessageResult(wire, request), hasCode(code), code);
  }
});
