import assert from "node:assert/strict";
import test from "node:test";

import {
  DraftMutationParseError,
  MAX_DRAFT_ATTACHMENT_REFERENCES,
  MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
  MAX_DRAFT_MENTION_REFERENCES,
  MAX_DRAFT_TEXT_UTF8_BYTES,
  parseClearDraftInput,
  parseConversationDraftUpdatedEvent,
  parseReplaceDraftInput,
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
} from "../dist/index.js";
import { parseKnownDurableEvent, DurableEventParseError } from "../dist/contracts/generated/durable-events.js";
import * as clientDraftContracts from "../dist/client/index.js";
import * as serverDraftContracts from "../dist/server/index.js";
import {
  canonicalUpdatedAt,
  clearDraftInput,
  draftUpdatedEvent,
  replaceDraftInput,
  settledDraftResult,
  staleDraftResult,
} from "./fixtures/draft-mutations.mjs";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const assertParseError = (code) => (error) =>
  error instanceof DraftMutationParseError && error.code === code;

test("replace and clear draft intents survive JSON round trips from every public entry point", () => {
  assert.deepEqual(parseReplaceDraftInput(roundTrip(replaceDraftInput)), replaceDraftInput);
  assert.deepEqual(parseClearDraftInput(roundTrip(clearDraftInput)), clearDraftInput);
  assert.deepEqual(parseSynchronizeDraftInput(roundTrip(replaceDraftInput)), replaceDraftInput);
  assert.deepEqual(parseSynchronizeDraftInput(roundTrip(clearDraftInput)), clearDraftInput);

  assert.equal(
    clientDraftContracts.parseSynchronizeDraftInput,
    parseSynchronizeDraftInput,
  );
  assert.equal(
    serverDraftContracts.parseSynchronizeDraftResult,
    parseSynchronizeDraftResult,
  );
  assert.equal(
    clientDraftContracts.parseConversationDraftUpdatedEvent,
    parseConversationDraftUpdatedEvent,
  );
  assert.equal(
    serverDraftContracts.parseConversationDraftUpdatedEvent,
    parseConversationDraftUpdatedEvent,
  );
});

test("drafts without mention references remain valid and omit the optional key", () => {
  const legacyInput = {
    ...replaceDraftInput,
    content: {
      format: replaceDraftInput.content.format,
      text: replaceDraftInput.content.text,
      attachments: replaceDraftInput.content.attachments,
    },
  };
  const parsed = parseReplaceDraftInput(roundTrip(legacyInput));
  assert.equal(Object.hasOwn(parsed.content, "mentions"), false);
  assert.deepEqual(parsed, legacyInput);
  assert.deepEqual(
    parseSynchronizeDraftResult(settledDraftResult(legacyInput), legacyInput),
    settledDraftResult(legacyInput),
  );
});

test("rejects ambiguous toggle state, missing intent fields, and unsupported content", () => {
  const { content: _content, ...replaceWithoutContent } = replaceDraftInput;
  const { deviceMutationId: _mutation, ...withoutDeviceMutationId } =
    replaceDraftInput;

  for (const invalid of [
    replaceWithoutContent,
    withoutDeviceMutationId,
    { ...replaceDraftInput, operation: "toggle_draft" },
    { ...replaceDraftInput, intent: "toggle" },
    { ...replaceDraftInput, toggle: true },
    { ...replaceDraftInput, clear: false },
    { ...clearDraftInput, content: replaceDraftInput.content },
    {
      ...replaceDraftInput,
      content: { ...replaceDraftInput.content, format: "html" },
    },
    {
      ...replaceDraftInput,
      content: { ...replaceDraftInput.content, blocks: [] },
    },
  ]) {
    assert.throws(
      () => parseSynchronizeDraftInput(invalid),
      assertParseError(invalid.content?.format === "html" || invalid.content?.blocks
        ? "malformed_content"
        : "malformed_input"),
    );
  }
});

