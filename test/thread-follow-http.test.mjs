import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_THREAD_FOLLOW_INVALID_REQUEST_CODE,
  CHAT_THREAD_FOLLOW_UNAVAILABLE_CODE,
  MAX_THREAD_FOLLOW_REQUEST_BYTES,
  THREAD_FOLLOW_ROUTE_SUFFIX,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "thread-follower",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (threadId, suffix, overrides = {}) => ({
  operation: "set_thread_follow",
  intent: "follow",
  target: { type: "thread", id: threadId },
  expectedFollowRevision: 0,
  idempotencyKey: `thread-follow-http-${suffix}`,
  ...overrides,
});

const route = (threadId) =>
  `/conversations/${threadId}${THREAD_FOLLOW_ROUTE_SUFFIX}`;

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
  const body = await response.json();
  assert.deepEqual(body, { error: { code, message } });
  return body;
};

const adapters = (resolveActor) => ({
  auth: { resolveActor },
  directory: {
    async getUser() {
      throw new Error("thread-follow route must not query the directory");
    },
    async searchUsers() {
      throw new Error("thread-follow route must not search the directory");
    },
  },
  permissions: {
    async getCapabilities() {
      return [];
    },
    async authorizeEntity() {
      return true;
    },
  },
});

test("thread-follow HTTP transport rejects malformed or spoofed requests before command work", async () => {
  let commandConnectCount = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          throw new Error("unexpected query");
        },
        async connect() {
          commandConnectCount += 1;
          throw new Error("sensitive database detail");
        },
      },
      schema: "chat_thread_follow_transport",
    },
    ...adapters(async (request) => {
      if (request.headers.authorization === "Bearer valid") return actor;
      throw new Error("sensitive authentication-provider detail");
    }),
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundConnectCount = commandConnectCount;
    const valid = input("follow-primary", "transport-valid");
    const malformedCases = [
      () => request(`${route("follow-primary")}?tenant=other`, valid),
      () => request(route("follow-other"), valid),
      () => request("/conversations/follow%2Fprimary/follow", valid),
      () => request("/conversations//follow", valid),
      () => request(`${route("follow-primary")}/extra`, valid),
      () => request(route("follow-primary"), valid, { contentType: "text/plain" }),
      () => request(route("follow-primary"), valid, { body: "{" }),
      () => request(route("follow-primary"), { ...valid, unknown: true }),
      () => request(route("follow-primary"), { ...valid, tenantId: "tenant-b" }),
      () => request(route("follow-primary"), { ...valid, user_id: "other" }),
      () => request(route("follow-primary"), { ...valid, actor }),
      () => request(route("follow-primary"), { ...valid, roles: ["owner"] }),
      () => request(route("follow-primary"), { ...valid, permissions: ["admin"] }),
      () => request(route("follow-primary"), { ...valid, source: "mention" }),
      () => request(route("follow-primary"), { ...valid, channelId: "parent" }),
      () => request(route("follow-primary"), { ...valid, toggle: true }),
      () => request(route("follow-primary"), {
        ...valid,
        target: { type: "channel", id: "follow-primary" },
      }),
      () => request(route("follow-primary"), valid, { omitIdempotencyKey: true }),
      () => request(route("follow-primary"), valid, { idempotencyKey: "mismatch" }),
      () => request(route("follow-primary"), {
        ...valid,
        idempotencyKey: `k${"x".repeat(255)}`,
      }),
      () => request(route("follow-primary"), valid, {
        body: "x".repeat(MAX_THREAD_FOLLOW_REQUEST_BYTES + 1),
      }),
      () => request(route("follow-primary"), valid, { body: "" }),
    ];
    for (const send of malformedCases) {
      await assertStableError(
        await send(),
        400,
        CHAT_THREAD_FOLLOW_INVALID_REQUEST_CODE,
        "Invalid thread-follow request",
      );
    }

    const duplicate = await rawRequest(route("follow-primary"), {
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
      CHAT_THREAD_FOLLOW_INVALID_REQUEST_CODE,
      "Invalid thread-follow request",
    );
    assert.equal(commandConnectCount, backgroundConnectCount);

    const streamedOverflow = await rawRequest(route("follow-primary"), {
      chunks: [
        " ".repeat(MAX_THREAD_FOLLOW_REQUEST_BYTES),
        "SECRET_THREAD_FOLLOW_STREAMED_OVERFLOW",
      ],
      headers: [
        "authorization", "Bearer valid",
        "content-type", "application/json",
        "transfer-encoding", "chunked",
        "idempotency-key", valid.idempotencyKey,
      ],
    });
    const streamedOverflowBody = await assertStableError(
      streamedOverflow,
      400,
      CHAT_THREAD_FOLLOW_INVALID_REQUEST_CODE,
      "Invalid thread-follow request",
    );
    assert.doesNotMatch(
      JSON.stringify(streamedOverflowBody),
      /SECRET_THREAD_FOLLOW_STREAMED_OVERFLOW|sensitive database detail/iu,
    );
    assert.equal(commandConnectCount, backgroundConnectCount);

    await assertStableError(
      await request(route("follow-primary"), valid, {
        authorization: "Bearer invalid",
      }),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    assert.equal(commandConnectCount, backgroundConnectCount);

    await assertStableError(
      await request(route("follow-primary"), valid),
      503,
      CHAT_THREAD_FOLLOW_UNAVAILABLE_CODE,
      "Thread follow temporarily unavailable",
    );
    assert.equal(commandConnectCount, backgroundConnectCount + 1);
  });
});
