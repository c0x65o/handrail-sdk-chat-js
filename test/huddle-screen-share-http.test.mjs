import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
  CHAT_HUDDLE_SCREEN_SHARE_UNAVAILABLE_CODE,
  HUDDLE_SCREEN_SHARE_CAPABILITY,
  HUDDLE_SCREEN_SHARE_ROUTE,
  MAX_HUDDLE_SCREEN_SHARE_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

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

const rawRequest = (endpoint, path, body, headers) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      `${endpoint}${path}`,
      { method: "PATCH", headers },
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

const mediaAdapter = Object.freeze({
  async createRoom() {
    throw new Error("provider room creation was not expected");
  },
  async createParticipantToken() {
    throw new Error("provider token creation was not expected");
  },
  async terminateRoom() {
    throw new Error("provider room termination was not expected");
  },
});

test("huddle screen-share HTTP route rejects unsafe input before command effects", async () => {
  let connectCalls = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          return { rows: [], rowCount: 0 };
        },
        async connect() {
          connectCalls += 1;
          throw new Error("DATABASE_SECRET_SENTINEL");
        },
      },
    },
    auth: {
      async resolveActor(request) {
        if (
          request.headers.authorization !==
          `Bearer ${actors.alice.credential}`
        ) {
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
      async getCapabilities() { return [HUDDLE_SCREEN_SHARE_CAPABILITY]; },
      async authorizeEntity() {
        throw new Error("entity authorization was not expected");
      },
    },
    media: mediaAdapter,
    features: { media: true },
    outbox: { pollIntervalMs: 60_000 },
  });
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  const endpoint = await listen(server);
  const sessionId = "transport-session";
  const valid = screenShareInput(
    sessionId,
    "set",
    "screen-share-http-transport",
  );

  try {
    for (const input of [
      screenShareInput(sessionId, "toggle", "malformed-intent"),
      screenShareInput("other-session", "set", "path-mismatch"),
      screenShareInput(sessionId, "set", "trusted-actor", {
        actorUserId: "FORGED_ACTOR_SECRET_SENTINEL",
      }),
      screenShareInput(sessionId, "set", "trusted-tenant", {
        tenantId: "FORGED_TENANT_SECRET_SENTINEL",
      }),
      screenShareInput(sessionId, "set", "trusted-role", {
        roles: ["administrator"],
      }),
      screenShareInput(sessionId, "set", "provider-room", {
        providerRoomId: "PROVIDER_ROOM_SECRET_SENTINEL",
      }),
      screenShareInput(sessionId, "set", "provider-token", {
        token: "PROVIDER_TOKEN_SECRET_SENTINEL",
      }),
      { ...valid, operation: "join_huddle" },
      { ...valid, unsupported: true },
    ]) {
      await assertStableError(
        await requestScreenShare(endpoint, actors.alice, sessionId, input),
        400,
        CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
        "Invalid huddle screen-share request",
      );
    }

    for (const options of [
      { query: "?provider=forged" },
      { body: "{" },
      { body: "" },
      { contentType: "text/plain" },
      { omitIdempotencyKey: true },
      { idempotencyKey: "different-header-key" },
    ]) {
      await assertStableError(
        await requestScreenShare(
          endpoint,
          actors.alice,
          sessionId,
          valid,
          options,
        ),
        400,
        CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
        "Invalid huddle screen-share request",
      );
    }

    await assertStableError(
      await requestScreenShare(
        endpoint,
        actors.alice,
        "bad/id",
        screenShareInput("bad/id", "set", "bad-path"),
      ),
      400,
      CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
      "Invalid huddle screen-share request",
    );

    const duplicateBody = JSON.stringify(valid);
    await assertStableError(
      await rawRequest(endpoint, screenSharePath(sessionId), duplicateBody, [
        "host", new URL(endpoint).host,
        "authorization", `Bearer ${actors.alice.credential}`,
        "content-type", "application/json",
        "content-length", String(Buffer.byteLength(duplicateBody)),
        "idempotency-key", valid.idempotencyKey,
        "idempotency-key", valid.idempotencyKey,
      ]),
      400,
      CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
      "Invalid huddle screen-share request",
    );

    await assertStableError(
      await requestScreenShare(
        endpoint,
        actors.alice,
        sessionId,
        screenShareInput(sessionId, "set", "oversized", {
          padding: "x".repeat(MAX_HUDDLE_SCREEN_SHARE_REQUEST_BYTES),
        }),
      ),
      400,
      CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
      "Invalid huddle screen-share request",
    );
    await assertStableError(
      await rawRequest(
        endpoint,
        screenSharePath(sessionId),
        [
          Buffer.alloc(MAX_HUDDLE_SCREEN_SHARE_REQUEST_BYTES, 0x20),
          Buffer.from("x"),
        ],
        [
          "host", new URL(endpoint).host,
          "authorization", `Bearer ${actors.alice.credential}`,
          "content-type", "application/json",
          "transfer-encoding", "chunked",
          "idempotency-key", "screen-share-http-transport-chunked",
        ],
      ),
      400,
      CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
      "Invalid huddle screen-share request",
    );
    assert.equal(connectCalls, 0);

    await assertStableError(
      await requestScreenShare(endpoint, actors.alice, sessionId, valid),
      503,
      CHAT_HUDDLE_SCREEN_SHARE_UNAVAILABLE_CODE,
      "Huddle screen sharing temporarily unavailable",
    );
    assert.equal(connectCalls, 1);
  } finally {
    await closeServer(server);
    await runtime.close();
  }
});
