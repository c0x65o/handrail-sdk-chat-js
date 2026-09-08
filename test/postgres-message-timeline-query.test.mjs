import assert from "node:assert/strict";
import test from "node:test";

import { MessageTimelineContractError } from "@handrail/chat";
import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
  ChatAuthorizationError,
  queryMessageTimeline,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorA = {
  credential: "timeline-actor-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
};

const actorB = {
  credential: "timeline-actor-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["employee"],
  },
};

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const countedDatabase = (pool) => {
  let queryCount = 0;
  return {
    database: {
      query(...args) {
        queryCount += 1;
        return pool.query(...args);
      },
      connect() {
        return pool.connect();
      },
    },
    count: () => queryCount,
  };
};

const runTimeline = (harness, database, input, actor = actorA.actor) =>
  queryMessageTimeline({
    database,
    permissions: harness.adapters.permissions,
    storage: harness.adapters.storage,
    actor,
    input,
    schema: harness.schema,
  });

const authorizationShape = (error) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  statusCode: error.statusCode,
});

async function seedTimeline(harness) {
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;
  const revisions = `${schema}.chat_message_revisions`;
  const reactions = `${schema}.chat_reactions`;
  const readCursors = `${schema}.chat_read_cursors`;
  const threadFollows = `${schema}.chat_thread_follows`;
  const attachments = `${schema}.chat_attachments`;
  const outbox = `${schema}.chat_outbox_events`;

  await harness.pool.query(
    `INSERT INTO ${conversations}
       (tenant_id, id, type, visibility, name, entity_type, entity_id,
        current_message_sequence, created_at, updated_at)
     VALUES
       ('tenant-a', 'parent', 'channel', 'private', 'Order chat', 'order', '42',
        7, '2030-01-01T00:00:00Z', '2030-01-01T00:07:00Z'),
       ('tenant-a', 'public', 'channel', 'public', 'Public', NULL, NULL,
        0, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
       ('tenant-a', 'private-denied', 'channel', 'private', 'Denied', NULL, NULL,
        0, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
       ('tenant-b', 'cross-tenant', 'channel', 'public', 'Other tenant', NULL, NULL,
        0, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
  );
  await harness.pool.query(
    `INSERT INTO ${members}
       (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
     VALUES
       ('tenant-a', 'parent', 'user-a', 'member', 'active',
        '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
       ('tenant-a', 'parent', 'user-c', 'member', 'active',
        '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
       ('tenant-a', 'private-denied', 'user-c', 'member', 'active',
        '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
  );

  await harness.pool.query(
    `INSERT INTO ${messages}
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, current_revision, created_at, updated_at,
        edited_at, edited_by_user_id, deleted_at, deleted_by_user_id)
     VALUES
       ('tenant-a', 'message-1', 'parent', 1, 'user-a', 'client-1',
        '{"format":"plain","text":"one"}', 1,
        '2030-01-01T00:01:00Z', '2030-01-01T00:01:00Z',
        NULL, NULL, NULL, NULL),
       ('tenant-a', 'message-2', 'parent', 2, 'user-a', 'client-2',
        '{"format":"markdown","text":"two edited"}', 2,
        '2030-01-01T00:02:00Z', '2030-01-01T00:02:30Z',
        '2030-01-01T00:02:30Z', 'user-a', NULL, NULL),
       ('tenant-a', 'message-3', 'parent', 3, 'user-c', 'client-3',
        '{"format":"plain","text":"must be redacted"}', 1,
        '2030-01-01T00:03:00Z', '2030-01-01T00:03:30Z',
        NULL, NULL, '2030-01-01T00:03:30Z', 'user-c'),
       ('tenant-a', 'message-4', 'parent', 4, 'user-a', 'client-4',
        '{"format":"markdown","text":"files","attachments":[{"attachmentId":"attachment-2"},{"attachmentId":"attachment-1"}]}', 1,
        '2030-01-01T00:04:00Z', '2030-01-01T00:04:00Z',
        NULL, NULL, NULL, NULL),
       ('tenant-a', 'message-5', 'parent', 5, 'user-a', 'client-5',
        '{"format":"plain","text":"five"}', 1,
        '2030-01-01T00:05:00Z', '2030-01-01T00:05:00Z',
        NULL, NULL, NULL, NULL),
       ('tenant-a', 'message-6', 'parent', 6, 'user-a', 'client-6',
        '{"format":"plain","text":"six"}', 1,
        '2030-01-01T00:06:00Z', '2030-01-01T00:06:00Z',
        NULL, NULL, NULL, NULL),
       ('tenant-a', 'message-7', 'parent', 7, 'user-a', 'client-7',
        '{"format":"plain","text":"seven"}', 1,
        '2030-01-01T00:07:00Z', '2030-01-01T00:07:00Z',
        NULL, NULL, NULL, NULL)`,
  );
  await harness.pool.query(
    `INSERT INTO ${revisions}
       (tenant_id, message_id, revision_number, content, created_at,
        created_by_user_id)
     VALUES
       ('tenant-a', 'message-2', 1,
        '{"format":"markdown","text":"two original"}',
        '2030-01-01T00:02:00Z', 'user-a'),
       ('tenant-a', 'message-2', 2,
        '{"format":"markdown","text":"two edited"}',
        '2030-01-01T00:02:30Z', 'user-a')`,
  );

  await harness.pool.query(
    `INSERT INTO ${conversations}
       (tenant_id, id, type, visibility, parent_conversation_id,
        root_message_id, current_message_sequence, created_at, updated_at)
     VALUES
       ('tenant-a', 'thread-4', 'thread', 'private', 'parent', 'message-4', 2,
        '2030-01-01T00:04:10Z', '2030-01-01T00:04:30Z')`,
  );
  await harness.pool.query(
    `INSERT INTO ${members}
       (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
     VALUES
       ('tenant-a', 'thread-4', 'user-a', 'member', 'active',
        '2030-01-01T00:04:10Z', '2030-01-01T00:04:10Z'),
       ('tenant-a', 'thread-4', 'user-c', 'member', 'active',
        '2030-01-01T00:04:10Z', '2030-01-01T00:04:10Z')`,
  );
  await harness.pool.query(
    `INSERT INTO ${messages}
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, created_at, updated_at)
     VALUES
       ('tenant-a', 'reply-1', 'thread-4', 1, 'user-c', 'reply-client-1',
        '{"format":"plain","text":"reply one"}',
        '2030-01-01T00:04:20Z', '2030-01-01T00:04:20Z'),
       ('tenant-a', 'reply-2', 'thread-4', 2, 'user-a', 'reply-client-2',
        '{"format":"plain","text":"reply two"}',
        '2030-01-01T00:04:30Z', '2030-01-01T00:04:30Z')`,
  );
  await harness.pool.query(
    `INSERT INTO ${readCursors}
       (tenant_id, conversation_id, user_id, last_read_sequence, updated_at)
     VALUES ('tenant-a', 'thread-4', 'user-a', 1, '2030-01-01T00:04:25Z')`,
  );
  await harness.pool.query(
    `INSERT INTO ${threadFollows}
       (tenant_id, conversation_id, user_id, is_following, follow_source,
        created_at, updated_at)
     VALUES ('tenant-a', 'thread-4', 'user-a', true, 'reply',
       '2030-01-01T00:04:20Z', '2030-01-01T00:04:20Z')`,
  );

  await harness.pool.query(
    `INSERT INTO ${reactions}
       (tenant_id, message_id, user_id, reaction_key, created_at, updated_at)
     VALUES
       ('tenant-a', 'message-4', 'user-a', 'thumbsup',
        '2030-01-01T00:04:40Z', '2030-01-01T00:04:40Z'),
       ('tenant-a', 'message-4', 'user-c', 'thumbsup',
        '2030-01-01T00:04:41Z', '2030-01-01T00:04:41Z'),
       ('tenant-a', 'message-4', 'user-c', 'eyes',
        '2030-01-01T00:04:42Z', '2030-01-01T00:04:42Z')`,
  );

  await harness.pool.query(
    `INSERT INTO ${attachments}
       (tenant_id, id, uploader_user_id, storage_key, file_name, content_type,
        size_bytes, created_at, updated_at, expires_at)
     VALUES
       ('tenant-a', 'attachment-1', 'user-a', 'tenant-a/attachment-1',
        'one.txt', 'text/plain', 11, '2030-01-01T00:03:00Z',
        '2030-01-01T00:03:00Z', '2030-01-01T01:00:00Z'),
       ('tenant-a', 'attachment-2', 'user-a', 'tenant-a/attachment-2',
        'two.png', 'image/png', 22, '2030-01-01T00:03:00Z',
        '2030-01-01T00:03:00Z', '2030-01-01T01:00:00Z'),
       ('tenant-a', 'attachment-pending', 'user-a', 'tenant-a/pending',
        'pending.txt', 'text/plain', 33, '2030-01-01T00:03:00Z',
        '2030-01-01T00:03:00Z', '2030-01-01T01:00:00Z')`,
  );
  await harness.pool.query(
    `UPDATE ${attachments}
     SET state = 'attached', attached_message_id = 'message-4',
         checksum = $1, attached_at = '2030-01-01T00:04:00Z',
         updated_at = '2030-01-01T00:04:00Z'
     WHERE tenant_id = 'tenant-a' AND id IN ('attachment-1', 'attachment-2')`,
    [`sha256:${"a".repeat(64)}`],
  );

  await harness.pool.query(
    `INSERT INTO ${outbox}
       (event_id, protocol_version, tenant_id, stream_id, type, occurred_at,
        payload, expires_at)
     VALUES
       ('event-a-1', 4, 'tenant-a', 'parent', 'message.created',
        '2030-01-01T00:01:00Z', '{}', '2030-01-02T00:00:00Z'),
       ('event-a-2', 4, 'tenant-a', 'parent', 'message.created',
        '2030-01-01T00:07:00Z', '{}', '2030-01-02T00:00:00Z'),
       ('event-b-later', 4, 'tenant-b', 'cross-tenant', 'message.created',
        '2030-01-01T00:08:00Z', '{}', '2030-01-02T00:00:00Z')`,
  );
}

test("message timeline query paginates exclusively and enriches one tenant-scoped page set-wise", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_timeline_query",
    });
    await seedTimeline(harness);

    const latestCounted = countedDatabase(harness.pool);
    const latest = await runTimeline(harness, latestCounted.database, {
      conversationId: "parent",
      direction: "backward",
      limit: 3,
    });
    assert.equal(latestCounted.count(), 1);
    assert.deepEqual(latest.messages.map(({ sequence }) => sequence), [5, 6, 7]);
    assert.deepEqual(latest.pagination, {
      older: { available: true, cursor: 5 },
      newer: { available: false },
    });
    assert.deepEqual(latest.replay, { resumeFrom: { eventId: "event-a-2" } });

    const forward = await runTimeline(harness, harness.pool, {
      conversationId: "parent",
      direction: "forward",
      limit: 2,
    });
    assert.deepEqual(forward.messages.map(({ sequence }) => sequence), [1, 2]);
    assert.deepEqual(forward.pagination, {
      older: { available: false },
      newer: { available: true, cursor: 2 },
    });
    assert.equal(forward.messages[1].content.text, "two edited");
    assert.deepEqual(forward.messages[1].revision, {
      revision: 2,
      editedAt: "2030-01-01T00:02:30.000Z",
      editedByUserId: "user-a",
    });

    const forwardAfter = await runTimeline(harness, harness.pool, {
      conversationId: "parent",
      direction: "forward",
      cursor: 2,
      limit: 2,
    });
    assert.deepEqual(
      forwardAfter.messages.map(({ sequence }) => sequence),
      [3, 4],
    );

    harness.calls.reset();
    const middleCounted = countedDatabase(harness.pool);
    const middle = await runTimeline(harness, middleCounted.database, {
      conversationId: "parent",
      direction: "backward",
      cursor: 5,
      limit: 2,
    });
    assert.equal(middleCounted.count(), 1);
    assert.deepEqual(middle.messages.map(({ sequence }) => sequence), [3, 4]);
    assert.deepEqual(middle.pagination, {
      older: { available: true, cursor: 3 },
      newer: { available: true, cursor: 4 },
    });

    const deleted = middle.messages[0];
    assert.equal(deleted.content, null);
    assert.equal(deleted.deletedAt, "2030-01-01T00:03:30.000Z");
    assert.equal(deleted.deletedByUserId, "user-c");

    const root = middle.messages[1];
    assert.equal(root.isThreadRoot, true);
    assert.deepEqual(root.reactions, [
      { reactionKey: "eyes", count: 1, reactedByCurrentUser: false },
      { reactionKey: "thumbsup", count: 2, reactedByCurrentUser: true },
    ]);
    assert.deepEqual(
      root.attachmentMetadata.map((attachment) => ({
        id: attachment.attachmentId,
        name: attachment.fileName,
        type: attachment.contentType,
        bytes: attachment.sizeBytes,
        url: attachment.downloadUrl,
      })),
      [
        {
          id: "attachment-2",
          name: "two.png",
          type: "image/png",
          bytes: 22,
          url: "https://storage.test.invalid/tenant-a%2Fattachment-2",
        },
        {
          id: "attachment-1",
          name: "one.txt",
          type: "text/plain",
          bytes: 11,
          url: "https://storage.test.invalid/tenant-a%2Fattachment-1",
        },
      ],
    );
    assert.deepEqual(root.threadSummary, {
      threadId: "thread-4",
      replyCount: 2,
      participantIds: ["user-a", "user-c"],
      unreadCount: 1,
      lastReplyAt: "2030-01-01T00:04:30.000Z",
    });
    assert.deepEqual(
      harness.calls
        .all("storage.createDownloadUrl")
        .map(({ input }) => input.attachmentId),
      ["attachment-2", "attachment-1"],
    );
    assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
    assert.deepEqual(
      harness.calls.all("permissions.authorizeEntity")[0].input,
      {
        actor: actorA.actor,
        entity: { type: "order", id: "42" },
        action: MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
      },
    );

    const thread = await runTimeline(harness, harness.pool, {
      conversationId: "thread-4",
      direction: "forward",
      limit: 10,
    });
    assert.deepEqual(thread.messages.map(({ id }) => id), ["reply-1", "reply-2"]);
    assert.equal(thread.messages.some(({ id }) => id === "message-4"), false);
    assert.equal(latest.messages.some(({ id }) => id.startsWith("reply-")), false);

    const publicPage = await runTimeline(harness, harness.pool, {
      conversationId: "public",
      direction: "forward",
      limit: 10,
    });
    assert.deepEqual(publicPage.messages, []);
    assert.deepEqual(publicPage.pagination, {
      older: { available: false },
      newer: { available: false },
    });

    const schema = quoteIdentifier(harness.schema);
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_messages
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, created_at, updated_at)
       SELECT
         'tenant-a', 'message-' || generated.sequence, 'parent',
         generated.sequence, 'user-a', 'client-' || generated.sequence,
         jsonb_build_object('format', 'plain', 'text', 'bulk message'),
         '2030-01-02T00:00:00Z'::timestamptz + generated.sequence * interval '1 second',
         '2030-01-02T00:00:00Z'::timestamptz + generated.sequence * interval '1 second'
       FROM generate_series(8, 107) AS generated(sequence)`,
    );
    await harness.pool.query(
      `UPDATE ${schema}.chat_conversations
       SET current_message_sequence = 107,
           updated_at = '2030-01-02T00:01:47Z'
       WHERE tenant_id = 'tenant-a' AND id = 'parent'`,
    );
    const grownCounted = countedDatabase(harness.pool);
    const grown = await runTimeline(harness, grownCounted.database, {
      conversationId: "parent",
      direction: "forward",
      cursor: 100,
      limit: 5,
    });
    assert.equal(grownCounted.count(), 1);
    assert.deepEqual(grown.messages.map(({ sequence }) => sequence), [
      101, 102, 103, 104, 105,
    ]);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("message timeline query reloads persisted replies and retains references after source deletion", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_timeline_replies",
    });
    await seedTimeline(harness);
    const schema = quoteIdentifier(harness.schema);
    // Persist directly: reply sending is a separate command concern.
    await harness.pool.query(
      `UPDATE ${schema}.chat_messages
       SET reply_to_message_id = 'message-4',
           reply_notify_author = (id = 'message-5')
       WHERE tenant_id = 'tenant-a' AND conversation_id = 'parent'
         AND id IN ('message-5', 'message-6')`,
    );
    const input = {
      conversationId: "parent",
      direction: "forward",
      limit: 10,
    };
    const assertReplies = (page) => {
      assert.equal(page.conversationId, "parent");
      for (const [id, notifyAuthor] of [["message-5", true], ["message-6", false]]) {
        const reply = page.messages.find((message) => message.id === id);
        assert.equal(reply.tenantId, "tenant-a");
        assert.equal(reply.conversationId, "parent");
        assert.deepEqual(reply.replyTo, { messageId: "message-4", notifyAuthor });
        assert.equal(reply.isThreadRoot, false);
        assert.equal(Object.hasOwn(reply, "threadSummary"), false);
      }
      const legacy = page.messages.find(({ id }) => id === "message-1");
      assert.equal(Object.hasOwn(legacy, "replyTo"), false);
    };
    const before = await runTimeline(harness, harness.pool, input);
    assertReplies(before);
    assert.deepEqual(
      before.messages.filter(({ replyTo }) => replyTo).map(({ content }) => content),
      [{ format: "plain", text: "five" }, { format: "plain", text: "six" }],
    );

    await harness.pool.query(
      `UPDATE ${schema}.chat_messages
       SET deleted_at = '2030-01-01T00:08:00Z', deleted_by_user_id = 'user-a',
           updated_at = '2030-01-01T00:08:00Z'
       WHERE tenant_id = 'tenant-a' AND id = 'message-4'`,
    );
    harness.calls.reset();
    const after = await runTimeline(harness, harness.pool, input);
    assertReplies(after);
    const source = after.messages.find(({ id }) => id === "message-4");
    assert.equal(source.content, null);
    assert.equal(source.deletedAt, "2030-01-01T00:08:00.000Z");
    assert.equal(source.deletedByUserId, "user-a");
    assert.deepEqual(source.attachmentMetadata, []);
    assert.deepEqual(
      source.threadSummary,
      before.messages.find(({ id }) => id === "message-4").threadSummary,
    );
    assert.equal(harness.calls.count("storage.createDownloadUrl"), 0);

    // A deleted reply also remains a shell with its identity metadata intact.
    await harness.pool.query(
      `UPDATE ${schema}.chat_messages
       SET deleted_at = '2030-01-01T00:09:00Z', deleted_by_user_id = 'user-a',
           updated_at = '2030-01-01T00:09:00Z'
       WHERE tenant_id = 'tenant-a' AND id = 'message-5'`,
    );
    const deletedReplyPage = await runTimeline(harness, harness.pool, input);
    assertReplies(deletedReplyPage);
    assert.equal(deletedReplyPage.messages.find(({ id }) => id === "message-5").content, null);

    for (const actor of [
      actorB.actor,
      { ...actorA.actor, userId: "non-member" },
    ]) {
      await assert.rejects(
        runTimeline(harness, harness.pool, input, actor),
        (error) => error instanceof ChatAuthorizationError &&
          error.code === CHAT_AUTHORIZATION_ERROR_CODE,
      );
    }
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("message timeline query validates before access and sanitizes all authorization exclusions", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_timeline_denial",
    });
    await seedTimeline(harness);

    const invalid = countedDatabase(harness.pool);
    await assert.rejects(
      runTimeline(harness, invalid.database, {
        conversationId: "parent",
        direction: "forward",
        limit: 10,
        tenantId: "spoofed-tenant",
      }),
      (error) =>
        error instanceof MessageTimelineContractError &&
        error.code === "invalid_request",
    );
    assert.equal(invalid.count(), 0);

    const failures = [];
    for (const conversationId of [
      "missing",
      "private-denied",
      "cross-tenant",
    ]) {
      const counted = countedDatabase(harness.pool);
      await assert.rejects(
        runTimeline(harness, counted.database, {
          conversationId,
          direction: "forward",
          limit: 10,
        }),
        (error) => {
          assert.ok(error instanceof ChatAuthorizationError);
          assert.equal(error.code, CHAT_AUTHORIZATION_ERROR_CODE);
          failures.push(authorizationShape(error));
          return true;
        },
      );
      assert.equal(counted.count(), 1);
    }

    harness.setEntityAuthorization(false);
    await assert.rejects(
      runTimeline(harness, harness.pool, {
        conversationId: "parent",
        direction: "forward",
        limit: 10,
      }),
      (error) => {
        failures.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      },
    );
    harness.setEntityAuthorization(true);
    harness.failures.failNext(
      "permissions.authorizeEntity",
      new Error("sensitive adapter detail"),
    );
    await assert.rejects(
      runTimeline(harness, harness.pool, {
        conversationId: "parent",
        direction: "forward",
        limit: 10,
      }),
      (error) => {
        failures.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      },
    );

    assert.equal(failures.length, 5);
    for (const failure of failures) {
      assert.deepEqual(failure, failures[0]);
    }
    assert.equal(harness.calls.count("storage.createDownloadUrl"), 0);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
