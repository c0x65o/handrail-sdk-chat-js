import assert from "node:assert/strict";
import test from "node:test";

// Compile canonical sources into isolated output; never overwrite shared dist:
// node_modules/.bin/esbuild test/postgres-thread-lifecycle-schema.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/thread-lifecycle-schema-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/thread-lifecycle-schema-tests.mjs"
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { chatThreadLifecycleMigration, handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createThread } from "../src/server/create-thread-command.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";
import conversationContract from "../contracts/models/conversation.json" with { type: "json" };

const migrationIndex = handrailChatPostgresMigrations.indexOf(chatThreadLifecycleMigration);
const precedingMigrations = handrailChatPostgresMigrations.slice(0, migrationIndex);
const migrationsThroughLifecycle = handrailChatPostgresMigrations.slice(0, migrationIndex + 1);
const { minimum, maximum } = conversationContract.threadLifecycle.revisionValidation;

test("thread lifecycle migration is immutable and uniquely ordered after existing migrations", () => {
  assert.equal(chatThreadLifecycleMigration.id, "0043-chat-thread-lifecycle");
  assert.equal(chatThreadLifecycleMigration.order, 43);
  assert.equal(migrationIndex, 42);
  assert.equal(precedingMigrations.at(-1).id, "0042-chat-draft-replies");
  for (const value of [chatThreadLifecycleMigration, chatThreadLifecycleMigration.statements, handrailChatPostgresMigrations]) {
    assert.ok(Object.isFrozen(value));
  }
  const ids = handrailChatPostgresMigrations.map(({ id }) => id);
  const orders = handrailChatPostgresMigrations.map(({ order }) => order);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(orders).size, orders.length);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test("thread lifecycle storage supports fresh installation and populated legacy upgrade", async (t) => {
  const backend = await createPostgresTestBackend();
  t.diagnostic(`PostgreSQL backend: ${backend.kind}; isolated schemas, pool maximum 4`);
  try {
    for (const upgrade of [false, true]) {
      await t.test(upgrade ? "populated legacy upgrade" : "fresh installation", async (scenario) => {
        const harness = await backend.createHarness({ schemaPrefix: "thread_lifecycle" });
        const schema = `"${harness.schema.replaceAll('"', '""')}"`;
        const conversations = `${schema}.chat_conversations`;
        const query = (sql, values) => harness.pool.query(sql, values);
        const runner = createPostgresMigrationRunner({
          database: harness.pool, schema: harness.schema,
          migrations: upgrade ? migrationsThroughLifecycle : handrailChatPostgresMigrations,
        });
        const snapshot = async (omitLifecycle = false) => {
          const retained = {};
          for (const table of ["chat_conversations", "chat_messages", "chat_message_revisions",
            "chat_conversation_members", "chat_read_cursors", "chat_thread_follows",
            "chat_conversation_preferences", "chat_drafts", "chat_user_reply_style_preferences"]) {
            const projection = table === "chat_conversations" && omitLifecycle
              ? "to_jsonb(row) - 'closed_at' - 'closed_by_user_id' - 'locked'" : "to_jsonb(row)";
            retained[table] = (await query(`SELECT ${projection} AS data FROM ${schema}.${table} AS row ORDER BY to_jsonb(row)::text`)).rows;
          }
          return retained;
        };
        const seedHistory = async () => {
          await query(`INSERT INTO ${conversations}
            (tenant_id, id, type, visibility, name, lifecycle_revision, archived_at, archived_by_user_id) VALUES
            ('tenant', 'parent', 'channel', 'public', 'Launch', 7, NULL, NULL),
            ('tenant', 'direct', 'direct', 'private', NULL, 3, '2026-01-03Z', 'admin'),
            ('tenant', 'group', 'group_direct', 'private', NULL, 5, NULL, NULL)`);
          await query(`INSERT INTO ${schema}.chat_messages
            (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content) VALUES
            ('tenant', 'root', 'parent', 1, 'alice', 'root', '{"format":"plain","text":"Which launch date?"}'),
            ('tenant', 'fresh-root', 'parent', 2, 'alice', 'fresh-root', '{"format":"plain","text":"Another discussion"}')`);
          await query(`INSERT INTO ${conversations}
            (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id,
             lifecycle_revision, archived_at, archived_by_user_id, current_message_sequence) VALUES
            ('tenant', 'thread', 'thread', 'public', 'Launch dates', 'parent', 'root', 9, '2026-01-03Z', 'admin', 2)`);
          await query(`INSERT INTO ${schema}.chat_messages
            (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content,
             current_revision, created_at, updated_at, edited_at, edited_by_user_id, deleted_at, deleted_by_user_id) VALUES
            ('tenant', 'reply', 'thread', 1, 'bob', 'reply', '{"format":"plain","text":"Next Friday"}',
             2, '2026-01-01Z', '2026-01-02Z', '2026-01-02Z', 'bob', NULL, NULL),
            ('tenant', 'deleted', 'thread', 2, 'bob', 'deleted', NULL,
             1, '2026-01-01Z', '2026-01-02Z', NULL, NULL, '2026-01-02Z', 'bob')`);
          await query(`INSERT INTO ${schema}.chat_message_revisions
            (tenant_id, message_id, revision_number, content, created_by_user_id) VALUES
            ('tenant', 'reply', 1, '{"format":"plain","text":"Friday"}', 'bob'),
            ('tenant', 'reply', 2, '{"format":"plain","text":"Next Friday"}', 'bob'),
            ('tenant', 'deleted', 1, '{"format":"plain","text":"Retained history"}', 'bob')`);
          await query(`INSERT INTO ${schema}.chat_conversation_members
            (tenant_id, conversation_id, user_id, role, state) VALUES ('tenant', 'thread', 'bob', 'member', 'active')`);
          await query(`INSERT INTO ${schema}.chat_read_cursors
            (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
            VALUES ('tenant', 'thread', 'bob', 2, 1)`);
          await query(`INSERT INTO ${schema}.chat_thread_follows
            (tenant_id, conversation_id, user_id, is_following, follow_source)
            VALUES ('tenant', 'thread', 'bob', false, 'manual')`);
          await query(`INSERT INTO ${schema}.chat_conversation_preferences
            (tenant_id, conversation_id, user_id, notification_level)
            VALUES ('tenant', 'thread', 'bob', 'mentions')`);
          await query(`INSERT INTO ${schema}.chat_drafts
            (tenant_id, conversation_id, user_id, content, revision)
            VALUES ('tenant', 'thread', 'bob', '{"format":"plain","text":"Unsent"}', 4)`);
          await query(`INSERT INTO ${schema}.chat_user_reply_style_preferences
            (tenant_id, user_id, style, revision) VALUES ('tenant', 'bob', 'discord', 2)`);
        };
        const writeState = (closedAt, actor, locked, revision, id = "thread") => query(
          `UPDATE ${conversations} SET closed_at = $1, closed_by_user_id = $2, locked = $3,
             lifecycle_revision = $4 WHERE tenant_id = 'tenant' AND id = $5`,
          [closedAt, actor, locked, revision, id]);
        try {
          scenario.diagnostic(`PostgreSQL ${(await query("SHOW server_version")).rows[0].server_version}`);
          let before;
          if (upgrade) {
            await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema, migrations: precedingMigrations }).apply();
            await seedHistory();
            before = await snapshot(true);
          }
          const statusBefore = await runner.status();
          assert.deepEqual(statusBefore.incompatible, []);
          const applied = await runner.apply();
          assert.deepEqual(applied.applied.map(({ id }) => id),
            (upgrade ? [chatThreadLifecycleMigration] : handrailChatPostgresMigrations).map(({ id }) => id));
          assert.deepEqual(applied.status.pending, []);
          assert.deepEqual(applied.status.incompatible, []);
          if (upgrade) assert.deepEqual(await snapshot(true), before);
          else await seedHistory();

          await scenario.test("legacy rows and inserts default to open/unlocked without resetting archive or revision", async () => {
            const rows = (await query(`SELECT closed_at, closed_by_user_id, locked FROM ${conversations}`)).rows;
            assert.equal(rows.length, 4);
            assert.ok(rows.every((row) => row.closed_at === null && row.closed_by_user_id === null && row.locked === false));
            await query(`INSERT INTO ${conversations}
              (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
              VALUES ('tenant', 'new-thread', 'thread', 'public', 'parent', 'fresh-root')`);
            assert.deepEqual((await query(`SELECT closed_at, closed_by_user_id, locked, lifecycle_revision::text
              FROM ${conversations} WHERE id = 'new-thread'`)).rows,
            [{ closed_at: null, closed_by_user_id: null, locked: false, lifecycle_revision: "1" }]);
            assert.deepEqual((await query(`SELECT id, lifecycle_revision::text, archived_by_user_id FROM ${conversations}
              WHERE id IN ('thread', 'direct', 'parent', 'group') ORDER BY id`)).rows,
            [{ id: "direct", lifecycle_revision: "3", archived_by_user_id: "admin" },
              { id: "group", lifecycle_revision: "5", archived_by_user_id: null },
              { id: "parent", lifecycle_revision: "7", archived_by_user_id: null },
              { id: "thread", lifecycle_revision: "9", archived_by_user_id: "admin" }]);
          });

          await scenario.test("close, lock, unlock and reopen preserve history, private state and independent archive", async () => {
            const retained = await snapshot(true);
            const closedAt = "2026-02-01T12:34:56.123Z";
            let revision = 9;
            for (const [timestamp, actor, locked] of [
              [closedAt, "moderator", false], [closedAt, "moderator", true],
              [closedAt, "moderator", false], [null, null, false],
              [closedAt, "moderator", true], [closedAt, "moderator", false], [null, null, false],
            ]) {
              await writeState(timestamp, actor, locked, ++revision);
              const row = (await query(`SELECT closed_at, closed_by_user_id, locked, lifecycle_revision::text
                FROM ${conversations} WHERE id = 'thread'`)).rows[0];
              assert.deepEqual({ ...row, closed_at: row.closed_at?.toISOString() ?? null },
                { closed_at: timestamp, closed_by_user_id: actor, locked, lifecycle_revision: String(revision) });
              const expected = structuredClone(retained);
              expected.chat_conversations.find(({ data }) => data.id === "thread").data.lifecycle_revision = revision;
              assert.deepEqual(await snapshot(true), expected);
            }
          });

          for (const [name, timestamp, actor, locked, revision, failure] of [
            ["timestamp without actor", "2026-02-01Z", null, false, 2, { constraint: "chat_conversations_closure_pair_check" }],
            ["actor without timestamp", null, "moderator", false, 2, { constraint: "chat_conversations_closure_pair_check" }],
            ["open and locked", null, null, true, 2, { constraint: "chat_conversations_locked_closed_check" }],
            ["positive infinity", "infinity", "moderator", false, 2, { constraint: "chat_conversations_closed_at_check" }],
            ["negative infinity while locked", "-infinity", "moderator", true, 2, { constraint: "chat_conversations_closed_at_check" }],
            ["invalid timestamp", "not-a-timestamp", "moderator", false, 2, { code: "22007" }],
            ["zero revision while open", null, null, false, minimum - 1, { constraint: "chat_conversations_lifecycle_revision_check" }],
            ["negative revision while closed", "2026-02-01Z", "moderator", false, -1, { constraint: "chat_conversations_lifecycle_revision_check" }],
            ["unsafe revision while locked", "2026-02-01Z", "moderator", true, String(BigInt(maximum) + 1n), { constraint: "chat_conversations_lifecycle_revision_check" }],
            ["fractional revision", null, null, false, "1.5", { code: "22P02" }],
            ["null revision", null, null, false, null, { code: "23502", column: "lifecycle_revision" }],
            ["null lock", null, null, null, 2, { code: "23502", column: "locked" }],
          ]) {
            await scenario.test(`rejects ${name} atomically`, async () => {
              const retained = await snapshot();
              await assert.rejects(writeState(timestamp, actor, locked, revision), { code: "23514", ...failure });
              assert.deepEqual(await snapshot(), retained);
            });
          }
          await scenario.test("nonthreads reject closure/lock but retain archive/restore revision writes", async () => {
            for (const id of ["parent", "direct", "group"]) {
              for (const locked of [false, true]) {
                await assert.rejects(writeState("2026-02-01Z", "moderator", locked, 8, id),
                  { code: "23514", constraint: "chat_conversations_thread_lifecycle_check" });
              }
              for (const archived of [true, false]) {
                const result = await query(`UPDATE ${conversations}
                  SET archived_at = $1, archived_by_user_id = $2, lifecycle_revision = lifecycle_revision + 1
                  WHERE id = $3 RETURNING lifecycle_revision::text, closed_at, closed_by_user_id, locked`,
                [archived ? "2026-02-01Z" : null, archived ? "admin" : null, id]);
                assert.equal(result.rowCount, 1);
                assert.equal(result.rows[0].locked, false);
                assert.equal(result.rows[0].closed_at, null);
                assert.equal(result.rows[0].closed_by_user_id, null);
              }
            }
            for (const id of ["thread", "direct"]) {
              for (const revision of [minimum, maximum]) await writeState(null, null, false, String(revision), id);
            }
          });
          await scenario.test("retains one canonical thread per root under concurrent command reconciliation", async () => {
            // Root uniqueness is provided by command locking, not a SQL unique index.
            await query(`INSERT INTO ${schema}.chat_messages
              (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
              VALUES ('tenant', 'command-root', 'parent', 3, 'alice', 'command-root', '{"format":"plain","text":"New root"}')`);
            const command = (key) => createThread({
              database: harness.pool, schema: harness.schema,
              actor: { tenantId: "tenant", userId: "alice", roles: [] },
              permissions: { getCapabilities: async () => ["thread.create"], authorizeEntity: async () => true },
              input: { operation: "create_thread", parentConversationId: "parent", rootMessageId: "command-root", idempotencyKey: key },
            });
            const results = await Promise.all([command("left"), command("right")]);
            assert.deepEqual(results.map(({ reconciliationStatus }) => reconciliationStatus).sort(), ["created", "existing_for_root"]);
            assert.equal(results[0].conversation.conversation.id, results[1].conversation.conversation.id);
            assert.equal((await query(`SELECT count(*)::int AS count FROM ${conversations}
              WHERE tenant_id = 'tenant' AND parent_conversation_id = 'parent' AND root_message_id = 'command-root'`)).rows[0].count, 1);
            await assert.rejects(query(`DELETE FROM ${schema}.chat_messages WHERE id = 'command-root'`),
              { code: "23503", constraint: "chat_conversations_root_message_fkey" });
          });
          await scenario.test("migration reapplication preserves every resulting row and checksums", async () => {
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
