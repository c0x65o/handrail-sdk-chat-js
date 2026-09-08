import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseDevicePushTokenResult } from "@handrail/chat";
import {
  CHAT_DEVICE_PUSH_TOKEN_CONFLICT_CODE,
  DEVICE_PUSH_TOKEN_ROUTE,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

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

test("PUT /devices/:deviceId/push-token mounts token-safe register, replay, refresh, and unregister behavior", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_device_push_token_http",
  });
  const protectionCalls = [];
  const runtime = createChatServer(adapters(
    {
      pool: harness.pool,
      schema: harness.schema,
    },
    {},
    {
      async protect(value) {
        protectionCalls.push(value);
        return {
          ciphertext: `http-ciphertext:${Buffer.from(value.token).toString("base64")}`,
          keyId: "http-kms-key",
        };
      },
      async unprotect() {
        throw new Error("unprotect must not run while updating a token");
      },
    },
  ));

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await withHttpServer(runtime, async ({ request }) => {
      const register = input("http-device", "register", {
        token: "SECRET_HTTP_REGISTER",
      });
      const registerResponse = await request(route(register.deviceId), register);
      assert.equal(registerResponse.status, 200);
      assert.equal(registerResponse.headers.get("cache-control"), "private, no-store");
      const registeredText = await registerResponse.text();
      assert.doesNotMatch(registeredText, /SECRET_HTTP_REGISTER/);
      const registered = parseDevicePushTokenResult(
        JSON.parse(registeredText),
        register,
      );
      assert.equal(registered.reconciliationStatus, "applied");
      assert.equal(registered.devicePushToken.status, "active");
      assert.deepEqual(protectionCalls.at(-1), {
        token: register.token,
        tenantId: actor.tenantId,
        userId: actor.userId,
        deviceId: register.deviceId,
      });

      const replayResponse = await request(route(register.deviceId), register);
      assert.equal(replayResponse.status, 200);
      const replayText = await replayResponse.text();
      assert.doesNotMatch(replayText, /SECRET_HTTP_REGISTER/);
      const replay = parseDevicePushTokenResult(JSON.parse(replayText), register);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.devicePushToken, registered.devicePushToken);

      const conflictingReuse = await request(route(register.deviceId), {
        ...register,
        token: "SECRET_HTTP_CONFLICT",
      });
      const conflictingBody = await assertStableError(
        conflictingReuse,
        409,
        CHAT_DEVICE_PUSH_TOKEN_CONFLICT_CODE,
        "Device push-token request conflicts with current server state",
      );
      assert.doesNotMatch(JSON.stringify(conflictingBody), /SECRET_HTTP_CONFLICT/);

      const refresh = {
        ...register,
        operation: "refresh",
        environment: "production",
        token: "SECRET_HTTP_REFRESH",
        tokenRevision: 2,
        idempotencyKey: "push-http-refresh",
      };
      const refreshResponse = await request(route(refresh.deviceId), refresh);
      assert.equal(refreshResponse.status, 200);
      const refreshedText = await refreshResponse.text();
      assert.doesNotMatch(refreshedText, /SECRET_HTTP_REFRESH/);
      const refreshed = parseDevicePushTokenResult(JSON.parse(refreshedText), refresh);
      assert.equal(refreshed.devicePushToken.tokenRevision, 2);

      const stale = {
        ...refresh,
        token: "SECRET_HTTP_STALE",
        idempotencyKey: "push-http-stale",
      };
      const staleBody = await assertStableError(
        await request(route(stale.deviceId), stale),
        409,
        CHAT_DEVICE_PUSH_TOKEN_CONFLICT_CODE,
        "Device push-token request conflicts with current server state",
      );
      assert.doesNotMatch(JSON.stringify(staleBody), /SECRET_HTTP_STALE/);

      const unregister = {
        operation: "unregister",
        intent: "unregister",
        deviceId: register.deviceId,
        tokenRevision: 3,
        idempotencyKey: "push-http-unregister",
      };
      const unregisterResponse = await request(route(unregister.deviceId), unregister);
      assert.equal(unregisterResponse.status, 200);
      const unregistered = parseDevicePushTokenResult(
        await unregisterResponse.json(),
        unregister,
      );
      assert.equal(unregistered.devicePushToken.status, "unregistered");
      assert.equal(unregistered.devicePushToken.environment, "production");
    });
  } finally {
    if (!runtime.closed) await runtime.close().catch(() => undefined);
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
