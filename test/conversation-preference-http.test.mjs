import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_PREFERENCE_UNAVAILABLE_CODE,
  CONVERSATION_PREFERENCE_ROUTE_SUFFIX,
  MAX_CONVERSATION_PREFERENCE_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "preference-user",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (conversationId, suffix, overrides = {}) => ({
  operation: "update_conversation_preference",
  conversationId,
  expectedPreferenceRevision: 0,
  idempotencyKey: `preference-http-${suffix}`,
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  ...overrides,
});

const route = (conversationId) =>
  `/conversations/${conversationId}${CONVERSATION_PREFERENCE_ROUTE_SUFFIX}`;

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const rawRequest = (path, { body = "", chunks, headers = [] } = {}) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          `${origin}${path}`,
          {
            method: "PATCH",
            headers: ["host", new URL(origin).host, ...headers],
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        if (chunks === undefined) {
          request.end(body);
          return;
        }
        const writeChunk = (index) => {
          const chunk = chunks[index];
          if (chunk === undefined) {
            request.end();
            return;
          }
          request.write(chunk);
          setImmediate(() => writeChunk(index + 1));
        };
        writeChunk(0);
      });

    return await callback({
      request(path, requestInput, options = {}) {
        const body = options.body ?? JSON.stringify(requestInput);
        const idempotencyKey =
          options.idempotencyKey === undefined
            ? requestInput?.idempotencyKey
            : options.idempotencyKey;
        return fetch(`${origin}${path}`, {
          method: "PATCH",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey === true ||
            idempotencyKey === undefined
              ? {}
              : { "idempotency-key": idempotencyKey }),
          },
          body,
        });
      },
      rawRequest,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("conversation-preference HTTP transport rejects untrusted input before command work", async () => {
  let commandConnectCount = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          throw new Error("unexpected query");
        },
        async connect() {
          return {
            async query(statement) {
              if (String(statement).includes("claim_chat_idempotency_key")) {
                commandConnectCount += 1;
                throw new Error("sensitive database detail");
              }
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
      },
      schema: "chat_preference_transport",
    },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization === "Bearer valid") return actor;
        throw new Error("sensitive authentication-provider detail");
      },
    },
    directory: {
      async getUser() { throw new Error("unexpected directory lookup"); },
      async searchUsers() { throw new Error("unexpected directory search"); },
    },
    permissions: {
      async getCapabilities() { return []; },
      async authorizeEntity() { throw new Error("unexpected authorization"); },
    },
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    const valid = input("preference-primary", "transport-base", {
      expectedPreferenceRevision: 3,
    });
    const { isStarred: _isStarred, ...withoutIsStarred } = valid;
    const malformedCases = [
      () => request(`${route("preference-primary")}?userId=other`, valid),
      () => request(route("preference-primary"), { ...valid, conversationId: "other" }),
      () => request("/conversations/preference%2Fprimary/preference", valid),
      () => request("/conversations//preference", valid),
      () => request(route("preference-primary"), valid, { contentType: "text/plain" }),
      () => request(route("preference-primary"), valid, { body: "{" }),
      () => request(route("preference-primary"), { ...valid, unknown: true }),
      () => request(route("preference-primary"), withoutIsStarred),
      () => request(route("preference-primary"), { ...valid, isStarred: "true" }),
      () => request(route("preference-primary"), { ...valid, toggleIsStarred: true }),
      () => request(route("preference-primary"), { ...valid, tenantId: "tenant-b" }),
      () => request(route("preference-primary"), { ...valid, user_id: "other" }),
      () => request(route("preference-primary"), { ...valid, actor }),
      () => request(route("preference-primary"), { ...valid, roles: ["owner"] }),
      () => request(route("preference-primary"), { ...valid, capabilities: ["admin"] }),
      () => request(route("preference-primary"), valid, { omitIdempotencyKey: true }),
      () => request(route("preference-primary"), valid, { idempotencyKey: "mismatch" }),
      () => request(route("preference-primary"), { ...valid, idempotencyKey: "unsafe/key" }),
      () => request(route("preference-primary"), {
        ...valid,
        idempotencyKey: `p${"x".repeat(255)}`,
      }),
      () => request(route("preference-primary"), valid, {
        body: "x".repeat(64 * 1_024 + 1),
      }),
      () => request(route("preference-primary"), valid, { body: "" }),
    ];
    for (const [index, send] of malformedCases.entries()) {
      await assertStableError(
        await send(),
        400,
        CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST_CODE,
        "Invalid conversation-preference request",
      );
      assert.equal(
        commandConnectCount,
        0,
        `malformed case ${index} reached command work`,
      );
    }

    const duplicate = await rawRequest(route("preference-primary"), {
      body: JSON.stringify(valid),
      headers: [
        "authorization",
        "Bearer valid",
        "content-type",
        "application/json",
        "idempotency-key",
        valid.idempotencyKey,
        "idempotency-key",
        valid.idempotencyKey,
      ],
    });
    await assertStableError(
      duplicate,
      400,
      CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST_CODE,
      "Invalid conversation-preference request",
    );

    const beforeStreamedOverflowConnects = commandConnectCount;
    const streamedOverflow = await rawRequest(route("preference-primary"), {
      chunks: [
        " ".repeat(MAX_CONVERSATION_PREFERENCE_REQUEST_BYTES),
        "x",
      ],
      headers: [
        "authorization", "Bearer valid",
        "content-type", "application/json",
        "idempotency-key", valid.idempotencyKey,
      ],
    });
    await assertStableError(
      streamedOverflow,
      400,
      CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST_CODE,
      "Invalid conversation-preference request",
    );
    assert.equal(commandConnectCount, beforeStreamedOverflowConnects);
    assert.equal(commandConnectCount, 0);

    await assertStableError(
      await request(route("preference-primary"), valid, {
        authorization: "Bearer invalid",
      }),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    assert.equal(commandConnectCount, 0);

    await assertStableError(
      await request(route("preference-primary"), valid),
      503,
      CHAT_CONVERSATION_PREFERENCE_UNAVAILABLE_CODE,
      "Conversation preference temporarily unavailable",
    );
    assert.equal(commandConnectCount, 1);
  });
});
