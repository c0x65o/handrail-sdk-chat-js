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

test("message and revision migration enforces ordered tenant-scoped history", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_messages" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const revisions = `${schema}.chat_message_revisions`;

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

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'parent-a', 'channel', 'private', 'Parent A'),
         ('tenant-a', 'other-a', 'channel', 'private', 'Other A'),
         ('tenant-a', 'timeline-a', 'channel', 'private', 'Timeline A'),
         ('tenant-b', 'parent-b', 'channel', 'private', 'Parent B')`,
    );

    await t.test("stores ordered messages and multiple revisions", async () => {
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content, current_revision, edited_at,
            edited_by_user_id, created_at, updated_at)
         VALUES
           ('tenant-a', 'message-a1', 'parent-a', 1, 'author-a',
            'client-a1', '{"format":"markdown","text":"Edited first"}',
            2, '2026-01-02T00:00:00Z', 'editor-a',
            '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
           ('tenant-a', 'message-a2', 'parent-a', 2, 'author-b',
            'client-a2', '{"format":"plain","text":"Second"}',
            1, NULL, NULL, clock_timestamp(), clock_timestamp()),
           ('tenant-b', 'message-b1', 'parent-b', 1, 'author-a',
            'client-a1', '{"format":"plain","text":"Tenant B"}',
            1, NULL, NULL, clock_timestamp(), clock_timestamp())`,
      );
      await harness.pool.query(
        `INSERT INTO ${revisions}
           (tenant_id, message_id, revision_number, content,
            created_by_user_id)
         VALUES
           ('tenant-a', 'message-a1', 1,
            '{"format":"plain","text":"First"}', 'author-a'),
           ('tenant-a', 'message-a1', 2,
            '{"format":"markdown","text":"Edited first"}', 'editor-a'),
           ('tenant-a', 'message-a2', 1,
            '{"format":"plain","text":"Second"}', 'author-b')`,
      );

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT id, sequence::integer AS sequence
             FROM ${messages}
             WHERE tenant_id = 'tenant-a' AND conversation_id = 'parent-a'
             ORDER BY sequence`,
          )
        ).rows,
        [
          { id: "message-a1", sequence: 1 },
          { id: "message-a2", sequence: 2 },
        ],
      );
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT revision_number::integer AS revision_number,
                    content ->> 'text' AS text
             FROM ${revisions}
             WHERE tenant_id = 'tenant-a' AND message_id = 'message-a1'
             ORDER BY revision_number`,
          )
        ).rows,
        [
          { revision_number: 1, text: "First" },
          { revision_number: 2, text: "Edited first" },
        ],
      );
    });

    await t.test("rejects duplicate sequence and client message identities", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content)
           VALUES ('tenant-a', 'duplicate-sequence', 'parent-a', 2, 'author-c',
                   'client-c', '{"format":"plain","text":"Duplicate"}')`,
        ),
        /chat_messages_conversation_sequence_key/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content)
           VALUES ('tenant-a', 'duplicate-client', 'other-a', 1, 'author-a',
                   'client-a1', '{"format":"plain","text":"Duplicate"}')`,
        ),
        /chat_messages_author_client_message_key/,
      );
    });

    await t.test("rejects cross-tenant message, revision, and thread roots", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content)
           VALUES ('tenant-b', 'cross-tenant-message', 'parent-a', 2, 'author-b',
                   'cross-tenant-client',
                   '{"format":"plain","text":"Cross tenant"}')`,
        ),
        /chat_messages_conversation_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${revisions}
             (tenant_id, message_id, revision_number, content,
              created_by_user_id)
           VALUES ('tenant-b', 'message-a1', 1,
                   '{"format":"plain","text":"Cross tenant"}', 'author-b')`,
        ),
        /chat_message_revisions_message_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${conversations}
             (tenant_id, id, type, visibility,
              parent_conversation_id, root_message_id)
           VALUES ('tenant-b', 'cross-tenant-thread', 'thread', 'private',
                   'parent-b', 'message-a1')`,
        ),
        /chat_conversations_root_message_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${conversations}
             (tenant_id, id, type, visibility,
              parent_conversation_id, root_message_id)
           VALUES ('tenant-a', 'wrong-parent-thread', 'thread', 'private',
                   'other-a', 'message-a1')`,
        ),
        /chat_conversations_root_message_fkey/,
      );
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility,
            parent_conversation_id, root_message_id)
         VALUES ('tenant-a', 'valid-thread', 'thread', 'private',
                 'parent-a', 'message-a1')`,
      );
    });

    await t.test("rejects malformed structured content and unsafe counters", async () => {
      const malformedContent = [
        [],
        { format: "html", text: "Unsupported" },
        { format: "plain", text: 42 },
        { format: "plain" },
        { text: "Missing format" },
      ];

      for (const [index, content] of malformedContent.entries()) {
        await assert.rejects(
          harness.pool.query(
            `INSERT INTO ${messages}
               (tenant_id, id, conversation_id, sequence, author_user_id,
                client_message_id, content)
             VALUES ('tenant-a', $1, 'other-a', $2, 'malformed-author', $3, $4)`,
            [
              `malformed-${index}`,
              index + 10,
              `malformed-client-${index}`,
              JSON.stringify(content),
            ],
          ),
          /chat_messages_content_check/,
        );
      }

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${revisions}
             (tenant_id, message_id, revision_number, content,
              created_by_user_id)
           VALUES ('tenant-a', 'message-a2', 2,
                   '{"format":"html","text":"Unsupported"}', 'author-b')`,
        ),
        /chat_message_revisions_content_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content)
           VALUES ('tenant-a', 'zero-sequence', 'other-a', 0, 'author-z',
                   'zero-sequence', '{"format":"plain","text":"Invalid"}')`,
        ),
        /chat_messages_sequence_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content, current_revision)
           VALUES ('tenant-a', 'unsafe-revision', 'other-a', 1, 'author-z',
                   'unsafe-revision', '{"format":"plain","text":"Invalid"}',
                   9007199254740992)`,
        ),
        /chat_messages_current_revision_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${revisions}
             (tenant_id, message_id, revision_number, content,
              created_by_user_id)
           VALUES ('tenant-a', 'message-a2', 0,
                   '{"format":"plain","text":"Invalid"}', 'author-b')`,
        ),
        /chat_message_revisions_number_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content)
           VALUES ('tenant-a', 'missing-content', 'other-a', 1, 'author-z',
                   'missing-content', NULL)`,
        ),
        /chat_messages_content_deletion_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${messages}
           SET deleted_at = deletion.at,
               updated_at = deletion.at
           FROM (SELECT clock_timestamp() AS at) AS deletion
           WHERE tenant_id = 'tenant-a' AND id = 'message-a2'`,
        ),
        /chat_messages_deletion_pair_check/,
      );
    });

    await t.test("preserves soft-deleted history and rejects revision mutation", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${revisions}
             (tenant_id, message_id, revision_number, content,
              created_by_user_id)
           VALUES ('tenant-a', 'message-a1', 2,
                   '{"format":"plain","text":"Duplicate"}', 'editor-a')`,
        ),
        /chat_message_revisions_pkey/,
      );

      await harness.pool.query(
        `UPDATE ${messages}
         SET content = NULL,
             deleted_at = deletion.at,
             deleted_by_user_id = 'deleter-a',
             updated_at = deletion.at
         FROM (SELECT clock_timestamp() AS at) AS deletion
         WHERE tenant_id = 'tenant-a' AND id = 'message-a1'`,
      );

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT content, deleted_by_user_id,
                    (SELECT count(*)::integer
                     FROM ${revisions}
                     WHERE tenant_id = 'tenant-a'
                       AND message_id = 'message-a1') AS revision_count
             FROM ${messages}
             WHERE tenant_id = 'tenant-a' AND id = 'message-a1'`,
          )
        ).rows,
        [{ content: null, deleted_by_user_id: "deleter-a", revision_count: 2 }],
      );

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${revisions}
           SET revision_number = 3
           WHERE tenant_id = 'tenant-a' AND message_id = 'message-a1'
             AND revision_number = 2`,
        ),
        /chat_message_revisions are append-only/,
      );
      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${revisions}
           WHERE tenant_id = 'tenant-a' AND message_id = 'message-a1'
             AND revision_number = 1`,
        ),
        /chat_message_revisions are append-only/,
      );
      await assert.rejects(
        harness.pool.query(`TRUNCATE ${revisions}`),
        /chat_message_revisions are append-only/,
      );
    });

    await t.test("uses the covering conversation timeline index", async () => {
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         SELECT
           'tenant-a',
           'timeline-message-' || value,
           'timeline-a',
           value,
           'timeline-author-' || value,
           'timeline-client-' || value,
           jsonb_build_object('format', 'plain', 'text', 'Message ' || value)
         FROM generate_series(1, 5000) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${messages}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const timelinePlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id, sequence, created_at
           FROM ${messages}
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'timeline-a'
           ORDER BY sequence DESC
           LIMIT 50`,
        );

        assert.ok(
          findIndexes(timelinePlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_messages_conversation_timeline_idx",
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
