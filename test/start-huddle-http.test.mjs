import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
} from "node:http";
import test from "node:test";


import {
  CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
  MAX_START_HUDDLE_REQUEST_BYTES,
  START_HUDDLE_CAPABILITY,
  START_HUDDLE_ROUTE,
  createChatServer,
} from "@handrail/chat/server";

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

test("start-huddle HTTP route returns canonical feature-disabled and validates before effects", async () => {
  let databaseCalls = 0;
  let mediaCalls = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          databaseCalls += 1;
          return { rows: [], rowCount: 0 };
        },
        async connect() {
          databaseCalls += 1;
          throw new Error("start-huddle database work was not expected");
        },
      },
    },
    auth: {
      async resolveActor(request) {
        if (
          request.headers.authorization !==
          `Bearer ${actorRegistration.credential}`
        ) {
          throw new Error("invalid credential");
        }
        return actorContext;
      },
    },
    directory: {
      async getUser() { return null; },
      async searchUsers() { return { users: [] }; },
    },
    permissions: {
      async getCapabilities() { return [START_HUDDLE_CAPABILITY]; },
      async authorizeEntity() {
        throw new Error("entity authorization was not expected");
      },
    },
    media: {
      async createRoom() {
        mediaCalls += 1;
        throw new Error("media room work was not expected");
      },
      async createParticipantToken() {
        mediaCalls += 1;
        throw new Error("media token work was not expected");
      },
      async terminateRoom() {
        mediaCalls += 1;
        throw new Error("media compensation work was not expected");
      },
    },
    features: { media: false },
    outbox: { pollIntervalMs: 60_000 },
  });
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const harness = { endpoint: `http://127.0.0.1:${address.port}` };
  await new Promise((resolve) => setImmediate(resolve));
  const backgroundDatabaseCalls = databaseCalls;

  try {
    const input = huddleInput("not-persisted", "huddle-http-disabled");
    const response = await requestHuddle(harness, "not-persisted", input);
    assert.equal(response.status, 200);
    assertSafeHeaders(response);
    assert.deepEqual(await response.json(), {
      operation: "start_huddle",
      outcome: "feature_disabled",
      reconciliationStatus: "applied",
      feature: "huddles",
      reason: "media_unavailable",
      state: { status: "inactive", conversationId: "not-persisted" },
    });

    await assertStableError(
      await requestHuddle(
        harness,
        "not-persisted",
        huddleInput("not-persisted", "huddle-http-spoofed", {
          providerRoomId: "provider-room-secret",
        }),
      ),
      400,
      CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
      "Invalid huddle start request",
    );

    const duplicateInput = huddleInput(
      "not-persisted",
      "huddle-http-disabled-duplicate",
    );
    const duplicateBody = JSON.stringify(duplicateInput);
    await assertStableError(
      await rawRequest(
        harness,
        huddlePath("not-persisted"),
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
    await assertStableError(
      await rawRequest(
        harness,
        huddlePath("not-persisted"),
        [
          Buffer.alloc(MAX_START_HUDDLE_REQUEST_BYTES, 0x20),
          Buffer.from("x"),
        ],
        [
          "host", new URL(harness.endpoint).host,
          "authorization", `Bearer ${actorRegistration.credential}`,
          "content-type", "application/json",
          "transfer-encoding", "chunked",
          "idempotency-key", "huddle-http-disabled-chunked",
        ],
      ),
      400,
      CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
      "Invalid huddle start request",
    );
    assert.equal(databaseCalls, backgroundDatabaseCalls);
    assert.equal(mediaCalls, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
});
