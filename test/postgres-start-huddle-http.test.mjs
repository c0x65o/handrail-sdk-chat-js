import assert from "node:assert/strict";
import {
  request as httpRequest,
} from "node:http";
import test from "node:test";

import { parseHuddleCommandResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_HUDDLE_START_CONFLICT_CODE,
  CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
  CHAT_HUDDLE_START_UNAVAILABLE_CODE,
  MAX_START_HUDDLE_REQUEST_BYTES,
  MAX_START_HUDDLE_RESPONSE_BYTES,
  START_HUDDLE_CAPABILITY,
  START_HUDDLE_ROUTE,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorContext = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const actorRegistration = Object.freeze({
  credential: "valid-huddle-token",
  actor: actorContext,
  capabilities: Object.freeze([START_HUDDLE_CAPABILITY]),
});

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const huddlePath = (conversationId) =>
  START_HUDDLE_ROUTE.replace(":conversationId", encodeURIComponent(conversationId));

const huddleInput = (conversationId, key, overrides = {}) => ({
  operation: "start_huddle",
  conversationId,
  idempotencyKey: key,
  ...overrides,
});

const requestHuddle = (harness, conversationId, input, options = {}) =>
  fetch(`${harness.endpoint}${huddlePath(conversationId)}${options.query ?? ""}`, {
    method: "POST",
    headers: {
      authorization: options.authorization ??
        `Bearer ${actorRegistration.credential}`,
      "content-type": options.contentType ?? "application/json",
      ...(options.omitIdempotencyKey
        ? {}
        : { "idempotency-key": options.idempotencyKey ?? input?.idempotencyKey }),
    },
    body: options.body ?? JSON.stringify(input),
  });

const rawRequest = (harness, path, body, headers) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      `${harness.endpoint}${path}`,
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

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assertSafeHeaders(response);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: { code, message } });
  for (const sensitive of [
    "test-room-",
    "provider-room-secret",
    "provider-token-secret",
    "valid-huddle-token",
    "trusted-host-role",
    "tenant-a",
  ]) {
    assert.equal(text.includes(sensitive), false);
  }
};

