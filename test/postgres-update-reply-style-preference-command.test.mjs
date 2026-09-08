import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

// Bundle this test from source with esbuild (see docs/validation/reply-style-preference-command.md).
// No package self-imports or shared dist output: concurrent builds cannot supply stale command code.
import { updateReplyStylePreference, UpdateReplyStylePreferenceCommandError,
  UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_OPERATION,
  UPDATE_REPLY_STYLE_PREFERENCE_AUDIT_ACTION } from "../src/server/update-reply-style-preference-command.ts";
import { parseUpdateReplyStylePreferenceResult } from "../src/contracts/reply-style-preference.ts";
import { parseKnownDurableEvent } from "../src/contracts/generated/durable-events.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant-a", userId: "alice", roles: [] };
const input = (key, style = "discord", baseRevision = 0) => ({
  operation: "update_reply_style_preference", style, baseRevision, idempotencyKey: key,
});
const keyConflict = (error) => error instanceof UpdateReplyStylePreferenceCommandError &&
  error.code === "idempotency_conflict" && error.statusCode === 409;

test("transactional reply-style saves on isolated PostgreSQL", { timeout: 60_000 }, async (t) => {
  const backend = await createPostgresTestBackend();
  t.diagnostic(`PostgreSQL harness: ${backend.kind}`);
  try {
    const harness = await backend.createHarness({ schemaPrefix: "reply_style_command" });
    try {
      const schema = `"${harness.schema.replaceAll('"', '""')}"`;
      await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
        migrations: handrailChatPostgresMigrations }).apply();
      const command = (request, identity = actor, extra = {}) => updateReplyStylePreference({
        database: harness.pool, schema: harness.schema, actor: identity, input: request,
        requestId: "reply-style-test", ...extra,
      });
      const rows = async (table) => (await harness.pool.query(
        `SELECT * FROM ${schema}.${table} ORDER BY to_jsonb(${table})::text`,
      )).rows;
      const saved = async (identity = actor) => (await harness.pool.query(
        `SELECT * FROM ${schema}.chat_user_reply_style_preferences WHERE tenant_id=$1 AND user_id=$2`,
        [identity.tenantId, identity.userId],
      )).rows[0];
      const effects = async () => ({ audit: await rows("chat_audit_events"),
        outbox: await rows("chat_outbox_events") });
      const snapshot = async () => ({ ...await effects(), preferences: await rows("chat_user_reply_style_preferences"),
        idempotency: await rows("chat_idempotency_keys") });
      const applied = [];
      const apply = async (request, identity = actor, extra = {}) => {
        const result = await command(request, identity, extra);
        assert.equal(result.reconciliationStatus, "applied");
        assert.deepEqual(result, parseUpdateReplyStylePreferenceResult(result, request));
        assert.deepEqual(result.preference, { state: "saved", style: request.style, revision: request.baseRevision + 1 });
        applied.push({ request, identity, result, stored: await saved(identity) });
        return result;
      };
      // Nonempty legacy fixtures prove saving a global style does not mutate shared state.
      await harness.pool.query(`INSERT INTO ${schema}.chat_conversations (tenant_id,id,type,visibility,name)
        VALUES ('tenant-a','channel','channel','public','Legacy')`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_messages
        (tenant_id,conversation_id,id,sequence,author_user_id,client_message_id,content)
        VALUES ('tenant-a','channel','root',1,'alice','root','{"format":"plain","text":"Which launch date?"}')`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_conversations
        (tenant_id,id,type,visibility,parent_conversation_id,root_message_id,name)
        VALUES ('tenant-a','thread','thread','public','channel','root','Launch')`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_conversation_members
        (tenant_id,conversation_id,user_id,role,state) VALUES ('tenant-a','channel','alice','member','active')`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_conversation_preferences
        (tenant_id,conversation_id,user_id,notification_level,muted,is_starred,preference_revision)
        VALUES ('tenant-a','channel','alice','mentions',true,true,7)`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_thread_follows
        (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
        VALUES ('tenant-a','thread','alice',true,'manual',3)`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_read_cursors
        (tenant_id,conversation_id,user_id,last_read_sequence) VALUES ('tenant-a','channel','alice',1)`);
      await harness.pool.query(`INSERT INTO ${schema}.chat_drafts
        (tenant_id,conversation_id,user_id,revision,content) VALUES ('tenant-a','channel','alice',1,'{"format":"plain","text":"Friday"}')`);
      await harness.pool.query(`UPDATE ${schema}.chat_conversations
        SET closed_at = '2030-01-01T00:00:00Z', closed_by_user_id = 'alice', locked = true,
            archived_at = '2030-01-01T00:00:00Z', archived_by_user_id = 'alice'
        WHERE tenant_id = 'tenant-a' AND id = 'thread'`);
      const unrelatedTables = ["chat_conversations", "chat_messages", "chat_conversation_members",
        "chat_conversation_preferences", "chat_thread_follows", "chat_read_cursors", "chat_drafts"];
      const unrelated = async () => {
        const result = {};
        for (const table of unrelatedTables) result[table] = await rows(table);
        return result;
      };
      const beforeUnrelated = await unrelated();

      await t.test("stale absent state stays absent and explicit current creates revision one", async () => {
        const identity = { ...actor, userId: "explicit-current" };
        const request = input("absent-conflict", "current", 4);
        const before = await effects();
        const conflict = await command(request, identity);
        assert.equal(conflict.reconciliationStatus, "preference_revision_conflict");
        assert.deepEqual(conflict.preference, { state: "absent", revision: 0 });
        assert.equal(await saved(identity), undefined);
        assert.deepEqual(await effects(), before);
        await apply(input("current-first", "current"), identity);
        assert.deepEqual(await command(request, identity), conflict);
      });

      await t.test("first save, switch-back, stale matching value, no-op and immutable replay", async () => {
        const request = input("first");
        const first = await apply(request);
        const firstRow = await saved();
        const noopRequest = input("noop", "discord", 1);
        const conflictRequest = input("stale-matching", "discord", 0);
        const before = await effects();
        const noop = await command(noopRequest);
        assert.equal(noop.reconciliationStatus, "already_requested_state");
        const conflict = await command(conflictRequest);
        assert.equal(conflict.reconciliationStatus, "preference_revision_conflict");
        assert.deepEqual(conflict.preference, first.preference);
        assert.deepEqual(await saved(), firstRow);
        assert.deepEqual(await effects(), before);
        await apply(input("switch-back", "current", 1));
        const laterSnapshot = await snapshot();
        assert.deepEqual(await command(request), { ...first, reconciliationStatus: "replayed" });
        assert.deepEqual(await command(noopRequest), noop);
        assert.deepEqual(await command(conflictRequest), conflict);
        assert.deepEqual(await snapshot(), laterSnapshot);
        for (const changed of [input("first", "current"), input("first", "discord", 1)]) {
          await assert.rejects(command(changed), keyConflict);
        }
        assert.deepEqual(await snapshot(), laterSnapshot);
      });

      await t.test("same key is independent across trusted tenants and users without memberships", async () => {
        const beforeAlice = await saved();
        await apply(input("first"), { ...actor, userId: "bob" });
        await apply(input("first", "current"), { ...actor, tenantId: "tenant-b" });
        assert.deepEqual(await saved(), beforeAlice);
      });

      await t.test("different keys serialize simultaneous first saves and existing-row updates", async () => {
        for (const sameStyle of [false, true]) {
          const identity = { ...actor, userId: `concurrent-${sameStyle}` };
          for (const baseRevision of [0, 1]) {
            const currentStyle = baseRevision ? (await saved(identity)).style : undefined;
            const desiredStyle = currentStyle === "discord" ? "current" : "discord";
            const requests = [
              input(`race-${baseRevision}-a`, desiredStyle, baseRevision),
              input(`race-${baseRevision}-b`, baseRevision || sameStyle ? desiredStyle : "current", baseRevision),
            ];
            const results = await Promise.all(requests.map(request => command(request, identity)));
            assert.deepEqual(results.map(r => r.reconciliationStatus).sort(), ["applied", "preference_revision_conflict"]);
            const winner = results.findIndex(r => r.reconciliationStatus === "applied");
            const loser = 1 - winner;
            assert.deepEqual(results[loser].preference, results[winner].preference);
            applied.push({ request: requests[winner], identity, result: results[winner], stored: await saved(identity) });
          }
        }
      });

      await t.test("simultaneous same-key first saves apply once and replay once", async () => {
        const identity = { ...actor, userId: "same-key-race" };
        const request = input("simultaneous");
        const results = await Promise.all([command(request, identity), command(request, identity)]);
        assert.deepEqual(results.map(r => r.reconciliationStatus).sort(), ["applied", "replayed"]);
        assert.deepEqual(results[0].preference, results[1].preference);
        applied.push({ request, identity, result: results.find(r => r.reconciliationStatus === "applied"), stored: await saved(identity) });
      });

      await t.test("conflict preserves an unsupported raw stored style", async () => {
        // Simulate a future writer/schema in this isolated harness only.
        await harness.pool.query(`ALTER TABLE ${schema}.chat_user_reply_style_preferences
          DROP CONSTRAINT chat_user_reply_style_preferences_style_check`);
        const identity = { ...actor, userId: "future-style" };
        await harness.pool.query(`INSERT INTO ${schema}.chat_user_reply_style_preferences
          (tenant_id,user_id,style,revision) VALUES ('tenant-a','future-style',' Future Style ',8)`);
        const before = await effects();
        const result = await command(input("future-stale", "current", 7), identity);
        assert.deepEqual(result.preference, { state: "saved", revision: 8, style: " Future Style " });
        assert.equal(result.reconciliationStatus, "preference_revision_conflict");
        assert.equal((await saved(identity)).style, " Future Style ");
        assert.deepEqual(await effects(), before);
        await apply(input("future-replace", "current", 8), identity);
        await harness.pool.query(`ALTER TABLE ${schema}.chat_user_reply_style_preferences
          ADD CONSTRAINT chat_user_reply_style_preferences_style_check CHECK (style IN ('current','discord'))`);
      });

      await t.test("audit, outbox and final idempotency failures each roll back the whole transaction", async () => {
        for (const [table, operation] of [["chat_audit_events", "INSERT"], ["chat_outbox_events", "INSERT"], ["chat_idempotency_keys", "UPDATE"]]) {
          for (const existing of [false, true]) {
            const identity = { ...actor, userId: `rollback-${table}-${existing}` };
            if (existing) await apply(input("seed"), identity);
            const request = input("rollback", "current", existing ? 1 : 0);
            const before = await snapshot();
            // Real PostgreSQL failure after the state write, including after both effects.
            await harness.pool.query(`CREATE FUNCTION ${schema}.reject_reply_save() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN RAISE EXCEPTION 'injected reply save failure'; END $$`);
            await harness.pool.query(`CREATE TRIGGER reject_reply_save BEFORE ${operation} ON ${schema}.${table}
              FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_reply_save()`);
            try {
              await assert.rejects(command(request, identity), /injected reply save failure/);
              assert.deepEqual(await snapshot(), before);
              assert.equal(harness.pool.waitingCount, 0);
              assert.equal(harness.pool.idleCount, harness.pool.totalCount);
            } finally {
              await harness.pool.query(`DROP TRIGGER reject_reply_save ON ${schema}.${table}`);
              await harness.pool.query(`DROP FUNCTION ${schema}.reject_reply_save()`);
            }
            await apply(request, identity); // The rolled-back key remains usable.
          }
        }
      });

      await t.test("strict parsing rejects spoofed identity and malformed values before any writes", async () => {
        const before = await snapshot();
        for (const request of [{ ...input("spoof"), userId: "bob" }, { ...input("spoof"), tenantId: "tenant-b" },
          input("invalid", "future"), input("invalid", "current", -1), input("invalid", "current", Number.MAX_SAFE_INTEGER)]) {
          await assert.rejects(command(request));
        }
        assert.deepEqual(await snapshot(), before);
      });

      await t.test("every applied change has one parsed private event, audit and exact idempotent response", async () => {
        const { audit, outbox } = await effects();
        assert.equal(audit.length, applied.length);
        assert.equal(outbox.length, applied.length);
        for (const { request, identity, result, stored } of applied) {
          const matches = outbox.filter(e => e.tenant_id === identity.tenantId && e.stream_id === `user:${identity.userId}` &&
            e.payload.mutation.idempotencyKey === request.idempotencyKey);
          assert.equal(matches.length, 1);
          const event = matches[0];
          const timestamp = stored.updated_at.toISOString();
          assert.equal(event.type, "reply.style.updated");
          assert.equal(event.occurred_at.toISOString(), timestamp);
          assert.deepEqual(event.payload, { actorUserId: identity.userId, preference: result.preference, updatedAt: timestamp, mutation: request });
          assert.equal(event.expires_at - event.occurred_at, 7 * 24 * 60 * 60 * 1000);
          const envelope = { eventId: event.event_id, protocolVersion: Number(event.protocol_version),
            tenantId: event.tenant_id, streamId: event.stream_id, type: event.type,
            occurredAt: timestamp, payload: event.payload };
          assert.equal(parseKnownDurableEvent(envelope, identity).type, "reply.style.updated");
          assert.throws(() => parseKnownDurableEvent(envelope, { ...identity, userId: "someone-else" }), { code: "private_stream_mismatch" });
          assert.throws(() => parseKnownDurableEvent(envelope, { ...identity, tenantId: "another-tenant" }), { code: "tenant_mismatch" });
          const audits = audit.filter(a => a.tenant_id === identity.tenantId && a.actor_user_id === identity.userId &&
            a.metadata.currentPreferenceRevision === result.preference.revision);
          assert.equal(audits.length, 1);
          assert.equal(audits[0].action, UPDATE_REPLY_STYLE_PREFERENCE_AUDIT_ACTION);
          assert.equal(audits[0].target_type, "user");
          assert.equal(audits[0].target_id, identity.userId);
          assert.equal(audits[0].request_id, "reply-style-test");
          assert.equal(audits[0].occurred_at.toISOString(), timestamp);
          assert.deepEqual(audits[0].metadata, { style: request.style,
            previousPreferenceRevision: request.baseRevision, currentPreferenceRevision: result.preference.revision });
        }
        for (const row of await rows("chat_idempotency_keys")) {
          assert.equal(row.operation_name, UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_OPERATION);
          assert.equal(row.state, "completed");
          const result = row.response_body;
          const expectedHash = createHash("sha256").update(JSON.stringify({ baseRevision: result.baseRevision,
            operation: result.operation, style: result.requestedStyle })).digest("hex");
          assert.equal(row.request_hash, `sha256:${expectedHash}`);
          assert.equal(row.response_status, result.reconciliationStatus === "preference_revision_conflict" ? 409 : 200);
          assert.ok(row.expires_at > row.created_at);
          assert.ok(Math.abs(row.expires_at - row.created_at - 24 * 60 * 60 * 1000) < 1000);
          const accepted = applied.find(a => a.identity.tenantId === row.tenant_id && a.identity.userId === row.user_id &&
            a.request.idempotencyKey === row.client_key);
          if (accepted) assert.deepEqual(row.response_body, accepted.result);
        }
        assert.deepEqual(await unrelated(), beforeUnrelated);
      });
    } finally {
      await harness.teardown();
      assert.equal(await backend.schemaExists(harness.schema), false);
    }
  } finally {
    await backend.teardown();
  }
});