test("enforces bounded UTF-8 text, identifiers, and unique attachment references", () => {
  const oversizedReferences = Array.from(
    { length: MAX_DRAFT_ATTACHMENT_REFERENCES + 1 },
    (_, index) => ({ attachmentId: `attachment-${index}` }),
  );

  const cases = [
    [
      { ...replaceDraftInput, content: { ...replaceDraftInput.content, text: "x".repeat(MAX_DRAFT_TEXT_UTF8_BYTES + 1) } },
      "malformed_content",
    ],
    [
      { ...replaceDraftInput, conversationId: "x".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES + 1) },
      "malformed_identifier",
    ],
    [
      { ...replaceDraftInput, deviceMutationId: "e\u0301" },
      "malformed_identifier",
    ],
    [
      {
        ...replaceDraftInput,
        deviceMutationId: "x".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES + 1),
      },
      "malformed_identifier",
    ],
    [
      {
        ...replaceDraftInput,
        idempotencyKey: "x".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES + 1),
      },
      "malformed_input",
    ],
    [
      { ...replaceDraftInput, content: { ...replaceDraftInput.content, attachments: oversizedReferences } },
      "malformed_content",
    ],
    [
      {
        ...replaceDraftInput,
        content: {
          ...replaceDraftInput.content,
          attachments: [
            { attachmentId: "attachment-1" },
            { attachmentId: "attachment-1" },
          ],
        },
      },
      "duplicate_attachment_reference",
    ],
    [
      { ...replaceDraftInput, content: { ...replaceDraftInput.content, attachments: [{ attachmentId: " attachment-1" }] } },
      "malformed_identifier",
    ],
    [
      { ...replaceDraftInput, content: { ...replaceDraftInput.content, attachments: [{ attachmentId: "attachment-1", url: "https://untrusted.test/file" }] } },
      "malformed_content",
    ],
  ];

  for (const [input, code] of cases) {
    assert.throws(
      () => parseSynchronizeDraftInput(input),
      assertParseError(code),
      code,
    );
  }

  assert.equal(
    parseReplaceDraftInput({
      ...replaceDraftInput,
      content: {
        ...replaceDraftInput.content,
        text: "x".repeat(MAX_DRAFT_TEXT_UTF8_BYTES),
      },
    }).content.text.length,
    MAX_DRAFT_TEXT_UTF8_BYTES,
  );
});

test("enforces exact, normalized, bounded, unique mention references", () => {
  const oversizedMentions = Array.from(
    { length: MAX_DRAFT_MENTION_REFERENCES + 1 },
    (_, index) => ({ type: "user", userId: `user-${index}` }),
  );
  const invalidMentions = [
    ["not-an-array", "malformed_content"],
    [[{ type: "team", teamId: "team-1" }], "malformed_content"],
    [[{ type: "user" }], "malformed_content"],
    [[{ type: "user", userId: "user-1", label: "User One" }], "malformed_content"],
    [[{ type: "user", userId: " user-1" }], "malformed_identifier"],
    [[{ type: "conversation", conversationId: "e\u0301" }], "malformed_identifier"],
    [[{ type: "entity", entity: { type: "invoice", id: "invoice-1", secret: true } }], "malformed_content"],
    [[{ type: "entity", entity: { type: " invoice", id: "invoice-1" } }], "malformed_identifier"],
    [[{ type: "entity", entity: { type: "invoice", id: "x".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES + 1) } }], "malformed_identifier"],
    [oversizedMentions, "malformed_content"],
    [[
      { type: "conversation", conversationId: "conversation-duplicate" },
      { type: "conversation", conversationId: "conversation-duplicate" },
    ], "duplicate_mention_reference"],
    [[
      { type: "entity", entity: { type: "invoice", id: "invoice-1" } },
      { type: "entity", entity: { type: "invoice", id: "invoice-1" } },
    ], "duplicate_mention_reference"],
  ];

  for (const [mentions, code] of invalidMentions) {
    assert.throws(
      () => parseReplaceDraftInput({
        ...replaceDraftInput,
        content: { ...replaceDraftInput.content, mentions },
      }),
      assertParseError(code),
      code,
    );
  }
});

