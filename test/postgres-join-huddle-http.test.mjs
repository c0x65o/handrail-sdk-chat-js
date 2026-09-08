import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { parseHuddleCommandResult } from "@handrail/chat";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_HUDDLE_JOIN_CONFLICT_CODE,
  CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
  CHAT_HUDDLE_JOIN_NOT_LIVE_CODE,
  CHAT_HUDDLE_JOIN_UNAVAILABLE_CODE,
  JOIN_HUDDLE_ROUTE,
  MAX_JOIN_HUDDLE_REQUEST_BYTES,
  MAX_JOIN_HUDDLE_RESPONSE_BYTES,
  createChatServer,
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
  capabilities: Object.freeze(["huddle.join"]),
});

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const joinPath = (huddleSessionId) =>
  JOIN_HUDDLE_ROUTE.replace(
    ":huddleSessionId",
    encodeURIComponent(huddleSessionId),
  );

const joinInput = (huddleSessionId, idempotencyKey, overrides = {}) => ({
  operation: "join_huddle",
  huddleSessionId,
  idempotencyKey,
  ...overrides,
});

const requestJoin = (endpoint, huddleSessionId, input, options = {}) =>
  fetch(`${endpoint}${joinPath(huddleSessionId)}${options.query ?? ""}`, {
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

const rawRequest = (endpoint, path, body, headers) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      `${endpoint}${path}`,
      { method: "POST", headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            headers: new Headers(response.headers),
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    request.on("error", reject);
    if (Array.isArray(body)) {
      for (const chunk of body) {
        request.write(chunk);
      }
      request.end();
    } else {
      request.end(body);
    }
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
  "PROVIDER_THROW_SECRET_SENTINEL",
  "PROVIDER_TOKEN_SECRET_SENTINEL",
  "RAW_PROVIDER_SECRET_SENTINEL",
  "ENTITY_SECRET_SENTINEL",
  "FORGED_ACTOR_SECRET_SENTINEL",
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

const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

test("join-huddle HTTP route validates, authorizes, projects, and redacts", async (t) => {
  const backend = await createPostgresTestBackend();

  const harness = await createChatTestHarness({
    backend,
    schemaPrefix: "chat_join_http",
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
  const customRuntimes = [];

  const seedSession = async ({
    tenantId = "tenant-a",
    conversationId,
    huddleSessionId,
    status = "starting",
    actorMembership = "active",
    entity,
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
        [tenantId, conversationId, actorContext.userId, actorMembership],
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
  };

  const durableCounts = async (huddleSessionId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.participants}
           WHERE tenant_id = 'tenant-a' AND huddle_session_id = $1) AS participants,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND type = 'huddle.updated' AND payload->>'operation' = 'join_huddle'
             AND payload -> 'state' ->> 'huddleSessionId' = $1) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE tenant_id = 'tenant-a' AND operation_name = 'huddle.join'
             AND response_reference = $1 AND state = 'completed') AS idempotency`,
      [huddleSessionId],
    );
    return result.rows[0];
  };

  const openCustomRuntime = async ({
    media,
    mediaEnabled = true,
    middlewareErrors,
  }) => {
    const runtime = createChatServer({
      database: { pool: harness.pool, schema: harness.schema },
      auth: harness.adapters.auth,
      directory: harness.adapters.directory,
      permissions: harness.adapters.permissions,
      ...(media === undefined ? {} : { media }),
      features: { media: mediaEnabled },
      outbox: { pollIntervalMs: 60_000 },
    });
    const listener = middlewareErrors === undefined
      ? runtime.router
      : (request, response) =>
          runtime.router(request, response, (error) => {
            middlewareErrors.push(error);
            response.statusCode = error.statusCode ?? 500;
            response.setHeader("content-type", "application/json; charset=utf-8");
            response.setHeader("cache-control", "private, no-store");
            response.end(JSON.stringify({
              error: { code: error.code, message: error.message },
            }));
          });
    const server = createServer({ joinDuplicateHeaders: true }, listener);
    const endpoint = await listen(server);
    const owned = { runtime, server, endpoint };
    customRuntimes.push(owned);
    return owned;
  };

  const mediaAdapter = (outcome) => ({
    async createRoom() {
      throw new Error("join route must not create rooms");
    },
    async createParticipantToken() {
      if (outcome === "throw") {
        throw new Error("PROVIDER_THROW_SECRET_SENTINEL");
      }
      if (outcome === "invalid") {
        return {
          token: " ",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          rawProviderSecret: "RAW_PROVIDER_SECRET_SENTINEL",
        };
      }
      if (outcome === "expired") {
        return {
          token: "PROVIDER_TOKEN_SECRET_SENTINEL",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          rawProviderSecret: "RAW_PROVIDER_SECRET_SENTINEL",
        };
      }
      return {
        token: `opaque-test-token-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async terminateRoom() {
      throw new Error("join route must not terminate rooms");
    },
  });

  try {
    for (const scenario of [
      "first",
      "conflict-a",
      "conflict-b",
      "already-joined",
      "rejoin",
      "malformed",
      "provider-throw",
      "provider-invalid",
      "provider-expired",
      "middleware-redaction",
    ]) {
      await seedSession({
        conversationId: `conversation-${scenario}`,
        huddleSessionId: `session-${scenario}`,
      });
    }
    await seedSession({
      conversationId: "conversation-ended",
      huddleSessionId: "session-ended",
      status: "ended",
    });
    await seedSession({
      conversationId: "conversation-nonmember",
      huddleSessionId: "session-nonmember",
      actorMembership: null,
    });
    await seedSession({
      conversationId: "conversation-entity-denied",
      huddleSessionId: "session-entity-denied",
      entity: { type: "invoice", id: "ENTITY_SECRET_SENTINEL" },
    });
    await seedSession({
      tenantId: "tenant-b",
      conversationId: "conversation-cross-tenant",
      huddleSessionId: "session-cross-tenant",
    });
    await seedSession({
      conversationId: "conversation-disabled",
      huddleSessionId: "session-disabled",
      status: "active",
    });

    await t.test("joins once and replays with freshly minted opaque material", async () => {
      const input = joinInput("session-first", "join-http-first");
      const firstResponse = await requestJoin(
        harness.endpoint,
        input.huddleSessionId,
        input,
      );
      assert.equal(firstResponse.status, 200);
      assertSafeHeaders(firstResponse);
      const firstText = await firstResponse.text();
      assert.ok(Buffer.byteLength(firstText) <= MAX_JOIN_HUDDLE_RESPONSE_BYTES);
      assertRedacted(firstText);
      const first = JSON.parse(firstText);
      assert.deepEqual(Object.keys(first).sort(), [
        "mediaJoin",
        "operation",
        "outcome",
        "reconciliationStatus",
        "state",
      ]);
      assert.deepEqual(Object.keys(first.mediaJoin).sort(), [
        "descriptor",
        "expiresAt",
        "kind",
      ]);
      assert.deepEqual(
        {
          operation: first.operation,
          outcome: first.outcome,
          reconciliationStatus: first.reconciliationStatus,
          huddleSessionId: first.state.huddleSessionId,
          stateStatus: first.state.status,
          mediaKind: first.mediaJoin.kind,
        },
        {
          operation: "join_huddle",
          outcome: "ok",
          reconciliationStatus: "applied",
          huddleSessionId: "session-first",
          stateStatus: "active",
          mediaKind: "opaque_media_join",
        },
      );

      const replayResponse = await requestJoin(
        harness.endpoint,
        input.huddleSessionId,
        input,
      );
      assert.equal(replayResponse.status, 200);
      assertSafeHeaders(replayResponse);
      const replay = await replayResponse.json();
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.notEqual(replay.mediaJoin.descriptor, first.mediaJoin.descriptor);
      assert.deepEqual(await durableCounts(input.huddleSessionId), {
        participants: 1,
        outbox: 1,
        idempotency: 1,
      });
    });

    await t.test("maps non-live, authorization, tenant, and entity denials", async () => {
      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-ended",
          joinInput("session-ended", "join-http-ended"),
        ),
        409,
        CHAT_HUDDLE_JOIN_NOT_LIVE_CODE,
        "Huddle is not available to join",
      );

      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-nonmember",
          joinInput("session-nonmember", "join-http-nonmember"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-cross-tenant",
          joinInput("session-cross-tenant", "join-http-cross-tenant"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );

      harness.setEntityAuthorization(false);
      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-entity-denied",
          joinInput("session-entity-denied", "join-http-entity-denied"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      harness.setEntityAuthorization(true);

      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-first",
          joinInput("session-first", "join-http-authentication"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );
    });

    await t.test("maps idempotency and already-joined conflicts and allows a new visit after leaving", async (t) => {
      const sharedKey = "join-http-conflict-key";
      assert.equal(
        (await requestJoin(
          harness.endpoint,
          "session-conflict-a",
          joinInput("session-conflict-a", sharedKey),
        )).status,
        200,
      );
      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-conflict-b",
          joinInput("session-conflict-b", sharedKey),
        ),
        409,
        CHAT_HUDDLE_JOIN_CONFLICT_CODE,
        "Huddle join conflicts with current server state",
      );

      assert.equal(
        (await requestJoin(
          harness.endpoint,
          "session-already-joined",
          joinInput("session-already-joined", "join-http-already-a"),
        )).status,
        200,
      );
      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "session-already-joined",
          joinInput("session-already-joined", "join-http-already-b"),
        ),
        409,
        CHAT_HUDDLE_JOIN_CONFLICT_CODE,
        "Huddle join conflicts with current server state",
      );

      assert.equal(
        (await requestJoin(
          harness.endpoint,
          "session-rejoin",
          joinInput("session-rejoin", "join-http-rejoin-a"),
        )).status,
        200,
      );
      await harness.pool.query(
        `UPDATE ${tables.participants}
            SET left_at = clock_timestamp(), leave_reason = 'explicit_leave'
          WHERE tenant_id = 'tenant-a' AND huddle_session_id = 'session-rejoin'
            AND user_id = $1`,
        [actorContext.userId],
      );
      const input = joinInput("session-rejoin", "join-http-rejoin-b");
      const joinedAgain = await requestJoin(harness.endpoint, "session-rejoin", input);
      assert.equal(joinedAgain.status, 200);
      const result = parseHuddleCommandResult(await joinedAgain.json(), input);
      assert.equal(result.state.participants.find((value) => value.userId === actorContext.userId).status, "joined");
      const visits = await harness.pool.query(`SELECT user_id FROM ${schema}.chat_huddle_participant_visits WHERE huddle_session_id = 'session-rejoin'`);
      assert.deepEqual(visits.rows, [{ user_id: actorContext.userId }]);
    });

    await t.test("rejects malformed, spoofed, mismatched, duplicate, and oversized input", async () => {
      const sessionId = "session-malformed";
      const cases = [
        joinInput("other-session", "join-http-body-mismatch"),
        joinInput(sessionId, "join-http-trusted", {
          actorUserId: "FORGED_ACTOR_SECRET_SENTINEL",
        }),
        joinInput(sessionId, "join-http-provider", {
          roomId: "PROVIDER_ROOM_SECRET_SENTINEL",
        }),
      ];
      for (const input of cases) {
        await assertStableError(
          await requestJoin(harness.endpoint, sessionId, input),
          400,
          CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
          "Invalid huddle join request",
        );
      }

      const valid = joinInput(sessionId, "join-http-invalid-cases");
      for (const options of [
        { query: "?provider=forged" },
        { body: "{" },
        { omitIdempotencyKey: true },
        { idempotencyKey: "different-header-key" },
        { contentType: "text/plain" },
      ]) {
        await assertStableError(
          await requestJoin(harness.endpoint, sessionId, valid, options),
          400,
          CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
          "Invalid huddle join request",
        );
      }
      await assertStableError(
        await requestJoin(
          harness.endpoint,
          "bad/id",
          joinInput("bad/id", "join-http-bad-path"),
        ),
        400,
        CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
        "Invalid huddle join request",
      );

      const duplicateBody = JSON.stringify(valid);
      await assertStableError(
        await rawRequest(
          harness.endpoint,
          joinPath(sessionId),
          duplicateBody,
          [
            "host", new URL(harness.endpoint).host,
            "authorization", `Bearer ${actorRegistration.credential}`,
            "content-type", "application/json",
            "content-length", String(Buffer.byteLength(duplicateBody)),
            "idempotency-key", valid.idempotencyKey,
            "idempotency-key", valid.idempotencyKey,
          ],
        ),
        400,
        CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
        "Invalid huddle join request",
      );

      const oversized = joinInput(sessionId, "join-http-oversized", {
        padding: "x".repeat(MAX_JOIN_HUDDLE_REQUEST_BYTES),
      });
      await assertStableError(
        await requestJoin(harness.endpoint, sessionId, oversized),
        400,
        CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
        "Invalid huddle join request",
      );
      assert.deepEqual(await durableCounts(sessionId), {
        participants: 0,
        outbox: 0,
        idempotency: 0,
      });
    });

    await t.test("projects disabled media without joining", async () => {
      const disabled = await openCustomRuntime({ mediaEnabled: false });
      const input = joinInput("session-disabled", "join-http-disabled");
      const response = await requestJoin(
        disabled.endpoint,
        input.huddleSessionId,
        input,
      );
      assert.equal(response.status, 200);
      assertSafeHeaders(response);
      const text = await response.text();
      assertRedacted(text);
      const result = JSON.parse(text);
      assert.deepEqual(Object.keys(result).sort(), [
        "feature",
        "operation",
        "outcome",
        "reason",
        "reconciliationStatus",
        "state",
      ]);
      assert.deepEqual(result, {
        operation: "join_huddle",
        outcome: "feature_disabled",
        reconciliationStatus: "applied",
        feature: "huddles",
        reason: "media_unavailable",
        state: {
          status: "active",
          conversationId: "conversation-disabled",
          huddleSessionId: "session-disabled",
          startedAt: result.state.startedAt,
          participants: [
            {
              userId: "starter-user",
              status: "joined",
              joinedAt: result.state.participants[0].joinedAt,
            },
          ],
          screenShareOwnerUserId: null,
        },
      });
      assert.deepEqual(await durableCounts(input.huddleSessionId), {
        participants: 1,
        outbox: 0,
        idempotency: 0,
      });
    });

    await t.test("sanitizes provider throw, invalid, and expired material", async () => {
      for (const [scenario, outcome] of [
        ["provider-throw", "throw"],
        ["provider-invalid", "invalid"],
        ["provider-expired", "expired"],
      ]) {
        const custom = await openCustomRuntime({
          media: mediaAdapter(outcome),
        });
        const input = joinInput(`session-${scenario}`, `join-http-${scenario}`);
        await assertStableError(
          await requestJoin(custom.endpoint, input.huddleSessionId, input),
          503,
          CHAT_HUDDLE_JOIN_UNAVAILABLE_CODE,
          "Huddle join temporarily unavailable",
        );
        assert.deepEqual(await durableCounts(input.huddleSessionId), {
          participants: 1,
          outbox: 1,
          idempotency: 1,
        });
      }
    });

    await t.test("redacts provider failures from middleware errors and console output", async () => {
      const middlewareErrors = [];
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
        const custom = await openCustomRuntime({
          media: mediaAdapter("throw"),
          middlewareErrors,
        });
        const input = joinInput(
          "session-middleware-redaction",
          "join-http-middleware-redaction",
        );
        await assertStableError(
          await requestJoin(custom.endpoint, input.huddleSessionId, input),
          503,
          CHAT_HUDDLE_JOIN_UNAVAILABLE_CODE,
          "Huddle join temporarily unavailable",
        );
      } finally {
        console.error = originals.error;
        console.warn = originals.warn;
        console.log = originals.log;
      }
      assert.equal(middlewareErrors.length, 1);
      const middlewareError = middlewareErrors[0];
      assert.equal(middlewareError.name, "ChatHuddleJoinRouteError");
      assert.equal(middlewareError.code, CHAT_HUDDLE_JOIN_UNAVAILABLE_CODE);
      assert.equal(middlewareError.statusCode, 503);
      const structuralError = [
        middlewareError.name,
        middlewareError.message,
        middlewareError.stack,
        JSON.stringify(middlewareError),
      ].join("\n");
      assertRedacted(structuralError);
      assertRedacted(capturedLogs.join("\n"));
    });
  } finally {
    for (const owned of customRuntimes.reverse()) {
      await closeServer(owned.server);
      await owned.runtime.close();
    }
    await harness.teardown();
    await backend.teardown();
  }
});
