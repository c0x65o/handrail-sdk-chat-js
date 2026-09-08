import assert from "node:assert/strict";
import test from "node:test";

import {
  AttachmentTransportError,
  MAX_ATTACHMENT_FILE_NAME_UTF8_BYTES,
  MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES,
  MAX_ATTACHMENT_SIZE_BYTES,
  isAllowedAttachmentLifecycleTransition,
  parseAttachmentDownloadDescriptor,
  parseAttachmentLifecycleState,
  parseAttachmentMutationResult,
  parseAttachmentTransportResult,
  parseAttachmentTransportInput,
  parseGetAttachmentDownloadResult,
  validateAttachmentLifecycleTransition,
} from "../src/contracts/attachment-transport.ts";
import {
  abandonedAttachment,
  abortAppliedResult,
  abortInput,
  abortReplayedResult,
  attachedAttachment,
  checksum,
  downloadDescriptor,
  downloadInput,
  downloadResult,
  finalizeAppliedResult,
  finalizeInput,
  finalizeReplayedResult,
  finalizedAttachment,
  fixtureNow,
  pendingAbortAttachment,
  pendingAttachment,
  prepareAppliedResult,
  prepareInput,
  prepareReplayedResult,
} from "./fixtures/attachment-transports.mjs";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const parseError = (...codes) =>
  (error) =>
    error instanceof AttachmentTransportError && codes.includes(error.code);

test("prepare, finalize, abort, and download inputs strictly round trip", () => {
  for (const input of [prepareInput, finalizeInput, abortInput, downloadInput]) {
    assert.deepEqual(
      parseAttachmentTransportInput(roundTrip(input), { now: fixtureNow }),
      input,
    );
  }
});

test("every mutation requires a bounded nonblank idempotency key", () => {
  for (const source of [prepareInput, finalizeInput, abortInput]) {
    const { idempotencyKey: _key, ...missing } = source;
    for (const input of [
      missing,
      { ...source, idempotencyKey: " \n" },
      {
        ...source,
        idempotencyKey: "x".repeat(
          MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES + 1,
        ),
      },
    ]) {
      assert.throws(
        () => parseAttachmentTransportInput(input, { now: fixtureNow }),
        parseError("malformed_input"),
      );
    }
  }
  assert.deepEqual(parseAttachmentTransportInput(downloadInput), downloadInput);
});

test("metadata enforces UTF-8 bounds, safe basenames, supported media, and application size", () => {
  const unsafeNames = [
    "../report.pdf",
    "folder/report.pdf",
    "folder\\report.pdf",
    ".hidden.pdf",
    "report.pdf.exe",
    "report\u0000.pdf",
    " report.pdf",
    "report.pdf ",
    "report\u202Efdp.exe",
    `${"é".repeat(MAX_ATTACHMENT_FILE_NAME_UTF8_BYTES)}.pdf`,
  ];
  for (const fileName of unsafeNames) {
    assert.throws(
      () =>
        parseAttachmentTransportInput({
          ...prepareInput,
          metadata: { ...prepareInput.metadata, fileName },
        }),
      parseError("unsafe_filename"),
      fileName,
    );
  }

  for (const contentType of [
    "application/octet-stream",
    "application/javascript",
    "image/svg+xml",
    "text/html",
    "Application/PDF",
    "application/pdf; charset=utf-8",
    "image/png\ntext/html",
  ]) {
    assert.throws(
      () =>
        parseAttachmentTransportInput({
          ...prepareInput,
          metadata: { ...prepareInput.metadata, contentType },
        }),
      parseError("unsupported_content_type"),
      contentType,
    );
  }

  for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        parseAttachmentTransportInput({
          ...prepareInput,
          metadata: { ...prepareInput.metadata, sizeBytes },
        }),
      parseError("malformed_input"),
    );
  }
  assert.throws(
    () =>
      parseAttachmentTransportInput({
        ...prepareInput,
        metadata: {
          ...prepareInput.metadata,
          sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1,
        },
      }),
    parseError("oversized_attachment"),
  );
  assert.doesNotThrow(() =>
    parseAttachmentTransportInput({
      ...prepareInput,
      metadata: { fileName: "empty.txt", contentType: "text/plain", sizeBytes: 0 },
    }),
  );
});

test("finalization accepts no caller-supplied message, metadata, checksum, or proof", () => {
  for (const input of [
    { ...finalizeInput, messageId: "message-1" },
    { ...finalizeInput, metadata: { sizeBytes: 42, checksum } },
    { ...finalizeInput, checksum },
    { ...finalizeInput, proof: { descriptor: "opaque" } },
  ]) {
    assert.throws(
      () => parseAttachmentTransportInput(input, { now: fixtureNow }),
      parseError("malformed_input"),
    );
  }
});