test("rejects negative, fractional, and non-advanceable base revisions", () => {
  for (const baseRevision of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => parseSynchronizeDraftInput({ ...replaceDraftInput, baseRevision }),
      assertParseError("malformed_revision"),
    );
  }

  assert.equal(
    parseSynchronizeDraftInput({ ...replaceDraftInput, baseRevision: 0 })
      .baseRevision,
    0,
  );
});

test("rejects unsafe control characters and malformed Unicode", () => {
  for (const text of ["unsafe\u0000text", "unsafe\u001ftext", "lone-\ud800-surrogate"]) {
    assert.throws(
      () =>
        parseReplaceDraftInput({
          ...replaceDraftInput,
          content: { ...replaceDraftInput.content, text },
        }),
      assertParseError("unsafe_content"),
    );
  }

  assert.equal(
    parseReplaceDraftInput({
      ...replaceDraftInput,
      content: { ...replaceDraftInput.content, text: "line one\nline two\t✓" },
    }).content.text,
    "line one\nline two\t✓",
  );
});

test("rejects normalized client-authored trusted identity and authorization fields", () => {
  const spoofedFields = [
    ["tenant-id", "tenant-spoof"],
    ["organization.id", "organization-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["current user", { id: "user-spoof" }],
    ["session-id", "session-spoof"],
    ["authorization", "Bearer spoof"],
    ["roles", ["admin"]],
    ["capabilities", ["chat.draft.write"]],
    ["permissions", ["draft:any"]],
  ];

  for (const input of [replaceDraftInput, clearDraftInput]) {
    for (const [field, value] of spoofedFields) {
      assert.throws(
        () => parseSynchronizeDraftInput({ ...input, [field]: value }),
        assertParseError("trusted_identity_field"),
        field,
      );
    }
  }
});

test("parses applied replace and clear results with canonical revision and tombstone state", () => {
  const replaceResult = settledDraftResult(replaceDraftInput);
  const clearResult = settledDraftResult(clearDraftInput);

  assert.deepEqual(
    parseSynchronizeDraftResult(roundTrip(replaceResult), replaceDraftInput),
    replaceResult,
  );
  assert.deepEqual(
    parseSynchronizeDraftResult(roundTrip(clearResult), clearDraftInput),
    clearResult,
  );
});

test("a stale base deterministically returns the current canonical state", () => {
  const currentState = {
    kind: "replaced",
    content: { format: "plain", text: "Saved by another tab", attachments: [] },
  };
  const conflict = staleDraftResult(clearDraftInput, 11, currentState);
  const first = parseSynchronizeDraftResult(roundTrip(conflict), clearDraftInput);
  const second = parseSynchronizeDraftResult(roundTrip(conflict), clearDraftInput);

  assert.equal(first.reconciliationStatus, "stale_base");
  assert.equal(first.canonicalRevision, 11);
  assert.deepEqual(first.draft, currentState);
  assert.deepEqual(second, first);
});

test("an exact retry preserves the canonical revision, timestamp, and content", () => {
  const applied = parseSynchronizeDraftResult(
    settledDraftResult(replaceDraftInput, "applied"),
    replaceDraftInput,
  );
  const replayedWireResult = {
    ...settledDraftResult(replaceDraftInput, "replayed"),
    canonicalRevision: applied.canonicalRevision,
    canonicalUpdatedAt: applied.canonicalUpdatedAt,
    draft: applied.draft,
  };
  const replayed = parseSynchronizeDraftResult(
    roundTrip(replayedWireResult),
    replaceDraftInput,
  );

  assert.equal(replayed.reconciliationStatus, "replayed");
  assert.equal(replayed.canonicalRevision, applied.canonicalRevision);
  assert.equal(replayed.canonicalUpdatedAt, canonicalUpdatedAt);
  assert.deepEqual(replayed.draft, applied.draft);
  assert.deepEqual(
    parseSynchronizeDraftResult(roundTrip(replayedWireResult), replaceDraftInput),
    replayed,
  );
});

test("parses the existing server's private draft-updated envelope", () => {
  const replaceEvent = draftUpdatedEvent(replaceDraftInput);
  const clearEvent = draftUpdatedEvent(
    clearDraftInput,
    settledDraftResult(clearDraftInput),
  );
  assert.deepEqual(
    parseConversationDraftUpdatedEvent(roundTrip(replaceEvent), "tenant-1"),
    replaceEvent,
  );
  assert.deepEqual(
    parseConversationDraftUpdatedEvent(roundTrip(clearEvent), "tenant-1"),
    clearEvent,
  );
});

test("rejects malformed or non-private draft-updated envelopes", () => {
  const event = draftUpdatedEvent(replaceDraftInput);
  for (const invalid of [
    { ...event, streamId: "conversation:conversation-1" },
    { ...event, tenantId: "tenant-other" },
    { ...event, type: "message.updated" },
    { ...event, sessionId: "session-spoof" },
    {
      ...event,
      payload: { ...event.payload, actorUserId: "user-other" },
    },
    {
      ...event,
      payload: {
        ...event.payload,
        input: { ...event.payload.input, actorUserId: "user-spoof" },
      },
    },
    {
      ...event,
      payload: {
        ...event.payload,
        result: { ...event.payload.result, idempotencyKey: "different" },
      },
    },
  ]) {
    assert.throws(
      () => parseConversationDraftUpdatedEvent(invalid, "tenant-1"),
      DraftMutationParseError,
    );
  }
});

test("rejects malformed and request-incoherent canonical results", () => {
  const valid = settledDraftResult(replaceDraftInput);
  const { mentions: _mentions, ...contentWithoutMentions } =
    replaceDraftInput.content;
  const malformed = [
    [{ ...valid, conversationId: "conversation-other" }, "incoherent_result"],
    [{ ...valid, baseRevision: 3 }, "incoherent_result"],
    [{ ...valid, deviceMutationId: "other-device-mutation" }, "incoherent_result"],
    [{ ...valid, idempotencyKey: "other-key" }, "incoherent_result"],
    [{ ...valid, canonicalRevision: replaceDraftInput.baseRevision }, "incoherent_result"],
    [{ ...valid, canonicalUpdatedAt: "not-a-timestamp" }, "malformed_result"],
    [{ ...valid, draft: { kind: "clear_tombstone", content: null } }, "incoherent_result"],
    [{ ...valid, draft: { kind: "replaced", content: { ...replaceDraftInput.content, text: "changed" } } }, "incoherent_result"],
    [{ ...valid, draft: { kind: "replaced", content: { ...replaceDraftInput.content, mentions: [] } } }, "incoherent_result"],
    [{ ...valid, draft: { kind: "replaced", content: contentWithoutMentions } }, "incoherent_result"],
    [{ ...valid, serverTime: canonicalUpdatedAt }, "malformed_result"],
    [{ ...valid, draft: { kind: "clear_tombstone", content: replaceDraftInput.content } }, "malformed_result"],
    [staleDraftResult(replaceDraftInput, replaceDraftInput.baseRevision, valid.draft), "incoherent_result"],
  ];

  for (const [result, code] of malformed) {
    assert.throws(
      () => parseSynchronizeDraftResult(result, replaceDraftInput),
      assertParseError(code),
      code,
    );
  }
});

const replyInput = (replyTo) => ({
  ...replaceDraftInput,
  content: { ...replaceDraftInput.content, replyTo },
});
const trustedDraftIdentity = { tenantId: "tenant-1", userId: "user-1" };
const assertDraftEvent = (input, result) => {
  const event = draftUpdatedEvent(input, result);
  assert.deepEqual(parseConversationDraftUpdatedEvent(roundTrip(event), "tenant-1"), event);
  assert.deepEqual(parseKnownDurableEvent(roundTrip(event), trustedDraftIdentity), event);
};

test("reply metadata round-trips replacement, replay, conflicts and both event parsers", () => {
  for (const notifyAuthor of [false, true]) {
    const input = replyInput({ messageId: "é".repeat(127) + "x", notifyAuthor });
    assert.deepEqual(parseReplaceDraftInput(roundTrip(input)), input);
    for (const status of ["applied", "replayed"]) {
      const result = settledDraftResult(input, status);
      assert.deepEqual(parseSynchronizeDraftResult(roundTrip(result), input), result);
      assertDraftEvent(input, result);
    }
    const conflict = staleDraftResult(input, 11, {
      kind: "replaced", content: replyInput({ messageId: "other-source", notifyAuthor: !notifyAuthor }).content,
    });
    assert.deepEqual(parseSynchronizeDraftResult(roundTrip(conflict), input), conflict);
    assertDraftEvent(input, conflict);
    assertDraftEvent(clearDraftInput, staleDraftResult(clearDraftInput, 11, settledDraftResult(input).draft));
    assertDraftEvent(input, staleDraftResult(input, 11, { kind: "clear_tombstone", content: null }));
  }
});

test("settled replies must match presence, target and ping choice", () => {
  const input = replyInput({ messageId: "source", notifyAuthor: false });
  for (const status of ["applied", "replayed"]) {
    for (const content of [
      replaceDraftInput.content,
      replyInput({ messageId: "other", notifyAuthor: false }).content,
      replyInput({ messageId: "source", notifyAuthor: true }).content,
    ]) {
      const result = { ...settledDraftResult(input, status), draft: { kind: "replaced", content } };
      assert.throws(() => parseSynchronizeDraftResult(result, input), assertParseError("incoherent_result"));
      assert.throws(() => parseConversationDraftUpdatedEvent(draftUpdatedEvent(input, result), "tenant-1"), DraftMutationParseError);
      assert.throws(() => parseKnownDurableEvent(draftUpdatedEvent(input, result), trustedDraftIdentity), DurableEventParseError);
    }
    assert.throws(() => parseSynchronizeDraftResult(settledDraftResult(input, status), replaceDraftInput), assertParseError("incoherent_result"));
  }
});

test("reply references reject malformed shapes, identifiers and attribution with draft errors", () => {
  const malformedIds = ["", " source", "source ", "e\u0301", "a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u2028b", "a\u2029b", "\ud800", "\udc00", "x".repeat(256), "é".repeat(128), 1, null];
  const cases = [
    ...[null, undefined, [], "source", {}, { messageId: "source" }, { notifyAuthor: false },
      ...[null, 0, "false"].map((notifyAuthor) => ({ messageId: "source", notifyAuthor })),
      ...["sourceMessageId", "originalAuthor", "originalCreatedAt", "displayName", "sourceDisplay", "source", "content", "extra"].map((key) => ({ messageId: "source", notifyAuthor: false, [key]: "forbidden" })),
    ].map((value) => [value, "malformed_content"]),
    ...malformedIds.map((messageId) => [{ messageId, notifyAuthor: false }, "malformed_identifier"]),
  ];
  for (const [replyTo, code] of cases) {
    const invalidInput = replyInput(replyTo);
    assert.throws(() => parseReplaceDraftInput(invalidInput), assertParseError(code));
    const result = { ...settledDraftResult(replaceDraftInput), draft: { kind: "replaced", content: invalidInput.content } };
    assert.throws(() => parseSynchronizeDraftResult(result, replaceDraftInput), assertParseError(code === "malformed_content" ? "malformed_result" : code));
    for (const event of [draftUpdatedEvent(invalidInput), draftUpdatedEvent(replaceDraftInput, result), draftUpdatedEvent(replaceDraftInput, { ...result, reconciliationStatus: "stale_base" })]) {
      assert.throws(() => parseConversationDraftUpdatedEvent(event, "tenant-1"), DraftMutationParseError);
      assert.throws(() => parseKnownDurableEvent(event, trustedDraftIdentity), (error) => error instanceof DurableEventParseError && error.code === "incoherent_payload");
    }
  }
});
