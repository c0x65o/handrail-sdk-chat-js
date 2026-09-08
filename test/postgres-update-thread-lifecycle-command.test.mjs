import assert from "node:assert/strict";
import test from "node:test";

// Bundle canonical source (not shared dist) before running this focused suite:
// node_modules/.bin/esbuild test/postgres-update-thread-lifecycle-command.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/thread-lifecycle-command-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/thread-lifecycle-command-tests.mjs"
import {
  updateThreadLifecycle,
  UpdateThreadLifecycleCommandError,
  UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_OPERATION,
} from "../src/server/update-thread-lifecycle-command.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { CHAT_PROTOCOL_VERSION } from "../src/contracts/realtime.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = Object.freeze({ tenantId: "tenant-a", userId: "actor", roles: ["host-owner"] });
const denial = (error) => error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" && error.statusCode === 403 &&
  error.message === "Chat authorization failed";
const commandError = (code) => (error) => error instanceof UpdateThreadLifecycleCommandError &&
  error.code === code && error.statusCode === 409;
const request = (threadId, intent = "close", expectedLifecycleRevision = 1, idempotencyKey = `${threadId}-${intent}`) => ({
  operation: "update_thread_lifecycle", threadId, intent, expectedLifecycleRevision, idempotencyKey,
});
const closure = { closedAt: "2025-01-01T00:00:00.123Z", closedByUserId: "original-closer" };
const lifecycle = (state, revision = 1) => ({
  revision, locked: state === "locked", ...(state === "open" ? {} : closure),
});

