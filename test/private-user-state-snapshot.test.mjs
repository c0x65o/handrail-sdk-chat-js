import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
  MAX_DRAFT_MENTION_REFERENCES,
  MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT,
  PrivateUserStateSnapshotParseError,
  decodeSavedMessageSnapshotCursor,
  encodeSavedMessageSnapshotCursor,
  parseConversationDraftSnapshot,
  parseConversationDraftSnapshotInput,
  parseSavedMessageListSnapshot,
  parseSavedMessageListSnapshotInput,
} from "../dist/index.js";
import * as clientContracts from "../dist/client/index.js";
import * as serverContracts from "../dist/server/index.js";
import {
  absentDraftSnapshot,
  draftSnapshotInput,
  presentDraftSnapshot,
  replyDraftSnapshots,
  replySavedMessagePages,
  savedMessageFirstPage,
  savedMessageFirstPageInput,
  savedMessageSecondPageInput,
  savedMessageTerminalPage,
} from "./fixtures/private-user-state-snapshots.mjs";

const jsonRoundTrip = (value) => JSON.parse(JSON.stringify(value));

test("round-trips present and absent actor-private conversation drafts", () => {
  const present = parseConversationDraftSnapshot(
    jsonRoundTrip(presentDraftSnapshot),
    draftSnapshotInput,
  );
  const absent = parseConversationDraftSnapshot(
    jsonRoundTrip(absentDraftSnapshot),
    draftSnapshotInput,
  );

  assert.deepEqual(present, presentDraftSnapshot);
  assert.equal(Object.hasOwn(present.content.value, "replyTo"), false);
  assert.equal(present.privacy, ACTOR_PRIVATE_USER_STATE_PRIVACY);
  assert.equal(
    present.content.privacy,
    ACTOR_PRIVATE_USER_STATE_PRIVACY,
  );
  assert.deepEqual(
    present.content.value.mentions,
    [
      { type: "user", userId: "user-reviewer" },
      { type: "conversation", conversationId: "conversation-reviews" },
      { type: "entity", entity: { type: "invoice", id: "invoice-42" } },
    ],
  );
  assert.deepEqual(
    present.content.value.attachments,
    [{ attachmentId: "attachment-draft-1" }, { attachmentId: "attachment-draft-2" }],
  );
  assert.deepEqual(absent, absentDraftSnapshot);
  assert.equal(absent.content, null);

  const neverCreated = {
    ...absentDraftSnapshot,
    canonicalRevision: 0,
    canonicalUpdatedAt: null,
  };
  assert.deepEqual(
    parseConversationDraftSnapshot(neverCreated, draftSnapshotInput),
    neverCreated,
  );

  const { mentions: _mentions, ...legacyValue } =
    presentDraftSnapshot.content.value;
  const legacySnapshot = {
    ...presentDraftSnapshot,
    content: { ...presentDraftSnapshot.content, value: legacyValue },
  };
  const parsedLegacy = parseConversationDraftSnapshot(
    jsonRoundTrip(legacySnapshot),
    draftSnapshotInput,
  );
  assert.deepEqual(parsedLegacy, legacySnapshot);
  assert.equal(Object.hasOwn(parsedLegacy.content.value, "mentions"), false);
  assert.equal(Object.hasOwn(parsedLegacy.content.value, "replyTo"), false);
});

test("round-trips reply targets and both ping choices, then recovers a cleared draft", () => {
  for (const snapshot of replyDraftSnapshots) {
    const parsed = parseConversationDraftSnapshot(jsonRoundTrip(snapshot), draftSnapshotInput);
    assert.deepEqual(parsed, snapshot);
    assert.notEqual(parsed.content.value.replyTo, snapshot.content.value.replyTo);
    assert.deepEqual(
      parseConversationDraftSnapshot(jsonRoundTrip(absentDraftSnapshot), draftSnapshotInput),
      absentDraftSnapshot,
    );
    assert.throws(
      () => parseConversationDraftSnapshot(
        { ...absentDraftSnapshot, content: snapshot.content }, draftSnapshotInput,
      ),
      hasCode("malformed_snapshot"),
    );
  }
});

