import assert from "node:assert/strict";
import test from "node:test";

import { parseHuddleCommandResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_HUDDLE_LEAVE_CONFLICT_CODE,
  LEAVE_HUDDLE_ENTITY_POLICY_ACTION,
  LEAVE_HUDDLE_ROUTE,
  MAX_LEAVE_HUDDLE_RESPONSE_BYTES,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorContext = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["TRUSTED_ROLE_SECRET_SENTINEL"]),
});

const actorRegistration = Object.freeze({
  credential: "AUTH_SECRET_SENTINEL",
  actor: actorContext,
  capabilities: Object.freeze(["huddle.leave"]),
});

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const leavePath = (huddleSessionId) =>
  LEAVE_HUDDLE_ROUTE.replace(
    ":huddleSessionId",
    encodeURIComponent(huddleSessionId),
  );

const leaveInput = (huddleSessionId, idempotencyKey, overrides = {}) => ({
  operation: "leave_huddle",
  huddleSessionId,
  idempotencyKey,
  ...overrides,
});

const requestLeave = (endpoint, huddleSessionId, input, options = {}) =>
  fetch(`${endpoint}${leavePath(huddleSessionId)}${options.query ?? ""}`, {
    method: "POST",
    headers: {
      authorization: options.authorization ??
        `Bearer ${actorRegistration.credential}`,
      "content-type": options.contentType ?? "application/json",
      ...(options.omitIdempotencyKey
        ? {}
        : {
            "idempotency-key":
              options.idempotencyKey ?? input?.idempotencyKey,
          }),
    },
    body: options.body ?? JSON.stringify(input),
  });

const assertSafeHeaders = (response) => {
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
};

const SECRET_SENTINELS = Object.freeze([
  "AUTH_SECRET_SENTINEL",
  "TRUSTED_ROLE_SECRET_SENTINEL",
  "PROVIDER_ROOM_SECRET_SENTINEL",
  "PROVIDER_SECRET_SENTINEL",
  "STORAGE_SECRET_SENTINEL",
  "ENTITY_SECRET_SENTINEL",
  "FORGED_ACTOR_SECRET_SENTINEL",
  "FORGED_TENANT_SECRET_SENTINEL",
  "tenant-a",
]);

const assertRedacted = (text) => {
  for (const sentinel of SECRET_SENTINELS) {
    assert.equal(text.includes(sentinel), false, `response leaked ${sentinel}`);
  }
};

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assertSafeHeaders(response);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: { code, message } });
  assertRedacted(text);
};

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
};

