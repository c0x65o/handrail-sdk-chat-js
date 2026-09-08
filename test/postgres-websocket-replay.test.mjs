import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";
import { WebSocket } from "ws";
import {
  readChatWebSocketReplay,
  resolveBufferedReplayEvents,
} from "../dist/server/websocket-replay.js";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const createFanout = () => {
  const listeners = new Set();
  return {
    get subscriberCount() {
      return listeners.size;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async publish(event) {
      await Promise.all([...listeners].map((listener) => listener(event)));
    },
  };
};

const connect = async (url, resumeFrom, protocolVersion = CHAT_PROTOCOL_VERSION) => {
  const socket = new WebSocket(url, {
    headers: { authorization: "Bearer actor-a" },
  });
  const messages = [];
  const received = [];
  const waiters = [];
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    received.push(message);
    const waiter = waiters.shift();
    if (waiter === undefined) messages.push(message);
    else waiter.resolve(message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      clientPackageVersion: "0.1.3",
      protocolVersion,
      ...(resumeFrom === undefined
        ? {}
        : { resumeFrom: { eventId: resumeFrom } }),
    }),
  );
  const nextMessage = (timeoutMs = 2_000) => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
      waiters.push({
        resolve(message) {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  };
  return { socket, closed, nextMessage, received };
};

test("WebSocket cursor replay is ordered, bounded, authorized, and tenant-safe on PostgreSQL", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "socket_replay" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const outbox = `${schema}.chat_outbox_events`;
  const fanout = createFanout();
  const runtimes = [];
  let eventSequence = 0;
  let replayReadCount = 0;
  let boundaryHook;

  const insertEvent = async ({
    tenantId = "tenant-a",
    streamId = "allowed",
    type = "message.created",
    protocolVersion = CHAT_PROTOCOL_VERSION,
    expired = false,
    payload,
  } = {}) => {
    eventSequence += 1;
    payload ??= { ordinal: eventSequence };
    const eventId = `replay-event-${eventSequence}`;
    const result = await harness.pool.query(
      `INSERT INTO ${outbox}
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, published_at, expires_at)
       VALUES (
         $1, $2, $3, $4, $5,
         CASE WHEN $6 THEN clock_timestamp() - interval '2 days'
              ELSE clock_timestamp() END,
         $7::jsonb,
         clock_timestamp(),
         CASE WHEN $6 THEN clock_timestamp() - interval '1 day'
              ELSE clock_timestamp() + interval '1 day' END
       )
       RETURNING replay_position::integer AS replay_position, occurred_at`,
      [
        eventId,
        protocolVersion,
        tenantId,
        streamId,
        type,
        expired,
        JSON.stringify(payload),
      ],
    );
    return {
      replayPosition: result.rows[0].replay_position,
      event: {
        eventId,
        protocolVersion,
        tenantId,
        streamId,
        type,
        occurredAt: new Date(result.rows[0].occurred_at).toISOString(),
        payload,
      },
    };
  };

  const database = {
    async query(sql, values) {
      if (sql.includes("ORDER BY replay_position") && sql.includes("LIMIT $5")) {
        replayReadCount += 1;
        if (boundaryHook !== undefined) {
          const hook = boundaryHook;
          boundaryHook = undefined;
          await hook();
        }
      }
      return harness.pool.query(sql, values);
    },
    connect() {
      return harness.pool.connect();
    },
  };

  const createRuntime = async (maxReplayEvents = 50, maxPendingEvents = 20) => {
    const sessions = [];
    const runtime = createChatServer({
      database: { pool: database, schema: harness.schema },
      auth: {
        async resolveActor(request) {
          if (request.headers.authorization !== "Bearer actor-a") {
            throw new Error("private authentication detail");
          }
          return {
            tenantId: "tenant-a",
            userId: "user-a",
            roles: ["employee"],
          };
        },
      },
      directory: {
        async getUser() {
          return null;
        },
        async searchUsers() {
          return [];
        },
      },
      permissions: {
        async getCapabilities() {
          return ["messages.read"];
        },
        async authorizeEntity({ entity }) {
          return entity.id !== "denied";
        },
      },
      realtime: fanout,
      outbox: { pollIntervalMs: 60_000 },
      webSocket: {
        handshakeTimeoutMs: 2_000,
        maxPendingEvents,
        maxReplayEvents,
        onSession(_socket, session) {
          sessions.push(session);
        },
      },
    });
    const server = createServer(runtime.router);
    runtime.attachWebSocket(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    const fixture = {
      runtime,
      sessions,
      server,
      url: `ws://127.0.0.1:${address.port}${DEFAULT_CHAT_WEBSOCKET_PATH}`,
      async close() {
        await runtime.close();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
    runtimes.push(fixture);
    return fixture;
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id)
       VALUES
         ('tenant-a', 'allowed', 'channel', 'private', 'Allowed', NULL, NULL),
         ('tenant-a', 'internal-only', 'channel', 'private', 'Internal only', NULL, NULL),
         ('tenant-a', 'revoked', 'channel', 'private', 'Revoked', NULL, NULL),
         ('tenant-a', 'entity-denied', 'channel', 'public', 'Denied', 'case', 'denied'),
         ('tenant-b', 'tenant-b-stream', 'channel', 'public', 'Tenant B', NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'allowed', 'user-a', 'member', 'active'),
         ('tenant-a', 'allowed', 'user-b', 'member', 'active'),
         ('tenant-a', 'internal-only', 'user-a', 'member', 'active'),
         ('tenant-a', 'internal-only', 'user-b', 'member', 'active'),
         ('tenant-a', 'revoked', 'user-a', 'member', 'active')`,
    );

    const cursor = await insertEvent();
    const second = await insertEvent();
    const reminderPayload = {
      message: { id: "reminded-message", author: { userId: "user-b" }, sequence: 1 },
      reminder: { userId: "user-b", revision: 2, dueAt: new Date().toISOString() },
    };
    const reminder = await insertEvent({
      type: "message.reminder",
      payload: reminderPayload,
    });
    await insertEvent({
      streamId: "internal-only",
      type: "message.reminder",
      payload: reminderPayload,
    });
    await insertEvent({ type: "typing.signal" });
    const userEvent = await insertEvent({ streamId: "user:user-a" });
    await insertEvent({ type: "presence.signal", streamId: "user:user-a" });
    await insertEvent({ streamId: "user:user-other" });
    await insertEvent({ streamId: "revoked" });
    await insertEvent({ streamId: "entity-denied" });
    const finalReplay = await insertEvent();
    const replayOptions = {
      database: harness.pool,
      schema: harness.schema,
      actor: { tenantId: "tenant-a", userId: "user-a", roles: ["employee"] },
      permissions: {
        async getCapabilities() { return ["messages.read"]; },
        async authorizeEntity({ entity }) { return entity.id !== "denied"; },
      },
      protocolVersion: CHAT_PROTOCOL_VERSION,
    };
    await t.test("buffered reminders are dropped and stored types remain authoritative", async () => {
      const bufferedOptions = {
        ...replayOptions,
        cursorPosition: cursor.replayPosition,
      };
      assert.deepEqual(await resolveBufferedReplayEvents({
        ...bufferedOptions,
        events: [reminder.event],
      }), []);
      const resolved = await resolveBufferedReplayEvents({
        ...bufferedOptions,
        events: [
          finalReplay.event,
          reminder.event,
          { ...reminder.event, type: "message.created" },
          second.event,
        ],
      });
      assert.deepEqual(resolved, [second, finalReplay]);
    });
    await harness.pool.query(
      `UPDATE ${members}
       SET state = 'removed', updated_at = clock_timestamp()
       WHERE tenant_id = 'tenant-a'
         AND conversation_id = 'revoked'
         AND user_id = 'user-a'`,
    );

    await t.test("internal-only streams skip authorization and reminders do not consume the page", async () => {
      const authorizationStreams = [];
      const result = await readChatWebSocketReplay({
        ...replayOptions,
        database: {
          async query(sql, values) {
            if (sql.includes("current_member.state AS member_state")) {
              authorizationStreams.push(values[1]);
            }
            return harness.pool.query(sql, values);
          },
        },
        cursor: { eventId: cursor.event.eventId },
        limit: 3,
      });
      assert.equal(authorizationStreams.includes("internal-only"), false);
      assert.equal(result.state, "accepted");
      assert.deepEqual(result.streamIds, ["allowed", "user:user-a"]);
      assert.deepEqual(result.events, [second, userEvent, finalReplay]);
    });

    const main = await createRuntime();
    await t.test("an internal reminder cursor requires a snapshot and closes the socket", async () => {
      const internal = await connect(main.url, reminder.event.eventId);
      try {
        const message = await internal.nextMessage();
        assert.equal(message.type, "chat.session.snapshot_required");
        assert.equal(message.reason, "replay_unavailable");
        assert.deepEqual(await internal.closed, CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired);
      } finally {
        internal.socket.close();
        await internal.closed;
      }
    });
    let boundary;
    boundaryHook = async () => {
      boundary = await insertEvent();
      await fanout.publish(boundary.event);
    };
    const resumed = await connect(main.url, cursor.event.eventId);
    const accepted = await resumed.nextMessage();
    assert.deepEqual(accepted.resumeFrom, { eventId: cursor.event.eventId });
    assert.equal(accepted.type, "chat.session.accepted");

    const replayed = await Promise.all([
      resumed.nextMessage(),
      resumed.nextMessage(),
      resumed.nextMessage(),
      resumed.nextMessage(),
    ]);
    assert.deepEqual(
      replayed.map((event) => event.eventId),
      [
        second.event.eventId,
        userEvent.event.eventId,
        finalReplay.event.eventId,
        boundary.event.eventId,
      ],
    );
    assert.equal(new Set(replayed.map((event) => event.eventId)).size, 4);
    assert.deepEqual([...main.sessions[0].subscriptions.streamIds].sort(), [
      "allowed",
      "user:user-a",
    ]);

    const live = await insertEvent();
    await fanout.publish(live.event);
    assert.equal((await resumed.nextMessage()).eventId, live.event.eventId);
    resumed.socket.close();
    await resumed.closed;

    const unknown = await connect(main.url, "missing-cursor");
    const unknownMessage = await unknown.nextMessage();
    assert.equal(unknownMessage.type, "chat.session.snapshot_required");
    assert.equal(unknownMessage.reason, "replay_unavailable");
    assert.deepEqual(await unknown.closed, CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired);

    const crossTenant = await insertEvent({
      tenantId: "tenant-b",
      streamId: "tenant-b-stream",
    });
    const cross = await connect(main.url, crossTenant.event.eventId);
    const crossMessage = await cross.nextMessage();
    assert.deepEqual(
      { type: crossMessage.type, reason: crossMessage.reason },
      { type: unknownMessage.type, reason: unknownMessage.reason },
    );
    assert.deepEqual(await cross.closed, CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired);

    const expiredCursor = await insertEvent({ expired: true });
    const expired = await connect(main.url, expiredCursor.event.eventId);
    assert.equal((await expired.nextMessage()).reason, "replay_expired");
    await expired.closed;

    const overflowCursor = await insertEvent();
    await insertEvent();
    await insertEvent();
    await insertEvent();
    const bounded = await createRuntime(2);
    const overflow = await connect(bounded.url, overflowCursor.event.eventId);
    assert.equal((await overflow.nextMessage()).reason, "replay_overflow");
    await overflow.closed;

    await t.test("replay boundary subscription overflow closes before session acceptance", async () => {
      const admissionCursor = await insertEvent();
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         SELECT 'tenant-a', 'admission-' || n, 'channel', 'public', 'Admission'
         FROM generate_series(1, 1024) AS n`,
      );
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, published_at, expires_at)
         SELECT 'admission-event-' || n, $1, 'tenant-a', 'admission-' || n,
                'message.created', clock_timestamp(), '{}'::jsonb,
                clock_timestamp(), clock_timestamp() + interval '1 day'
         FROM generate_series(1, 1000) AS n`,
        [CHAT_PROTOCOL_VERSION],
      );
      const admission = await createRuntime(1_100, 24);
      let boundaryPublished = 0;
      let lastBoundary;
      // The candidate read sees exactly 1,000 streams. Add the private user
      // slot and 24 persisted boundary streams to exceed subscription capacity,
      // without tripping the separate candidate, replay-event or pending limits.
      boundaryHook = async () => {
        for (let index = 1001; index <= 1024; index += 1) {
          lastBoundary = await insertEvent({ streamId: `admission-${index}` });
          await fanout.publish(lastBoundary.event);
          boundaryPublished += 1;
        }
      };
      const connection = await connect(admission.url, admissionCursor.event.eventId);
      let timer;
      try {
        const closed = await Promise.race([
          connection.closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("admission close timeout")), 5_000);
          }),
        ]);
        assert.equal(boundaryPublished, 24);
        assert.deepEqual(closed, CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit);
        assert.deepEqual(admission.sessions, []);
        assert.equal(admission.runtime.webSocketSessionCount, 0);
        assert.equal(admission.runtime.webSocketSubscriptionCount, 0);
        assert.equal(fanout.subscriberCount, 0);
        await fanout.publish(lastBoundary.event);
        assert.deepEqual(connection.received, []);
        t.diagnostic(`PostgreSQL ${backend.kind}: subscription admission overflow after 1,000 candidates + private stream + 24 boundary streams`);
      } finally {
        clearTimeout(timer);
        connection.socket.terminate();
        await admission.close();
      }
    });

    const replayReadsBeforeProtocolRejection = replayReadCount;
    const unsupported = await connect(
      main.url,
      cursor.event.eventId,
      CHAT_PROTOCOL_VERSION + 1,
    );
    const refresh = await unsupported.nextMessage();
    assert.equal(refresh.type, "chat.session.refresh_required");
    assert.equal(refresh.reason, "unsupported_protocol");
    assert.deepEqual(
      await unsupported.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.unsupportedProtocol,
    );
    assert.equal(replayReadCount, replayReadsBeforeProtocolRejection);
  } finally {
    await Promise.allSettled(runtimes.map((fixture) => fixture.close()));
    await harness.teardown();
    await backend.teardown();
  }
});

test("WebSocket replay bounds candidate authorization on PostgreSQL", async (t) => {
  // Independent regression value for the internal production budget.
  const candidateBudget = 1_000;
  const backend = await createPostgresTestBackend();
  try {
    for (const candidateCount of [candidateBudget - 1, candidateBudget, candidateBudget + 1, candidateBudget + 25]) {
      await t.test(`${candidateCount} candidate streams`, async (t) => {
        const harness = await backend.createHarness({ schemaPrefix: "replay_candidates" });
        const schema = quoteIdentifier(harness.schema);
        const outbox = `${schema}.chat_outbox_events`;
        const streamId = (ordinal) => `candidate-${String(ordinal).padStart(4, "0")}`;
        const permittedStreams = [streamId(1), streamId(candidateCount)];
        const authorizationQueries = [];
        const permissionCalls = [];
        const candidateQueries = [];
        let eventQueries = 0;
        try {
          await createPostgresMigrationRunner({
            database: harness.pool,
            schema: harness.schema,
            migrations: handrailChatPostgresMigrations,
          }).apply();
          await harness.pool.query(
            `INSERT INTO ${schema}.chat_conversations
               (tenant_id, id, type, visibility, name, entity_type, entity_id)
             SELECT 'tenant-a', 'candidate-' || lpad(n::text, 4, '0'),
                    'channel', 'public', 'Candidate', 'case',
                    'candidate-' || lpad(n::text, 4, '0')
             FROM generate_series(1, $1::integer) AS n`,
            [candidateCount],
          );
          const insertEvent = async (eventId, stream, tenantId = "tenant-a") => {
            await harness.pool.query(
              `INSERT INTO ${outbox}
                 (event_id, protocol_version, tenant_id, stream_id, type,
                  occurred_at, payload, expires_at)
               VALUES ($1, $2, $3, $4, 'message.created',
                       clock_timestamp(), '{}'::jsonb, clock_timestamp() + interval '1 day')`,
              [eventId, CHAT_PROTOCOL_VERSION, tenantId, stream],
            );
          };
          // These distinct streams must not count against the post-cursor budget.
          await insertEvent("before-cursor", "before-cursor-only");
          await insertEvent("cursor", "cursor-only");
          await harness.pool.query(
            `INSERT INTO ${outbox}
               (event_id, protocol_version, tenant_id, stream_id, type,
                occurred_at, payload, expires_at)
             SELECT 'event-' || n, $2, 'tenant-a',
                    'candidate-' || lpad(n::text, 4, '0'), 'message.created',
                    clock_timestamp(), '{}'::jsonb, clock_timestamp() + interval '1 day'
             FROM generate_series(1, $1::integer) AS n
             ORDER BY n DESC`,
            [candidateCount, CHAT_PROTOCOL_VERSION],
          );
          // Event ordering differs from stream ordering, and DISTINCT must count
          // a stream only once even when it has multiple replay events.
          await insertEvent("last-event", streamId(candidateCount));
          await insertEvent("other-tenant-event", "other-tenant-only", "tenant-b");
          await insertEvent("other-tenant-shared-stream", streamId(1), "tenant-b");

          const actor = { tenantId: "tenant-a", userId: "user-a", roles: ["employee"] };
          const result = await readChatWebSocketReplay({
            database: {
              async query(sql, values) {
                if (sql.includes("current_member.state AS member_state")) {
                  authorizationQueries.push(values);
                }
                if (sql.includes("ORDER BY replay_position") && sql.includes("LIMIT $5")) {
                  eventQueries += 1;
                }
                const result = await harness.pool.query(sql, values);
                if (sql.includes("SELECT DISTINCT stream_id")) {
                  candidateQueries.push({ sql, values, rows: result.rows });
                }
                return result;
              },
            },
            schema: harness.schema,
            actor,
            permissions: {
              async getCapabilities() { return ["messages.read"]; },
              async authorizeEntity(request) {
                permissionCalls.push(request);
                return permittedStreams.includes(request.entity.id);
              },
            },
            protocolVersion: CHAT_PROTOCOL_VERSION,
            cursor: { eventId: "cursor" },
            limit: 3,
          });
          t.diagnostic(`PostgreSQL ${backend.kind}: candidates=${candidateCount}, returned=${candidateQueries[0]?.rows.length}, conversation queries=${authorizationQueries.length}, permission calls=${permissionCalls.length}`);
          if (candidateCount > candidateBudget) {
            assert.deepEqual(result, { state: "snapshot_required", reason: "replay_overflow" });
            assert.deepEqual(authorizationQueries, []);
            assert.deepEqual(permissionCalls, []);
            assert.equal(eventQueries, 0);
          } else {
            assert.equal(result.state, "accepted");
            assert.deepEqual(result.streamIds, permittedStreams);
            assert.deepEqual(result.events.map(({ event }) => event.eventId), [
              `event-${candidateCount}`, "event-1", "last-event",
            ]);
            assert.ok(result.events.every(({ event }) => event.tenantId === actor.tenantId));
            const positions = result.events.map(({ replayPosition }) => replayPosition);
            assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
            assert.equal(eventQueries, 1);
            const expectedStreams = Array.from({ length: candidateCount }, (_, i) => streamId(i + 1));
            assert.deepEqual(authorizationQueries, expectedStreams.map((stream) => [
              actor.tenantId, stream, actor.userId,
            ]));
            assert.deepEqual(permissionCalls, expectedStreams.map((stream) => ({
              actor, entity: { type: "case", id: stream }, action: "conversation.subscribe",
            })));
          }
          assert.equal(candidateQueries.length, 1);
          const candidateQuery = candidateQueries[0];
          assert.match(candidateQuery.sql, /LIMIT \$4\s*$/);
          assert.equal(candidateQuery.values[3], candidateBudget + 1);
          assert.equal(candidateQuery.rows.length, Math.min(candidateCount, candidateBudget + 1));
          assert.equal(candidateQuery.rows.some(({ stream_id }) => stream_id === "other-tenant-only"), false);
        } finally {
          await harness.teardown();
        }
      });
    }
  } finally {
    await backend.teardown();
  }
});
