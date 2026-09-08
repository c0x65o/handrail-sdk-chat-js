import assert from "node:assert/strict";
import test from "node:test";

import {
  chatConversationPreferenceStarredMigration,
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

const starredMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatConversationPreferenceStarredMigration,
);
const migrationsBefore0032 = handrailChatPostgresMigrations.slice(
  0,
  starredMigrationIndex,
);

test("starred preference migration is immutable and ordered", () => {
  assert.deepEqual(
    {
      id: chatConversationPreferenceStarredMigration.id,
      order: chatConversationPreferenceStarredMigration.order,
    },
    { id: "0032-chat-conversation-preference-starred", order: 32 },
  );
  assert.equal(Object.isFrozen(chatConversationPreferenceStarredMigration), true);
  assert.equal(
    Object.isFrozen(chatConversationPreferenceStarredMigration.statements),
    true,
  );
  assert.equal(
    handrailChatPostgresMigrations[starredMigrationIndex + 1]?.id,
    "0033-chat-device-push-token-protection-metadata",
  );
  assert.equal(migrationsBefore0032.at(-1)?.id, "0031-chat-message-reminder-notifications");
});

test("starred preference migration upgrades existing rows and remains idempotent", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_star_upgrade",
  });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const preferences = `${schema}.chat_conversation_preferences`;

  try {
    const oldRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: migrationsBefore0032,
    });
    const oldApply = await oldRunner.apply();
    assert.equal(oldApply.applied.at(-1)?.id, "0031-chat-message-reminder-notifications");

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'conversation-existing', 'channel', 'private', 'Existing'),
         ('tenant-a', 'conversation-new', 'channel', 'private', 'New')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'conversation-existing', 'user-a', 'member', 'active'),
         ('tenant-a', 'conversation-new', 'user-a', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${preferences}
         (tenant_id, conversation_id, user_id, notification_level, muted)
       VALUES
         ('tenant-a', 'conversation-existing', 'user-a', 'mentions', false)`,
    );

    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const beforeUpgrade = await runner.status();
    assert.deepEqual(beforeUpgrade.pending.map(({ id }) => id), [
      chatConversationPreferenceStarredMigration.id,
    ]);
    assert.deepEqual(beforeUpgrade.incompatible, []);

    const upgrade = await runner.apply();
    assert.deepEqual(upgrade.applied.map(({ id, order }) => ({ id, order })), [
      { id: "0032-chat-conversation-preference-starred", order: 32 },
    ]);
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT notification_level, muted, is_starred
           FROM ${preferences}
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-existing'
             AND user_id = 'user-a'`,
        )
      ).rows[0],
      { notification_level: "mentions", muted: false, is_starred: false },
    );

    const inserted = (
      await harness.pool.query(
        `INSERT INTO ${preferences}
           (tenant_id, conversation_id, user_id)
         VALUES ('tenant-a', 'conversation-new', 'user-a')
         RETURNING is_starred`,
      )
    ).rows[0];
    assert.deepEqual(inserted, { is_starred: false });

    for (const isStarred of [true, false]) {
      const updated = (
        await harness.pool.query(
          `UPDATE ${preferences}
           SET is_starred = $1
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-existing'
             AND user_id = 'user-a'
           RETURNING is_starred`,
          [isStarred],
        )
      ).rows[0];
      assert.deepEqual(updated, { is_starred: isStarred });
    }

    const index = (
      await harness.pool.query(
        `SELECT
           ARRAY(
             SELECT attribute.attname
             FROM unnest(index_metadata.indkey)
               WITH ORDINALITY AS key(attnum, ordinality)
             INNER JOIN pg_catalog.pg_attribute AS attribute
               ON attribute.attrelid = indexed_table.oid
              AND attribute.attnum = key.attnum
             ORDER BY key.ordinality
           ) AS columns,
           pg_get_expr(
             index_metadata.indpred,
             index_metadata.indrelid
           ) AS predicate
         FROM pg_catalog.pg_index AS index_metadata
         INNER JOIN pg_catalog.pg_class AS indexed_table
           ON indexed_table.oid = index_metadata.indrelid
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = indexed_table.relnamespace
         INNER JOIN pg_catalog.pg_class AS indexed_relation
           ON indexed_relation.oid = index_metadata.indexrelid
         WHERE namespace.nspname = $1
           AND indexed_table.relname = 'chat_conversation_preferences'
           AND indexed_relation.relname =
             'chat_conversation_preferences_starred_actor_idx'`,
        [harness.schema],
      )
    ).rows[0];
    assert.deepEqual(index?.columns, [
      "tenant_id",
      "user_id",
      "conversation_id",
    ]);
    assert.match(index?.predicate ?? "", /^is_starred$/);

    const repeated = await runner.apply();
    assert.deepEqual(repeated.applied, []);
    assert.equal(repeated.status.applied.length, 32);
    assert.deepEqual(repeated.status.pending, []);
    assert.deepEqual(repeated.status.incompatible, []);
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});

