import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createChatServer } from "../src/server/create-chat-server.ts";
import { CHAT_REPLY_THREAD_FEATURES as F } from "../src/contracts/generated/realtime-handshake.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const actor = { tenantId: "tenant", userId: "bob", roles: [] };
const reply = key => ({ operation: "send", conversationId: "parent", clientMessageId: key,
  idempotencyKey: key, content: { format: "plain", text: "Friday" },
  replyTo: { messageId: "root", notifyAuthor: false } });
const named = key => ({ operation: "create_thread", parentConversationId: "parent",
  rootMessageId: "root", name: "Launch date", initialFollow: true, idempotencyKey: key });
const lifecycle = key => ({ operation: "update_thread_lifecycle",
  intent: "close", expectedLifecycleRevision: 1, idempotencyKey: key });
const actions = [
  [F.inlineReplies, "POST", "/conversations/parent/messages", reply, "chat_inline_replies_disabled", "CHAT_MESSAGE_SEND_UNAVAILABLE"],
  [F.namedThreads, "POST", "/messages/root/thread", named, "chat_named_threads_disabled", "CHAT_THREAD_CREATION_UNAVAILABLE"],
  [F.savedReplyStyle, "GET", "/preferences/reply-style", () => undefined, "chat_reply_style_preference_disabled", "chat_reply_style_preference_unavailable"],
  [F.threadLifecycle, "PATCH", "/conversations/child/lifecycle", lifecycle, "chat_thread_lifecycle_disabled", "chat_thread_lifecycle_unavailable"],
  [F.threadDiscovery, "GET", "/conversations/parent/threads", () => undefined, "chat_thread_discovery_disabled", "chat_thread_list_unavailable"],
];
async function withHttp(config, callback) {
  const runtime = createChatServer(config);
  await runtime.outboxPublisher.stop();
  await runtime.postgresMaintenance.stop();
  const server = createServer(runtime.router);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const request = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "content-type": "application/json", ...(body?.idempotencyKey ? { "idempotency-key": body.idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try { await callback(request); }
  finally { await new Promise(resolve => server.close(resolve)); await runtime.close(); }
}
const error = (result, status, code) => {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
};

test("reply/thread deployment gates use real PostgreSQL independently of actor permissions", { timeout: 90_000 }, async t => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "reply_thread_gates" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    await sql(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id,id,type,visibility,name,current_message_sequence)
      VALUES ('tenant','parent','channel','public','Launch',2)`);
    await sql(`INSERT INTO ${prefix}.chat_messages
      (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content)
      VALUES ('tenant','root','parent',1,'alice','root','{"format":"plain","text":"Which launch date?"}'),
      ('tenant','legacy-root','parent',2,'alice','legacy-root','{"format":"plain","text":"Legacy root"}')`);
    await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
      VALUES ('tenant','parent','bob','member','active')`);
    let allowed = true;
    const config = {
      database: { pool: harness.pool, schema: harness.schema },
      auth: { async resolveActor() { return actor; } },
      directory: { async getUser() { return null; }, async searchUsers() { return []; } },
      permissions: { async getCapabilities() { return allowed ? ["message.send", "thread.create", "thread.manage"] : []; },
        async authorizeEntity() { return allowed; } },
    };
    const all = Object.fromEntries(Object.values(F).map(feature => [feature, true]));
    await t.test("absent and false flags disable new actions but retain ordinary sends/openThread", async () => {
      for (const features of [undefined, Object.fromEntries(Object.values(F).map(f => [f, false]))]) {
        await withHttp({ ...config, ...(features ? { features } : {}) }, async request => {
          const meta = await request("GET", "/_meta");
          for (const feature of Object.values(F)) assert.equal(meta.body.enabledFeatures[feature], false);
          for (const [, method, path, input, disabled] of actions) error(await request(method, path, input("disabled")), 501, disabled);
          const plain = reply(`ordinary-${features === undefined}`); delete plain.replyTo;
          assert.equal((await request("POST", "/conversations/parent/messages", plain)).status, 201);
          const legacy = { ...named(`legacy-${features === undefined}`), rootMessageId: "legacy-root" }; delete legacy.name;
          const opened = await request("POST", "/messages/legacy-root/thread", legacy);
          assert.ok([200, 201].includes(opened.status), JSON.stringify(opened.body));
        });
      }
    });
    await t.test("each capability can be enabled independently; inactivity needs discovery and policy", async () => {
      for (const feature of Object.values(F)) {
        await withHttp({ ...config, features: { [feature]: true } }, async request => {
          const flags = (await request("GET", "/_meta")).body.enabledFeatures;
          for (const candidate of Object.values(F)) assert.equal(flags[candidate],
            candidate === feature && feature !== F.threadInactivity, `${feature}: ${candidate}`);
        });
      }
      for (const [features, policy, ready] of [
        [{ [F.savedReplyStyle]: true }, async () => ({ hideAfterMs: 1 }), false],
        [{ [F.threadDiscovery]: true }, async () => ({ hideAfterMs: 1 }), false],
        [{ [F.threadDiscovery]: true, [F.threadInactivity]: true }, false, false],
        [{ [F.threadDiscovery]: true, [F.threadInactivity]: true }, async () => ({ hideAfterMs: 1 }), true],
      ]) {
        await withHttp({ ...config, features, threadInactivityPolicy: policy }, async request => {
          const flags = (await request("GET", "/_meta")).body.enabledFeatures;
          assert.equal(flags[F.threadInactivity], ready);
          assert.equal(flags[F.threadLifecycle], false);
          if (features[F.threadDiscovery]) {
            const list = await request("GET", "/conversations/parent/threads");
            assert.equal(list.status, 200);
            assert.deepEqual(list.body.inactivityPolicy, ready ? { hideAfterMs: 1 } : false);
          }
        });
      }
    });
    await t.test("enabled Reply stays in its conversation, creates no thread, and retains authorization", async () => {
      await withHttp({ ...config, features: { [F.inlineReplies]: true } }, async request => {
        const sent = await request("POST", "/conversations/parent/messages", reply("friday"));
        assert.equal(sent.status, 201, JSON.stringify(sent.body));
        const rows = (await sql(`SELECT conversation_id, reply_to_message_id FROM ${prefix}.chat_messages WHERE client_message_id='friday'`)).rows;
        assert.deepEqual(rows, [{ conversation_id: "parent", reply_to_message_id: "root" }]);
        assert.equal((await sql(`SELECT count(*)::int AS n FROM ${prefix}.chat_conversations WHERE type='thread' AND root_message_id='root'`)).rows[0].n, 0);
        allowed = false;
        error(await request("POST", "/conversations/parent/messages", reply("forbidden")), 403, "CHAT_AUTHORIZATION_FAILED");
        allowed = true;
      });
    });
    await t.test("named creation and lifecycle remain authorized with availability enabled", async () => {
      await withHttp({ ...config, features: all, threadInactivityPolicy: async () => false }, async request => {
        allowed = false;
        error(await request("POST", "/messages/root/thread", named("forbidden-name")), 403, "CHAT_AUTHORIZATION_FAILED");
        allowed = true;
        const created = await request("POST", "/messages/root/thread", named("named"));
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const id = created.body.conversation.conversation.id;
        assert.equal(created.body.conversation.conversation.name, "Launch date");
        await sql(`UPDATE ${prefix}.chat_conversation_members SET role='member' WHERE conversation_id=$1`, [id]);
        allowed = false;
        error(await request("PATCH", `/conversations/${id}/lifecycle`, { ...lifecycle("forbidden-close") }), 403, "CHAT_AUTHORIZATION_FAILED");
        allowed = true;
        const list = await request("GET", "/conversations/parent/threads");
        assert.equal(list.body.lifecycleSupported, true);
        const closed = await request("PATCH", `/conversations/${id}/lifecycle`, { ...lifecycle("close"),
          expectedLifecycleRevision: 1 });
        assert.equal(closed.status, 200, JSON.stringify(closed.body));
        // Revoked private-parent access must override retained child membership.
        await sql(`UPDATE ${prefix}.chat_conversations SET visibility='private' WHERE id='parent'`);
        await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
          VALUES ('tenant','parent','bob','member','removed')
          ON CONFLICT (tenant_id,conversation_id,user_id) DO UPDATE SET state='removed'`);
        error(await request("GET", "/conversations/parent/threads"), 403, "CHAT_AUTHORIZATION_FAILED");
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state='active' WHERE conversation_id='parent' AND user_id='bob'`);
      });
    });
    await t.test("turning flags off preserves named-thread reads and canonical legacy opening", async () => {
      const id = (await sql(`SELECT id FROM ${prefix}.chat_conversations WHERE root_message_id='root'`)).rows[0].id;
      await withHttp(config, async request => {
        assert.equal((await request("GET", `/conversations/${id}`)).status, 200);
        assert.equal((await request("GET", "/conversations/parent/messages")).status, 200);
        assert.equal((await request("GET", "/conversations/parent/messages/root/context")).status, 200);
        const legacy = named("read-existing-with-flags-off"); delete legacy.name;
        const opened = await request("POST", "/messages/root/thread", legacy);
        assert.equal(opened.status, 200, JSON.stringify(opened.body));
        assert.equal(opened.body.conversation.conversation.id, id);
        assert.equal(opened.body.conversation.conversation.name, "Launch date");
        assert.equal(opened.body.reconciliationStatus, "existing_for_root");
      });
    });
    await t.test("a high schema version cannot substitute for the named-thread migration", async () => {
      const connection = await harness.pool.connect();
      await connection.query("BEGIN");
      try {
        await connection.query(`DELETE FROM ${prefix}._handrail_migrations WHERE id='0040-chat-thread-names'`);
        await withHttp({ ...config, features: all, database: { schema: harness.schema, pool: {
          query: (...args) => connection.query(...args), connect: () => harness.pool.connect(),
        } } }, async request => {
          const meta = (await request("GET", "/_meta")).body;
          assert.equal(meta.schemaVersion, 43);
          assert.equal(meta.enabledFeatures[F.namedThreads], false);
          // A hole before applied migrations is incompatible canonical history.
          assert.equal(meta.enabledFeatures[F.inlineReplies], false);
          assert.equal(meta.enabledFeatures[F.threadLifecycle], false);
          error(await request("POST", "/messages/root/thread", named("missing-migration")), 503, "CHAT_THREAD_CREATION_UNAVAILABLE");
        });
      } finally { await connection.query("ROLLBACK"); connection.release(); }
    });
    await t.test("deployment table privileges are checked without granting actor permissions", async () => {
      const connection = await harness.pool.connect();
      const role = `cap_role_${harness.schema.slice(-20)}`;
      try {
        await connection.query(`CREATE ROLE ${role}`);
        await connection.query(`GRANT USAGE ON SCHEMA ${prefix} TO ${role}`);
        await connection.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${prefix} TO ${role}`);
        await connection.query(`SET ROLE ${role}`);
        await withHttp({ ...config, features: all, database: { schema: harness.schema, pool: {
          query: (...args) => connection.query(...args), connect: () => harness.pool.connect(),
        } } }, async request => {
          const flags = (await request("GET", "/_meta")).body.enabledFeatures;
          assert.equal(flags[F.threadDiscovery], true);
          for (const [feature, method, path, input, , unavailable] of actions.filter(a => a[0] !== F.threadDiscovery)) {
            assert.equal(flags[feature], false);
            error(await request(method, path, input(`privileges-${feature}`)), 503, unavailable);
          }
        });
      } finally {
        await connection.query("RESET ROLE");
        await connection.query(`DROP OWNED BY ${role}`);
        await connection.query(`DROP ROLE ${role}`);
        connection.release();
      }
    });
    await t.test("missing reply column suppresses dependent capabilities, not saved style", async () => {
      await sql(`ALTER TABLE ${prefix}.chat_messages RENAME COLUMN reply_to_message_id TO unavailable_reply_source`);
      try {
        await withHttp({ ...config, features: all }, async request => {
          const flags = (await request("GET", "/_meta")).body.enabledFeatures;
          assert.equal(flags[F.inlineReplies], false);
          assert.equal(flags[F.namedThreads], false);
          assert.equal(flags[F.savedReplyStyle], true);
          assert.equal(flags[F.threadLifecycle], true);
          for (const [feature, method, path, input, , unavailable] of actions.filter(a => a[0] !== F.savedReplyStyle && a[0] !== F.threadLifecycle)) {
            error(await request(method, path, input(`missing-${feature}`)), 503, unavailable);
          }
        });
      } finally { await sql(`ALTER TABLE ${prefix}.chat_messages RENAME COLUMN unavailable_reply_source TO reply_to_message_id`); }
    });
    await t.test("read-only storage suppresses writes while discovery remains available", async () => {
      const connection = await harness.pool.connect();
      try {
        await connection.query("SET default_transaction_read_only = on");
        await withHttp({ ...config, features: all, database: { pool: {
          query: (...args) => connection.query(...args), connect: () => harness.pool.connect(),
        }, schema: harness.schema } }, async request => {
          const flags = (await request("GET", "/_meta")).body.enabledFeatures;
          assert.equal(flags[F.threadDiscovery], true);
          for (const [feature, method, path, input, , unavailable] of actions.filter(a => a[0] !== F.threadDiscovery)) {
            assert.equal(flags[feature], false);
            error(await request(method, path, input(`readonly-${feature}`)), 503, unavailable);
          }
        });
      } finally { await connection.query("SET default_transaction_read_only = off"); connection.release(); }
    });
    t.diagnostic(`Real PostgreSQL ${backend.kind}, canonical migrations and isolated schema`);
  } finally { await harness?.teardown(); await backend.teardown(); }
});
