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

test("thread follow migration persists tenant-safe durable follow state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_thread_follows" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;
  const follows = `${schema}.chat_thread_follows`;

  const upsertFollow = async ({
    tenantId = "tenant-a",
    conversationId = "thread-a",
    userId = "user-parent",
    isFollowing,
    followSource = "manual",
    updatedAt,
  }) =>
    harness.pool.query(
      `INSERT INTO ${follows} AS stored
         (tenant_id, conversation_id, user_id, is_following,
          follow_source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ON CONSTRAINT chat_thread_follows_pkey
       DO UPDATE SET
         is_following = EXCLUDED.is_following,
         follow_source = EXCLUDED.follow_source,
         updated_at = EXCLUDED.updated_at
       RETURNING
         tenant_id,
         conversation_id,
         user_id,
         is_following,
         follow_source,
         created_at,
         updated_at`,
      [
        tenantId,
        conversationId,
        userId,
        isFollowing,
        followSource,
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
         ('tenant-a', 'public-parent-a', 'channel', 'public', 'Public parent A'),
         ('tenant-a', 'non-thread-a', 'channel', 'private', 'Not a thread'),
         ('tenant-b', 'parent-b', 'channel', 'private', 'Parent B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'root-a', 'parent-a', 1, 'author-a', 'root-client-a',
          '{"format":"plain","text":"Root A"}'),
         ('tenant-a', 'public-root-a', 'public-parent-a', 1, 'author-a',
          'public-root-client-a', '{"format":"plain","text":"Public root A"}'),
         ('tenant-b', 'root-b', 'parent-b', 1, 'author-b', 'root-client-b',
          '{"format":"plain","text":"Root B"}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, parent_conversation_id,
          root_message_id)
       VALUES
         ('tenant-a', 'thread-a', 'thread', 'public', 'parent-a', 'root-a'),
         ('tenant-a', 'public-thread-a', 'thread', 'public',
          'public-parent-a', 'public-root-a'),
         ('tenant-b', 'thread-b', 'thread', 'private', 'parent-b', 'root-b')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'parent-a', 'user-parent', 'member', 'active'),
         ('tenant-a', 'thread-a', 'user-thread', 'member', 'active'),
         ('tenant-a', 'parent-a', 'user-left', 'member', 'left'),
         ('tenant-a', 'thread-a', 'user-removed', 'member', 'removed'),
         ('tenant-a', 'parent-a', 'user-invalid-value', 'member', 'active'),
         ('tenant-a', 'non-thread-a', 'user-parent', 'member', 'active'),
         ('tenant-b', 'parent-b', 'user-b', 'member', 'active')`,
    );

    await t.test("accepts active private-parent members and public-parent access", async () => {
      const parentMember = (
        await upsertFollow({
          isFollowing: true,
          updatedAt: "2030-01-01T00:00:00Z",
        })
      ).rows[0];
      const publicAccess = (
        await upsertFollow({
          conversationId: "public-thread-a",
          userId: "user-public",
          isFollowing: true,
          followSource: "reply",
          updatedAt: "2030-01-01T00:00:00Z",
        })
      ).rows[0];

      assert.deepEqual(
        {
          isFollowing: parentMember.is_following,
          followSource: parentMember.follow_source,
          timestampsAreFinite:
            Number.isFinite(parentMember.created_at.getTime()) &&
            Number.isFinite(parentMember.updated_at.getTime()),
        },
        { isFollowing: true, followSource: "manual", timestampsAreFinite: true },
      );
      assert.deepEqual(
        { isFollowing: publicAccess.is_following, followSource: publicAccess.follow_source },
        { isFollowing: true, followSource: "reply" },
      );
    });

    await t.test("converges repeated follow and unfollow writes to one row", async () => {
      const firstCreatedAt = (
        await upsertFollow({
          isFollowing: true,
          updatedAt: "2030-01-01T00:00:00Z",
        })
      ).rows[0].created_at;

      await upsertFollow({
        isFollowing: true,
        updatedAt: "2030-01-01T00:00:00Z",
      });
      await upsertFollow({
        isFollowing: false,
        updatedAt: "2030-01-01T00:00:01Z",
      });
      await upsertFollow({
        isFollowing: false,
        updatedAt: "2030-01-01T00:00:01Z",
      });

      await assert.rejects(
        upsertFollow({
          isFollowing: true,
          followSource: "reply",
          updatedAt: "2030-01-01T00:00:02Z",
        }),
        /automatic thread follow cannot overwrite an explicit manual unfollow/,
      );

      const stored = (
        await harness.pool.query(
          `SELECT
             count(*)::integer AS count,
             bool_and(is_following) AS is_following,
             min(follow_source) AS follow_source,
             min(created_at) AS created_at,
             max(updated_at) AS updated_at
             FROM ${follows}
             WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'thread-a'
             AND user_id = 'user-parent'`,
        )
      ).rows[0];

      assert.deepEqual(
        {
          count: stored.count,
          isFollowing: stored.is_following,
          followSource: stored.follow_source,
          creationTimestampRetained: stored.created_at.getTime() === firstCreatedAt.getTime(),
          updatedAt: stored.updated_at.toISOString(),
        },
        {
          count: 1,
          isFollowing: false,
          followSource: "manual",
          creationTimestampRetained: true,
          updatedAt: "2030-01-01T00:00:01.000Z",
        },
      );

      await upsertFollow({
        isFollowing: true,
        updatedAt: "2030-01-01T00:00:02Z",
      });
    });

    await t.test("rejects non-thread and cross-tenant targets", async () => {
      await assert.rejects(
        upsertFollow({
          conversationId: "non-thread-a",
          isFollowing: true,
          updatedAt: "2030-01-01T00:00:00Z",
        }),
        /chat_thread_follows_thread_type_check/,
      );
      await assert.rejects(
        upsertFollow({
          conversationId: "thread-b",
          isFollowing: true,
          updatedAt: "2030-01-01T00:00:00Z",
        }),
        /chat_thread_follows_thread_type_check/,
      );
    });

    await t.test("rejects users without tenant-safe active parent access", async () => {
      for (const userId of [
        "user-none",
        "user-left",
        "user-removed",
        "user-thread",
      ]) {
        await assert.rejects(
          upsertFollow({
            userId,
            isFollowing: true,
            updatedAt: "2030-01-01T00:00:00Z",
          }),
          /chat_thread_follows_active_membership_check/,
        );
      }

      await assert.rejects(
        upsertFollow({
          tenantId: "tenant-b",
          conversationId: "thread-b",
          userId: "user-parent",
          isFollowing: true,
          updatedAt: "2030-01-01T00:00:00Z",
        }),
        /chat_thread_follows_active_membership_check/,
      );
    });

    await t.test("validates state, source, identity, and finite ordered timestamps", async () => {
      const invalidInserts = [
        {
          query: `INSERT INTO ${follows}
                    (tenant_id, conversation_id, user_id, is_following,
                     follow_source, created_at, updated_at)
                  VALUES
                    ('tenant-a', 'thread-a', 'user-invalid-value', NULL,
                     'manual', '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
          error: /is_following/,
        },
        {
          query: `INSERT INTO ${follows}
                    (tenant_id, conversation_id, user_id, is_following,
                     follow_source, created_at, updated_at)
                  VALUES
                    ('tenant-a', 'thread-a', 'user-invalid-value', true,
                     'automatic', '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`,
          error: /chat_thread_follows_source_check/,
        },
        {
          query: `INSERT INTO ${follows}
                    (tenant_id, conversation_id, user_id, is_following,
                     created_at, updated_at)
                  VALUES
                    ('tenant-a', 'thread-a', 'user-invalid-value', true,
                     '2030-01-01T00:00:01Z', '2030-01-01T00:00:00Z')`,
          error: /chat_thread_follows_timestamp_order_check/,
        },
        {
          query: `INSERT INTO ${follows}
                    (tenant_id, conversation_id, user_id, is_following,
                     follow_revision)
                  VALUES
                    ('tenant-a', 'thread-a', 'user-invalid-value', true, 0)`,
          error: /chat_thread_follows_revision_check/,
        },
        {
          query: `INSERT INTO ${follows}
                    (tenant_id, conversation_id, user_id, is_following,
                     created_at, updated_at)
                  VALUES
                    ('tenant-a', 'thread-a', 'user-invalid-value', true,
                     '-infinity', 'infinity')`,
          error: /chat_thread_follows_timestamp_order_check/,
        },
      ];

      for (const { query, error } of invalidInserts) {
        await assert.rejects(harness.pool.query(query), error);
      }

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${follows}
           SET created_at = created_at + interval '1 second'
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'thread-a'
             AND user_id = 'user-parent'`,
        ),
        /identities and creation timestamps are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${follows}
           SET updated_at = created_at
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'thread-a'
             AND user_id = 'user-parent'`,
        ),
        /updated_at must not move backwards/,
      );
    });

    await t.test("keeps thread replies solely in chat_messages", async () => {
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         VALUES
           ('tenant-a', 'reply-a', 'thread-a', 1, 'user-parent', 'reply-client-a',
            '{"format":"plain","text":"Thread reply"}')`,
      );

      const threadTables = await harness.pool.query(
        `SELECT relation.relname
         FROM pg_catalog.pg_class AS relation
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1
           AND relation.relname LIKE 'chat_thread%'
           AND relation.relkind IN ('r', 'p')
         ORDER BY relation.relname`,
        [harness.schema],
      );
      const replyCount = (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${messages}
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'thread-a'`,
        )
      ).rows[0]?.count;

      assert.deepEqual(threadTables.rows, [{ relname: "chat_thread_follows" }]);
      assert.equal(replyCount, 1);
    });

    await t.test("uses the partial covering per-user followed-thread index", async () => {
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES ('lookup-tenant', 'lookup-parent', 'channel', 'private', 'Lookup')`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         SELECT
           'lookup-tenant',
           'lookup-root-' || value,
           'lookup-parent',
           value,
           'lookup-author',
           'lookup-client-' || value,
           '{"format":"plain","text":"Lookup root"}'::jsonb
         FROM generate_series(1, 500) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, parent_conversation_id,
            root_message_id)
         SELECT
           'lookup-tenant',
           'lookup-thread-' || value,
           'thread',
           'private',
           'lookup-parent',
           'lookup-root-' || value
         FROM generate_series(1, 500) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES
           ('lookup-tenant', 'lookup-parent', 'lookup-user', 'member', 'active')`,
      );
      await harness.pool.query(
        `INSERT INTO ${follows}
           (tenant_id, conversation_id, user_id, is_following,
            follow_source, created_at, updated_at)
         SELECT
           'lookup-tenant',
           'lookup-thread-' || value,
           'lookup-user',
           value % 3 <> 0,
           CASE value % 3 WHEN 1 THEN 'reply' ELSE 'manual' END,
           '2030-01-01T00:00:00Z'::timestamptz,
           '2030-01-01T00:00:00Z'::timestamptz
             + value * interval '1 second'
         FROM generate_series(1, 500) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${follows}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const plan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT
             conversation_id,
             follow_source,
             created_at,
             updated_at
           FROM ${follows}
           WHERE tenant_id = 'lookup-tenant'
             AND user_id = 'lookup-user'
             AND is_following IS TRUE
           ORDER BY updated_at DESC, conversation_id`,
        );

        assert.ok(
          findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_thread_follows_tenant_user_followed_idx",
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
