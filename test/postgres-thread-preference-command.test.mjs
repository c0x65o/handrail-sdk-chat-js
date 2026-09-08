import assert from "node:assert/strict";
import test from "node:test";
import { updateConversationPreference } from "../src/server/update-conversation-preference-command.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
const denied = (error) => error instanceof ChatAuthorizationError && error.statusCode === 403;

test("thread preferences use current parent authority and preserve retained state", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_thread_preference" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema and canonical migrations`);
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
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
        VALUES ('tenant-a', $1, 'thread', $2, $3, $4)`,
      [id, visibility, `${id}-parent`, `${id}-root`]);
    };
    let nextKey = 0;
    const request = (id, overrides = {}) => ({
      operation: "update_conversation_preference", conversationId: id,
      expectedPreferenceRevision: 0, idempotencyKey: `thread-pref-${++nextKey}`,
      notificationPreference: "mentions", isStarred: false, mute: { muted: false }, ...overrides,
    });
    const command = (input, overrides = {}) => updateConversationPreference({
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
        WHERE payload->'input'->>'conversationId' = $1 ORDER BY event_id`, [id])).rows;
      return result;
    };
    const assertNoClaim = async (input) => assert.equal((await sql(
      `SELECT count(*)::integer AS count FROM ${prefix}.chat_idempotency_keys
       WHERE client_key = $1`, [input.idempotencyKey])).rows[0].count, 0);

    for (const level of ["mentions", "none", "all"]) {
      await t.test(`parent member saves ${level} at revision one before following`, async () => {
        const id = `first-${level}`;
        await seed(id);
        const before = await snapshot(id);
        const input = request(id, { notificationPreference: level });
        const result = await command(input);
        assert.equal(result.reconciliationStatus, "applied");
        assert.equal(result.preferenceRevision, 1);
        const after = await snapshot(id);
        assert.equal(after.chat_conversation_preferences[0].notification_level, level);
        assert.equal(after.chat_conversation_members[0].state, "active");
        assert.equal(after.chat_read_cursors[0].last_read_sequence, "0");
        assert.deepEqual(after.chat_thread_follows, []);
        assert.deepEqual(after.chat_drafts, []);
        assert.deepEqual(after.conversation, before.conversation);
        assert.equal(after.audit.length, 1);
        assert.equal(after.audit[0].metadata.previousPreferenceRevision, 0);
        assert.equal(after.outbox.length, 1);
        assert.equal(after.outbox[0].stream_id, "user:reader");
        assert.deepEqual(after.outbox[0].payload.result, result);
        assert.deepEqual(await command(input), { ...result, reconciliationStatus: "replayed" });
        assert.deepEqual(await snapshot(id), after);
        const noop = await command({ ...input, idempotencyKey: `${input.idempotencyKey}-noop`, expectedPreferenceRevision: 1 });
        assert.equal(noop.reconciliationStatus, "already_requested_state");
        assert.equal(noop.preferenceRevision, 1);
        assert.deepEqual(await snapshot(id), after);
      });
    }
    await t.test("public parent needs no parent or child membership", async () => {
      await seed("public", { visibility: "public" });
      assert.equal((await command(request("public"))).reconciliationStatus, "applied");
      assert.deepEqual((await snapshot("public")).chat_thread_follows, []);
    });
    await t.test("missing preference conflict leaves revision zero and no setup", async () => {
      await seed("empty-conflict");
      const before = await snapshot("empty-conflict");
      const input = request("empty-conflict", { expectedPreferenceRevision: 7 });
      const result = await command(input);
      assert.equal(result.reconciliationStatus, "preference_revision_conflict");
      assert.equal(result.preferenceRevision, 0);
      assert.deepEqual(await snapshot("empty-conflict"), before);
      assert.deepEqual(await command(input), result);
    });
    for (const following of [true, false]) {
      await t.test(`retained mute, role, cursor, draft and follow=${following} survive setup and retries`, async () => {
        const id = `retained-${following}`;
        await seed(id);
        await command(request(id));
        await sql(`UPDATE ${prefix}.chat_conversation_members SET role = 'moderator', state = 'left'
          WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_conversation_preferences SET muted = true,
          muted_until = '2099-01-01T00:00:00Z', is_starred = true, preference_revision = 7
          WHERE conversation_id = $1`, [id]);
        await sql(`UPDATE ${prefix}.chat_read_cursors SET last_read_sequence = 9,
          manual_unread_from_sequence = 4 WHERE conversation_id = $1`, [id]);
        await sql(`INSERT INTO ${prefix}.chat_thread_follows
          (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
          VALUES ('tenant-a', $1, 'reader', $2, 'manual', 8)`, [id, following]);
        await sql(`INSERT INTO ${prefix}.chat_drafts (tenant_id, conversation_id, user_id, content, revision)
          VALUES ('tenant-a', $1, 'reader', '{"format":"plain","text":"draft"}', 6)`, [id]);
        const before = await snapshot(id);
        const input = request(id, { expectedPreferenceRevision: 7, notificationPreference: "none",
          isStarred: true, mute: { muted: true, mutedUntil: "2099-01-01T00:00:00.000Z" } });
        const result = await command(input);
        assert.equal(result.preferenceRevision, 8);
        assert.equal(result.reconciliationStatus, "applied");
        const after = await snapshot(id);
        for (const table of ["chat_read_cursors", "chat_thread_follows", "chat_drafts", "conversation"])
          assert.deepEqual(after[table], before[table]);
        const { state, updated_at, ...membership } = before.chat_conversation_members[0];
        assert.deepEqual(after.chat_conversation_members[0], {
          ...membership, state: "active", updated_at: after.chat_conversation_members[0].updated_at,
        });
        assert.deepEqual(after.chat_conversation_preferences[0], {
          ...before.chat_conversation_preferences[0], notification_level: "none", preference_revision: "8",
          updated_at: after.chat_conversation_preferences[0].updated_at,
        });
        assert.deepEqual(await command(input), { ...result, reconciliationStatus: "replayed" });
        const stale = await command(request(id, { expectedPreferenceRevision: 7 }));
        assert.equal(stale.reconciliationStatus, "preference_revision_conflict");
        assert.equal(stale.preferenceRevision, 8);
        assert.deepEqual(stale.preference, result.preference);
        assert.deepEqual(await snapshot(id), after);
      });
    }
    for (const reason of ["membership", "entity", "missing-adapter", "throwing-adapter", "parent-archive", "thread-archive"]) {
      await t.test(`${reason} denial rejects new writes and completed retries with active child storage`, async () => {
        const id = `denied-${reason}`;
        const entity = ["entity", "missing-adapter", "throwing-adapter"].includes(reason);
        await seed(id, { entity });
        const calls = [];
        const allowed = { permissions: { async authorizeEntity(value) { calls.push(value); return true; } } };
        const input = request(id);
        await command(input, allowed);
        if (entity) assert.deepEqual(calls[0], { actor, entity: { type: "case", id: "host-case" }, action: "conversation.preference.update" });
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
        const fresh = request(id, { expectedPreferenceRevision: 1, notificationPreference: "none" });
        await assert.rejects(command(fresh, options), denied);
        await assertNoClaim(fresh);
        await assert.rejects(command(input, options), denied);
        assert.deepEqual(await snapshot(id), before);
      });
    }
    await t.test("denied first access and a denial during setup leave no private or durable effects", async () => {
      for (const denyOnCall of [1, 2]) {
        const id = `setup-denial-${denyOnCall}`;
        await seed(id, { entity: true });
        const before = await snapshot(id);
        let calls = 0;
        const input = request(id);
        await assert.rejects(command(input, { permissions: {
          async authorizeEntity() { return ++calls < denyOnCall; },
        } }), denied);
        assert.equal(calls, denyOnCall);
        assert.deepEqual(await snapshot(id), before);
        await assertNoClaim(input);
      }
    });
    await t.test("outbox failure rolls back participant setup, preference, audit and idempotency", async () => {
      const id = "rollback";
      await seed(id);
      const before = await snapshot(id);
      await sql(`CREATE FUNCTION ${prefix}.reject_thread_preference() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected thread preference outbox failure'; END $$`);
      await sql(`CREATE TRIGGER reject_thread_preference BEFORE INSERT ON ${prefix}.chat_outbox_events
        FOR EACH ROW EXECUTE FUNCTION ${prefix}.reject_thread_preference()`);
      const input = request(id);
      await assert.rejects(command(input), /injected thread preference outbox failure/);
      assert.deepEqual(await snapshot(id), before);
      await assertNoClaim(input);
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