test("rejects malformed reply targets and ping choices with snapshot errors", () => {
  const valid = replyDraftSnapshots[0].content.value.replyTo;
  const invalidReplies = [
    null, undefined, [], "message-launch-date", {},
    { messageId: valid.messageId },
    { notifyAuthor: true },
    ...[null, undefined, "false", 0, 1, {}, []].map((notifyAuthor) => ({ ...valid, notifyAuthor })),
    ...[
      null, undefined, 42, "", " ", " leading", "trailing ", "e\u0301",
      "unsafe\u0000id", "unsafe\nid", "unsafe\tid", "unsafe\u007fid",
      "unsafe\u0085id", "unsafe\u2028id", "unsafe\u2029id", "unsafe\ud800id",
      "x".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES + 1),
      "é".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES / 2 + 1),
    ].map((messageId) => ({ ...valid, messageId })),
    ...["conversationId", "tenantId", "actorUserId", "author", "text", "extra"].map(
      (key) => ({ ...valid, [key]: "unexpected" }),
    ),
  ];
  for (const replyTo of invalidReplies) {
    assert.throws(
      () => parseConversationDraftSnapshot({
        ...presentDraftSnapshot,
        content: {
          ...presentDraftSnapshot.content,
          value: { ...presentDraftSnapshot.content.value, replyTo },
        },
      }, draftSnapshotInput),
      (error) => hasCode("malformed_snapshot")(error) &&
        error.message.includes("snapshot.content.value.replyTo"),
    );
  }
});

test("reply drafts preserve actor-private wrappers and the requested conversation boundary", () => {
  const snapshot = replyDraftSnapshots[0];
  for (const invalid of [
    { ...snapshot, privacy: "public" },
    { ...snapshot, content: { ...snapshot.content, privacy: "public" } },
  ]) {
    assert.throws(
      () => parseConversationDraftSnapshot(invalid, draftSnapshotInput),
      hasCode("unsafe_private_data"),
    );
  }
  for (const invalid of [
    { ...snapshot, content: snapshot.content.value },
    { ...snapshot, actorUserId: "other-user" },
    { ...snapshot, content: { ...snapshot.content, tenantId: "other-tenant" } },
  ]) {
    assert.throws(
      () => parseConversationDraftSnapshot(invalid, draftSnapshotInput),
      hasCode("malformed_snapshot"),
    );
  }
  assert.throws(
    () => parseConversationDraftSnapshot(snapshot, { conversationId: "other-conversation" }),
    hasCode("incoherent_snapshot"),
  );
  for (const key of ["actorUserId", "tenantId", "otherUserId", "roles"]) {
    assert.throws(
      () => parseConversationDraftSnapshot(snapshot, { ...draftSnapshotInput, [key]: "spoof" }),
      hasCode("trusted_identity_field"),
    );
  }
});

test("rejects malformed, non-normalized, over-limit, and duplicate draft mentions", () => {
  const oversized = Array.from(
    { length: MAX_DRAFT_MENTION_REFERENCES + 1 },
    (_, index) => ({ type: "user", userId: `user-${index}` }),
  );
  const invalidMentions = [
    {},
    [{ type: "user" }],
    [{ type: "user", userId: "user-1", displayName: "User One" }],
    [{ type: "conversation", conversationId: "e\u0301" }],
    [{ type: "entity", entity: { type: " invoice", id: "invoice-1" } }],
    [{
      type: "entity",
      entity: {
        type: "invoice",
        id: "x".repeat(MAX_DRAFT_IDENTIFIER_UTF8_BYTES + 1),
      },
    }],
    oversized,
    [
      { type: "user", userId: "user-duplicate" },
      { type: "user", userId: "user-duplicate" },
    ],
    [
      { type: "entity", entity: { type: "invoice", id: "invoice-1" } },
      { type: "entity", entity: { type: "invoice", id: "invoice-1" } },
    ],
  ];

  for (const mentions of invalidMentions) {
    assert.throws(
      () => parseConversationDraftSnapshot(
        {
          ...presentDraftSnapshot,
          content: {
            ...presentDraftSnapshot.content,
            value: { ...presentDraftSnapshot.content.value, mentions },
          },
        },
        draftSnapshotInput,
      ),
      hasCode("malformed_snapshot"),
    );
  }
});

test("rejects incoherent draft revisions, unsafe content, and attachment metadata", () => {
  assert.throws(
    () =>
      parseConversationDraftSnapshot(
        { ...presentDraftSnapshot, canonicalRevision: 0 },
        draftSnapshotInput,
      ),
    hasCode("incoherent_snapshot"),
  );
  assert.throws(
    () =>
      parseConversationDraftSnapshot(
        {
          ...absentDraftSnapshot,
          canonicalRevision: 0,
          canonicalUpdatedAt: absentDraftSnapshot.canonicalUpdatedAt,
        },
        draftSnapshotInput,
      ),
    hasCode("incoherent_snapshot"),
  );
  assert.throws(
    () =>
      parseConversationDraftSnapshot(
        {
          ...presentDraftSnapshot,
          content: {
            ...presentDraftSnapshot.content,
            value: {
              ...presentDraftSnapshot.content.value,
              text: "unsafe\u0000draft",
            },
          },
        },
        draftSnapshotInput,
      ),
    hasCode("malformed_snapshot"),
  );
  assert.throws(
    () =>
      parseConversationDraftSnapshot(
        {
          ...presentDraftSnapshot,
          content: {
            ...presentDraftSnapshot.content,
            value: {
              ...presentDraftSnapshot.content.value,
              attachmentMetadata: [{ fileName: "secret.txt" }],
            },
          },
        },
        draftSnapshotInput,
      ),
    hasCode("malformed_snapshot"),
  );
});

