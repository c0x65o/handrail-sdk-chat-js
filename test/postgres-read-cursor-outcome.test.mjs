import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { createChatClient, createNormalizedChatCache } from "@handrail/chat/client";
import { parseReadCursorMutationOutcome } from "@handrail/chat";
import { createChatServer, createPostgresMigrationRunner, handrailChatPostgresMigrations,
  updateReadCursor, UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION } from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
const read = (conversationId, key, throughSequence = 6) => ({
  operation: "mark_read", conversationId, throughSequence, idempotencyKey: key,
});
const unread = (conversationId, key, fromSequence = 4) => ({
  operation: "mark_unread", conversationId, fromSequence, idempotencyKey: key,
});
const receipt = ({ reconciliationStatus, idempotencyKey, ...result }) => result;

for (const boundary of ["command", "HTTP"]) {
  test(`${boundary}: complete immutable read cursor acknowledgements`, async (t) => {
    const backend = await createPostgresTestBackend();
    const harness = await backend.createHarness({ schemaPrefix: "chat_ack" });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    let runtime, server;
    let entityAllowed = true;
    const permissions = { getCapabilities: async () => [], authorizeEntity: async () => entityAllowed };
    const fixtures = [];
    try {
      await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
        migrations: handrailChatPostgresMigrations }).apply();
      t.diagnostic(`PostgreSQL ${(await sql("SHOW server_version")).rows[0].server_version}; isolated schema; canonical migrations`);
      const seed = async (id, tenant = actor.tenantId, user = actor.userId) => {
        await sql(`INSERT INTO ${prefix}.chat_conversations
          (tenant_id,id,type,visibility,name,current_message_sequence)
          VALUES ($1,$2,'channel','private',$2,10)`, [tenant,id]);
        await sql(`INSERT INTO ${prefix}.chat_conversation_members
          (tenant_id,conversation_id,user_id,role,state) VALUES ($1,$2,$3,'member','active')`, [tenant,id,user]);
      };
      const seedThread = async (id) => {
        await seed(`${id}-parent`);
        await sql(`UPDATE ${prefix}.chat_conversations SET entity_type='case', entity_id='case-1' WHERE id=$1`, [`${id}-parent`]);
        await sql(`INSERT INTO ${prefix}.chat_messages
          (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content)
          VALUES ('tenant-a',$1,$2,1,'reader',$1,'{"format":"plain","text":"root"}')`, [`${id}-root`,`${id}-parent`]);
        await sql(`INSERT INTO ${prefix}.chat_conversations
          (tenant_id,id,type,visibility,parent_conversation_id,root_message_id,current_message_sequence)
          VALUES ('tenant-a',$1,'thread','private',$2,$3,10)`, [id,`${id}-parent`,`${id}-root`]);
      };
      const snapshot = async () => {
        const state = {};
        for (const table of ["chat_read_cursors", "chat_idempotency_keys", "chat_audit_events", "chat_outbox_events",
          "chat_conversation_members", "chat_conversation_preferences", "chat_thread_follows"]) {
          state[table] = (await sql(`SELECT row_to_json(t)::text AS value FROM ${prefix}.${table} t ORDER BY row_to_json(t)::text`)).rows;
        }
        return state;
      };
      let send;
      if (boundary === "HTTP") {
        runtime = createChatServer({ database: { pool: harness.pool, schema: harness.schema },
          auth: { resolveActor: async (request) => request.headers.authorization === "Bearer other-user"
            ? { ...actor, userId: "other" } : request.headers.authorization === "Bearer other-tenant"
            ? { ...actor, tenantId: "tenant-b" } : actor },
          directory: { getUser: async () => undefined, searchUsers: async () => [] }, permissions });
        await runtime.postgresMaintenance.stop();
        await runtime.outboxPublisher.stop();
        server = createServer(runtime.router);
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        send = async (input, identity = actor) => {
          const response = await fetch(`http://127.0.0.1:${server.address().port}/conversations/${input.conversationId}/read-cursor`, {
            method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey,
              authorization: identity.tenantId !== actor.tenantId ? "Bearer other-tenant" : identity.userId !== actor.userId ? "Bearer other-user" : "Bearer valid" },
            body: JSON.stringify(input),
          });
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          return { status: response.status, body: await response.json() };
        };
      } else {
        send = async (input, identity = actor) => {
          try { return { status: 200, body: await updateReadCursor({ database: harness.pool, schema: harness.schema, actor: identity, input, permissions }) }; }
          catch (error) { return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } }; }
        };
      }
      const accepted = async (input, status, identity = actor) => {
        const response = await send(input, identity);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(parseReadCursorMutationOutcome(response.body, input), response.body);
        assert.equal(response.body.reconciliationStatus, status);
        assert.equal(response.body.readState.userId, identity.userId);
        fixtures.push({ input, outcome: response.body });
        return response.body;
      };
      const denied = async (input, identity = actor, status = 403) => {
        const before = await snapshot();
        const response = await send(input, identity);
        assert.equal(response.status, status, JSON.stringify(response.body));
        if (status === 403) assert.deepEqual(response.body, { error: { code: "CHAT_AUTHORIZATION_FAILED", message: "Chat authorization failed" } });
        assert.deepEqual(await snapshot(), before);
      };
      await t.test("first application, no-op, lost acknowledgement and later intent retain exact receipts", async () => {
        const id = "ack-order";
        await seed(id);
        const firstInput = read(id, "read-original");
        const first = await accepted(firstInput, "applied");
        const unchanged = await accepted(read(id, "read-no-op"), "applied");
        assert.deepEqual(unchanged.readState, first.readState);
        const unreadInput = unread(id, "unread-original");
        const marked = await accepted(unreadInput, "applied");
        const sameUnread = await accepted(unread(id, "unread-no-op"), "applied");
        assert.deepEqual(sameUnread.readState, marked.readState);
        let before = await snapshot();
        assert.deepEqual(await accepted(firstInput, "replayed"), { ...first, reconciliationStatus: "replayed" });
        assert.deepEqual(await snapshot(), before);
        await accepted(read(id, "newer-read", 9), "applied");
        before = await snapshot();
        assert.deepEqual(await accepted(unreadInput, "replayed"), { ...marked, reconciliationStatus: "replayed" });
        assert.deepEqual(await snapshot(), before);
        const rows = (await sql(`SELECT response_body FROM ${prefix}.chat_idempotency_keys WHERE client_key=$1`, [firstInput.idempotencyKey])).rows;
        assert.deepEqual(rows[0].response_body, receipt(first), "legacy receipt shape stays unchanged on disk");
        for (const input of [{ ...firstInput, throughSequence: 7 }, unread(id, firstInput.idempotencyKey), read("other-conversation", firstInput.idempotencyKey)]) {
          await denied(input, actor, 409);
        }
        await denied(firstInput, { ...actor, userId: "other" });
        await denied(firstInput, { ...actor, tenantId: "tenant-b" });
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state='left' WHERE conversation_id=$1`, [id]);
        await denied(firstInput);
        await denied(unreadInput);
        await denied(read(id, "revoked-fresh", 10));
      });
      await t.test("legacy completed receipt is returned without rewriting any historical data", async () => {
        const id = "legacy";
        await seed(id);
        const input = read(id, "legacy-key");
        const legacy = { operation: "mark_read", conversationId: id,
          readState: { conversationId: id, userId: actor.userId, lastReadSequence: 6, updatedAt: "2026-01-01T00:00:00.000Z" }, latestSequence: 10, unreadCount: 4 };
        const hash = `sha256:${createHash("sha256").update(JSON.stringify({ conversationId: id, operation: "mark_read", throughSequence: 6 })).digest("hex")}`;
        await sql(`INSERT INTO ${prefix}.chat_idempotency_keys
          (tenant_id,user_id,operation_name,client_key,request_hash,state,response_status,response_body,created_at,updated_at,completed_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,'completed',200,$6,'2026-01-01','2026-01-01','2026-01-01','2099-01-01')`,
        [actor.tenantId,actor.userId,UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,input.idempotencyKey,hash,legacy]);
        const before = await snapshot();
        assert.deepEqual(await accepted(input, "replayed"), { ...legacy, reconciliationStatus: "replayed", idempotencyKey: input.idempotencyKey });
        assert.deepEqual(await snapshot(), before);
      });
      await t.test("same key is isolated by tenant and actor", async () => {
        const id = "isolated";
        await seed(id);
        await seed(id, "tenant-b");
        await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
          VALUES ('tenant-a',$1,'other','member','active')`, [id]);
        for (const identity of [actor, { ...actor, userId: "other" }, { ...actor, tenantId: "tenant-b" }]) {
          const input = read(id, "shared-key");
          const first = await accepted(input, "applied", identity);
          assert.deepEqual(await accepted(input, "replayed", identity), { ...first, reconciliationStatus: "replayed" });
        }
      });
      await t.test("completed thread replay rechecks entity and parent access", async () => {
        const id = "parent-authority";
        await seedThread(id);
        const input = read(id, "parent-key");
        await accepted(input, "applied");
        entityAllowed = false;
        await denied(input);
        entityAllowed = true;
        await sql(`UPDATE ${prefix}.chat_conversation_members SET state='left' WHERE conversation_id=$1`, [`${id}-parent`]);
        await denied(input);
      });
      await t.test("concurrent duplicates commit once and expired keys retain claim semantics", async () => {
        const id = "concurrent";
        await seed(id);
        const input = read(id, "concurrent-key");
        const results = await Promise.all(Array.from({ length: 4 }, () => send(input)));
        for (const result of results) assert.deepEqual(parseReadCursorMutationOutcome(result.body, input), result.body);
        assert.deepEqual(results.map(x => x.body.reconciliationStatus).sort(), ["applied", "replayed", "replayed", "replayed"]);
        const before = await snapshot();
        assert.equal(before.chat_audit_events.filter(x => x.value.includes(id)).length, 1);
        assert.equal(before.chat_outbox_events.filter(x => x.value.includes(id)).length, 1);
        const unreadInput = unread(id, "concurrent-unread-key");
        const unreadResults = await Promise.all(Array.from({ length: 4 }, () => send(unreadInput)));
        for (const result of unreadResults) assert.deepEqual(parseReadCursorMutationOutcome(result.body, unreadInput), result.body);
        assert.deepEqual(unreadResults.map(x => x.body.reconciliationStatus).sort(), ["applied", "replayed", "replayed", "replayed"]);
        const competingInputs = [read(id, "concurrent-clear"), unread(id, "concurrent-new-marker", 3)];
        const competing = await Promise.all(competingInputs.map(input => accepted(input, "applied")));
        const newest = competing.toSorted((a, b) => a.readState.updatedAt.localeCompare(b.readState.updatedAt)).at(-1);
        const persisted = (await sql(`SELECT manual_unread_from_sequence, updated_at FROM ${prefix}.chat_read_cursors WHERE conversation_id=$1`, [id])).rows[0];
        assert.equal(persisted.updated_at.toISOString(), newest.readState.updatedAt);
        assert.equal(persisted.manual_unread_from_sequence, newest.readState.manualUnreadFromSequence?.toString() ?? null);
        // Seed history already expired; never bypass immutable receipt guards.
        await sql(`INSERT INTO ${prefix}.chat_idempotency_keys
          (tenant_id,user_id,operation_name,client_key,request_hash,state,response_status,response_body,created_at,updated_at,completed_at,expires_at)
          SELECT tenant_id,user_id,operation_name,'expired-key',request_hash,state,response_status,response_body,
            '2020-01-01','2020-01-01','2020-01-01','2020-01-02'
          FROM ${prefix}.chat_idempotency_keys WHERE client_key=$1`, [input.idempotencyKey]);
        // Expiry is maintenance-owned: an unpruned receipt still binds the key.
        await denied({ ...input, idempotencyKey: "expired-key", throughSequence: 8 }, actor, 409);
        const expiredBefore = await snapshot();
        await accepted({ ...input, idempotencyKey: "expired-key" }, "replayed");
        assert.deepEqual(await snapshot(), expiredBefore);
      });
      if (boundary === "HTTP") {
        await t.test("public JS client settles both commands against real HTTP", async () => {
          const id = "js-client";
          await seed(id);
          const at = "2020-01-01T00:00:00.000Z";
          const cache = createNormalizedChatCache({ ...actor, sessionId: "js-proof" });
          cache.hydrateConversationList({ kind: "conversation_list", scope: { type: "organization" }, page: {},
            _meta: { packageVersion: "1.0.54", protocolVersion: 4, schemaVersion: 9, enabledFeatures: {},
              supportedProtocolRange: { minimumVersion: 4, maximumVersion: 4 }, feature: { name: "conversation_snapshots", version: 1 } },
            items: [{ id, tenantId: actor.tenantId, type: "channel", visibility: "private", name: id,
              createdAt: at, updatedAt: at, activityAt: at, latestSequence: 10, unreadMentionCount: 0, activeMemberUserIds: [actor.userId],
              currentMember: { tenantId: actor.tenantId, conversationId: id, userId: actor.userId, role: "member", state: "active", joinedAt: at, updatedAt: at },
              currentReadState: { conversationId: id, userId: actor.userId, lastReadSequence: 0, updatedAt: at },
              currentPreference: { conversationId: id, userId: actor.userId, notificationPreference: "all", mute: { muted: false }, updatedAt: at },
            }],
          });
          let key = 0;
          const client = createChatClient({ endpoint: `http://127.0.0.1:${server.address().port}`,
            getAccessToken: () => "valid", cache, readState: { generateIdempotencyKey: () => `js-client-${++key}` } });
          try {
            for (const operation of ["mark_read", "mark_unread"]) {
              const result = operation === "mark_read"
                ? await client.markRead({ conversationId: id, throughSequence: 6 })
                : await client.markUnread({ conversationId: id, fromSequence: 4 });
              assert.equal(result.status, "success");
              assert.equal(result.value.reconciliationStatus, "applied");
              assert.equal(result.value.idempotencyKey, `js-client-${key}`);
              assert.deepEqual(cache.getState().currentUser.readStates[id], result.value.readState);
            }
          } finally { client.close(); }
        });
      }
      if (process.env.READ_CURSOR_FLUTTER32_PROOF && boundary === "HTTP") {
        await t.test("unmodified published Flutter .32 runtime against candidate HTTP and PostgreSQL", async () => {
          for (const mode of ["valid", "lost", "malformed", "wrong-user", "denied", "429"]) await seed(`flutter-${mode}`);
          const output = await new Promise((resolve, reject) => {
            const child = spawn(process.env.READ_CURSOR_DART, [
              `--packages=${process.env.READ_CURSOR_DART_PACKAGES}`,
              process.env.READ_CURSOR_FLUTTER32_PROOF,
              `http://127.0.0.1:${server.address().port}`,
            ], { stdio: ["ignore", "pipe", "pipe"] });
            let text = "";
            child.stdout.on("data", chunk => { text += chunk; });
            child.stderr.on("data", chunk => { text += chunk; });
            child.on("error", reject);
            child.on("close", code => code === 0 ? resolve(text) : reject(new Error(`Dart exit ${code}: ${text}`)));
          });
          t.diagnostic(output);
          const cursors = (await sql(`SELECT conversation_id,last_read_sequence,manual_unread_from_sequence
            FROM ${prefix}.chat_read_cursors WHERE conversation_id LIKE 'flutter-%' ORDER BY conversation_id`)).rows;
          assert.equal(cursors.length, 5, "denied actor never commits a cursor");
          for (const row of cursors) {
            assert.equal(row.last_read_sequence, "6");
            assert.equal(row.manual_unread_from_sequence, row.conversation_id === "flutter-valid" ? "4" : null);
          }
          const counts = (await sql(`SELECT target_id,count(*)::int AS count FROM ${prefix}.chat_audit_events
            WHERE target_id LIKE 'flutter-%' GROUP BY target_id`)).rows;
          for (const row of counts) assert.equal(row.count, row.target_id === "flutter-valid" ? 2 : 1);
        });
      }
      if (process.env.READ_CURSOR_ACK_FIXTURES && boundary === "HTTP") {
        await writeFile(process.env.READ_CURSOR_ACK_FIXTURES, JSON.stringify(fixtures, null, 2) + "\n");
      }
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      await runtime?.close();
      await harness.teardown();
      await backend.teardown();
    }
  });
}
