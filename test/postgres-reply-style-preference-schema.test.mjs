import assert from "node:assert/strict";
import test from "node:test";

// Execute canonical sources without overwriting shared dist:
// node_modules/.bin/esbuild test/postgres-reply-style-preference-schema.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/reply-style-preference-schema-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/reply-style-preference-schema-tests.mjs"
// node_modules/.bin/tsc --project tsconfig.message-reply-schema-type-tests.json
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import {
  chatUserReplyStylePreferencesMigration,
  handrailChatPostgresMigrations,
} from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const migration = chatUserReplyStylePreferencesMigration;
const migrationIndex = handrailChatPostgresMigrations.indexOf(migration);
const precedingMigrations = handrailChatPostgresMigrations.slice(0, migrationIndex);
const migrationsThroughPreference = handrailChatPostgresMigrations.slice(0, migrationIndex + 1);
const tableName = "chat_user_reply_style_preferences";

test("reply-style migration is immutable, uniquely registered and ordered", () => {
  assert.equal(migration.id, "0041-chat-user-reply-style-preferences");
  assert.equal(migration.order, 41);
  assert.equal(migrationIndex, 40);
  assert.equal(precedingMigrations.at(-1).id, "0040-chat-thread-names");
  assert.ok(Object.isFrozen(migration));
  assert.ok(Object.isFrozen(migration.statements));
  assert.ok(Object.isFrozen(handrailChatPostgresMigrations));
  const ids = handrailChatPostgresMigrations.map(({ id }) => id);
  const orders = handrailChatPostgresMigrations.map(({ order }) => order);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(orders).size, orders.length);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test("reply-style storage supports fresh installation and legacy upgrade", async (t) => {
  const backend = await createPostgresTestBackend();
  t.diagnostic(`PostgreSQL harness: ${backend.kind}`);
  try {
    for (const upgrade of [false, true]) {
      await t.test(upgrade ? "upgrade with legacy preferences and follows" : "fresh installation", async (scenario) => {
        const harness = await backend.createHarness({ schemaPrefix: "reply_style_preferences" });
        try {
          const schema = `"${harness.schema.replaceAll('"', '""')}"`;
          const preferences = `${schema}.${tableName}`;
          const readPreferences = async () => (await harness.pool.query(
            `SELECT * FROM ${preferences} ORDER BY tenant_id, user_id`,
          )).rows;
          const readLegacy = async () => ({
            preferences: (await harness.pool.query(`SELECT * FROM ${schema}.chat_conversation_preferences ORDER BY tenant_id, conversation_id, user_id`)).rows,
            follows: (await harness.pool.query(`SELECT * FROM ${schema}.chat_thread_follows ORDER BY tenant_id, conversation_id, user_id`)).rows,
          });
          const insertLegacy = async () => {
            await harness.pool.query(`INSERT INTO ${schema}.chat_conversations
              (tenant_id, id, type, visibility, name)
              VALUES ('tenant-a', 'channel', 'channel', 'public', 'Legacy channel')`);
            await harness.pool.query(`INSERT INTO ${schema}.chat_messages
              (tenant_id, conversation_id, id, sequence, author_user_id, client_message_id, content)
              VALUES ('tenant-a', 'channel', 'root', 1, 'alice', 'root', '{"format":"plain","text":"Legacy root"}')`);
            await harness.pool.query(`INSERT INTO ${schema}.chat_conversations
              (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
              VALUES ('tenant-a', 'thread', 'thread', 'public', 'channel', 'root')`);
            await harness.pool.query(`INSERT INTO ${schema}.chat_conversation_members
              (tenant_id, conversation_id, user_id, role, state)
              VALUES ('tenant-a', 'channel', 'alice', 'member', 'active')`);
            await harness.pool.query(`INSERT INTO ${schema}.chat_conversation_preferences
              (tenant_id, conversation_id, user_id, notification_level, muted, is_starred, preference_revision)
              VALUES ('tenant-a', 'channel', 'alice', 'mentions', true, true, 7)`);
            await harness.pool.query(`INSERT INTO ${schema}.chat_thread_follows
              (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
              VALUES ('tenant-a', 'thread', 'alice', true, 'manual', 3)`);
          };
          const runner = createPostgresMigrationRunner({
            database: harness.pool,
            schema: harness.schema,
            migrations: upgrade ? migrationsThroughPreference : handrailChatPostgresMigrations,
          });
          let legacyBefore;
          if (upgrade) {
            await createPostgresMigrationRunner({
              database: harness.pool,
              schema: harness.schema,
              migrations: precedingMigrations,
            }).apply();
            await insertLegacy();
            legacyBefore = await readLegacy();
            assert.equal((await harness.pool.query("SELECT to_regclass($1) AS relation", [`${schema}.${tableName}`])).rows[0].relation, null);
          }
          const before = await runner.status();
          assert.deepEqual(before.incompatible, []);
          assert.deepEqual(before.pending.map(({ id }) => id),
            (upgrade ? [migration] : handrailChatPostgresMigrations).map(({ id }) => id));
          const applied = await runner.apply();
          assert.deepEqual(applied.applied.map(({ id }) => id), before.pending.map(({ id }) => id));
          assert.deepEqual(applied.status.pending, []);
          assert.deepEqual(applied.status.incompatible, []);
          if (!upgrade) {
            await insertLegacy();
            legacyBefore = await readLegacy();
          }
          await scenario.test("absence stays no row and legacy preference/follow data is unchanged", async () => {
            assert.deepEqual(await readPreferences(), []);
            assert.deepEqual(await readLegacy(), legacyBefore);
          });
          await scenario.test("schema has only the tenant/user key and required typed preference fields", async () => {
            const columns = (await harness.pool.query(`SELECT column_name, data_type, is_nullable, column_default
              FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
              ORDER BY ordinal_position`, [harness.schema, tableName])).rows;
            assert.deepEqual(columns, [
              { column_name: "tenant_id", data_type: "text", is_nullable: "NO", column_default: null },
              { column_name: "user_id", data_type: "text", is_nullable: "NO", column_default: null },
              { column_name: "style", data_type: "text", is_nullable: "NO", column_default: null },
              { column_name: "revision", data_type: "bigint", is_nullable: "NO", column_default: null },
              { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "clock_timestamp()" },
            ]);
            const keys = (await harness.pool.query(`SELECT contype, pg_get_constraintdef(oid) AS definition
              FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'f')`,
              [`${schema}.${tableName}`])).rows;
            assert.deepEqual(keys, [{ contype: "p", definition: "PRIMARY KEY (tenant_id, user_id)" }]);
          });
          const insert = (tenant, user, style, revision) => harness.pool.query(
            `INSERT INTO ${preferences} (tenant_id, user_id, style, revision) VALUES ($1, $2, $3, $4)`,
            [tenant, user, style, revision],
          );
          await scenario.test("both styles and safe revision boundaries work without local memberships", async () => {
            await insert("tenant-a", "alice", "current", "1");
            await insert("tenant-b", "alice", "discord", "9007199254740991");
            await insert("tenant-a", "bob", "discord", "9007199254740990");
            assert.deepEqual((await readPreferences()).map(({ updated_at, ...row }) => row), [
              { tenant_id: "tenant-a", user_id: "alice", style: "current", revision: "1" },
              { tenant_id: "tenant-a", user_id: "bob", style: "discord", revision: "9007199254740990" },
              { tenant_id: "tenant-b", user_id: "alice", style: "discord", revision: "9007199254740991" },
            ]);
            const others = (await readPreferences()).filter((row) => row.tenant_id !== "tenant-a" || row.user_id !== "alice");
            await harness.pool.query(`UPDATE ${preferences} SET style = 'discord', revision = 2,
              updated_at = '2030-01-01T03:00:00+03:00'
              WHERE tenant_id = 'tenant-a' AND user_id = 'alice'`);
            assert.deepEqual((await readPreferences()).filter((row) => row.tenant_id !== "tenant-a" || row.user_id !== "alice"), others);
            const alice = (await readPreferences())[0];
            assert.equal(alice.style, "discord");
            assert.equal(alice.revision, "2");
            assert.equal(alice.updated_at.toISOString(), "2030-01-01T00:00:00.000Z");
          });
          await scenario.test("duplicate tenant/user is rejected even with a different style", async () => {
            await assert.rejects(insert("tenant-a", "alice", "current", "3"),
              { code: "23505", constraint: `${tableName}_pkey` });
          });
          for (const style of ["", "future-style", "Current", " discord", "discord "]) {
            await scenario.test(`rejects unsupported style ${JSON.stringify(style)}`, async () => {
              await assert.rejects(insert("invalid", "style", style, "1"),
                { code: "23514", constraint: `${tableName}_style_check` });
            });
          }
          for (const revision of ["0", "-1", "9007199254740992"]) {
            await scenario.test(`rejects out-of-range revision ${revision}`, async () => {
              await assert.rejects(insert("invalid", "revision", "current", revision),
                { code: "23514", constraint: `${tableName}_revision_check` });
            });
          }
          await scenario.test("bigint rejects fractional revision input", async () => {
            await assert.rejects(insert("invalid", "revision", "current", "1.5"), { code: "22P02" });
          });
          for (const column of ["tenant_id", "user_id"]) {
            await scenario.test(`${column} uses established nonblank 255-byte host identity limits`, async () => {
              for (const invalid of ["", " \t\n", "a".repeat(256), "é".repeat(128)]) {
                await assert.rejects(insert(
                  column === "tenant_id" ? invalid : "valid-tenant",
                  column === "user_id" ? invalid : "valid-user", "current", "1",
                ), { code: "23514", constraint: `${tableName}_${column}_check` });
              }
              for (const valid of ["a".repeat(255), "é".repeat(127) + "a"]) {
                await insert(column === "tenant_id" ? valid : "valid-tenant",
                  column === "user_id" ? valid : "valid-user", "current", "1");
              }
            });
          }
          for (const column of ["tenant_id", "user_id", "style", "revision", "updated_at"]) {
            await scenario.test(`rejects null ${column}`, async () => {
              const row = { tenant_id: "invalid", user_id: "null", style: "current", revision: "1", updated_at: "2030-01-01T00:00:00Z" };
              row[column] = null;
              await assert.rejects(harness.pool.query(`INSERT INTO ${preferences}
                (tenant_id, user_id, style, revision, updated_at) VALUES ($1, $2, $3, $4, $5)`,
                Object.values(row)), { code: "23502", column });
            });
          }
          await scenario.test("timestamp defaults to database wall clock and rejects nonfinite/invalid timestamps", async () => {
            const start = (await harness.pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
            await insert("timestamp", "default", "current", "1");
            const end = (await harness.pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
            const row = (await harness.pool.query(`SELECT updated_at FROM ${preferences} WHERE tenant_id = 'timestamp'`)).rows[0];
            assert.ok(row.updated_at instanceof Date);
            assert.ok(row.updated_at >= start && row.updated_at <= end);
            for (const value of ["-infinity", "infinity"]) {
              await assert.rejects(harness.pool.query(`UPDATE ${preferences} SET updated_at = $1 WHERE tenant_id = 'timestamp'`, [value]),
                { code: "23514", constraint: `${tableName}_updated_at_check` });
            }
            await assert.rejects(harness.pool.query(`UPDATE ${preferences} SET updated_at = 'invalid' WHERE tenant_id = 'timestamp'`),
              { code: "22007" });
          });
          await scenario.test("updates enforce style and revision constraints", async () => {
            for (const [column, value] of [["style", "future-style"], ["revision", "0"], ["revision", "9007199254740992"]]) {
              await assert.rejects(harness.pool.query(`UPDATE ${preferences} SET ${column} = $1 WHERE tenant_id = 'tenant-a' AND user_id = 'alice'`, [value]),
                { code: "23514", constraint: `${tableName}_${column}_check` });
            }
          });
          await scenario.test("repeat migration preserves all preferences, follows and migration history", async () => {
            const saved = await readPreferences();
            const repeated = await runner.apply();
            assert.deepEqual(repeated.applied, []);
            assert.deepEqual(repeated.status, applied.status);
            assert.deepEqual(await readPreferences(), saved);
            assert.deepEqual(await readLegacy(), legacyBefore);
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