test("start-huddle HTTP route validates, authorizes, converges, and redacts", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await createChatTestHarness({
    backend,
    schemaPrefix: "chat_huddle_http",
    actors: [actorRegistration],
    initialTime: new Date(),
  });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const sessions = `${schema}.chat_huddle_sessions`;
  const idempotency = `${schema}.chat_idempotency_keys`;
  const audit = `${schema}.chat_audit_events`;
  const outbox = `${schema}.chat_outbox_events`;

  const activateSession = async (sessionId) => {
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_huddle_participants (tenant_id, huddle_session_id, user_id)
       VALUES ('tenant-a', $1, 'actor-a')`, [sessionId]);
    await harness.pool.query(
      `UPDATE ${sessions} SET status = 'active', activated_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE tenant_id = 'tenant-a' AND id = $1`, [sessionId]);
  };

  const seedConversation = async ({
    tenantId = "tenant-a",
    conversationId,
    memberUserId = "actor-a",
    entity,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4)`,
      [tenantId, conversationId, entity?.type ?? null, entity?.id ?? null],
    );
    if (memberUserId !== null) {
      await harness.pool.query(
        `INSERT INTO ${members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', 'active')`,
        [tenantId, conversationId, memberUserId],
      );
    }
  };

  const effectCounts = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${sessions}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS sessions,
         (SELECT count(*)::integer FROM ${audit}
           WHERE tenant_id = 'tenant-a' AND target_id = $1
             AND action = 'huddle.started') AS audit,
         (SELECT count(*)::integer FROM ${outbox}
           WHERE tenant_id = 'tenant-a' AND stream_id = $1
             AND type = 'huddle.updated' AND payload->>'operation' = 'start_huddle') AS outbox`,
      [conversationId],
    );
    return result.rows[0];
  };

  try {
    for (const conversationId of [
      "replay",
      "converge",
      "conflict-target",
      "missing-capability",
      "entity-denied",
      "provider-room-fail",
      "provider-token-fail",
      "active-conflict",
    ]) {
      await seedConversation({
        conversationId,
        ...(conversationId === "entity-denied"
          ? { entity: { type: "invoice", id: "invoice-private-42" } }
          : {}),
      });
    }
    await seedConversation({ conversationId: "nonmember", memberUserId: null });
    await seedConversation({
      tenantId: "tenant-b",
      conversationId: "cross-tenant",
    });

    await t.test("starts once, retries canonically, and replays after durable advancement", async () => {
      harness.calls.reset();
      const input = huddleInput("replay", "huddle-http-replay");
      const firstResponse = await requestHuddle(harness, "replay", input);
      assert.equal(firstResponse.status, 200);
      assertSafeHeaders(firstResponse);
      const firstText = await firstResponse.text();
      assert.ok(Buffer.byteLength(firstText) <= MAX_START_HUDDLE_RESPONSE_BYTES);
      const applied = parseHuddleCommandResult(JSON.parse(firstText), input);
      assert.deepEqual(Object.keys(applied).sort(), [
        "mediaJoin",
        "operation",
        "outcome",
        "reconciliationStatus",
        "state",
      ]);
      assert.deepEqual(Object.keys(applied.state).sort(), [
        "conversationId",
        "huddleSessionId",
        "participants",
        "screenShareOwnerUserId",
        "startedAt",
        "status",
      ]);
      assert.deepEqual(Object.keys(applied.mediaJoin).sort(), [
        "descriptor",
        "expiresAt",
        "kind",
      ]);
      assert.equal(applied.operation, "start_huddle");
      assert.equal(applied.outcome, "ok");
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.state.status, "starting");
      assert.equal(applied.state.conversationId, "replay");
      assert.deepEqual(applied.state.participants, []);
      assert.equal(applied.state.screenShareOwnerUserId, null);
      assert.equal(applied.mediaJoin.kind, "opaque_media_join");
      assert.match(applied.mediaJoin.descriptor, /^test-media-token-/u);
      assert.equal(firstText.includes("test-room-"), false);
      assert.equal(firstText.includes(actorContext.roles[0]), false);
      assert.equal(firstText.includes(actorContext.tenantId), false);

      const retryResponse = await requestHuddle(harness, "replay", input);
      assert.equal(retryResponse.status, 200);
      const retry = parseHuddleCommandResult(await retryResponse.json(), input);
      assert.equal(retry.reconciliationStatus, "replayed");
      assert.deepEqual(retry.state, applied.state);
      assert.notEqual(retry.mediaJoin.descriptor, applied.mediaJoin.descriptor);
      assert.equal(harness.calls.count("media.createRoom"), 1);
      assert.equal(harness.calls.count("media.createParticipantToken"), 2);
      assert.deepEqual(await effectCounts("replay"), {
        sessions: 1,
        audit: 1,
        outbox: 1,
      });

      await activateSession(applied.state.huddleSessionId);
      const advancedResponse = await requestHuddle(harness, "replay", input);
      assert.equal(advancedResponse.status, 200);
      const advancedReplay = parseHuddleCommandResult(
        await advancedResponse.json(),
        input,
      );
      assert.equal(advancedReplay.reconciliationStatus, "replayed");
      assert.deepEqual(advancedReplay.state, applied.state);
      assert.equal(harness.calls.count("media.createRoom"), 1);
      assert.deepEqual(await effectCounts("replay"), {
        sessions: 1,
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("a second key converges on starting state while active state conflicts", async (t) => {
      harness.calls.reset();
      const firstInput = huddleInput("converge", "huddle-http-converge-a");
      const first = parseHuddleCommandResult(
        await (await requestHuddle(harness, "converge", firstInput)).json(),
        firstInput,
      );
      const secondInput = huddleInput("converge", "huddle-http-converge-b");
      const secondResponse = await requestHuddle(harness, "converge", secondInput);
      assert.equal(secondResponse.status, 200);
      const second = parseHuddleCommandResult(
        await secondResponse.json(),
        secondInput,
      );
      assert.equal(second.reconciliationStatus, "applied");
      assert.deepEqual(second.state, first.state);
      assert.equal(harness.calls.count("media.createRoom"), 1);
      assert.deepEqual(await effectCounts("converge"), {
        sessions: 1,
        audit: 1,
        outbox: 1,
      });

      const activeInput = huddleInput("active-conflict", "huddle-http-active-a");
      const active = parseHuddleCommandResult(
        await (await requestHuddle(harness, "active-conflict", activeInput)).json(),
        activeInput,
      );
      await activateSession(active.state.huddleSessionId);
      await assertStableError(
        await requestHuddle(
          harness,
          "active-conflict",
          huddleInput("active-conflict", "huddle-http-active-b"),
        ),
        409,
        CHAT_HUDDLE_START_CONFLICT_CODE,
        "Huddle start conflicts with current server state",
      );
    });

    await t.test("uses safe authentication and authorization errors", async () => {
      await assertStableError(
        await requestHuddle(
          harness,
          "missing-capability",
          huddleInput("missing-capability", "huddle-http-authentication"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      harness.setCapabilities(actorRegistration.credential, []);
      await assertStableError(
        await requestHuddle(
          harness,
          "missing-capability",
          huddleInput("missing-capability", "huddle-http-capability"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      harness.setCapabilities(actorRegistration.credential, [START_HUDDLE_CAPABILITY]);

      harness.setEntityAuthorization(false);
      await assertStableError(
        await requestHuddle(
          harness,
          "entity-denied",
          huddleInput("entity-denied", "huddle-http-entity"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      harness.setEntityAuthorization(true);

      for (const conversationId of ["nonmember", "cross-tenant"]) {
        await assertStableError(
          await requestHuddle(
            harness,
            conversationId,
            huddleInput(conversationId, `huddle-http-${conversationId}`),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
      }
    });

    await t.test("rejects malformed, spoofed, mismatched, duplicate, and oversized input before effects", async () => {
      harness.calls.reset();
      const before = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${sessions}`,
      );
      const cases = [
        {
          conversationId: "conflict-target",
          input: huddleInput("other-conversation", "huddle-http-mismatch"),
        },
        {
          conversationId: "conflict-target",
          input: huddleInput("conflict-target", "huddle-http-trusted", {
            actorUserId: "forged-user",
          }),
        },
        {
          conversationId: "conflict-target",
          input: huddleInput("conflict-target", "huddle-http-provider", {
            roomId: "provider-room-secret",
          }),
        },
      ];
      for (const entry of cases) {
        await assertStableError(
          await requestHuddle(harness, entry.conversationId, entry.input),
          400,
          CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
          "Invalid huddle start request",
        );
      }
      await assertStableError(
        await requestHuddle(
          harness,
          "conflict-target",
          huddleInput("conflict-target", "huddle-http-query"),
          { query: "?provider=forged" },
        ),
        400,
        CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
        "Invalid huddle start request",
      );
      await assertStableError(
        await requestHuddle(
          harness,
          "conflict-target",
          huddleInput("conflict-target", "huddle-http-malformed"),
          { body: "{" },
        ),
        400,
        CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
        "Invalid huddle start request",
      );
      await assertStableError(
        await requestHuddle(
          harness,
          "conflict-target",
          huddleInput("conflict-target", "huddle-http-missing-header"),
          { omitIdempotencyKey: true },
        ),
        400,
        CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
        "Invalid huddle start request",
      );

      const duplicateInput = huddleInput(
        "conflict-target",
        "huddle-http-duplicate",
      );
      const duplicateBody = JSON.stringify(duplicateInput);
      await assertStableError(
        await rawRequest(
          harness,
          huddlePath("conflict-target"),
          duplicateBody,
          [
            "host", new URL(harness.endpoint).host,
            "authorization", `Bearer ${actorRegistration.credential}`,
            "content-type", "application/json",
            "content-length", String(Buffer.byteLength(duplicateBody)),
            "idempotency-key", duplicateInput.idempotencyKey,
            "idempotency-key", duplicateInput.idempotencyKey,
          ],
        ),
        400,
        CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
        "Invalid huddle start request",
      );

      const oversizedInput = huddleInput(
        "conflict-target",
        "huddle-http-oversized-json",
        { padding: "x".repeat(MAX_START_HUDDLE_REQUEST_BYTES) },
      );
      await assertStableError(
        await requestHuddle(harness, "conflict-target", oversizedInput),
        400,
        CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
        "Invalid huddle start request",
      );
      const after = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${sessions}`,
      );
      assert.equal(after.rows[0].count, before.rows[0].count);
      assert.equal(harness.calls.count("media.createRoom"), 0);
      assert.equal(harness.calls.count("media.createParticipantToken"), 0);
    });

    await t.test("maps conflicting key reuse and redacts provider failures", async () => {
      const sourceInput = huddleInput("conflict-target", "huddle-http-shared-key");
      assert.equal(
        (await requestHuddle(harness, "conflict-target", sourceInput)).status,
        200,
      );
      await assertStableError(
        await requestHuddle(
          harness,
          "provider-room-fail",
          huddleInput("provider-room-fail", sourceInput.idempotencyKey),
        ),
        409,
        CHAT_HUDDLE_START_CONFLICT_CODE,
        "Huddle start conflicts with current server state",
      );

      harness.failures.failNext(
        "media.createRoom",
        new Error("provider-room-secret raw-room-credential"),
      );
      await assertStableError(
        await requestHuddle(
          harness,
          "provider-room-fail",
          huddleInput("provider-room-fail", "huddle-http-provider-room"),
        ),
        503,
        CHAT_HUDDLE_START_UNAVAILABLE_CODE,
        "Huddle start temporarily unavailable",
      );
      assert.deepEqual(await effectCounts("provider-room-fail"), {
        sessions: 0,
        audit: 0,
        outbox: 0,
      });

      harness.failures.failNext(
        "media.createParticipantToken",
        new Error("provider-token-secret raw-join-credential"),
      );
      const tokenInput = huddleInput(
        "provider-token-fail",
        "huddle-http-provider-token",
      );
      await assertStableError(
        await requestHuddle(harness, "provider-token-fail", tokenInput),
        503,
        CHAT_HUDDLE_START_UNAVAILABLE_CODE,
        "Huddle start temporarily unavailable",
      );
      assert.deepEqual(await effectCounts("provider-token-fail"), {
        sessions: 1,
        audit: 1,
        outbox: 1,
      });
      const recoveredResponse = await requestHuddle(
        harness,
        "provider-token-fail",
        tokenInput,
      );
      assert.equal(recoveredResponse.status, 200);
      const recoveredText = await recoveredResponse.text();
      const recovered = parseHuddleCommandResult(
        JSON.parse(recoveredText),
        tokenInput,
      );
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.equal(recoveredText.includes("test-room-"), false);
      assert.equal(recoveredText.includes("provider-token-secret"), false);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
