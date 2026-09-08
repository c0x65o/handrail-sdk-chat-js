import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
  CHAT_HUDDLE_LEAVE_UNAVAILABLE_CODE,
  LEAVE_HUDDLE_ROUTE,
  MAX_LEAVE_HUDDLE_REQUEST_BYTES,
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
  capabilities: Object.freeze(["huddle.leave"]),
});

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

const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

test("leave-huddle HTTP route rejects unsafe transport input before command effects", async () => {
  let connectCalls = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() { return { rows: [], rowCount: 0 }; },
        async connect() {
          connectCalls += 1;
          throw new Error("PROVIDER_SECRET_SENTINEL database failure");
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
      async getCapabilities() { return ["huddle.leave"]; },
      async authorizeEntity() {
        throw new Error("entity authorization was not expected");
      },
    },
    outbox: { pollIntervalMs: 60_000 },
  });
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  const endpoint = await listen(server);
  const sessionId = "transport-session";
  const valid = leaveInput(sessionId, "leave-http-transport");

  try {
    for (const input of [
      leaveInput("other-session", "leave-http-path-mismatch"),
      leaveInput(sessionId, "leave-http-actor", {
        actorUserId: "FORGED_ACTOR_SECRET_SENTINEL",
      }),
      leaveInput(sessionId, "leave-http-tenant", {
        tenantId: "FORGED_TENANT_SECRET_SENTINEL",
      }),
      leaveInput(sessionId, "leave-http-role", { roles: ["admin"] }),
      leaveInput(sessionId, "leave-http-provider", {
        providerRoomReference: "PROVIDER_ROOM_SECRET_SENTINEL",
      }),
      leaveInput(sessionId, "leave-http-reason", { reason: "disconnect" }),
      leaveInput(sessionId, "leave-http-credential", {
        credential: "AUTH_SECRET_SENTINEL",
      }),
      leaveInput(sessionId, "leave-http-storage", {
        storageKey: "STORAGE_SECRET_SENTINEL",
      }),
    ]) {
      await assertStableError(
        await requestLeave(endpoint, sessionId, input),
        400,
        CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
        "Invalid huddle leave request",
      );
    }

    for (const options of [
      { query: "?reason=disconnect" },
      { body: "{" },
      { contentType: "text/plain" },
      { omitIdempotencyKey: true },
      { idempotencyKey: "different-header-key" },
    ]) {
      await assertStableError(
        await requestLeave(endpoint, sessionId, valid, options),
        400,
        CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
        "Invalid huddle leave request",
      );
    }

    await assertStableError(
      await requestLeave(
        endpoint,
        "bad/id",
        leaveInput("bad/id", "leave-http-bad-path"),
      ),
      400,
      CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
      "Invalid huddle leave request",
    );

    const duplicateBody = JSON.stringify(valid);
    await assertStableError(
      await rawRequest(endpoint, leavePath(sessionId), duplicateBody, [
        "host", new URL(endpoint).host,
        "authorization", `Bearer ${actorRegistration.credential}`,
        "content-type", "application/json",
        "content-length", String(Buffer.byteLength(duplicateBody)),
        "idempotency-key", valid.idempotencyKey,
        "idempotency-key", valid.idempotencyKey,
      ]),
      400,
      CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
      "Invalid huddle leave request",
    );

    await assertStableError(
      await requestLeave(
        endpoint,
        sessionId,
        leaveInput(sessionId, "leave-http-oversized", {
          padding: "x".repeat(MAX_LEAVE_HUDDLE_REQUEST_BYTES),
        }),
      ),
      400,
      CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
      "Invalid huddle leave request",
    );
    await assertStableError(
      await rawRequest(
        endpoint,
        leavePath(sessionId),
        [
          Buffer.alloc(MAX_LEAVE_HUDDLE_REQUEST_BYTES, 0x20),
          Buffer.from("x"),
        ],
        [
          "host", new URL(endpoint).host,
          "authorization", `Bearer ${actorRegistration.credential}`,
          "content-type", "application/json",
          "transfer-encoding", "chunked",
          "idempotency-key", "leave-http-transport-chunked",
        ],
      ),
      400,
      CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
      "Invalid huddle leave request",
    );
    assert.equal(connectCalls, 0);

    await assertStableError(
      await requestLeave(endpoint, sessionId, valid),
      503,
      CHAT_HUDDLE_LEAVE_UNAVAILABLE_CODE,
      "Huddle leave temporarily unavailable",
    );
    assert.equal(connectCalls, 1);
  } finally {
    await closeServer(server);
    await runtime.close();
  }
});