test("leave-huddle HTTP route leaves canonically and maps safe state conflicts", async (t) => {
  const backend = await createPostgresTestBackend();

  const harness = await createChatTestHarness({
    backend,
    schemaPrefix: "chat_leave_http",
    actors: [actorRegistration],
    initialTime: new Date(),
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

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    huddleSessionId,
    includeActor = true,
    ended = false,
    screenShareOwner = null,
    entity,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4)`,
      [tenantId, conversationId, entity?.type ?? null, entity?.id ?? null],
    );
    for (const userId of ["starter-user", ...(includeActor ? [actorContext.userId] : [])]) {
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
      [
        tenantId,
        huddleSessionId,
        conversationId,
        `PROVIDER_ROOM_SECRET_SENTINEL_${tenantId}_${huddleSessionId}`,
      ],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.participants}
         (tenant_id, huddle_session_id, user_id)
       VALUES ($1, $2, 'starter-user')`,
      [tenantId, huddleSessionId],
    );
    if (includeActor) {
      await harness.pool.query(
        `INSERT INTO ${tables.participants}
           (tenant_id, huddle_session_id, user_id)
         VALUES ($1, $2, $3)`,
        [tenantId, huddleSessionId, actorContext.userId],
      );
    }
    await harness.pool.query(
      `UPDATE ${tables.sessions}
          SET status = 'active', activated_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, huddleSessionId],
    );
    if (screenShareOwner !== null) {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET active_screen_share_owner_user_id = $1,
                updated_at = clock_timestamp()
          WHERE tenant_id = $2 AND id = $3`,
        [screenShareOwner, tenantId, huddleSessionId],
      );
    }
    if (ended) {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ending', ended_by_user_id = 'starter-user',
                active_screen_share_owner_user_id = NULL,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, huddleSessionId],
      );
      await harness.pool.query(
        `UPDATE ${tables.participants}
            SET left_at = clock_timestamp(), leave_reason = 'huddle_ended'
          WHERE tenant_id = $1 AND huddle_session_id = $2 AND left_at IS NULL`,
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
  };

  try {
    await seedSession({
      conversationId: "conversation-success",
      huddleSessionId: "session-success",
      screenShareOwner: actorContext.userId,
      entity: { type: "invoice", id: "invoice-allowed" },
    });
    await seedSession({
      conversationId: "conversation-conflict",
      huddleSessionId: "session-conflict",
    });
    await seedSession({
      conversationId: "conversation-ended",
      huddleSessionId: "session-ended",
      ended: true,
    });
    await seedSession({
      conversationId: "conversation-nonparticipant",
      huddleSessionId: "session-nonparticipant",
      includeActor: false,
    });
    await seedSession({
      tenantId: "tenant-b",
      conversationId: "conversation-cross-tenant",
      huddleSessionId: "session-cross-tenant",
    });
    await seedSession({
      conversationId: "conversation-entity-denied",
      huddleSessionId: "session-entity-denied",
      entity: { type: "invoice", id: "ENTITY_SECRET_SENTINEL" },
    });

    await t.test("leaves once, replays, and returns canonical participant/share cleanup", async () => {
      harness.calls.reset();
      const input = leaveInput("session-success", "leave-http-success");
      const response = await requestLeave(
        harness.endpoint,
        input.huddleSessionId,
        input,
      );
      assert.equal(response.status, 200);
      assertSafeHeaders(response);
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) <= MAX_LEAVE_HUDDLE_RESPONSE_BYTES);
      assertRedacted(text);
      const applied = parseHuddleCommandResult(JSON.parse(text), input);
      assert.deepEqual(Object.keys(applied).sort(), [
        "operation",
        "outcome",
        "reconciliationStatus",
        "state",
      ]);
      assert.equal(applied.operation, "leave_huddle");
      assert.equal(applied.outcome, "ok");
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.state.status, "active");
      assert.equal(applied.state.huddleSessionId, "session-success");
      assert.equal(applied.state.screenShareOwnerUserId, null);
      const actor = applied.state.participants.find(
        ({ userId }) => userId === actorContext.userId,
      );
      assert.equal(actor.status, "left");
      assert.equal(typeof actor.leftAt, "string");
      assert.equal(
        applied.state.participants.find(({ userId }) => userId === "starter-user").status,
        "joined",
      );
      assert.deepEqual(
        harness.calls.all("permissions.authorizeEntity").at(-1)?.input,
        {
          actor: actorContext,
          entity: { type: "invoice", id: "invoice-allowed" },
          action: LEAVE_HUDDLE_ENTITY_POLICY_ACTION,
        },
      );

      const replayResponse = await requestLeave(
        harness.endpoint,
        input.huddleSessionId,
        input,
      );
      assert.equal(replayResponse.status, 200);
      assertSafeHeaders(replayResponse);
      const replay = parseHuddleCommandResult(
        await replayResponse.json(),
        input,
      );
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.state, applied.state);

      const durable = await harness.pool.query(
        `SELECT participant.leave_reason,
                session.active_screen_share_owner_user_id AS owner,
                (SELECT count(*)::integer FROM ${tables.outbox}
                  WHERE tenant_id = 'tenant-a'
                    AND type = 'huddle.updated' AND payload->>'operation' = 'leave_huddle'
                    AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox,
                (SELECT count(*)::integer FROM ${tables.idempotency}
                  WHERE tenant_id = 'tenant-a'
                    AND operation_name = 'huddle.leave'
                    AND state = 'completed'
                    AND response_body -> 'state' ->> 'huddleSessionId' = $1) AS idempotency
           FROM ${tables.participants} AS participant
           INNER JOIN ${tables.sessions} AS session
             ON session.tenant_id = participant.tenant_id
            AND session.id = participant.huddle_session_id
          WHERE participant.tenant_id = 'tenant-a'
            AND participant.huddle_session_id = $1
            AND participant.user_id = $2`,
        [input.huddleSessionId, actorContext.userId],
      );
      assert.deepEqual(durable.rows[0], {
        leave_reason: "explicit_leave",
        owner: null,
        outbox: 1,
        idempotency: 1,
      });
    });

    await t.test("maps repeated leave, ended state, and conflicting key reuse to one safe conflict", async () => {
      const first = leaveInput("session-conflict", "leave-http-conflict-a");
      assert.equal(
        (await requestLeave(harness.endpoint, first.huddleSessionId, first)).status,
        200,
      );
      await assertStableError(
        await requestLeave(
          harness.endpoint,
          first.huddleSessionId,
          leaveInput(first.huddleSessionId, "leave-http-conflict-b"),
        ),
        409,
        CHAT_HUDDLE_LEAVE_CONFLICT_CODE,
        "Huddle leave conflicts with current server state",
      );
      await assertStableError(
        await requestLeave(
          harness.endpoint,
          "session-ended",
          leaveInput("session-ended", "leave-http-ended"),
        ),
        409,
        CHAT_HUDDLE_LEAVE_CONFLICT_CODE,
        "Huddle leave conflicts with current server state",
      );
      await assertStableError(
        await requestLeave(
          harness.endpoint,
          "session-ended",
          leaveInput("session-ended", first.idempotencyKey),
        ),
        409,
        CHAT_HUDDLE_LEAVE_CONFLICT_CODE,
        "Huddle leave conflicts with current server state",
      );
    });

    await t.test("does not disclose nonparticipant, cross-tenant, entity-denied, or authentication details", async () => {
      for (const sessionId of ["session-nonparticipant", "session-cross-tenant"]) {
        await assertStableError(
          await requestLeave(
            harness.endpoint,
            sessionId,
            leaveInput(sessionId, `leave-http-${sessionId}`),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
      }

      harness.setEntityAuthorization(false);
      await assertStableError(
        await requestLeave(
          harness.endpoint,
          "session-entity-denied",
          leaveInput("session-entity-denied", "leave-http-entity-denied"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      harness.setEntityAuthorization(true);

      await assertStableError(
        await requestLeave(
          harness.endpoint,
          "session-success",
          leaveInput("session-success", "leave-http-authentication"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
