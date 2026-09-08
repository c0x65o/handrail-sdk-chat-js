import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  CHAT_DIRECTORY_INVALID_REQUEST_CODE,
  CHAT_DIRECTORY_RATE_LIMITED_CODE,
  CHAT_DIRECTORY_UNAVAILABLE_CODE,
  DEFAULT_HOST_DIRECTORY_SEARCH_LIMIT,
  HOST_DIRECTORY_BATCH_ROUTE,
  HOST_DIRECTORY_LOOKUP_POLICY_ACTION,
  HOST_DIRECTORY_RATE_LIMIT_REQUESTS,
  HOST_DIRECTORY_SEARCH_POLICY_ACTION,
  HOST_DIRECTORY_SEARCH_ROUTE,
  MAX_HOST_DIRECTORY_REQUEST_BYTES,
  MAX_HOST_DIRECTORY_RESPONSE_BYTES,
  createChatServer,
  decodeHostDirectorySearchCursor,
  encodeHostDirectorySearchCursor,
} from "@handrail/chat/server";
import {
  MAX_HOST_DIRECTORY_BATCH_SIZE,
  MAX_HOST_DIRECTORY_QUERY_LENGTH,
} from "@handrail/chat";

const makeMetadataDatabase = () => ({
  async query(sql) {
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ exists: false }] };
    }
    throw new Error(`unexpected directory metadata query: ${sql}`);
  },
  async connect() {
    throw new Error("directory HTTP routes must not apply migrations");
  },
});

