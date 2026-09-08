import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createChatServer, MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES } from "../src/server/create-chat-server.ts";
import { parseThreadLifecycleResult } from "../src/contracts/thread-lifecycle.ts";
import { parseConversationArchiveResult } from "../src/contracts/conversation-archive.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

// Bundle canonical sources before running; do not use shared dist artifacts.
const actor = { tenantId: "tenant-a", userId: "actor", roles: ["employee"] };
const route = (id = "thread space") => `/conversations/${encodeURIComponent(id)}/lifecycle`;
const input = (key, overrides = {}) => ({ operation: "update_thread_lifecycle", intent: "close",
  expectedLifecycleRevision: 1, idempotencyKey: key, ...overrides });
const canonical = (response, body, threadId = "thread space") => {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(parseThreadLifecycleResult(response.body, { ...body, threadId }), response.body);
  return response.body;
};
const assertError = (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.body, { error: { code, message } });
};

async function withHttp(runtime, callback) {
  await Promise.all([runtime.outboxPublisher.stop(), runtime.postgresMaintenance.stop()]);
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (body, { path = route(), headers = {}, method = "PATCH", raw, chunks } = {}) =>
    new Promise((resolve, reject) => {
      const payload = raw ?? JSON.stringify(body);
      const req = httpRequest(`${origin}${path}`, { method, headers: {
        authorization: "Bearer valid", "content-type": "application/json",
        ...(payload === undefined || chunks ? {} : { "content-length": Buffer.byteLength(payload) }),
        ...headers,
      } }, res => {
        const data = [];
        res.on("data", chunk => data.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
          body: JSON.parse(Buffer.concat(data).toString("utf8")) }));
      });
      req.on("error", reject);
      if (chunks) {
        for (const chunk of chunks) req.write(chunk);
        req.end();
      } else req.end(payload);
    });
  try { await callback(request); }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  }
}