test("spoofed ownership and trusted authorization context are rejected recursively", () => {
  for (const [field, value] of [
    ["tenant-id", "tenant-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["uploaderUserId", "uploader-spoof"],
    ["owner", { id: "user-spoof" }],
    ["sessionId", "session-spoof"],
    ["authorization", "Bearer spoof"],
    ["roles", ["admin"]],
    ["permissions", ["attachments:any"]],
  ]) {
    assert.throws(
      () =>
        parseAttachmentTransportInput({
          ...prepareInput,
          metadata: { ...prepareInput.metadata, nested: { [field]: value } },
        }),
      parseError("trusted_context_field"),
      field,
    );
  }
});

test("provider configuration, object keys, raw responses, credentials, and secret keys never cross the public boundary", () => {
  for (const [field, value] of [
    ["provider", "s3"],
    ["storage-key", "tenant/private/key"],
    ["objectKey", "private/key"],
    ["bucket", "private-bucket"],
    ["rawProviderResponse", { ok: true }],
    ["headers", { Authorization: "Bearer secret" }],
    ["credentials", { password: "secret" }],
    ["accessToken", "secret"],
    ["signature", "secret"],
  ]) {
    assert.throws(
      () =>
        parseAttachmentMutationResult(
          {
            ...prepareAppliedResult,
            upload: { ...prepareAppliedResult.upload, nested: { [field]: value } },
          },
          prepareInput,
          { now: fixtureNow },
        ),
      parseError("provider_field", "secret_field", "trusted_context_field"),
      field,
    );
  }
});

test("serialized opaque descriptors reject secret-bearing keys recursively", () => {
  for (const descriptor of [
    JSON.stringify({ accessToken: "secret" }),
    JSON.stringify({ nested: { signature: "secret" } }),
    JSON.stringify([{ providerResponse: { requestId: "internal" } }]),
  ]) {
    assert.throws(
      () =>
        parseAttachmentDownloadDescriptor(
          { ...downloadDescriptor, descriptor },
          { now: fixtureNow },
        ),
      parseError("secret_field", "provider_field"),
    );
  }
});

test("opaque descriptors require exact kinds and bounded future expiry", () => {
  assert.deepEqual(
    parseAttachmentDownloadDescriptor(roundTrip(downloadDescriptor), {
      now: fixtureNow,
    }),
    downloadDescriptor,
  );
  for (const [descriptor, code] of [
    [{ ...downloadDescriptor, expiresAt: fixtureNow }, "expired_descriptor"],
    [
      { ...downloadDescriptor, expiresAt: "2026-08-26T12:05:00.001Z" },
      "malformed_descriptor",
    ],
    [{ ...downloadDescriptor, expiresAt: "not-a-date" }, "malformed_descriptor"],
    [{ ...downloadDescriptor, kind: "opaque_attachment_upload" }, "malformed_descriptor"],
    [{ ...downloadDescriptor, unexpected: true }, "malformed_descriptor"],
  ]) {
    assert.throws(
      () => parseAttachmentDownloadDescriptor(descriptor, { now: fixtureNow }),
      parseError(code),
    );
  }
});

test("attachment lifecycle separates storage finalization from message claiming", () => {
  const statuses = [null, "pending", "finalized", "rejected", "attached", "abandoned"];
  const allowed = new Set([
    "null:pending",
    "pending:finalized",
    "pending:rejected",
    "pending:abandoned",
    "finalized:attached",
  ]);
  for (const from of statuses) {
    for (const to of statuses.slice(1)) {
      assert.equal(
        isAllowedAttachmentLifecycleTransition(from, to),
        allowed.has(`${from}:${to}`),
        `${from} -> ${to}`,
      );
    }
  }

  assert.deepEqual(
    validateAttachmentLifecycleTransition(null, pendingAttachment, prepareInput),
    pendingAttachment,
  );
  assert.deepEqual(
    validateAttachmentLifecycleTransition(
      pendingAttachment,
      finalizedAttachment,
      finalizeInput,
      "applied",
      { now: fixtureNow },
    ),
    finalizedAttachment,
  );
  assert.deepEqual(
    validateAttachmentLifecycleTransition(
      pendingAbortAttachment,
      abandonedAttachment,
      abortInput,
    ),
    abandonedAttachment,
  );
});

test("terminal state mutation, metadata mutation, and cross-claim transitions are illegal", () => {
  for (const [before, after, input] of [
    [attachedAttachment, abandonedAttachment, abortInput],
    [abandonedAttachment, finalizedAttachment, finalizeInput],
    [pendingAttachment, attachedAttachment, finalizeInput],
    [
      pendingAttachment,
      { ...finalizedAttachment, attachmentId: "attachment-other" },
      finalizeInput,
    ],
    [
      pendingAttachment,
      { ...finalizedAttachment, metadata: { ...finalizedAttachment.metadata, sizeBytes: 1 } },
      finalizeInput,
    ],
    [pendingAttachment, pendingAttachment, prepareInput],
  ]) {
    assert.throws(
      () =>
        validateAttachmentLifecycleTransition(before, after, input, "applied", {
          now: fixtureNow,
        }),
      parseError("invalid_transition"),
    );
  }
});

test("pending, finalized, attached, and abandoned serialized states are exact and coherent", () => {
  for (const state of [pendingAttachment, finalizedAttachment, attachedAttachment, abandonedAttachment]) {
    assert.deepEqual(parseAttachmentLifecycleState(roundTrip(state)), state);
  }
  for (const state of [
    { ...pendingAttachment, messageId: "message-1" },
    { ...finalizedAttachment, checksum: `sha256:${"G".repeat(64)}` },
    { ...attachedAttachment, checksum: `sha256:${"G".repeat(64)}` },
    { ...attachedAttachment, attachedAt: "2026-08-26T13:01:00.000Z" },
    { ...abandonedAttachment, abandonedAt: "2026-08-26T11:59:00.000Z" },
    { ...pendingAttachment, expiresAt: "2026-08-28T12:00:30.000Z" },
  ]) {
    assert.throws(
      () => parseAttachmentLifecycleState(state),
      parseError("malformed_state", "incoherent_state"),
    );
  }
});

test("applied and replayed mutation fixtures reconcile deterministically", () => {
  const cases = [
    [prepareInput, null, pendingAttachment, prepareAppliedResult, prepareReplayedResult],
    [finalizeInput, pendingAttachment, finalizedAttachment, finalizeAppliedResult, finalizeReplayedResult],
    [abortInput, pendingAbortAttachment, abandonedAttachment, abortAppliedResult, abortReplayedResult],
  ];
  for (const [input, before, terminal, applied, replayed] of cases) {
    assert.deepEqual(
      parseAttachmentMutationResult(roundTrip(applied), input, {
        now: fixtureNow,
        previousState: before,
      }),
      applied,
    );
    assert.deepEqual(
      parseAttachmentMutationResult(roundTrip(replayed), input, {
        now: fixtureNow,
        previousState: terminal,
        replayOf: applied,
      }),
      replayed,
    );
  }
});

test("finalize results reject claims, malformed outcomes, and replay drift", () => {
  for (const result of [
    { ...finalizeAppliedResult, attachmentId: "attachment-other" },
    { ...finalizeAppliedResult, messageId: "message-other" },
    {
      ...finalizeAppliedResult,
      attachment: { ...finalizedAttachment, attachmentId: "attachment-other" },
    },
    { ...finalizeAppliedResult, outcome: "attached" },
    { ...finalizeAppliedResult, idempotencyKey: "different-key" },
    { ...finalizeAppliedResult, reconciliationStatus: "already_attached" },
    { ...finalizeAppliedResult, proof: { descriptor: "opaque" } },
  ]) {
    assert.throws(
      () =>
        parseAttachmentMutationResult(result, finalizeInput, {
          now: fixtureNow,
          previousState: pendingAttachment,
        }),
      parseError("malformed_result", "incoherent_result", "invalid_transition"),
    );
  }

  assert.throws(
    () =>
      parseAttachmentMutationResult(finalizeReplayedResult, finalizeInput, {
        now: fixtureNow,
        previousState: finalizedAttachment,
        replayOf: {
          ...finalizeAppliedResult,
          attachment: { ...finalizedAttachment, checksum: `sha256:${"b".repeat(64)}` },
        },
      }),
    parseError("incoherent_result", "replay_mismatch"),
  );
});

test("authorized download results require the exact attached message claim", () => {
  assert.deepEqual(
    parseAttachmentTransportResult(roundTrip(downloadResult), downloadInput, {
      now: fixtureNow,
    }),
    downloadResult,
  );
  for (const result of [
    { ...downloadResult, attachmentId: "attachment-other" },
    { ...downloadResult, messageId: "message-other" },
    { ...downloadResult, attachment: pendingAttachment },
    {
      ...downloadResult,
      attachment: { ...attachedAttachment, messageId: "message-other" },
    },
  ]) {
    assert.throws(
      () =>
        parseGetAttachmentDownloadResult(result, downloadInput, {
          now: fixtureNow,
        }),
      parseError("incoherent_result"),
    );
  }
});

void checksum;
