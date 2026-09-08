import assert from "node:assert/strict";
import test from "node:test";

// Fresh canonical sources, no shared dist or broad build (run suites sequentially):
// node_modules/.bin/esbuild test/postgres-thread-participant.test.mjs test/postgres-create-thread-command.test.mjs test/postgres-thread-access.test.mjs --bundle --platform=node --format=esm --packages=external --out-extension:.js=.mjs --outdir=node_modules/.cache
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/postgres-thread-participant.test.mjs" "$PWD/node_modules/.cache/postgres-create-thread-command.test.mjs" "$PWD/node_modules/.cache/postgres-thread-access.test.mjs"
import { ensureThreadParticipant } from "../src/server/thread-participant.ts";
import { authorizeThreadAccess } from "../src/server/thread-access.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = Object.freeze({ tenantId: "tenant-a", userId: "participant", roles: [] });

test("retained thread participant setup uses current authority and caller transactions", async (t) => {
  const backend = await createPostgresTestBackend(); // Unavailable PostgreSQL fails, never skips.
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_thread_participant" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({
      database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);
    let hostAllowed = true;
    const entityCalls = [];
    const permissions = {
      async authorizeEntity(request) {
        entityCalls.push(request);
        return hostAllowed;
      },
    };
    const seed = async (id, { visibility = "public", entity = false } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ('tenant-a', $1, 'channel', $2, $1, $3, $4)`,
      [`${id}-parent`, visibility, entity ? "case" : null, entity ? "host-case" : null]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant-a', $1, $2, 1, 'author', $1, '{"format":"plain","text":"root"}')`,
      [`${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
        VALUES ('tenant-a', $1, 'thread', $2, $3, $4)`,
      [id, visibility, `${id}-parent`, `${id}-root`]);
    };
    const member = (id, state = "active") => sql(`INSERT INTO ${prefix}.chat_conversation_members
      (tenant_id, conversation_id, user_id, role, state)
      VALUES ('tenant-a', $1, 'participant', 'moderator', $2)
      ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET state = EXCLUDED.state`, [id, state]);
    const setup = async (connection, id, overrides = {}) => {
      const timestamp = await connection.query("SELECT clock_timestamp() AS now");
      await ensureThreadParticipant({
        connection, schema: harness.schema, actor, threadId: id,
        parentConversationId: `${id}-parent`, permissions, entityAction: "thread.create",
        initialRole: "member", occurredAt: timestamp.rows[0].now.toISOString(), ...overrides,
      });
    };
    const transaction = async (work) => {
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN");
        await work(connection);
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    };
    const enroll = (id, overrides) => transaction((connection) => setup(connection, id, overrides));
    const snapshot = async (id) => {
      const result = {};
      for (const table of ["chat_conversation_members", "chat_read_cursors", "chat_conversation_preferences", "chat_drafts", "chat_thread_follows"]) {
        result[table] = (await sql(`SELECT * FROM ${prefix}.${table}
          WHERE tenant_id = 'tenant-a' AND conversation_id = $1 AND user_id = 'participant'`, [id])).rows;
      }
      return result;
    };
    const retained = (snapshot) => ({
      ...snapshot,
      chat_conversation_members: snapshot.chat_conversation_members.map(({ state, updated_at, ...row }) => row),
    });

    await t.test("first enrollment creates only required rows; repeated legacy setup never follows", async () => {
      await seed("first");
      await enroll("first", { initialRole: "owner" });
      const first = await snapshot("first");
      assert.equal(first.chat_conversation_members[0].role, "owner");
      assert.equal(first.chat_conversation_members[0].state, "active");
      assert.equal(first.chat_read_cursors[0].last_read_sequence, "0");
      assert.equal(first.chat_conversation_preferences[0].notification_level, "all");
      assert.equal(first.chat_conversation_preferences[0].muted, false);
      assert.deepEqual(first.chat_thread_follows, []);
      assert.deepEqual(first.chat_drafts, []);
      await enroll("first");
      assert.deepEqual(retained(await snapshot("first")), retained(first));
      await member("first", "left");
      await enroll("first");
      assert.deepEqual(retained(await snapshot("first")), retained(first));
      assert.equal((await snapshot("first")).chat_conversation_members[0].state, "active");
    });

    for (const following of [true, false]) {
      await t.test(`repeat/reactivation retains all private state and follow=${following} revision`, async () => {
        const id = `retained-${following}`;
        await seed(id);
        await member(id);
        await enroll(id);
        await sql(`UPDATE ${prefix}.chat_read_cursors
          SET last_read_sequence = 9, manual_unread_from_sequence = 4
          WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_conversation_preferences
          SET notification_level = 'mentions', muted = true, muted_until = '2099-01-01',
              is_starred = true, preference_revision = 7
          WHERE conversation_id = $1`, [id]);
        await sql(`INSERT INTO ${prefix}.chat_drafts
          (tenant_id, conversation_id, user_id, content, revision)
          VALUES ('tenant-a', $1, 'participant', '{"format":"markdown","text":"retained draft"}', 6)`, [id]);
        await sql(`INSERT INTO ${prefix}.chat_thread_follows
          (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
          VALUES ('tenant-a', $1, 'participant', $2, 'manual', 8)`, [id, following]);
        const before = await snapshot(id);
        await enroll(id, { initialRole: "owner" });
        assert.deepEqual(retained(await snapshot(id)), retained(before));
        await member(id, "left");
        await enroll(id);
        const after = await snapshot(id);
        assert.equal(after.chat_conversation_members[0].state, "active");
        assert.deepEqual(retained(after), retained(before));
      });
    }

    await t.test("missing cursor/preference rows are repaired independently without resetting survivors", async () => {
      const id = "retained-true";
      await sql(`DELETE FROM ${prefix}.chat_read_cursors WHERE conversation_id = $1`, [id]);
      const before = await snapshot(id);
      await enroll(id);
      const repairedCursor = await snapshot(id);
      assert.equal(repairedCursor.chat_read_cursors[0].last_read_sequence, "0");
      assert.deepEqual(retained({ ...repairedCursor, chat_read_cursors: [] }), retained(before));
      await sql(`DELETE FROM ${prefix}.chat_conversation_preferences WHERE conversation_id = $1`, [id]);
      await enroll(id);
      const repairedPreference = await snapshot(id);
      assert.equal(repairedPreference.chat_conversation_preferences[0].notification_level, "all");
      assert.deepEqual(
        retained({ ...repairedPreference, chat_conversation_preferences: [] }),
        retained({ ...repairedCursor, chat_conversation_preferences: [] }),
      );
    });

    await t.test("stale private-parent access and retained child role cannot authorize writes", async () => {
      await seed("private", { visibility: "private" });
      await member("private-parent");
      await enroll("private", { initialRole: "owner" });
      const stale = await authorizeThreadAccess({
        database: harness.pool, schema: harness.schema, actor, threadId: "private",
        operation: "read", entityAction: "thread.create", permissions,
      });
      await member("private-parent", "left");
      await member("private", "left");
      await sql(`DELETE FROM ${prefix}.chat_read_cursors WHERE conversation_id = 'private'`);
      const before = await snapshot("private");
      // Even an extra runtime property containing a prior result cannot bypass a fresh check.
      await assert.rejects(enroll("private", { access: stale }), ChatAuthorizationError);
      assert.deepEqual(await snapshot("private"), before);
      await assert.rejects(enroll("private", { actor: { ...actor, userId: "new-user" } }), ChatAuthorizationError);
      assert.equal((await sql(`SELECT count(*)::int AS count FROM ${prefix}.chat_conversation_members WHERE user_id = 'new-user'`)).rows[0].count, 0);
    });

    await t.test("denied current host entity access leaves no participant writes", async () => {
      await seed("entity", { entity: true });
      hostAllowed = false;
      const before = await snapshot("entity");
      await assert.rejects(enroll("entity"), ChatAuthorizationError);
      assert.deepEqual(await snapshot("entity"), before);
      assert.deepEqual(entityCalls.at(-1), {
        actor, entity: { type: "case", id: "host-case" }, action: "thread.create",
      });
      hostAllowed = true;
    });

    await t.test("tenant, actor and intended parent are bound to the fresh check", async () => {
      const before = await snapshot("first");
      await assert.rejects(enroll("first", { parentConversationId: "entity-parent" }), ChatAuthorizationError);
      await assert.rejects(enroll("first", { actor: { ...actor, tenantId: "tenant-b" } }), ChatAuthorizationError);
      assert.deepEqual(await snapshot("first"), before);
    });

    await t.test("authorization locks parent, child and parent membership until caller commit", async () => {
      await seed("locked", { visibility: "private" });
      await member("locked-parent");
      await transaction(async (connection) => {
        await setup(connection, "locked");
        const other = await harness.pool.connect();
        try {
          for (const [table, column, id] of [
            ["chat_conversations", "id", "locked-parent"],
            ["chat_conversations", "id", "locked"],
            ["chat_conversation_members", "conversation_id", "locked-parent"],
          ]) {
            await assert.rejects(other.query(`SELECT * FROM ${prefix}.${table}
              WHERE tenant_id = 'tenant-a' AND ${column} = $1 FOR UPDATE NOWAIT`, [id]),
            (error) => error.code === "55P03");
          }
        } finally {
          other.release();
        }
      });
      await member("locked-parent", "left");
      const before = await snapshot("locked");
      await assert.rejects(enroll("locked"), ChatAuthorizationError);
      assert.deepEqual(await snapshot("locked"), before);
    });

    await t.test("uncommitted private-parent revocation is checked on the caller connection", async () => {
      await seed("transaction-access", { visibility: "private" });
      await member("transaction-access-parent");
      await transaction(async (connection) => {
        await connection.query(`UPDATE ${prefix}.chat_conversation_members SET state = 'left'
          WHERE conversation_id = 'transaction-access-parent'`);
        await assert.rejects(setup(connection, "transaction-access"), ChatAuthorizationError);
      });
      assert.equal(Object.values(await snapshot("transaction-access")).every((rows) => rows.length === 0), true);
    });

    await t.test("caller rollback removes setup and helper leaves connection/transaction open", async () => {
      await seed("rollback");
      await assert.rejects(transaction(async (connection) => {
        await setup(connection, "rollback");
        const inside = await connection.query(`SELECT count(*)::int AS count FROM ${prefix}.chat_read_cursors WHERE conversation_id = 'rollback'`);
        assert.equal(inside.rows[0].count, 1);
        assert.deepEqual((await snapshot("rollback")).chat_conversation_members, []);
        throw new Error("caller failure");
      }), /caller failure/);
      assert.equal(Object.values(await snapshot("rollback")).every((rows) => rows.length === 0), true);
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
