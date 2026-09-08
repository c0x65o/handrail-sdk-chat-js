import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_MEMBERSHIP_UNAVAILABLE_CODE,
  MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actors = Object.freeze({
  valid: Object.freeze({
    tenantId: "tenant-a",
    userId: "actor-a",
    roles: Object.freeze(["sensitive-host-role"]),
  }),
  member: Object.freeze({
    tenantId: "tenant-a",
    userId: "actor-member",
    roles: Object.freeze(["sensitive-member-role"]),
  }),
});

const input = (suffix, intent, conversationId, overrides = {}) => ({
  operation: "mutate_conversation_membership",
  intent,
  conversationId,
  expectedMemberListRevision: 1,
  idempotencyKey: `membership-http-${suffix}`,
  ...overrides,
});

const targetedInput = (
  suffix,
  intent,
  conversationId,
  targetUserId,
  overrides = {},
) => ({
  ...input(suffix, intent, conversationId),
  targetUserId,
  ...(intent === "add_member" || intent === "change_member_role"
    ? { requestedRole: "member" }
    : {}),
  ...overrides,
});

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const rawRequest = (path, { body = "", headers = [] } = {}) =>
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
                text: async () => text,
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        request.end(body);
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

test("membership endpoint validates its HTTP boundary before command invocation", async () => {
  let connectCount = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          throw new Error("unexpected direct query");
        },
        async connect() {
          connectCount += 1;
          throw new Error("sensitive database failure");
        },
      },
    },
    auth: { async resolveActor() { return actors.valid; } },
    directory: {
      async getUser() { return null; },
      async searchUsers() { return { users: [] }; },
    },
    permissions: {
      async getCapabilities() { return []; },
      async authorizeEntity() { return true; },
    },
  });
  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    const valid = targetedInput(
      "boundary",
      "add_member",
      "boundary-target",
      "user-d",
    );
    const invalidRequests = [
      () => request("/conversations/boundary-target/membership", valid, {
        body: "{",
      }),
      () => request("/conversations/boundary-target/membership", {
        ...valid,
        unexpected: true,
      }),
      () => request("/conversations/boundary-target/membership", {
        ...valid,
        actorUserId: "attacker",
      }),
      () => request("/conversations/boundary-target/membership", {
        ...valid,
        tenantId: "tenant-b",
      }),
      () => request("/conversations/boundary-target/membership", {
        ...valid,
        capabilities: ["chat.members.manage"],
      }),
      () => request("/conversations/different/membership", valid),
      () => request("/conversations/boundary-target/membership?intent=add_member", valid),
      () => request("/conversations/boundary-target/extra/membership", valid),
      () => request("/conversations/boundary-target/membership", {
        ...valid,
        targetUserId: " user-d",
      }),
      () => request("/conversations/boundary-target/membership", valid, {
        idempotencyKey: "different-key",
      }),
      () => request("/conversations/boundary-target/membership", valid, {
        omitIdempotencyKey: true,
      }),
      () => request("/conversations/boundary-target/membership", valid, {
        contentType: "text/plain",
      }),
      () => request("/conversations/boundary-target/membership", valid, {
        body: JSON.stringify({
          ...valid,
          targetUserId: "x".repeat(
            MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES,
          ),
        }),
      }),
    ];
    for (const send of invalidRequests) {
      await assertStableError(
        await send(),
        400,
        CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
        "Invalid conversation membership request",
      );
    }
    const duplicate = await rawRequest(
      "/conversations/boundary-target/membership",
      {
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
      },
    );
    await assertStableError(
      duplicate,
      400,
      CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
      "Invalid conversation membership request",
    );

    const beforeOverDeclaredConnects = connectCount;
    const overDeclared = await rawRequest(
      "/conversations/boundary-target/membership",
      {
        body: JSON.stringify(valid),
        headers: [
          "authorization", "Bearer valid",
          "content-type", "application/json",
          "idempotency-key", valid.idempotencyKey,
          "content-length",
          String(MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES + 1),
        ],
      },
    );
    await assertStableError(
      overDeclared,
      400,
      CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
      "Invalid conversation membership request",
    );
    assert.equal(connectCount, beforeOverDeclaredConnects);
    assert.equal(connectCount, 0);

    await assertStableError(
      await request(
        "/conversations/unavailable/membership",
        input("unavailable", "join", "unavailable"),
      ),
      503,
      CHAT_CONVERSATION_MEMBERSHIP_UNAVAILABLE_CODE,
      "Conversation membership temporarily unavailable",
    );
    assert.equal(connectCount, 1);
  });
});
