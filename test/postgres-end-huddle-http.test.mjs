import assert from "node:assert/strict";
import test from "node:test";

import { parseHuddleCommandResult } from "@handrail/chat";
import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_HUDDLE_END_CONFLICT_CODE,
  CHAT_HUDDLE_END_UNAVAILABLE_CODE,
  END_HUDDLE_MODERATION_CAPABILITY,
  END_HUDDLE_ROUTE,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actors = Object.freeze({
  alice: Object.freeze({
    credential: "end-huddle-alice-token",
    actor: Object.freeze({
      tenantId: "tenant-a",
      userId: "alice",
      roles: Object.freeze(["trusted-host-role"]),
    }),
    capabilities: Object.freeze([]),
  }),
  bob: Object.freeze({
    credential: "end-huddle-bob-token",
    actor: Object.freeze({
      tenantId: "tenant-a",
      userId: "bob",
      roles: Object.freeze(["trusted-host-role"]),
    }),
    capabilities: Object.freeze([END_HUDDLE_MODERATION_CAPABILITY]),
  }),
  charlie: Object.freeze({
    credential: "end-huddle-charlie-token",
    actor: Object.freeze({
      tenantId: "tenant-a",
      userId: "charlie",
      roles: Object.freeze(["trusted-host-role"]),
    }),
    capabilities: Object.freeze([]),
  }),
});

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const endPath = (sessionId) =>
  END_HUDDLE_ROUTE.replace(
    ":huddleSessionId",
    encodeURIComponent(sessionId),
  );

const endInput = (sessionId, idempotencyKey, overrides = {}) => ({
  operation: "end_huddle",
  huddleSessionId: sessionId,
  idempotencyKey,
  ...overrides,
});

const requestEnd = (harness, actor, sessionId, input, options = {}) =>
  fetch(`${harness.endpoint}${endPath(sessionId)}${options.query ?? ""}`, {
    method: "POST",
    headers: {
      authorization: options.authorization ?? `Bearer ${actor.credential}`,
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

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assertSafeHeaders(response);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: { code, message } });
  for (const sensitive of [
    "opaque-provider-room",
    "provider-secret-token",
    "provider-access-token",
    "end-huddle-alice-token",
    "trusted-host-role",
    "tenant-a",
    "tenant-b",
  ]) {
    assert.equal(text.includes(sensitive), false);
  }
};

