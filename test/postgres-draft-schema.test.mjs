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

test("draft migration synchronizes tenant-safe member drafts", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_drafts" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const drafts = `${schema}.chat_drafts`;
  const synchronizeDraft = `${schema}.synchronize_chat_draft`;

  const synchronize = async ({
    tenantId = "tenant-a",
    conversationId = "conversation-a",
    userId = "user-a",
    content,
    revision,
    updatedAt,
  }) =>
    harness.pool.query(
      `SELECT
         did_apply,
         stored_revision::integer AS stored_revision,
         stored_content,
         stored_created_at,
         stored_updated_at
       FROM ${synchronizeDraft}($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        conversationId,
        userId,
        content === null ? null : JSON.stringify(content),
        revision,
        updatedAt,
      ],
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
      handrailChatPostgresMigrations.map(({ id, order }) => ({ id, order })),
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
               AND relation.relname = 'chat_drafts'
               AND relation.relkind IN ('r', 'p')
           ) AS exists`,
          [harness.schema],
        )
      ).rows[0]?.exists,
      true,
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'conversation-a', 'channel', 'private', 'Conversation A'),
         ('tenant-a', 'conversation-b', 'channel', 'private', 'Conversation B'),
         ('tenant-b', 'conversation-a', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'conversation-a', 'user-a', 'member', 'active'),
         ('tenant-a', 'conversation-b', 'user-a', 'member', 'active'),
         ('tenant-b', 'conversation-a', 'user-b', 'member', 'active')`,
    );

    await t.test("stores one structured draft per member and conversation", async () => {
      const content = {
        format: "markdown",
        text: "Hello **draft**",
        mentions: [
          { type: "user", userId: "user-b" },
          { type: "conversation", conversationId: "conversation-b" },
          { type: "entity", entity: { type: "invoice", id: "invoice-a" } },
        ],
        attachments: [{ attachmentId: "attachment-a" }],
        blocks: [{ type: "invoice", data: { id: "invoice-a" } }],
      };
      const initial = (
        await synchronize({
          content,
          revision: 1,
          updatedAt: "2030-01-01T00:00:00Z",
        })
      ).rows;

      assert.deepEqual(initial.map(({ did_apply, stored_revision, stored_content }) => ({
        did_apply,
        stored_revision,
        stored_content,
      })), [{ did_apply: true, stored_revision: 1, stored_content: content }]);

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${drafts}
             (tenant_id, conversation_id, user_id, content, revision)
           VALUES (
             'tenant-a', 'conversation-a', 'user-a',
             '{"format":"plain","text":"Duplicate"}', 2
           )`,
        ),
        /chat_drafts_pkey/,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${drafts}
             WHERE tenant_id = 'tenant-a'
               AND conversation_id = 'conversation-a'
               AND user_id = 'user-a'`,
          )
        ).rows[0]?.count,
        1,
      );
    });

    await t.test("applies only newer revisions atomically", async () => {
      const newer = { format: "plain", text: "Newer content" };
      const newerResult = (
        await synchronize({
          content: newer,
          revision: 2,
          updatedAt: "2030-01-01T00:00:02Z",
        })
      ).rows[0];
      assert.deepEqual(
        {
          didApply: newerResult.did_apply,
          revision: newerResult.stored_revision,
          content: newerResult.stored_content,
        },
        { didApply: true, revision: 2, content: newer },
      );

      for (const [revision, text] of [
        [1, "Stale content"],
        [2, "Equal content"],
      ]) {
        const ignored = (
          await synchronize({
            content: { format: "plain", text },
            revision,
            updatedAt: "2030-01-01T00:00:03Z",
          })
        ).rows[0];
        assert.deepEqual(
          {
            didApply: ignored.did_apply,
            revision: ignored.stored_revision,
            content: ignored.stored_content,
          },
          { didApply: false, revision: 2, content: newer },
        );
      }

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${drafts}
           SET content = '{"format":"plain","text":"Direct stale"}',
               revision = 2,
               updated_at = '2030-01-01T00:00:04Z'
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-a'
             AND user_id = 'user-a'`,
        ),
        /chat_drafts revisions must increase/,
      );
    });

    await t.test("keeps clear tombstones deterministic and idempotent", async () => {
      const cleared = (
        await synchronize({
          content: null,
          revision: 3,
          updatedAt: "2030-01-01T00:00:05Z",
        })
      ).rows[0];
      assert.deepEqual(
        {
          didApply: cleared.did_apply,
          revision: cleared.stored_revision,
          content: cleared.stored_content,
        },
        { didApply: true, revision: 3, content: null },
      );

      const repeatedClear = (
        await synchronize({
          content: null,
          revision: 3,
          updatedAt: "2030-01-01T00:00:06Z",
        })
      ).rows[0];
      assert.deepEqual(
        {
          didApply: repeatedClear.did_apply,
          revision: repeatedClear.stored_revision,
          content: repeatedClear.stored_content,
        },
        { didApply: false, revision: 3, content: null },
      );

      const staleRestore = (
        await synchronize({
          content: { format: "plain", text: "Must stay cleared" },
          revision: 2,
          updatedAt: "2030-01-01T00:00:07Z",
        })
      ).rows[0];
      assert.deepEqual(
        {
          didApply: staleRestore.did_apply,
          revision: staleRestore.stored_revision,
          content: staleRestore.stored_content,
        },
        { didApply: false, revision: 3, content: null },
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${drafts}
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-a'
               AND content IS NOT NULL`,
          )
        ).rows[0]?.count,
        0,
      );
    });

    await t.test("rejects non-member and cross-tenant identities", async () => {
      await assert.rejects(
        synchronize({
          userId: "non-member",
          content: { format: "plain", text: "Not a member" },
          revision: 1,
          updatedAt: "2030-01-02T00:00:00Z",
        }),
        /chat_drafts_membership_fkey/,
      );
      await assert.rejects(
        synchronize({
          tenantId: "tenant-b",
          userId: "user-a",
          content: { format: "plain", text: "Cross tenant" },
          revision: 1,
          updatedAt: "2030-01-02T00:00:00Z",
        }),
        /chat_drafts_membership_fkey/,
      );
    });

    await t.test("rejects malformed content, revisions, and timestamp ordering", async () => {
      const malformedContent = [
        [],
        { format: "html", text: "Unsupported" },
        { format: "plain", text: 42 },
        { format: "plain" },
        { format: "plain", text: "Bad mentions", mentions: {} },
        { format: "plain", text: "Bad mention", mentions: [{ type: "user" }] },
        { format: "plain", text: "Bad attachment", attachments: [{}] },
        { format: "plain", text: "Bad block", blocks: [{ type: "missing-data" }] },
      ];

      for (const content of malformedContent) {
        await assert.rejects(
          synchronize({
            conversationId: "conversation-b",
            content,
            revision: 1,
            updatedAt: "2030-01-03T00:00:00Z",
          }),
          /chat_drafts_content_check/,
        );
      }

      for (const revision of [0, 9007199254740992]) {
        await assert.rejects(
          synchronize({
            conversationId: "conversation-b",
            content: { format: "plain", text: "Invalid revision" },
            revision,
            updatedAt: "2030-01-03T00:00:00Z",
          }),
          /chat_drafts_revision_check/,
        );
      }

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${drafts}
             (tenant_id, conversation_id, user_id, content, revision,
              created_at, updated_at)
           VALUES (
             'tenant-a', 'conversation-b', 'user-a',
             '{"format":"plain","text":"Time travel"}', 1,
             '2030-01-04T00:00:01Z', '2030-01-04T00:00:00Z'
           )`,
        ),
        /chat_drafts_timestamp_order_check/,
      );
    });

    await t.test("uses the covering tenant-user draft lookup index", async () => {
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         SELECT
           'lookup-tenant',
           'lookup-conversation-' || value,
           'channel',
           'private',
           'Lookup ' || value
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
        `INSERT INTO ${drafts}
           (tenant_id, conversation_id, user_id, content, revision,
            created_at, updated_at)
         SELECT
           'lookup-tenant',
           'lookup-conversation-' || value,
           'lookup-user-' || (value % 250),
           jsonb_build_object('format', 'plain', 'text', 'Draft ' || value),
           (value % 10) + 1,
           '2030-02-01T00:00:00Z',
           '2030-02-01T00:00:01Z'
         FROM generate_series(1, 5000) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${drafts}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const plan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT conversation_id, content, revision, created_at, updated_at
           FROM ${drafts}
           WHERE tenant_id = 'lookup-tenant'
             AND user_id = 'lookup-user-42'
             AND content IS NOT NULL
           ORDER BY conversation_id`,
        );

        assert.ok(
          findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_drafts_tenant_user_idx",
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
