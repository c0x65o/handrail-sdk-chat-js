import assert from "node:assert/strict";
import test from "node:test";

// Bundle canonical sources with esbuild before running; never use shared dist.
import { sendMessage, SendMessageCommandError } from "../src/server/send-message-command.ts";
import { updateThreadLifecycle } from "../src/server/update-thread-lifecycle-command.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant", userId: "sender", roles: ["employee"] };
const input = (id, suffix = "send", extra = {}) => ({
  operation: "send", conversationId: id, clientMessageId: `${id}-${suffix}`,
  idempotencyKey: `${id}-${suffix}`, content: { format: "plain", text: "Accepted reply" }, ...extra,
});
const denied = (error) => error instanceof ChatAuthorizationError;
const invalidReply = (error) => error instanceof SendMessageCommandError && error.code === "invalid_reply_source";

test("thread sends reopen atomically with retained participation and safe retries", { timeout: 60_000 }, async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_send_reopen" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; canonical migrations and source bundle`);
    const permissions = { async getCapabilities() { return ["message.send"]; }, async authorizeEntity() { return true; } };
    const command = (request, overrides = {}) => sendMessage({
      database: harness.pool, schema: harness.schema, actor, input: request,
      permissions, directory: { async getUser() { return null; } }, ...overrides,
    });
    const lifecycle = (id, intent, revision, overrides = {}) => updateThreadLifecycle({
      database: harness.pool, schema: harness.schema, actor,
      permissions: { ...permissions, async getCapabilities() { return ["message.send", "thread.manage"]; } },
      input: { operation: "update_thread_lifecycle", threadId: id, intent,
        expectedLifecycleRevision: revision, idempotencyKey: `${id}-${intent}-${revision}` }, ...overrides,
    });
    const seed = async (id, { closed = true, locked = false, member = null,
      visibility = "private", parentMember = true, revision = 1 } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ('tenant', $1, 'channel', $2, $1, 'case', 'case-id')`, [`${id}-parent`, visibility]);
      if (parentMember) await sql(`INSERT INTO ${prefix}.chat_conversation_members
        (tenant_id, conversation_id, user_id, role, state)
        VALUES ('tenant', $1, 'sender', 'member', 'active')`, [`${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant', $1, $2, 1, 'author', $1, '{"format":"plain","text":"Root"}')`,
      [`${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id,
         lifecycle_revision, closed_at, closed_by_user_id, locked)
        VALUES ('tenant', $1, 'thread', $2, $3, $4, $5, $6, $7, $8)`,
      [id, visibility, `${id}-parent`, `${id}-root`, revision,
        closed ? "2025-01-01T00:00:00Z" : null, closed ? "closer" : null, locked]);
      if (member) await sql(`INSERT INTO ${prefix}.chat_conversation_members
        (tenant_id, conversation_id, user_id, role, state, joined_at)
        VALUES ('tenant', $1, 'sender', $2, 'active', '2025-01-01T00:00:00Z')`, [id, member]);
      // Real persisted inline source, independent of the send under test.
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant', $1, $2, 1, 'author', $1, '{"format":"plain","text":"Sensitive source"}')`,
      [`${id}-source`, id]);
      await sql(`UPDATE ${prefix}.chat_conversations SET current_message_sequence = 1
        WHERE tenant_id = 'tenant' AND id IN ($1, $2)`, [id, `${id}-parent`]);
    };
    const state = async (id) => (await sql(`SELECT lifecycle_revision::text, closed_at, closed_by_user_id,
      locked, current_message_sequence::text, updated_at FROM ${prefix}.chat_conversations WHERE id = $1`, [id])).rows[0];
    const events = async (id) => (await sql(`SELECT stream_id, type, payload FROM ${prefix}.chat_outbox_events
      WHERE stream_id IN ($1, $2) ORDER BY replay_position`, [id, `${id}-parent`])).rows;
    const privateState = async (id) => {
      const result = {};
      for (const table of ["chat_thread_follows", "chat_read_cursors", "chat_drafts", "chat_conversation_preferences"]) {
        result[table] = (await sql(`SELECT * FROM ${prefix}.${table} WHERE conversation_id = $1 ORDER BY user_id`, [id])).rows;
      }
      return result;
    };
    const effects = async () => {
      const result = {};
      for (const table of ["chat_conversations", "chat_conversation_members", "chat_messages", "chat_message_revisions",
        "chat_thread_follows", "chat_read_cursors", "chat_drafts", "chat_conversation_preferences",
        "chat_attachments", "chat_audit_events", "chat_outbox_events", "chat_idempotency_keys"]) {
        result[table] = (await sql(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text), '[]') AS rows
          FROM ${prefix}.${table} row`)).rows[0].rows;
      }
      return result;
    };
    const assertEvents = async (id, result, reopened = true, revision = 2) => {
      const rows = await events(id);
      assert.deepEqual(rows.filter(({ type }) => type.startsWith("thread.lifecycle.")), reopened ? [
        { stream_id: id, type: "thread.lifecycle.updated", payload: {
          threadId: id, parentConversationId: `${id}-parent`, threadLifecycle: { revision, locked: false } } },
        { stream_id: `${id}-parent`, type: "thread.lifecycle.changed", payload: {
          threadId: id, parentConversationId: `${id}-parent`, revision } },
      ] : []);
      const messages = rows.filter(({ type }) => type === "message.created");
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0].payload.message, result.message);
      assert.equal(rows.filter(({ type }) => type === "message.thread_summary.updated").length, 1);
      assert.equal(rows.length, reopened ? 4 : 2);
      assert.equal((await sql(`SELECT count(*)::int AS count FROM ${prefix}.chat_messages
        WHERE conversation_id = $1 AND author_user_id = 'sender'`, [id])).rows[0].count, 1);
    };

    await t.test("plain and inline closed sends initialize eligible parent readers and emit one event per stream", async () => {
      for (const inline of [false, true]) {
        const id = inline ? "inline" : "plain";
        await seed(id);
        const request = input(id, "send", inline ? { replyTo: { messageId: `${id}-source`, notifyAuthor: true } } : {});
        const results = await Promise.all([command(request), command(request), command(request)]);
        const accepted = results.find(({ reconciliationStatus }) => reconciliationStatus === "applied");
        assert.ok(accepted);
        assert.equal(results.filter(({ reconciliationStatus }) => reconciliationStatus === "applied").length, 1);
        for (const result of results) assert.deepEqual(result.message, accepted.message);
        assert.equal(accepted.message.conversationId, id);
        assert.equal(accepted.message.sequence, 2);
        assert.deepEqual(accepted.message.replyTo, request.replyTo);
        assert.equal(JSON.stringify(accepted).includes("Sensitive source"), false);
        await assertEvents(id, accepted);
        const stored = await state(id);
        assert.equal(stored.closed_at, null);
        assert.equal(stored.closed_by_user_id, null);
        assert.equal(stored.lifecycle_revision, "2");
        assert.equal((await sql(`SELECT state FROM ${prefix}.chat_conversation_members
          WHERE conversation_id = $1 AND user_id = 'sender'`, [id])).rows[0].state, "active");
        const retained = await privateState(id);
        assert.equal(retained.chat_read_cursors[0].last_read_sequence, "0");
        assert.equal(retained.chat_conversation_preferences[0].notification_level, "all");
        assert.deepEqual(retained.chat_thread_follows, []);
        const before = await effects();
        assert.deepEqual(await command(request), { ...accepted, reconciliationStatus: "replayed" });
        assert.deepEqual(await effects(), before);
      }
      await seed("public", { closed: false, visibility: "public", parentMember: false });
      await assertEvents("public", await command(input("public")), false);
    });

    await t.test("retained inactive roles, private state and manual unfollow survive reactivation", async () => {
      await seed("retained", { member: "moderator" });
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
        VALUES ('tenant', 'retained', 'sender', false, 'manual', 7)`);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
        VALUES ('tenant', 'retained', 'sender', 1, 1)`);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id, conversation_id, user_id, notification_level, muted)
        VALUES ('tenant', 'retained', 'sender', 'mentions', true)`);
      await sql(`INSERT INTO ${prefix}.chat_drafts (tenant_id, conversation_id, user_id, content, revision)
        VALUES ('tenant', 'retained', 'sender', '{"format":"plain","text":"Keep draft"}', 9)`);
      await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed' WHERE conversation_id = 'retained'`);
      const before = await privateState("retained");
      const accepted = await command(input("retained"));
      assert.deepEqual(await privateState("retained"), before);
      const member = (await sql(`SELECT role, state, joined_at FROM ${prefix}.chat_conversation_members
        WHERE conversation_id = 'retained'`)).rows[0];
      assert.equal(member.role, "moderator");
      assert.equal(member.state, "active");
      assert.equal(member.joined_at.toISOString(), "2025-01-01T00:00:00.000Z");
      await assertEvents("retained", accepted);
      // Active membership must not have its timestamp/state touched on another send.
      const members = (await sql(`SELECT * FROM ${prefix}.chat_conversation_members WHERE conversation_id = 'retained'`)).rows;
      await command(input("retained", "again"));
      assert.deepEqual((await sql(`SELECT * FROM ${prefix}.chat_conversation_members WHERE conversation_id = 'retained'`)).rows, members);
      assert.deepEqual(await privateState("retained"), before);
      assert.equal((await events("retained")).filter(({ type }) => type.startsWith("thread.lifecycle.")).length, 2);
    });

    await t.test("legacy capability fallback and explicit host narrowing are independent of following", async () => {
      await seed("narrowed");
      let capabilities = ["message.send"];
      let throws = false;
      const calls = [];
      const narrowed = { ...permissions, async getCapabilities() { return capabilities; },
        async authorizeThreadSend(scope) { calls.push(scope); if (throws) throw new Error("private host detail");
          return scope.capabilities.includes("thread.send"); } };
      const request = input("narrowed");
      const before = await effects();
      await assert.rejects(command(request, { permissions: narrowed }), denied);
      assert.deepEqual(await effects(), before);
      assert.deepEqual(calls[0], { actor, threadId: "narrowed", parentConversationId: "narrowed-parent", capabilities });
      capabilities = ["message.send", "thread.send"];
      const accepted = await command(request, { permissions: narrowed });
      await assertEvents("narrowed", accepted);
      const after = await effects();
      capabilities = ["message.send"];
      await assert.rejects(command(request, { permissions: narrowed }), denied);
      throws = true;
      await assert.rejects(command(input("narrowed", "throws"), { permissions: narrowed }), denied);
      assert.deepEqual(await effects(), after);
      // Existing non-thread sends do not invoke thread policy.
      await command(input("narrowed-parent"), { permissions: narrowed });
    });

    await t.test("ordinary and manager locked sends, archives and revoked parent/entity access roll back", async () => {
      for (const scenario of ["locked-reader", "locked-manager", "child-archive", "parent-archive", "revoked", "entity", "capability"]) {
        await seed(scenario, { locked: scenario.startsWith("locked"), member: scenario === "locked-manager" ? "owner" : null });
        if (scenario.endsWith("archive")) await sql(`UPDATE ${prefix}.chat_conversations
          SET archived_at = clock_timestamp(), archived_by_user_id = 'admin' WHERE id = $1`,
        [scenario === "child-archive" ? scenario : `${scenario}-parent`]);
        if (scenario === "revoked") await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed'
          WHERE conversation_id = $1`, [`${scenario}-parent`]);
        const override = { permissions: { ...permissions,
          async getCapabilities() { return scenario === "capability" ? [] : ["message.send", "thread.manage"]; },
          async authorizeEntity() { return scenario !== "entity"; } } };
        const before = await effects();
        await assert.rejects(command(input(scenario), override), denied);
        await assert.rejects(command(input(scenario, "inline", { replyTo: { messageId: `${scenario}-source`, notifyAuthor: false } }), override),
          scenario === "capability" ? denied : invalidReply);
        assert.deepEqual(await effects(), before);
      }
      await lifecycle("locked-manager", "unlock", 1);
      await command(input("locked-manager", "unlocked"));
      assert.equal((await state("locked-manager")).closed_at, null);
    });

    await t.test("source, attachment and late persistence failures roll back participant, lifecycle and all effects", async () => {
      for (const failure of ["source", "attachment", "parent-event", "completion"]) {
        const id = `rollback-${failure}`;
        await seed(id);
        const extra = failure === "source" ? { replyTo: { messageId: "missing", notifyAuthor: false } }
          : failure === "attachment" ? { content: { format: "plain", text: "Bad attachment", attachments: [{ attachmentId: "missing" }] } } : {};
        if (failure === "parent-event" || failure === "completion") {
          await sql(`CREATE OR REPLACE FUNCTION ${prefix}.reject_send_effect() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN RAISE EXCEPTION 'injected send effect failure'; END; $body$`);
          const target = failure === "parent-event" ? "chat_outbox_events" : "chat_idempotency_keys";
          await sql(`CREATE TRIGGER reject_send_effect BEFORE ${failure === "parent-event" ? "INSERT" : "UPDATE"}
            ON ${prefix}.${target} FOR EACH ROW
            WHEN (${failure === "parent-event" ? "NEW.type = 'thread.lifecycle.changed'" : "NEW.state = 'completed'"})
            EXECUTE FUNCTION ${prefix}.reject_send_effect()`);
        }
        const before = await effects();
        await assert.rejects(command(input(id, "send", extra)), (error) => failure === "source" ? invalidReply(error)
          : failure === "attachment" ? error.code === "attachment_unavailable" : /injected send effect failure/.test(error.message));
        assert.deepEqual(await effects(), before);
        if (failure === "parent-event" || failure === "completion") await sql(`DROP TRIGGER reject_send_effect ON ${prefix}.${failure === "parent-event" ? "chat_outbox_events" : "chat_idempotency_keys"}`);
      }
      await seed("exhausted", { revision: Number.MAX_SAFE_INTEGER });
      const before = await effects();
      await assert.rejects(command(input("exhausted")), (error) => error.code === "revision_exhausted" && error.statusCode === 409);
      assert.deepEqual(await effects(), before);
      await seed("open-exhausted", { closed: false, revision: Number.MAX_SAFE_INTEGER });
      await assertEvents("open-exhausted", await command(input("open-exhausted")), false);
    });

    // Pause the real transaction at a known statement; no SQL behavior is mocked.
    const gateDatabase = (matches) => {
      let release;
      let reached;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { reached = resolve; });
      let paused = false;
      return { ready, release, database: { async connect() {
        const connection = await harness.pool.connect();
        return { async query(query, values) {
          const result = await connection.query(query, values);
          if (!paused && matches(query)) { paused = true; reached(); await gate; }
          return result;
        }, release() { connection.release(); } };
      } } };
    };
    const waitBlocked = async () => {
      // Observe PostgreSQL waiting on a row/transaction lock, rather than timing
      // the race with sleeps or assuming the competing command has started.
      for (let i = 0; i < 200; i++) {
        const result = await sql(`SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE $1`, [`%${harness.schema}%`]);
        if (result.rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail("competing transaction did not wait on the held lock");
    };
    await t.test("close before send reopens once; close after send and replay never reopen again", async () => {
      for (const closeFirst of [true, false]) {
        const id = closeFirst ? "close-first" : "send-first";
        await seed(id, { closed: !closeFirst });
        const gate = gateDatabase((query) => closeFirst
          ? query.includes("SET closed_at = CASE") : query.includes("SET state = 'completed'"));
        let first;
        let second;
        try {
          first = closeFirst ? lifecycle(id, "close", 1, { database: gate.database })
            : command(input(id), { database: gate.database });
          await gate.ready;
          second = closeFirst ? command(input(id)) : lifecycle(id, "close", 2);
          await waitBlocked();
        } finally { gate.release(); }
        const [firstResult, secondResult] = await Promise.all([first, second]);
        const accepted = closeFirst ? secondResult : firstResult;
        assert.equal(firstResult.reconciliationStatus, "applied");
        assert.equal(secondResult.reconciliationStatus, "applied");
        assert.equal((await state(id)).lifecycle_revision, "3");
        assert.equal((await state(id)).closed_at === null, closeFirst);
        assert.equal((await events(id)).filter(({ type }) => type === "message.created").length, 1);
        assert.equal((await events(id)).filter(({ type }) => type === "thread.lifecycle.updated").length, 2);
        assert.equal((await events(id)).filter(({ type }) => type === "thread.lifecycle.changed").length, 2);
        if (closeFirst) await lifecycle(id, "close", 3);
        // Current parent access, not a retained child membership, permits replay.
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed' WHERE conversation_id = $1`, [id]);
        const before = await effects();
        assert.deepEqual(await command(input(id)), { ...accepted, reconciliationStatus: "replayed" });
        assert.deepEqual(await effects(), before);
        await lifecycle(id, "lock", closeFirst ? 4 : 3);
        const locked = await effects();
        assert.deepEqual(await command(input(id)), { ...accepted, reconciliationStatus: "replayed" });
        assert.deepEqual(await effects(), locked);
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed' WHERE conversation_id = $1`, [`${id}-parent`]);
        const revoked = await effects();
        await assert.rejects(command(input(id)), denied);
        assert.deepEqual(await effects(), revoked);
      }
    });
  } finally {
    if (harness) await harness.teardown();
    await backend.teardown();
  }
});
