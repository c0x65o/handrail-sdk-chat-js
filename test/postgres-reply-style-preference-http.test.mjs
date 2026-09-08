import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { createChatServer } from "../src/server/create-chat-server.ts";
import {
  REPLY_STYLE_PREFERENCE_FEATURE,
  parseReplyStylePreferenceState,
  parseUpdateReplyStylePreferenceResult,
} from "../src/contracts/reply-style-preference.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

// Source bundle belongs in node_modules/.cache; shared dist is never overwritten.
const route = "/preferences/reply-style";
const actor = { tenantId: "tenant-a", userId: "alice", roles: [] };
const input = (idempotencyKey, baseRevision = 0, style = "discord") => ({
  operation: "update_reply_style_preference", style, baseRevision, idempotencyKey,
});

// Same real Node HTTP pattern as postgres-thread-list-http.test.mjs.
async function withHttp(runtime, callback) {
  await Promise.all([runtime.outboxPublisher.stop(), runtime.postgresMaintenance.stop()]);
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (method, path = route, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, {
      method, headers: {
        ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
  try {
    await callback({
      request,
      get: (options) => request("GET", route, options),
      patch: (value, options = {}) => request("PATCH", route, { body: JSON.stringify(value), ...options }),
      meta: () => request("GET", "/_meta"),
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.close();
  }
}

function assertError(response, status, code, message) {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.deepEqual(response.body, { error: { code, message } });
}
const invalid = response => assertError(response, 400,
  "chat_reply_style_preference_invalid_request", "Invalid reply-style preference request");
const unavailable = response => assertError(response, 503,
  "chat_reply_style_preference_unavailable", "Reply-style preference temporarily unavailable");

test("reply-style preference HTTP with isolated real PostgreSQL", { timeout: 60_000 }, async t => {
  const backend = await createPostgresTestBackend();
  let harness, readOnlyConnection;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_reply_style_http" });
    const prefix = `"${harness.schema}"`;
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; canonical migrations and isolated schema`);
    let authCalls = 0, databaseCalls = 0, allowAdmission = true, authResult = actor;
    const admissions = [], outcomes = [];
    const database = {
      query(...args) { databaseCalls++; return (readOnlyConnection ?? harness.pool).query(...args); },
      connect() { databaseCalls++; return harness.pool.connect(); },
    };
    const config = {
      database: { pool: database, schema: harness.schema },
      features: { [REPLY_STYLE_PREFERENCE_FEATURE]: true },
      auth: { async resolveActor() { authCalls++; if (authResult instanceof Error) throw authResult; return authResult; } },
      directory: { async getUser() { assert.fail("preference queried directory"); }, async searchUsers() { assert.fail("preference searched directory"); } },
      permissions: { async getCapabilities() { return []; }, async authorizeEntity() { assert.fail("preference is not entity scoped"); } },
      admission: { async admit(value) { admissions.push(value); return allowAdmission
        ? { decision: "allow" } : { decision: "deny", retryAfterSeconds: 12 }; } },
      httpObservability: { onOutcome: value => outcomes.push(value) },
    };
    const saved = (style, revision) => ({ state: "saved", style, revision });
    await withHttp(createChatServer(config), async http => {
      await t.test("admission metadata and denial precede authentication and persistence for both methods", async () => {
        allowAdmission = false;
        const before = [authCalls, databaseCalls];
        for (const method of ["GET", "PATCH"]) {
          const response = await http.request(method);
          assertError(response, 429, "chat_request_not_admitted", "Chat request temporarily unavailable");
          assert.equal(response.headers["retry-after"], "12");
          assert.equal(admissions.at(-1).routeTemplate, route);
          assert.equal(admissions.at(-1).method, method);
          assert.equal(outcomes.at(-1).routeTemplate, route);
          assert.equal(outcomes.at(-1).tenantId, undefined);
        }
        assert.deepEqual([authCalls, databaseCalls], before);
        allowAdmission = true;
      });

      await t.test("trusted authentication rejects null, malformed actors and thrown secrets", async () => {
        const before = databaseCalls;
        for (const value of [null, {}, { ...actor, tenantId: "" }, { ...actor, roles: "admin" }, new Error("secret-host-token")]) {
          authResult = value;
          for (const response of [await http.get(), await http.patch(input("unauthenticated"))]) {
            assertError(response, 401, "CHAT_AUTHENTICATION_FAILED", "Chat authentication failed");
          }
        }
        assert.equal(databaseCalls, before);
        authResult = actor;
      });

      await t.test("canonical absent GET, explicit Current save, switch and saved GET", async () => {
        const absent = await http.get();
        assert.equal(absent.status, 200);
        assert.deepEqual(parseReplyStylePreferenceState(absent.body), { state: "absent", revision: 0 });
        assert.equal(absent.headers["cache-control"], "private, no-store");
        for (const value of [input("first", 0, "current"), input("switch", 1)]) {
          const response = await http.patch(value);
          assert.equal(response.status, 200);
          assert.equal(response.headers["cache-control"], "private, no-store");
          assert.equal(admissions.at(-1).method, "PATCH");
          const audit = await sql(`SELECT request_id FROM ${prefix}.chat_audit_events
            WHERE tenant_id=$1 AND actor_user_id=$2 AND action='reply.style.update'
              AND metadata->>'currentPreferenceRevision'=$3`,
          [actor.tenantId, actor.userId, String(value.baseRevision + 1)]);
          assert.equal(audit.rows[0].request_id, response.headers["x-handrail-request-id"]);
          const result = parseUpdateReplyStylePreferenceResult(response.body, value);
          assert.equal(result.reconciliationStatus, "applied");
          assert.deepEqual(result.preference, saved(value.style, value.baseRevision + 1));
          assert.deepEqual((await http.get()).body, result.preference);
        }
        assert.equal(outcomes.at(-1).tenantId, actor.tenantId);
        assert.equal(outcomes.at(-1).userId, actor.userId);
        assert.equal(outcomes.at(-1).statusCode, 200);
        assert.equal(outcomes.at(-1).routeTemplate, route);
      });

      await t.test("replay, no-op, stale revision and key reuse map without losing reconciliation", async () => {
        const replay = await http.patch(input("first", 0, "current"));
        assert.equal(replay.status, 200);
        assert.equal(replay.body.reconciliationStatus, "replayed");
        assert.deepEqual(replay.body.preference, saved("current", 1));
        assert.deepEqual((await http.get()).body, saved("discord", 2));
        for (const [value, status, reconciliationStatus] of [
          [input("noop", 2), 200, "already_requested_state"],
          [input("stale", 1), 409, "preference_revision_conflict"],
        ]) {
          const first = await http.patch(value);
          assert.equal(first.status, status);
          assert.equal(parseUpdateReplyStylePreferenceResult(first.body, value).reconciliationStatus, reconciliationStatus);
          assert.deepEqual((await http.patch(value)).body, first.body);
        }
        for (const value of [input("switch", 1, "current"), input("switch", 0)]) {
          assertError(await http.patch(value), 409, "chat_reply_style_preference_idempotency_conflict",
            "Reply-style preference request conflicts with current server state");
          assert.equal(outcomes.at(-1).outcomeCode, "chat_reply_style_preference_idempotency_conflict");
        }
        assert.equal((await sql(`SELECT count(*) FROM ${prefix}.chat_outbox_events WHERE type='reply.style.updated'`)).rows[0].count, "2");
      });

      await t.test("user and tenant isolation includes identical idempotency keys", async () => {
        for (const identity of [{ ...actor, userId: "bob" }, { ...actor, tenantId: "tenant-b" }]) {
          authResult = identity;
          assert.deepEqual((await http.get()).body, { state: "absent", revision: 0 });
          const stale = await http.patch(input("absent-conflict", 1));
          assert.equal(stale.status, 409);
          assert.deepEqual(stale.body.preference, { state: "absent", revision: 0 });
          assert.equal((await http.patch(input("first", 0, "current"))).body.reconciliationStatus, "applied");
          assert.deepEqual((await http.get()).body, saved("current", 1));
        }
        authResult = actor;
        assert.deepEqual((await http.get()).body, saved("discord", 2));
      });

      await t.test("malformed transport, strict body and identity injection fail before database access", async () => {
        const before = databaseCalls;
        for (const query of ["unknown=1", "tenantId=other", "userId=other", "actor=admin", "style=current", "x=1&x=2"]) {
          for (const method of ["GET", "PATCH"]) {
            invalid(await http.request(method, `${route}?${query}`, method === "PATCH" ? { body: JSON.stringify(input("bad-query")) } : {}));
          }
        }
        for (const body of ["{}", "null", "[1]", "broken"]) invalid(await http.get({ body }));
        invalid(await http.get({ headers: { "transfer-encoding": "chunked" } }));
        for (const body of ["", "{", "null", "[]", "{}", JSON.stringify({ ...input("huge"), padding: "x".repeat(65536) })]) {
          invalid(await http.request("PATCH", route, { body }));
        }
        invalid(await http.patch(input("media"), { headers: { "content-type": "text/plain" } }));
        for (const overrides of [
          { operation: "other" }, { style: "future" }, { baseRevision: -1 }, { baseRevision: 1.5 },
          { idempotencyKey: " bad " }, { unknown: true }, { actor: { userId: "admin" } },
          { tenantId: "tenant-b" }, { userId: "bob" }, { Actor_User_ID: "bob" },
          { wrapper: { authorization: "admin" } },
        ]) invalid(await http.patch({ ...input("invalid"), ...overrides }));
        for (const header of ["x-user-id", "x-tenant-id", "x-chat-actor", "x-handrail-roles", "capabilities"]) {
          invalid(await http.get({ headers: { [header]: "spoof" } }));
          invalid(await http.patch(input("spoof"), { headers: { [header]: "spoof" } }));
        }
        assert.equal(databaseCalls, before);
      });

      await t.test("unknown stored styles remain saved in GET and revision conflicts", async () => {
        await sql(`ALTER TABLE ${prefix}.chat_user_reply_style_preferences DROP CONSTRAINT chat_user_reply_style_preferences_style_check`);
        try {
          await sql(`UPDATE ${prefix}.chat_user_reply_style_preferences SET style=' future-style ' WHERE tenant_id=$1 AND user_id=$2`, [actor.tenantId, actor.userId]);
          assert.deepEqual((await http.get()).body, saved(" future-style ", 2));
          const conflict = await http.patch(input("future-conflict", 0));
          assert.equal(conflict.status, 409);
          assert.deepEqual(conflict.body.preference, saved(" future-style ", 2));
          assert.deepEqual((await http.patch(input("future-conflict", 0))).body, conflict.body);
          assert.equal((await http.patch(input("restore", 2))).status, 200);
        } finally {
          await sql(`ALTER TABLE ${prefix}.chat_user_reply_style_preferences ADD CONSTRAINT chat_user_reply_style_preferences_style_check CHECK (style IN ('current','discord'))`);
        }
      });

      await t.test("typed in-progress conflict rolls back the save and uses a stable 409", async () => {
        await sql(`CREATE FUNCTION ${prefix}.suppress_reply_completion() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.client_key='in-progress' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
        await sql(`CREATE TRIGGER suppress_reply_completion BEFORE UPDATE ON ${prefix}.chat_idempotency_keys
          FOR EACH ROW EXECUTE FUNCTION ${prefix}.suppress_reply_completion()`);
        try {
          assertError(await http.patch(input("in-progress", 3, "current")), 409,
            "chat_reply_style_preference_idempotency_in_progress", "Reply-style preference request conflicts with current server state");
          assert.deepEqual((await http.get()).body, saved("discord", 3));
        } finally {
          await sql(`DROP TRIGGER suppress_reply_completion ON ${prefix}.chat_idempotency_keys`);
          await sql(`DROP FUNCTION ${prefix}.suppress_reply_completion()`);
        }
      });

      await t.test("true metadata requires opt-in and installed writable persistence, independent of realtime", async () => {
        const meta = await http.meta();
        assert.equal(meta.status, 200);
        assert.equal(meta.body.enabledFeatures[REPLY_STYLE_PREFERENCE_FEATURE], true);
        assert.equal(meta.body.enabledFeatures.realtime, false);
        assert.equal(meta.body.enabledFeatures.discord, undefined);
        readOnlyConnection = await harness.pool.connect();
        await readOnlyConnection.query("BEGIN READ ONLY");
        try {
          assert.equal((await http.meta()).body.enabledFeatures[REPLY_STYLE_PREFERENCE_FEATURE], false);
          unavailable(await http.get());
          unavailable(await http.patch(input("read-only", 3, "current")));
        } finally {
          await readOnlyConnection.query("ROLLBACK");
          readOnlyConnection.release(); readOnlyConnection = undefined;
        }
        assert.equal((await http.meta()).body.enabledFeatures[REPLY_STYLE_PREFERENCE_FEATURE], true);
      });

      await t.test("lost required persistence disables advertisement and never fakes a successful save", async () => {
        await sql(`ALTER TABLE ${prefix}.chat_user_reply_style_preferences RENAME TO hidden_reply_preferences`);
        try {
          assert.equal((await http.meta()).body.enabledFeatures[REPLY_STYLE_PREFERENCE_FEATURE], false);
          unavailable(await http.get());
          unavailable(await http.patch(input("missing", 3, "current")));
          assert.equal(outcomes.at(-1).outcomeCode, "chat_reply_style_preference_unavailable");
        } finally {
          await sql(`ALTER TABLE ${prefix}.hidden_reply_preferences RENAME TO chat_user_reply_style_preferences`);
        }
        // Readiness cannot guarantee arbitrary trigger behavior; real failures stay sanitized.
        await sql(`CREATE FUNCTION ${prefix}.reject_reply_save() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'secret internal storage failure'; END $$`);
        await sql(`CREATE TRIGGER reject_reply_save BEFORE UPDATE ON ${prefix}.chat_user_reply_style_preferences
          FOR EACH ROW EXECUTE FUNCTION ${prefix}.reject_reply_save()`);
        try {
          unavailable(await http.patch(input("trigger-failure", 3, "current")));
          assert.deepEqual((await http.get()).body, saved("discord", 3));
        } finally {
          await sql(`DROP TRIGGER reject_reply_save ON ${prefix}.chat_user_reply_style_preferences`);
          await sql(`DROP FUNCTION ${prefix}.reject_reply_save()`);
        }
      });
    });

    await t.test("default and explicitly disabled routes return 501 with false metadata and no preference queries", async () => {
      for (const features of [undefined, { [REPLY_STYLE_PREFERENCE_FEATURE]: false }]) {
        await withHttp(createChatServer({ ...config, features }), async http => {
          assert.equal((await http.meta()).body.enabledFeatures[REPLY_STYLE_PREFERENCE_FEATURE], false);
          const before = databaseCalls;
          for (const result of [await http.get(), await http.patch(input("disabled"))]) {
            assertError(result, 501, "chat_reply_style_preference_disabled", "Reply-style preference is not supported");
          }
          assert.equal(databaseCalls, before);
          assert.equal((await http.request("POST")).status, 404);
        });
      }
    });

    await t.test("uninstalled and pre-preference schemas do not advertise or return success", async () => {
      const partial = await backend.createHarness({ schemaPrefix: "chat_reply_partial" });
      try {
        for (const migrated of [false, true]) {
          if (migrated) await createPostgresMigrationRunner({ database: partial.pool, schema: partial.schema,
            migrations: handrailChatPostgresMigrations.filter(migration => migration.order < 41) }).apply();
          await withHttp(createChatServer({ ...config, database: { pool: partial.pool, schema: partial.schema } }), async http => {
            assert.equal((await http.meta()).body.enabledFeatures[REPLY_STYLE_PREFERENCE_FEATURE], false);
            unavailable(await http.get());
            unavailable(await http.patch(input("not-installed")));
          });
        }
      } finally { await partial.teardown(); }
    });
  } finally {
    if (readOnlyConnection) { await readOnlyConnection.query("ROLLBACK"); readOnlyConnection.release(); }
    await harness?.teardown();
    await backend.teardown();
  }
});
