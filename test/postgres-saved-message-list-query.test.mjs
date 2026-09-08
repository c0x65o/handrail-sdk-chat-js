import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  PrivateUserStateSnapshotParseError,
  decodeSavedMessageSnapshotCursor,
} from "@handrail/chat";
import {
  SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  querySavedMessageList,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

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

const createReplyHarness = async (t) => {
  const backend = await createPostgresTestBackend();
  t.after(() => backend.teardown());
  const harness = await backend.createHarness({ schemaPrefix: "chat_saved_replies" });
  t.after(() => harness.teardown());
  await createPostgresMigrationRunner({
    database: harness.pool,
    schema: harness.schema,
    migrations: handrailChatPostgresMigrations,
  }).apply();
  t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);
  const prefix = quoteIdentifier(harness.schema);
  const sql = (query, values) => harness.pool.query(query, values);
  const message = (id, conversationId, sequence, replyTo = null) => sql(
    `INSERT INTO ${prefix}.chat_messages
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, reply_to_message_id, reply_notify_author)
     VALUES ('tenant-a', $1, $2, $3, $4, $1, $5, $6, $7)`,
    [id, conversationId, sequence, `author-${id}`,
      { format: "plain", text: `body-${id}` },
      replyTo?.messageId ?? null, replyTo?.notifyAuthor ?? false],
  );
  const save = (id, conversationId) => sql(
    `INSERT INTO ${prefix}.chat_saved_messages
       (tenant_id, user_id, message_id, conversation_id, is_saved,
        private_note, saved_message_revision, created_at, updated_at)
     VALUES ('tenant-a', 'actor-a', $1, $2, true, 'My private note', 3,
             '2030-02-01T12:30:00.123456Z', '2030-02-01T12:31:00Z')`,
    [id, conversationId],
  );
  return { harness, prefix, sql, message, save };
};

test("saved replies reload canonical references and retain only safe identity after source deletion", async (t) => {
  const { harness, prefix, sql, message, save } = await createReplyHarness(t);
  await sql(`INSERT INTO ${prefix}.chat_conversations
    (tenant_id, id, type, visibility, name)
    VALUES ('tenant-a', 'channel', 'channel', 'public', 'Channel')`);
  await message("source-secret", "channel", 1);
  await message("reply-true", "channel", 2, { messageId: "source-secret", notifyAuthor: true });
  await message("reply-false", "channel", 3, { messageId: "source-secret", notifyAuthor: false });
  await message("legacy", "channel", 4);
  for (const id of ["reply-true", "reply-false", "legacy"]) await save(id, "channel");
  const run = () => querySavedMessageList({
    database: harness.pool, schema: harness.schema, actor, input: { limit: 10 },
    permissions: { authorizeEntity: async () => assert.fail("No entity to authorize") },
    storage: { createDownloadUrl: async () => assert.fail("No attachments to resolve") },
  });
  const verify = (snapshot) => {
    for (const item of snapshot.items) {
      assert.equal(item.message.availability, "available");
      const current = item.message.current;
      assert.equal(current.conversationId, "channel");
      assert.equal(current.content.text, `body-${item.messageId}`);
      assert.deepEqual(current.author, { type: "user", userId: `author-${item.messageId}` });
      assert.equal("forwardedFrom" in current, false);
      if (item.messageId === "legacy") {
        assert.equal("replyTo" in current, false);
      } else {
        assert.deepEqual(current.replyTo, {
          messageId: "source-secret", notifyAuthor: item.messageId === "reply-true",
        });
      }
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /body-source-secret|author-source-secret/);
  };
  const before = await run();
  verify(before);
  assert.deepEqual(await run(), before, "a fresh reload preserves both ping choices and legacy omission");
  // Retain stale source content in storage deliberately: none may reach a saved reply.
  await sql(`UPDATE ${prefix}.chat_messages
    SET deleted_at = statement_timestamp(), deleted_by_user_id = 'deleter',
        updated_at = statement_timestamp()
    WHERE id = 'source-secret'`);
  const after = await run();
  verify(after);
  assert.deepEqual(after, before);
  await sql(`UPDATE ${prefix}.chat_messages
    SET deleted_at = statement_timestamp(), deleted_by_user_id = 'deleter',
        updated_at = statement_timestamp()
    WHERE id = 'reply-true'`);
  assert.deepEqual((await run()).items.find((item) => item.messageId === "reply-true").message, {
    availability: "unavailable", reason: "deleted",
  });
});