test("transactional thread lifecycle PostgreSQL command", { timeout: 60_000 }, async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_lifecycle_command" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({
      database: harness.pool, schema: harness.schema, migrations: handrailChatPostgresMigrations,
    }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema, canonical migrations, source bundle`);
    const member = (id, role = "member", state = "active", user = actor.userId) => sql(
      `INSERT INTO ${prefix}.chat_conversation_members (tenant_id, conversation_id, user_id, role, state)
       VALUES ('tenant-a', $1, $2, $3, $4)
       ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET role = EXCLUDED.role, state = EXCLUDED.state`,
      [id, user, role, state],
    );
    const seed = async (id, { state = "open", role = "owner", visibility = "public", entity = false,
      revision = 1, tenant = actor.tenantId } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ($1, $2, 'channel', $3, $2, $4, $5)`,
      [tenant, `${id}-parent`, visibility, entity ? "case" : null, entity ? "private-case" : null]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ($1, $2, $3, 1, 'author', $2, '{"format":"plain","text":"retained root"}')`,
      [tenant, `${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id,
         lifecycle_revision, closed_at, closed_by_user_id, locked)
        VALUES ($1, $2, 'thread', $3, $4, $5, $6, $7, $8, $9)`,
      [tenant, id, visibility, `${id}-parent`, `${id}-root`, revision,
        state === "open" ? null : closure.closedAt, state === "open" ? null : closure.closedByUserId, state === "locked"]);
      if (role !== null && tenant === actor.tenantId) await member(id, role);
      if (visibility === "private" && tenant === actor.tenantId) await member(`${id}-parent`);
    };
    let capabilities = [];
    let entityMode = "allow";
    const calls = [];
    const permissions = {
      async getCapabilities() { return capabilities; },
      async authorizeEntity(input) {
        calls.push(input);
        if (entityMode === "error") throw new Error("sensitive host error");
        return entityMode === "allow";
      },
    };
    let nextId = 0;
    const command = (input, overrides = {}) => updateThreadLifecycle({
      database: harness.pool, schema: harness.schema, actor, input, permissions,
      createId: () => `lifecycle-event-${++nextId}`, ...overrides,
    });
    const events = async (id) => (await sql(`SELECT event_id, tenant_id, stream_id, type, payload,
      protocol_version::int, replay_position::text, expires_at > occurred_at AS retained
      FROM ${prefix}.chat_outbox_events WHERE tenant_id = 'tenant-a' AND payload->>'threadId' = $1
      ORDER BY chat_outbox_events.replay_position`, [id])).rows;
    const stored = async (id) => (await sql(`SELECT lifecycle_revision::text, closed_at, closed_by_user_id,
      locked, archived_at, archived_by_user_id FROM ${prefix}.chat_conversations
      WHERE tenant_id = 'tenant-a' AND id = $1`, [id])).rows[0];
    const outcomes = async (key) => (await sql(`SELECT user_id, operation_name, state, response_status, response_body
      FROM ${prefix}.chat_idempotency_keys WHERE tenant_id = 'tenant-a' AND client_key = $1
      ORDER BY user_id`, [key])).rows;
    const assertPair = (rows, id, after) => {
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(({ stream_id, type, payload }) => ({ stream_id, type, payload })), [
        { stream_id: id, type: "thread.lifecycle.updated",
          payload: { threadId: id, parentConversationId: `${id}-parent`, threadLifecycle: after } },
        { stream_id: `${id}-parent`, type: "thread.lifecycle.changed",
          payload: { threadId: id, parentConversationId: `${id}-parent`, revision: after.revision } },
      ]);
      for (const row of rows) {
        assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
        assert.equal(row.tenant_id, actor.tenantId);
        assert.equal(row.retained, true);
      }
      assert.ok(BigInt(rows[1].replay_position) > BigInt(rows[0].replay_position));
      assert.notEqual(rows[0].event_id, rows[1].event_id);
    };

    await t.test("all twelve transitions preserve canonical state, attribution, and no-op/conflict statuses", async () => {
      const matrix = {
        open: { close: "closed", reopen: "open", lock: "locked", unlock: "open" },
        closed: { close: "closed", reopen: "open", lock: "locked", unlock: "closed" },
        locked: { close: "locked", reopen: null, lock: "locked", unlock: "closed" },
      };
      capabilities = ["message.send"];
      for (const [state, intents] of Object.entries(matrix)) {
        for (const [intent, target] of Object.entries(intents)) {
          const id = `matrix-${state}-${intent}`;
          await seed(id, { state });
          const result = await command(request(id, intent));
          const status = target === null ? "lifecycle_conflict" : target === state ? "already_requested_state" : "applied";
          assert.equal(result.reconciliationStatus, status);
          assert.deepEqual(result.previousLifecycle, lifecycle(state));
          const after = result.threadLifecycle;
          assert.equal(after.revision, status === "applied" ? 2 : 1);
          assert.equal(after.locked, (target ?? state) === "locked");
          assert.equal(after.closedAt !== undefined, (target ?? state) !== "open");
          if (after.closedAt !== undefined) {
            assert.equal(after.closedByUserId, state === "open" ? actor.userId : closure.closedByUserId);
            if (state !== "open") assert.equal(after.closedAt, closure.closedAt);
          } else assert.equal(after.closedByUserId, undefined);
          const row = await stored(id);
          assert.equal(Number(row.lifecycle_revision), after.revision);
          assert.equal(row.closed_at?.toISOString(), after.closedAt);
          assert.equal(row.closed_by_user_id ?? undefined, after.closedByUserId);
          assert.equal(row.locked, after.locked);
          if (status === "applied") assertPair(await events(id), id, after);
          else assert.deepEqual(await events(id), []);
          assert.deepEqual(await command(request(id, intent)), {
            ...result, reconciliationStatus: status === "applied" ? "replayed" : status,
          });
          assert.equal((await events(id)).length, status === "applied" ? 2 : 0);
        }
      }
      capabilities = [];
    });

    await t.test("management requires active child owner/moderator or explicit capability, never parent role/follow", async () => {
      for (const intent of ["close", "lock", "unlock"]) {
        for (const role of ["owner", "moderator", null]) {
          const id = `authority-${intent}-${role}`;
          await seed(id, { role, state: intent === "unlock" ? "locked" : "open" });
          capabilities = role === null ? ["thread.manage"] : [];
          assert.equal((await command(request(id, intent))).reconciliationStatus, "applied");
          if (role === null) {
            capabilities = [];
            await assert.rejects(command(request(id, intent)), denial);
          }
        }
        for (const [role, state] of [["member", "active"], ["owner", "left"], ["moderator", "left"]]) {
          const id = `denied-${intent}-${role}`;
          await seed(id, { role, state: "locked" });
          await member(id, role, state);
          await member(`${id}-parent`, "owner");
          await sql(`INSERT INTO ${prefix}.chat_thread_follows
            (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
            VALUES ('tenant-a', $1, 'actor', true, 'manual', 1)`, [id]);
          capabilities = ["message.send"];
          // close/lock would be no-ops at revision 1; stale requests also disclose no state.
          for (const revision of [1, 2]) await assert.rejects(command(request(id, intent, revision)), denial);
          assert.deepEqual(await events(id), []);
          assert.deepEqual(await outcomes(`${id}-${intent}`), []);
        }
      }
      capabilities = [];
      await seed("sender", { state: "closed", role: null });
      await assert.rejects(command(request("sender", "reopen")), denial);
      capabilities = ["message.send"];
      assert.equal((await command(request("sender", "reopen"))).reconciliationStatus, "applied");
      capabilities = [];
      await assert.rejects(command(request("sender", "reopen")), denial);
    });

    await t.test("fresh tenant, parent, entity and authority checks protect every stored retry", async () => {
      capabilities = [];
      await seed("private", { visibility: "private", entity: true });
      const appliedRequest = request("private");
      const applied = await command(appliedRequest);
      const noopRequest = request("private", "close", 2, "private-noop");
      const noop = await command(noopRequest);
      const conflictRequest = request("private", "close", 1, "private-conflict");
      const conflict = await command(conflictRequest);
      assert.deepEqual(calls.at(-1), {
        actor, entity: { type: "case", id: "private-case" }, action: "thread.manage",
      });
      for (const change of ["parent", "role", "entity-deny", "entity-error"]) {
        if (change === "parent") await member("private-parent", "member", "left");
        if (change === "role") await member("private", "member");
        if (change === "entity-deny") entityMode = "deny";
        if (change === "entity-error") entityMode = "error";
        for (const input of [appliedRequest, noopRequest, conflictRequest]) {
          await assert.rejects(command(input), denial);
        }
        await member("private-parent");
        await member("private", "owner");
        entityMode = "allow";
      }
      assert.deepEqual(await command(appliedRequest), { ...applied, reconciliationStatus: "replayed" });
      assert.deepEqual(await command(noopRequest), noop);
      assert.deepEqual(await command(conflictRequest), conflict);
      assertPair(await events("private"), "private", applied.threadLifecycle);
      await seed("other-tenant", { tenant: "tenant-b" });
      capabilities = ["thread.manage"];
      for (const id of ["other-tenant", "missing", "private-parent"]) {
        await assert.rejects(command(request(id)), denial);
      }
      await assert.rejects(command(appliedRequest, { actor: { ...actor, tenantId: "tenant-b" } }), denial);
      capabilities = [];
    });

    await t.test("archived child or parent rejects writes and retries without altering archive state", async () => {
      for (const target of ["child", "parent"]) {
        const id = `archive-${target}`;
        await seed(id);
        const original = request(id);
        await command(original);
        const archivedId = target === "child" ? id : `${id}-parent`;
        await sql(`UPDATE ${prefix}.chat_conversations
          SET archived_at = '2025-02-01', archived_by_user_id = 'administrator', lifecycle_revision = lifecycle_revision + 1
          WHERE tenant_id = 'tenant-a' AND id = $1`, [archivedId]);
        const before = await stored(archivedId);
        capabilities = ["thread.manage", "message.send"];
        for (const input of [original, ...["close", "reopen", "lock", "unlock"].map((intent) => request(id, intent, 3, `${id}-new-${intent}`))]) {
          await assert.rejects(command(input), denial);
        }
        assert.deepEqual(await stored(archivedId), before);
        assert.equal((await events(id)).length, 2);
      }
      capabilities = [];
    });

    await t.test("revision mismatch precedes no-op, and old retry snapshots survive newer mutations", async () => {
      await seed("revisions");
      const noopInput = request("revisions", "unlock");
      const noop = await command(noopInput);
      const futureInput = request("revisions", "unlock", 9, "future");
      const future = await command(futureInput);
      assert.equal(future.reconciliationStatus, "lifecycle_conflict");
      const firstInput = request("revisions");
      const first = await command(firstInput);
      const staleInput = request("revisions", "close", 1, "stale-already-closed");
      const stale = await command(staleInput);
      assert.equal(stale.reconciliationStatus, "lifecycle_conflict");
      await command(request("revisions", "lock", 2));
      assert.deepEqual(await command(firstInput), { ...first, reconciliationStatus: "replayed" });
      assert.deepEqual(await command(noopInput), noop);
      assert.deepEqual(await command(futureInput), future);
      assert.deepEqual(await command(staleInput), stale);
      assert.equal((await stored("revisions")).lifecycle_revision, "3");
      assert.equal((await events("revisions")).length, 4);
      for (const input of [futureInput, staleInput]) {
        const [outcome] = await outcomes(input.idempotencyKey);
        assert.equal(outcome.response_status, 409);
        assert.equal(outcome.operation_name, UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_OPERATION);
      }
      for (const overrides of [{ intent: "unlock" }, { expectedLifecycleRevision: 3 }, { threadId: "private" }]) {
        await assert.rejects(command({ ...firstInput, ...overrides }), commandError("idempotency_key_reuse"));
      }
      // The same key under another trusted actor is independent.
      capabilities = ["thread.manage"];
      const other = await command(request("revisions", "unlock", 3, firstInput.idempotencyKey), {
        actor: { ...actor, userId: "other-actor" },
      });
      assert.equal(other.reconciliationStatus, "applied");
      assert.equal((await outcomes(firstInput.idempotencyKey)).length, 2);
      capabilities = [];
    });

    await t.test("revision exhaustion rejects mutations but permits no-op/conflict without overflow", async () => {
      await seed("exhausted", { revision: Number.MAX_SAFE_INTEGER });
      const before = await stored("exhausted");
      const input = request("exhausted", "close", Number.MAX_SAFE_INTEGER);
      await assert.rejects(command(input), commandError("revision_exhausted"));
      assert.deepEqual(await outcomes(input.idempotencyKey), []);
      assert.equal((await command(request("exhausted", "unlock", Number.MAX_SAFE_INTEGER))).reconciliationStatus, "already_requested_state");
      assert.equal((await command(request("exhausted", "close", 1, "exhausted-stale"))).reconciliationStatus, "lifecycle_conflict");
      assert.deepEqual(await stored("exhausted"), before);
      assert.deepEqual(await events("exhausted"), []);
    });

    await t.test("concurrent identical and competing keys yield one mutation and one event per stream", async () => {
      for (const sameKey of [true, false]) {
        const id = `concurrent-${sameKey}`;
        await seed(id);
        const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
          command(request(id, "lock", 1, sameKey ? id : `${id}-${index}`))));
        assert.equal(results.filter((result) => result.reconciliationStatus === "applied").length, 1);
        assert.equal(results.filter((result) => result.reconciliationStatus === (sameKey ? "replayed" : "lifecycle_conflict")).length, 3);
        const applied = results.find((result) => result.reconciliationStatus === "applied");
        assertPair(await events(id), id, applied.threadLifecycle);
        assert.equal((await stored(id)).lifecycle_revision, "2");
        for (const result of results) {
          if (sameKey) assert.deepEqual(result, { ...applied, reconciliationStatus: result.reconciliationStatus });
          else if (result.reconciliationStatus === "lifecycle_conflict") {
            assert.deepEqual(result.previousLifecycle, applied.threadLifecycle);
            assert.deepEqual(result.threadLifecycle, applied.threadLifecycle);
          }
        }
      }
    });

    await t.test("follows, cursors, drafts, preferences, memberships and history survive mutations and rollback", async () => {
      await seed("retained", { state: "closed" });
      // Keep submillisecond closure attribution in storage across lock/unlock.
      await sql(`UPDATE ${prefix}.chat_conversations SET closed_at = '2025-01-01T00:00:00.123456Z'
        WHERE tenant_id = 'tenant-a' AND id = 'retained'`);
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
        VALUES ('tenant-a', 'retained', 'actor', false, 'manual', 7)`);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
        VALUES ('tenant-a', 'retained', 'actor', 1, 1)`);
      await sql(`INSERT INTO ${prefix}.chat_drafts (tenant_id, conversation_id, user_id, content, revision)
        VALUES ('tenant-a', 'retained', 'actor', '{"format":"plain","text":"retained draft"}', 9)`);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id, conversation_id, user_id, notification_level)
        VALUES ('tenant-a', 'retained', 'actor', 'mentions')`);
      const retained = async () => {
        const result = {};
        for (const table of ["chat_thread_follows", "chat_read_cursors", "chat_drafts", "chat_conversation_preferences",
          "chat_conversation_members", "chat_messages"]) {
          result[table] = (await sql(`SELECT * FROM ${prefix}.${table} WHERE tenant_id = 'tenant-a'
            AND conversation_id IN ('retained', 'retained-parent') ORDER BY conversation_id`)).rows;
        }
        result.conversations = (await sql(`SELECT id, parent_conversation_id, root_message_id,
          current_message_sequence, created_at, archived_at, archived_by_user_id
          FROM ${prefix}.chat_conversations WHERE tenant_id = 'tenant-a'
          AND id IN ('retained', 'retained-parent') ORDER BY id`)).rows;
        return result;
      };
      const before = await retained();
      await command(request("retained", "lock"));
      await command(request("retained", "unlock", 2));
      assert.equal((await sql(`SELECT closed_at = '2025-01-01T00:00:00.123456Z'::timestamptz AS retained
        FROM ${prefix}.chat_conversations WHERE tenant_id = 'tenant-a' AND id = 'retained'`)).rows[0].retained, true);
      assert.deepEqual(await retained(), before);

      // Fail the second event, then fail idempotency completion after both events.
      await sql(`CREATE FUNCTION ${prefix}.reject_lifecycle_effect() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'injected lifecycle effect failure'; END; $body$`);
      for (const failure of ["parent-event", "completion"]) {
        if (failure === "parent-event") {
          await sql(`CREATE TRIGGER reject_lifecycle_effect BEFORE INSERT ON ${prefix}.chat_outbox_events
            FOR EACH ROW WHEN (NEW.stream_id = 'retained-parent') EXECUTE FUNCTION ${prefix}.reject_lifecycle_effect()`);
        } else {
          await sql(`CREATE TRIGGER reject_lifecycle_effect BEFORE UPDATE ON ${prefix}.chat_idempotency_keys
            FOR EACH ROW WHEN (NEW.state = 'completed') EXECUTE FUNCTION ${prefix}.reject_lifecycle_effect()`);
        }
        const input = request("retained", "lock", 3, `rollback-${failure}`);
        const stateBefore = await stored("retained");
        const eventsBefore = await events("retained");
        await assert.rejects(command(input), /injected lifecycle effect failure/);
        assert.deepEqual(await stored("retained"), stateBefore);
        assert.deepEqual(await events("retained"), eventsBefore);
        assert.deepEqual(await outcomes(input.idempotencyKey), []);
        assert.deepEqual(await retained(), before);
        await sql(`DROP TRIGGER reject_lifecycle_effect ON ${prefix}.${failure === "parent-event" ? "chat_outbox_events" : "chat_idempotency_keys"}`);
      }
      capabilities = ["message.send"];
      await command(request("retained", "reopen", 3));
      assert.deepEqual(await retained(), before);
      capabilities = [];
    });

    await t.test("parent, child and role rows remain locked while host authorization executes", async () => {
      await seed("locks", { visibility: "private", entity: true });
      let signal;
      let resume;
      const entered = new Promise((resolve) => { signal = resolve; });
      const gate = new Promise((resolve) => { resume = resolve; });
      const pending = command(request("locks"), { permissions: {
        getCapabilities: permissions.getCapabilities,
        async authorizeEntity() { signal(); await gate; return true; },
      } });
      try {
        await entered;
        for (const [table, condition, assignment] of [
          ["chat_conversations", "id = 'locks-parent'", "visibility = 'public'"],
          ["chat_conversations", "id = 'locks'", "locked = false"],
          ["chat_conversation_members", "conversation_id = 'locks-parent' AND user_id = 'actor'", "state = 'left'"],
          ["chat_conversation_members", "conversation_id = 'locks' AND user_id = 'actor'", "role = 'member'"],
        ]) {
          const connection = await harness.pool.connect();
          try {
            await connection.query("BEGIN");
            await connection.query("SET LOCAL lock_timeout = '100ms'");
            await assert.rejects(connection.query(`UPDATE ${prefix}.${table} SET ${assignment}
              WHERE tenant_id = 'tenant-a' AND ${condition}`), (error) => error.code === "55P03");
          } finally {
            await connection.query("ROLLBACK");
            connection.release();
          }
        }
      } finally { resume(); }
      assert.equal((await pending).reconciliationStatus, "applied");
    });
  } finally {
    try { await harness?.teardown(); } finally { await backend.teardown(); }
  }
});
