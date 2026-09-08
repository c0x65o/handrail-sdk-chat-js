import assert from "node:assert/strict";
import test from "node:test";
import { updateReadCursor } from "../src/server/update-read-cursor-command.ts";
import { ReadCursorMutationError } from "../src/contracts/read-cursor-mutation.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
const denied = (error) => error instanceof ChatAuthorizationError && error.statusCode === 403;

test("thread cursors use current parent authority and preserve retained state", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_thread_cursor" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${(await sql("SHOW server_version")).rows[0].server_version}; ${backend.kind}, isolated schema and canonical migrations`);
    const seed = async (id, { visibility = "private", entity = false } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ('tenant-a', $1, 'channel', $2, $1, $3, $4)`,
      [`${id}-parent`, visibility, entity ? "case" : null, entity ? "host-case" : null]);
      if (visibility === "private") await sql(`INSERT INTO ${prefix}.chat_conversation_members
        (tenant_id, conversation_id, user_id, role, state)
        VALUES ('tenant-a', $1, 'reader', 'member', 'active')`, [`${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant-a', $1, $2, 1, 'author', $1, '{"format":"plain","text":"root"}')`,
      [`${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id, current_message_sequence)
        VALUES ('tenant-a', $1, 'thread', $2, $3, $4, 10)`,
      [id, visibility, `${id}-parent`, `${id}-root`]);
    };
    let nextKey = 0;
    const request = (id, overrides = {}) => ({
      operation: "mark_read", conversationId: id, throughSequence: 6,
      idempotencyKey: `thread-cursor-${++nextKey}`, ...overrides,
    });
    const unread = (id, fromSequence) => ({
      operation: "mark_unread", conversationId: id, fromSequence,
      idempotencyKey: `thread-cursor-${++nextKey}`,
    });
    const command = (input, overrides = {}) => updateReadCursor({
      database: harness.pool, schema: harness.schema, actor, input, ...overrides,
    });
    const snapshot = async (id) => {
      const result = {};
      for (const table of ["chat_conversation_members", "chat_conversation_preferences",
        "chat_read_cursors", "chat_thread_follows", "chat_drafts"]) {
        result[table] = (await sql(`SELECT * FROM ${prefix}.${table}
          WHERE tenant_id = 'tenant-a' AND conversation_id = $1 AND user_id = 'reader'`, [id])).rows;
      }
      result.conversation = (await sql(`SELECT * FROM ${prefix}.chat_conversations
        WHERE tenant_id = 'tenant-a' AND id = $1`, [id])).rows;
      result.audit = (await sql(`SELECT * FROM ${prefix}.chat_audit_events
        WHERE target_id = $1 ORDER BY event_id`, [id])).rows;
      result.outbox = (await sql(`SELECT * FROM ${prefix}.chat_outbox_events
        WHERE payload->>'conversationId' = $1 ORDER BY event_id`, [id])).rows;
      return result;
    };
    const assertNoClaim = async (input) => assert.equal((await sql(
      `SELECT count(*)::integer AS count FROM ${prefix}.chat_idempotency_keys
       WHERE client_key = $1`, [input.idempotencyKey])).rows[0].count, 0);

    for (const visibility of ["private", "public"]) {
      await t.test(`${visibility} parent reader advances without child membership or following`, async () => {
        const id = `first-${visibility}`;
        await seed(id, { visibility });
        const before = await snapshot(id);
        assert.deepEqual(before.chat_conversation_members, []);
        assert.deepEqual(before.chat_read_cursors, []);
        if (visibility === "public") assert.deepEqual((await snapshot(`${id}-parent`)).chat_conversation_members, []);
        const input = request(id);
        const result = await command(input);
        assert.equal(result.readState.lastReadSequence, 6);
        assert.equal(result.unreadCount, 4);
        const after = await snapshot(id);
        assert.equal(after.chat_conversation_members[0].state, "active");
        assert.equal(after.chat_read_cursors[0].last_read_sequence, "6");
        assert.equal(after.chat_conversation_preferences[0].notification_level, "all");
        assert.deepEqual(after.chat_thread_follows, []);
        assert.deepEqual(after.chat_drafts, []);
        assert.deepEqual(after.conversation, before.conversation);
        assert.equal(after.audit.length, 1);
        assert.equal(after.audit[0].metadata.previousLastReadSequence, 0);
        assert.equal(after.outbox.length, 1);
        assert.equal(after.outbox[0].stream_id, "user:reader");
        assert.deepEqual(after.outbox[0].payload, { kind: "conversation_read_cursor", actorUserId: "reader", ...result });
        assert.deepEqual(await command(input), result);
        assert.deepEqual(await snapshot(id), after);
      });
    }
    for (const following of [true, false]) {
      await t.test(`re-entry retains manual unread, notification settings, role, draft and follow=${following}`, async () => {
        const id = `retained-${following}`;
        await seed(id);
        const originalInput = request(id);
        const original = await command(originalInput);
        await command(unread(id, 4));
        await sql(`UPDATE ${prefix}.chat_conversation_members SET role = 'moderator', state = 'left'
          WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_conversation_preferences SET notification_level = 'none', muted = true,
          muted_until = '2099-01-01T00:00:00Z', is_starred = true, preference_revision = 7
          WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_read_cursors SET updated_at = '2099-01-01T00:00:00Z'
          WHERE conversation_id = $1`, [id]);
        await sql(`INSERT INTO ${prefix}.chat_thread_follows
          (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
          VALUES ('tenant-a', $1, 'reader', $2, 'manual', 8)`, [id, following]);
        await sql(`INSERT INTO ${prefix}.chat_drafts (tenant_id, conversation_id, user_id, content, revision)
          VALUES ('tenant-a', $1, 'reader', '{"format":"plain","text":"draft"}', 6)`, [id]);
        const before = await snapshot(id);
        // Completed retries do not run participant setup or reconcile newer state.
        assert.deepEqual(await command(originalInput), original);
        assert.deepEqual(await snapshot(id), before);
        const stale = request(id, { throughSequence: 5 });
        await assert.rejects(command(stale), (e) => e instanceof ReadCursorMutationError && e.code === "cursor_regression");
        await assertNoClaim(stale);
        assert.deepEqual(await snapshot(id), before);
        // An unchanged manual marker exercises setup without clearing the marker.
        const reentry = await command(unread(id, 4));
        assert.equal(reentry.readState.lastReadSequence, 6);
        assert.equal(reentry.readState.manualUnreadFromSequence, 4);
        assert.equal(reentry.unreadCount, 7);
        const after = await snapshot(id);
        assert.deepEqual(after.chat_read_cursors, before.chat_read_cursors);
        for (const table of ["chat_conversation_preferences", "chat_thread_follows", "chat_drafts", "conversation"])
          assert.deepEqual(after[table], before[table]);
        assert.deepEqual(after.chat_conversation_members[0], {
          ...before.chat_conversation_members[0], state: "active", updated_at: after.chat_conversation_members[0].updated_at,
        });
        const clear = await command(request(id));
        assert.equal(clear.readState.lastReadSequence, 6);
        assert.equal(clear.readState.manualUnreadFromSequence, undefined);
        assert.equal(clear.readState.updatedAt, "2099-01-01T00:00:00.001Z");
        const advance = await command(request(id, { throughSequence: 9 }));
        assert.equal(advance.readState.lastReadSequence, 9);
        assert.equal(advance.readState.updatedAt, "2099-01-01T00:00:00.002Z");
        assert.equal(advance.unreadCount, 1);
        const final = await snapshot(id);
        for (const table of ["chat_conversation_preferences", "chat_thread_follows", "chat_drafts", "conversation"])
          assert.deepEqual(final[table], before[table]);
      });
    }
    for (const reason of ["membership", "entity", "missing-adapter", "throwing-adapter", "parent-archive", "thread-archive"]) {
      await t.test(`${reason} revocation denies fresh requests and completed retries despite retained child membership`, async () => {
        const id = `revoked-${reason}`;
        const entity = ["entity", "missing-adapter", "throwing-adapter"].includes(reason);
        await seed(id, { entity });
        const calls = [];
        const allowed = { permissions: { async authorizeEntity(value) { calls.push(value); return true; } } };
        const input = request(id);
        await command(input, allowed);
        if (entity) assert.deepEqual(calls, Array(2).fill({ actor, entity: { type: "case", id: "host-case" }, action: "conversation.read_cursor.update" }));
        let options = allowed;
        if (reason === "membership") await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'left'
          WHERE conversation_id = $1`, [`${id}-parent`]);
        if (reason === "entity") options = { permissions: { async authorizeEntity() { return false; } } };
        if (reason === "missing-adapter") options = {};
        if (reason === "throwing-adapter") options = { permissions: { async authorizeEntity() { throw new Error("host secret"); } } };
        if (reason.endsWith("archive")) await sql(`UPDATE ${prefix}.chat_conversations
          SET archived_at = clock_timestamp(), archived_by_user_id = 'reader'
          WHERE id = $1`, [reason === "parent-archive" ? `${id}-parent` : id]);
        const before = await snapshot(id);
        assert.equal(before.chat_conversation_members[0].state, "active");
        const fresh = request(id, { throughSequence: 8 });
        await assert.rejects(command(fresh, options), denied);
        await assertNoClaim(fresh);
        await assert.rejects(command(input, options), denied);
        assert.deepEqual(await snapshot(id), before);
      });
    }
    for (const reason of ["missing", "denying", "throwing", "setup-recheck"]) {
      await t.test(`${reason} entity adapter denies initial setup without any leakage`, async () => {
        const id = `setup-${reason}`;
        await seed(id, { entity: true });
        const before = await snapshot(id);
        let calls = 0;
        const options = reason === "missing" ? {} : { permissions: {
          async authorizeEntity() {
            calls++;
            if (reason === "throwing") throw new Error("host secret");
            return reason === "setup-recheck" && calls === 1;
          },
        } };
        const input = request(id);
        await assert.rejects(command(input, options), denied);
        assert.equal(calls, reason === "missing" ? 0 : reason === "setup-recheck" ? 2 : 1);
        assert.deepEqual(await snapshot(id), before);
        await assertNoClaim(input);
      });
    }
    await t.test("tenant and user isolation deny setup using another actor's parent membership", async () => {
      await seed("isolated");
      const before = await snapshot("isolated");
      for (const other of [{ ...actor, tenantId: "tenant-b" }, { ...actor, userId: "outsider" }]) {
        const input = request("isolated");
        await assert.rejects(command(input, { actor: other }), denied);
        await assertNoClaim(input);
      }
      assert.deepEqual(await snapshot("isolated"), before);
    });
    await t.test("relationship changes after discovery are rejected under parent-before-child locks", async () => {
      await seed("moved");
      await seed("destination");
      const locks = [];
      const database = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(query, values) {
              const result = await connection.query(query, values);
              if (query.includes("SELECT type, parent_conversation_id")) {
                await sql(`UPDATE ${prefix}.chat_conversations
                  SET parent_conversation_id = 'destination-parent', root_message_id = 'destination-root'
                  WHERE id = 'moved'`);
              }
              if (query.includes("FOR UPDATE")) locks.push(values[1]);
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      // Remove the other child so the canonical root uniqueness remains valid.
      await sql(`DELETE FROM ${prefix}.chat_conversations WHERE id = 'destination'`);
      const input = request("moved");
      await assert.rejects(command(input, { database }), denied);
      assert.deepEqual(locks, ["moved-parent", "moved"]);
      const after = await snapshot("moved");
      for (const table of ["chat_conversation_members", "chat_read_cursors", "chat_conversation_preferences", "chat_thread_follows", "chat_drafts", "audit", "outbox"])
        assert.deepEqual(after[table], []);
      await assertNoClaim(input);
    });
    await t.test("invalid first cursor mutation rolls back participant setup", async () => {
      await seed("invalid");
      const before = await snapshot("invalid");
      const input = request("invalid", { throughSequence: 11 });
      await assert.rejects(command(input), (e) => e instanceof ReadCursorMutationError && e.code === "sequence_out_of_range");
      assert.deepEqual(await snapshot("invalid"), before);
      await assertNoClaim(input);
    });
    await t.test("outbox failure rolls back new and retained participant state, cursor, preference, audit and claim", async () => {
      for (const retained of [false, true]) {
        const id = `rollback-${retained}`;
        await seed(id);
        if (retained) {
          await command(request(id));
          await command(unread(id, 4));
          await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'left' WHERE conversation_id = $1`, [id]);
        }
        const before = await snapshot(id);
        await sql(`CREATE FUNCTION ${prefix}.reject_thread_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected thread cursor outbox failure'; END $$`);
        await sql(`CREATE TRIGGER reject_thread_cursor BEFORE INSERT ON ${prefix}.chat_outbox_events
          FOR EACH ROW EXECUTE FUNCTION ${prefix}.reject_thread_cursor()`);
        try {
          const input = request(id, { throughSequence: 8 });
          await assert.rejects(command(input), /injected thread cursor outbox failure/);
          assert.deepEqual(await snapshot(id), before);
          await assertNoClaim(input);
        } finally {
          await sql(`DROP TRIGGER reject_thread_cursor ON ${prefix}.chat_outbox_events`);
          await sql(`DROP FUNCTION ${prefix}.reject_thread_cursor()`);
        }
      }
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