test("thread lifecycle HTTP dispatch preserves archive compatibility with isolated PostgreSQL", { timeout: 60_000 }, async t => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_lifecycle_http" });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema, canonical migrations and source bundle`);
    await sql(`INSERT INTO ${prefix}.chat_conversations (tenant_id,id,type,visibility,name)
      VALUES ('tenant-a','parent','channel','public','Parent')`);
    await sql(`INSERT INTO ${prefix}.chat_messages
      (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content)
      VALUES ('tenant-a','root','parent',1,'author','root','{"format":"plain","text":"Root"}')`);
    await sql(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id,id,type,visibility,parent_conversation_id,root_message_id)
      VALUES ('tenant-a','thread space','thread','private','parent','root')`);
    await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
      VALUES ('tenant-a','thread space','actor','owner','active')`);

    let currentActor = actor, admissionAllowed = true, authCalls = 0, connects = 0;
    const admissions = [], outcomes = [], permissionActors = [];
    const database = {
      query: (...args) => harness.pool.query(...args),
      connect() { connects++; return harness.pool.connect(); },
    };
    const config = {
      features: { threadLifecycle: true },
      database: { pool: database, schema: harness.schema },
      auth: { async resolveActor(request) { authCalls++; return request.headers.authorization === "Bearer valid" ? currentActor : null; } },
      directory: { async getUser() { return null; }, async searchUsers() { return []; } },
      permissions: {
        async getCapabilities(trusted) { permissionActors.push(trusted); return ["message.send"]; },
        async authorizeEntity() { return true; },
      },
      admission: { async admit(value) { admissions.push(value); return admissionAllowed ? { decision: "allow" }
        : { decision: "deny", retryAfterSeconds: 7 }; } },
      httpObservability: { onOutcome: outcome => outcomes.push(outcome) },
    };
    await withHttp(createChatServer(config), async request => {
      await t.test("authenticated path/body normalization returns applied, replayed and no-op canonical responses", async () => {
        // No Idempotency-Key header is required by the lifecycle body contract.
        const body = input(" exact key preserved ");
        const response = await request(body);
        assert.equal(response.status, 200);
        const result = canonical(response, body);
        assert.equal(result.reconciliationStatus, "applied");
        assert.deepEqual(result.previousLifecycle, { revision: 1, locked: false });
        assert.equal(result.threadLifecycle.revision, 2);
        assert.equal(result.threadLifecycle.closedByUserId, actor.userId);
        assert.equal(result.threadLifecycle.locked, false);
        assert.ok(Number.isFinite(Date.parse(result.threadLifecycle.closedAt)));
        const retry = await request(body);
        assert.equal(retry.status, 200);
        assert.deepEqual(canonical(retry, body), { ...result, reconciliationStatus: "replayed" });
        const noop = input("noop", { expectedLifecycleRevision: 2 });
        const unchanged = await request(noop);
        assert.equal(unchanged.status, 200);
        assert.equal(canonical(unchanged, noop).reconciliationStatus, "already_requested_state");
        assert.deepEqual(unchanged.body.threadLifecycle, result.threadLifecycle);
        assert.deepEqual(permissionActors.at(-1), { actor });
        // One existing route template remains the admission/observability identity.
        assert.equal(admissions.at(-1).routeTemplate, "/conversations/:conversationId/lifecycle");
        assert.equal(outcomes.at(-1).routeTemplate, admissions.at(-1).routeTemplate);
        assert.equal(outcomes.at(-1).tenantId, actor.tenantId);
        assert.equal(outcomes.at(-1).userId, actor.userId);
        assert.equal(outcomes.at(-1).statusCode, 200);
      });

      await t.test("stale revision and key reuse have safe 409 outcomes", async () => {
        const stale = input("stale");
        const response = await request(stale);
        assert.equal(response.status, 409);
        const result = canonical(response, stale);
        assert.equal(result.reconciliationStatus, "lifecycle_conflict");
        assert.deepEqual(result.previousLifecycle, result.threadLifecycle);
        assert.equal(result.threadLifecycle.revision, 2);
        assert.equal(outcomes.at(-1).statusCode, 409);
        assertError(await request(input(" exact key preserved ", { intent: "lock" })), 409,
          "chat_thread_lifecycle_conflict", "Thread lifecycle conflicts with current server state");
      });

      await t.test("caller identity, moderation, canonical state, unknown fields and body threadId are rejected before command work", async () => {
        const before = connects;
        for (const claims of [{ actor: { userId: "admin" } }, { tenantId: "other" }, { roles: ["owner"] },
          { moderation: true }, { permissions: ["thread.manage"] }, { "ACTOR-context": { userId: "admin" } },
          { threadLifecycle: { revision: 2, locked: false } }, { nested: { authorization: "secret" } },
          { threadId: "thread space" }, { toggle: true }, { expectedLifecycleRevision: 0 }, { intent: "archive" }]) {
          assertError(await request(input("bad", claims)), 400,
            "chat_thread_lifecycle_invalid_request", "Invalid thread lifecycle request");
        }
        // Transport validation before dispatch retains the shared route's legacy errors.
        for (const options of [{ path: `${route()}?actor=admin` }, { path: "/conversations/%ZZ/lifecycle" },
          { path: "/conversations/a%2Fb/lifecycle" }, { path: "/conversations/a%5Cb/lifecycle" },
          { path: "/conversations/%00/lifecycle" }, { raw: "{" }, { headers: { "content-type": "text/plain" } },
          { raw: " ".repeat(MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES + 1) },
          { chunks: [" ".repeat(MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES), "x"] }]) {
          assertError(await request(input("bad"), options), 400,
            "CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST", "Invalid conversation archive request");
        }
        assert.equal(connects, before);
      });

      await t.test("authentication and admission reject before commands; authorization discloses no canonical state", async () => {
        const before = connects;
        assertError(await request(input("unauth"), { headers: { authorization: "" } }), 401,
          "CHAT_AUTHENTICATION_FAILED", "Chat authentication failed");
        assert.equal(connects, before);
        const authBefore = authCalls;
        admissionAllowed = false;
        const rejected = await request(input("admission"));
        assertError(rejected, 429, "chat_request_not_admitted", "Chat request temporarily unavailable");
        assert.equal(rejected.headers["retry-after"], "7");
        assert.equal(authCalls, authBefore);
        assert.equal(connects, before);
        assert.equal(outcomes.at(-1).tenantId, undefined);
        admissionAllowed = true;
        for (const deniedActor of [{ ...actor, userId: "ordinary-reader" }, { ...actor, tenantId: "other" }]) {
          currentActor = deniedActor;
          assertError(await request(input("denied")), 403, "CHAT_AUTHORIZATION_FAILED", "Chat authorization failed");
        }
        currentActor = actor;
        assertError(await request(input("missing"), { path: route("missing") }), 403,
          "CHAT_AUTHORIZATION_FAILED", "Chat authorization failed");
      });

      await t.test("archive and restore still use the same URL with their original validation and response contract", async () => {
        const archive = { operation: "set_conversation_archive", intent: "archive", conversationId: "thread space",
          expectedLifecycleRevision: 2, idempotencyKey: "archive" };
        const before = connects;
        for (const body of [archive, { ...archive, operation: "unknown" }]) {
          assertError(await request(body), 400, "CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST", "Invalid conversation archive request");
        }
        assertError(await request(archive, { headers: { "idempotency-key": "mismatch" } }), 400,
          "CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST", "Invalid conversation archive request");
        assert.equal(connects, before);
        const archived = await request(archive, { headers: { "idempotency-key": archive.idempotencyKey } });
        assert.equal(archived.status, 200);
        const archivedResult = parseConversationArchiveResult(archived.body, archive);
        assert.equal(archivedResult.archiveState.status, "archived");
        assertError(await request(input("archived", { intent: "reopen", expectedLifecycleRevision: 3 })), 403,
          "CHAT_AUTHORIZATION_FAILED", "Chat authorization failed");
        const restore = { ...archive, intent: "restore", expectedLifecycleRevision: archivedResult.lifecycleRevision,
          idempotencyKey: "restore" };
        const restored = await request(restore, { headers: { "idempotency-key": restore.idempotencyKey } });
        assert.equal(restored.status, 200);
        const restoredResult = parseConversationArchiveResult(restored.body, restore);
        assert.equal(restoredResult.archiveState.status, "active");
        const reopen = input("reopen", { intent: "reopen", expectedLifecycleRevision: restoredResult.lifecycleRevision });
        const opened = await request(reopen);
        assert.equal(opened.status, 200);
        assert.deepEqual(canonical(opened, reopen).threadLifecycle,
          { revision: restoredResult.lifecycleRevision + 1, locked: false });
      });

      await t.test("explicit lifecycle opt-in advertises ready support", async () => {
        const meta = await request(undefined, { path: "/_meta", method: "GET" });
        assert.equal(meta.status, 200);
        assert.notEqual(meta.body.enabledFeatures.thread_lifecycle_v1, true);
        assert.equal(meta.body.enabledFeatures.threadLifecycle, true);
      });
    });

    await t.test("internal command failures use sanitized lifecycle availability errors", async () => {
      await withHttp(createChatServer({ ...config, database: { pool: database, schema: "uninstalled_lifecycle_http" } }), async request => {
        assertError(await request(input("unavailable")), 503,
          "chat_thread_lifecycle_unavailable", "Thread lifecycle temporarily unavailable");
        assert.equal(outcomes.at(-1).outcomeCode, "chat_thread_lifecycle_unavailable");
      });
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