test("round-trips visible, deleted, and inaccessible saved entries across pages", () => {
  const first = parseSavedMessageListSnapshot(
    jsonRoundTrip(savedMessageFirstPage),
    savedMessageFirstPageInput,
  );
  const terminal = parseSavedMessageListSnapshot(
    jsonRoundTrip(savedMessageTerminalPage),
    savedMessageSecondPageInput,
  );

  assert.deepEqual(first, savedMessageFirstPage);
  assert.equal(
    first.items[0].privateNote.privacy,
    ACTOR_PRIVATE_USER_STATE_PRIVACY,
  );
  assert.equal(first.items[0].message.availability, "available");
  assert.equal(first.items[1].message.reason, "deleted");
  assert.deepEqual(terminal, savedMessageTerminalPage);
  assert.equal(terminal.items[0].message.reason, "inaccessible");
  assert.equal(terminal.page.nextCursor, null);
});

test("unavailable tombstones cannot contain stale content, metadata, author, or private data", () => {
  for (const entry of [
    savedMessageFirstPage.items[1],
    savedMessageTerminalPage.items[0],
  ]) {
    assert.deepEqual(Object.keys(entry.message).sort(), [
      "availability",
      "reason",
    ]);
    assert.equal("content" in entry.message, false);
    assert.equal("attachmentMetadata" in entry.message, false);
    assert.equal("author" in entry.message, false);
    assert.equal("privateData" in entry.message, false);

    for (const leakedField of [
      ["current", savedMessageFirstPage.items[0].message.current],
      ["replyTo", { messageId: "message-source", notifyAuthor: false }],
      ["content", { format: "plain", text: "stale body" }],
      ["attachmentMetadata", [{ fileName: "stale.pdf" }]],
      ["author", { type: "user", userId: "user-stale" }],
      ["privateData", { secret: "stale" }],
    ]) {
      const [key, leakedValue] = leakedField;
      const leaked = {
        ...entry,
        message: { ...entry.message, [key]: leakedValue },
      };
      const page = {
        kind: "saved_message_list",
        privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
        items: [leaked],
        page: { nextCursor: null },
      };
      assert.throws(
        () => parseSavedMessageListSnapshot(page, { limit: 1 }),
        hasCode("malformed_snapshot"),
      );
    }
  }
});

test("uses deterministic versioned cursors and rejects malformed versions", () => {
  const position = {
    savedAt: "2026-08-26T12:20:00.000Z",
    messageId: "message-deleted",
  };
  const cursor = encodeSavedMessageSnapshotCursor(position);
  assert.equal(cursor, encodeSavedMessageSnapshotCursor(position));
  assert.deepEqual(decodeSavedMessageSnapshotCursor(cursor), position);
  assert.match(cursor, /^handrail-saved-messages\.v1\./);

  for (const malformed of [
    "",
    "not-a-cursor",
    "handrail-saved-messages.v1.%",
    `handrail-saved-messages.v1.${encodeURIComponent(JSON.stringify([position.savedAt]))}`,
    `handrail-saved-messages.v1.${encodeURIComponent(JSON.stringify(["yesterday", position.messageId]))}`,
  ]) {
    assert.throws(
      () => decodeSavedMessageSnapshotCursor(malformed),
      hasCode("malformed_cursor"),
    );
  }
  assert.throws(
    () =>
      decodeSavedMessageSnapshotCursor(
        `handrail-saved-messages.v2.${encodeURIComponent(JSON.stringify([position.savedAt, position.messageId]))}`,
      ),
    hasCode("unsupported_cursor"),
  );
});

test("enforces page limits, exclusive cursor coherence, stable ordering, and terminal pages", () => {
  for (const limit of [0, MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT + 1, 1.5]) {
    assert.throws(
      () => parseSavedMessageListSnapshotInput({ limit }),
      hasCode("malformed_input"),
    );
  }
  assert.throws(
    () =>
      parseSavedMessageListSnapshot(
        {
          ...savedMessageFirstPage,
          items: [...savedMessageFirstPage.items].reverse(),
          page: { nextCursor: savedMessageFirstPage.page.nextCursor },
        },
        savedMessageFirstPageInput,
      ),
    hasCode("incoherent_snapshot"),
  );
  assert.throws(
    () =>
      parseSavedMessageListSnapshot(
        savedMessageFirstPage,
        { ...savedMessageFirstPageInput, limit: 1 },
      ),
    hasCode("incoherent_snapshot"),
  );
  assert.throws(
    () =>
      parseSavedMessageListSnapshot(
        {
          ...savedMessageTerminalPage,
          page: { nextCursor: savedMessageFirstPage.page.nextCursor },
        },
        savedMessageSecondPageInput,
      ),
    hasCode("incoherent_snapshot"),
  );
});

