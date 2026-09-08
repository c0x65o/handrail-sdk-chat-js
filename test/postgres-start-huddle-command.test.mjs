import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION, HuddleContractError } from "@handrail/chat";
import {
  START_HUDDLE_CAPABILITY,
  START_HUDDLE_ENTITY_POLICY_ACTION,
  StartHuddleCommandError,
  ChatAuthorizationError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  startHuddle,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const input = (conversationId, suffix, overrides = {}) => ({
  operation: "start_huddle",
  conversationId,
  idempotencyKey: `start-huddle-${suffix}`,
  ...overrides,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

class FakeMediaAdapter {
  constructor() {
    this.created = [];
    this.tokens = [];
    this.terminated = [];
    this.failCreateFor = new Set();
    this.failNextToken = false;
    this.roomSequence = 0;
    this.tokenSequence = 0;
  }

  async createRoom(request) {
    this.created.push(request);
    if (this.failCreateFor.has(request.conversationId)) {
      throw new Error("provider create payload with private diagnostics");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      roomId: `opaque-provider-room-${++this.roomSequence}-${request.conversationId}`,
      ignoredRawProviderPayload: "must-not-be-persisted",
    };
  }

  async createParticipantToken(request) {
    this.tokens.push(request);
    if (this.failNextToken) {
      this.failNextToken = false;
      throw new Error("provider token payload with private diagnostics");
    }
    return {
      token: `secret-participant-token-${++this.tokenSequence}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ignoredRefreshCredential: "must-not-be-persisted",
    };
  }

  async terminateRoom(request) {
    this.terminated.push(request);
  }
}

test("start-huddle reports unavailable media without touching trusted providers or PostgreSQL", async () => {
  const unavailableDatabase = {
    async connect() {
      throw new Error("database must not be called");
    },
    async query() {
      throw new Error("database must not be called");
    },
  };
  const unavailablePermissions = {
    async getCapabilities() {
      throw new Error("permissions must not be called");
    },
    async authorizeEntity() {
      throw new Error("permissions must not be called");
    },
  };
  const request = input("feature-target", "feature-target");

  const disabled = await startHuddle({
    database: unavailableDatabase,
    permissions: unavailablePermissions,
    actor,
    input: request,
    mediaEnabled: false,
  });
  assert.deepEqual(disabled, {
    operation: "start_huddle",
    outcome: "feature_disabled",
    reconciliationStatus: "applied",
    feature: "huddles",
    reason: "media_unavailable",
    state: { status: "inactive", conversationId: "feature-target" },
  });

  assert.deepEqual(
    await startHuddle({
      database: unavailableDatabase,
      permissions: unavailablePermissions,
      actor,
      input: request,
      mediaEnabled: true,
    }),
    disabled,
  );

  await assert.rejects(
    startHuddle({
      database: unavailableDatabase,
      permissions: unavailablePermissions,
      actor,
      input: { ...request, actorUserId: "caller-forgery" },
      mediaEnabled: false,
    }),
    (error) =>
      error instanceof HuddleContractError &&
      error.code === "trusted_context_field",
  );
});

test("trusted start-huddle converges provider and PostgreSQL lifecycle effects", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_start_huddle" });
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
  let capabilities = [START_HUDDLE_CAPABILITY];
  let entityAllowed = true;
  const entityCalls = [];
  const permissions = {
    async getCapabilities() {
      return capabilities;
    },
    async authorizeEntity(request) {
      entityCalls.push(request);
      return entityAllowed;
    },
  };
  let idSequence = 0;
  const command = (request, overrides = {}) =>
    startHuddle({
      database: harness.pool,
      schema: harness.schema,
      permissions,
      actor,
      input: request,
      mediaEnabled: true,
      media,
      createId: () => `start-huddle-id-${++idSequence}`,
      ...overrides,
    });

  const counts = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.sessions}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS sessions,
         (SELECT count(*)::integer FROM ${tables.participants} AS participant
            INNER JOIN ${tables.sessions} AS session
              ON session.tenant_id = participant.tenant_id
             AND session.id = participant.huddle_session_id
           WHERE session.tenant_id = 'tenant-a'
             AND session.conversation_id = $1) AS participants,
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = 'tenant-a' AND target_id = $1
             AND action = 'huddle.started') AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a' AND stream_id = $1
             AND type = 'huddle.updated' AND payload->>'operation' = 'start_huddle') AS outbox`,
      [conversationId],
    );
    return result.rows[0];
  };

  const seedConversation = async ({
    tenantId = "tenant-a",
    conversationId,
    visibility = "private",
    memberUserId = "actor-a",
    memberState = "active",
    archived = false,
    entity,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id,
         archived_at, archived_by_user_id
       ) VALUES ($1, $2, 'channel', $3, $2, $4, $5, $6, $7)`,
      [
        tenantId,
        conversationId,
        visibility,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? "2026-01-01T00:00:00Z" : null,
        archived ? "archiver-a" : null,
      ],
    );
    if (memberUserId !== null) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', $4)`,
        [tenantId, conversationId, memberUserId, memberState],
      );
    }
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    for (const conversationId of [
      "success",
      "concurrent",
      "provider-create-fail",
      "provider-token-fail",
      "commit-reconcile",
      "rollback-audit",
      "rollback-outbox",
      "rollback-idempotency",
      "missing-capability",
      "entity-denied",
      "archived",
    ]) {
      await seedConversation({
        conversationId,
        ...(conversationId === "entity-denied"
          ? { entity: { type: "invoice", id: "invoice-secret" } }
          : {}),
        ...(conversationId === "archived" ? { archived: true } : {}),
      });
    }
    await seedConversation({
      conversationId: "private-inaccessible",
      memberUserId: null,
    });
    await seedConversation({
      conversationId: "public-inaccessible",
      visibility: "public",
      memberUserId: null,
    });
    await seedConversation({
      conversationId: "left-membership",
      memberState: "left",
    });
    await seedConversation({
      tenantId: "tenant-b",
      conversationId: "cross-tenant",
    });

    await harness.pool.query(
      `CREATE FUNCTION ${schema}.reject_test_huddle_audit()
         RETURNS trigger LANGUAGE plpgsql AS $body$
         BEGIN
           IF NEW.target_id = 'rollback-audit' THEN
             RAISE EXCEPTION 'injected audit persistence failure';
           END IF;
           RETURN NEW;
         END;
       $body$;
       CREATE TRIGGER reject_test_huddle_audit
         BEFORE INSERT ON ${tables.audit}
         FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_test_huddle_audit();
       CREATE FUNCTION ${schema}.reject_test_huddle_outbox()
         RETURNS trigger LANGUAGE plpgsql AS $body$
         BEGIN
           IF NEW.stream_id = 'rollback-outbox' THEN
             RAISE EXCEPTION 'injected outbox persistence failure';
           END IF;
           RETURN NEW;
         END;
       $body$;
       CREATE TRIGGER reject_test_huddle_outbox
         BEFORE INSERT ON ${tables.outbox}
         FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_test_huddle_outbox();
       CREATE FUNCTION ${schema}.reject_test_huddle_idempotency()
         RETURNS trigger LANGUAGE plpgsql AS $body$
         BEGIN
           IF NEW.client_key = 'start-huddle-rollback-idempotency' AND
              NEW.state = 'completed' THEN
             RAISE EXCEPTION 'injected idempotency persistence failure';
           END IF;
           RETURN NEW;
         END;
       $body$;
       CREATE TRIGGER reject_test_huddle_idempotency
         BEFORE UPDATE ON ${tables.idempotency}
         FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_test_huddle_idempotency()` ,
    );

    await t.test("persists one sanitized starting state and reissues only ephemeral join material", async () => {
      const request = input("success", "success");
      const result = await command(request);
      assert.equal(result.outcome, "ok");
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.state.status, "starting");
      assert.equal(result.state.conversationId, "success");
      assert.deepEqual(result.state.participants, []);
      assert.equal(result.mediaJoin.kind, "opaque_media_join");
      assert.equal(result.mediaJoin.descriptor, "secret-participant-token-1");
      assert.equal(media.created.length, 1);
      assert.equal(media.tokens.length, 1);
      assert.deepEqual(media.tokens[0].permissions, {
        audio: true,
        video: true,
        screenShare: true,
      });

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.state, result.state);
      assert.equal(replay.mediaJoin.descriptor, "secret-participant-token-2");
      assert.equal(media.created.length, 1);
      assert.equal(media.tokens.length, 2);
      assert.deepEqual(await counts("success"), {
        sessions: 1,
        participants: 0,
        audit: 1,
        outbox: 1,
      });

      const stored = await harness.pool.query(
        `SELECT session.provider_room_reference,
                session.status,
                outcome.state AS idempotency_state,
                outcome.response_body,
                outcome.response_reference,
                audit.metadata AS audit_metadata,
                event.protocol_version::integer AS protocol_version,
                event.payload AS event_payload,
                concat_ws(' ', row_to_json(session)::text,
                  row_to_json(outcome)::text, row_to_json(audit)::text,
                  row_to_json(event)::text)
                  AS all_persisted_text
           FROM ${tables.sessions} AS session
           INNER JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = session.tenant_id
            AND outcome.response_reference = session.id
           INNER JOIN ${tables.audit} AS audit
             ON audit.tenant_id = session.tenant_id
            AND audit.target_id = session.conversation_id
            AND audit.action = 'huddle.started'
           INNER JOIN ${tables.outbox} AS event
             ON event.tenant_id = session.tenant_id
            AND event.stream_id = session.conversation_id
            AND event.type = 'huddle.updated' AND event.payload->>'operation' = 'start_huddle'
          WHERE session.tenant_id = 'tenant-a'
            AND session.conversation_id = 'success'`,
      );
      assert.equal(stored.rows[0].status, "starting");
      assert.equal(stored.rows[0].idempotency_state, "completed");
      assert.equal(stored.rows[0].response_body, null);
      assert.equal(stored.rows[0].response_reference, result.state.huddleSessionId);
      assert.equal(stored.rows[0].protocol_version, CHAT_PROTOCOL_VERSION);
      assert.deepEqual(stored.rows[0].event_payload, {
        operation: "start_huddle",
        state: result.state,
      });
      assert.deepEqual(stored.rows[0].audit_metadata, {
        conversationId: "success",
        huddleSessionId: result.state.huddleSessionId,
        status: "starting",
        startedAt: result.state.startedAt,
        initiatedByUserId: actor.userId,
      });
      for (const forbidden of [
        "secret-participant-token",
        "must-not-be-persisted",
        "ignoredRefreshCredential",
        "private diagnostics",
      ]) {
        assert.equal(stored.rows[0].all_persisted_text.includes(forbidden), false);
      }

      await assert.rejects(
        command(input("concurrent", "success")),
        (error) =>
          error instanceof StartHuddleCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
    });

    await t.test("requires capability, active tenant membership, and inherited entity access", async () => {
      capabilities = [];
      await assert.rejects(
        command(input("missing-capability", "missing-capability")),
        sanitizedAuthorizationFailure,
      );
      capabilities = [START_HUDDLE_CAPABILITY];

      for (const conversationId of [
        "missing-conversation",
        "private-inaccessible",
        "public-inaccessible",
        "left-membership",
        "archived",
        "cross-tenant",
      ]) {
        await assert.rejects(
          command(input(conversationId, `denied-${conversationId}`)),
          sanitizedAuthorizationFailure,
        );
      }

      entityAllowed = false;
      await assert.rejects(
        command(input("entity-denied", "entity-denied")),
        sanitizedAuthorizationFailure,
      );
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "invoice", id: "invoice-secret" },
        action: START_HUDDLE_ENTITY_POLICY_ACTION,
      });
      entityAllowed = true;
      assert.equal(media.created.length, 1);
    });

    await t.test("concurrent starts converge on one session, provider room, and event set", async () => {
      const beforeRooms = media.created.length;
      const [first, second] = await Promise.all([
        command(input("concurrent", "concurrent-a")),
        command(input("concurrent", "concurrent-b")),
      ]);
      assert.equal(first.state.huddleSessionId, second.state.huddleSessionId);
      assert.equal(first.state.status, "starting");
      assert.equal(second.state.status, "starting");
      assert.equal(media.created.length - beforeRooms, 1);
      assert.deepEqual(await counts("concurrent"), {
        sessions: 1,
        participants: 0,
        audit: 1,
        outbox: 1,
      });
      const outcomes = await harness.pool.query(
        `SELECT count(*)::integer AS count
           FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND operation_name = 'huddle.start'
            AND client_key IN ('start-huddle-concurrent-a', 'start-huddle-concurrent-b')
            AND state = 'completed'`,
      );
      assert.equal(outcomes.rows[0].count, 2);
    });

    await t.test("provider room creation failure rolls back without compensation or durable state", async () => {
      media.failCreateFor.add("provider-create-fail");
      const beforeTerminations = media.terminated.length;
      await assert.rejects(
        command(input("provider-create-fail", "provider-create-fail")),
        (error) =>
          error instanceof StartHuddleCommandError &&
          error.code === "media_room_creation_failed" &&
          !error.message.includes("private diagnostics"),
      );
      assert.equal(media.terminated.length, beforeTerminations);
      assert.deepEqual(await counts("provider-create-fail"), {
        sessions: 0,
        participants: 0,
        audit: 0,
        outbox: 0,
      });
      const outcome = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a'
            AND client_key = 'start-huddle-provider-create-fail'`,
      );
      assert.equal(outcome.rows[0].count, 0);
    });

    await t.test("reconciles a durable session before compensating an uncertain commit", async () => {
      const database = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          let injectCommitFailure = true;
          return {
            release: connection.release.bind(connection),
            async query(statement, values) {
              const result = await connection.query(statement, values);
              if (statement === "COMMIT" && injectCommitFailure) {
                injectCommitFailure = false;
                throw new Error("injected response loss after durable commit");
              }
              return result;
            },
          };
        },
      };
      const beforeTerminations = media.terminated.length;
      const result = await command(
        input("commit-reconcile", "commit-reconcile"),
        { database },
      );
      assert.equal(result.outcome, "ok");
      assert.equal(result.state.status, "starting");
      assert.equal(media.terminated.length, beforeTerminations);
      assert.deepEqual(await counts("commit-reconcile"), {
        sessions: 1,
        participants: 0,
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("known persistence rollbacks compensate orphan rooms atomically", async () => {
      for (const suffix of ["rollback-audit", "rollback-outbox", "rollback-idempotency"]) {
        const beforeTerminations = media.terminated.length;
        await assert.rejects(command(input(suffix, suffix)));
        assert.equal(media.terminated.length, beforeTerminations + 1);
        assert.equal(media.terminated.at(-1).actor, actor);
        assert.deepEqual(await counts(suffix), {
          sessions: 0,
          participants: 0,
          audit: 0,
          outbox: 0,
        });
        const outcome = await harness.pool.query(
          `SELECT count(*)::integer AS count FROM ${tables.idempotency}
            WHERE tenant_id = 'tenant-a' AND client_key = $1`,
          [`start-huddle-${suffix}`],
        );
        assert.equal(outcome.rows[0].count, 0);
      }
    });

    await t.test("participant-token failure retains a recoverable starting state without joining", async () => {
      media.failNextToken = true;
      const request = input("provider-token-fail", "provider-token-fail");
      const beforeRooms = media.created.length;
      const beforeTerminations = media.terminated.length;
      await assert.rejects(
        command(request),
        (error) =>
          error instanceof StartHuddleCommandError &&
          error.code === "media_join_unavailable" &&
          !error.message.includes("private diagnostics"),
      );
      assert.equal(media.created.length, beforeRooms + 1);
      assert.equal(media.terminated.length, beforeTerminations);
      assert.deepEqual(await counts("provider-token-fail"), {
        sessions: 1,
        participants: 0,
        audit: 1,
        outbox: 1,
      });

      const recovered = await command(request);
      assert.equal(recovered.outcome, "ok");
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.equal(media.created.length, beforeRooms + 1);
      assert.deepEqual(await counts("provider-token-fail"), {
        sessions: 1,
        participants: 0,
        audit: 1,
        outbox: 1,
      });
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
