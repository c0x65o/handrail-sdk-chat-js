import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const findIndexes = (plan, indexes = []) => {
  if (plan && typeof plan === "object") {
    if (typeof plan["Index Name"] === "string") {
      indexes.push(plan["Index Name"]);
    }
    for (const value of Object.values(plan)) {
      findIndexes(value, indexes);
    }
  }
  return indexes;
};

test("saved-message migration persists tenant-safe per-user saves", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_saved_messages" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;
  const savedMessages = `${schema}.chat_saved_messages`;

  const saveMessage = async ({
    tenantId = "tenant-a",
    userId = "user-shared",
    messageId = "message-shared",
    conversationId = "conversation-a",
    createdAt,
  } = {}) =>
    harness.pool.query(
      `INSERT INTO ${savedMessages}
         (tenant_id, user_id, message_id, conversation_id, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, clock_timestamp()))
       ON CONFLICT ON CONSTRAINT chat_saved_messages_pkey DO NOTHING
       RETURNING tenant_id, user_id, message_id, conversation_id, created_at`,
      [tenantId, userId, messageId, conversationId, createdAt ?? null],
    );

  const unsaveMessage = async ({
    tenantId = "tenant-a",
    userId = "user-shared",
    messageId = "message-shared",
  } = {}) =>
    harness.pool.query(
      `DELETE FROM ${savedMessages}
       WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3`,
      [tenantId, userId, messageId],
    );

  try {
    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const applied = await runner.apply();

    assert.deepEqual(
      applied.applied.map(({ id, order }) => ({ id, order })),
      [
        { id: "0001-chat-conversations-membership", order: 1 },
        { id: "0002-chat-messages-revisions", order: 2 },
        { id: "0003-chat-reactions", order: 3 },
        { id: "0004-chat-read-cursors", order: 4 },
        { id: "0005-chat-outbox-events", order: 5 },
        { id: "0006-chat-idempotency-keys", order: 6 },
        { id: "0007-chat-drafts", order: 7 },
        { id: "0008-chat-conversation-preferences", order: 8 },
        { id: "0009-chat-thread-follows", order: 9 },
        { id: "0010-chat-attachments", order: 10 },
        { id: "0011-chat-audit-events", order: 11 },
        { id: "0012-chat-saved-messages", order: 12 },
        { id: "0013-chat-huddle-sessions", order: 13 },
        { id: "0014-chat-notification-deliveries", order: 14 },
        { id: "0015-chat-conversation-lifecycle-revision", order: 15 },
        { id: "0016-chat-thread-follow-revision", order: 16 },
        { id: "0017-chat-conversation-member-list-revision", order: 17 },
        { id: "0018-chat-conversation-preference-revision", order: 18 },
        { id: "0019-chat-saved-message-mutation-state", order: 19 },
      ],
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'conversation-a', 'channel', 'private', 'Tenant A'),
         ('tenant-a', 'conversation-other', 'channel', 'private', 'Other A'),
         ('tenant-b', 'conversation-a', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'conversation-a', 'user-shared', 'member', 'active'),
         ('tenant-a', 'conversation-a', 'user-other', 'member', 'active'),
         ('tenant-a', 'conversation-a', 'user-only-a', 'member', 'active'),
         ('tenant-a', 'conversation-a', 'user-left', 'member', 'left'),
         ('tenant-a', 'conversation-a', 'user-removed', 'member', 'removed'),
         ('tenant-a', 'conversation-other', 'user-shared', 'member', 'active'),
         ('tenant-b', 'conversation-a', 'user-shared', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'message-shared', 'conversation-a', 1, 'author-a',
          'client-a', '{"format":"plain","text":"Sensitive body"}'),
         ('tenant-a', 'message-other', 'conversation-other', 1, 'author-a',
          'client-other', '{"format":"plain","text":"Other body"}'),
         ('tenant-b', 'message-shared', 'conversation-a', 1, 'author-b',
          'client-b', '{"format":"plain","text":"Tenant B body"}')`,
    );

    await t.test("converges repeated save and unsave writes", async () => {
      const first = (await saveMessage()).rows[0];
      const repeated = await saveMessage();

      assert.equal(repeated.rowCount, 0);
      assert.equal(Number.isFinite(first.created_at.getTime()), true);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${savedMessages}
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-shared'
               AND message_id = 'message-shared'`,
          )
        ).rows[0].count,
        1,
      );

      await saveMessage({
        messageId: "message-other",
        conversationId: "conversation-other",
      });
      assert.equal(
        (await unsaveMessage({ messageId: "message-other" })).rowCount,
        1,
      );
      assert.equal(
        (await unsaveMessage({ messageId: "message-other" })).rowCount,
        0,
      );
    });

    await t.test("isolates saves between users and tenants", async () => {
      await saveMessage({ userId: "user-other" });
      await saveMessage({ tenantId: "tenant-b" });

      const rows = (
        await harness.pool.query(
          `SELECT tenant_id, user_id, message_id
           FROM ${savedMessages}
           WHERE message_id = 'message-shared'
           ORDER BY tenant_id, user_id`,
        )
      ).rows;
      assert.deepEqual(rows, [
        {
          tenant_id: "tenant-a",
          user_id: "user-other",
          message_id: "message-shared",
        },
        {
          tenant_id: "tenant-a",
          user_id: "user-shared",
          message_id: "message-shared",
        },
        {
          tenant_id: "tenant-b",
          user_id: "user-shared",
          message_id: "message-shared",
        },
      ]);
    });

    await t.test("rejects missing, inactive, and cross-tenant membership", async () => {
      for (const userId of ["user-missing", "user-left", "user-removed"]) {
        await assert.rejects(
          saveMessage({ userId }),
          /current conversation visibility/,
        );
      }

      await assert.rejects(
        saveMessage({ tenantId: "tenant-b", userId: "user-only-a" }),
        /current conversation visibility/,
      );
    });

    await t.test("rejects mismatched message and conversation identity", async () => {
      await assert.rejects(
        saveMessage({
          userId: "user-only-a",
          messageId: "message-other",
          conversationId: "conversation-a",
        }),
        /chat_saved_messages_message_fkey/,
      );
    });

    await t.test("keeps identity and creation time stable and finite", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${savedMessages}
           SET created_at = created_at + interval '1 second'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-shared'
             AND message_id = 'message-shared'`,
        ),
        /identities and creation timestamps are immutable/,
      );
      await assert.rejects(
        saveMessage({
          userId: "user-only-a",
          createdAt: "infinity",
        }),
        /chat_saved_messages_created_at_check/,
      );

      const columns = (
        await harness.pool.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'chat_saved_messages'
           ORDER BY ordinal_position`,
          [harness.schema],
        )
      ).rows.map(({ column_name: columnName }) => columnName);
      assert.deepEqual(columns, [
        "tenant_id",
        "user_id",
        "message_id",
        "conversation_id",
        "created_at",
        "is_saved",
        "private_note",
        "saved_message_revision",
        "updated_at",
      ]);
    });

    await t.test("retains saves with only the soft-deleted message shell", async () => {
      await harness.pool.query(
        `UPDATE ${messages}
         SET content = NULL,
             deleted_at = '2030-01-01T00:00:00Z',
             deleted_by_user_id = 'moderator-a',
             updated_at = '2030-01-01T00:00:00Z'
         WHERE tenant_id = 'tenant-a' AND id = 'message-shared'`,
      );

      const retained = (
        await harness.pool.query(
          `SELECT saved.message_id, saved.created_at,
                  message.content, message.deleted_at
           FROM ${savedMessages} AS saved
           INNER JOIN ${messages} AS message
             ON message.tenant_id = saved.tenant_id
            AND message.conversation_id = saved.conversation_id
            AND message.id = saved.message_id
           WHERE saved.tenant_id = 'tenant-a'
             AND saved.user_id = 'user-shared'
             AND saved.message_id = 'message-shared'`,
        )
      ).rows[0];

      assert.deepEqual(
        {
          messageId: retained.message_id,
          savedAtIsFinite: Number.isFinite(retained.created_at.getTime()),
          content: retained.content,
          deletedAt: retained.deleted_at.toISOString(),
        },
        {
          messageId: "message-shared",
          savedAtIsFinite: true,
          content: null,
          deletedAt: "2030-01-01T00:00:00.000Z",
        },
      );
    });

    await t.test("uses the covering per-user newest-first index", async () => {
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES
           ('tenant-a', 'conversation-a', 'lookup-user', 'member', 'active')`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         SELECT
           'tenant-a',
           'lookup-message-' || lpad(value::text, 4, '0'),
           'conversation-a',
           value,
           'author-a',
           'lookup-client-' || value,
           jsonb_build_object('format', 'plain', 'text', 'Lookup ' || value)
         FROM generate_series(2, 601) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${savedMessages}
           (tenant_id, user_id, message_id, conversation_id, created_at, updated_at)
         SELECT
           'tenant-a',
           'lookup-user',
           'lookup-message-' || lpad(value::text, 4, '0'),
           'conversation-a',
           '2030-01-01T00:00:00Z'::timestamptz
             + value * interval '1 second',
           '2030-01-01T00:00:00Z'::timestamptz
             + value * interval '1 second'
         FROM generate_series(2, 601) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${savedMessages}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const plan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT message_id, conversation_id, created_at
           FROM ${savedMessages}
           WHERE tenant_id = 'tenant-a' AND user_id = 'lookup-user'
           ORDER BY created_at DESC, message_id DESC
           LIMIT 25`,
        );

        assert.ok(
          findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_saved_messages_tenant_user_created_idx",
          ),
        );
      } finally {
        await client.query("RESET enable_bitmapscan").catch(() => undefined);
        await client.query("RESET enable_seqscan").catch(() => undefined);
        client.release();
      }
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
