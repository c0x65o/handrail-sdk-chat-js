import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatAuthorizationError,
  CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
  MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
  queryConversationDetail,
  queryMessageTimeline,
} from "@handrail/chat/server";
import { createChatTestHarness, createPostgresTestBackend } from "@handrail/chat/testing";

const actor = { tenantId: "tenant-a", userId: "reader", roles: ["employee"] };
const unavailable = (error) => {
  assert.ok(error instanceof ChatAuthorizationError);
  assert.deepEqual(
    { name: error.name, message: error.message, code: error.code, statusCode: error.statusCode },
    { name: "ChatAuthorizationError", message: "Chat authorization failed",
      code: "CHAT_AUTHORIZATION_FAILED", statusCode: 403 },
  );
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error), /secret|root|parent|attachment/);
  return true;
};

for (const kind of ["detail", "timeline"]) {
  test(`${kind} snapshots enforce current parent access without participation writes`, async (t) => {
    const backend = await createPostgresTestBackend();
    let harness;
    try {
      harness = await createChatTestHarness({
        backend, actors: [{ credential: "reader", actor }], schemaPrefix: `chat_${kind}_access`,
      });
      const prefix = `"${harness.schema}"`;
      const sql = (text, values) => harness.pool.query(text, values);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, current_message_sequence)
        VALUES ('tenant-a', 'parent', 'channel', 'public', 'Parent', 1)`);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant-a', 'root', 'parent', 1, 'author', 'root-client',
          '{"format":"plain","text":"Root"}')`);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id,
         current_message_sequence)
        VALUES ('tenant-a', 'thread', 'thread', 'private', 'Named discussion', 'parent', 'root', 3)`);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        SELECT 'tenant-a', 'reply-' || n, 'thread', n, 'author', 'reply-client-' || n,
          CASE WHEN n = 3 THEN
            '{"format":"plain","text":"History","attachments":[{"attachmentId":"attachment"}]}'::jsonb
          ELSE '{"format":"plain","text":"History"}'::jsonb END
        FROM generate_series(1, 3) AS n`);
      await sql(`INSERT INTO ${prefix}.chat_attachments
        (tenant_id, id, uploader_user_id, storage_key, file_name, content_type, size_bytes,
         created_at, updated_at, expires_at)
        VALUES ('tenant-a', 'attachment', 'author', 'secret-object-key', 'history.txt', 'text/plain',
          7, '2029-01-01T00:00:00Z', '2029-01-01T00:00:00Z', '2099-01-01T00:00:00Z')`);
      await sql(`UPDATE ${prefix}.chat_attachments SET state = 'attached',
        attached_message_id = 'reply-3', checksum = $1, attached_at = '2030-01-01T00:00:00Z',
        updated_at = '2030-01-01T00:00:00Z'
        WHERE id = 'attachment'`, [`sha256:${"a".repeat(64)}`]);

      const read = async (input = {}, database = harness.pool, trustedActor = actor) => {
        let queries = 0;
        const options = {
          database: {
            query(...args) { queries += 1; return database.query(...args); },
            connect() { return database.connect(); },
          },
          schema: harness.schema, actor: trustedActor, permissions: harness.adapters.permissions,
          input: { conversationId: "thread", ...input },
        };
        const result = kind === "detail"
          ? await queryConversationDetail(options)
          : await queryMessageTimeline({ ...options, storage: harness.adapters.storage,
            input: { direction: "backward", limit: 100, ...options.input } });
        assert.equal(queries, 2, "one page query plus one parent authorization, independent of page size");
        return result;
      };
      const assertHistory = (result) => {
        if (kind === "detail") {
          assert.equal(result.id, "thread");
          assert.equal(result.name, "Named discussion");
          assert.equal(result.rootMessageId, "root");
        } else {
          assert.deepEqual(result.messages.map(({ id }) => id), ["reply-1", "reply-2", "reply-3"]);
          assert.equal(result.messages[2].attachmentMetadata.length, 1);
        }
      };
      const participation = async () => {
        const state = {};
        for (const table of ["chat_conversation_members", "chat_thread_follows",
          "chat_read_cursors", "chat_conversation_preferences"]) {
          state[table] = (await sql(`SELECT to_jsonb(t) AS row FROM ${prefix}.${table} AS t
            ORDER BY to_jsonb(t)::text`)).rows;
        }
        return state;
      };
      const denied = async (input = {}, database = harness.pool, trustedActor = actor) => {
        harness.calls.reset();
        await assert.rejects(read(input, database, trustedActor), unavailable);
        assert.equal(harness.calls.count("storage.createDownloadUrl"), 0);
      };

      await t.test("public and private parent readers need no child membership, follow or cursor", async () => {
        for (const visibility of ["public", "private"]) {
          if (visibility === "private") {
            await sql(`UPDATE ${prefix}.chat_conversations SET visibility = 'private' WHERE id = 'parent'`);
            await sql(`INSERT INTO ${prefix}.chat_conversation_members
              (tenant_id, conversation_id, user_id, role, state)
              VALUES ('tenant-a', 'parent', 'reader', 'member', 'active')`);
          }
          const before = await participation();
          assert.equal(before.chat_conversation_members.length, visibility === "private" ? 1 : 0);
          for (const table of ["chat_thread_follows", "chat_read_cursors", "chat_conversation_preferences"]) {
            assert.deepEqual(before[table], []);
          }
          const connection = await harness.pool.connect();
          try {
            await connection.query("BEGIN READ ONLY");
            const result = await read({}, connection);
            assertHistory(result);
            if (kind === "detail") {
              assert.deepEqual(result.currentThreadFollow, { followRevision: 0, follow: null });
              assert.deepEqual(result.memberUserIds, []);
            } else {
              const page = await read({ limit: 1 }, connection);
              assert.deepEqual(page.messages.map(({ id }) => id), ["reply-3"]);
              assert.deepEqual(page.pagination.older, { available: true, cursor: 3 });
              const empty = await read({ direction: "forward", cursor: 3, limit: 1 }, connection);
              assert.deepEqual(empty.messages, []);
              assert.deepEqual(empty.pagination, { older: { available: false }, newer: { available: false } });
            }
            await connection.query("COMMIT");
          } finally {
            await connection.query("ROLLBACK");
            connection.release();
          }
          assert.deepEqual(await participation(), before);
        }
      });

      await t.test("retained membership and unfollow state survive reads but cannot override parent revocation", async () => {
        await sql(`INSERT INTO ${prefix}.chat_conversation_members
          (tenant_id, conversation_id, user_id, role, state)
          VALUES ('tenant-a', 'thread', 'reader', 'member', 'active')`);
        await sql(`INSERT INTO ${prefix}.chat_thread_follows
          (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
          VALUES ('tenant-a', 'thread', 'reader', false, 'manual', 2)`);
        await sql(`INSERT INTO ${prefix}.chat_read_cursors
          (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
          VALUES ('tenant-a', 'thread', 'reader', 2, 1)`);
        await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
          (tenant_id, conversation_id, user_id, notification_level, muted)
          VALUES ('tenant-a', 'thread', 'reader', 'mentions', true)`);
        const before = await participation();
        assertHistory(await read());
        assert.deepEqual(await participation(), before);
        for (const state of ["removed", "left"]) {
          await sql(`UPDATE ${prefix}.chat_conversation_members SET state = $1 WHERE conversation_id = 'parent'`, [state]);
          const revoked = await participation();
          await denied();
          if (kind === "timeline") await denied({ direction: "forward", cursor: 3 });
          assert.deepEqual(await participation(), revoked);
          assert.equal((await sql(`SELECT state FROM ${prefix}.chat_conversation_members
            WHERE conversation_id = 'thread'`)).rows[0].state, "active");
        }
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'active' WHERE conversation_id = 'parent'`);
      });

      await t.test("deleted root and archived child retain history; archived parent denies", async () => {
        await sql(`UPDATE ${prefix}.chat_messages SET deleted_at = '2030-01-02T00:00:00Z',
          deleted_by_user_id = 'author', updated_at = '2030-01-02T00:00:00Z' WHERE id = 'root'`);
        assertHistory(await read());
        await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = '2030-01-03T00:00:00Z',
          archived_by_user_id = 'admin' WHERE id = 'thread'`);
        const archived = await read();
        assertHistory(archived);
        if (kind === "detail") assert.equal(archived.archivedAt, "2030-01-03T00:00:00.000Z");
        await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = '2030-01-04T00:00:00Z',
          archived_by_user_id = 'admin' WHERE id = 'parent'`);
        await denied();
        await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = NULL, archived_by_user_id = NULL`);
      });

      await t.test("parent entity policy inherits the query action and sanitizes host denial/errors", async () => {
        await sql(`UPDATE ${prefix}.chat_conversations SET entity_type = 'case', entity_id = 'secret-parent'
          WHERE id = 'parent'`);
        harness.calls.reset();
        assertHistory(await read());
        assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
        assert.deepEqual(harness.calls.all("permissions.authorizeEntity")[0].input, {
          actor, entity: { type: "case", id: "secret-parent" },
          action: kind === "detail" ? CONVERSATION_DETAIL_ENTITY_POLICY_ACTION : MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
        });
        harness.setEntityAuthorization(false);
        await denied();
        harness.setEntityAuthorization(true);
        harness.failures.failNext("permissions.authorizeEntity", new Error("secret host failure"));
        await denied();
        await sql(`UPDATE ${prefix}.chat_conversations SET entity_type = NULL, entity_id = NULL WHERE id = 'parent'`);
      });

      await t.test("missing parent fails closed before storage resolution", async () => {
        // Canonical FKs forbid dangling parents. Prove defensive handling in a
        // rolled-back transaction owned solely by this disposable schema.
        const connection = await harness.pool.connect();
        try {
          await connection.query("BEGIN");
          await connection.query(`ALTER TABLE ${prefix}.chat_conversations
            DROP CONSTRAINT chat_conversations_parent_fkey,
            DROP CONSTRAINT chat_conversations_root_message_fkey`);
          await connection.query(`UPDATE ${prefix}.chat_conversations
            SET parent_conversation_id = 'missing-parent' WHERE id = 'thread'`);
          await denied({}, connection);
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
        }
      });

      await t.test("same IDs in another tenant cannot supply current parent membership", async () => {
        await sql(`INSERT INTO ${prefix}.chat_conversations (tenant_id, id, type, visibility, name)
          VALUES ('tenant-b', 'parent', 'channel', 'public', 'Other parent')`);
        await sql(`INSERT INTO ${prefix}.chat_conversation_members
          (tenant_id, conversation_id, user_id, role, state)
          VALUES ('tenant-b', 'parent', 'reader', 'member', 'active')`);
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed'
          WHERE tenant_id = 'tenant-a' AND conversation_id = 'parent'`);
        await denied();
        await denied({}, harness.pool, { ...actor, tenantId: "tenant-b" });
      });
    } finally {
      await harness?.teardown();
      await backend.teardown();
    }
  });
}