test("conversation preference migration stores tenant-safe member settings", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_conversation_preferences",
  });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const preferences = `${schema}.chat_conversation_preferences`;

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

    await t.test("defaults to all notifications and an unmuted state", async () => {
      const inserted = (
        await harness.pool.query(
          `INSERT INTO ${preferences}
             (tenant_id, conversation_id, user_id)
           VALUES ('tenant-a', 'conversation-a', 'user-a')
           RETURNING
             notification_level,
             muted,
             muted_until,
             created_at,
             updated_at`,
        )
      ).rows[0];

      assert.deepEqual(
        {
          notificationLevel: inserted.notification_level,
          muted: inserted.muted,
          mutedUntil: inserted.muted_until,
        },
        { notificationLevel: "all", muted: false, mutedUntil: null },
      );
      assert.ok(inserted.created_at instanceof Date);
      assert.ok(inserted.updated_at instanceof Date);
      assert.ok(Number.isFinite(inserted.created_at.getTime()));
      assert.ok(Number.isFinite(inserted.updated_at.getTime()));
      assert.ok(inserted.updated_at >= inserted.created_at);
    });

    await t.test("transitions among notification levels", async () => {
      for (const notificationLevel of ["mentions", "none", "all"]) {
        const updated = (
          await harness.pool.query(
            `UPDATE ${preferences}
             SET notification_level = $1,
                 updated_at = clock_timestamp()
             WHERE tenant_id = 'tenant-a'
               AND conversation_id = 'conversation-a'
               AND user_id = 'user-a'
             RETURNING notification_level`,
            [notificationLevel],
          )
        ).rows[0];
        assert.equal(updated.notification_level, notificationLevel);
      }
    });

    await t.test("transitions among finite, indefinite, and unmuted states", async () => {
      const finite = (
        await harness.pool.query(
          `UPDATE ${preferences}
           SET muted = true,
               muted_until = '2030-02-03T04:05:06Z',
               updated_at = clock_timestamp()
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-a'
             AND user_id = 'user-a'
           RETURNING muted, muted_until`,
        )
      ).rows[0];
      assert.equal(finite.muted, true);
      assert.equal(finite.muted_until.toISOString(), "2030-02-03T04:05:06.000Z");

      const indefinite = (
        await harness.pool.query(
          `UPDATE ${preferences}
           SET muted_until = NULL,
               updated_at = clock_timestamp()
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-a'
             AND user_id = 'user-a'
           RETURNING muted, muted_until`,
        )
      ).rows[0];
      assert.deepEqual(indefinite, { muted: true, muted_until: null });

      const unmuted = (
        await harness.pool.query(
          `UPDATE ${preferences}
           SET muted = false,
               muted_until = NULL,
               updated_at = clock_timestamp()
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-a'
             AND user_id = 'user-a'
           RETURNING muted, muted_until`,
        )
      ).rows[0];
      assert.deepEqual(unmuted, { muted: false, muted_until: null });
    });

    await t.test("rejects invalid notification and mute shapes", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${preferences}
           SET notification_level = 'important'
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-a'
             AND user_id = 'user-a'`,
        ),
        /chat_conversation_preferences_notification_level_check/,
      );

      for (const [muted, mutedUntil] of [
        [false, "2030-01-01T00:00:00Z"],
        [true, "infinity"],
        [true, "-infinity"],
      ]) {
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${preferences}
             SET muted = $1, muted_until = $2
             WHERE tenant_id = 'tenant-a'
               AND conversation_id = 'conversation-a'
               AND user_id = 'user-a'`,
            [muted, mutedUntil],
          ),
          /chat_conversation_preferences_mute_shape_check/,
        );
      }
    });

    await t.test("rejects non-members and cross-tenant identities", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${preferences}
             (tenant_id, conversation_id, user_id)
           VALUES ('tenant-a', 'conversation-a', 'non-member')`,
        ),
        /chat_conversation_preferences_membership_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${preferences}
             (tenant_id, conversation_id, user_id)
           VALUES ('tenant-b', 'conversation-a', 'user-a')`,
        ),
        /chat_conversation_preferences_membership_fkey/,
      );
    });

    await t.test("stores at most one preference row per membership", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${preferences}
             (tenant_id, conversation_id, user_id)
           VALUES ('tenant-a', 'conversation-a', 'user-a')`,
        ),
        /chat_conversation_preferences_pkey/,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${preferences}
             WHERE tenant_id = 'tenant-a'
               AND conversation_id = 'conversation-a'
               AND user_id = 'user-a'`,
          )
        ).rows[0]?.count,
        1,
      );
    });

    await t.test("rejects non-finite and reversed lifecycle timestamps", async () => {
      for (const [createdAt, updatedAt] of [
        ["2030-01-01T00:00:01Z", "2030-01-01T00:00:00Z"],
        ["infinity", "infinity"],
        ["-infinity", "2030-01-01T00:00:00Z"],
      ]) {
        await assert.rejects(
          harness.pool.query(
            `INSERT INTO ${preferences}
               (tenant_id, conversation_id, user_id, created_at, updated_at)
             VALUES ('tenant-a', 'conversation-b', 'user-a', $1, $2)`,
            [createdAt, updatedAt],
          ),
          /chat_conversation_preferences_timestamp_order_check/,
        );
      }
    });

    await t.test("uses the covering tenant-user preference lookup index", async () => {
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
        `INSERT INTO ${preferences}
           (tenant_id, conversation_id, user_id, notification_level,
            muted, muted_until, created_at, updated_at)
         SELECT
           'lookup-tenant',
           'lookup-conversation-' || value,
           'lookup-user-' || (value % 250),
           CASE value % 3
             WHEN 0 THEN 'all'
             WHEN 1 THEN 'mentions'
             ELSE 'none'
           END,
           value % 2 = 0,
           CASE WHEN value % 4 = 0
             THEN '2031-01-01T00:00:00Z'::timestamptz
             ELSE NULL
           END,
           '2030-01-01T00:00:00Z',
           '2030-01-01T00:00:01Z'
         FROM generate_series(1, 5000) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${preferences}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const plan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT
             conversation_id,
             notification_level,
             muted,
             muted_until,
             created_at,
             updated_at
           FROM ${preferences}
           WHERE tenant_id = 'lookup-tenant'
             AND user_id = 'lookup-user-42'
           ORDER BY conversation_id`,
        );

        assert.ok(
          findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_conversation_preferences_tenant_user_idx",
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
