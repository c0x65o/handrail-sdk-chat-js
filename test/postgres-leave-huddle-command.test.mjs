import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  HUDDLE_LEAVE_REASONS,
  LEAVE_HUDDLE_ENTITY_POLICY_ACTION,
  LEAVE_HUDDLE_OUTBOX_EVENT_TYPE,
  ChatAuthorizationError,
  LeaveHuddleCommandError,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  leaveHuddle,
  leaveJoinedHuddlesOnDisconnect,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";
import { WebSocket } from "ws";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const request = (huddleSessionId, key) => ({
  operation: "leave_huddle",
  huddleSessionId,
  idempotencyKey: key,
});

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
};

test("trusted leave-huddle is tenant-safe, atomic, replayable, and used by disconnect cleanup", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_leave_huddle" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    sessions: `${schema}.chat_huddle_sessions`,
    participants: `${schema}.chat_huddle_participants`,
    idempotency: `${schema}.chat_idempotency_keys`,
    outbox: `${schema}.chat_outbox_events`,
  };
  const entityCalls = [];
  const permissions = {
    async getCapabilities() {
      return [];
    },
    async authorizeEntity(input) {
      entityCalls.push(input);
      return true;
    },
  };
  let eventSequence = 0;
  const command = (input, overrides = {}) =>
    leaveHuddle({
      database: harness.pool,
      schema: harness.schema,
      permissions,
      actor,
      input,
      createId: () => `leave-event-${++eventSequence}`,
      ...overrides,
    });

  const seedActiveSession = async ({
    tenantId = "tenant-a",
    conversationId,
    sessionId,
    includeActor = true,
    actorJoinedAt = null,
    screenShareOwner = null,
    entity = null,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4)`,
      [tenantId, conversationId, entity?.type ?? null, entity?.id ?? null],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ($1, $2, 'starter-user', 'member', 'active')`,
      [tenantId, conversationId],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ($1, $2, $3, 'member', 'active')`,
      [tenantId, conversationId, actor.userId],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.sessions} (
         tenant_id, id, conversation_id, provider_room_reference,
         status, initiated_by_user_id
       ) VALUES ($1, $2, $3, $4, 'starting', 'starter-user')`,
      [tenantId, sessionId, conversationId, `opaque-room-${tenantId}-${sessionId}`],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.participants}
         (tenant_id, huddle_session_id, user_id)
       VALUES ($1, $2, 'starter-user')`,
      [tenantId, sessionId],
    );
    if (includeActor) {
      await harness.pool.query(
        `INSERT INTO ${tables.participants}
           (tenant_id, huddle_session_id, user_id, joined_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, clock_timestamp()))`,
        [tenantId, sessionId, actor.userId, actorJoinedAt],
      );
    }
    await harness.pool.query(
      `UPDATE ${tables.sessions}
          SET status = 'active', activated_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, sessionId],
    );
    if (screenShareOwner !== null) {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET active_screen_share_owner_user_id = $1,
                updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND id = $3`,
        [screenShareOwner, tenantId, sessionId],
      );
    }
  };

  const counts = async (sessionId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND type = $2
             AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE tenant_id = 'tenant-a' AND operation_name = 'huddle.leave'
             AND state = 'completed'
             AND response_body -> 'state' ->> 'huddleSessionId' = $1) AS idempotency`,
      [sessionId, LEAVE_HUDDLE_OUTBOX_EVENT_TYPE],
    );
    return result.rows[0];
  };

  try {
    const migrationResult = await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    assert.deepEqual(
      {
        id: migrationResult.applied.at(-1).id,
        order: migrationResult.applied.at(-1).order,
      },
      { id: "0038-chat-huddle-rejoin", order: 38 },
    );

    await seedActiveSession({
      conversationId: "conversation-explicit",
      sessionId: "session-explicit",
      entity: { type: "invoice", id: "invoice-a" },
    });
    await seedActiveSession({
      conversationId: "conversation-nonparticipant",
      sessionId: "session-nonparticipant",
      includeActor: false,
    });
    await seedActiveSession({
      tenantId: "tenant-b",
      conversationId: "conversation-cross-tenant",
      sessionId: "session-cross-tenant",
    });
    await seedActiveSession({
      conversationId: "conversation-screen-share",
      sessionId: "session-screen-share",
      screenShareOwner: actor.userId,
    });
    await seedActiveSession({
      conversationId: "conversation-rollback",
      sessionId: "session-rollback",
      screenShareOwner: actor.userId,
    });
    await seedActiveSession({
      conversationId: "conversation-disconnect-helper",
      sessionId: "session-disconnect-helper",
    });

    await t.test("persists explicit reason/time, keeps the room active, and emits exactly one event", async () => {
      const input = request("session-explicit", "leave-explicit");
      const applied = await command(input);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.state.status, "active");
      assert.equal(applied.state.participants.find(({ userId }) => userId === actor.userId).status, "left");
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "invoice", id: "invoice-a" },
        action: LEAVE_HUDDLE_ENTITY_POLICY_ACTION,
      });

      const durable = await harness.pool.query(
        `SELECT participant.left_at, participant.leave_reason,
                session.status, session.ended_at, session.ended_by_user_id,
                session.active_screen_share_owner_user_id
           FROM ${tables.participants} AS participant
           INNER JOIN ${tables.sessions} AS session
             ON session.tenant_id = participant.tenant_id
            AND session.id = participant.huddle_session_id
          WHERE participant.tenant_id = 'tenant-a'
            AND participant.huddle_session_id = 'session-explicit'
            AND participant.user_id = $1`,
        [actor.userId],
      );
      assert.ok(durable.rows[0].left_at instanceof Date);
      assert.deepEqual(
        {
          reason: durable.rows[0].leave_reason,
          status: durable.rows[0].status,
          endedAt: durable.rows[0].ended_at,
          endedBy: durable.rows[0].ended_by_user_id,
          owner: durable.rows[0].active_screen_share_owner_user_id,
        },
        {
          reason: HUDDLE_LEAVE_REASONS.explicit,
          status: "active",
          endedAt: null,
          endedBy: null,
          owner: null,
        },
      );
      assert.deepEqual(await counts("session-explicit"), { outbox: 1, idempotency: 1 });

      const event = await harness.pool.query(
        `SELECT payload FROM ${tables.outbox}
          WHERE tenant_id = 'tenant-a' AND type = $1
            AND payload -> 'state' ->> 'huddleSessionId' = 'session-explicit'`,
        [LEAVE_HUDDLE_OUTBOX_EVENT_TYPE],
      );
      assert.equal(event.rows[0].payload.reason, HUDDLE_LEAVE_REASONS.explicit);
      assert.equal(event.rows[0].payload.participant.userId, actor.userId);
      assert.equal(event.rows[0].payload.participant.status, "left");
      assert.equal(JSON.stringify(event.rows[0].payload).includes("opaque-room"), false);

      const replay = await command(input);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.state, applied.state);
      assert.deepEqual(await counts("session-explicit"), { outbox: 1, idempotency: 1 });

      await assert.rejects(
        command(request("session-explicit", "leave-explicit-second-key")),
        (error) =>
          error instanceof LeaveHuddleCommandError &&
          error.code === "participant_already_left" &&
          error.statusCode === 409,
      );
      assert.deepEqual(await counts("session-explicit"), { outbox: 1, idempotency: 1 });
    });

    await t.test("rejects nonparticipants and cross-tenant sessions without foreign state", async () => {
      for (const [sessionId, key] of [
        ["session-nonparticipant", "leave-nonparticipant"],
        ["session-cross-tenant", "leave-cross-tenant"],
        ["missing-session", "leave-missing"],
      ]) {
        await assert.rejects(
          command(request(sessionId, key)),
          (error) =>
            error instanceof ChatAuthorizationError &&
            error.code === "CHAT_AUTHORIZATION_FAILED" &&
            error.message === "Chat authorization failed",
        );
      }
    });

    await t.test("clears actor-owned screen share before recording leave", async () => {
      const result = await command(request("session-screen-share", "leave-screen-share"));
      assert.equal(result.state.screenShareOwnerUserId, null);
      const stored = await harness.pool.query(
        `SELECT session.active_screen_share_owner_user_id, session.status,
                participant.left_at, participant.leave_reason
           FROM ${tables.sessions} AS session
           INNER JOIN ${tables.participants} AS participant
             ON participant.tenant_id = session.tenant_id
            AND participant.huddle_session_id = session.id
            AND participant.user_id = $1
          WHERE session.tenant_id = 'tenant-a' AND session.id = 'session-screen-share'`,
        [actor.userId],
      );
      assert.equal(stored.rows[0].active_screen_share_owner_user_id, null);
      assert.equal(stored.rows[0].status, "active");
      assert.ok(stored.rows[0].left_at instanceof Date);
      assert.equal(stored.rows[0].leave_reason, HUDDLE_LEAVE_REASONS.explicit);
    });

    await t.test("preserves same-millisecond departure precision and canonical replay", async () => {
      const sessionId = "session-precision";
      const joinedAt = "2099-01-01T00:00:00.123456Z";
      const departureClock = "2099-01-01T00:00:00.123789Z";
      await seedActiveSession({
        conversationId: "conversation-precision",
        sessionId,
        actorJoinedAt: joinedAt,
        screenShareOwner: actor.userId,
      });
      let clockReads = 0;
      const database = {
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              // Only replace the clock boundary; every SQL operation runs on PostgreSQL.
              if (/^SELECT clock_timestamp\(\)(?:::text)? AS left_at$/.test(sql)) {
                clockReads += 1;
                return connection.query(
                  sql.replace("clock_timestamp()", "$1::timestamptz"),
                  [departureClock],
                );
              }
              return connection.query(sql, values);
            },
            release() { connection.release(); },
          };
        },
      };
      const input = request(sessionId, "leave-precision");
      const applied = await command(input, { database });
      assert.equal(applied.reconciliationStatus, "applied");
      const durable = await harness.pool.query(
        `SELECT participant.left_at,
                participant.left_at >= participant.joined_at AS ordered,
                participant.left_at = $1::timestamptz AS precise,
                session.active_screen_share_owner_user_id AS owner,
                event.occurred_at = participant.left_at AS event_time_matches,
                event.payload
           FROM ${tables.participants} AS participant
           JOIN ${tables.sessions} AS session
             ON session.tenant_id = participant.tenant_id
            AND session.id = participant.huddle_session_id
           JOIN ${tables.outbox} AS event
             ON event.tenant_id = participant.tenant_id
            AND event.payload -> 'state' ->> 'huddleSessionId' = session.id
          WHERE participant.tenant_id = $2
            AND participant.huddle_session_id = $3 AND participant.user_id = $4`,
        [departureClock, actor.tenantId, sessionId, actor.userId],
      );
      assert.equal(durable.rows.length, 1);
      const stored = durable.rows[0];
      assert.equal(stored.ordered, true);
      assert.equal(stored.precise, true);
      assert.equal(stored.owner, null);
      assert.equal(stored.event_time_matches, true);
      const participant = applied.state.participants.find(({ userId }) => userId === actor.userId);
      assert.equal(participant.leftAt, stored.left_at.toISOString());
      assert.equal(participant.status, "left");
      assert.equal(applied.state.screenShareOwnerUserId, null);
      assert.deepEqual(stored.payload.participant, participant);
      assert.deepEqual(stored.payload.state, applied.state);
      assert.deepEqual(await counts(sessionId), { outbox: 1, idempotency: 1 });
      const replay = await command(input, { database });
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.state, applied.state);
      assert.equal(clockReads, 1);
      assert.deepEqual(await counts(sessionId), { outbox: 1, idempotency: 1 });
    });

    await t.test("rolls back participant, screen share, outbox, and idempotency on a late failure", async () => {
      await harness.pool.query(
        `CREATE FUNCTION fail_leave_outbox()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.event_id = 'fail-leave-event' THEN
               RAISE EXCEPTION 'injected leave outbox failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER fail_leave_outbox
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION fail_leave_outbox()`,
      );
      await assert.rejects(
        command(request("session-rollback", "leave-rollback"), {
          createId: () => "fail-leave-event",
        }),
        /injected leave outbox failure/,
      );
      const stored = await harness.pool.query(
        `SELECT session.active_screen_share_owner_user_id, session.status,
                participant.left_at, participant.leave_reason
           FROM ${tables.sessions} AS session
           INNER JOIN ${tables.participants} AS participant
             ON participant.tenant_id = session.tenant_id
            AND participant.huddle_session_id = session.id
            AND participant.user_id = $1
          WHERE session.tenant_id = 'tenant-a' AND session.id = 'session-rollback'`,
        [actor.userId],
      );
      assert.deepEqual(stored.rows[0], {
        active_screen_share_owner_user_id: actor.userId,
        status: "active",
        left_at: null,
        leave_reason: null,
      });
      assert.deepEqual(await counts("session-rollback"), { outbox: 0, idempotency: 0 });
      await harness.pool.query(`DROP TRIGGER fail_leave_outbox ON ${tables.outbox}`);
      await harness.pool.query(`DROP FUNCTION fail_leave_outbox()`);
    });

    await t.test("disconnect helper invokes the shared operation with a deterministic retry-safe identity", async () => {
      const options = {
        database: harness.pool,
        schema: harness.schema,
        permissions,
        actor,
        disconnectIdentity: "trusted-socket-session",
      };
      assert.equal(await leaveJoinedHuddlesOnDisconnect(options), 2);
      assert.equal(await leaveJoinedHuddlesOnDisconnect(options), 0);
      const stored = await harness.pool.query(
        `SELECT leave_reason FROM ${tables.participants}
          WHERE tenant_id = 'tenant-a'
            AND huddle_session_id = 'session-disconnect-helper'
            AND user_id = $1`,
        [actor.userId],
      );
      assert.equal(stored.rows[0].leave_reason, HUDDLE_LEAVE_REASONS.disconnect);
      assert.deepEqual(await counts("session-disconnect-helper"), { outbox: 1, idempotency: 1 });
    });

    await t.test("an authenticated WebSocket close invokes disconnect leave, while failed handshakes do not", async () => {
      await seedActiveSession({
        conversationId: "conversation-websocket-disconnect",
        sessionId: "session-websocket-disconnect",
      });
      const runtime = createChatServer({
        database: { pool: harness.pool, schema: harness.schema },
        auth: {
          async resolveActor(request) {
            if (request.headers.authorization !== "Bearer valid") {
              throw new Error("private authentication detail");
            }
            return actor;
          },
        },
        directory: {
          async getUser() { return null; },
          async searchUsers() { return []; },
        },
        permissions,
        webSocket: { handshakeTimeoutMs: 1_000 },
      });
      const server = createServer(runtime.router);
      runtime.attachWebSocket(server);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.equal(typeof address, "object");
      const url = `ws://127.0.0.1:${address.port}/_realtime`;
      try {
        const rejected = new WebSocket(url, {
          headers: { authorization: "Bearer invalid" },
        });
        rejected.once("open", () => {
          rejected.send(JSON.stringify({
            clientPackageVersion: "0.1.3",
            protocolVersion: CHAT_PROTOCOL_VERSION,
          }));
        });
        await new Promise((resolve) => rejected.once("close", resolve));
        const before = await harness.pool.query(
          `SELECT left_at FROM ${tables.participants}
            WHERE tenant_id = 'tenant-a'
              AND huddle_session_id = 'session-websocket-disconnect'
              AND user_id = $1`,
          [actor.userId],
        );
        assert.equal(before.rows[0].left_at, null);

        const socket = new WebSocket(url, {
          headers: { authorization: "Bearer valid" },
        });
        const accepted = new Promise((resolve) =>
          socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
        );
        socket.once("open", () => {
          socket.send(JSON.stringify({
            clientPackageVersion: "0.1.3",
            protocolVersion: CHAT_PROTOCOL_VERSION,
          }));
        });
        assert.equal((await accepted).type, "chat.session.accepted");
        socket.close();
        await new Promise((resolve) => socket.once("close", resolve));
        await waitFor(async () => {
          const result = await harness.pool.query(
            `SELECT leave_reason FROM ${tables.participants}
              WHERE tenant_id = 'tenant-a'
                AND huddle_session_id = 'session-websocket-disconnect'
                AND user_id = $1`,
            [actor.userId],
          );
          return result.rows[0].leave_reason === HUDDLE_LEAVE_REASONS.disconnect;
        });
        const session = await harness.pool.query(
          `SELECT status, ended_at FROM ${tables.sessions}
            WHERE tenant_id = 'tenant-a' AND id = 'session-websocket-disconnect'`,
        );
        assert.deepEqual(session.rows[0], { status: "active", ended_at: null });
      } finally {
        runtime.detachWebSocket(CHAT_WEBSOCKET_CLOSE_REASONS.runtimeClosed);
        await runtime.close();
        await new Promise((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()),
        );
      }
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
