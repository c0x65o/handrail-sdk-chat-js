import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
  JOIN_HUDDLE_ROUTE,
  MAX_JOIN_HUDDLE_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

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

test("join-huddle HTTP route rejects unsafe transport input before database effects", async () => {
  let connectCalls = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          return { rows: [], rowCount: 0 };
        },
        async connect() {
          connectCalls += 1;
          throw new Error("join-huddle database work was not expected");
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
      async getCapabilities() { return ["huddle.join"]; },
      async authorizeEntity() {
        throw new Error("entity authorization was not expected");
      },
    },
    media: mediaAdapterForTransportTest(),
    features: { media: true },
    outbox: { pollIntervalMs: 60_000 },
  });
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  const endpoint = await listen(server);
  const sessionId = "transport-session";
  const valid = joinInput(sessionId, "join-http-transport");

  try {
    for (const input of [
      joinInput("other-session", "join-http-path-mismatch"),
      joinInput(sessionId, "join-http-trusted-field", {
        actorUserId: "FORGED_ACTOR_SECRET_SENTINEL",
      }),
      joinInput(sessionId, "join-http-provider-field", {
        token: "PROVIDER_TOKEN_SECRET_SENTINEL",
      }),
    ]) {
      await assertStableError(
        await requestJoin(endpoint, sessionId, input),
        400,
        CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
        "Invalid huddle join request",
      );
    }

    for (const options of [
      { query: "?provider=forged" },
      { body: "{" },
      { contentType: "text/plain" },
      { idempotencyKey: "different-header-key" },
    ]) {
      await assertStableError(
        await requestJoin(endpoint, sessionId, valid, options),
        400,
        CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
        "Invalid huddle join request",
      );
    }

    const duplicateBody = JSON.stringify(valid);
    await assertStableError(
      await rawRequest(endpoint, joinPath(sessionId), duplicateBody, [
        "host", new URL(endpoint).host,
        "authorization", `Bearer ${actorRegistration.credential}`,
        "content-type", "application/json",
        "content-length", String(Buffer.byteLength(duplicateBody)),
        "idempotency-key", valid.idempotencyKey,
        "idempotency-key", valid.idempotencyKey,
      ]),
      400,
      CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
      "Invalid huddle join request",
    );

    await assertStableError(
      await requestJoin(
        endpoint,
        sessionId,
        joinInput(sessionId, "join-http-transport-oversized", {
          padding: "x".repeat(MAX_JOIN_HUDDLE_REQUEST_BYTES),
        }),
      ),
      400,
      CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
      "Invalid huddle join request",
    );
    await assertStableError(
      await rawRequest(
        endpoint,
        joinPath(sessionId),
        [
          Buffer.alloc(MAX_JOIN_HUDDLE_REQUEST_BYTES, 0x20),
          Buffer.from("x"),
        ],
        [
          "host", new URL(endpoint).host,
          "authorization", `Bearer ${actorRegistration.credential}`,
          "content-type", "application/json",
          "transfer-encoding", "chunked",
          "idempotency-key", "join-http-transport-chunked",
        ],
      ),
      400,
      CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
      "Invalid huddle join request",
    );
    assert.equal(connectCalls, 0);
  } finally {
    await closeServer(server);
    await runtime.close();
  }
});

function mediaAdapterForTransportTest() {
  return {
    async createRoom() {
      throw new Error("media room work was not expected");
    },
    async createParticipantToken() {
      throw new Error("media token work was not expected");
    },
    async terminateRoom() {
      throw new Error("media compensation work was not expected");
    },
  };
}
