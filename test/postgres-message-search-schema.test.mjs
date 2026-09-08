import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresMigrationIncompatibilityError,
  chatMessageSearchVectorMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const messageSearchMigrationIndex = handrailChatPostgresMigrations.indexOf(
  chatMessageSearchVectorMigration,
);
const migrationThrough0028 = handrailChatPostgresMigrations.slice(
  0,
  messageSearchMigrationIndex,
);
const migrationThrough0029 = handrailChatPostgresMigrations.slice(
  0,
  messageSearchMigrationIndex + 1,
);

const findColumn = async (pool, schema, column) =>
  (
    await pool.query(
      `SELECT attribute.attgenerated,
              pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                AS data_type,
              pg_catalog.pg_get_expr(definition.adbin, definition.adrelid)
                AS generation_expression
       FROM pg_catalog.pg_attribute AS attribute
       INNER JOIN pg_catalog.pg_class AS relation
         ON relation.oid = attribute.attrelid
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef AS definition
         ON definition.adrelid = relation.oid
        AND definition.adnum = attribute.attnum
       WHERE namespace.nspname = $1
         AND relation.relname = 'chat_messages'
         AND attribute.attname = $2
         AND NOT attribute.attisdropped`,
      [schema, column],
    )
  ).rows[0];

const findIndex = async (pool, schema, indexName) =>
  (
    await pool.query(
      `SELECT access_method.amname AS access_method,
              pg_catalog.pg_get_indexdef(index_relation.oid) AS definition,
              pg_catalog.pg_get_expr(index.indpred, index.indrelid) AS predicate
       FROM pg_catalog.pg_class AS index_relation
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = index_relation.relnamespace
       INNER JOIN pg_catalog.pg_index AS index
         ON index.indexrelid = index_relation.oid
       INNER JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = index_relation.relam
       WHERE namespace.nspname = $1
         AND index_relation.relname = $2`,
      [schema, indexName],
    )
  ).rows[0];

test("message search-vector migration is immutable and registered after 0028", () => {
  assert.deepEqual(
    {
      id: chatMessageSearchVectorMigration.id,
      order: chatMessageSearchVectorMigration.order,
    },
    { id: "0029-chat-message-search-vector", order: 29 },
  );
  assert.equal(Object.isFrozen(chatMessageSearchVectorMigration), true);
  assert.equal(Object.isFrozen(chatMessageSearchVectorMigration.statements), true);
  assert.deepEqual(chatMessageSearchVectorMigration.statements, [
    `ALTER TABLE chat_messages
         ADD COLUMN search_vector tsvector
         GENERATED ALWAYS AS (
           to_tsvector('simple', COALESCE(content ->> 'text', ''))
         ) STORED`,
    `CREATE INDEX chat_messages_search_vector_idx
         ON chat_messages USING GIN (search_vector)
         WHERE deleted_at IS NULL`,
  ]);
  assert.equal(
    handrailChatPostgresMigrations[messageSearchMigrationIndex],
    chatMessageSearchVectorMigration,
  );
  assert.equal(
    migrationThrough0028.at(-1)?.id,
    "0028-chat-outbox-expiry-cleanup",
  );
});

