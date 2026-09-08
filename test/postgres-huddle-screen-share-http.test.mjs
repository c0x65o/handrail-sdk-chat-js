import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { parseHuddleCommandResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
  CHAT_HUDDLE_SCREEN_SHARE_DISABLED_CODE,
  HUDDLE_SCREEN_SHARE_CAPABILITY,
  HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
  HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
  HUDDLE_SCREEN_SHARE_ROUTE,
  MAX_HUDDLE_SCREEN_SHARE_RESPONSE_BYTES,
  createChatServer,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actors = Object.freeze({
  alice: Object.freeze({
    credential: "ALICE_AUTH_SECRET_SENTINEL",
    actor: Object.freeze({
      tenantId: "tenant-a",
      userId: "alice",
      roles: Object.freeze(["ALICE_TRUSTED_ROLE_SECRET_SENTINEL"]),
    }),
    capabilities: Object.freeze([HUDDLE_SCREEN_SHARE_CAPABILITY]),
  }),
  bob: Object.freeze({
    credential: "BOB_AUTH_SECRET_SENTINEL",
    actor: Object.freeze({
      tenantId: "tenant-a",
      userId: "bob",
      roles: Object.freeze(["BOB_TRUSTED_ROLE_SECRET_SENTINEL"]),
    }),
    capabilities: Object.freeze([HUDDLE_SCREEN_SHARE_CAPABILITY]),
  }),
  noCapability: Object.freeze({
    credential: "NO_CAPABILITY_AUTH_SECRET_SENTINEL",
    actor: Object.freeze({
      tenantId: "tenant-a",
      userId: "no-capability",
      roles: Object.freeze(["NO_CAPABILITY_ROLE_SECRET_SENTINEL"]),
    }),
    capabilities: Object.freeze([]),
  }),
});

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const screenSharePath = (huddleSessionId) =>
  HUDDLE_SCREEN_SHARE_ROUTE.replace(
    ":huddleSessionId",
    encodeURIComponent(huddleSessionId),
  );

const screenShareInput = (
  huddleSessionId,
  intent,
  idempotencyKey,
  overrides = {},
) => ({
  operation: "set_huddle_screen_share",
  huddleSessionId,
  intent,
  idempotencyKey,
  ...overrides,
});

const requestScreenShare = (
  endpoint,
  actor,
  huddleSessionId,
  input,
  options = {},
) =>
  fetch(
    `${endpoint}${screenSharePath(huddleSessionId)}${options.query ?? ""}`,
    {
      method: "PATCH",
      headers: {
        authorization:
          options.authorization ?? `Bearer ${actor.credential}`,
        "content-type": options.contentType ?? "application/json",
        ...(options.omitIdempotencyKey
          ? {}
          : {
              "idempotency-key":
                options.idempotencyKey ?? input?.idempotencyKey,
            }),
      },
      body: options.body ?? JSON.stringify(input),
    },
  );

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

const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

const assertSafeHeaders = (response) => {
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
};

const REDACTED_SENTINELS = Object.freeze([
  "AUTH_SECRET_SENTINEL",
  "TRUSTED_ROLE_SECRET_SENTINEL",
  "FORGED_ACTOR_SECRET_SENTINEL",
  "FORGED_TENANT_SECRET_SENTINEL",
  "PROVIDER_ROOM_SECRET_SENTINEL",
  "PROVIDER_TOKEN_SECRET_SENTINEL",
  "DATABASE_SECRET_SENTINEL",
  "ENTITY_SECRET_SENTINEL",
  "tenant-a",
]);

const assertRedacted = (text) => {
  for (const sentinel of REDACTED_SENTINELS) {
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

const requestHash = ({ operation, huddleSessionId, intent }) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({ operation, huddleSessionId, intent }))
    .digest("hex")}`;

test("huddle screen-share HTTP route applies exclusive canonical ownership and redacts failures", async () => {
  const backend = await createPostgresTestBackend();

  const harness = await createChatTestHarness({
    backend,
    schemaPrefix: "chat_screen_share_http",
    actors: Object.values(actors),
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
  const extraRuntimes = [];
  const extraServers = [];

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    sessionId,
    participantUserIds = [actors.alice.actor.userId],
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
      [
        tenantId,
        sessionId,
        conversationId,
        `PROVIDER_ROOM_SECRET_SENTINEL-${tenantId}-${sessionId}`,
      ],
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
    } else {
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

  const durableState = async (sessionId, tenantId = "tenant-a") => {
    const result = await harness.pool.query(
      `SELECT active_screen_share_owner_user_id AS owner
         FROM ${tables.sessions}
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, sessionId],
    );
    return result.rows[0]?.owner ?? null;
  };

  const effectCounts = async (sessionId, keys = []) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE type = $2
             AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE operation_name = $3
             AND client_key = ANY($4::text[])) AS idempotency`,
      [
        sessionId,
        HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
        HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
        keys,
      ],
    );
    return result.rows[0];
  };

  try {
    for (const seed of [
      { conversationId: "conversation-lifecycle", sessionId: "session-lifecycle" },
      {
        conversationId: "conversation-race",
        sessionId: "session-race",
        participantUserIds: [actors.alice.actor.userId, actors.bob.actor.userId],
      },
      {
        conversationId: "conversation-owned-by-bob",
        sessionId: "session-owned-by-bob",
        participantUserIds: [actors.alice.actor.userId, actors.bob.actor.userId],
        ownerUserId: actors.bob.actor.userId,
      },
      { conversationId: "conversation-no-owner", sessionId: "session-no-owner" },
      {
        conversationId: "conversation-nonparticipant",
        sessionId: "session-nonparticipant",
        participantUserIds: [actors.bob.actor.userId],
        memberUserIds: [actors.alice.actor.userId, actors.bob.actor.userId],
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
      { conversationId: "conversation-disabled", sessionId: "session-disabled" },
      {
        conversationId: "conversation-no-capability",
        sessionId: "session-no-capability",
        participantUserIds: [actors.noCapability.actor.userId],
      },
      {
        conversationId: "conversation-entity-denied",
        sessionId: "session-entity-denied",
        entity: { type: "invoice", id: "ENTITY_SECRET_SENTINEL" },
      },
      { conversationId: "conversation-in-progress", sessionId: "session-in-progress" },
    ]) {
      await seedSession(seed);
    }

    await t.test("starts, replays, and stops with canonical participant state", async () => {
      const setInput = screenShareInput(
        "session-lifecycle",
        "set",
        "screen-share-lifecycle-set",
      );
      const first = await requestScreenShare(
        harness.endpoint,
        actors.alice,
        "session-lifecycle",
        setInput,
      );
      assert.equal(first.status, 200);
      assertSafeHeaders(first);
      const firstText = await first.text();
      assert.ok(
        Buffer.byteLength(firstText) <=
          MAX_HUDDLE_SCREEN_SHARE_RESPONSE_BYTES,
      );
      assertRedacted(firstText);
      const applied = parseHuddleCommandResult(JSON.parse(firstText), setInput);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.state.status, "active");
      assert.equal(applied.state.screenShareOwnerUserId, "alice");
      assert.deepEqual(
        applied.state.participants.map(({ userId, status }) => ({ userId, status })),
        [{ userId: "alice", status: "joined" }],
      );

      const retry = await requestScreenShare(
        harness.endpoint,
        actors.alice,
        "session-lifecycle",
        setInput,
      );
      assert.equal(retry.status, 200);
      const replayed = parseHuddleCommandResult(await retry.json(), setInput);
      assert.equal(replayed.reconciliationStatus, "replayed");
      assert.deepEqual(replayed.state, applied.state);
      assert.deepEqual(
        await effectCounts("session-lifecycle", [setInput.idempotencyKey]),
        { outbox: 1, idempotency: 1 },
      );

      const clearInput = screenShareInput(
        "session-lifecycle",
        "clear",
        "screen-share-lifecycle-clear",
      );
      const clearedResponse = await requestScreenShare(
        harness.endpoint,
        actors.alice,
        "session-lifecycle",
        clearInput,
      );
      assert.equal(clearedResponse.status, 200);
      const cleared = parseHuddleCommandResult(
        await clearedResponse.json(),
        clearInput,
      );
      assert.equal(cleared.reconciliationStatus, "applied");
      assert.equal(cleared.state.screenShareOwnerUserId, null);
      assert.deepEqual(cleared.state.participants, applied.state.participants);
      assert.equal(await durableState("session-lifecycle"), null);
      assert.deepEqual(
        await effectCounts("session-lifecycle", [
          setInput.idempotencyKey,
          clearInput.idempotencyKey,
        ]),
        { outbox: 2, idempotency: 2 },
      );
    });

    await t.test("serializes concurrent owners with one winner and one conflict", async () => {
      const responses = await Promise.all([
        requestScreenShare(
          harness.endpoint,
          actors.alice,
          "session-race",
          screenShareInput("session-race", "set", "race-alice"),
        ),
        requestScreenShare(
          harness.endpoint,
          actors.bob,
          "session-race",
          screenShareInput("session-race", "set", "race-bob"),
        ),
      ]);
      assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
      const winnerResponse = responses.find(({ status }) => status === 200);
      const loserResponse = responses.find(({ status }) => status === 409);
      assert.notEqual(winnerResponse, undefined);
      assert.notEqual(loserResponse, undefined);
      const winner = await winnerResponse.json();
      assert.equal(
        await durableState("session-race"),
        winner.state.screenShareOwnerUserId,
      );
      await assertStableError(
        loserResponse,
        409,
        CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
        "Huddle screen-share request conflicts with current server state",
      );
      assert.deepEqual(
        await effectCounts("session-race", ["race-alice", "race-bob"]),
        { outbox: 1, idempotency: 1 },
      );
    });

    await t.test("redacts authorization and lifecycle denials without effects", async () => {
      const cases = [
        {
          actor: actors.alice,
          sessionId: "session-nonparticipant",
          key: "reject-nonparticipant",
          status: 403,
          code: CHAT_AUTHORIZATION_ERROR_CODE,
          message: "Chat authorization failed",
        },
        {
          actor: actors.alice,
          sessionId: "session-cross-tenant",
          key: "reject-cross-tenant",
          status: 403,
          code: CHAT_AUTHORIZATION_ERROR_CODE,
          message: "Chat authorization failed",
        },
        {
          actor: actors.alice,
          sessionId: "missing-session",
          key: "reject-missing",
          status: 403,
          code: CHAT_AUTHORIZATION_ERROR_CODE,
          message: "Chat authorization failed",
        },
        {
          actor: actors.alice,
          sessionId: "session-ended",
          key: "reject-ended",
          status: 409,
          code: CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
          message: "Huddle screen-share request conflicts with current server state",
        },
        {
          actor: actors.noCapability,
          sessionId: "session-no-capability",
          key: "reject-capability",
          status: 403,
          code: CHAT_AUTHORIZATION_ERROR_CODE,
          message: "Chat authorization failed",
        },
      ];
      for (const item of cases) {
        const response = await requestScreenShare(
          harness.endpoint,
          item.actor,
          item.sessionId,
          screenShareInput(item.sessionId, "set", item.key),
        );
        await assertStableError(
          response,
          item.status,
          item.code,
          item.message,
        );
        assert.deepEqual(await effectCounts(item.sessionId, [item.key]), {
          outbox: 0,
          idempotency: 0,
        });
      }

      await assertStableError(
        await requestScreenShare(
          harness.endpoint,
          actors.alice,
          "session-no-owner",
          screenShareInput(
            "session-no-owner",
            "set",
            "reject-authentication",
          ),
          { authorization: "Bearer UNKNOWN_AUTH_SECRET_SENTINEL" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );
      assert.deepEqual(
        await effectCounts("session-no-owner", ["reject-authentication"]),
        { outbox: 0, idempotency: 0 },
      );

      harness.setEntityAuthorization(false);
      await assertStableError(
        await requestScreenShare(
          harness.endpoint,
          actors.alice,
          "session-entity-denied",
          screenShareInput(
            "session-entity-denied",
            "set",
            "reject-entity",
          ),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      harness.setEntityAuthorization(true);
      assert.equal(await durableState("session-entity-denied"), null);
      assert.deepEqual(
        await effectCounts("session-entity-denied", ["reject-entity"]),
        { outbox: 0, idempotency: 0 },
      );
    });

    await t.test("maps ownership, inactive-share, and idempotency conflicts safely", async () => {
      for (const [sessionId, intent, key] of [
        ["session-owned-by-bob", "set", "reject-owned-set"],
        ["session-owned-by-bob", "clear", "reject-owned-clear"],
        ["session-no-owner", "clear", "reject-no-active-share"],
      ]) {
        await assertStableError(
          await requestScreenShare(
            harness.endpoint,
            actors.alice,
            sessionId,
            screenShareInput(sessionId, intent, key),
          ),
          409,
          CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
          "Huddle screen-share request conflicts with current server state",
        );
        assert.deepEqual(await effectCounts(sessionId, [key]), {
          outbox: 0,
          idempotency: 0,
        });
      }
      assert.equal(await durableState("session-owned-by-bob"), "bob");
      assert.equal(await durableState("session-no-owner"), null);

      const completedKey = "screen-share-lifecycle-set";
      await assertStableError(
        await requestScreenShare(
          harness.endpoint,
          actors.alice,
          "session-lifecycle",
          screenShareInput("session-lifecycle", "clear", completedKey),
        ),
        409,
        CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
        "Huddle screen-share request conflicts with current server state",
      );

      const pendingInput = screenShareInput(
        "session-in-progress",
        "set",
        "screen-share-in-progress",
      );
      await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           expires_at
         ) VALUES ('tenant-a', 'alice', $1, $2, $3,
                   clock_timestamp() + interval '1 hour')`,
        [
          HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
          pendingInput.idempotencyKey,
          requestHash(pendingInput),
        ],
      );
      await assertStableError(
        await requestScreenShare(
          harness.endpoint,
          actors.alice,
          "session-in-progress",
          pendingInput,
        ),
        409,
        CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
        "Huddle screen-share request conflicts with current server state",
      );
      const pending = await harness.pool.query(
        `SELECT state FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND user_id = 'alice'
            AND operation_name = $1 AND client_key = $2`,
        [HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION, pendingInput.idempotencyKey],
      );
      assert.deepEqual(pending.rows, [{ state: "pending" }]);
      assert.equal(await durableState("session-in-progress"), null);
      assert.deepEqual(
        await effectCounts("session-in-progress", [pendingInput.idempotencyKey]),
        { outbox: 0, idempotency: 1 },
      );
    });

    await t.test("keeps disabled sharing distinct from transient unavailability", async () => {
      const disabledRuntime = createChatServer({
        database: { pool: harness.pool, schema: harness.schema },
        ...harness.adapters,
        features: { media: false },
        outbox: { pollIntervalMs: 60_000 },
      });
      extraRuntimes.push(disabledRuntime);
      const disabledServer = createServer(disabledRuntime.router);
      extraServers.push(disabledServer);
      const disabledEndpoint = await listen(disabledServer);
      const key = "screen-share-disabled";
      await assertStableError(
        await requestScreenShare(
          disabledEndpoint,
          actors.alice,
          "session-disabled",
          screenShareInput("session-disabled", "set", key),
        ),
        403,
        CHAT_HUDDLE_SCREEN_SHARE_DISABLED_CODE,
        "Huddle screen sharing is disabled",
      );
      assert.equal(await durableState("session-disabled"), null);
      assert.deepEqual(await effectCounts("session-disabled", [key]), {
        outbox: 0,
        idempotency: 0,
      });
    });
  } finally {
    for (const server of extraServers) {
      await closeServer(server);
    }
    for (const runtime of extraRuntimes) {
      await runtime.close();
    }
    await harness.teardown();
  }
});