test("end-huddle HTTP route authorizes, replays, recovers, and persists canonical redacted state", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await createChatTestHarness({
    backend,
    schemaPrefix: "chat_end_huddle_http",
    actors: Object.values(actors),
    initialTime: new Date(),
  });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const sessions = `${schema}.chat_huddle_sessions`;
  const participants = `${schema}.chat_huddle_participants`;

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    sessionId,
    initiator = "alice",
    participantUserIds = ["alice", "bob", "charlie"],
    screenShareOwner = null,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES ($1, $2, 'channel', 'private', $2)`,
      [tenantId, conversationId],
    );
    for (const userId of participantUserIds) {
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', 'active')`,
        [tenantId, conversationId, userId],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${sessions} (
         tenant_id, id, conversation_id, provider_room_reference,
         status, initiated_by_user_id
       ) VALUES ($1, $2, $3, $4, 'starting', $5)`,
      [
        tenantId,
        sessionId,
        conversationId,
        `opaque-provider-room-${sessionId}`,
        initiator,
      ],
    );
    for (const userId of participantUserIds) {
      await harness.pool.query(
        `INSERT INTO ${participants}
           (tenant_id, huddle_session_id, user_id)
         VALUES ($1, $2, $3)`,
        [tenantId, sessionId, userId],
      );
    }
    await harness.pool.query(
      `UPDATE ${sessions}
          SET status = 'active', activated_at = clock_timestamp(),
              active_screen_share_owner_user_id = $1,
              updated_at = clock_timestamp()
        WHERE tenant_id = $2 AND id = $3`,
      [screenShareOwner, tenantId, sessionId],
    );
  };

  try {
    await seedSession({
      conversationId: "conversation-initiator",
      sessionId: "session-initiator",
      screenShareOwner: "bob",
    });
    await seedSession({
      conversationId: "conversation-moderator",
      sessionId: "session-moderator",
    });
    await seedSession({
      conversationId: "conversation-denied",
      sessionId: "session-denied",
    });
    await seedSession({
      tenantId: "tenant-b",
      conversationId: "conversation-cross-tenant",
      sessionId: "session-cross-tenant",
      initiator: "mallory",
      participantUserIds: ["mallory"],
    });
    await seedSession({
      conversationId: "conversation-recovery",
      sessionId: "session-recovery",
    });
    await seedSession({
      conversationId: "conversation-key-conflict",
      sessionId: "session-key-conflict",
    });

    const initiatorInput = endInput("session-initiator", "end-http-initiator");
    const success = await requestEnd(
      harness,
      actors.alice,
      "session-initiator",
      initiatorInput,
    );
    assert.equal(success.status, 200);
    assertSafeHeaders(success);
    const successText = await success.text();
    for (const sensitive of [
      "opaque-provider-room",
      "providerRoomReference",
      "roomId",
      "tenantId",
    ]) {
      assert.equal(successText.includes(sensitive), false);
    }
    const successResult = JSON.parse(successText);
    assert.deepEqual(
      parseHuddleCommandResult(successResult, initiatorInput),
      successResult,
    );
    assert.equal(successResult.operation, "end_huddle");
    assert.equal(successResult.outcome, "ok");
    assert.equal(successResult.reconciliationStatus, "applied");
    assert.equal(successResult.state.status, "ended");
    assert.equal(successResult.state.endedByUserId, "alice");
    assert.equal(successResult.state.screenShareOwnerUserId, null);
    assert.ok(
      successResult.state.participants.every(
        (participant) => participant.status === "left",
      ),
    );

    const replay = await requestEnd(
      harness,
      actors.alice,
      "session-initiator",
      initiatorInput,
    );
    assert.equal(replay.status, 200);
    const replayResult = await replay.json();
    assert.deepEqual(replayResult, {
      ...successResult,
      reconciliationStatus: "replayed",
    });
    assert.equal(harness.calls.count("media.terminateRoom"), 1);

    await assertStableError(
      await requestEnd(
        harness,
        actors.alice,
        "session-initiator",
        endInput("session-initiator", "end-http-already-final"),
      ),
      409,
      CHAT_HUDDLE_END_CONFLICT_CODE,
      "Huddle end conflicts with current server state",
    );

    const moderated = await requestEnd(
      harness,
      actors.bob,
      "session-moderator",
      endInput("session-moderator", "end-http-moderator"),
    );
    assert.equal(moderated.status, 200);
    assert.equal((await moderated.json()).state.endedByUserId, "bob");

    await assertStableError(
      await requestEnd(
        harness,
        actors.charlie,
        "session-denied",
        endInput("session-denied", "end-http-denied"),
      ),
      403,
      CHAT_AUTHORIZATION_ERROR_CODE,
      "Chat authorization failed",
    );

    await assertStableError(
      await requestEnd(
        harness,
        actors.alice,
        "session-cross-tenant",
        endInput("session-cross-tenant", "end-http-cross-tenant"),
      ),
      403,
      CHAT_AUTHORIZATION_ERROR_CODE,
      "Chat authorization failed",
    );

    harness.failures.failNext(
      "media.terminateRoom",
      new Error("provider timeout secret=provider-secret-token"),
    );
    const recoveryInput = endInput("session-recovery", "end-http-recovery");
    await assertStableError(
      await requestEnd(
        harness,
        actors.alice,
        "session-recovery",
        recoveryInput,
      ),
      503,
      CHAT_HUDDLE_END_UNAVAILABLE_CODE,
      "Huddle end temporarily unavailable",
    );
    const recovered = await requestEnd(
      harness,
      actors.alice,
      "session-recovery",
      recoveryInput,
    );
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).state.status, "ended");

    await assertStableError(
      await requestEnd(
        harness,
        actors.alice,
        "session-key-conflict",
        endInput("session-key-conflict", "end-http-initiator"),
      ),
      409,
      CHAT_HUDDLE_END_CONFLICT_CODE,
      "Huddle end conflicts with current server state",
    );

    const persisted = await harness.pool.query(
      `SELECT session.status, session.ended_by_user_id,
              session.active_screen_share_owner_user_id,
              count(*) FILTER (WHERE participant.left_at IS NULL)::integer
                AS joined_participants,
              count(*) FILTER (WHERE participant.leave_reason = 'huddle_ended')::integer
                AS ended_participants
         FROM ${sessions} AS session
         INNER JOIN ${participants} AS participant
           ON participant.tenant_id = session.tenant_id
          AND participant.huddle_session_id = session.id
        WHERE session.tenant_id = 'tenant-a' AND session.id = 'session-initiator'
        GROUP BY session.status, session.ended_by_user_id,
                 session.active_screen_share_owner_user_id`,
    );
    assert.deepEqual(persisted.rows[0], {
      status: "ended",
      ended_by_user_id: "alice",
      active_screen_share_owner_user_id: null,
      joined_participants: 0,
      ended_participants: 3,
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
