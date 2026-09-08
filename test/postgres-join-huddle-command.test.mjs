import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION, HuddleContractError } from "@handrail/chat";
import {
  JOIN_HUDDLE_ENTITY_POLICY_ACTION,
  JOIN_HUDDLE_OUTBOX_EVENT_TYPE,
  JOIN_HUDDLE_PARTICIPANT_PERMISSIONS,
  ChatAuthorizationError,
  JoinHuddleCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  joinHuddle,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const input = (huddleSessionId, suffix, overrides = {}) => ({
  operation: "join_huddle",
  huddleSessionId,
  idempotencyKey: `join-huddle-${suffix}`,
  ...overrides,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

class FakeMediaAdapter {
  constructor(now = () => new Date()) {
    this.now = now;
    this.calls = [];
    this.outcomes = [];
    this.sequence = 0;
  }

  async createRoom() {
    throw new Error("join-huddle must not create rooms");
  }

  async createParticipantToken(request) {
    this.calls.push(request);
    const queued = this.outcomes.shift() ?? "valid";
    const outcome = typeof queued === "function" ? await queued() : queued;
    if (outcome === "throw") {
      throw new Error("PROVIDER_ERROR_SECRET_SENTINEL");
    }
    if (outcome === "expired") {
      return {
        token: "EXPIRED_TOKEN_SECRET_SENTINEL",
        expiresAt: new Date(this.now().valueOf() - 1_000).toISOString(),
        rawProviderSecret: "RAW_PROVIDER_SECRET_SENTINEL",
      };
    }
    if (outcome === "invalid") {
      return {
        token: " ",
        expiresAt: new Date(this.now().valueOf() + 60_000).toISOString(),
        rawProviderSecret: "RAW_PROVIDER_SECRET_SENTINEL",
      };
    }
    return {
      token: `JOIN_TOKEN_SECRET_SENTINEL_${++this.sequence}`,
      expiresAt: new Date(this.now().valueOf() + 60_000).toISOString(),
      rawProviderSecret: "RAW_PROVIDER_SECRET_SENTINEL",
    };
  }

  async terminateRoom() {
    throw new Error("join-huddle must not terminate rooms");
  }
}

test("trusted join-huddle converges durable state and ephemeral provider material", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_join_huddle" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    sessions: `${schema}.chat_huddle_sessions`,
    participants: `${schema}.chat_huddle_participants`,
    idempotency: `${schema}.chat_idempotency_keys`,
    outbox: `${schema}.chat_outbox_events`,
    audit: `${schema}.chat_audit_events`,
  };
  const media = new FakeMediaAdapter();
  let entityAllowed = true;
  const entityCalls = [];
  const permissions = {
    async authorizeEntity(request) {
      entityCalls.push(request);
      return entityAllowed;
    },
  };
  let idSequence = 0;
  const command = (request, overrides = {}) =>
    joinHuddle({
      database: harness.pool,
      schema: harness.schema,
      permissions,
      actor,
      input: request,
      mediaEnabled: true,
      media,
      createId: () => `join-huddle-event-${++idSequence}`,
      ...overrides,
    });

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    huddleSessionId,
    status = "starting",
    actorMembership = "active",
    entity,
    archived = false,
    startedAt = null,
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
    if (actorMembership !== null) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', $4)`,
        [tenantId, conversationId, actor.userId, actorMembership],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.sessions} (
         tenant_id, id, conversation_id, provider_room_reference,
         status, initiated_by_user_id, started_at
       ) VALUES ($1, $2, $3, $4, 'starting', 'starter-user',
                 COALESCE($5::timestamptz, clock_timestamp()))`,
      [
        tenantId,
        huddleSessionId,
        conversationId,
        `opaque-room-${tenantId}-${huddleSessionId}`,
        startedAt,
      ],
    );
    if (status === "active") {
      await harness.pool.query(
        `INSERT INTO ${tables.participants}
           (tenant_id, huddle_session_id, user_id)
         VALUES ($1, $2, 'starter-user')`,
        [tenantId, huddleSessionId],
      );
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'active', activated_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, huddleSessionId],
      );
    } else if (status === "ended") {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ending', ended_by_user_id = 'starter-user',
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, huddleSessionId],
      );
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ended', ended_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, huddleSessionId],
      );
    }
    if (archived) {
      await harness.pool.query(
        `UPDATE ${tables.conversations}
            SET archived_at = clock_timestamp(), archived_by_user_id = 'starter-user'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, conversationId],
      );
    }
  };

  const durableCounts = async (huddleSessionId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.participants}
           WHERE tenant_id = 'tenant-a' AND huddle_session_id = $1) AS participants,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND type = '${JOIN_HUDDLE_OUTBOX_EVENT_TYPE}'
             AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE tenant_id = 'tenant-a' AND operation_name = 'huddle.join'
             AND response_reference = $1 AND state = 'completed') AS idempotency`,
      [huddleSessionId],
    );
    return result.rows[0];
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    for (const scenario of [
      ["initial", "starting", "active", undefined, false],
      ["already-active", "active", "active", undefined, false],
      ["invalid-material", "starting", "active", undefined, false],
      ["expired-material", "starting", "active", undefined, false],
      ["provider-failure", "starting", "active", undefined, false],
      ["concurrent", "starting", "active", undefined, false],
      ["conflict-a", "starting", "active", undefined, false],
      ["conflict-b", "starting", "active", undefined, false],
      ["ended", "ended", "active", undefined, false],
      ["archived", "starting", "active", undefined, true],
      ["left-member", "starting", "left", undefined, false],
      ["nonmember", "starting", null, undefined, false],
      ["entity-denied", "starting", "active", { type: "invoice", id: "invoice-secret" }, false],
      ["feature-disabled", "active", "active", undefined, false],
    ]) {
      const [name, status, actorMembership, entity, archived] = scenario;
      await seedSession({
        conversationId: `conversation-${name}`,
        huddleSessionId: `session-${name}`,
        status,
        actorMembership,
        entity,
        archived,
      });
    }
    await seedSession({
      tenantId: "tenant-b",
      conversationId: "conversation-cross-tenant",
      huddleSessionId: "session-cross-tenant",
    });

    await t.test("joins a starting session once and replays with one fresh descriptor per call", async () => {
      const request = input("session-initial", "initial");
      const beforeCalls = media.calls.length;
      const result = await command(request);
      assert.equal(result.outcome, "ok");
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.state.status, "active");
      assert.equal(result.state.conversationId, "conversation-initial");
      assert.deepEqual(result.state.participants, [
        {
          userId: actor.userId,
          status: "joined",
          joinedAt: result.state.participants[0].joinedAt,
        },
      ]);
      assert.deepEqual(media.calls.at(-1), {
        actor,
        roomId: "opaque-room-tenant-a-session-initial",
        permissions: JOIN_HUDDLE_PARTICIPANT_PERMISSIONS,
      });

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.state, result.state);
      assert.notEqual(replay.mediaJoin.descriptor, result.mediaJoin.descriptor);
      assert.equal(media.calls.length - beforeCalls, 2);
      assert.deepEqual(await durableCounts("session-initial"), {
        participants: 1,
        outbox: 1,
        idempotency: 1,
      });

      const stored = await harness.pool.query(
        `SELECT session.status, session.activated_at,
                participant.user_id, participant.joined_at, participant.left_at,
                outcome.response_body, outcome.response_reference,
                event.protocol_version::integer AS protocol_version,
                event.stream_id, event.payload
           FROM ${tables.sessions} AS session
           INNER JOIN ${tables.participants} AS participant
             ON participant.tenant_id = session.tenant_id
            AND participant.huddle_session_id = session.id
           INNER JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = session.tenant_id
            AND outcome.response_reference = session.id
           INNER JOIN ${tables.outbox} AS event
             ON event.tenant_id = session.tenant_id
            AND event.payload -> 'state' ->> 'huddleSessionId' = session.id
          WHERE session.tenant_id = 'tenant-a' AND session.id = 'session-initial'`,
      );
      assert.equal(stored.rows[0].status, "active");
      assert.ok(stored.rows[0].activated_at instanceof Date);
      assert.equal(stored.rows[0].user_id, actor.userId);
      assert.equal(stored.rows[0].left_at, null);
      assert.equal(stored.rows[0].response_body, null);
      assert.equal(stored.rows[0].response_reference, "session-initial");
      assert.equal(stored.rows[0].protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(stored.rows[0].stream_id, "conversation-initial");
      assert.deepEqual(stored.rows[0].payload, {
        operation: "join_huddle",
        participant: result.state.participants[0],
        state: result.state,
      });
    });

    await t.test("preserves PostgreSQL activation precision within one millisecond across replay", async () => {
      const sessionId = "session-fractional-activation";
      await seedSession({
        conversationId: "conversation-fractional-activation",
        huddleSessionId: sessionId,
        startedAt: "2026-01-01T00:00:00.123456Z",
      });
      const request = input(sessionId, "fractional-activation");
      const beforeCalls = media.calls.length;
      let result;
      // Override only the insert clock boundary in this harness's isolated schema.
      await harness.pool.query(
        `ALTER TABLE ${tables.participants} ALTER COLUMN joined_at
           SET DEFAULT '2026-01-01T00:00:00.123789Z'::timestamptz`,
      );
      try {
        result = await command(request);
      } finally {
        await harness.pool.query(
          `ALTER TABLE ${tables.participants} ALTER COLUMN joined_at
             SET DEFAULT clock_timestamp()`,
        );
      }
      assert.equal(result.outcome, "ok");
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.state.status, "active");

      const assertPrecision = async () => {
        const stored = await harness.pool.query(
          `SELECT session.status,
                  session.started_at = '2026-01-01T00:00:00.123456Z'::timestamptz AS exact_start,
                  participant.joined_at = '2026-01-01T00:00:00.123789Z'::timestamptz AS exact_join,
                  session.activated_at = participant.joined_at AS exact_activation,
                  session.activated_at >= session.started_at AS activation_ordered,
                  session.updated_at >= session.activated_at AS update_ordered
             FROM ${tables.sessions} AS session
             JOIN ${tables.participants} AS participant
               ON participant.tenant_id = session.tenant_id
              AND participant.huddle_session_id = session.id
            WHERE session.tenant_id = $1 AND session.id = $2
              AND participant.user_id = $3`,
          [actor.tenantId, sessionId, actor.userId],
        );
        assert.deepEqual(stored.rows, [{
          status: "active",
          exact_start: true,
          exact_join: true,
          exact_activation: true,
          activation_ordered: true,
          update_ordered: true,
        }]);
      };
      await assertPrecision();
      const counts = await durableCounts(sessionId);
      assert.deepEqual(counts, { participants: 1, outbox: 1, idempotency: 1 });

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.state, result.state);
      assert.notEqual(replay.mediaJoin.descriptor, result.mediaJoin.descriptor);
      assert.equal(media.calls.length - beforeCalls, 2);
      assert.deepEqual(await durableCounts(sessionId), counts);
      await assertPrecision();
    });

    for (const failRenewal of [false, true]) {
      await t.test(failRenewal
        ? "retries a completed fresh renewal key after provider failure without another durable join"
        : "renews with a fresh key without another durable join", async () => {
        const suffix = failRenewal ? "renewal-recovery" : "renewal";
        const sessionId = `session-${suffix}`;
        await seedSession({
          conversationId: `conversation-${suffix}`,
          huddleSessionId: sessionId,
        });
        const now = () => new Date("2026-09-05T12:00:00.000Z");
        const renewalMedia = new FakeMediaAdapter(now);
        const join = (request) => command(request, { media: renewalMedia, now });
        const requestA = input(sessionId, `${suffix}-a`);
        const requestB = input(sessionId, `${suffix}-b`);
        assert.notEqual(requestA.idempotencyKey, requestB.idempotencyKey);

        const initial = await join(requestA);
        assert.equal(initial.outcome, "ok");
        assert.equal(initial.reconciliationStatus, "applied");
        assert.deepEqual(await durableCounts(sessionId), {
          participants: 1, outbox: 1, idempotency: 1,
        });
        const participantRows = async () => {
          // Text casts retain PostgreSQL microseconds that JS Date would truncate.
          const stored = await harness.pool.query(
            `SELECT user_id, joined_at::text, left_at::text
               FROM ${tables.participants}
              WHERE tenant_id = $1 AND huddle_session_id = $2
              ORDER BY user_id`,
            [actor.tenantId, sessionId],
          );
          return stored.rows;
        };
        const beforeParticipants = await participantRows();
        const assertRenewalCompleted = async () => {
          assert.deepEqual(await durableCounts(sessionId), {
            participants: 1, outbox: 1, idempotency: 2,
          });
          assert.deepEqual(await participantRows(), beforeParticipants);
          const stored = await harness.pool.query(
            `SELECT client_key, state, response_reference, response_body
               FROM ${tables.idempotency}
              WHERE tenant_id = $1 AND user_id = $2
                AND operation_name = 'huddle.join'
                AND client_key = ANY($3::text[])
              ORDER BY client_key`,
            [actor.tenantId, actor.userId, [requestA.idempotencyKey, requestB.idempotencyKey]],
          );
          assert.deepEqual(stored.rows, [requestA, requestB].map((request) => ({
            client_key: request.idempotencyKey,
            state: "completed",
            response_reference: sessionId,
            response_body: null,
          })));
        };

        if (failRenewal) {
          let observedCompletion = false;
          renewalMedia.outcomes.push(async () => {
            // A separate pool query observes B's commit before the provider fails.
            await assertRenewalCompleted();
            observedCompletion = true;
            return "throw";
          });
          await assert.rejects(join(requestB), (error) =>
            error instanceof JoinHuddleCommandError &&
            error.code === "media_join_unavailable" && error.statusCode === 503,
          );
          assert.equal(renewalMedia.calls.length, 2);
          assert.equal(observedCompletion, true);
          await assertRenewalCompleted();
        }

        const renewed = await join(requestB);
        assert.equal(renewed.outcome, "ok");
        assert.equal(renewed.reconciliationStatus, "replayed");
        assert.deepEqual(renewed.state, initial.state);
        assert.notEqual(renewed.mediaJoin.descriptor, initial.mediaJoin.descriptor);
        assert.equal(renewalMedia.calls.length, failRenewal ? 3 : 2);
        await assertRenewalCompleted();
      });
    }

    await t.test("joins an already-active session without disturbing existing participants", async () => {
      const result = await command(input("session-already-active", "already-active"));
      assert.equal(result.state.status, "active");
      assert.deepEqual(
        result.state.participants.map(({ userId, status }) => ({ userId, status })),
        [
          { userId: "starter-user", status: "joined" },
          { userId: actor.userId, status: "joined" },
        ],
      );
      assert.deepEqual(await durableCounts("session-already-active"), {
        participants: 2,
        outbox: 1,
        idempotency: 1,
      });
    });

    await t.test("retains one durable join across invalid, expired, and failed descriptor generation", async () => {
      for (const [scenario, providerOutcome] of [
        ["invalid-material", "invalid"],
        ["expired-material", "expired"],
        ["provider-failure", "throw"],
      ]) {
        const request = input(`session-${scenario}`, scenario);
        const beforeCalls = media.calls.length;
        media.outcomes.push(providerOutcome);
        let failure;
        try {
          await command(request);
        } catch (error) {
          failure = error;
        }
        assert.ok(failure instanceof JoinHuddleCommandError);
        assert.equal(failure.code, "media_join_unavailable");
        assert.equal(failure.statusCode, 503);
        for (const secret of [
          "PROVIDER_ERROR_SECRET_SENTINEL",
          "EXPIRED_TOKEN_SECRET_SENTINEL",
          "RAW_PROVIDER_SECRET_SENTINEL",
        ]) {
          assert.equal(`${failure.name}:${failure.message}:${JSON.stringify(failure)}`.includes(secret), false);
        }
        assert.deepEqual(await durableCounts(`session-${scenario}`), {
          participants: 1,
          outbox: 1,
          idempotency: 1,
        });

        const recovered = await command(request);
        assert.equal(recovered.reconciliationStatus, "replayed");
        assert.equal(recovered.state.status, "active");
        assert.equal(media.calls.length - beforeCalls, 2);
        assert.deepEqual(await durableCounts(`session-${scenario}`), {
          participants: 1,
          outbox: 1,
          idempotency: 1,
        });
      }
    });

    await t.test("same-key concurrency produces one transition and one fresh descriptor per caller", async () => {
      const request = input("session-concurrent", "concurrent");
      const beforeCalls = media.calls.length;
      const results = await Promise.all([command(request), command(request)]);
      assert.deepEqual(
        results.map((result) => result.reconciliationStatus).sort(),
        ["applied", "replayed"],
      );
      assert.notEqual(results[0].mediaJoin.descriptor, results[1].mediaJoin.descriptor);
      assert.equal(media.calls.length - beforeCalls, 2);
      assert.deepEqual(await durableCounts("session-concurrent"), {
        participants: 1,
        outbox: 1,
        idempotency: 1,
      });
    });

    await t.test("rejects idempotency conflicts without minting another descriptor", async () => {
      const sharedKey = "shared-conflict-key";
      await command(input("session-conflict-a", "ignored", { idempotencyKey: sharedKey }));
      const beforeCalls = media.calls.length;
      await assert.rejects(
        command(input("session-conflict-b", "ignored", { idempotencyKey: sharedKey })),
        (error) =>
          error instanceof JoinHuddleCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
      assert.equal(media.calls.length, beforeCalls);
      assert.deepEqual(await durableCounts("session-conflict-b"), {
        participants: 0,
        outbox: 0,
        idempotency: 0,
      });
    });

    await t.test("requires a live session, active tenant membership, and entity authorization", async () => {
      for (const sessionId of [
        "session-missing",
        "session-ended",
        "session-archived",
        "session-left-member",
        "session-nonmember",
        "session-cross-tenant",
      ]) {
        await assert.rejects(
          command(input(sessionId, `denied-${sessionId}`)),
          sessionId === "session-ended"
            ? (error) =>
                error instanceof JoinHuddleCommandError &&
                error.code === "huddle_not_live"
            : sanitizedAuthorizationFailure,
        );
      }

      entityAllowed = false;
      await assert.rejects(
        command(input("session-entity-denied", "entity-denied")),
        sanitizedAuthorizationFailure,
      );
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "invoice", id: "invoice-secret" },
        action: JOIN_HUDDLE_ENTITY_POLICY_ACTION,
      });
      entityAllowed = true;
    });

    await t.test("reports disabled media without joining, claiming idempotency, or calling an adapter", async () => {
      const beforeCalls = media.calls.length;
      const result = await command(input("session-feature-disabled", "feature-disabled"), {
        mediaEnabled: false,
      });
      assert.equal(result.outcome, "feature_disabled");
      assert.equal(result.state.status, "active");
      assert.equal(media.calls.length, beforeCalls);
      assert.deepEqual(await durableCounts("session-feature-disabled"), {
        participants: 1,
        outbox: 0,
        idempotency: 0,
      });
    });

    await t.test("rejects caller-forged trusted/provider fields before touching adapters", async () => {
      const beforeCalls = media.calls.length;
      await assert.rejects(
        command({
          ...input("session-initial", "forged"),
          actorUserId: "caller-forgery",
        }),
        (error) =>
          error instanceof HuddleContractError &&
          error.code === "trusted_context_field",
      );
      await assert.rejects(
        command({
          ...input("session-initial", "provider-forged"),
          token: "CALLER_TOKEN_SECRET_SENTINEL",
        }),
        (error) =>
          error instanceof HuddleContractError && error.code === "provider_field",
      );
      assert.equal(media.calls.length, beforeCalls);
    });

    await t.test("does not persist, audit, outbox, serialize, or log token/provider sentinels", async () => {
      const capturedLogs = [];
      const originals = {
        error: console.error,
        warn: console.warn,
        log: console.log,
      };
      console.error = (...values) => capturedLogs.push(values.join(" "));
      console.warn = (...values) => capturedLogs.push(values.join(" "));
      console.log = (...values) => capturedLogs.push(values.join(" "));
      try {
        media.outcomes.push("throw");
        await assert.rejects(
          command(input("session-provider-failure", "provider-failure")),
          (error) =>
            error instanceof JoinHuddleCommandError &&
            error.code === "media_join_unavailable",
        );
      } finally {
        console.error = originals.error;
        console.warn = originals.warn;
        console.log = originals.log;
      }

      const persisted = await harness.pool.query(
        `SELECT concat_ws(' ',
           (SELECT jsonb_agg(row_to_json(session))::text FROM ${tables.sessions} AS session),
           (SELECT jsonb_agg(row_to_json(participant))::text FROM ${tables.participants} AS participant),
           (SELECT jsonb_agg(row_to_json(outcome))::text FROM ${tables.idempotency} AS outcome),
           (SELECT jsonb_agg(row_to_json(event))::text FROM ${tables.outbox} AS event),
           (SELECT jsonb_agg(row_to_json(audit))::text FROM ${tables.audit} AS audit)
         ) AS all_persisted_text`,
      );
      const combined = `${persisted.rows[0].all_persisted_text} ${capturedLogs.join(" ")}`;
      for (const secret of [
        "JOIN_TOKEN_SECRET_SENTINEL",
        "EXPIRED_TOKEN_SECRET_SENTINEL",
        "PROVIDER_ERROR_SECRET_SENTINEL",
        "RAW_PROVIDER_SECRET_SENTINEL",
        "CALLER_TOKEN_SECRET_SENTINEL",
      ]) {
        assert.equal(combined.includes(secret), false, secret);
      }
      const audit = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.audit}
          WHERE action LIKE 'huddle.%'`,
      );
      assert.equal(audit.rows[0].count, 0);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
