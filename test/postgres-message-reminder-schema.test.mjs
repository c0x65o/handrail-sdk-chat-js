import assert from "node:assert/strict";
import test from "node:test";

import {
  chatMessageReminderNotificationsMigration,
  chatMessageRemindersMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const reminderMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatMessageRemindersMigration,
);
const reminderNotificationsMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatMessageReminderNotificationsMigration,
);
const migrationsThrough0029 = handrailChatPostgresMigrations.slice(
  0,
  reminderMigrationIndex,
);

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

test("message-reminder migrations are immutable and registered in order", () => {
  assert.deepEqual(
    {
      id: chatMessageRemindersMigration.id,
      order: chatMessageRemindersMigration.order,
    },
    { id: "0030-chat-message-reminders", order: 30 },
  );
  assert.equal(Object.isFrozen(chatMessageRemindersMigration), true);
  assert.equal(Object.isFrozen(chatMessageRemindersMigration.statements), true);
  assert.deepEqual(
    {
      id: chatMessageReminderNotificationsMigration.id,
      order: chatMessageReminderNotificationsMigration.order,
    },
    { id: "0031-chat-message-reminder-notifications", order: 31 },
  );
  assert.equal(Object.isFrozen(chatMessageReminderNotificationsMigration), true);
  assert.equal(
    Object.isFrozen(chatMessageReminderNotificationsMigration.statements),
    true,
  );
  assert.equal(reminderMigrationIndex, 29);
  assert.equal(
    handrailChatPostgresMigrations[reminderMigrationIndex - 1]?.id,
    "0029-chat-message-search-vector",
  );
  assert.equal(
    handrailChatPostgresMigrations[reminderMigrationIndex],
    chatMessageRemindersMigration,
  );
  assert.equal(reminderNotificationsMigrationIndex, 30);
  assert.equal(
    handrailChatPostgresMigrations[reminderNotificationsMigrationIndex],
    chatMessageReminderNotificationsMigration,
  );
});

