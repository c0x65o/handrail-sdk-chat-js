import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST_CODE,
  CHAT_DEVICE_PUSH_TOKEN_UNAVAILABLE_CODE,
  DEVICE_PUSH_TOKEN_ROUTE,
  MAX_DEVICE_PUSH_TOKEN_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "push-http-user",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (deviceId, suffix, overrides = {}) => ({
  operation: "register",
  deviceId,
  platform: "ios",
  provider: "apns",
  environment: "sandbox",
  token: `SECRET_HTTP_${suffix}`,
  tokenRevision: 1,
  idempotencyKey: `push-http-${suffix}`,
  ...overrides,
});

const route = (deviceId) =>
  DEVICE_PUSH_TOKEN_ROUTE.replace(":deviceId", deviceId);

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const rawRequest = (
      path,
      { body = "", headers = [], sendBody = true } = {},
    ) =>
      new Promise((resolve, reject) => {
        let timeout;
        const request = httpRequest(
          `${origin}${path}`,
          {
            method: "PUT",
            headers: ["host", new URL(origin).host, ...headers],
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              clearTimeout(timeout);
              if (!request.writableEnded) request.destroy();
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                text,
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        if (sendBody) {
          request.end(body);
          return;
        }
        timeout = setTimeout(() => {
          request.destroy();
          reject(new Error("server did not reject the declared length early"));
        }, 5_000);
        request.flushHeaders();
      });

    return await callback({
      request(path, requestInput, options = {}) {
        const body = options.body ?? JSON.stringify(requestInput);
        const idempotencyKey =
          options.idempotencyKey === undefined
            ? requestInput?.idempotencyKey
            : options.idempotencyKey;
        return fetch(`${origin}${path}`, {
          method: "PUT",
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

const adapters = (database, auth = {}, pushTokenProtector) => ({
  database,
  ...(pushTokenProtector === undefined ? {} : { pushTokenProtector }),
  auth: {
    async resolveActor(request) {
      if (request.headers.authorization === "Bearer valid") return actor;
      throw new Error("sensitive authentication-provider detail");
    },
    ...auth,
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

test("device push-token HTTP transport rejects malformed and untrusted requests without leaking tokens", async () => {
  let commandConnectCount = 0;
  const runtime = createChatServer(adapters({
    pool: {
      async query() { throw new Error("unexpected query"); },
      async connect() {
        commandConnectCount += 1;
        throw new Error("sensitive database detail");
      },
    },
    schema: "chat_push_token_transport",
  }));

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundConnectCount = commandConnectCount;
    const valid = input("transport-device", "transport");
    const malformedCases = [
      () => request(`${route(valid.deviceId)}?userId=other`, valid),
      () => request(route(valid.deviceId), { ...valid, deviceId: "other-device" }),
      () => request("/devices/device%2Fsub/push-token", valid),
      () => request("/devices//push-token", valid),
      () => request(`${route(valid.deviceId)}/`, valid),
      () => request(route(valid.deviceId), valid, { contentType: "text/plain" }),
      () => request(route(valid.deviceId), valid, { body: "{" }),
      () => request(route(valid.deviceId), { ...valid, unknown: true }),
      () => request(route(valid.deviceId), { ...valid, tenantId: "tenant-b" }),
      () => request(route(valid.deviceId), { ...valid, nested: { userId: "other" } }),
      () => request(route(valid.deviceId), { ...valid, actor }),
      () => request(route(valid.deviceId), valid, { omitIdempotencyKey: true }),
      () => request(route(valid.deviceId), valid, { idempotencyKey: "mismatch" }),
      () => request(route(valid.deviceId), { ...valid, idempotencyKey: "unsafe/key" }),
      () => request(route(valid.deviceId), {
        ...valid,
        idempotencyKey: `p${"x".repeat(255)}`,
      }),
      () => request(route(valid.deviceId), valid, {
        body: "x".repeat(64 * 1_024 + 1),
      }),
      () => request(route(valid.deviceId), valid, { body: "" }),
      () => request(route(valid.deviceId), {
        ...valid,
        token: "SECRET_MALFORMED_NEVER_ECHOED",
        platform: "android",
      }),
    ];
    for (const send of malformedCases) {
      const response = await send();
      const body = await assertStableError(
        response,
        400,
        CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST_CODE,
        "Invalid device push-token request",
      );
      assert.doesNotMatch(JSON.stringify(body), /SECRET_/);
    }

    const duplicate = await rawRequest(route(valid.deviceId), {
      body: JSON.stringify(valid),
      headers: [
        "authorization", "Bearer valid",
        "content-type", "application/json",
        "idempotency-key", valid.idempotencyKey,
        "idempotency-key", valid.idempotencyKey,
      ],
    });
    const duplicateBody = await assertStableError(
      duplicate,
      400,
      CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST_CODE,
      "Invalid device push-token request",
    );
    assert.doesNotMatch(JSON.stringify(duplicateBody), /SECRET_HTTP_transport/);
    assert.equal(commandConnectCount, backgroundConnectCount);

    const overDeclared = await rawRequest(route(valid.deviceId), {
      headers: [
        "authorization", "Bearer valid",
        "content-type", "application/json",
        "idempotency-key", valid.idempotencyKey,
        "content-length", String(MAX_DEVICE_PUSH_TOKEN_REQUEST_BYTES + 1),
      ],
      sendBody: false,
    });
    const overDeclaredBody = await assertStableError(
      overDeclared,
      400,
      CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST_CODE,
      "Invalid device push-token request",
    );
    assert.doesNotMatch(JSON.stringify(overDeclaredBody), /SECRET_|sensitive/iu);
    assert.equal(commandConnectCount, backgroundConnectCount);

    await assertStableError(
      await request(route(valid.deviceId), valid, {
        authorization: "Bearer invalid",
      }),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    assert.equal(commandConnectCount, backgroundConnectCount);

    await assertStableError(
      await request(route(valid.deviceId), valid),
      503,
      CHAT_DEVICE_PUSH_TOKEN_UNAVAILABLE_CODE,
      "Device push token temporarily unavailable",
    );
    assert.equal(commandConnectCount, backgroundConnectCount);
  });
});

test("device push-token HTTP transport sanitizes protector failures before database checkout", async () => {
  const providerErrorSentinel = "HTTP_PROVIDER_ERROR_MUST_NEVER_ESCAPE";
  let commandConnectCount = 0;
  const protectionCalls = [];
  const runtime = createChatServer(adapters(
    {
      pool: {
        async query() {
          throw new Error("database query must not run");
        },
        async connect() {
          commandConnectCount += 1;
          throw new Error("database checkout must not run");
        },
      },
      schema: "chat_push_token_protection_failure",
    },
    {},
    {
      async protect(value) {
        protectionCalls.push(value);
        throw new Error(providerErrorSentinel);
      },
      async unprotect() {
        throw new Error("unprotect must not run while updating a token");
      },
    },
  ));
  const requestInput = input("protection-failure-device", "protection-failure", {
    token: "HTTP_RAW_TOKEN_MUST_NEVER_ESCAPE",
  });

  await withHttpServer(runtime, async ({ request }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundConnectCount = commandConnectCount;
    const response = await request(route(requestInput.deviceId), requestInput);
    const body = await assertStableError(
      response,
      503,
      CHAT_DEVICE_PUSH_TOKEN_UNAVAILABLE_CODE,
      "Device push token temporarily unavailable",
    );
    const observable = JSON.stringify(body);
    assert.doesNotMatch(observable, /HTTP_PROVIDER_ERROR_MUST_NEVER_ESCAPE/);
    assert.doesNotMatch(observable, /HTTP_RAW_TOKEN_MUST_NEVER_ESCAPE/);
    assert.equal(commandConnectCount, backgroundConnectCount);
  });

  assert.deepEqual(protectionCalls, [{
    token: requestInput.token,
    tenantId: actor.tenantId,
    userId: actor.userId,
    deviceId: requestInput.deviceId,
  }]);
});