test("saved thread replies require current parent access before content and attachment URLs", async (t) => {
  const { harness, prefix, sql, message, save } = await createReplyHarness(t);
  await sql(`INSERT INTO ${prefix}.chat_conversations
    (tenant_id, id, type, visibility, name, entity_type, entity_id)
    VALUES ('tenant-a', 'parent', 'channel', 'private', 'Parent', 'order', 'parent-order')`);
  await message("root", "parent", 1);
  await sql(`INSERT INTO ${prefix}.chat_conversations
    (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
    VALUES ('tenant-a', 'thread', 'thread', 'private', 'parent', 'root')`);
  await sql(`INSERT INTO ${prefix}.chat_conversation_members
    (tenant_id, conversation_id, user_id, role, state)
    VALUES ('tenant-a', 'parent', 'actor-a', 'member', 'active'),
           ('tenant-a', 'thread', 'actor-a', 'member', 'active')`);
  await message("thread-source", "thread", 1);
  for (const [id, sequence, notifyAuthor] of [["reply-z", 2, true], ["reply-a", 3, false]]) {
    await message(id, "thread", sequence, { messageId: "thread-source", notifyAuthor });
    await save(id, "thread");
    await sql(`INSERT INTO ${prefix}.chat_attachments
      (tenant_id, id, uploader_user_id, storage_key, file_name, content_type,
       size_bytes, expires_at)
      VALUES ('tenant-a', $1, 'actor-a', $1, 'private.txt', 'text/plain', 10,
              clock_timestamp() + interval '1 day')`, [`attachment-${id}`]);
    await sql(`UPDATE ${prefix}.chat_attachments
      SET state = 'attached', attached_message_id = $1, checksum = $2,
          attached_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $3`, [id, `sha256:${"a".repeat(64)}`, `attachment-${id}`]);
    await sql(`UPDATE ${prefix}.chat_messages
      SET content = content || jsonb_build_object('attachments',
        jsonb_build_array(jsonb_build_object('attachmentId', $2::text)))
      WHERE id = $1`, [id, `attachment-${id}`]);
  }
  const authorizationCalls = [];
  const storageCalls = [];
  let hostMode = "allow";
  const run = async (input = { limit: 10 }, trustedActor = actor) => {
    authorizationCalls.length = 0;
    storageCalls.length = 0;
    const counted = countedDatabase(harness.pool);
    const snapshot = await querySavedMessageList({
      database: counted.database, schema: harness.schema, actor: trustedActor, input,
      permissions: {
        async authorizeEntity(request) {
          authorizationCalls.push(request);
          if (hostMode === "error") throw new Error("sensitive parent provider failure");
          return hostMode === "allow";
        },
      },
      storage: {
        async createDownloadUrl(request) {
          assert.equal(authorizationCalls.length, 1, "parent authorized before URL resolution");
          storageCalls.push(request);
          return { url: "https://storage.test.invalid/private", expiresAt: "2031-01-01T00:00:00Z" };
        },
      },
    });
    return { snapshot, queryCount: counted.count() };
  };
  const assertInaccessible = ({ snapshot }) => {
    assert.equal(snapshot.items.length, 2);
    for (const item of snapshot.items) {
      assert.deepEqual(item.message, { availability: "unavailable", reason: "inaccessible" });
      assert.equal(item.privateNote.text, "My private note");
      assert.equal(item.savedMessageRevision, 3);
      assert.equal(item.savedAt, "2030-02-01T12:30:00.123456Z");
      assert.equal(item.updatedAt, "2030-02-01T12:31:00.000Z");
    }
    assert.deepEqual(storageCalls, []);
  };

  await t.test("authorized thread hydrates replies and caches access only within the request", async () => {
    const { snapshot, queryCount } = await run();
    assert.equal(queryCount, 2, "one page query plus one check for the repeated thread");
    assert.deepEqual(authorizationCalls, [{
      actor, entity: { type: "order", id: "parent-order" },
      action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
    }]);
    assert.deepEqual(storageCalls.map(({ attachmentId }) => attachmentId), ["attachment-reply-z", "attachment-reply-a"]);
    for (const item of snapshot.items) {
      assert.equal(item.message.availability, "available");
      assert.equal(item.message.current.conversationId, "thread");
      assert.deepEqual(item.message.current.replyTo, {
        messageId: "thread-source", notifyAuthor: item.messageId === "reply-z",
      });
    }
    const first = await run({ limit: 1 });
    assert.equal(first.queryCount, 2);
    assert.equal(first.snapshot.items[0].messageId, "reply-z");
    const second = await run({ limit: 1, cursor: first.snapshot.page.nextCursor });
    assert.equal(second.snapshot.items[0].messageId, "reply-a");
    assert.equal(second.snapshot.page.nextCursor, null);
  });
  await t.test("revoked private parent overrides a surviving active child member", async () => {
    await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed'
      WHERE conversation_id = 'parent'`);
    const result = await run();
    assertInaccessible(result);
    assert.equal(result.queryCount, 2);
    assert.deepEqual(authorizationCalls, []);
    assert.equal((await sql(`SELECT state FROM ${prefix}.chat_conversation_members
      WHERE conversation_id = 'thread'`)).rows[0].state, "active");
    await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'active'
      WHERE conversation_id = 'parent'`);
  });
  for (const mode of ["deny", "error"]) {
    await t.test(`parent entity ${mode} returns exact shells with no URLs`, async () => {
      hostMode = mode;
      assertInaccessible(await run());
      assert.equal(authorizationCalls.length, 1);
      assert.equal(authorizationCalls[0].entity.id, "parent-order");
      hostMode = "allow";
    });
  }
  for (const id of ["thread", "parent"]) {
    await t.test(`archived ${id} stays inaccessible`, async () => {
      await sql(`UPDATE ${prefix}.chat_conversations
        SET archived_at = clock_timestamp(), archived_by_user_id = 'actor-a' WHERE id = $1`, [id]);
      const result = await run();
      assertInaccessible(result);
      assert.equal(result.queryCount, id === "thread" ? 1 : 2);
      await sql(`UPDATE ${prefix}.chat_conversations
        SET archived_at = NULL, archived_by_user_id = NULL WHERE id = $1`, [id]);
    });
  }
  await t.test("accessible public parent needs no child or parent membership", async () => {
    await sql(`UPDATE ${prefix}.chat_conversations SET visibility = 'public' WHERE id = 'parent'`);
    await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed'`);
    const { snapshot } = await run();
    assert.ok(snapshot.items.every((item) => item.message.availability === "available"));
    assert.equal(storageCalls.length, 2);
  });
  await t.test("actor and tenant isolation also apply to thread saves", async () => {
    for (const trustedActor of [{ ...actor, userId: "other" }, { ...actor, tenantId: "other" }]) {
      const { snapshot, queryCount } = await run({ limit: 10 }, trustedActor);
      assert.deepEqual(snapshot.items, []);
      assert.equal(queryCount, 1);
      assert.deepEqual(storageCalls, []);
      assert.deepEqual(authorizationCalls, []);
    }
  });
});