test("rejects exact-key violations and nested actor, tenant, other-user, and authorization spoofing", () => {
  const draftSpoofs = [
    { conversationId: "conversation-1", tenantId: "tenant-spoof" },
    { conversationId: "conversation-1", actor: { userId: "user-spoof" } },
    { conversationId: "conversation-1", filters: { otherUserId: "user-other" } },
    { conversationId: "conversation-1", nested: { roles: ["admin"] } },
  ];
  for (const input of draftSpoofs) {
    assert.throws(
      () => parseConversationDraftSnapshotInput(input),
      hasCode("trusted_identity_field"),
    );
  }

  const savedSpoofs = [
    { limit: 20, currentUserId: "user-spoof" },
    { limit: 20, filters: { user: { id: "user-spoof" } } },
    { limit: 20, filters: { arbitrary_user_id: "user-other" } },
    { limit: 20, request: { sessionId: "session-spoof" } },
    { limit: 20, request: { permissions: ["saved:any"] } },
  ];
  for (const input of savedSpoofs) {
    assert.throws(
      () => parseSavedMessageListSnapshotInput(input),
      hasCode("trusted_identity_field"),
    );
  }

  assert.throws(
    () => parseSavedMessageListSnapshotInput({ limit: 20, filter: "mine" }),
    hasCode("malformed_input"),
  );
});

test("exports identical browser-safe codecs from root, client, and server surfaces", () => {
  assert.equal(
    clientContracts.parseConversationDraftSnapshot,
    parseConversationDraftSnapshot,
  );
  assert.equal(
    serverContracts.parseSavedMessageListSnapshot,
    parseSavedMessageListSnapshot,
  );
  assert.equal(
    clientContracts.encodeSavedMessageSnapshotCursor,
    encodeSavedMessageSnapshotCursor,
  );
});

function hasCode(code) {
  return (error) =>
    error instanceof PrivateUserStateSnapshotParseError && error.code === code;
}


test("saved reply projections preserve both choices and leave legacy references absent", () => {
  for (const page of [savedMessageFirstPage, ...replySavedMessagePages]) {
    const parsed = parseSavedMessageListSnapshot(jsonRoundTrip(page), savedMessageFirstPageInput);
    assert.deepEqual(jsonRoundTrip(parsed), page);
    assert.deepEqual(parsed.items[0].privateNote, savedMessageFirstPage.items[0].privateNote);
    assert.deepEqual(parsed.items[0].message.current.content, savedMessageFirstPage.items[0].message.current.content);
    assert.equal(Object.hasOwn(parsed.items[0].message.current, "replyTo"), page !== savedMessageFirstPage);
  }
});

test("saved references use canonical identity validation without draft normalization", () => {
  for (const messageId of ["x".repeat(255), "é".repeat(127) + "x", "e\u0301", "message-source"]) {
    const page = jsonRoundTrip(replySavedMessagePages[0]);
    page.items[0].message.current.replyTo.messageId = messageId;
    assert.deepEqual(parseSavedMessageListSnapshot(page, savedMessageFirstPageInput), page);
  }
});

test("saved projections reject malformed references, source copies, and destination overrides", () => {
  const reference = { messageId: "message-source", notifyAuthor: false };
  const invalid = [null, undefined, [], "message-source", {},
    { messageId: "message-source" }, { notifyAuthor: false },
    ...[null, 0, "false"].map((notifyAuthor) => ({ ...reference, notifyAuthor })),
    ...[null, 1, "", " x", "x ", "x\n", "x\u0085", "x\u2028", "x\u2029", "x".repeat(256), "é".repeat(128)]
      .map((messageId) => ({ ...reference, messageId })),
    ...["unknown", "conversationId", "tenantId", "actor", "actorId", "userId", "author", "sourceMessageId", "originalAuthor", "content", "source", "forwarded"]
      .map((key) => ({ ...reference, [key]: "forbidden" })),
  ];
  for (const replyTo of invalid) {
    const page = jsonRoundTrip(savedMessageFirstPage);
    page.items[0].message.current.replyTo = replyTo;
    assert.throws(() => parseSavedMessageListSnapshot(page, savedMessageFirstPageInput), hasCode("malformed_snapshot"));
  }
  const mismatch = jsonRoundTrip(replySavedMessagePages[0]);
  mismatch.items[0].message.current.id = "message-other";
  assert.throws(() => parseSavedMessageListSnapshot(mismatch, savedMessageFirstPageInput), hasCode("incoherent_snapshot"));
});
