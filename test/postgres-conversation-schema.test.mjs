import assert from "node:assert/strict";
import test from "node:test";

// Bundle canonical sources without overwriting the shared dist directory:
// node_modules/.bin/esbuild test/postgres-conversation-schema.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/conversation-schema-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/conversation-schema-tests.mjs"
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import {
  chatThreadNamesMigration,
  handrailChatPostgresMigrations,
} from "../src/server/postgres-schema-migrations.ts";
import { createThread } from "../src/server/create-thread-command.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";
import conversationContract from "../contracts/models/conversation.json" with { type: "json" };

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const threadNamesIndex = handrailChatPostgresMigrations.indexOf(chatThreadNamesMigration);
const precedingMigrations = handrailChatPostgresMigrations.slice(0, threadNamesIndex);
const migrationsThroughThreadNames = handrailChatPostgresMigrations.slice(0, threadNamesIndex + 1);
const nameValidation = conversationContract.variants
  .find(({ name }) => name === "ThreadConversation").fields
  .find(({ name }) => name === "name").validation;

test("thread-name migration is immutable and registered in order", () => {
  assert.equal(chatThreadNamesMigration.id, "0040-chat-thread-names");
  assert.equal(chatThreadNamesMigration.order, 40);
  assert.equal(threadNamesIndex, 39);
  assert.equal(precedingMigrations.at(-1).id, "0039-chat-message-replies");
  assert.ok(Object.isFrozen(chatThreadNamesMigration));
  assert.ok(Object.isFrozen(chatThreadNamesMigration.statements));
  assert.ok(Object.isFrozen(handrailChatPostgresMigrations));
  const ids = handrailChatPostgresMigrations.map(({ id }) => id);
  const orders = handrailChatPostgresMigrations.map(({ order }) => order);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(orders).size, orders.length);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test("thread names support fresh installation and preserve legacy history on upgrade", async (t) => {
  const backend = await createPostgresTestBackend();
  t.diagnostic(`Postgres backend: ${backend.kind}; every scenario uses an isolated schema`);
  try {
    for (const upgrade of [false, true]) {
      await t.test(upgrade ? "populated upgrade" : "fresh installation", async (scenario) => {
        const harness = await backend.createHarness({ schemaPrefix: "thread_names" });
        const schema = quoteIdentifier(harness.schema);
        const conversations = `${schema}.chat_conversations`;
        const messages = `${schema}.chat_messages`;
        const query = (sql, values) => harness.pool.query(sql, values);
        const checkFailure = { code: "23514", constraint: "chat_conversations_thread_name_check" };
        const shapeFailure = { code: "23514", constraint: "chat_conversations_channel_shape_check" };
        const runner = createPostgresMigrationRunner({
          database: harness.pool, schema: harness.schema,
          migrations: upgrade ? migrationsThroughThreadNames : handrailChatPostgresMigrations,
        });
        let fixtureNumber = 0;
        // Every candidate gets an independent, valid root and unused thread ID.
        const newRoot = async (parent = "parent", tenant = "tenant-a") => {
          const id = `candidate-${++fixtureNumber}`;
          await query(`INSERT INTO ${messages}
            (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
            VALUES ($1, $2, $3, $4, 'alice', $2, '{"format":"plain","text":"Root"}')`,
          [tenant, id, parent, fixtureNumber + 10]);
          return id;
        };
        const insertThread = (root, name, overrides = {}) => query(`INSERT INTO ${conversations}
          (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id, entity_type, entity_id)
          VALUES ($1, $2, 'thread', 'public', $3, $4, $5, $6, $7) RETURNING name`, [
          overrides.tenant ?? "tenant-a", overrides.id ?? `thread-${root}`, name,
          overrides.parent === undefined ? "parent" : overrides.parent,
          overrides.root === undefined ? root : overrides.root,
          overrides.entityType ?? null, overrides.entityId ?? null,
        ]);
        const snapshot = async () => {
          const retained = {};
          for (const table of ["chat_conversations", "chat_messages", "chat_message_revisions",
            "chat_conversation_members", "chat_read_cursors", "chat_thread_follows", "chat_conversation_preferences"]) {
            // JSON preserves timestamp precision, including metadata not explicitly named here.
            retained[table] = (await query(`SELECT to_jsonb(row) AS data FROM ${schema}.${table} AS row
              ORDER BY to_jsonb(row)::text`)).rows;
          }
          return retained;
        };
        const seedHistory = async () => {
          await query(`INSERT INTO ${conversations}
            (tenant_id, id, type, visibility, name, current_message_sequence) VALUES
            ('tenant-a', 'parent', 'channel', 'public', 'Parent', 1),
            ('tenant-a', 'other-parent', 'channel', 'private', 'Other', 0),
            ('tenant-b', 'parent', 'channel', 'public', 'Other tenant', 0),
            ('tenant-b', 'tenant-b-parent', 'channel', 'public', 'Tenant B only', 0)`);
          await query(`INSERT INTO ${messages}
            (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content,
             created_at, updated_at) VALUES
            ('tenant-a', 'legacy-root', 'parent', 1, 'alice', 'legacy-root',
             '{"format":"plain","text":"Which launch date?"}', '2026-01-01Z', '2026-01-01Z')`);
          await query(`INSERT INTO ${conversations}
            (tenant_id, id, type, visibility, parent_conversation_id, root_message_id,
             current_message_sequence, lifecycle_revision, archived_at, archived_by_user_id, created_at, updated_at)
            VALUES ('tenant-a', 'legacy-thread', 'thread', 'public', 'parent', 'legacy-root',
              2, 3, '2026-01-03Z', 'alice', '2026-01-01Z', '2026-01-03Z')`);
          await query(`INSERT INTO ${messages}
            (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content,
             current_revision, created_at, updated_at, edited_at, edited_by_user_id, deleted_at, deleted_by_user_id)
            VALUES
            ('tenant-a', 'legacy-reply', 'legacy-thread', 1, 'bob', 'legacy-reply',
             '{"format":"markdown","text":"**Next Friday**"}', 2, '2026-01-01Z', '2026-01-02Z', '2026-01-02Z', 'bob', NULL, NULL),
            ('tenant-a', 'legacy-deleted', 'legacy-thread', 2, 'alice', 'legacy-deleted',
             NULL, 1, '2026-01-01Z', '2026-01-02Z', NULL, NULL, '2026-01-02Z', 'alice')`);
          await query(`INSERT INTO ${schema}.chat_message_revisions
            (tenant_id, message_id, revision_number, content, created_by_user_id, created_at) VALUES
            ('tenant-a', 'legacy-root', 1, '{"format":"plain","text":"Which launch date?"}', 'alice', '2026-01-01Z'),
            ('tenant-a', 'legacy-reply', 1, '{"format":"plain","text":"Friday"}', 'bob', '2026-01-01Z'),
            ('tenant-a', 'legacy-reply', 2, '{"format":"markdown","text":"**Next Friday**"}', 'bob', '2026-01-02Z'),
            ('tenant-a', 'legacy-deleted', 1, '{"format":"plain","text":"Retained revision"}', 'alice', '2026-01-01Z')`);
          await query(`INSERT INTO ${schema}.chat_conversation_members
            (tenant_id, conversation_id, user_id, role, state)
            VALUES ('tenant-a', 'legacy-thread', 'bob', 'member', 'active')`);
          await query(`INSERT INTO ${schema}.chat_read_cursors
            (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
            VALUES ('tenant-a', 'legacy-thread', 'bob', 2, 1)`);
          await query(`INSERT INTO ${schema}.chat_thread_follows
            (tenant_id, conversation_id, user_id, is_following, follow_source)
            VALUES ('tenant-a', 'legacy-thread', 'bob', true, 'reply')`);
          await query(`INSERT INTO ${schema}.chat_conversation_preferences
            (tenant_id, conversation_id, user_id, notification_level)
            VALUES ('tenant-a', 'legacy-thread', 'bob', 'mentions')`);
        };
        try {
          assert.equal((await query("SHOW server_encoding")).rows[0].server_encoding, "UTF8");
          let before;
          if (upgrade) {
            await createPostgresMigrationRunner({
              database: harness.pool, schema: harness.schema, migrations: precedingMigrations,
            }).apply();
            await seedHistory();
            const root = await newRoot();
            await assert.rejects(insertThread(root, "Previously rejected"), shapeFailure);
            before = await snapshot();
          }
          const applied = await runner.apply();
          assert.deepEqual(applied.applied.map(({ id }) => id),
            (upgrade ? [chatThreadNamesMigration] : handrailChatPostgresMigrations).map(({ id }) => id));
          assert.deepEqual(applied.status.pending, []);
          assert.deepEqual(applied.status.incompatible, []);
          if (!upgrade) await seedHistory();
          else assert.deepEqual(await snapshot(), before);
          assert.deepEqual((await query(`SELECT id, name FROM ${conversations} WHERE id = 'legacy-thread'`)).rows,
            [{ id: "legacy-thread", name: null }]);
          const beforeRepeat = await snapshot();
          assert.deepEqual((await runner.apply()).applied, []);
          assert.deepEqual(await snapshot(), beforeRepeat);

          await scenario.test("accepts NULL, scalar length boundaries and exact unnormalized content", async () => {
            const whitespace = String.fromCodePoint(...nameValidation.whitespaceCodePoints);
            for (const name of [null, "a", "a".repeat(100), "😀", "😀".repeat(100),
              "e\u0301".repeat(50), "Launch discussion", `a${whitespace}b`, "\u200B", "\u180E"]) {
              const root = await newRoot();
              assert.deepEqual((await insertThread(root, name)).rows, [{ name }]);
            }
          });
          await scenario.test("rejects empty and overlength names without other constraint failures", async () => {
            for (const name of ["", "a".repeat(101), "😀".repeat(101), "e\u0301".repeat(50) + "a"]) {
              const root = await newRoot();
              await assert.rejects(insertThread(root, name), checkFailure);
              assert.deepEqual((await insertThread(root, "Valid replacement")).rows, [{ name: "Valid replacement" }]);
            }
          });
          await scenario.test("rejects every contract whitespace code point alone and at either boundary", async () => {
            for (const codePoint of nameValidation.whitespaceCodePoints) {
              const space = String.fromCodePoint(codePoint);
              for (const name of [space, space.repeat(3), `${space}Launch`, `Launch${space}`]) {
                const root = await newRoot();
                await assert.rejects(insertThread(root, name), checkFailure);
                await insertThread(root, "Valid replacement");
              }
            }
          });
          await scenario.test("updates reject invalid names and never silently trim", async () => {
            const root = await newRoot();
            await insertThread(root, "Original");
            for (const name of ["", "\u0085New", "New\uFEFF", "😀".repeat(101)]) {
              await assert.rejects(query(`UPDATE ${conversations} SET name = $1 WHERE id = $2`,
                [name, `thread-${root}`]), checkFailure);
              assert.equal((await query(`SELECT name FROM ${conversations} WHERE id = $1`, [`thread-${root}`])).rows[0].name, "Original");
            }
            for (const name of ["Renamed", null]) {
              await query(`UPDATE ${conversations} SET name = $1 WHERE id = $2`, [name, `thread-${root}`]);
              assert.equal((await query(`SELECT name FROM ${conversations} WHERE id = $1`, [`thread-${root}`])).rows[0].name, name);
            }
          });
          await scenario.test("preserves channel requirements, DM names prohibition and non-channel entity prohibition", async () => {
            const insertConversation = (type, name, entityType = null, entityId = null) => query(`INSERT INTO ${conversations}
              (tenant_id, id, type, visibility, name, entity_type, entity_id)
              VALUES ('tenant-a', $1, $2, 'private', $3, $4, $5)`,
            [`shape-${++fixtureNumber}`, type, name, entityType, entityId]);
            await assert.rejects(insertConversation("channel", null), shapeFailure);
            // Existing channel semantics require only non-NULL; do not tighten them.
            for (const name of ["", " ", "x".repeat(101), "Channel"]) await insertConversation("channel", name);
            await insertConversation("channel", "Entity", "ticket", "ticket-1");
            await assert.rejects(insertConversation("channel", "Half entity", "ticket"),
              { code: "23514", constraint: "chat_conversations_entity_pair_check" });
            for (const type of ["direct", "group_direct"]) {
              await insertConversation(type, null);
              for (const name of ["Named", ""]) await assert.rejects(insertConversation(type, name), shapeFailure);
              for (const [entityType, entityId] of [["ticket", "ticket-1"], ["ticket", null], [null, "ticket-1"]]) {
                await assert.rejects(insertConversation(type, null, entityType, entityId), shapeFailure);
              }
            }
            for (const name of [null, "Named"]) {
              for (const [entityType, entityId] of [["ticket", "ticket-1"], ["ticket", null], [null, "ticket-1"]]) {
                const root = await newRoot();
                await assert.rejects(insertThread(root, name, { entityType, entityId }), shapeFailure);
                await insertThread(root, name);
              }
            }
          });
          await scenario.test("retains tenant, parent, root and conversation identity constraints", async () => {
            const localRoot = await newRoot();
            const otherRoot = await newRoot("other-parent");
            const foreignRoot = await newRoot("parent", "tenant-b");
            for (const [overrides, constraint] of [
              [{ parent: null }, "chat_conversations_thread_shape_check"],
              [{ root: null }, "chat_conversations_thread_shape_check"],
              [{ parent: "missing" }, "chat_conversations_parent_fkey"],
              [{ parent: "tenant-b-parent" }, "chat_conversations_parent_fkey"],
              [{ root: "missing" }, "chat_conversations_root_message_fkey"],
              [{ root: otherRoot }, "chat_conversations_root_message_fkey"],
              [{ root: foreignRoot }, "chat_conversations_root_message_fkey"],
              [{ tenant: "tenant-b" }, "chat_conversations_root_message_fkey"],
            ]) {
              await assert.rejects(insertThread(localRoot, "Valid", overrides), {
                code: constraint.endsWith("_fkey") ? "23503" : "23514", constraint,
              });
            }
            await insertThread(localRoot, "Valid");
            await assert.rejects(insertThread(localRoot, "Duplicate ID"),
              { code: "23505", constraint: "chat_conversations_pkey" });
            await insertThread(foreignRoot, "Other tenant", { tenant: "tenant-b" });
            await assert.rejects(query(`DELETE FROM ${messages} WHERE id = $1`, [localRoot]),
              { code: "23503", constraint: "chat_conversations_root_message_fkey" });
          });
          await scenario.test("existing command reconciles concurrent requests to one root thread", async () => {
            // The baseline implements root uniqueness with command locking, not a unique SQL index.
            const root = await newRoot();
            const command = (key) => createThread({
              database: harness.pool, schema: harness.schema,
              actor: { tenantId: "tenant-a", userId: "alice", roles: ["employee"] },
              permissions: { getCapabilities: async () => ["thread.create"], authorizeEntity: async () => true },
              input: { operation: "create_thread", parentConversationId: "parent", rootMessageId: root, idempotencyKey: key },
            });
            const results = await Promise.all([command("same-root-left"), command("same-root-right")]);
            assert.deepEqual(results.map(({ reconciliationStatus }) => reconciliationStatus).sort(), ["created", "existing_for_root"]);
            const id = results[0].conversation.conversation.id;
            assert.equal(results[1].conversation.conversation.id, id);
            await query(`UPDATE ${conversations} SET name = 'Named existing thread' WHERE id = $1`, [id]);
            const existing = await command("same-root-named");
            assert.equal(existing.reconciliationStatus, "existing_for_root");
            assert.equal(existing.conversation.conversation.id, id);
            assert.deepEqual((await query(`SELECT id, name FROM ${conversations}
              WHERE tenant_id = 'tenant-a' AND parent_conversation_id = 'parent' AND root_message_id = $1`, [root])).rows,
            [{ id, name: "Named existing thread" }]);
          });
          await scenario.test("repeat application preserves all resulting rows and migration status", async () => {
            const retained = await snapshot();
            const repeated = await runner.apply();
            assert.deepEqual(repeated.applied, []);
            assert.deepEqual(repeated.status, applied.status);
            assert.deepEqual(await snapshot(), retained);
          });
        } finally {
          await harness.teardown();
          assert.equal(await backend.schemaExists(harness.schema), false);
        }
      });
    }
  } finally {
    await backend.teardown();
  }
});

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

test("conversation and membership migration enforces tenant-scoped contracts", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_schema" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;

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

    await t.test("accepts every conversation, member role, and member state", async () => {
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            entity_type, entity_id, current_message_sequence)
         VALUES
           ('tenant-a', 'channel-a', 'channel', 'public', 'General',
            'work_order', 'work-order-1', 12),
           ('tenant-a', 'direct-a', 'direct', 'private', NULL,
            NULL, NULL, 0),
           ('tenant-a', 'group-a', 'group_direct', 'private', NULL,
            NULL, NULL, 3)`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         VALUES ('tenant-a', 'message-root-a', 'channel-a', 1, 'owner-user',
                 'client-root-a', '{"format":"plain","text":"Root"}')`,
      );
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility,
            parent_conversation_id, root_message_id)
         VALUES ('tenant-a', 'thread-a', 'thread', 'public',
                 'channel-a', 'message-root-a')`,
      );
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES
           ('tenant-a', 'channel-a', 'owner-user', 'owner', 'active'),
           ('tenant-a', 'channel-a', 'moderator-user', 'moderator', 'left'),
           ('tenant-a', 'channel-a', 'member-user', 'member', 'removed')`,
      );

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT id, type
             FROM ${conversations}
             WHERE tenant_id = 'tenant-a'
             ORDER BY id`,
          )
        ).rows,
        [
          { id: "channel-a", type: "channel" },
          { id: "direct-a", type: "direct" },
          { id: "group-a", type: "group_direct" },
          { id: "thread-a", type: "thread" },
        ],
      );

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT id, lifecycle_revision::integer AS lifecycle_revision
               FROM ${conversations}
              WHERE tenant_id = 'tenant-a'
              ORDER BY id`,
          )
        ).rows,
        [
          { id: "channel-a", lifecycle_revision: 1 },
          { id: "direct-a", lifecycle_revision: 1 },
          { id: "group-a", lifecycle_revision: 1 },
          { id: "thread-a", lifecycle_revision: 1 },
        ],
      );
    });

    await t.test("rejects cross-tenant references and duplicate membership", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${members}
             (tenant_id, conversation_id, user_id, role, state)
           VALUES ('tenant-b', 'channel-a', 'cross-tenant-user', 'member', 'active')`,
        ),
        /chat_conversation_members_conversation_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${conversations}
             (tenant_id, id, type, visibility,
              parent_conversation_id, root_message_id)
           VALUES ('tenant-b', 'thread-cross-tenant', 'thread', 'private',
                   'channel-a', 'message-cross-tenant')`,
        ),
        /chat_conversations_parent_fkey/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${members}
             (tenant_id, conversation_id, user_id, role, state)
           VALUES ('tenant-a', 'channel-a', 'owner-user', 'member', 'active')`,
        ),
        /chat_conversation_members_pkey/,
      );
    });

    await t.test("rejects malformed conversation and member values", async () => {
      const invalidConversationQueries = [
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility)
         VALUES ('tenant-a', 'channel-without-name', 'channel', 'public')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES ('tenant-a', 'named-direct', 'direct', 'private', 'Invalid')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, entity_type, entity_id)
         VALUES ('tenant-a', 'entity-direct', 'direct', 'private', 'ticket', 'ticket-1')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility)
         VALUES ('tenant-a', 'public-direct', 'direct', 'public')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility,
            parent_conversation_id)
         VALUES ('tenant-a', 'thread-without-root', 'thread', 'private', 'channel-a')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility,
            root_message_id)
         VALUES ('tenant-a', 'thread-without-parent', 'thread', 'private', 'message-a')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            parent_conversation_id, root_message_id)
         VALUES ('tenant-a', 'channel-with-thread-link', 'channel', 'private',
                 'Invalid', 'channel-a', 'message-a')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            entity_type)
         VALUES ('tenant-a', 'half-entity', 'channel', 'private', 'Invalid', 'ticket')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            current_message_sequence)
         VALUES ('tenant-a', 'negative-sequence', 'channel', 'private', 'Invalid', -1)`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            current_message_sequence)
         VALUES ('tenant-a', 'unsafe-sequence', 'channel', 'private',
                 'Invalid', 9007199254740992)`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name, lifecycle_revision)
         VALUES ('tenant-a', 'zero-lifecycle', 'channel', 'private',
                 'Invalid', 0)`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name, lifecycle_revision)
         VALUES ('tenant-a', 'unsafe-lifecycle', 'channel', 'private',
                 'Invalid', 9007199254740992)`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            archived_at)
         VALUES ('tenant-a', 'half-archive', 'channel', 'private', 'Invalid', now())`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            archived_by_user_id)
         VALUES ('tenant-a', 'half-archive-actor', 'channel', 'private',
                 'Invalid', 'archiver-user')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES ('tenant-a', 'invalid-type', 'broadcast', 'public', 'Invalid')`,
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES ('tenant-a', 'invalid-visibility', 'channel', 'secret', 'Invalid')`,
      ];

      for (const query of invalidConversationQueries) {
        await assert.rejects(harness.pool.query(query), /violates check constraint/);
      }

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${members}
             (tenant_id, conversation_id, user_id, role, state)
           VALUES ('tenant-a', 'channel-a', 'invalid-role', 'administrator', 'active')`,
        ),
        /chat_conversation_members_role_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${members}
             (tenant_id, conversation_id, user_id, role, state)
           VALUES ('tenant-a', 'channel-a', 'invalid-state', 'member', 'invited')`,
        ),
        /chat_conversation_members_state_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${members}
             (tenant_id, conversation_id, user_id, role, state, joined_at)
           VALUES ('tenant-a', 'channel-a', 'missing-joined-at', 'member', 'active', NULL)`,
        ),
        /joined_at/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${members}
             (tenant_id, conversation_id, user_id, role, state, updated_at)
           VALUES ('tenant-a', 'channel-a', 'missing-updated-at', 'member', 'active', NULL)`,
        ),
        /updated_at/,
      );
    });

    await t.test("keeps host users external while enforcing root-message identity", async () => {
      const foreignKeys = await harness.pool.query(
        `SELECT
           source.relname AS source_table,
           constraint_record.conname AS constraint_name,
           target.relname AS referenced_table
         FROM pg_catalog.pg_constraint AS constraint_record
         INNER JOIN pg_catalog.pg_class AS source
           ON source.oid = constraint_record.conrelid
         INNER JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = source.relnamespace
         INNER JOIN pg_catalog.pg_class AS target
           ON target.oid = constraint_record.confrelid
         WHERE namespace.nspname = $1
           AND source.relname IN ('chat_conversations', 'chat_conversation_members')
           AND constraint_record.contype = 'f'
         ORDER BY source.relname, constraint_record.conname`,
        [harness.schema],
      );

      assert.deepEqual(foreignKeys.rows, [
        {
          source_table: "chat_conversation_members",
          constraint_name: "chat_conversation_members_conversation_fkey",
          referenced_table: "chat_conversations",
        },
        {
          source_table: "chat_conversations",
          constraint_name: "chat_conversations_parent_fkey",
          referenced_table: "chat_conversations",
        },
        {
          source_table: "chat_conversations",
          constraint_name: "chat_conversations_root_message_fkey",
          referenced_table: "chat_messages",
        },
      ]);
    });

    await t.test("uses entity and per-user membership indexes", async () => {
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name,
            entity_type, entity_id)
         SELECT
           'lookup-tenant',
           'lookup-channel-' || value,
           'channel',
           'private',
           'Lookup ' || value,
           'ticket',
           'ticket-' || value
         FROM generate_series(1, 5000) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         SELECT
           'lookup-tenant',
           'lookup-channel-' || value,
           'lookup-user-' || (value % 250),
           'member',
           'active'
         FROM generate_series(1, 5000) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${conversations}`);
        await client.query(`ANALYZE ${members}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const entityPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id
           FROM ${conversations}
           WHERE tenant_id = 'lookup-tenant'
             AND entity_type = 'ticket'
             AND entity_id = 'ticket-4242'`,
        );
        const membershipPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT conversation_id
           FROM ${members}
           WHERE tenant_id = 'lookup-tenant'
             AND user_id = 'lookup-user-42'`,
        );

        assert.ok(
          findIndexes(entityPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_conversations_entity_idx",
          ),
        );
        assert.ok(
          findIndexes(membershipPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_conversation_members_user_idx",
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