test("saved-message list is isolated, currently authorized, redacted, and stably paginated in one query", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_saved_message_list",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    saved: `${schema}.chat_saved_messages`,
    attachments: `${schema}.chat_attachments`,
  };
  const authorizationCalls = [];
  const storageCalls = [];
  const permissions = {
    async authorizeEntity(request) {
      authorizationCalls.push(request);
      if (request.entity.id === "error") {
        throw new Error("sensitive host provider failure");
      }
      return request.entity.id !== "deny";
    },
  };
  const storage = {
    async createDownloadUrl(request) {
      storageCalls.push(request);
      return {
        url: `https://storage.test.invalid/${encodeURIComponent(request.objectKey)}`,
        expiresAt: "2031-01-01T00:00:00.000Z",
      };
    },
  };
  const run = (input, trustedActor = actor, database = harness.pool) =>
    querySavedMessageList({
      database,
      permissions,
      storage,
      actor: trustedActor,
      input,
      schema: harness.schema,
    });

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          current_message_sequence, created_at, updated_at)
       VALUES
         ('tenant-a', 'visible', 'channel', 'private', 'Visible', 'order', 'allow',
          4, '2030-01-01T00:00:00Z', '2030-01-01T00:04:00Z'),
         ('tenant-a', 'revoked', 'channel', 'private', 'Revoked', NULL, NULL,
          1, '2030-01-01T00:00:00Z', '2030-01-01T00:01:00Z'),
         ('tenant-a', 'denied', 'channel', 'public', 'Denied', 'order', 'deny',
          1, '2030-01-01T00:00:00Z', '2030-01-01T00:01:00Z'),
         ('tenant-a', 'errored', 'channel', 'public', 'Errored', 'order', 'error',
          1, '2030-01-01T00:00:00Z', '2030-01-01T00:01:00Z'),
         ('tenant-a', 'archived', 'channel', 'public', 'Archived', NULL, NULL,
          1, '2030-01-01T00:00:00Z', '2030-01-01T00:01:00Z'),
         ('tenant-b', 'visible', 'channel', 'public', 'Other tenant', NULL, NULL,
          1, '2030-01-01T00:00:00Z', '2030-01-01T00:01:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
       VALUES
         ('tenant-a', 'visible', 'actor-a', 'member', 'active',
          '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
         ('tenant-a', 'visible', 'actor-b', 'member', 'active',
          '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
         ('tenant-a', 'revoked', 'actor-a', 'member', 'active',
          '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, current_revision, created_at, updated_at,
          edited_at, edited_by_user_id, deleted_at, deleted_by_user_id)
       VALUES
         ('tenant-a', 'message-visible', 'visible', 1, 'author-a', 'client-visible',
          '{"format":"markdown","text":"Current edited body","mentions":[{"type":"user","userId":"mentioned-user"}],"attachments":[{"attachmentId":"attachment-2"},{"attachmentId":"attachment-1"}],"blocks":[{"type":"erp.reference","data":{"id":"invoice-42"}}]}',
          2, '2030-01-01T10:00:00Z', '2030-01-01T10:05:00Z',
          '2030-01-01T10:05:00Z', 'editor-a', NULL, NULL),
         ('tenant-a', 'message-tie-z', 'visible', 2, 'author-a', 'client-tie-z',
          '{"format":"plain","text":"tie z current"}', 1,
          '2030-01-01T10:06:00Z', '2030-01-01T10:06:00Z', NULL, NULL, NULL, NULL),
         ('tenant-a', 'message-tie-a', 'visible', 3, 'author-a', 'client-tie-a',
          '{"format":"plain","text":"tie a current"}', 1,
          '2030-01-01T10:07:00Z', '2030-01-01T10:07:00Z', NULL, NULL, NULL, NULL),
         ('tenant-a', 'message-unsaved', 'visible', 4, 'author-a', 'client-unsaved',
          '{"format":"plain","text":"must not be listed"}', 1,
          '2030-01-01T10:08:00Z', '2030-01-01T10:08:00Z', NULL, NULL, NULL, NULL),
         ('tenant-a', 'message-deleted', 'visible', 5, 'author-secret', 'client-deleted',
          '{"format":"plain","text":"stale deleted secret","attachments":[{"attachmentId":"attachment-deleted"}]}', 1,
          '2030-01-01T10:09:00Z', '2030-01-01T10:10:00Z', NULL, NULL,
          '2030-01-01T10:10:00Z', 'deleter-a'),
         ('tenant-a', 'message-revoked', 'revoked', 1, 'author-secret', 'client-revoked',
          '{"format":"plain","text":"revoked secret"}', 1,
          '2030-01-01T10:11:00Z', '2030-01-01T10:11:00Z', NULL, NULL, NULL, NULL),
         ('tenant-a', 'message-denied', 'denied', 1, 'author-secret', 'client-denied',
          '{"format":"plain","text":"denied secret"}', 1,
          '2030-01-01T10:12:00Z', '2030-01-01T10:12:00Z', NULL, NULL, NULL, NULL),
         ('tenant-a', 'message-error', 'errored', 1, 'author-secret', 'client-error',
          '{"format":"plain","text":"provider error secret"}', 1,
          '2030-01-01T10:13:00Z', '2030-01-01T10:13:00Z', NULL, NULL, NULL, NULL),
         ('tenant-a', 'message-archived', 'archived', 1, 'author-secret', 'client-archived',
          '{"format":"plain","text":"archived secret"}', 1,
          '2030-01-01T10:14:00Z', '2030-01-01T10:14:00Z', NULL, NULL, NULL, NULL),
         ('tenant-b', 'message-visible', 'visible', 1, 'other-author', 'other-client',
          '{"format":"plain","text":"other tenant secret"}', 1,
          '2030-01-01T10:00:00Z', '2030-01-01T10:00:00Z', NULL, NULL, NULL, NULL)`,
    );

    await harness.pool.query(
      `INSERT INTO ${tables.attachments}
         (tenant_id, id, uploader_user_id, storage_key, file_name, content_type,
          size_bytes, created_at, updated_at, expires_at)
       VALUES
         ('tenant-a', 'attachment-1', 'actor-a', 'tenant-a/attachment-1',
          'one.txt', 'text/plain', 11, '2030-01-01T09:00:00Z',
          '2030-01-01T09:00:00Z', '2030-01-02T09:00:00Z'),
         ('tenant-a', 'attachment-2', 'actor-a', 'tenant-a/attachment-2',
          'two.png', 'image/png', 22, '2030-01-01T09:00:00Z',
          '2030-01-01T09:00:00Z', '2030-01-02T09:00:00Z'),
         ('tenant-a', 'attachment-deleted', 'actor-a', 'tenant-a/deleted',
          'deleted.txt', 'text/plain', 33, '2030-01-01T09:00:00Z',
          '2030-01-01T09:00:00Z', '2030-01-02T09:00:00Z')`,
    );
    await harness.pool.query(
      `UPDATE ${tables.attachments}
          SET state = 'attached', attached_message_id = CASE id
                WHEN 'attachment-deleted' THEN 'message-deleted'
                ELSE 'message-visible'
              END,
              checksum = $1, attached_at = '2030-01-01T10:00:00Z',
              updated_at = '2030-01-01T10:00:00Z'
        WHERE tenant_id = 'tenant-a'`,
      [`sha256:${"a".repeat(64)}`],
    );

    await harness.pool.query(
      `INSERT INTO ${tables.saved}
         (tenant_id, user_id, message_id, conversation_id, is_saved,
          private_note, saved_message_revision, created_at, updated_at)
       VALUES
         ('tenant-a', 'actor-a', 'message-visible', 'visible', true,
          'Actor A private note', 3, '2030-02-01T12:40:00Z', '2030-02-01T12:41:00Z'),
         ('tenant-a', 'actor-a', 'message-tie-z', 'visible', true,
          NULL, 1, '2030-02-01T12:30:00.123456Z', '2030-02-01T12:30:00.123456Z'),
         ('tenant-a', 'actor-a', 'message-tie-a', 'visible', true,
          NULL, 1, '2030-02-01T12:30:00.123456Z', '2030-02-01T12:30:00.123456Z'),
         ('tenant-a', 'actor-a', 'message-deleted', 'visible', true,
          'Deleted item note', 2, '2030-02-01T12:20:00Z', '2030-02-01T12:20:00Z'),
         ('tenant-a', 'actor-a', 'message-revoked', 'revoked', true,
          NULL, 1, '2030-02-01T12:10:00Z', '2030-02-01T12:10:00Z'),
         ('tenant-a', 'actor-a', 'message-denied', 'denied', true,
          NULL, 1, '2030-02-01T12:00:00Z', '2030-02-01T12:00:00Z'),
         ('tenant-a', 'actor-a', 'message-error', 'errored', true,
          NULL, 1, '2030-02-01T11:50:00Z', '2030-02-01T11:50:00Z'),
         ('tenant-a', 'actor-a', 'message-archived', 'archived', true,
          NULL, 1, '2030-02-01T11:40:00Z', '2030-02-01T11:40:00Z'),
         ('tenant-a', 'actor-a', 'message-unsaved', 'visible', false,
          NULL, 2, '2030-02-01T13:00:00Z', '2030-02-01T13:00:00Z'),
         ('tenant-a', 'actor-b', 'message-visible', 'visible', true,
          'Actor B private note', 1, '2030-02-01T13:10:00Z', '2030-02-01T13:10:00Z'),
         ('tenant-b', 'actor-a', 'message-visible', 'visible', true,
          'Other tenant private note', 1, '2030-02-01T13:20:00Z', '2030-02-01T13:20:00Z')`,
    );
    await harness.pool.query(
      `UPDATE ${tables.members}
          SET state = 'removed', updated_at = '2030-02-02T00:00:00Z'
        WHERE tenant_id = 'tenant-a' AND conversation_id = 'revoked'
          AND user_id = 'actor-a'`,
    );
    await harness.pool.query(
      `UPDATE ${tables.conversations}
          SET archived_at = '2030-02-02T00:00:00Z',
              archived_by_user_id = 'actor-a',
              updated_at = '2030-02-02T00:00:00Z'
        WHERE tenant_id = 'tenant-a' AND id = 'archived'`,
    );

    const counted = countedDatabase(harness.pool);
    const snapshot = await run({ limit: 20 }, actor, counted.database);
    assert.equal(counted.count(), 1);
    assert.equal(snapshot.kind, "saved_message_list");
    assert.equal(snapshot.privacy, ACTOR_PRIVATE_USER_STATE_PRIVACY);
    assert.equal(snapshot.page.nextCursor, null);
    assert.deepEqual(
      snapshot.items.map(({ messageId }) => messageId),
      [
        "message-visible",
        "message-tie-z",
        "message-tie-a",
        "message-deleted",
        "message-revoked",
        "message-denied",
        "message-error",
        "message-archived",
      ],
    );
    assert.equal(
      snapshot.items.some(({ messageId }) => messageId === "message-unsaved"),
      false,
    );
    assert.equal(
      JSON.stringify(snapshot).includes("Actor B private note"),
      false,
    );
    assert.equal(
      JSON.stringify(snapshot).includes("Other tenant private note"),
      false,
    );

    const visible = snapshot.items[0];
    assert.deepEqual(visible.privateNote, {
      privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
      text: "Actor A private note",
    });
    assert.equal(visible.savedMessageRevision, 3);
    assert.equal(visible.message.availability, "available");
    assert.deepEqual(visible.message.current, {
      id: "message-visible",
      conversationId: "visible",
      author: { type: "user", userId: "author-a" },
      sequence: 1,
      createdAt: "2030-01-01T10:00:00.000Z",
      updatedAt: "2030-01-01T10:05:00.000Z",
      revision: {
        revision: 2,
        editedAt: "2030-01-01T10:05:00.000Z",
        editedByUserId: "editor-a",
      },
      content: {
        format: "markdown",
        text: "Current edited body",
        mentions: [{ type: "user", userId: "mentioned-user" }],
        attachments: [
          { attachmentId: "attachment-2" },
          { attachmentId: "attachment-1" },
        ],
        blocks: [{ type: "erp.reference", data: { id: "invoice-42" } }],
      },
      attachmentMetadata: [
        {
          attachmentId: "attachment-2",
          fileName: "two.png",
          contentType: "image/png",
          sizeBytes: 22,
          downloadUrl:
            "https://storage.test.invalid/tenant-a%2Fattachment-2",
        },
        {
          attachmentId: "attachment-1",
          fileName: "one.txt",
          contentType: "text/plain",
          sizeBytes: 11,
          downloadUrl:
            "https://storage.test.invalid/tenant-a%2Fattachment-1",
        },
      ],
    });
    assert.deepEqual(
      storageCalls.map(({ attachmentId }) => attachmentId),
      ["attachment-2", "attachment-1"],
    );

    const byId = new Map(snapshot.items.map((item) => [item.messageId, item]));
    assert.deepEqual(byId.get("message-deleted").message, {
      availability: "unavailable",
      reason: "deleted",
    });
    for (const messageId of [
      "message-revoked",
      "message-denied",
      "message-error",
      "message-archived",
    ]) {
      assert.deepEqual(byId.get(messageId).message, {
        availability: "unavailable",
        reason: "inaccessible",
      });
    }
    const unavailableJson = JSON.stringify([
      byId.get("message-deleted").message,
      byId.get("message-revoked").message,
      byId.get("message-denied").message,
      byId.get("message-error").message,
      byId.get("message-archived").message,
    ]);
    assert.doesNotMatch(
      unavailableJson,
      /secret|author|content|attachment|entity/i,
    );
    assert.deepEqual(
      authorizationCalls.map(({ entity, action }) => ({ entity, action })),
      [
        {
          entity: { type: "order", id: "allow" },
          action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
        },
        {
          entity: { type: "order", id: "deny" },
          action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
        },
        {
          entity: { type: "order", id: "error" },
          action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
        },
      ],
    );

    authorizationCalls.length = 0;
    storageCalls.length = 0;
    const firstCounted = countedDatabase(harness.pool);
    const first = await run({ limit: 2 }, actor, firstCounted.database);
    assert.equal(firstCounted.count(), 1);
    assert.deepEqual(first.items.map(({ messageId }) => messageId), [
      "message-visible",
      "message-tie-z",
    ]);
    assert.ok(first.page.nextCursor);
    assert.deepEqual(decodeSavedMessageSnapshotCursor(first.page.nextCursor), {
      savedAt: "2030-02-01T12:30:00.123456Z",
      messageId: "message-tie-z",
    });

    const secondCounted = countedDatabase(harness.pool);
    const second = await run(
      { limit: 2, cursor: first.page.nextCursor },
      actor,
      secondCounted.database,
    );
    assert.equal(secondCounted.count(), 1);
    assert.deepEqual(second.items.map(({ messageId }) => messageId), [
      "message-tie-a",
      "message-deleted",
    ]);
    assert.ok(second.page.nextCursor);

    const third = await run({ limit: 20, cursor: second.page.nextCursor });
    assert.deepEqual(third.items.map(({ messageId }) => messageId), [
      "message-revoked",
      "message-denied",
      "message-error",
      "message-archived",
    ]);
    assert.equal(third.page.nextCursor, null);
    const terminal = await run({
      limit: 20,
      cursor: `handrail-saved-messages.v1.${encodeURIComponent(
        JSON.stringify([
          third.items.at(-1).savedAt,
          third.items.at(-1).messageId,
        ]),
      )}`,
    });
    assert.deepEqual(terminal.items, []);
    assert.equal(terminal.page.nextCursor, null);

    const empty = await run(
      { limit: 10 },
      { tenantId: "tenant-a", userId: "actor-empty", roles: ["employee"] },
    );
    assert.deepEqual(empty.items, []);
    assert.equal(empty.page.nextCursor, null);

    const malformed = countedDatabase(harness.pool);
    for (const input of [
      { limit: 0 },
      { limit: 10, tenantId: "spoofed" },
      { limit: 10, cursor: "not-a-cursor" },
    ]) {
      await assert.rejects(
        run(input, actor, malformed.database),
        (error) => error instanceof PrivateUserStateSnapshotParseError,
      );
    }
    assert.equal(malformed.count(), 0);

    const actorBPage = await run(
      { limit: 10 },
      { tenantId: "tenant-a", userId: "actor-b", roles: ["employee"] },
    );
    assert.deepEqual(actorBPage.items.map(({ messageId }) => messageId), [
      "message-visible",
    ]);
    assert.equal(actorBPage.items[0].privateNote.text, "Actor B private note");

    const tenantBPage = await run(
      { limit: 10 },
      { tenantId: "tenant-b", userId: "actor-a", roles: ["employee"] },
    );
    assert.deepEqual(tenantBPage.items.map(({ messageId }) => messageId), [
      "message-visible",
    ]);
    assert.equal(
      tenantBPage.items[0].privateNote.text,
      "Other tenant private note",
    );
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
