import assert from "node:assert/strict";
import test from "node:test";

import {
  END_HUDDLE_AUDIT_ACTION,
  END_HUDDLE_ENTITY_POLICY_ACTION,
  END_HUDDLE_IDEMPOTENCY_OPERATION,
  END_HUDDLE_INTERNAL_ENDING_STATUS,
  END_HUDDLE_MODERATION_CAPABILITY,
  END_HUDDLE_OUTBOX_EVENT_TYPE,
  HUDDLE_LEAVE_REASONS,
  START_HUDDLE_CAPABILITY,
  ChatAuthorizationError,
  EndHuddleCommandError,
  StartHuddleCommandError,
  createPostgresMigrationRunner,
  endHuddle,
  handrailChatPostgresMigrations,
  startHuddle,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actors = Object.freeze({
  alice: Object.freeze({
    tenantId: "tenant-a",
    userId: "alice",
    roles: Object.freeze(["trusted-host-role"]),
  }),
  bob: Object.freeze({
    tenantId: "tenant-a",
    userId: "bob",
    roles: Object.freeze(["trusted-host-role"]),
  }),
  mallory: Object.freeze({
    tenantId: "tenant-b",
    userId: "mallory",
    roles: Object.freeze(["trusted-host-role"]),
  }),
});

const input = (sessionId, key) => ({
  operation: "end_huddle",
  huddleSessionId: sessionId,
  idempotencyKey: key,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

class FakeMediaAdapter {
  constructor() {
    this.created = [];
    this.terminated = [];
    this.failNextTermination = false;
    this.releaseTermination = null;
  }

  async createRoom(request) {
    this.created.push(request);
    return { roomId: `replacement-room-${request.conversationId}` };
  }

  async createParticipantToken() {
    throw new Error("not used");
  }

  async terminateRoom(request) {
    this.terminated.push(request);
    if (this.failNextTermination) {
      this.failNextTermination = false;
      const error = new Error("raw provider timeout secret=provider-secret-token");
      error.providerResponse = { accessToken: "provider-access-token" };
      throw error;
    }
    if (this.releaseTermination !== null) {
      await new Promise((resolve) => {
        this.releaseTermination = resolve;
      });
    }
  }
}

test("trusted end-huddle is recoverable, tenant-safe, and exactly final", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_end_huddle" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    sessions: `${schema}.chat_huddle_sessions`,
    participants: `${schema}.chat_huddle_participants`,
    idempotency: `${schema}.chat_idempotency_keys`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
  };
  const media = new FakeMediaAdapter();
  const capabilityUsers = new Set();
  let entityAllowed = true;
  const entityCalls = [];
  const permissions = {
    async getCapabilities({ actor }) {
      return capabilityUsers.has(actor.userId)
        ? [END_HUDDLE_MODERATION_CAPABILITY]
        : [];
    },
    async authorizeEntity(request) {
      entityCalls.push(request);
      return entityAllowed;
    },
  };
  let idSequence = 0;
  const command = (actor, request, overrides = {}) =>
    endHuddle({
      database: harness.pool,
      schema: harness.schema,
      permissions,
      actor,
      input: request,
      media,
      createId: () => `end-huddle-id-${++idSequence}`,
      ...overrides,
    });

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    sessionId,
    initiator = "alice",
    status = "active",
    participantUserIds = status === "active" ? ["alice", "bob"] : [],
    ownerUserId = null,
    archived = false,
    entity = null,
    preciseTimes = null,
  }) => {
    const users = [...new Set([initiator, ...participantUserIds, "alice", "bob"])]
      .filter((userId) => tenantId === "tenant-a" || userId !== "bob");
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4)`,
      [tenantId, conversationId, entity?.type ?? null, entity?.id ?? null],
    );
    for (const userId of users) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', 'active')`,
        [tenantId, conversationId, userId],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.sessions} (
         tenant_id, id, conversation_id, provider_room_reference,
         status, initiated_by_user_id, started_at
       ) VALUES ($1, $2, $3, $4, 'starting', $5,
                 COALESCE($6::timestamptz, clock_timestamp()))`,
      [
        tenantId,
        sessionId,
        conversationId,
        `opaque-provider-room-${sessionId}`,
        initiator,
        preciseTimes?.startedAt ?? null,
      ],
    );
    for (const userId of participantUserIds) {
      await harness.pool.query(
        `INSERT INTO ${tables.participants}
           (tenant_id, huddle_session_id, user_id, joined_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, clock_timestamp()))`,
        [tenantId, sessionId, userId, preciseTimes?.joinedAt[userId] ?? null],
      );
    }
    if (status === "active") {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'active',
                activated_at = COALESCE($3::timestamptz, clock_timestamp()),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, sessionId, preciseTimes?.activatedAt ?? null],
      );
    }
    if (ownerUserId !== null) {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET active_screen_share_owner_user_id = $1,
                updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND id = $3`,
        [ownerUserId, tenantId, sessionId],
      );
    }
    if (archived) {
      await harness.pool.query(
        `UPDATE ${tables.conversations}
            SET archived_at = clock_timestamp(), archived_by_user_id = $1
          WHERE tenant_id = $2 AND id = $3`,
        [initiator, tenantId, conversationId],
      );
    }
  };

  const finalCounts = async (sessionId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = 'tenant-a' AND action = $2
             AND metadata -> 'state' ->> 'huddleSessionId' = $1) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a' AND type = $3
             AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox`,
      [sessionId, END_HUDDLE_AUDIT_ACTION, END_HUDDLE_OUTBOX_EVENT_TYPE],
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

    await seedSession({
      conversationId: "conversation-success",
      sessionId: "session-success",
      ownerUserId: "bob",
      entity: { type: "invoice", id: "invoice-visible" },
    });
    await seedSession({
      conversationId: "conversation-moderated",
      sessionId: "session-moderated",
      initiator: "alice",
    });
    await seedSession({
      conversationId: "conversation-unauthorized",
      sessionId: "session-unauthorized",
      initiator: "alice",
    });
    await seedSession({
      tenantId: "tenant-b",
      conversationId: "conversation-cross-tenant",
      sessionId: "session-cross-tenant",
      initiator: "mallory",
      participantUserIds: ["mallory"],
    });
    await seedSession({
      conversationId: "conversation-archived",
      sessionId: "session-archived",
      archived: true,
    });
    await seedSession({
      conversationId: "conversation-timeout",
      sessionId: "session-timeout",
      ownerUserId: "bob",
    });
    await seedSession({
      conversationId: "conversation-starting",
      sessionId: "session-starting",
      status: "starting",
    });
    await seedSession({
      conversationId: "conversation-ending-exclusive",
      sessionId: "session-ending-exclusive",
    });

    await t.test("initiator success closes participants/share and persists one exact sanitized final state", async () => {
      const request = input("session-success", "success");
      const applied = await command(actors.alice, request);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.state.status, "ended");
      assert.equal(applied.state.endedByUserId, actors.alice.userId);
      assert.equal(applied.state.screenShareOwnerUserId, null);
      assert.ok(applied.state.participants.every(({ status }) => status === "left"));
      assert.deepEqual(media.terminated.at(-1), {
        actor: actors.alice,
        roomId: "opaque-provider-room-session-success",
      });
      assert.deepEqual(entityCalls.at(-1), {
        actor: actors.alice,
        entity: { type: "invoice", id: "invoice-visible" },
        action: END_HUDDLE_ENTITY_POLICY_ACTION,
      });

      const durable = await harness.pool.query(
        `SELECT session.status, session.started_at, session.ended_at,
                session.ended_by_user_id,
                session.active_screen_share_owner_user_id,
                participant.user_id, participant.joined_at,
                participant.left_at, participant.leave_reason
           FROM ${tables.sessions} AS session
           LEFT JOIN ${tables.participants} AS participant
             ON participant.tenant_id = session.tenant_id
            AND participant.huddle_session_id = session.id
          WHERE session.tenant_id = 'tenant-a' AND session.id = $1
          ORDER BY participant.joined_at, participant.user_id`,
        ["session-success"],
      );
      const storedState = {
        status: durable.rows[0].status,
        conversationId: "conversation-success",
        huddleSessionId: "session-success",
        startedAt: durable.rows[0].started_at.toISOString(),
        endedAt: durable.rows[0].ended_at.toISOString(),
        endedByUserId: durable.rows[0].ended_by_user_id,
        participants: durable.rows.map((row) => ({
          userId: row.user_id,
          status: "left",
          joinedAt: row.joined_at.toISOString(),
          leftAt: row.left_at.toISOString(),
        })),
        screenShareOwnerUserId:
          durable.rows[0].active_screen_share_owner_user_id,
      };
      assert.deepEqual(storedState, applied.state);
      assert.ok(durable.rows.every(
        ({ leave_reason }) => leave_reason === HUDDLE_LEAVE_REASONS.huddleEnded,
      ));

      const records = await harness.pool.query(
        `SELECT
           (SELECT response_body FROM ${tables.idempotency}
             WHERE tenant_id = 'tenant-a' AND user_id = 'alice'
               AND operation_name = $1 AND client_key = 'success') AS response,
           (SELECT metadata FROM ${tables.audit}
             WHERE tenant_id = 'tenant-a' AND action = $2
               AND metadata -> 'state' ->> 'huddleSessionId' = 'session-success') AS audit,
           (SELECT payload FROM ${tables.outbox}
             WHERE tenant_id = 'tenant-a' AND type = $3
               AND payload -> 'state' ->> 'huddleSessionId' = 'session-success') AS outbox`,
        [
          END_HUDDLE_IDEMPOTENCY_OPERATION,
          END_HUDDLE_AUDIT_ACTION,
          END_HUDDLE_OUTBOX_EVENT_TYPE,
        ],
      );
      assert.deepEqual(records.rows[0].response, applied);
      assert.deepEqual(records.rows[0].audit, {
        operation: "end_huddle",
        state: applied.state,
      });
      assert.deepEqual(records.rows[0].outbox, records.rows[0].audit);
      const durableJson = JSON.stringify(records.rows[0]);
      for (const forbidden of [
        "opaque-provider-room",
        "provider-secret",
        "accessToken",
        "token",
        "diagnostic",
        "providerResponse",
      ]) {
        assert.equal(durableJson.includes(forbidden), false, forbidden);
      }

      const replayed = await command(actors.alice, request);
      assert.equal(replayed.reconciliationStatus, "replayed");
      assert.deepEqual(replayed.state, applied.state);
      assert.equal(
        media.terminated.filter(({ roomId }) =>
          roomId === "opaque-provider-room-session-success").length,
        1,
      );
      assert.deepEqual(await finalCounts("session-success"), {
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("terminal persistence preserves a same-millisecond PostgreSQL clock through replay", async () => {
      const sessionId = "session-precise-terminal";
      const terminalTime = "2026-01-01T00:00:00.123789Z";
      const wireTime = "2026-01-01T00:00:00.123Z";
      await seedSession({
        conversationId: "conversation-precise-terminal",
        sessionId,
        ownerUserId: "bob",
        preciseTimes: {
          startedAt: "2026-01-01T00:00:00.123123Z",
          activatedAt: "2026-01-01T00:00:00.123456Z",
          joinedAt: {
            alice: "2026-01-01T00:00:00.123456Z",
            bob: "2026-01-01T00:00:00.123678Z",
          },
        },
      });
      let clockSamples = 0;
      // Replace only the clock expression; PostgreSQL still executes all SQL,
      // including timestamp decoding, transactions, writes, and constraints.
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            query(sql, values) {
              if (/^SELECT clock_timestamp\(\)(?:::text)? AS ended_at$/u.test(sql)) {
                clockSamples += 1;
                return connection.query(
                  sql.replace("clock_timestamp()", "$1::timestamptz"),
                  [terminalTime],
                );
              }
              return connection.query(sql, values);
            },
            release: () => connection.release(),
          };
        },
      };
      const request = input(sessionId, "precise-terminal");
      const applied = await command(actors.alice, request, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.equal(applied.reconciliationStatus, "applied");
      const durable = await harness.pool.query(
        `SELECT session.status,
                session.active_screen_share_owner_user_id AS share_owner,
                session.ended_at >= session.started_at AS after_start,
                session.ended_at >= session.activated_at AS after_activation,
                session.ended_at = $2::timestamptz AS exact_clock,
                count(*)::integer AS participants,
                count(*) FILTER (WHERE participant.left_at IS NULL)::integer AS active,
                bool_and(participant.left_at >= participant.joined_at) AS after_join,
                bool_and(participant.left_at = session.ended_at) AS same_clock
           FROM ${tables.sessions} AS session
           JOIN ${tables.participants} AS participant
             ON participant.tenant_id = session.tenant_id
            AND participant.huddle_session_id = session.id
          WHERE session.tenant_id = 'tenant-a' AND session.id = $1
          GROUP BY session.tenant_id, session.id`,
        [sessionId, terminalTime],
      );
      assert.deepEqual(durable.rows[0], {
        status: "ended", share_owner: null, after_start: true,
        after_activation: true, exact_clock: true, participants: 2,
        active: 0, after_join: true, same_clock: true,
      });
      assert.deepEqual(applied.state, {
        status: "ended",
        conversationId: "conversation-precise-terminal",
        huddleSessionId: sessionId,
        startedAt: wireTime,
        endedAt: wireTime,
        endedByUserId: "alice",
        participants: ["alice", "bob"].map((userId) => ({
          userId, status: "left", joinedAt: wireTime, leftAt: wireTime,
        })),
        screenShareOwnerUserId: null,
      });
      const records = await harness.pool.query(
        `SELECT
           (SELECT response_body FROM ${tables.idempotency}
             WHERE tenant_id = 'tenant-a' AND user_id = 'alice'
               AND operation_name = $2 AND client_key = 'precise-terminal') AS response,
           (SELECT metadata FROM ${tables.audit}
             WHERE action = $3 AND metadata -> 'state' ->> 'huddleSessionId' = $1) AS audit,
           (SELECT payload FROM ${tables.outbox}
             WHERE type = $4 AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox`,
        [sessionId, END_HUDDLE_IDEMPOTENCY_OPERATION,
          END_HUDDLE_AUDIT_ACTION, END_HUDDLE_OUTBOX_EVENT_TYPE],
      );
      assert.deepEqual(records.rows[0], {
        response: applied,
        audit: { operation: "end_huddle", state: applied.state },
        outbox: { operation: "end_huddle", state: applied.state },
      });
      assert.deepEqual(await finalCounts(sessionId), { audit: 1, outbox: 1 });
      const replayed = await command(actors.alice, request, { database: clockDatabase });
      assert.deepEqual(replayed, { ...applied, reconciliationStatus: "replayed" });
      assert.equal(clockSamples, 1);
      assert.equal(media.terminated.filter(({ roomId }) =>
        roomId === `opaque-provider-room-${sessionId}`).length, 1);
      assert.deepEqual(await finalCounts(sessionId), { audit: 1, outbox: 1 });
    });

    await t.test("trusted moderation capability can end another initiator's huddle", async () => {
      capabilityUsers.add("bob");
      const result = await command(
        actors.bob,
        input("session-moderated", "moderated"),
      );
      assert.equal(result.state.endedByUserId, "bob");
      assert.equal(result.state.status, "ended");
    });

    await t.test("unauthorized, cross-tenant, archived, and entity-denied attempts are sanitized", async () => {
      capabilityUsers.delete("bob");
      const callsBefore = media.terminated.length;
      await assert.rejects(
        command(actors.bob, input("session-unauthorized", "unauthorized")),
        sanitizedAuthorizationFailure,
      );
      await assert.rejects(
        command(actors.alice, input("session-cross-tenant", "cross-tenant")),
        sanitizedAuthorizationFailure,
      );
      await assert.rejects(
        command(actors.alice, input("session-archived", "archived")),
        sanitizedAuthorizationFailure,
      );
      entityAllowed = false;
      await assert.rejects(
        command(actors.alice, input("session-success", "entity-denied")),
        sanitizedAuthorizationFailure,
      );
      entityAllowed = true;
      assert.equal(media.terminated.length, callsBefore);
    });

    await t.test("provider timeout leaves safe ending intent and the same key retries to completion", async () => {
      media.failNextTermination = true;
      const request = input("session-timeout", "timeout-retry");
      await assert.rejects(
        command(actors.alice, request),
        (error) =>
          error instanceof EndHuddleCommandError &&
          error.code === "media_termination_failed" &&
          error.statusCode === 503 &&
          error.message === "The media provider could not terminate the huddle room",
      );
      const failed = await harness.pool.query(
        `SELECT session.status, session.ended_at, session.ended_by_user_id,
                session.active_screen_share_owner_user_id,
                idempotency.state AS idempotency_state,
                idempotency.response_body
           FROM ${tables.sessions} AS session
           INNER JOIN ${tables.idempotency} AS idempotency
             ON idempotency.tenant_id = session.tenant_id
            AND idempotency.user_id = 'alice'
            AND idempotency.operation_name = $1
            AND idempotency.client_key = 'timeout-retry'
          WHERE session.tenant_id = 'tenant-a' AND session.id = $2`,
        [END_HUDDLE_IDEMPOTENCY_OPERATION, "session-timeout"],
      );
      assert.deepEqual(failed.rows[0], {
        status: END_HUDDLE_INTERNAL_ENDING_STATUS,
        ended_at: null,
        ended_by_user_id: "alice",
        active_screen_share_owner_user_id: "bob",
        idempotency_state: "pending",
        response_body: null,
      });
      assert.equal(JSON.stringify(failed.rows[0]).includes("provider"), false);
      assert.deepEqual(await finalCounts("session-timeout"), {
        audit: 0,
        outbox: 0,
      });

      const recovered = await command(actors.alice, request);
      assert.equal(recovered.state.status, "ended");
      assert.equal(recovered.reconciliationStatus, "applied");
      assert.equal(
        media.terminated.filter(({ roomId }) =>
          roomId === "opaque-provider-room-session-timeout").length,
        2,
      );
      assert.deepEqual(await finalCounts("session-timeout"), {
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("starting sessions end through the same public terminal contract", async () => {
      const result = await command(
        actors.alice,
        input("session-starting", "starting"),
      );
      assert.equal(result.state.status, "ended");
      assert.deepEqual(result.state.participants, []);
    });

    await t.test("ending remains conversation-exclusive while provider termination is underway", async () => {
      media.releaseTermination = () => undefined;
      const endingPromise = command(
        actors.alice,
        input("session-ending-exclusive", "ending-exclusive"),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await harness.pool.query(
          `SELECT status FROM ${tables.sessions}
            WHERE tenant_id = 'tenant-a' AND id = 'session-ending-exclusive'`,
        );
        if (state.rows[0]?.status === END_HUDDLE_INTERNAL_ENDING_STATUS) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const startPermissions = {
        async getCapabilities() {
          return [START_HUDDLE_CAPABILITY];
        },
        async authorizeEntity() {
          return true;
        },
      };
      await assert.rejects(
        startHuddle({
          database: harness.pool,
          schema: harness.schema,
          permissions: startPermissions,
          actor: actors.alice,
          input: {
            operation: "start_huddle",
            conversationId: "conversation-ending-exclusive",
            idempotencyKey: "replacement",
          },
          mediaEnabled: true,
          media,
        }),
        (error) =>
          error instanceof StartHuddleCommandError &&
          error.code === "huddle_already_active",
      );
      assert.equal(
        media.created.some(({ conversationId }) =>
          conversationId === "conversation-ending-exclusive"),
        false,
      );
      const release = media.releaseTermination;
      media.releaseTermination = null;
      release();
      const result = await endingPromise;
      assert.equal(result.state.status, "ended");
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
