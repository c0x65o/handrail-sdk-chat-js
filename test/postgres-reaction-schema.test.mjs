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

test("reaction migration enforces canonical tenant-scoped toggles", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_reactions" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const reactions = `${schema}.chat_reactions`;

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
         ('tenant-a', 'conversation-a', 'channel', 'private', 'Tenant A'),
         ('tenant-b', 'conversation-b', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'message-a', 'conversation-a', 1, 'author-a',
          'client-a', '{"format":"plain","text":"React here"}'),
         ('tenant-a', 'aggregate-message', 'conversation-a', 2, 'author-a',
          'aggregate-client', '{"format":"plain","text":"Aggregate here"}')`,
    );

    await t.test("enforces identical-toggle uniqueness while allowing distinct toggles", async () => {
      await harness.pool.query(
        `INSERT INTO ${reactions}
           (tenant_id, message_id, user_id, reaction_key)
         VALUES ('tenant-a', 'message-a', 'user-a', '👍')`,
      );

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${reactions}
             (tenant_id, message_id, user_id, reaction_key)
           VALUES ('tenant-a', 'message-a', 'user-a', '👍')`,
        ),
        /chat_reactions_pkey/,
      );

      await harness.pool.query(
        `INSERT INTO ${reactions}
           (tenant_id, message_id, user_id, reaction_key)
         VALUES
           ('tenant-a', 'message-a', 'user-b', '👍'),
           ('tenant-a', 'message-a', 'user-a', '❤️')`,
      );

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT reaction_key, count(*)::integer AS count
             FROM ${reactions}
             WHERE tenant_id = 'tenant-a' AND message_id = 'message-a'
             GROUP BY reaction_key
             ORDER BY encode(convert_to(reaction_key, 'UTF8'), 'hex')`,
          )
        ).rows,
        [
          { reaction_key: "❤️", count: 1 },
          { reaction_key: "👍", count: 2 },
        ],
      );
    });

    await t.test("rejects cross-tenant message references", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${reactions}
             (tenant_id, message_id, user_id, reaction_key)
           VALUES ('tenant-b', 'message-a', 'user-b', '👍')`,
        ),
        /chat_reactions_message_fkey/,
      );
    });

    await t.test("requires bounded canonical NFC reaction keys", async () => {
      const invalidKeys = ["", " \t", " 👍", "👍 ", "e\u0301", "x".repeat(65)];

      for (const [index, reactionKey] of invalidKeys.entries()) {
        await assert.rejects(
          harness.pool.query(
            `INSERT INTO ${reactions}
               (tenant_id, message_id, user_id, reaction_key)
             VALUES ('tenant-a', 'message-a', $1, $2)`,
            [`invalid-user-${index}`, reactionKey],
          ),
          /chat_reactions_reaction_key_check/,
        );
      }

      await harness.pool.query(
        `INSERT INTO ${reactions}
           (tenant_id, message_id, user_id, reaction_key)
         VALUES
           ('tenant-a', 'message-a', 'canonical-user', $1),
           ('tenant-a', 'message-a', 'maximum-key-user', $2)`,
        ["é", "x".repeat(64)],
      );
    });

    await t.test("populates ordered timestamps", async () => {
      const row = (
        await harness.pool.query(
          `SELECT created_at, updated_at
           FROM ${reactions}
           WHERE tenant_id = 'tenant-a'
             AND message_id = 'message-a'
             AND user_id = 'user-a'
             AND reaction_key = '👍'`,
        )
      ).rows[0];

      assert.ok(row.created_at instanceof Date);
      assert.ok(row.updated_at instanceof Date);
      assert.ok(row.updated_at >= row.created_at);
    });

    await t.test("uses the message aggregate index for grouped lookup", async () => {
      await harness.pool.query(
        `INSERT INTO ${reactions}
           (tenant_id, message_id, user_id, reaction_key)
         SELECT
           'tenant-a',
           'aggregate-message',
           'aggregate-user-' || value,
           'reaction-' || (value % 10)
         FROM generate_series(1, 5000) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${reactions}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const aggregatePlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT reaction_key, count(*)
           FROM ${reactions}
           WHERE tenant_id = 'tenant-a'
             AND message_id = 'aggregate-message'
           GROUP BY reaction_key
           ORDER BY reaction_key`,
        );

        assert.ok(
          findIndexes(aggregatePlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_reactions_message_aggregate_idx",
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