const createDirectoryRuntime = ({ directory, authorizeEntity } = {}) => {
  const policyCalls = [];
  const runtime = createChatServer({
    database: { pool: makeMetadataDatabase() },
    auth: {
      async resolveActor(request) {
        return {
          tenantId: request.headers["x-test-tenant"] ?? "tenant-a",
          userId: request.headers["x-test-actor"] ?? "actor-a",
          roles: ["employee"],
        };
      },
    },
    directory: directory ?? {
      async getUser({ actor, userId }) {
        return {
          tenantId: actor.tenantId,
          userId,
          displayName: `User ${userId}`,
        };
      },
      async searchUsers() {
        return [];
      },
    },
    permissions: {
      async getCapabilities() {
        return ["directory.read"];
      },
      async authorizeEntity(input) {
        policyCalls.push(input);
        return authorizeEntity ? authorizeEntity(input) : true;
      },
    },
  });
  return { runtime, policyCalls };
};

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const request = (path, init) =>
      fetch(`${origin}${path}`, init);
    const rawRequest = (path, { body = "", chunks, headers = {} } = {}) =>
      new Promise((resolve, reject) => {
        const outgoing = httpRequest(
          `${origin}${path}`,
          {
            agent: false,
            method: "POST",
            headers: {
              connection: "close",
              host: new URL(origin).host,
              ...headers,
            },
          },
          (response) => {
            const responseChunks = [];
            response.on("data", (chunk) => responseChunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(responseChunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        outgoing.on("error", reject);
        if (chunks === undefined) {
          outgoing.end(body);
          return;
        }
        for (const chunk of chunks) {
          outgoing.write(chunk);
        }
        outgoing.end();
      });
    return await callback(request, rawRequest);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const postBatch = (request, value, headers = {}) =>
  request(HOST_DIRECTORY_BATCH_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

const assertStableError = async (response, status, code, message, context) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store",
    context,
  );
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("batch lookup preserves requested order and emits only safe normalized summaries", async () => {
  const lookupCalls = [];
  const directory = {
    async getUser(input) {
      lookupCalls.push(input);
      const { actor, userId } = input;
      if (userId === "missing") return null;
      if (userId === "redacted") {
        return {
          tenantId: actor.tenantId,
          userId,
          kind: "redacted",
          displayName: "must not leak",
          email: "private@example.test",
        };
      }
      if (userId === "temporary") {
        return {
          tenantId: actor.tenantId,
          userId,
          kind: "unavailable",
          reason: "temporarily_unavailable",
          profile: { displayName: "must not leak" },
        };
      }
      if (userId === "cross-tenant") {
        return {
          tenantId: "tenant-b",
          userId,
          displayName: "Other tenant user",
          avatarUrl: "https://private.example.test/avatar.png",
        };
      }
      return {
        tenantId: actor.tenantId,
        userId,
        displayName: "Ada Lovelace",
        avatarUrl: "/avatars/ada",
        status: { availability: "online", text: "Available" },
        email: "ada@example.test",
        roles: ["admin"],
        metadata: { department: "Research" },
      };
    },
    async searchUsers() {
      return [];
    },
  };
  const { runtime, policyCalls } = createDirectoryRuntime({ directory });

  await withHttpServer(runtime, async (request) => {
    const response = await postBatch(
      request,
      { userIds: ["active", "missing", "redacted", "temporary", "cross-tenant"] },
      { "x-test-tenant": "tenant-a", "x-test-actor": "trusted-actor" },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const result = await response.json();
    assert.equal(result.kind, "host_directory_batch");
    assert.deepEqual(result.users, [
      {
        kind: "active",
        userId: "active",
        displayName: "Ada Lovelace",
        avatar: { kind: "image", url: "/avatars/ada" },
        status: { availability: "online", text: "Available" },
      },
      { kind: "unavailable", userId: "missing", reason: "missing" },
      { kind: "redacted", userId: "redacted" },
      {
        kind: "unavailable",
        userId: "temporary",
        reason: "temporarily_unavailable",
      },
      { kind: "unavailable", userId: "cross-tenant", reason: "missing" },
    ]);
    assert.deepEqual(Object.keys(result).sort(), ["_meta", "kind", "users"]);
    assert.equal(JSON.stringify(result).includes("private@example.test"), false);
    assert.equal(JSON.stringify(result).includes("Research"), false);
  });

  assert.deepEqual(
    lookupCalls.map(({ actor, userId }) => [actor.tenantId, actor.userId, userId]),
    [
      ["tenant-a", "trusted-actor", "active"],
      ["tenant-a", "trusted-actor", "missing"],
      ["tenant-a", "trusted-actor", "redacted"],
      ["tenant-a", "trusted-actor", "temporary"],
      ["tenant-a", "trusted-actor", "cross-tenant"],
    ],
  );
  assert.deepEqual(policyCalls.map(({ entity, action }) => ({ entity, action })), [
    {
      entity: { type: "handrail.chat.tenant-directory", id: "tenant-a" },
      action: HOST_DIRECTORY_LOOKUP_POLICY_ACTION,
    },
  ]);
});

test("search translates opaque cursors, enforces page limits, and isolates tenants", async () => {
  const searchCalls = [];
  const directory = {
    async getUser() {
      return null;
    },
    async searchUsers(input) {
      searchCalls.push(input);
      if (input.continuation === "provider-page-2") {
        return {
          users: [{
            tenantId: input.actor.tenantId,
            userId: "page-2",
            displayName: "Page Two",
            avatar: { kind: "initials", initials: "PT" },
          }],
        };
      }
      return {
        users: [
          {
            tenantId: input.actor.tenantId,
            userId: "avery",
            displayName: "Avery",
            avatar: { kind: "none" },
          },
          {
            tenantId: input.actor.tenantId,
            userId: "avery",
            displayName: "Duplicate Avery",
          },
          {
            tenantId: input.actor.tenantId,
            userId: "private-user",
            kind: "redacted",
            profile: { displayName: "Hidden" },
          },
          {
            tenantId: "tenant-b",
            userId: "other-tenant",
            displayName: "Must not leak",
          },
        ],
        continuation: "provider-page-2",
      };
    },
  };
  const { runtime, policyCalls } = createDirectoryRuntime({ directory });

  await withHttpServer(runtime, async (request) => {
    const firstResponse = await request(
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=av&limit=4`,
      { headers: { "x-test-tenant": "tenant-a", "x-test-actor": "actor-a" } },
    );
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.deepEqual(first.users, [
      {
        kind: "active",
        userId: "avery",
        displayName: "Avery",
        avatar: { kind: "none" },
      },
      { kind: "redacted", userId: "private-user" },
    ]);
    assert.deepEqual(decodeHostDirectorySearchCursor(first.page.nextCursor), {
      query: "av",
      continuation: "provider-page-2",
    });

    const secondResponse = await request(
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=av&limit=4&cursor=${encodeURIComponent(first.page.nextCursor)}`,
      { headers: { "x-test-tenant": "tenant-a", "x-test-actor": "actor-a" } },
    );
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.deepEqual(second.users, [{
      kind: "active",
      userId: "page-2",
      displayName: "Page Two",
      avatar: { kind: "initials", initials: "PT" },
    }]);
    assert.deepEqual(second.page, {});
  });

  assert.deepEqual(
    searchCalls.map(({ actor, query, limit, continuation }) => ({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      query,
      limit,
      continuation,
    })),
    [
      { tenantId: "tenant-a", actorId: "actor-a", query: "av", limit: 4, continuation: undefined },
      { tenantId: "tenant-a", actorId: "actor-a", query: "av", limit: 4, continuation: "provider-page-2" },
    ],
  );
  assert.deepEqual(policyCalls.map(({ action }) => action), [
    HOST_DIRECTORY_SEARCH_POLICY_ACTION,
    HOST_DIRECTORY_SEARCH_POLICY_ACTION,
  ]);
});

test("malformed, duplicate, oversized, and spoofed inputs fail before directory calls", async () => {
  let directoryCalls = 0;
  const directory = {
    async getUser() {
      directoryCalls += 1;
      return null;
    },
    async searchUsers() {
      directoryCalls += 1;
      return [];
    },
  };
  const { runtime } = createDirectoryRuntime({ directory });

  await withHttpServer(runtime, async (request) => {
    const batchCases = [
      "{",
      { userIds: ["same", "same"] },
      { userIds: ["user-a"], tenantId: "tenant-b" },
      { userIds: ["user-a"], actor: { userId: "admin" } },
      { userIds: Array.from({ length: MAX_HOST_DIRECTORY_BATCH_SIZE + 1 }, (_, index) => `user-${index}`) },
    ];
    for (const value of batchCases) {
      await assertStableError(
        await postBatch(request, value),
        400,
        CHAT_DIRECTORY_INVALID_REQUEST_CODE,
        "Invalid directory request",
      );
    }

    const cursor = encodeHostDirectorySearchCursor({
      query: "av",
      continuation: "page-2",
    });
    const searchCases = [
      HOST_DIRECTORY_SEARCH_ROUTE,
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=${"x".repeat(MAX_HOST_DIRECTORY_QUERY_LENGTH + 1)}`,
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=av&limit=101`,
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=av&tenantId=tenant-b`,
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=av&accessToken=secret`,
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=av&query=avery`,
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=different&cursor=${encodeURIComponent(cursor)}`,
    ];
    for (const path of searchCases) {
      await assertStableError(
        await request(path),
        400,
        CHAT_DIRECTORY_INVALID_REQUEST_CODE,
        "Invalid directory request",
      );
    }
  });

  assert.equal(directoryCalls, 0);
});

test("batch transport bounds preserve sanitized failures and rate-limit accounting", async () => {
  let directoryCalls = 0;
  const { runtime } = createDirectoryRuntime({
    directory: {
      async getUser() {
        directoryCalls += 1;
        return null;
      },
      async searchUsers() {
        directoryCalls += 1;
        return [];
      },
    },
  });

  await withHttpServer(runtime, async (request, rawRequest) => {
    const actorHeaders = { "x-test-actor": "transport-actor" };
    const invalidRequests = [
      [
        "empty chunked body",
        () => rawRequest(HOST_DIRECTORY_BATCH_ROUTE, {
          chunks: [],
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            ...actorHeaders,
          },
        }),
      ],
      [
        "declared-zero body",
        () => rawRequest(HOST_DIRECTORY_BATCH_ROUTE, {
          headers: {
            "content-type": "application/json",
            "content-length": "0",
            ...actorHeaders,
          },
        }),
      ],
      [
        "over-declared body",
        () => rawRequest(HOST_DIRECTORY_BATCH_ROUTE, {
          body: "{}",
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_HOST_DIRECTORY_REQUEST_BYTES + 1),
            ...actorHeaders,
          },
        }),
      ],
      [
        "chunked overflow",
        () => rawRequest(HOST_DIRECTORY_BATCH_ROUTE, {
          chunks: [" ".repeat(MAX_HOST_DIRECTORY_REQUEST_BYTES), "x"],
          headers: {
            "content-type": "application/json",
            ...actorHeaders,
          },
        }),
      ],
    ];

    for (const [caseName, send] of invalidRequests) {
      let response;
      try {
        response = await send();
      } catch (error) {
        throw new Error(`${caseName}: raw request failed`, { cause: error });
      }
      await assertStableError(
        response,
        400,
        CHAT_DIRECTORY_INVALID_REQUEST_CODE,
        "Invalid directory request",
        caseName,
      );
    }
    assert.equal(directoryCalls, 0);

    const remainingAllowedRequests =
      HOST_DIRECTORY_RATE_LIMIT_REQUESTS - invalidRequests.length;
    for (let index = 0; index < remainingAllowedRequests; index += 1) {
      const response = await postBatch(
        request,
        { userIds: ["user-a"] },
        { "x-test-actor": "transport-actor" },
      );
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal(directoryCalls, remainingAllowedRequests);

    await assertStableError(
      await postBatch(
        request,
        { userIds: ["user-a"] },
        { "x-test-actor": "transport-actor" },
      ),
      429,
      CHAT_DIRECTORY_RATE_LIMITED_CODE,
      "Directory request rate limit exceeded",
    );
    assert.equal(directoryCalls, remainingAllowedRequests);
  });
});

test("rate limiting is deterministic and isolated by both trusted actor and tenant", async () => {
  const { runtime } = createDirectoryRuntime();

  await withHttpServer(runtime, async (request) => {
    for (let index = 0; index < HOST_DIRECTORY_RATE_LIMIT_REQUESTS; index += 1) {
      const response = await postBatch(request, { userIds: ["user-a"] });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    const throttled = await postBatch(request, { userIds: ["user-a"] });
    await assertStableError(
      throttled,
      429,
      CHAT_DIRECTORY_RATE_LIMITED_CODE,
      "Directory request rate limit exceeded",
    );
    assert.equal(throttled.headers.get("retry-after"), "60");

    assert.equal(
      (await postBatch(request, { userIds: ["user-a"] }, { "x-test-actor": "actor-b" })).status,
      200,
    );
    assert.equal(
      (await postBatch(request, { userIds: ["user-a"] }, { "x-test-tenant": "tenant-b" })).status,
      200,
    );
  });
});

test("host policy denial and adapter failures return stable sanitized errors", async (t) => {
  await t.test("entity policy denial", async () => {
    let directoryCalls = 0;
    const { runtime } = createDirectoryRuntime({
      authorizeEntity: () => false,
      directory: {
        async getUser() {
          directoryCalls += 1;
          return null;
        },
        async searchUsers() {
          directoryCalls += 1;
          return [];
        },
      },
    });
    await withHttpServer(runtime, async (request) => {
      const response = await postBatch(request, { userIds: ["user-a"] });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: {
          code: "CHAT_AUTHORIZATION_FAILED",
          message: "Chat authorization failed",
        },
      });
    });
    assert.equal(directoryCalls, 0);
  });

  await t.test("host adapter exception", async () => {
    const { runtime } = createDirectoryRuntime({
      directory: {
        async getUser() {
          throw new Error("provider token and private diagnostics");
        },
        async searchUsers() {
          return [];
        },
      },
    });
    await withHttpServer(runtime, async (request) => {
      await assertStableError(
        await postBatch(request, { userIds: ["user-a"] }),
        503,
        CHAT_DIRECTORY_UNAVAILABLE_CODE,
        "Host directory temporarily unavailable",
      );
    });
  });

  await t.test("over-limit adapter page", async () => {
    const { runtime } = createDirectoryRuntime({
      directory: {
        async getUser() {
          return null;
        },
        async searchUsers({ actor }) {
          return Array.from(
            { length: DEFAULT_HOST_DIRECTORY_SEARCH_LIMIT + 1 },
            (_, index) => ({
              tenantId: actor.tenantId,
              userId: `user-${index}`,
              displayName: `User ${index}`,
            }),
          );
        },
      },
    });
    await withHttpServer(runtime, async (request) => {
      await assertStableError(
        await request(`${HOST_DIRECTORY_SEARCH_ROUTE}?query=user`),
        503,
        CHAT_DIRECTORY_UNAVAILABLE_CODE,
        "Host directory temporarily unavailable",
      );
    });
  });
});

test("the response byte ceiling rejects otherwise valid oversized provider pages", async () => {
  const { runtime } = createDirectoryRuntime({
    directory: {
      async getUser() {
        return null;
      },
      async searchUsers({ actor }) {
        return Array.from({ length: 100 }, (_, index) => ({
          tenantId: actor.tenantId,
          userId: `large-user-${index}`,
          displayName: "D".repeat(256),
          avatar: {
            kind: "image",
            url: `https://assets.example.test/${"a".repeat(1_980)}-${index}`,
            altText: "A".repeat(256),
          },
          status: {
            text: "S".repeat(160),
            emoji: "e".repeat(32),
          },
        }));
      },
    },
  });

  await withHttpServer(runtime, async (request) => {
    const response = await request(
      `${HOST_DIRECTORY_SEARCH_ROUTE}?query=user&limit=100`,
    );
    await assertStableError(
      response,
      503,
      CHAT_DIRECTORY_UNAVAILABLE_CODE,
      "Host directory temporarily unavailable",
    );
    assert.ok(MAX_HOST_DIRECTORY_RESPONSE_BYTES < 300_000);
  });
});
