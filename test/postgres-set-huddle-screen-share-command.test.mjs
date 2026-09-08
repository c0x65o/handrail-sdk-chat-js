import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HUDDLE_LEAVE_REASONS,
  HUDDLE_SCREEN_SHARE_CAPABILITY,
  HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION,
  HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
  HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
  LEAVE_HUDDLE_OUTBOX_EVENT_TYPE,
  ChatAuthorizationError,
  SetHuddleScreenShareCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  leaveHuddle,
  setHuddleScreenShare,
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
});

const request = (huddleSessionId, intent, idempotencyKey) => ({
  operation: "set_huddle_screen_share",
  huddleSessionId,
  intent,
  idempotencyKey,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

const requestHash = ({ operation, huddleSessionId, intent }) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({ operation, huddleSessionId, intent }))
    .digest("hex")}`;

test("trusted screen-share ownership is exclusive, atomic, replayable, and leave-safe", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_huddle_share",
  });
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
  let capabilityAllowed = true;
  let entityAllowed = true;
  const permissions = {
    async getCapabilities({ actor }) {
      return capabilityAllowed && actor.roles.includes("trusted-host-role")
        ? [HUDDLE_SCREEN_SHARE_CAPABILITY]
        : [];
    },
    async authorizeEntity(input) {
      entityCalls.push(input);
      return entityAllowed;
    },
  };
  let eventSequence = 0;
  const command = (actor, input, overrides = {}) =>
    setHuddleScreenShare({
      database: harness.pool,
      schema: harness.schema,
      permissions,
      actor,
      input,
      maxActiveScreenSharers: 1,
      createId: () => `screen-share-event-${++eventSequence}`,
      ...overrides,
    });

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    sessionId,
    participantUserIds = [actors.alice.userId],
    memberUserIds = participantUserIds,
    ownerUserId = null,
    status = "active",
    entity = null,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4)`,
      [tenantId, conversationId, entity?.type ?? null, entity?.id ?? null],
    );
    for (const userId of new Set(["starter-user", ...memberUserIds])) {
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
         status, initiated_by_user_id
       ) VALUES ($1, $2, $3, $4, 'starting', 'starter-user')`,
      [tenantId, sessionId, conversationId, `opaque-room-${tenantId}-${sessionId}`],
    );
    for (const userId of participantUserIds) {
      await harness.pool.query(
        `INSERT INTO ${tables.participants}
           (tenant_id, huddle_session_id, user_id)
         VALUES ($1, $2, $3)`,
        [tenantId, sessionId, userId],
      );
    }
    if (status === "active") {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'active', activated_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, sessionId],
      );
      if (ownerUserId !== null) {
        await harness.pool.query(
          `UPDATE ${tables.sessions}
              SET active_screen_share_owner_user_id = $1,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $2 AND id = $3`,
          [ownerUserId, tenantId, sessionId],
        );
      }
    } else if (status === "ended") {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ending', ended_by_user_id = 'starter-user',
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, sessionId],
      );
      await harness.pool.query(
        `UPDATE ${tables.participants}
            SET left_at = clock_timestamp(), leave_reason = 'huddle_ended'
          WHERE tenant_id = $1 AND huddle_session_id = $2`,
        [tenantId, sessionId],
      );
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ended', ended_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, sessionId],
      );
    }
  };

  const effectCounts = async (sessionId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a' AND type = $2
             AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE tenant_id = 'tenant-a' AND operation_name = $3
             AND state = 'completed'
             AND response_body -> 'state' ->> 'huddleSessionId' = $1) AS idempotency`,
      [
        sessionId,
        HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
        HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
      ],
    );
    return result.rows[0];
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    for (const seed of [
      {
        conversationId: "conversation-lifecycle",
        sessionId: "session-lifecycle",
        entity: { type: "invoice", id: "invoice-a" },
      },
      {
        conversationId: "conversation-race",
        sessionId: "session-race",
        participantUserIds: [actors.alice.userId, actors.bob.userId],
      },
      {
        conversationId: "conversation-nonparticipant",
        sessionId: "session-nonparticipant",
        participantUserIds: [actors.bob.userId],
        memberUserIds: [actors.alice.userId, actors.bob.userId],
      },
      {
        tenantId: "tenant-b",
        conversationId: "conversation-cross-tenant",
        sessionId: "session-cross-tenant",
      },
      {
        conversationId: "conversation-ended",
        sessionId: "session-ended",
        status: "ended",
      },
      {
        conversationId: "conversation-disabled",
        sessionId: "session-disabled",
      },
      {
        conversationId: "conversation-conflict",
        sessionId: "session-conflict",
        participantUserIds: [actors.alice.userId, actors.bob.userId],
        ownerUserId: actors.bob.userId,
      },
      {
        conversationId: "conversation-idempotency",
        sessionId: "session-idempotency",
      },
      {
        conversationId: "conversation-in-progress",
        sessionId: "session-in-progress",
      },
      {
        conversationId: "conversation-rollback",
        sessionId: "session-rollback",
      },
      {
        conversationId: "conversation-leave",
        sessionId: "session-leave",
      },
      {
        conversationId: "conversation-authorization",
        sessionId: "session-authorization",
        entity: { type: "invoice", id: "invoice-denied" },
      },
    ]) {
      await seedSession(seed);
    }

    await t.test("starts and stops with canonical durable state and ordered outbox payloads", async () => {
      const started = await command(
        actors.alice,
        request("session-lifecycle", "set", "lifecycle-set"),
      );
      assert.equal(started.reconciliationStatus, "applied");
      assert.equal(started.state.screenShareOwnerUserId, actors.alice.userId);
      assert.deepEqual(started.state.participants.map(({ userId, status }) => ({ userId, status })), [
        { userId: actors.alice.userId, status: "joined" },
      ]);
      assert.deepEqual(entityCalls.at(-1), {
        actor: actors.alice,
        entity: { type: "invoice", id: "invoice-a" },
        action: HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION,
      });

      const stopped = await command(
        actors.alice,
        request("session-lifecycle", "clear", "lifecycle-clear"),
      );
      assert.equal(stopped.state.screenShareOwnerUserId, null);
      assert.deepEqual(stopped.state.participants, started.state.participants);

      const durable = await harness.pool.query(
        `SELECT active_screen_share_owner_user_id, status
           FROM ${tables.sessions}
          WHERE tenant_id = 'tenant-a' AND id = 'session-lifecycle'`,
      );
      assert.deepEqual(durable.rows[0], {
        active_screen_share_owner_user_id: null,
        status: "active",
      });
      const events = await harness.pool.query(
        `SELECT type, payload
           FROM ${tables.outbox}
          WHERE tenant_id = 'tenant-a'
            AND payload -> 'state' ->> 'huddleSessionId' = 'session-lifecycle'
          ORDER BY replay_position`,
      );
      assert.deepEqual(events.rows.map(({ type, payload }) => ({
        type,
        intent: payload.intent,
        owner: payload.state.screenShareOwnerUserId,
        state: payload.state.status,
      })), [
        {
          type: HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
          intent: "set",
          owner: actors.alice.userId,
          state: "active",
        },
        {
          type: HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
          intent: "clear",
          owner: null,
          state: "active",
        },
      ]);
      assert.equal(JSON.stringify(events.rows).includes("opaque-room"), false);

      const storedResults = await harness.pool.query(
        `SELECT client_key, response_body
           FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND operation_name = $1
            AND client_key IN ('lifecycle-set', 'lifecycle-clear')
          ORDER BY client_key`,
        [HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION],
      );
      assert.deepEqual(storedResults.rows.map(({ client_key, response_body }) => ({
        key: client_key,
        outcome: response_body.outcome,
        owner: response_body.state.screenShareOwnerUserId,
      })), [
        { key: "lifecycle-clear", outcome: "ok", owner: null },
        { key: "lifecycle-set", outcome: "ok", owner: actors.alice.userId },
      ]);
    });

    await t.test("serializes two participants racing so exactly one owns the share", async () => {
      const outcomes = await Promise.allSettled([
        command(actors.alice, request("session-race", "set", "race-alice")),
        command(actors.bob, request("session-race", "set", "race-bob")),
      ]);
      assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
      const rejection = outcomes.find(({ status }) => status === "rejected");
      assert.ok(
        rejection.reason instanceof SetHuddleScreenShareCommandError &&
        rejection.reason.code === "screen_share_ownership_conflict",
      );
      const winner = outcomes.find(({ status }) => status === "fulfilled").value;
      const stored = await harness.pool.query(
        `SELECT active_screen_share_owner_user_id FROM ${tables.sessions}
          WHERE tenant_id = 'tenant-a' AND id = 'session-race'`,
      );
      assert.equal(stored.rows[0].active_screen_share_owner_user_id, winner.state.screenShareOwnerUserId);
      assert.deepEqual(await effectCounts("session-race"), { outbox: 1, idempotency: 1 });
    });

    await t.test("rejects nonparticipants, cross-tenant sessions, and missing sessions indistinguishably", async () => {
      for (const [sessionId, key] of [
        ["session-nonparticipant", "nonparticipant"],
        ["session-cross-tenant", "cross-tenant"],
        ["missing-session", "missing"],
      ]) {
        await assert.rejects(
          command(actors.alice, request(sessionId, "set", key)),
          sanitizedAuthorizationFailure,
        );
      }
    });

    await t.test("rejects ended sessions, disabled policy, ownership conflicts, and invalid stops with stable codes", async () => {
      await assert.rejects(
        command(actors.alice, request("session-ended", "set", "ended")),
        (error) =>
          error instanceof SetHuddleScreenShareCommandError &&
          error.code === "huddle_not_active" && error.statusCode === 409,
      );
      await assert.rejects(
        command(
          actors.alice,
          request("session-disabled", "set", "disabled"),
          { maxActiveScreenSharers: 0 },
        ),
        (error) =>
          error instanceof SetHuddleScreenShareCommandError &&
          error.code === "screen_share_disabled" && error.statusCode === 403,
      );
      for (const intent of ["set", "clear"]) {
        await assert.rejects(
          command(
            actors.alice,
            request("session-conflict", intent, `conflict-${intent}`),
          ),
          (error) =>
            error instanceof SetHuddleScreenShareCommandError &&
            error.code === "screen_share_ownership_conflict",
        );
      }
      await assert.rejects(
        command(
          actors.alice,
          request("session-disabled", "clear", "invalid-clear"),
          { maxActiveScreenSharers: 0 },
        ),
        (error) =>
          error instanceof SetHuddleScreenShareCommandError &&
          error.code === "screen_share_not_active",
      );
      assert.deepEqual(await effectCounts("session-disabled"), { outbox: 0, idempotency: 0 });
    });

    await t.test("enforces capability and host entity authorization without retaining claims", async () => {
      capabilityAllowed = false;
      await assert.rejects(
        command(
          actors.alice,
          request("session-authorization", "set", "capability-denied"),
        ),
        sanitizedAuthorizationFailure,
      );
      capabilityAllowed = true;
      entityAllowed = false;
      await assert.rejects(
        command(
          actors.alice,
          request("session-authorization", "set", "entity-denied"),
        ),
        sanitizedAuthorizationFailure,
      );
      entityAllowed = true;
      assert.deepEqual(await effectCounts("session-authorization"), { outbox: 0, idempotency: 0 });
    });

    await t.test("replays the full original state once and rejects a different request using the key", async () => {
      const setRequest = request("session-idempotency", "set", "same-key");
      const applied = await command(actors.alice, setRequest);
      const appliedRow = await harness.pool.query(
        `SELECT updated_at FROM ${tables.sessions}
          WHERE tenant_id = 'tenant-a' AND id = 'session-idempotency'`,
      );
      const replayed = await command(actors.alice, setRequest);
      const replayedRow = await harness.pool.query(
        `SELECT updated_at FROM ${tables.sessions}
          WHERE tenant_id = 'tenant-a' AND id = 'session-idempotency'`,
      );
      assert.equal(replayed.reconciliationStatus, "replayed");
      assert.deepEqual(replayed.state, applied.state);
      assert.equal(
        replayedRow.rows[0].updated_at.toISOString(),
        appliedRow.rows[0].updated_at.toISOString(),
      );
      assert.deepEqual(await effectCounts("session-idempotency"), { outbox: 1, idempotency: 1 });

      await assert.rejects(
        command(
          actors.alice,
          request("session-idempotency", "clear", "same-key"),
        ),
        (error) =>
          error instanceof SetHuddleScreenShareCommandError &&
          error.code === "idempotency_conflict",
      );
      assert.deepEqual(await effectCounts("session-idempotency"), { outbox: 1, idempotency: 1 });
    });

    await t.test("reports a durable pending request as in progress", async () => {
      const pendingRequest = request(
        "session-in-progress",
        "set",
        "pending-key",
      );
      await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash, expires_at
         ) VALUES (
           'tenant-a', $1, $2, $3, $4, clock_timestamp() + interval '1 hour'
         )`,
        [
          actors.alice.userId,
          HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
          pendingRequest.idempotencyKey,
          requestHash(pendingRequest),
        ],
      );
      await assert.rejects(
        command(actors.alice, pendingRequest),
        (error) =>
          error instanceof SetHuddleScreenShareCommandError &&
          error.code === "idempotency_in_progress",
      );
      assert.deepEqual(await effectCounts("session-in-progress"), { outbox: 0, idempotency: 0 });
    });

    await t.test("rolls back ownership, outbox, and idempotency when completion fails late", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.fail_screen_share_completion()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.operation_name = '${HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION}'
                AND NEW.client_key = 'rollback-key'
                AND NEW.state = 'completed' THEN
               RAISE EXCEPTION 'injected screen-share completion failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER fail_screen_share_completion
           BEFORE UPDATE ON ${tables.idempotency}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_screen_share_completion()`,
      );
      try {
        await assert.rejects(
          command(
            actors.alice,
            request("session-rollback", "set", "rollback-key"),
          ),
          /injected screen-share completion failure/,
        );
        const stored = await harness.pool.query(
          `SELECT active_screen_share_owner_user_id FROM ${tables.sessions}
            WHERE tenant_id = 'tenant-a' AND id = 'session-rollback'`,
        );
        assert.equal(stored.rows[0].active_screen_share_owner_user_id, null);
        assert.deepEqual(await effectCounts("session-rollback"), { outbox: 0, idempotency: 0 });
      } finally {
        await harness.pool.query(
          `DROP TRIGGER fail_screen_share_completion ON ${tables.idempotency}`,
        );
        await harness.pool.query(
          `DROP FUNCTION ${schema}.fail_screen_share_completion()`,
        );
      }
    });

    await t.test("leave clears actor ownership and publishes the next canonical state in order", async () => {
      const shared = await command(
        actors.alice,
        request("session-leave", "set", "leave-share"),
      );
      assert.equal(shared.state.screenShareOwnerUserId, actors.alice.userId);
      const left = await leaveHuddle({
        database: harness.pool,
        schema: harness.schema,
        permissions,
        actor: actors.alice,
        input: {
          operation: "leave_huddle",
          huddleSessionId: "session-leave",
          idempotencyKey: "leave-after-share",
        },
        createId: () => `leave-event-${++eventSequence}`,
      });
      assert.equal(left.state.screenShareOwnerUserId, null);
      assert.equal(
        left.state.participants.find(({ userId }) => userId === actors.alice.userId).status,
        "left",
      );

      const events = await harness.pool.query(
        `SELECT type, payload
           FROM ${tables.outbox}
          WHERE tenant_id = 'tenant-a'
            AND payload -> 'state' ->> 'huddleSessionId' = 'session-leave'
          ORDER BY replay_position`,
      );
      assert.deepEqual(events.rows.map(({ type, payload }) => ({
        type,
        owner: payload.state.screenShareOwnerUserId,
        actorStatus: payload.state.participants.find(
          ({ userId }) => userId === actors.alice.userId,
        ).status,
        reason: payload.reason ?? null,
      })), [
        {
          type: HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
          owner: actors.alice.userId,
          actorStatus: "joined",
          reason: null,
        },
        {
          type: LEAVE_HUDDLE_OUTBOX_EVENT_TYPE,
          owner: null,
          actorStatus: "left",
          reason: HUDDLE_LEAVE_REASONS.explicit,
        },
      ]);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
