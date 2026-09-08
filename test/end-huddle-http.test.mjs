import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_HUDDLE_END_INVALID_REQUEST_CODE,
  CHAT_HUDDLE_END_UNAVAILABLE_CODE,
  END_HUDDLE_MODERATION_CAPABILITY,
  END_HUDDLE_ROUTE,
  MAX_END_HUDDLE_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

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

test("end-huddle HTTP request validation is strict and unavailable media is sanitized", async () => {
  let databaseCalls = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          databaseCalls += 1;
          return { rows: [], rowCount: 0 };
        },
        async connect() {
          databaseCalls += 1;
          throw new Error("end-huddle database work was not expected");
        },
      },
    },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization !== `Bearer ${actors.alice.credential}`) {
          throw new Error("invalid credential");
        }
        return actors.alice.actor;
      },
    },
    directory: {
      async getUser() { return null; },
      async searchUsers() { return { users: [] }; },
    },
    permissions: {
      async getCapabilities() { return []; },
      async authorizeEntity() { return false; },
    },
    features: { media: false },
    outbox: { pollIntervalMs: 60_000 },
  });
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await new Promise((resolve) => setImmediate(resolve));
  const backgroundDatabaseCalls = databaseCalls;

  try {
    const validInput = endInput("not-persisted", "end-http-unavailable");
    await assertStableError(
      await requestEnd(
        { endpoint },
        actors.alice,
        "not-persisted",
        validInput,
      ),
      503,
      CHAT_HUDDLE_END_UNAVAILABLE_CODE,
      "Huddle end temporarily unavailable",
    );

    const invalidRequests = [
      requestEnd(
        { endpoint },
        actors.alice,
        "not-persisted",
        endInput("not-persisted", "end-http-spoof", {
          providerRoomReference: "opaque-provider-room-secret",
        }),
      ),
      requestEnd(
        { endpoint },
        actors.alice,
        "path-session",
        endInput("body-session", "end-http-path-mismatch"),
      ),
      requestEnd(
        { endpoint },
        actors.alice,
        "not-persisted",
        endInput("not-persisted", "end-http-query"),
        { query: "?tenantId=tenant-b" },
      ),
      requestEnd(
        { endpoint },
        actors.alice,
        "not-persisted",
        endInput("not-persisted", "end-http-missing-header"),
        { omitIdempotencyKey: true },
      ),
      requestEnd(
        { endpoint },
        actors.alice,
        "not-persisted",
        endInput("not-persisted", "end-http-body-key"),
        { idempotencyKey: "end-http-header-key" },
      ),
      requestEnd(
        { endpoint },
        actors.alice,
        "not-persisted",
        endInput("not-persisted", "end-http-oversized"),
        { body: `{"padding":"${"x".repeat(MAX_END_HUDDLE_REQUEST_BYTES)}"}` },
      ),
    ];
    for (const responsePromise of invalidRequests) {
      await assertStableError(
        await responsePromise,
        400,
        CHAT_HUDDLE_END_INVALID_REQUEST_CODE,
        "Invalid huddle end request",
      );
    }

    const duplicateInput = endInput(
      "not-persisted",
      "end-http-duplicate-header",
    );
    const duplicateBody = JSON.stringify(duplicateInput);
    await assertStableError(
      await rawRequest(endpoint, endPath("not-persisted"), duplicateBody, [
        "host", new URL(endpoint).host,
        "authorization", `Bearer ${actors.alice.credential}`,
        "content-type", "application/json",
        "content-length", String(Buffer.byteLength(duplicateBody)),
        "idempotency-key", duplicateInput.idempotencyKey,
        "idempotency-key", duplicateInput.idempotencyKey,
      ]),
      400,
      CHAT_HUDDLE_END_INVALID_REQUEST_CODE,
      "Invalid huddle end request",
    );
    await assertStableError(
      await rawRequest(
        endpoint,
        endPath("not-persisted"),
        [
          Buffer.alloc(MAX_END_HUDDLE_REQUEST_BYTES, 0x20),
          Buffer.from("x"),
        ],
        [
          "host", new URL(endpoint).host,
          "authorization", `Bearer ${actors.alice.credential}`,
          "content-type", "application/json",
          "transfer-encoding", "chunked",
          "idempotency-key", "end-http-chunked",
        ],
      ),
      400,
      CHAT_HUDDLE_END_INVALID_REQUEST_CODE,
      "Invalid huddle end request",
    );
    assert.equal(databaseCalls, backgroundDatabaseCalls);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
});
