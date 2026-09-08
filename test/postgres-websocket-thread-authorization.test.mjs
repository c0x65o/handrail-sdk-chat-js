import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { CHAT_PROTOCOL_VERSION } from "../src/contracts/realtime.ts";
import { createChatServer } from "../src/server/create-chat-server.ts";
import { authorizeChatWebSocketStream } from "../src/server/websocket-subscriptions.ts";
import { readChatWebSocketReplay, resolveBufferedReplayEvents } from "../src/server/websocket-replay.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

// Bundle canonical sources into an isolated artifact; never use shared dist.
test("thread websocket access follows current parent authority in PostgreSQL", { timeout: 60_000 }, async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  let runtime;
  let server;
  try {
    harness = await backend.createHarness({ schemaPrefix: "socket_thread_access" });
    const prefix = `"${harness.schema}"`;
    const sql = (text, values) => harness.pool.query(text, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);
    const actor = { tenantId: "tenant-a", userId: "reader", roles: [] };
    const listeners = new Set();
    const sessions = [];
    const denied = new Set();
    let hostFailure = false;
    let malformedHostResult = false;
    let relationshipFailure = false;
    const entityChecks = [];
    const permissions = {
      async getCapabilities() { return ["messages.read"]; },
      async authorizeEntity(input) {
        entityChecks.push(input);
        if (hostFailure) throw new Error("private host failure");
        if (malformedHostResult) return "true";
        return !denied.has(input.entity.id);
      },
    };
    // Failure injection only; all successful SQL executes against PostgreSQL.
    const database = {
      query(text, values) {
        if (relationshipFailure && text.includes("parent_conversation_id") && !text.includes("parent_member")) {
          throw new Error("private relationship failure");
        }
        return sql(text, values);
      },
      connect() { return harness.pool.connect(); },
    };
    runtime = createChatServer({
      database: { pool: database, schema: harness.schema },
      auth: { async resolveActor(request) {
        const [tenantId, userId] = request.headers.authorization.split("/");
        return { tenantId, userId, roles: [] };
      } },
      directory: { async getUser() { return null; }, async searchUsers() { return []; } },
      permissions,
      realtime: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async publish(event) { for (const listener of listeners) await listener(event); } },
      outbox: { pollIntervalMs: 60_000 },
      webSocket: { onSession(socket, session) { sessions.push({ socket, session }); } },
    });
    server = createServer(runtime.router);
    runtime.attachWebSocket(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connect = async (identity = actor, cursor) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/_realtime`, {
        headers: { authorization: `${identity.tenantId}/${identity.userId}` },
      });
      const received = [];
      const messages = [];
      const waiters = [];
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        received.push(message);
        if (waiters.length) waiters.shift()(message);
        else messages.push(message);
      });
      const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("message timeout")), 2_000);
        waiters.push((message) => { clearTimeout(timer); resolve(message); });
      });
      await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      socket.send(JSON.stringify({ clientPackageVersion: "0.1.3", protocolVersion: CHAT_PROTOCOL_VERSION,
        ...(cursor ? { resumeFrom: { eventId: cursor.event.eventId } } : {}) }));
      assert.equal((await next()).type, "chat.session.accepted");
      return { socket, next, received, state: sessions.at(-1), async subscribe(streamId) {
        socket.send(JSON.stringify({ type: "chat.subscribe", requestId: streamId, streamId }));
        return next();
      } };
    };
    const seed = async (id, { tenant = actor.tenantId, entity = false, visibility = "private", type = "channel" } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenant, `${id}-parent`, type, visibility, type === "channel" ? id : null, entity ? "case" : null, entity ? id : null]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ($1, $2, $3, 1, 'author', $2, '{"format":"plain","text":"root"}')`, [tenant, `${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
        VALUES ($1, $2, 'thread', $3, $4, $5)`, [tenant, id, visibility, `${id}-parent`, `${id}-root`]);
    };
    const member = (id, state = "active", identity = actor) => sql(`INSERT INTO ${prefix}.chat_conversation_members
      (tenant_id, conversation_id, user_id, role, state) VALUES ($1, $2, $3, 'member', $4)
      ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET state = EXCLUDED.state`,
    [identity.tenantId, id, identity.userId, state]);
    const follow = (id, isFollowing) => sql(`INSERT INTO ${prefix}.chat_thread_follows
      (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
      VALUES ('tenant-a', $1, 'reader', $2, 'manual', 1)
      ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE
      SET is_following = EXCLUDED.is_following, follow_revision = chat_thread_follows.follow_revision + 1`, [id, isFollowing]);
    const access = (streamId, identity = actor) => authorizeChatWebSocketStream({
      database, schema: harness.schema, permissions, actor: identity, streamId,
    });
    let sequence = 0;
    const event = async (streamId, tenantId = actor.tenantId) => {
      const eventId = `thread-event-${++sequence}`;
      const occurredAt = new Date().toISOString();
      const payload = { ordinal: sequence };
      const result = await sql(`INSERT INTO ${prefix}.chat_outbox_events
        (event_id, protocol_version, tenant_id, stream_id, type, occurred_at, payload, published_at, expires_at)
        VALUES ($1, $2, $3, $4, 'message.created', $5, $6, clock_timestamp(), clock_timestamp() + interval '1 day')
        RETURNING replay_position::integer AS position`, [eventId, CHAT_PROTOCOL_VERSION, tenantId, streamId, occurredAt, payload]);
      return { replayPosition: result.rows[0].position,
        event: { eventId, protocolVersion: CHAT_PROTOCOL_VERSION, tenantId, streamId, type: "message.created", occurredAt, payload } };
    };
    const publish = async (entry) => { for (const listener of listeners) await listener(entry.event); };
    const accepted = (response) => assert.equal(response.type, "chat.subscription.accepted");
    const rejected = (response) => {
      assert.equal(response.type, "chat.subscription.rejected");
      assert.equal(response.code, "access_denied");
      assert.doesNotMatch(JSON.stringify(response), /private .* failure/);
    };

    await t.test("unfollowed eligible readers subscribe; follow state neither grants nor revokes access", async () => {
      for (const [id, type, visibility] of [["public", "channel", "public"], ["private", "channel", "private"],
        ["direct", "direct", "private"], ["group", "group_direct", "private"]]) {
        await seed(id, { type, visibility });
        if (visibility === "private") await member(`${id}-parent`);
        const connection = await connect();
        accepted(await connection.subscribe(id));
        assert.equal(connection.state.session.subscriptions.has(`${id}-parent`), false);
        for (const following of [true, false]) {
          await follow(id, following);
          assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId, streamId: `${id}-parent` }), 0);
          accepted(await connection.subscribe(id));
        }
        if (visibility === "private") {
          await member(id);
          for (const following of [true, false]) {
            await member(`${id}-parent`);
            await follow(id, following);
            await member(`${id}-parent`, "removed");
            assert.deepEqual(await access(id), { authorized: false });
          }
          rejected(await connection.subscribe(id));
        }
      }
    });

    await t.test("parent denial excludes fresh and reconnect subscriptions, replay and buffered replay with retained child membership", async () => {
      for (const reason of ["membership", "entity"]) {
        const id = `replay-${reason}`;
        await seed(id, { entity: reason === "entity" });
        await member(`${id}-parent`);
        await member(id);
        await follow(id, true);
        const cursor = await event("user:reader");
        const childEvent = await event(id);
        const replayOptions = { database, schema: harness.schema, actor, permissions,
          protocolVersion: CHAT_PROTOCOL_VERSION, cursor: { eventId: cursor.event.eventId }, limit: 100 };
        assert.equal((await readChatWebSocketReplay(replayOptions)).events.some((entry) => entry.event.eventId === childEvent.event.eventId), true);
        if (reason === "membership") await member(`${id}-parent`, "removed");
        else denied.add(id);
        const replay = await readChatWebSocketReplay(replayOptions);
        assert.equal(replay.state, "accepted");
        assert.equal(replay.streamIds.includes(id), false);
        assert.equal(replay.events.some((entry) => entry.event.streamId === id), false);
        assert.deepEqual(await resolveBufferedReplayEvents({ ...replayOptions,
          cursorPosition: cursor.replayPosition, events: [childEvent.event] }), []);
        for (const resume of [undefined, cursor]) {
          const connection = await connect(actor, resume);
          rejected(await connection.subscribe(id));
          assert.equal(connection.state.session.subscriptions.has(id), false);
          assert.equal(connection.received.some((message) => message.eventId === childEvent.event.eventId), false);
        }
      }
      assert.ok(entityChecks.some(({ action, entity }) => action === "conversation.subscribe" && entity.id === "replay-entity"));
    });

    await t.test("parent-scoped revocation reaches child-only sessions, drops queued delivery and isolates users/tenants", async () => {
      const id = "scoped";
      const otherUser = { ...actor, userId: "other" };
      const otherTenant = { ...actor, tenantId: "tenant-b" };
      await seed(id);
      await seed(id, { tenant: otherTenant.tenantId });
      await seed("different-parent", { tenant: otherTenant.tenantId });
      await sql(`UPDATE ${prefix}.chat_conversations
        SET parent_conversation_id = 'different-parent-parent', root_message_id = 'different-parent-root'
        WHERE tenant_id = 'tenant-b' AND id = $1`, [id]);
      await member("different-parent-parent", "active", otherTenant);
      const connections = [];
      for (const identity of [actor, otherUser, otherTenant]) {
        await member(`${id}-parent`, "active", identity);
        await member(id, "active", identity);
        const connection = await connect(identity);
        accepted(await connection.subscribe(id));
        accepted(await connection.subscribe(`user:${identity.userId}`));
        connections.push(connection);
      }
      const [target, userControl, tenantControl] = connections;
      await seed("unrelated");
      await member("unrelated-parent");
      accepted(await target.subscribe("unrelated"));
      await member("unrelated-parent", "removed");
      // Hold one actual socket send callback so the next event remains queued.
      const serverSocket = target.state.socket;
      const originalSend = serverSocket.send;
      let releaseSend;
      serverSocket.send = function (data, callback) {
        if (JSON.parse(data).eventId && releaseSend === undefined) {
          return originalSend.call(this, data, (error) => { releaseSend = () => callback(error); });
        }
        return originalSend.call(this, data, callback);
      };
      const first = await event(id);
      await publish(first);
      assert.equal((await target.next()).eventId, first.event.eventId);
      // Barrier ensures the send callback ran before queuing more deliveries.
      for (let i = 0; !releaseSend && i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(typeof releaseSend, "function");
      const queued = await event(id);
      await publish(queued);
      await member(`${id}-parent`, "removed");
      assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId,
        userId: actor.userId, streamId: "user:reader" }), 0);
      assert.equal(target.state.session.subscriptions.has(id), true);
      const countBefore = runtime.webSocketSubscriptionCount;
      assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId,
        userId: actor.userId, streamId: `${id}-parent` }), 1);
      assert.equal(runtime.webSocketSubscriptionCount, countBefore - 1);
      assert.deepEqual(await target.next(), { type: "chat.subscription.revoked", code: "access_revoked", streamId: id });
      assert.equal(target.state.session.subscriptions.has(id), false);
      assert.equal(target.state.session.subscriptions.has("user:reader"), true);
      assert.equal(target.state.session.subscriptions.has("unrelated"), true, "another parent's notification is out of scope");
      assert.equal(userControl.state.session.subscriptions.has(id), true);
      assert.equal(tenantControl.state.session.subscriptions.has(id), true);
      serverSocket.send = originalSend;
      releaseSend();
      const later = await event(id);
      await publish(later);
      const barrier = await event("user:reader");
      await publish(barrier);
      assert.equal((await target.next()).eventId, barrier.event.eventId, "queued and subsequent child deliveries are absent");
      assert.equal(target.received.some((message) => [queued.event.eventId, later.event.eventId].includes(message.eventId)), false);
      assert.equal(tenantControl.received.some((message) => message.eventId), false);
      assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId,
        userId: actor.userId, streamId: `${id}-parent` }), 0);
    });

    await t.test("host denial and failed relationship lookup revoke safely; archives and actor-private streams remain restricted", async () => {
      await seed("host", { entity: true });
      await member("host-parent");
      await member("host");
      const connection = await connect();
      accepted(await connection.subscribe("host"));
      accepted(await connection.subscribe("user:reader"));
      denied.add("host");
      assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId, streamId: "host-parent" }), 1);
      assert.equal((await connection.next()).type, "chat.subscription.revoked");
      denied.delete("host");
      accepted(await connection.subscribe("host"));
      malformedHostResult = true;
      assert.deepEqual(await access("host"), { authorized: false });
      malformedHostResult = false;
      hostFailure = true;
      assert.deepEqual(await access("host"), { authorized: false });
      assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId, streamId: "host-parent" }), 1);
      assert.equal((await connection.next()).type, "chat.subscription.revoked");
      hostFailure = false;
      accepted(await connection.subscribe("host"));
      relationshipFailure = true;
      assert.equal(await runtime.revalidateWebSocketSubscriptions({ tenantId: actor.tenantId,
        userId: actor.userId, streamId: "host-parent" }) >= 1, true);
      assert.equal((await connection.next()).type, "chat.subscription.revoked");
      assert.deepEqual(connection.state.session.subscriptions.streamIds, ["user:reader"]);
      relationshipFailure = false;
      for (const id of ["archived-child", "archived-parent"]) {
        await seed(id, { visibility: "public" });
        await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = clock_timestamp(), archived_by_user_id = 'admin'
          WHERE tenant_id = 'tenant-a' AND id = $1`, [id === "archived-child" ? id : `${id}-parent`]);
        assert.deepEqual(await access(id), { authorized: false });
      }
      assert.deepEqual(await access("user:reader"), { authorized: true, kind: "user" });
      assert.deepEqual(await access("user:other"), { authorized: false });
      assert.deepEqual(await access("scoped", { ...actor, tenantId: "missing-tenant" }), { authorized: false });
    });
  } finally {
    await runtime?.close();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await harness?.teardown();
    await backend.teardown();
  }
});