test("message-reminder migration supports fresh installs and 0029 upgrades", async (t) => {
  const backend = await createPostgresTestBackend();
  const harnesses = [];

  const createHarness = async (schemaPrefix) => {
    const harness = await backend.createHarness({ schemaPrefix });
    harnesses.push(harness);
    return harness;
  };

  try {
    await t.test("fresh install enforces reminder identity, lifecycle, and visibility", async (freshTest) => {
      const harness = await createHarness("message_reminders_fresh");
      const schema = quoteIdentifier(harness.schema);
      const conversations = `${schema}.chat_conversations`;
      const members = `${schema}.chat_conversation_members`;
      const messages = `${schema}.chat_messages`;
      const reminders = `${schema}.chat_message_reminders`;
      const runner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: handrailChatPostgresMigrations,
      });

      const before = await runner.status();
      assert.deepEqual(before.applied, []);
      assert.deepEqual(
        before.pending.map(({ id }) => id),
        handrailChatPostgresMigrations.map(({ id }) => id),
      );
      assert.deepEqual(before.incompatible, []);

      const applied = await runner.apply();
      assert.deepEqual(
        applied.applied.at(-1) && {
          id: applied.applied.at(-1).id,
          order: applied.applied.at(-1).order,
        },
        { id: "0032-chat-conversation-preference-starred", order: 32 },
      );
      assert.deepEqual(applied.status.pending, []);
      assert.deepEqual(applied.status.incompatible, []);

      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES
           ('tenant-a', 'private-a', 'channel', 'private', 'Private A'),
           ('tenant-a', 'public-a', 'channel', 'public', 'Public A'),
           ('tenant-a', 'direct-a', 'direct', 'private', NULL),
           ('tenant-a', 'group-a', 'group_direct', 'private', NULL),
           ('tenant-b', 'private-b', 'channel', 'private', 'Private B'),
           ('tenant-b', 'only-b', 'channel', 'private', 'Only B')`,
      );
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES
           ('tenant-a', 'private-a', 'user-active', 'member', 'active'),
           ('tenant-a', 'private-a', 'user-other', 'member', 'active'),
           ('tenant-a', 'private-a', 'user-left', 'member', 'left'),
           ('tenant-a', 'direct-a', 'user-active', 'member', 'active'),
           ('tenant-a', 'group-a', 'user-active', 'member', 'active'),
           ('tenant-b', 'private-b', 'user-active', 'member', 'active'),
           ('tenant-b', 'only-b', 'user-active', 'member', 'active')`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         VALUES
           ('tenant-a', 'private-message', 'private-a', 1, 'author-a',
            'private-client', '{"format":"plain","text":"Private"}'),
           ('tenant-a', 'private-message-two', 'private-a', 2, 'author-a',
            'private-client-two', '{"format":"plain","text":"Private two"}'),
           ('tenant-a', 'private-root', 'private-a', 3, 'author-a',
            'private-root-client', '{"format":"plain","text":"Root"}'),
           ('tenant-a', 'public-message', 'public-a', 1, 'author-a',
            'public-client', '{"format":"plain","text":"Public"}'),
           ('tenant-a', 'direct-message', 'direct-a', 1, 'author-a',
            'direct-client', '{"format":"plain","text":"Direct"}'),
           ('tenant-a', 'group-message', 'group-a', 1, 'author-a',
            'group-client', '{"format":"plain","text":"Group"}'),
           ('tenant-b', 'private-message', 'private-b', 1, 'author-b',
            'private-client-b', '{"format":"plain","text":"Tenant B"}'),
           ('tenant-b', 'only-b-message', 'only-b', 1, 'author-b',
            'only-b-client', '{"format":"plain","text":"Only B"}')`,
      );
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
         VALUES ('tenant-a', 'thread-a', 'thread', 'private',
                 'private-a', 'private-root')`,
      );
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES
           ('tenant-a', 'thread-a', 'user-active', 'member', 'active'),
           ('tenant-a', 'thread-a', 'user-left', 'member', 'left')`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         VALUES ('tenant-a', 'thread-message', 'thread-a', 1, 'author-a',
                 'thread-client', '{"format":"plain","text":"Thread"}')`,
      );

      const insertReminder = async ({
        tenantId = "tenant-a",
        userId = "user-active",
        messageId = "private-message",
        conversationId = "private-a",
        remindAt = "2030-01-02T00:00:00Z",
        revision = 1,
        status = "active",
        deliveredAt = null,
        cancelledAt = null,
        createdAt = "2030-01-01T00:00:00Z",
        updatedAt = "2030-01-01T00:00:00Z",
      } = {}) =>
        harness.pool.query(
          `INSERT INTO ${reminders}
             (tenant_id, user_id, message_id, conversation_id, remind_at,
              reminder_revision, status, delivered_at, cancelled_at,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            tenantId,
            userId,
            messageId,
            conversationId,
            remindAt,
            revision,
            status,
            deliveredAt,
            cancelledAt,
            createdAt,
            updatedAt,
          ],
        );

      await freshTest.test("keeps one identity per actor and isolates actors and tenants", async () => {
        await insertReminder();
        await assert.rejects(insertReminder(), /chat_message_reminders_pkey/);
        await insertReminder({ userId: "user-other" });
        await insertReminder({
          tenantId: "tenant-b",
          conversationId: "private-b",
        });

        const rows = (
          await harness.pool.query(
            `SELECT tenant_id, user_id, message_id
             FROM ${reminders}
             WHERE message_id = 'private-message'
             ORDER BY tenant_id, user_id`,
          )
        ).rows;
        assert.deepEqual(rows, [
          {
            tenant_id: "tenant-a",
            user_id: "user-active",
            message_id: "private-message",
          },
          {
            tenant_id: "tenant-a",
            user_id: "user-other",
            message_id: "private-message",
          },
          {
            tenant_id: "tenant-b",
            user_id: "user-active",
            message_id: "private-message",
          },
        ]);
      });

      await freshTest.test("reschedules by revision and makes cancellation terminal", async () => {
        const rescheduled = (
          await harness.pool.query(
            `UPDATE ${reminders}
                SET remind_at = '2031-01-01T00:00:00Z',
                    reminder_revision = 2,
                    updated_at = '2030-02-01T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message'
            RETURNING remind_at, reminder_revision, status`,
          )
        ).rows[0];
        assert.deepEqual(
          {
            remindAt: rescheduled.remind_at.toISOString(),
            revision: Number(rescheduled.reminder_revision),
            status: rescheduled.status,
          },
          {
            remindAt: "2031-01-01T00:00:00.000Z",
            revision: 2,
            status: "active",
          },
        );

        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET remind_at = '2032-01-01T00:00:00Z',
                    reminder_revision = 4,
                    updated_at = '2030-03-01T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message'`,
          ),
          /revision must advance by exactly one/,
        );
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET remind_at = '2032-01-01T00:00:00Z',
                    reminder_revision = 3,
                    updated_at = '2030-01-15T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message'`,
          ),
          /updated_at must not move backwards/,
        );
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET status = 'cancelled',
                    remind_at = '2032-01-01T00:00:00Z',
                    cancelled_at = '2030-03-01T00:00:00Z',
                    reminder_revision = 3,
                    updated_at = '2030-03-01T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message'`,
          ),
          /terminal transition cannot reschedule/,
        );

        await harness.pool.query(
          `UPDATE ${reminders}
              SET status = 'cancelled',
                  cancelled_at = '2030-03-01T00:00:00Z',
                  reminder_revision = 3,
                  updated_at = '2030-03-01T00:00:00Z'
            WHERE tenant_id = 'tenant-a'
              AND user_id = 'user-active'
              AND message_id = 'private-message'`,
        );
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET status = 'active',
                    cancelled_at = NULL,
                    remind_at = '2032-01-01T00:00:00Z',
                    reminder_revision = 4,
                    updated_at = '2030-04-01T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message'`,
          ),
          /terminal state is immutable/,
        );
      });

      await freshTest.test("enforces delivered and cancelled exclusivity", async () => {
        await insertReminder({
          messageId: "private-message-two",
          remindAt: "2030-02-01T00:00:00Z",
        });
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET status = 'delivered',
                    delivered_at = '2030-02-02T00:00:00Z',
                    cancelled_at = '2030-02-02T00:00:00Z',
                    reminder_revision = 2,
                    updated_at = '2030-02-02T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message-two'`,
          ),
          /chat_message_reminders_lifecycle_check/,
        );
        await harness.pool.query(
          `UPDATE ${reminders}
              SET status = 'delivered',
                  delivered_at = '2030-02-02T00:00:00Z',
                  reminder_revision = 2,
                  updated_at = '2030-02-02T00:00:00Z'
            WHERE tenant_id = 'tenant-a'
              AND user_id = 'user-active'
              AND message_id = 'private-message-two'`,
        );
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET status = 'cancelled', delivered_at = NULL,
                    cancelled_at = '2030-02-03T00:00:00Z',
                    reminder_revision = 3,
                    updated_at = '2030-02-03T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-active'
                AND message_id = 'private-message-two'`,
          ),
          /terminal state is immutable/,
        );
      });

      await freshTest.test("rejects invalid references and inactive current visibility", async () => {
        await insertReminder({
          userId: "public-observer",
          messageId: "public-message",
          conversationId: "public-a",
        });
        for (const [messageId, conversationId] of [
          ["direct-message", "direct-a"],
          ["group-message", "group-a"],
          ["thread-message", "thread-a"],
        ]) {
          await insertReminder({ messageId, conversationId });
          await assert.rejects(
            insertReminder({ userId: "user-left", messageId, conversationId }),
            /current conversation visibility/,
          );
        }
        await assert.rejects(
          insertReminder({ userId: "user-left" }),
          /current conversation visibility/,
        );
        await assert.rejects(
          insertReminder({ userId: "user-missing" }),
          /current conversation visibility/,
        );
        await assert.rejects(
          insertReminder({
            tenantId: "tenant-a",
            messageId: "only-b-message",
            conversationId: "only-b",
          }),
          /current conversation visibility/,
        );
        await assert.rejects(
          insertReminder({ messageId: "missing-message" }),
          /chat_message_reminders_message_fkey/,
        );
        await assert.rejects(
          insertReminder({
            userId: "mismatch-user",
            messageId: "private-message",
            conversationId: "public-a",
          }),
          /chat_message_reminders_message_fkey/,
        );

        await harness.pool.query(
          `UPDATE ${members}
              SET state = 'removed', updated_at = clock_timestamp()
            WHERE tenant_id = 'tenant-a'
              AND conversation_id = 'private-a'
              AND user_id = 'user-other'`,
        );
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET remind_at = '2032-01-01T00:00:00Z',
                    reminder_revision = 2,
                    updated_at = '2030-02-01T00:00:00Z'
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'user-other'
                AND message_id = 'private-message'`,
          ),
          /current conversation visibility/,
        );
      });

      await freshTest.test("requires finite, ordered timestamps and bounded revisions", async () => {
        await assert.rejects(
          insertReminder({
            userId: "finite-one",
            messageId: "public-message",
            conversationId: "public-a",
            remindAt: "infinity",
          }),
          /chat_message_reminders_timestamp_order_check/,
        );
        await assert.rejects(
          insertReminder({
            userId: "finite-two",
            messageId: "public-message",
            conversationId: "public-a",
            remindAt: "2029-12-31T00:00:00Z",
          }),
          /chat_message_reminders_timestamp_order_check/,
        );
        await assert.rejects(
          insertReminder({
            userId: "finite-three",
            messageId: "public-message",
            conversationId: "public-a",
            updatedAt: "-infinity",
          }),
          /chat_message_reminders_timestamp_order_check/,
        );
        await assert.rejects(
          insertReminder({
            userId: "revision-zero",
            messageId: "public-message",
            conversationId: "public-a",
            revision: 0,
          }),
          /chat_message_reminders_revision_check/,
        );
        await assert.rejects(
          insertReminder({
            userId: "revision-too-large",
            messageId: "public-message",
            conversationId: "public-a",
            revision: "9007199254740992",
          }),
          /chat_message_reminders_revision_check/,
        );
        await assert.rejects(
          harness.pool.query(
            `UPDATE ${reminders}
                SET created_at = created_at - interval '1 second',
                    reminder_revision = reminder_revision + 1
              WHERE tenant_id = 'tenant-a'
                AND user_id = 'public-observer'
                AND message_id = 'public-message'`,
          ),
          /identities and creation timestamps are immutable/,
        );
      });

      await freshTest.test("uses the partial global due index and excludes terminal rows", async () => {
        await harness.pool.query(
          `INSERT INTO ${messages}
             (tenant_id, id, conversation_id, sequence, author_user_id,
              client_message_id, content)
           SELECT
             'tenant-a',
             'due-message-' || lpad(value::text, 4, '0'),
             'public-a',
             value + 1,
             'author-a',
             'due-client-' || value,
             jsonb_build_object('format', 'plain', 'text', 'Due ' || value)
           FROM generate_series(1, 760) AS value`,
        );
        await harness.pool.query(
          `INSERT INTO ${reminders}
             (tenant_id, user_id, message_id, conversation_id, remind_at,
              status, delivered_at, cancelled_at, created_at, updated_at)
           SELECT
             'tenant-a',
             'due-user-' || lpad(value::text, 4, '0'),
             'due-message-' || lpad(value::text, 4, '0'),
             'public-a',
             '2035-01-01T00:00:00Z'::timestamptz
               + value * interval '1 second',
             CASE
               WHEN value <= 600 THEN 'active'
               WHEN value <= 680 THEN 'delivered'
               ELSE 'cancelled'
             END,
             CASE WHEN value BETWEEN 601 AND 680
               THEN '2036-01-01T00:00:00Z'::timestamptz END,
             CASE WHEN value > 680
               THEN '2034-01-01T00:00:00Z'::timestamptz END,
             '2030-01-01T00:00:00Z'::timestamptz,
             CASE WHEN value > 600
               THEN '2036-01-01T00:00:00Z'::timestamptz
               ELSE '2030-01-01T00:00:00Z'::timestamptz END
           FROM generate_series(1, 760) AS value`,
        );

        const index = (
          await harness.pool.query(
            `SELECT pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
                    pg_catalog.pg_get_expr(index.indpred, index.indrelid) AS predicate
             FROM pg_catalog.pg_class AS index_relation
             INNER JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = index_relation.relnamespace
             INNER JOIN pg_catalog.pg_index AS index
               ON index.indexrelid = index_relation.oid
             WHERE namespace.nspname = $1
               AND index_relation.relname =
                 'chat_message_reminders_global_due_idx'`,
            [harness.schema],
          )
        ).rows[0];
        assert.match(
          index?.definition ?? "",
          /\(remind_at, tenant_id, user_id, message_id\).*INCLUDE \(conversation_id, reminder_revision, materialized_revision\)/,
        );
        assert.equal(index?.predicate, "(status = 'active'::text)");

        const client = await harness.pool.connect();
        try {
          await client.query(`ANALYZE ${reminders}`);
          await client.query("SET enable_seqscan = off");
          await client.query("SET enable_bitmapscan = off");

          const plan = await client.query(
            `EXPLAIN (FORMAT JSON)
             SELECT tenant_id, user_id, message_id, conversation_id,
                    reminder_revision
             FROM ${reminders}
             WHERE status = 'active'
               AND user_id LIKE 'due-user-%'
               AND remind_at <= '2040-01-01T00:00:00Z'
             ORDER BY remind_at, tenant_id, user_id, message_id
             LIMIT 25
             FOR UPDATE SKIP LOCKED`,
          );
          assert.ok(
            findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
              "chat_message_reminders_global_due_idx",
            ),
          );

          const dueRows = (
            await client.query(
              `SELECT message_id, status
               FROM ${reminders}
               WHERE status = 'active'
                 AND user_id LIKE 'due-user-%'
                 AND remind_at <= '2040-01-01T00:00:00Z'
               ORDER BY remind_at, tenant_id, user_id, message_id
               LIMIT 25`,
            )
          ).rows;
          assert.deepEqual(
            dueRows.map(({ message_id: messageId }) => messageId),
            Array.from(
              { length: 25 },
              (_, indexValue) =>
                `due-message-${String(indexValue + 1).padStart(4, "0")}`,
            ),
          );
          assert.ok(dueRows.every(({ status }) => status === "active"));

          const terminalPlan = await client.query(
            `EXPLAIN (FORMAT JSON)
             SELECT message_id
             FROM ${reminders}
             WHERE status IN ('delivered', 'cancelled')
             ORDER BY remind_at, tenant_id, user_id, message_id
             LIMIT 25`,
          );
          assert.equal(
            findIndexes(terminalPlan.rows[0]?.["QUERY PLAN"]).includes(
              "chat_message_reminders_global_due_idx",
            ),
            false,
          );
        } finally {
          await client.query("RESET enable_bitmapscan").catch(() => undefined);
          await client.query("RESET enable_seqscan").catch(() => undefined);
          client.release();
        }
      });
    });

    await t.test("upgrade reports coherent status and repeated apply is idempotent", async () => {
      const harness = await createHarness("reminders_upgrade");
      const schema = quoteIdentifier(harness.schema);
      const metadata = `${schema}._handrail_migrations`;
      const reminders = `${schema}.chat_message_reminders`;
      const oldRunner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: migrationsThrough0029,
      });

      const oldApply = await oldRunner.apply();
      assert.equal(oldApply.applied.at(-1)?.id, "0029-chat-message-search-vector");
      assert.equal(
        (
          await harness.pool.query(
            `SELECT to_regclass($1) AS relation`,
            [`${harness.schema}.chat_message_reminders`],
          )
        ).rows[0]?.relation,
        null,
      );

      const runner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: handrailChatPostgresMigrations,
      });
      const pending = await runner.status();
      assert.equal(pending.applied.length, 29);
      assert.deepEqual(pending.pending.map(({ id }) => id), [
        chatMessageRemindersMigration.id,
        chatMessageReminderNotificationsMigration.id,
        "0032-chat-conversation-preference-starred",
      ]);
      assert.deepEqual(pending.incompatible, []);

      const upgrade = await runner.apply();
      assert.deepEqual(upgrade.applied.map(({ id }) => id), [
        chatMessageRemindersMigration.id,
        chatMessageReminderNotificationsMigration.id,
        "0032-chat-conversation-preference-starred",
      ]);
      assert.equal(upgrade.status.applied.length, 32);
      assert.deepEqual(upgrade.status.pending, []);
      assert.deepEqual(upgrade.status.incompatible, []);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT to_regclass($1) AS relation`,
            [`${harness.schema}.chat_message_reminders`],
          )
        ).rows[0]?.relation,
        "chat_message_reminders",
      );

      const repeated = await runner.apply();
      assert.deepEqual(repeated.applied, []);
      assert.equal(repeated.status.applied.length, 32);
      assert.deepEqual(repeated.status.pending, []);
      assert.deepEqual(repeated.status.incompatible, []);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${metadata}
             WHERE id = $1 AND checksum = $2`,
            [
              chatMessageRemindersMigration.id,
              runner.migrations.find(
                ({ id }) => id === chatMessageRemindersMigration.id,
              )?.checksum,
            ],
          )
        ).rows[0]?.count,
        1,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count FROM ${reminders}`,
          )
        ).rows[0]?.count,
        0,
      );
    });
  } finally {
    await Promise.allSettled(harnesses.map((harness) => harness.teardown()));
    await backend.teardown();
  }
});
