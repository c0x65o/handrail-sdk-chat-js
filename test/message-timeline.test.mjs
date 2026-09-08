import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Bundle only the tested entry points from fresh source, independent of dist.
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(repositoryRoot, ".message-timeline-test-"));
let runtime;
try {
  const outfile = join(temporaryRoot, "timeline.mjs");
  await build({
    stdin: {
      contents: `export * from "./src/contracts/message-timeline.ts";
        export { DefaultAttachmentRenderer, DefaultMessageTimelineEmptyState } from "./src/ui/message-timeline.ts";`,
      resolveDir: repositoryRoot,
      loader: "ts",
    },
    outfile, bundle: true, packages: "external", format: "esm", platform: "node", target: "node22",
  });
  runtime = await import(pathToFileURL(outfile).href);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
const {
  MessageTimelineContractError,
  createMessageTimelinePage,
  DefaultAttachmentRenderer,
  DefaultMessageTimelineEmptyState,
} = runtime;

const conversationId = "conversation-parent";
const threadConversationId = "conversation-thread";
const replay = { resumeFrom: { eventId: "event-snapshot-42" } };

function message(sequence, overrides = {}) {
  return {
    id: `message-${sequence}`,
    tenantId: "tenant-1",
    conversationId,
    author: { type: "user", userId: "user-1" },
    sequence,
    createdAt: `2026-08-25T20:00:${String(sequence).padStart(2, "0")}.000Z`,
    updatedAt: `2026-08-25T20:00:${String(sequence).padStart(2, "0")}.000Z`,
    revision: { revision: 1 },
    content: { format: "plain", text: `message ${sequence}` },
    isThreadRoot: false,
    reactions: [],
    attachmentMetadata: [],
    ...overrides,
  };
}

function input(messages, pagination = {}) {
  return {
    messages,
    pagination: {
      older: { available: false },
      newer: { available: false },
      ...pagination,
    },
    replay,
  };
}

test("retains optional replies on active and deleted messages in their conversation", () => {
  for (const destination of [conversationId, threadConversationId]) {
    for (const deleted of [false, true]) {
      for (const notifyAuthor of [false, true]) {
        for (const messageId of ["source-1", "source with spaces", "a".repeat(255), "é".repeat(127) + "a", "😀".repeat(63) + "abc"]) {
          const replyTo = { messageId, notifyAuthor };
          const shell = deleted ? { content: null, deletedAt: "2026-08-25T20:04:00.000Z", deletedByUserId: "user-moderator" } : {};
          const original = message(2, { conversationId: destination, ...shell, replyTo });
          const legacy = message(1, { conversationId: destination, ...shell });
          const page = createMessageTimelinePage(
            { conversationId: destination, direction: "backward", cursor: 3, limit: 2 },
            input([original, legacy], { older: { available: true, cursor: 1 } }),
          );
          assert.deepEqual(page.messages, [legacy, original]);
          assert.deepEqual(JSON.parse(JSON.stringify(page)).messages[1].replyTo, replyTo);
          assert.equal(Object.hasOwn(page.messages[0], "replyTo"), false);
          assert.equal(page.messages[1].isThreadRoot, false);
          assert.equal(Object.hasOwn(page.messages[1], "threadSummary"), false);
          assert.equal(Object.hasOwn(page.messages[1].content ?? {}, "forwarded"), false);
          assert.equal(page.conversationId, destination);
        }
      }
    }
  }
});

test("rejects malformed reply references on active and deleted messages", () => {
  const valid = { messageId: "source-1", notifyAuthor: false };
  const malformed = [
    null, undefined, false, 1, "source-1", [], [valid], {},
    { messageId: "source-1" }, { notifyAuthor: true },
    ...[null, false, 1, {}, [], "", " ", " source", "source ", "source\n", "a\u0000b", "a\u001fb", "a\u007fb", "a\u0085b", "a\u009fb", "a\u2028b", "a\u2029b", "a".repeat(256), "é".repeat(128), "😀".repeat(64)]
      .map((messageId) => ({ ...valid, messageId })),
    ...[null, undefined, 0, 1, "true", "false", {}, []]
      .map((notifyAuthor) => ({ ...valid, notifyAuthor })),
    ...["tenantId", "conversationId", "actor", "actorId", "userId", "author", "authorId", "sourceMessageId", "originalAuthor", "originalCreatedAt", "displayName", "sourceDisplay", "source", "content", "forward", "forwarded", "snapshot", "threadSummary", "isThreadRoot", "unexpected"]
      .map((field) => ({ ...valid, [field]: "injected" })),
  ];
  for (const deleted of [false, true]) {
    for (const replyTo of malformed) {
      assert.throws(
        () => createMessageTimelinePage(
          { conversationId, direction: "forward", limit: 1 },
          input([message(1, {
            ...(deleted ? { content: null, deletedAt: "2026-08-25T20:04:00.000Z", deletedByUserId: "user-moderator" } : {}),
            replyTo,
          })]),
        ),
        (error) => error instanceof MessageTimelineContractError && error.code === "invalid_message",
        `accepted malformed reply: ${JSON.stringify(replyTo)}`,
      );
    }
  }
});

test("applies an exclusive backward cursor and returns ascending order", () => {
  const page = createMessageTimelinePage(
    { conversationId, direction: "backward", cursor: 10, limit: 2 },
    input([message(9), message(7)], {
      older: { available: true, cursor: 7 },
      newer: { available: true, cursor: 9 },
    }),
  );

  assert.deepEqual(
    page.messages.map(({ sequence }) => sequence),
    [7, 9],
  );
  assert.deepEqual(page.pagination, {
    older: { available: true, cursor: 7 },
    newer: { available: true, cursor: 9 },
  });
  assert.throws(
    () =>
      createMessageTimelinePage(
        { conversationId, direction: "backward", cursor: 10, limit: 1 },
        input([message(10)]),
      ),
    (error) =>
      error instanceof MessageTimelineContractError &&
      error.code === "cursor_boundary",
  );
});

test("applies an exclusive forward cursor and still returns ascending order", () => {
  const page = createMessageTimelinePage(
    { conversationId, direction: "forward", cursor: 10, limit: 3 },
    input([message(13), message(11), message(12)]),
  );

  assert.deepEqual(
    page.messages.map(({ sequence }) => sequence),
    [11, 12, 13],
  );
  assert.throws(
    () =>
      createMessageTimelinePage(
        { conversationId, direction: "forward", cursor: 10, limit: 1 },
        input([message(10)]),
      ),
    (error) =>
      error instanceof MessageTimelineContractError &&
      error.code === "cursor_boundary",
  );
});

test("preserves edit markers and a redacted soft-delete shell", () => {
  const edited = message(2, {
    revision: {
      revision: 3,
      editedAt: "2026-08-25T20:02:00.000Z",
      editedByUserId: "user-editor",
    },
    updatedAt: "2026-08-25T20:02:00.000Z",
  });
  const deleted = message(3, {
    revision: { revision: 2, editedAt: "2026-08-25T20:03:00.000Z" },
    content: null,
    deletedAt: "2026-08-25T20:04:00.000Z",
    deletedByUserId: "user-moderator",
    updatedAt: "2026-08-25T20:04:00.000Z",
  });

  const page = createMessageTimelinePage(
    { conversationId, direction: "forward", limit: 10 },
    input([deleted, edited]),
  );

  assert.equal(page.messages[0].revision.revision, 3);
  assert.equal(page.messages[0].revision.editedByUserId, "user-editor");
  assert.equal(page.messages[1].content, null);
  assert.equal(page.messages[1].deletedByUserId, "user-moderator");
});

test("serializes reaction aggregates, attachment metadata, root summary, and replay cursor", () => {
  const root = message(4, {
    replyTo: { messageId: "source-1", notifyAuthor: false },
    content: {
      format: "markdown",
      text: "Screenshot",
      attachments: [{ attachmentId: "attachment-1" }],
    },
    isThreadRoot: true,
    threadSummary: {
      threadId: threadConversationId,
      replyCount: 2,
      participantIds: ["user-1", "user-2"],
      unreadCount: 1,
      lastReplyAt: "2026-08-25T20:05:00.000Z",
    },
    reactions: [
      { reactionKey: "thumbsup", count: 2, reactedByCurrentUser: true },
    ],
    attachmentMetadata: [
      {
        attachmentId: "attachment-1",
        fileName: "status.png",
        contentType: "image/png",
        sizeBytes: 2048,
        downloadUrl: "https://cdn.example.test/status.png",
        previewUrl: "https://cdn.example.test/status-preview.png",
        width: 640,
        height: 480,
        altText: "Current order status",
      },
    ],
  });

  const page = createMessageTimelinePage(
    { conversationId, direction: "backward", limit: 20 },
    input([root]),
  );

  assert.deepEqual(page.messages[0].reactions, root.reactions);
  assert.deepEqual(page.messages[0].attachmentMetadata, root.attachmentMetadata);
  assert.deepEqual(page.messages[0].threadSummary, root.threadSummary);
  assert.deepEqual(page.messages[0].replyTo, root.replyTo);
  assert.deepEqual(page.replay.resumeFrom, { eventId: "event-snapshot-42" });
});

test("rejects thread replies and any other conversation row from a parent page", () => {
  const reply = message(1, {
    conversationId: threadConversationId,
    replyTo: { messageId: "source-1", notifyAuthor: true },
  });

  assert.throws(
    () =>
      createMessageTimelinePage(
        { conversationId, direction: "backward", limit: 20 },
        input([reply]),
      ),
    (error) =>
      error instanceof MessageTimelineContractError &&
      error.code === "conversation_mismatch",
  );
});

test("rejects thread summaries on ordinary messages and mismatched attachments", () => {
  assert.throws(
    () =>
      createMessageTimelinePage(
        { conversationId, direction: "backward", limit: 20 },
        input([
          message(1, {
            replyTo: { messageId: "source-1", notifyAuthor: true },
            threadSummary: {
              threadId: threadConversationId,
              replyCount: 1,
              participantIds: ["user-2"],
              unreadCount: 0,
            },
          }),
        ]),
      ),
    (error) =>
      error instanceof MessageTimelineContractError &&
      error.code === "invalid_message",
  );

  assert.throws(
    () =>
      createMessageTimelinePage(
        { conversationId, direction: "backward", limit: 20 },
        input([
          message(1, {
            content: {
              format: "plain",
              text: "file",
              attachments: [{ attachmentId: "attachment-1" }],
            },
          }),
        ]),
      ),
    (error) =>
      error instanceof MessageTimelineContractError &&
      error.code === "invalid_message",
  );
});

const renderAttachment = (overrides = {}) => renderToStaticMarkup(
  createElement(DefaultAttachmentRenderer, {
    attachment: {
      attachment: {
        attachmentId: "attachment-renderer",
        fileName: "status.png",
        contentType: "image/png",
        sizeBytes: 2_048,
        downloadUrl: "https://cdn.example.test/status.png?token=authorized",
        ...overrides,
      },
    },
    hostProps: { "data-testid": "attachment" },
  }),
);

test("DefaultAttachmentRenderer links a lazy image preview and keeps readable download metadata", () => {
  const markup = renderAttachment();

  assert.match(markup, /data-attachment-kind="image"/);
  assert.match(markup, /class="handrail-chat__timeline-attachment-preview" href="https:\/\/cdn\.example\.test\/status\.png\?token=authorized"/);
  assert.match(markup, /<img alt="status\.png" class="handrail-chat__timeline-attachment-image" decoding="async" loading="lazy" src="https:\/\/cdn\.example\.test\/status\.png\?token=authorized"\/?>/);
  assert.match(markup, />status\.png<\/span>/);
  assert.match(markup, />PNG image · 2 KB<\/span>/);
  assert.match(markup, /download="status\.png" href="https:\/\/cdn\.example\.test\/status\.png\?token=authorized">Download<\/a>/);
});

test("DefaultAttachmentRenderer uses canonical image preview metadata without changing open or download targets", () => {
  const markup = renderAttachment({
    previewUrl: "https://cdn.example.test/status-preview.png?size=compact",
    altText: "Deployment status chart",
    width: 640,
    height: 480,
  });

  assert.match(
    markup,
    /class="handrail-chat__timeline-attachment-preview" href="https:\/\/cdn\.example\.test\/status\.png\?token=authorized"/,
  );
  assert.match(markup, /<img\b[^>]*alt="Deployment status chart"/);
  assert.match(markup, /<img\b[^>]*height="480"/);
  assert.match(markup, /<img\b[^>]*src="https:\/\/cdn\.example\.test\/status-preview\.png\?size=compact"/);
  assert.match(markup, /<img\b[^>]*width="640"/);
  assert.match(
    markup,
    /download="status\.png" href="https:\/\/cdn\.example\.test\/status\.png\?token=authorized">Download<\/a>/,
  );
});

test("DefaultAttachmentRenderer rejects malformed optional preview metadata", () => {
  const markup = renderAttachment({
    previewUrl: " \t ",
    altText: "\n",
    width: 0,
    height: Number.MAX_SAFE_INTEGER + 1,
  });

  assert.match(markup, /<img\b[^>]*alt="status\.png"/);
  assert.match(
    markup,
    /<img\b[^>]*src="https:\/\/cdn\.example\.test\/status\.png\?token=authorized"/,
  );
  assert.doesNotMatch(markup, /<img\b[^>]*(?:height|width)="/);
  assert.doesNotMatch(markup, /src="\s+"/);
});

test("DefaultAttachmentRenderer keeps non-images compact and does not emit preview markup", () => {
  const markup = renderAttachment({
    fileName: "release-notes.pdf",
    contentType: "application/pdf",
    sizeBytes: 1_572_864,
    downloadUrl: "https://cdn.example.test/release-notes.pdf",
  });

  assert.match(markup, /data-attachment-kind="file"/);
  assert.doesNotMatch(markup, /<img\b|timeline-attachment-preview/);
  assert.match(markup, />release-notes\.pdf<\/span>/);
  assert.match(markup, />PDF document · 1\.5 MB<\/span>/);
  assert.match(markup, /download="release-notes\.pdf" href="https:\/\/cdn\.example\.test\/release-notes\.pdf">Download<\/a>/);
});

test("DefaultMessageTimelineEmptyState renders a quiet conversation introduction in the timeline column", () => {
  const introduction = Object.freeze({
    conversationType: "channel",
    identity: "#Release planning",
    context: "A private channel for invited members.",
    prompt: "This conversation is archived, so new messages are unavailable.",
    visibility: "private",
    archived: true,
    entity: Object.freeze({ type: "project", id: "launch" }),
  });
  const markup = renderToStaticMarkup(createElement(DefaultMessageTimelineEmptyState, {
    kind: "no_messages",
    title: introduction.identity,
    description: introduction.prompt,
    introduction,
    hostProps: {
      className: "handrail-chat__timeline-column",
      "data-conversation-introduction": "channel",
    },
  }));

  assert.match(
    markup,
    /class="handrail-chat__timeline-empty handrail-chat__timeline-introduction handrail-chat__timeline-column"/,
  );
  assert.match(markup, /data-conversation-type="channel"/);
  assert.match(markup, /data-conversation-visibility="private"/);
  assert.match(markup, />#Release planning<\/h2>/);
  assert.match(markup, />Private channel<\/p>/);
  assert.match(markup, /A private channel for invited members/);
  assert.match(markup, /Connected to project launch/);
  assert.match(markup, /This conversation is archived/);
  assert.match(markup, /new messages are unavailable/);
  assert.doesNotMatch(markup, /tenant|client|provider|token|membership/);
});

test("DefaultAttachmentRenderer escapes malicious-looking and long filenames as text", () => {
  const fileName = `\"><script>alert(&quot;attachment&quot;)</script>${"-very-long".repeat(40)}.png`;
  const markup = renderAttachment({ fileName });

  assert.doesNotMatch(markup, /<script>|<\/script>/);
  assert.match(markup, /alt="&quot;&gt;&lt;script&gt;alert\(&amp;quot;attachment&amp;quot;\)&lt;\/script&gt;/);
  assert.ok(markup.includes("-very-long".repeat(40)), "long filename was truncated by the renderer");
  assert.ok(markup.includes("download="), "explicit download affordance is missing");
});