test("message search-vector migration supports fresh installs and 0028 upgrades", async (t) => {
  const backend = await createPostgresTestBackend();
  const harnesses = [];

  const createHarness = async (schemaPrefix) => {
    const harness = await backend.createHarness({ schemaPrefix });
    harnesses.push(harness);
    return harness;
  };

  try {
    await t.test("fresh install indexes only scoped, non-deleted message text", async () => {
      const harness = await createHarness("message_search_fresh");
      const schema = quoteIdentifier(harness.schema);
      const conversations = `${schema}.chat_conversations`;
      const messages = `${schema}.chat_messages`;
      const runner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: migrationThrough0029,
      });

      const before = await runner.status();
      assert.deepEqual(before.applied, []);
      assert.deepEqual(
        before.pending.map(({ id }) => id),
        migrationThrough0029.map(({ id }) => id),
      );
      assert.deepEqual(before.incompatible, []);

      const firstApply = await runner.apply();
      assert.deepEqual(
        firstApply.applied.at(-1) && {
          id: firstApply.applied.at(-1).id,
          order: firstApply.applied.at(-1).order,
        },
        { id: "0029-chat-message-search-vector", order: 29 },
      );
      assert.deepEqual(firstApply.status.pending, []);
      assert.deepEqual(firstApply.status.incompatible, []);

      const column = await findColumn(
        harness.pool,
        harness.schema,
        "search_vector",
      );
      assert.equal(column?.attgenerated, "s");
      assert.equal(column?.data_type, "tsvector");
      assert.match(column?.generation_expression ?? "", /to_tsvector\('simple'/);
      assert.match(
        column?.generation_expression ?? "",
        /content ->> 'text'/,
      );

      const index = await findIndex(
        harness.pool,
        harness.schema,
        "chat_messages_search_vector_idx",
      );
      assert.equal(index?.access_method, "gin");
      assert.match(index?.definition ?? "", /USING gin \(search_vector\)/);
      assert.equal(index?.predicate, "(deleted_at IS NULL)");

      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES
           ('tenant-a', 'conversation-one', 'channel', 'private', 'One'),
           ('tenant-a', 'conversation-two', 'channel', 'private', 'Two'),
           ('tenant-b', 'conversation-one', 'channel', 'private', 'Other tenant')`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         VALUES
           ('tenant-a', 'plain-a', 'conversation-one', 1, 'author-a',
            'client-plain-a',
            '{"format":"plain","text":"Plain launch checklist","metadata":{"secret":"hiddenmeteor"}}'),
           ('tenant-a', 'markdown-a', 'conversation-one', 2, 'author-a',
            'client-markdown-a',
            '{"format":"markdown","text":"**Nebula** release notes"}'),
           ('tenant-a', 'other-conversation', 'conversation-two', 1, 'author-a',
            'client-other-conversation',
            '{"format":"plain","text":"Nebula elsewhere"}'),
           ('tenant-b', 'other-tenant', 'conversation-one', 1, 'author-b',
            'client-other-tenant',
            '{"format":"plain","text":"Nebula in another tenant"}')`,
      );

      const search = async (tenantId, conversationId, query) =>
        (
          await harness.pool.query(
            `SELECT id
             FROM ${messages}
             WHERE tenant_id = $1
               AND conversation_id = $2
               AND deleted_at IS NULL
               AND search_vector @@ pg_catalog.plainto_tsquery('simple', $3)
             ORDER BY sequence`,
            [tenantId, conversationId, query],
          )
        ).rows.map(({ id }) => id);

      assert.deepEqual(
        await search("tenant-a", "conversation-one", "launch"),
        ["plain-a"],
      );
      assert.deepEqual(
        await search("tenant-a", "conversation-one", "nebula"),
        ["markdown-a"],
      );
      assert.deepEqual(
        await search("tenant-a", "conversation-two", "nebula"),
        ["other-conversation"],
      );
      assert.deepEqual(
        await search("tenant-b", "conversation-one", "nebula"),
        ["other-tenant"],
      );
      assert.deepEqual(
        await search("tenant-a", "conversation-one", "hiddenmeteor"),
        [],
      );

      await harness.pool.query(
        `UPDATE ${messages}
         SET content = '{"format":"plain","text":"Revised quasar checklist"}',
             current_revision = current_revision + 1,
             edited_at = clock_timestamp(),
             edited_by_user_id = 'editor-a',
             updated_at = clock_timestamp()
         WHERE tenant_id = 'tenant-a' AND id = 'plain-a'`,
      );
      assert.deepEqual(
        await search("tenant-a", "conversation-one", "launch"),
        [],
      );
      assert.deepEqual(
        await search("tenant-a", "conversation-one", "quasar"),
        ["plain-a"],
      );

      await harness.pool.query(
        `UPDATE ${messages}
         SET content = NULL,
             deleted_at = clock_timestamp(),
             deleted_by_user_id = 'author-a',
             updated_at = clock_timestamp()
         WHERE tenant_id = 'tenant-a' AND id = 'markdown-a'`,
      );
      assert.deepEqual(
        await search("tenant-a", "conversation-one", "nebula"),
        [],
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT search_vector = ''::tsvector AS empty
             FROM ${messages}
             WHERE tenant_id = 'tenant-a' AND id = 'markdown-a'`,
          )
        ).rows[0]?.empty,
        true,
      );
    });

    await t.test("upgrade reports coherent status and repeated apply is idempotent", async () => {
      const harness = await createHarness("message_search_upgrade");
      const schema = quoteIdentifier(harness.schema);
      const metadata = `${schema}._handrail_migrations`;
      const oldRunner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: migrationThrough0028,
      });
      const oldApply = await oldRunner.apply();
      assert.equal(oldApply.applied.at(-1)?.id, "0028-chat-outbox-expiry-cleanup");
      assert.equal(
        await findColumn(harness.pool, harness.schema, "search_vector"),
        undefined,
      );

      const runner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: migrationThrough0029,
      });
      const pending = await runner.status();
      assert.equal(pending.applied.length, 28);
      assert.deepEqual(pending.pending.map(({ id }) => id), [
        chatMessageSearchVectorMigration.id,
      ]);
      assert.deepEqual(pending.incompatible, []);

      const upgrade = await runner.apply();
      assert.deepEqual(upgrade.applied.map(({ id }) => id), [
        chatMessageSearchVectorMigration.id,
      ]);
      assert.equal(upgrade.status.applied.length, 29);
      assert.deepEqual(upgrade.status.pending, []);
      assert.deepEqual(upgrade.status.incompatible, []);

      const repeated = await runner.apply();
      assert.deepEqual(repeated.applied, []);
      assert.equal(repeated.status.applied.length, 29);
      assert.deepEqual(repeated.status.pending, []);
      assert.deepEqual(repeated.status.incompatible, []);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${metadata}
             WHERE id = $1 AND checksum = $2`,
            [
              chatMessageSearchVectorMigration.id,
              runner.migrations.at(-1)?.checksum,
            ],
          )
        ).rows[0]?.count,
        1,
      );

      const incompatibleRunner = createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: [
          ...migrationThrough0028,
          {
            ...chatMessageSearchVectorMigration,
            statements: [...chatMessageSearchVectorMigration.statements, "SELECT 1"],
          },
        ],
      });
      const incompatible = await incompatibleRunner.status();
      assert.equal(incompatible.applied.length, 28);
      assert.deepEqual(incompatible.pending, []);
      assert.deepEqual(
        incompatible.incompatible.map(({ id, reason }) => ({ id, reason })),
        [
          {
            id: chatMessageSearchVectorMigration.id,
            reason: "checksum_mismatch",
          },
        ],
      );
      await assert.rejects(
        incompatibleRunner.apply(),
        (error) => error instanceof PostgresMigrationIncompatibilityError,
      );
    });

    await t.test("a failed 0029-style apply rolls back schema and metadata", async () => {
      const harness = await createHarness("message_search_rollback");
      const schema = quoteIdentifier(harness.schema);
      const metadata = `${schema}._handrail_migrations`;
      await createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: migrationThrough0028,
      }).apply();

      const failingMigration = {
        id: "0029-chat-message-search-vector-failing-test",
        order: 29,
        statements: [
          chatMessageSearchVectorMigration.statements[0],
          `CREATE INDEX invalid_message_search_idx
             ON chat_messages USING GIN (column_that_does_not_exist)`,
        ],
      };
      await assert.rejects(
        createPostgresMigrationRunner({
          database: harness.pool,
          schema: harness.schema,
          migrations: [...migrationThrough0028, failingMigration],
        }).apply(),
        /column_that_does_not_exist/,
      );
      assert.equal(
        await findColumn(harness.pool, harness.schema, "search_vector"),
        undefined,
      );
      assert.equal(
        await findIndex(harness.pool, harness.schema, "invalid_message_search_idx"),
        undefined,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count FROM ${metadata} WHERE id = $1`,
            [failingMigration.id],
          )
        ).rows[0]?.count,
        0,
      );

      const recovery = await createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: migrationThrough0029,
      }).status();
      assert.equal(recovery.applied.length, 28);
      assert.deepEqual(recovery.pending.map(({ id }) => id), [
        chatMessageSearchVectorMigration.id,
      ]);
      assert.deepEqual(recovery.incompatible, []);
    });
  } finally {
    await Promise.allSettled(harnesses.map((harness) => harness.teardown()));
    await backend.teardown();
  }
});
