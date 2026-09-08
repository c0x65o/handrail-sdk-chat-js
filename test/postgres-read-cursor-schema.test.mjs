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

test("read cursor migration persists tenant-safe sequence state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_read_cursors" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;
  const cursors = `${schema}.chat_read_cursors`;

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
      ],
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_class AS relation
             INNER JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $1
               AND relation.relname = 'chat_read_cursors'
               AND relation.relkind IN ('r', 'p')
           ) AS exists`,
          [harness.schema],
        )
      ).rows[0]?.exists,
      true,
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES
         ('tenant-a', 'direct-a', 'direct', 'private', NULL, 8),
         ('tenant-a', 'channel-a', 'channel', 'private', 'Channel A', 20),
         ('tenant-b', 'direct-a', 'direct', 'private', NULL, 4)`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'direct-a', 'user-a', 'member', 'active'),
         ('tenant-a', 'direct-a', 'user-b', 'member', 'active'),
         ('tenant-a', 'channel-a', 'user-a', 'member', 'active'),
         ('tenant-b', 'direct-a', 'user-c', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'direct-message-5', 'direct-a', 5, 'user-a',
          'direct-client-5', '{"format":"plain","text":"Message five"}'),
         ('tenant-a', 'direct-message-6', 'direct-a', 6, 'user-a',
          'direct-client-6', '{"format":"plain","text":"Message six"}')`,
    );

    await t.test("creates and advances one cursor per membership", async () => {
      await harness.pool.query(
        `INSERT INTO ${cursors}
           (tenant_id, conversation_id, user_id, last_read_sequence,
            manual_unread_from_sequence)
         VALUES
           ('tenant-a', 'direct-a', 'user-a', 3, NULL),
           ('tenant-a', 'direct-a', 'user-b', 5, NULL),
           ('tenant-a', 'channel-a', 'user-a', 18, 16)`,
      );

      const before = (
        await harness.pool.query(
          `SELECT updated_at
           FROM ${cursors}
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'direct-a'
             AND user_id = 'user-a'`,
        )
      ).rows[0];
      const advanced = (
        await harness.pool.query(
          `UPDATE ${cursors}
           SET last_read_sequence = 6,
               updated_at = clock_timestamp()
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'direct-a'
             AND user_id = 'user-a'
           RETURNING last_read_sequence::integer AS last_read_sequence,
                     manual_unread_from_sequence,
                     updated_at`,
        )
      ).rows[0];

      assert.ok(before.updated_at instanceof Date);
      assert.deepEqual(
        {
          lastReadSequence: advanced.last_read_sequence,
          manualUnreadFromSequence: advanced.manual_unread_from_sequence,
          updatedAtPopulated: advanced.updated_at instanceof Date,
          updatedAtAdvanced: advanced.updated_at >= before.updated_at,
        },
        {
          lastReadSequence: 6,
          manualUnreadFromSequence: null,
          updatedAtPopulated: true,
          updatedAtAdvanced: true,
        },
      );

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${cursors}
             (tenant_id, conversation_id, user_id, last_read_sequence)
           VALUES ('tenant-a', 'direct-a', 'user-a', 6)`,
        ),
        /chat_read_cursors_pkey/,
      );
    });

    await t.test("rejects non-member and cross-tenant cursor identities", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${cursors}
             (tenant_id, conversation_id, user_id, last_read_sequence)
           VALUES ('tenant-a', 'direct-a', 'non-member', 0)`,
        ),
        /chat_read_cursors_membership_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${cursors}
             (tenant_id, conversation_id, user_id, last_read_sequence)
           VALUES ('tenant-b', 'direct-a', 'user-a', 0)`,
        ),
        /chat_read_cursors_membership_fkey/,
      );
    });

    await t.test("rejects invalid cursor and manual-unread ranges", async () => {
      const invalidUpdates = [
        {
          query: `UPDATE ${cursors}
                  SET last_read_sequence = -1
                  WHERE tenant_id = 'tenant-a'
                    AND conversation_id = 'direct-a'
                    AND user_id = 'user-a'`,
          constraint: /chat_read_cursors_last_read_sequence_check/,
        },
        {
          query: `UPDATE ${cursors}
                  SET last_read_sequence = 9007199254740992
                  WHERE tenant_id = 'tenant-a'
                    AND conversation_id = 'direct-a'
                    AND user_id = 'user-a'`,
          constraint: /chat_read_cursors_last_read_sequence_check/,
        },
        {
          query: `UPDATE ${cursors}
                  SET manual_unread_from_sequence = 0
                  WHERE tenant_id = 'tenant-a'
                    AND conversation_id = 'direct-a'
                    AND user_id = 'user-a'`,
          constraint: /chat_read_cursors_manual_unread_sequence_check/,
        },
        {
          query: `UPDATE ${cursors}
                  SET manual_unread_from_sequence = last_read_sequence + 1
                  WHERE tenant_id = 'tenant-a'
                    AND conversation_id = 'direct-a'
                    AND user_id = 'user-a'`,
          constraint: /chat_read_cursors_manual_unread_sequence_check/,
        },
      ];

      for (const { query, constraint } of invalidUpdates) {
        await assert.rejects(harness.pool.query(query), constraint);
      }
    });

    await t.test("derives unread summaries and DM receipts from stored cursors", async () => {
      const unreadSummary = (
        await harness.pool.query(
          `SELECT
             conversation.id AS conversation_id,
             cursor.last_read_sequence::integer AS last_read_sequence,
             cursor.manual_unread_from_sequence::integer
               AS manual_unread_from_sequence,
             GREATEST(
               0,
               conversation.current_message_sequence - LEAST(
                 cursor.last_read_sequence,
                 COALESCE(
                   cursor.manual_unread_from_sequence - 1,
                   cursor.last_read_sequence
                 )
               )
             )::integer AS unread_count
           FROM ${cursors} AS cursor
           INNER JOIN ${conversations} AS conversation
             ON conversation.tenant_id = cursor.tenant_id
            AND conversation.id = cursor.conversation_id
           WHERE cursor.tenant_id = 'tenant-a'
             AND cursor.user_id = 'user-a'
           ORDER BY conversation.id`,
        )
      ).rows;

      assert.deepEqual(unreadSummary, [
        {
          conversation_id: "channel-a",
          last_read_sequence: 18,
          manual_unread_from_sequence: 16,
          unread_count: 5,
        },
        {
          conversation_id: "direct-a",
          last_read_sequence: 6,
          manual_unread_from_sequence: null,
          unread_count: 2,
        },
      ]);

      const receiptState = (
        await harness.pool.query(
          `SELECT
             message.sequence::integer AS message_sequence,
             recipient.last_read_sequence >= message.sequence
               AS recipient_has_read
           FROM ${messages} AS message
           INNER JOIN ${cursors} AS recipient
             ON recipient.tenant_id = message.tenant_id
            AND recipient.conversation_id = message.conversation_id
            AND recipient.user_id = 'user-b'
           WHERE message.tenant_id = 'tenant-a'
             AND message.conversation_id = 'direct-a'
           ORDER BY message.sequence`,
        )
      ).rows;

      assert.deepEqual(receiptState, [
        { message_sequence: 5, recipient_has_read: true },
        { message_sequence: 6, recipient_has_read: false },
      ]);
    });

    await t.test("uses the per-user cursor index for unread summaries", async () => {
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name, current_message_sequence)
         SELECT
           'lookup-tenant',
           'lookup-conversation-' || value,
           'channel',
           'private',
           'Lookup ' || value,
           value % 30
         FROM generate_series(1, 5000) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         SELECT
           'lookup-tenant',
           'lookup-conversation-' || value,
           'lookup-user-' || (value % 250),
           'member',
           'active'
         FROM generate_series(1, 5000) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${cursors}
           (tenant_id, conversation_id, user_id, last_read_sequence)
         SELECT
           'lookup-tenant',
           'lookup-conversation-' || value,
           'lookup-user-' || (value % 250),
           value % 20
         FROM generate_series(1, 5000) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${conversations}`);
        await client.query(`ANALYZE ${cursors}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const unreadPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT
             cursor.conversation_id,
             conversation.current_message_sequence,
             cursor.last_read_sequence,
             cursor.manual_unread_from_sequence,
             cursor.updated_at
           FROM ${cursors} AS cursor
           INNER JOIN ${conversations} AS conversation
             ON conversation.tenant_id = cursor.tenant_id
            AND conversation.id = cursor.conversation_id
           WHERE cursor.tenant_id = 'lookup-tenant'
             AND cursor.user_id = 'lookup-user-42'
           ORDER BY cursor.conversation_id`,
        );

        assert.ok(
          findIndexes(unreadPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_read_cursors_user_unread_idx",
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
