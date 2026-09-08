import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  CHAT_READ_CURSOR_INVALID_REQUEST_CODE,
  MAX_READ_CURSOR_REQUEST_BYTES,
  READ_CURSOR_ROUTE_SUFFIX,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "reader-a",
  roles: Object.freeze(["sensitive-host-role"]),
});

const route = (conversationId) =>
  `/conversations/${conversationId}${READ_CURSOR_ROUTE_SUFFIX}`;

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
            method: "PATCH",
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

test("PATCH /conversations/:conversationId/read-cursor rejects an over-limit declared Content-Length before command work", async () => {
  let directQueryCount = 0;
  let commandConnectCount = 0;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          directQueryCount += 1;
          throw new Error("sensitive direct database detail");
        },
        async connect() {
          commandConnectCount += 1;
          throw new Error("sensitive command database detail");
        },
      },
      schema: "chat_read_cursor_transport",
    },
    auth: {
      async resolveActor() {
        return actor;
      },
    },
    directory: {
      async getUser() {
        throw new Error("unexpected directory lookup");
      },
      async searchUsers() {
        throw new Error("unexpected directory search");
      },
    },
    permissions: {
      async getCapabilities() {
        return [];
      },
      async authorizeEntity() {
        throw new Error("unexpected authorization");
      },
    },
  });

  await withHttpServer(runtime, async ({ rawRequest }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundDirectQueryCount = directQueryCount;
    const backgroundCommandConnectCount = commandConnectCount;
    const overDeclared = await rawRequest(route("read-target"), {
      headers: [
        "authorization",
        "Bearer valid",
        "content-type",
        "application/json",
        "idempotency-key",
        "SECRET_READ_CURSOR_DECLARED_LENGTH",
        "content-length",
        String(MAX_READ_CURSOR_REQUEST_BYTES + 1),
      ],
      sendBody: false,
    });
    const overDeclaredBody = await assertStableError(
      overDeclared,
      400,
      CHAT_READ_CURSOR_INVALID_REQUEST_CODE,
      "Invalid read-cursor request",
    );
    assert.doesNotMatch(
      JSON.stringify(overDeclaredBody),
      /SECRET_READ_CURSOR_DECLARED_LENGTH|sensitive/iu,
    );
    assert.equal(directQueryCount, backgroundDirectQueryCount);
    assert.equal(commandConnectCount, backgroundCommandConnectCount);
  });
});
