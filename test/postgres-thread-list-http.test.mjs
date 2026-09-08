import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createChatServer } from "../src/server/create-chat-server.ts";
import { THREAD_LIST_PATH, parseThreadListResult } from "../src/contracts/thread-list.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

// Bundle canonical sources into node_modules/.cache (two levels below package.json).
// Use the existing isolated PostgreSQL backend; no database fake or skip fallback.
const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
const path = (id = "public", query = "") => `/conversations/${id}/threads${query}`;
const ids = result => result.items.map(item => item.thread.id);

async function withHttp(runtime, callback) {
  // Discovery must be measured independently of normal background maintenance.
  await Promise.all([runtime.outboxPublisher.stop(), runtime.postgresMaintenance.stop()]);
  const server = createServer(runtime.router);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (route, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${route}`, {
      method: "GET", headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(body);
  });
  try { await callback(get); }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  }
}

function assertError(result, status, code, message) {
  assert.equal(result.status, status);
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.deepEqual(result.body, { error: { code, message } });
}

test("channel thread discovery HTTP integration with real PostgreSQL", { timeout: 60_000 }, async t => {
  const backend = await createPostgresTestBackend();
  let harness;
  let connection;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_thread_list_http" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema and canonical migrations`);
    await sql(`INSERT INTO ${prefix}.chat_conversations (tenant_id,id,type,visibility,name,entity_type,entity_id)
      VALUES ('tenant-a','public','channel','public','Public',null,null),
        ('tenant-a','private','channel','private','Private',null,null),
        ('tenant-a','entity','channel','public','Entity','case','secret-case'),
        ('tenant-b','public','channel','public','Other tenant',null,null)`);
    for (const [id, parent, sequence] of [["a", "public", 1], ["b", "public", 2], ["private-child", "private", 1]]) {
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content)
        VALUES ('tenant-a',$1,$2,$3,'author',$1,'{"format":"plain","text":"Root"}')`, [`${id}-root`, parent, sequence]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id,id,type,visibility,name,parent_conversation_id,root_message_id,created_at,updated_at)
        VALUES ('tenant-a',$1,'thread','private',$1,$2,$3,'2026-01-01','2026-01-01')`, [id,parent,`${id}-root`]);
    }
    // Retained child membership/follow cannot authorize its private parent.
    await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
      VALUES ('tenant-a','private-child','reader','owner','active'),
        ('tenant-a','private','reader','member','active')`);
    await sql(`INSERT INTO ${prefix}.chat_thread_follows
      (tenant_id,conversation_id,user_id,is_following,follow_source,follow_revision)
      VALUES ('tenant-a','private-child','reader',true,'manual',1)`);
    await sql(`UPDATE ${prefix}.chat_conversation_members SET state='removed'
      WHERE tenant_id='tenant-a' AND conversation_id='private' AND user_id='reader'`);
    await sql(`UPDATE ${prefix}.chat_conversations SET lifecycle_revision=1,closed_at='2026-01-02',closed_by_user_id='admin'
      WHERE tenant_id='tenant-a' AND id='b'`);

    const state = async () => {
      const tables = (await sql("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [harness.schema])).rows;
      const result = {};
      for (const { tablename } of tables) {
        result[tablename] = (await sql(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text),'[]') AS rows
          FROM (SELECT to_jsonb(t) AS row FROM ${prefix}."${tablename}" AS t) AS data`)).rows[0].rows;
      }
      return result;
    };
    let authCalls = 0, queryCalls = 0, connectCalls = 0, entityAllowed = true, admissionAllowed = true;
    let policy = false;
    const scopes = [], admissions = [], outcomes = [], entityCalls = [];
    // Instrument real PostgreSQL calls without replacing persistence behavior.
    const database = {
      query(...args) { queryCalls++; return (connection ?? harness.pool).query(...args); },
      connect() { connectCalls++; return harness.pool.connect(); },
    };
    const config = {
      database: { pool: database, schema: harness.schema },
      features: { threadDiscovery: true, threadInactivity: true },
      auth: { async resolveActor(request) { authCalls++; return request.headers.authorization === "invalid" ? null : actor; } },
      directory: { async getUser() { assert.fail("discovery queried directory"); }, async searchUsers() { assert.fail("discovery searched directory"); } },
      permissions: { async getCapabilities() { return []; }, async authorizeEntity(input) {
        entityCalls.push(input); return entityAllowed;
      } },
      admission: { async admit(input) { admissions.push(input); return admissionAllowed
        ? { decision: "allow" } : { decision: "deny", retryAfterSeconds: 12 }; } },
      threadInactivityPolicy: async scope => { scopes.push(scope); return policy; },
      httpObservability: { onOutcome: outcome => outcomes.push(outcome) },
    };
    await withHttp(createChatServer(config), async get => {
      const before = await state();
      connection = await harness.pool.connect();
      await connection.query("BEGIN READ ONLY");
      const initialConnections = connectCalls;

      await t.test("authorized page and continuation are scoped, canonical, and independent of lifecycle", async () => {
        const first = await get(path("public", "?limit=1"));
        assert.equal(first.status, 200);
        assert.equal(first.headers["cache-control"], "private, no-store");
        assert.deepEqual(parseThreadListResult(first.body, { parentConversationId: "public", limit: 1 }), first.body);
        assert.deepEqual(ids(first.body), ["a"]);
        assert.ok(first.body.nextCursor);
        const second = await get(path("public", `?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`));
        assert.equal(second.status, 200);
        assert.deepEqual(ids(second.body), ["b"]);
        assert.equal(second.body.nextCursor, undefined);
        assert.equal(second.body.lifecycleSupported, false);
        assert.equal(second.body.items[0].thread.threadLifecycle, undefined);
        assert.deepEqual(second.body.items[0].currentThreadFollow, { followRevision: 0, follow: null });
        assert.deepEqual(scopes.at(-1), { tenantId: "tenant-a", parentConversationId: "public" });
        assert.equal(admissions.at(-1).routeTemplate, THREAD_LIST_PATH);
        assert.equal(admissions.at(-1).method, "GET");
        assert.equal(outcomes.at(-1).routeTemplate, THREAD_LIST_PATH);
        assert.equal(outcomes.at(-1).tenantId, actor.tenantId);
        assert.equal(outcomes.at(-1).userId, actor.userId);
        assert.equal(outcomes.at(-1).statusCode, 200);
        const mismatched = await get(path("private", `?cursor=${encodeURIComponent(first.body.nextCursor)}`));
        assert.equal(mismatched.status, 400);
      });

      await t.test("malformed pagination, duplicate keys, identity fields and bodies fail before querying", async () => {
        const beforeQueries = queryCalls;
        for (const query of ["cursor=bad", "cursor=", "limit=0", "limit=101", "limit=1.5", "limit=01", "limit=NaN",
          "limit=1&limit=2", "view=all&view=all", "cursor=a&cursor=b", "view=unknown", "tenantId=tenant-b", "userId=admin",
          "actor=admin", "roles=admin", "lifecycleSupported=true", "parentConversationId=private", "__proto__=spoof"]) {
          assertError(await get(path("public", `?${query}`)), 400, "chat_thread_list_invalid_request", "Invalid thread list request");
        }
        assertError(await get(path(), { body: '{"actor":{"tenantId":"tenant-b","userId":"admin"}}' }),
          400, "chat_thread_list_invalid_request", "Invalid thread list request");
        assertError(await get(path(), { headers: { "transfer-encoding": "chunked" } }),
          400, "chat_thread_list_invalid_request", "Invalid thread list request");
        assertError(await get(path("%ZZ")), 400, "chat_thread_list_invalid_request", "Invalid thread list request");
        for (const header of ["x-user-id", "x-tenant-id", "x-chat-actor", "x-handrail-roles", "capabilities"]) {
          assertError(await get(path(), { headers: { [header]: "spoof" } }),
            400, "chat_thread_list_invalid_request", "Invalid thread list request");
        }
        assert.equal(queryCalls, beforeQueries);
      });

      await t.test("private and entity parents retain server authorization and trusted tenant isolation", async () => {
        const policyCalls = scopes.length;
        assertError(await get(path("private")),
          403, "CHAT_AUTHORIZATION_FAILED", "Chat authorization failed");
        assert.equal(scopes.length, policyCalls);
        entityAllowed = false;
        assertError(await get(path("entity")), 403, "CHAT_AUTHORIZATION_FAILED", "Chat authorization failed");
        assert.equal(scopes.length, policyCalls);
        assert.deepEqual(entityCalls.at(-1), { actor, entity: { type: "case", id: "secret-case" }, action: "thread.list" });
        entityAllowed = true;
        assert.equal((await get(path("entity"))).status, 200);
        const trusted = await get(path());
        assert.deepEqual(ids(trusted.body), ["a", "b"]);
        assert.equal(trusted.body.items[0].thread.tenantId, actor.tenantId);
      });

      await t.test("admission denial precedes trusted context and query, authentication stays safe", async () => {
        admissionAllowed = false;
        const counts = [authCalls, queryCalls, scopes.length];
        const denied = await get(path("public", "?tenantId=spoof"));
        assertError(denied, 429, "chat_request_not_admitted", "Chat request temporarily unavailable");
        assert.equal(denied.headers["retry-after"], "12");
        assert.deepEqual([authCalls, queryCalls, scopes.length], counts);
        assert.equal(outcomes.at(-1).tenantId, undefined);
        admissionAllowed = true;
        assertError(await get(path(), { headers: { authorization: "invalid" } }),
          401, "CHAT_AUTHENTICATION_FAILED", "Chat authentication failed");
        assert.equal(queryCalls, counts[1]);
      });

      await t.test("capability is advertised with the enabled handler; policy never enables lifecycle", async () => {
        const meta = await get("/_meta");
        assert.equal(meta.body.enabledFeatures.threadDiscovery, true);
        assert.equal(meta.body.enabledFeatures.threadLifecycle, false);
        assert.equal(meta.body.enabledFeatures.realtime, false);
        policy = { hideAfterMs: 1 };
        const all = await get(path("public", "?view=all"));
        assert.equal(all.body.lifecycleSupported, false);
        assert.deepEqual(all.body.inactivityPolicy, policy);
        assert.deepEqual(ids(all.body), ["a", "b"]);
        assert.deepEqual(ids((await get(path())).body), []);
        policy = { hideAfterMs: -1 };
        assert.deepEqual(ids((await get(path())).body), ["a", "b"]);
        policy = false;
        const general = await get("/conversations?scope=organization");
        assert.equal(general.status, 200);
        assert.equal(general.body.kind, "conversation_list");
        assert.ok(general.body.items.every(item => item.type !== "thread"));
      });

      assert.equal(connectCalls, initialConnections, "discovery must not open command transactions");
      await connection.query("COMMIT");
      connection.release(); connection = undefined;
      assert.deepEqual(await state(), before, "all persisted state, including follow and outbox rows, stays unchanged");
    });

    await t.test("database failures return safe availability errors without internal details", async () => {
      await withHttp(createChatServer({ ...config, database: { pool: database, schema: "uninstalled_thread_list" } }), async get => {
        assertError(await get(path()), 503, "chat_thread_list_unavailable", "Thread list temporarily unavailable");
        assert.equal(outcomes.at(-1).outcomeCode, "chat_thread_list_unavailable");
      });
    });

    await t.test("unsupported discovery is deliberately disabled by default and explicitly, without a query", async () => {
      for (const features of [undefined, { threadDiscovery: false }]) {
        await withHttp(createChatServer({ ...config, features }), async get => {
          const meta = await get("/_meta");
          assert.equal(meta.body.enabledFeatures.threadDiscovery, false);
          const before = queryCalls;
          assertError(await get(path()), 501, "chat_thread_discovery_disabled", "Thread discovery is not supported");
          assert.equal(queryCalls, before);
        });
      }
    });
  } finally {
    if (connection) { await connection.query("ROLLBACK"); connection.release(); }
    await harness?.teardown();
    await backend.teardown();
  }
});
