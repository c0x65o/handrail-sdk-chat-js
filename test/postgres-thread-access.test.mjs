import assert from "node:assert/strict";
import test from "node:test";

// Bundle this focused suite from canonical sources, without using shared dist:
// node_modules/.bin/esbuild test/postgres-thread-access.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/thread-access-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/thread-access-tests.mjs"
import { authorizeThreadAccess } from "../src/server/thread-access.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = Object.freeze({ tenantId: "tenant-a", userId: "reader", roles: [] });
const sanitizedDenial = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" && error.statusCode === 403 &&
  error.message === "Chat authorization failed" && error.cause === undefined;

test("thread access uses current parent authority in PostgreSQL", async (t) => {
  // An unavailable backend fails explicitly; SQL coverage must never silently skip.
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_thread_access" });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    await createPostgresMigrationRunner({
      database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);

    const seed = async (id, { tenant = "tenant-a", visibility = "public", type = "channel", entity = false } = {}) => {
      await sql(
        `INSERT INTO ${prefix}.chat_conversations
           (tenant_id, id, type, visibility, name, entity_type, entity_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenant, `${id}-parent`, type, visibility, type === "channel" ? id : null,
          entity ? "case" : null, entity ? "private-host-case" : null],
      );
      await sql(
        `INSERT INTO ${prefix}.chat_messages
           (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
         VALUES ($1, $2, $3, 1, 'author', $2, '{"format":"plain","text":"root"}')`,
        [tenant, `${id}-root`, `${id}-parent`],
      );
      await sql(
        `INSERT INTO ${prefix}.chat_conversations
           (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
         VALUES ($1, $2, 'thread', $3, $4, $5)`,
        [tenant, id, visibility, `${id}-parent`, `${id}-root`],
      );
    };
    const member = (id, role = "member", state = "active", tenant = "tenant-a", user = "reader") => sql(
      `INSERT INTO ${prefix}.chat_conversation_members
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, conversation_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, state = EXCLUDED.state`,
      [tenant, id, user, role, state],
    );
    const calls = [];
    let capabilities = [];
    let hostMode = "allow";
    const permissions = {
      async getCapabilities(input) {
        calls.push({ kind: "capabilities", ...input });
        if (hostMode === "capability-error") throw new Error("private host details");
        return capabilities;
      },
      async authorizeEntity(input) {
        calls.push({ kind: "entity", ...input });
        if (hostMode === "entity-error") throw new Error("private host details");
        return hostMode !== "deny";
      },
    };
    const access = (threadId, operation = "read", overrides = {}) => authorizeThreadAccess({
      database: harness.pool, schema: harness.schema, actor, threadId,
      operation, ...(operation === "read" ? { entityAction: "conversation.detail" } : {}),
      permissions, ...overrides,
    });
    await seed("public");
    await seed("private", { visibility: "private" });
    await seed("entity", { entity: true });
    await seed("direct", { visibility: "private", type: "direct" });
    await seed("group", { visibility: "private", type: "group_direct" });

    await t.test("public parent permits unfollowed readers without any child membership", async () => {
      assert.deepEqual(await access("public"), {
        threadId: "public", parentConversationId: "public-parent", isArchived: false,
      });
      assert.deepEqual(calls, []);
      const rows = await sql(`SELECT
        (SELECT count(*)::int FROM ${prefix}.chat_conversation_members) AS members,
        (SELECT count(*)::int FROM ${prefix}.chat_thread_follows) AS follows`);
      assert.deepEqual(rows.rows[0], { members: 0, follows: 0 });
    });

    await t.test("private channel and direct parents require the current actor's active parent membership", async () => {
      for (const id of ["private", "direct", "group"]) {
        await assert.rejects(access(id), sanitizedDenial);
        await member(`${id}-parent`);
        assert.equal((await access(id)).threadId, id);
        await assert.rejects(access(id, "read", {
          actor: { ...actor, userId: "different-user" },
        }), sanitizedDenial);
      }
    });

    await t.test("stale child owner/moderator and follow cannot override lost parent access", async () => {
      for (const role of ["owner", "moderator", "member"]) {
        await member("private-parent");
        await member("private", role);
        await sql(`INSERT INTO ${prefix}.chat_thread_follows
          (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
          VALUES ('tenant-a', 'private', 'reader', true, 'manual', 1)
          ON CONFLICT DO NOTHING`);
        assert.equal((await access("private")).threadId, "private");
        for (const state of ["left", "removed"]) {
          await member("private-parent", "owner", state);
          capabilities = ["thread.manage", "message.send", "conversation.archive"];
          for (const operation of ["read", "send", "manage"]) {
            const callCount = calls.length;
            await assert.rejects(access("private", operation), sanitizedDenial);
            assert.equal(calls.length, callCount, "parent denial precedes host checks");
          }
        }
      }
      await sql(`DELETE FROM ${prefix}.chat_conversation_members
        WHERE tenant_id = 'tenant-a' AND conversation_id = 'private-parent'`);
      await assert.rejects(access("private"), sanitizedDenial);
      await member("private-parent");
      assert.equal((await access("private")).threadId, "private");
    });

    await t.test("tenant-scoped joins cannot borrow another tenant's parent or membership", async () => {
      await seed("collision", { visibility: "private" });
      await seed("collision", { tenant: "tenant-b" });
      await seed("only-other-tenant", { tenant: "tenant-b" });
      await member("collision-parent", "owner", "active", "tenant-b");
      await member("collision", "owner");
      await assert.rejects(access("collision"), sanitizedDenial);
      await assert.rejects(access("only-other-tenant"), sanitizedDenial);
      assert.equal((await access("collision", "read", {
        actor: { ...actor, tenantId: "tenant-b" },
      })).threadId, "collision");
    });

    await t.test("missing targets, nonthreads, and archived parents are denied for every operation", async () => {
      await seed("archived-parent");
      await sql(`UPDATE ${prefix}.chat_conversations
        SET archived_at = clock_timestamp(), archived_by_user_id = 'admin'
        WHERE tenant_id = 'tenant-a' AND id = 'archived-parent-parent'`);
      await member("archived-parent", "owner");
      capabilities = ["thread.manage", "message.send", "conversation.archive"];
      for (const id of ["missing", "public-parent", "archived-parent"]) {
        for (const operation of ["read", "send", "manage"]) {
          await assert.rejects(access(id, operation), sanitizedDenial);
        }
      }
    });

    await t.test("defensive parent validation rejects dangling and nested-thread parents", async () => {
      // The canonical FKs prevent a dangling parent. Temporarily remove only
      // those constraints in a rolled-back isolated-schema transaction to prove
      // the helper fails closed even for historical/corrupt parent references.
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(`ALTER TABLE ${prefix}.chat_conversations
          DROP CONSTRAINT chat_conversations_parent_fkey,
          DROP CONSTRAINT chat_conversations_root_message_fkey`);
        for (const parent of ["missing-parent", "public"]) {
          await connection.query(`UPDATE ${prefix}.chat_conversations
            SET parent_conversation_id = $1 WHERE tenant_id = 'tenant-a' AND id = 'private'`, [parent]);
          for (const operation of ["read", "send", "manage"]) {
            await assert.rejects(access("private", operation, { database: connection }), sanitizedDenial);
          }
        }
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
    });

    await t.test("send uses legacy message.send and management uses active thread roles or explicit host capability", async () => {
      capabilities = [];
      await assert.rejects(access("public", "send"), sanitizedDenial);
      await assert.rejects(access("public", "manage"), sanitizedDenial);
      capabilities = ["message.send"];
      assert.equal((await access("public", "send")).threadId, "public");
      await assert.rejects(access("public", "manage"), sanitizedDenial);
      capabilities = ["thread.manage"];
      assert.equal((await access("public", "manage")).threadId, "public");
      await assert.rejects(access("public", "send"), sanitizedDenial);
      capabilities = ["conversation.archive", "conversation.members.manage"];
      await member("public-parent", "owner");
      await assert.rejects(access("public", "manage", {
        actor: { ...actor, roles: ["owner", "moderator", "thread.manage"] },
      }), sanitizedDenial);
      for (const role of ["owner", "moderator"]) {
        await member("public", role);
        assert.equal((await access("public", "manage")).threadId, "public");
        await assert.rejects(access("public", "send"), sanitizedDenial);
        for (const state of ["left", "removed"]) {
          await member("public", role, state);
          await assert.rejects(access("public", "manage"), sanitizedDenial);
        }
      }
      await member("public", "member");
      await assert.rejects(access("public", "manage"), sanitizedDenial);
      hostMode = "capability-error";
      await assert.rejects(access("public", "send"), sanitizedDenial);
      await assert.rejects(access("public", "manage"), sanitizedDenial);
      hostMode = "allow";
      capabilities = ["message.send", 17];
      await assert.rejects(access("public", "send"), sanitizedDenial);
    });

    await t.test("inherited host entity action is operation-specific and denials/errors are sanitized", async () => {
      capabilities = ["message.send", "thread.manage"];
      for (const [operation, action] of [
        ["read", "conversation.detail"], ["read", "message.timeline"],
        ["read", "conversation.subscribe"], ["send", "message.send"], ["manage", "thread.manage"],
      ]) {
        for (const mode of ["deny", "entity-error", "allow"]) {
          hostMode = mode;
          const result = access("entity", operation, operation === "read" ? { entityAction: action } : {});
          if (mode === "allow") assert.equal((await result).threadId, "entity");
          else await assert.rejects(result, sanitizedDenial);
          assert.deepEqual(calls.at(-1), {
            kind: "entity", actor, entity: { type: "case", id: "private-host-case" }, action,
          });
        }
      }
      await member("entity", "owner");
      capabilities = [];
      hostMode = "deny";
      await assert.rejects(access("entity", "manage"), sanitizedDenial);
      hostMode = "allow";
    });

    await t.test("child archive remains readable as metadata but denies send/manage even for administrators", async () => {
      await seed("archived-child");
      await member("archived-child", "owner");
      await sql(`UPDATE ${prefix}.chat_conversations
        SET archived_at = clock_timestamp(), archived_by_user_id = 'admin'
        WHERE tenant_id = 'tenant-a' AND id = 'archived-child'`);
      capabilities = ["message.send", "thread.manage", "conversation.archive"];
      assert.equal((await access("archived-child")).isArchived, true);
      await assert.rejects(access("archived-child", "send"), sanitizedDenial);
      await assert.rejects(access("archived-child", "manage"), sanitizedDenial);
    });

    await t.test("read-only evaluation preserves all stored rows including follows, cursors, and lifecycle", async () => {
      const snapshot = async () => {
        const tables = await sql("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename", [harness.schema]);
        const rows = {};
        for (const { tablename } of tables.rows) {
          rows[tablename] = (await sql(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text), '[]') AS rows
            FROM (SELECT to_jsonb(t) AS row FROM ${prefix}."${tablename}" AS t) AS data`)).rows[0].rows;
        }
        return rows;
      };
      // Existing manual unfollow is also not an access restriction.
      await sql(`UPDATE ${prefix}.chat_thread_follows
        SET is_following = false, follow_revision = follow_revision + 1,
            updated_at = clock_timestamp()
        WHERE tenant_id = 'tenant-a' AND conversation_id = 'private'`);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
        VALUES ('tenant-a', 'private', 'reader', 7, 3)`);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id, conversation_id, user_id, notification_level, muted)
        VALUES ('tenant-a', 'private', 'reader', 'mentions', true)`);
      const before = await snapshot();
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN READ ONLY");
        for (const id of ["public", "private", "entity", "archived-child"]) {
          await access(id, "read", { database: connection });
        }
        await assert.rejects(access("missing", "read", { database: connection }), sanitizedDenial);
        assert.equal((await connection.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
        await connection.query("COMMIT");
      } finally {
        connection.release();
      }
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("caller-owned transaction sees uncommitted parent changes and retains rollback ownership", async () => {
      await seed("transaction");
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(`SELECT id FROM ${prefix}.chat_conversations
          WHERE tenant_id = 'tenant-a' AND id IN ('transaction', 'transaction-parent') FOR UPDATE`);
        capabilities = ["message.send"];
        assert.equal((await access("transaction", "send", { database: connection })).threadId, "transaction");
        await connection.query(`UPDATE ${prefix}.chat_conversations SET visibility = 'private'
          WHERE tenant_id = 'tenant-a' AND id = 'transaction-parent'`);
        await assert.rejects(access("transaction", "send", { database: connection }), sanitizedDenial);
        assert.equal((await connection.query(`SELECT visibility FROM ${prefix}.chat_conversations
          WHERE tenant_id = 'tenant-a' AND id = 'transaction-parent'`)).rows[0].visibility, "private");
        await connection.query("ROLLBACK");
        assert.equal((await access("transaction")).threadId, "transaction");
      } finally {
        connection.release();
      }
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
