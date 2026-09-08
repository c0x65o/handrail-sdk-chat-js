import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  parseConversationDraftSnapshot,
} from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE,
  CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
  CONVERSATION_DRAFT_SNAPSHOT_ROUTE,
  createChatServer,
} from "@handrail/chat/server";

const actors = Object.freeze({
  a: Object.freeze({
    tenantId: "tenant-a",
    userId: "user-a",
    roles: Object.freeze(["employee"]),
  }),
  b: Object.freeze({
    tenantId: "tenant-a",
    userId: "user-b",
    roles: Object.freeze(["employee"]),
  }),
  tenantB: Object.freeze({
    tenantId: "tenant-b",
    userId: "user-a",
    roles: Object.freeze(["employee"]),
  }),
});

const row = ({
  content,
  revision = 7,
  updatedAt = "2030-01-02T03:04:05.000Z",
  entityType = null,
  entityId = null,
}) => ({
  entity_type: entityType,
  entity_id: entityId,
  draft_content: content,
  draft_revision: revision,
  draft_updated_at: updatedAt,
});

const presentContent = (text) => ({
  format: "markdown",
  text,
  attachments: [
    { attachmentId: "attachment-draft-z" },
    { attachmentId: "attachment-draft-a" },
  ],
});

const rowForRequest = (tenantId, userId, conversationId) => {
  if (conversationId === "temporary-failure") {
    throw new Error(
      "postgres://database-user:database-password@private-host/draft-private-text?token=credential-secret",
    );
  }
  if (
    conversationId === "missing" ||
    conversationId === "inactive-member" ||
    conversationId === "cross-tenant"
  ) {
    return undefined;
  }
  if (
    conversationId === "never-created" ||
    conversationId === "public-nonmember"
  ) {
    return row({ content: null, revision: null, updatedAt: null });
  }
  if (conversationId === "cleared") {
    return row({
      content: null,
      revision: 8,
      updatedAt: "2030-01-03T03:04:05.000Z",
    });
  }
  if (conversationId === "entity-allowed") {
    return row({
      content: presentContent("entity draft"),
      entityType: "invoice",
      entityId: "42",
    });
  }
  if (conversationId === "entity-denied") {
    return row({
      content: presentContent("denied entity secret"),
      entityType: "invoice",
      entityId: "denied-42",
    });
  }
  if (conversationId === "invalid-projection") {
    return row({
      content: {
        format: "plain",
        text: "private malformed draft",
        attachments: [{ attachmentId: "attachment-secret" }],
        unexpectedDatabaseField: "database-provider-secret",
      },
    });
  }
  if (conversationId === "actor-shared") {
    return row({
      content: presentContent(
        userId === "user-b" ? "actor b private draft" : "actor a private draft",
      ),
      revision: userId === "user-b" ? 11 : 2,
      updatedAt:
        userId === "user-b"
          ? "2030-01-05T03:04:05.000Z"
          : "2030-01-04T03:04:05.000Z",
    });
  }
  if (conversationId === "tenant-shared") {
    return row({
      content: presentContent(
        tenantId === "tenant-b" ? "tenant b private draft" : "tenant a private draft",
      ),
      revision: tenantId === "tenant-b" ? 9 : 3,
    });
  }
  return row({ content: presentContent("private present draft") });
};

const createFixture = () => {
  const databaseCalls = [];
  const authorizationCalls = [];
  const database = {
    async query(sql, values = []) {
      databaseCalls.push({ sql, values });
      if (!sql.includes("WITH authorized_conversation AS")) {
        return { rows: [] };
      }
      const [tenantId, userId, conversationId] = values;
      const result = rowForRequest(tenantId, userId, conversationId);
      return result === undefined ? { rows: [] } : { rows: [result] };
    },
    async connect() {
      throw new Error("draft snapshot HTTP route must remain read-only");
    },
  };
  const runtime = createChatServer({
    database: { pool: database, schema: "draft_snapshot_http" },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization === "Bearer actor-a") return actors.a;
        if (request.headers.authorization === "Bearer actor-b") return actors.b;
        if (request.headers.authorization === "Bearer tenant-b") {
          return actors.tenantB;
        }
        throw new Error("credential-secret from authentication provider");
      },
    },
    directory: {
      async getUser() {
        throw new Error("draft snapshot must not read the directory");
      },
      async searchUsers() {
        throw new Error("draft snapshot must not search the directory");
      },
    },
    permissions: {
      async getCapabilities() {
        return ["draft.read"];
      },
      async authorizeEntity(input) {
        authorizationCalls.push(input);
        return input.entity.id !== "denied-42";
      },
    },
    outbox: { pollIntervalMs: 60_000 },
  });
  return {
    runtime,
    databaseCalls,
    authorizationCalls,
    get snapshotCalls() {
      return databaseCalls.filter(({ sql }) =>
        sql.includes("WITH authorized_conversation AS"),
      );
    },
  };
};

const route = (conversationId) =>
  CONVERSATION_DRAFT_SNAPSHOT_ROUTE.replace(
    ":conversationId",
    encodeURIComponent(conversationId),
  );

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({
      endpoint,
      request(path, init = {}) {
        return fetch(`${endpoint}${path}`, {
          ...init,
          headers: { authorization: "Bearer actor-a", ...init.headers },
        });
      },
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const rawGet = (endpoint, path, { body, headers = {} }) =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      `${endpoint}${path}`,
      {
        method: "GET",
        headers: { authorization: "Bearer actor-a", ...headers },
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
    if (body !== undefined) request.write(body);
    request.end();
  });

const assertSafeHeaders = (response) => {
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
};

const secrets = [
  "database-password",
  "private-host",
  "credential-secret",
  "private malformed draft",
  "database-provider-secret",
  "denied entity secret",
  "attachment-secret",
  "tenant-a",
  "user-a",
  "employee",
];

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assertSafeHeaders(response);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: { code, message } });
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  return text;
};

test("GET conversation draft snapshot returns canonical present, absent, and cleared actor-private state exactly once", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    const expected = [
      {
        conversationId: "present",
        state: "present",
        revision: 7,
        updatedAt: "2030-01-02T03:04:05.000Z",
      },
      {
        conversationId: "never-created",
        state: "absent",
        revision: 0,
        updatedAt: null,
      },
      {
        conversationId: "public-nonmember",
        state: "absent",
        revision: 0,
        updatedAt: null,
      },
      {
        conversationId: "cleared",
        state: "absent",
        revision: 8,
        updatedAt: "2030-01-03T03:04:05.000Z",
      },
    ];

    for (const item of expected) {
      const callsBefore = fixture.snapshotCalls.length;
      const response = await request(route(item.conversationId));
      assert.equal(response.status, 200);
      assertSafeHeaders(response);
      const snapshot = parseConversationDraftSnapshot(await response.json(), {
        conversationId: item.conversationId,
      });
      assert.equal(snapshot.privacy, ACTOR_PRIVATE_USER_STATE_PRIVACY);
      assert.equal(snapshot.state, item.state);
      assert.equal(snapshot.canonicalRevision, item.revision);
      assert.equal(snapshot.canonicalUpdatedAt, item.updatedAt);
      if (snapshot.state === "present") {
        assert.equal(snapshot.content.privacy, ACTOR_PRIVATE_USER_STATE_PRIVACY);
        assert.equal(snapshot.content.value.text, "private present draft");
        assert.deepEqual(snapshot.content.value.attachments, [
          { attachmentId: "attachment-draft-z" },
          { attachmentId: "attachment-draft-a" },
        ]);
      } else {
        assert.equal(snapshot.content, null);
      }
      assert.equal(fixture.snapshotCalls.length, callsBefore + 1);
    }

    for (const call of fixture.snapshotCalls) {
      assert.deepEqual(call.values.slice(0, 2), ["tenant-a", "user-a"]);
      assert.match(call.sql, /"draft_snapshot_http"\.chat_drafts/u);
      assert.match(
        call.sql,
        /conversation\.type = 'channel' AND conversation\.visibility = 'public'/u,
      );
      assert.match(call.sql, /current_member\.state = 'active'/u);
      assert.doesNotMatch(
        call.sql,
        /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/iu,
      );
    }
  });
});

test("draft snapshot isolates actors and tenants and applies entity authorization", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    const actorA = await request(route("actor-shared"));
    const actorB = await request(route("actor-shared"), {
      headers: { authorization: "Bearer actor-b" },
    });
    const tenantA = await request(route("tenant-shared"));
    const tenantB = await request(route("tenant-shared"), {
      headers: { authorization: "Bearer tenant-b" },
    });
    const snapshots = await Promise.all(
      [actorA, actorB, tenantA, tenantB].map((response) => response.json()),
    );
    assert.equal(snapshots[0].content.value.text, "actor a private draft");
    assert.equal(snapshots[1].content.value.text, "actor b private draft");
    assert.equal(snapshots[2].content.value.text, "tenant a private draft");
    assert.equal(snapshots[3].content.value.text, "tenant b private draft");
    assert.equal(JSON.stringify(snapshots[0]).includes("actor b private draft"), false);
    assert.equal(JSON.stringify(snapshots[2]).includes("tenant b private draft"), false);

    const allowed = await request(route("entity-allowed"));
    assert.equal(allowed.status, 200);
    assertSafeHeaders(allowed);
    assert.deepEqual(fixture.authorizationCalls[0], {
      actor: actors.a,
      entity: { type: "invoice", id: "42" },
      action: CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
    });
  });
});

test("draft snapshot denials are indistinguishable across membership, tenant, existence, and entity policy", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    const bodies = [];
    for (const conversationId of [
      "missing",
      "inactive-member",
      "cross-tenant",
      "entity-denied",
    ]) {
      const callsBefore = fixture.snapshotCalls.length;
      bodies.push(
        await assertStableError(
          await request(route(conversationId)),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        ),
      );
      assert.equal(fixture.snapshotCalls.length, callsBefore + 1);
    }
    assert.equal(new Set(bodies).size, 1);
  });
});

test("draft snapshot rejects malformed paths, queries, bodies, transfer encoding, and spoofed trusted context before querying", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ endpoint, request }) => {
    for (const path of [
      `${route("present")}?tenantId=tenant-b`,
      `${route("present")}?userId=user-b&roles=admin`,
      `${route("present")}?actor%5BuserId%5D=user-b`,
      `${route("present")}?authorization=credential-secret`,
      "/conversations/%E0%A4%A/draft",
      "/conversations/present%2Fother/draft",
      "/conversations/present%5Cother/draft",
      "/conversations/present%00other/draft",
      "/conversations/%20%20/draft",
      "/conversations//draft",
      "/conversations/present/draft/extra",
      `/conversations/${"x".repeat(256)}/draft`,
    ]) {
      await assertStableError(
        await request(path),
        400,
        CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE,
        "Invalid conversation draft snapshot request",
      );
    }

    const spoofedHeaders = [
      { "x-handrail-tenant-id": "tenant-b" },
      { "x-chat-user-id": "user-b" },
      { "x-actor-roles": "admin" },
      { roles: "admin" },
    ];
    for (const headers of spoofedHeaders) {
      await assertStableError(
        await request(route("present"), { headers }),
        400,
        CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE,
        "Invalid conversation draft snapshot request",
      );
    }

    const body = JSON.stringify({
      tenantId: "tenant-b",
      userId: "user-b",
      actor: actors.b,
      roles: ["admin"],
      text: "private spoofed body",
    });
    await assertStableError(
      await rawGet(endpoint, route("present"), {
        body,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      }),
      400,
      CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE,
      "Invalid conversation draft snapshot request",
    );
    await assertStableError(
      await rawGet(endpoint, route("present"), {
        body: "chunked private body",
        headers: { "transfer-encoding": "chunked" },
      }),
      400,
      CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE,
      "Invalid conversation draft snapshot request",
    );
    assert.equal(fixture.snapshotCalls.length, 0);
  });
});

test("draft snapshot sanitizes authentication, database, projection, and serialization failures without logging private data", async () => {
  const fixture = createFixture();
  const logged = [];
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  console.error = (...values) => logged.push(values);
  console.log = (...values) => logged.push(values);
  console.warn = (...values) => logged.push(values);
  try {
    await withHttpServer(fixture.runtime, async ({ request }) => {
      await assertStableError(
        await request(route("present"), {
          headers: { authorization: "Bearer invalid" },
        }),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );
      assert.equal(fixture.snapshotCalls.length, 0);

      await assertStableError(
        await request(route("temporary-failure")),
        503,
        CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE,
        "Conversation draft snapshot temporarily unavailable",
      );
      await assertStableError(
        await request(route("invalid-projection")),
        503,
        CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE,
        "Conversation draft snapshot temporarily unavailable",
      );

      const originalStringify = JSON.stringify;
      JSON.stringify = (value, ...args) => {
        if (value?.kind === "conversation_draft") {
          throw new Error("private serialization failure");
        }
        return originalStringify(value, ...args);
      };
      try {
        await assertStableError(
          await request(route("present")),
          503,
          CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE,
          "Conversation draft snapshot temporarily unavailable",
        );
      } finally {
        JSON.stringify = originalStringify;
      }
    });
  } finally {
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
  assert.deepEqual(logged, []);
});

test("draft snapshot passes only sanitized failures to host error middleware", async () => {
  const fixture = createFixture();
  let middlewareError;
  const server = createServer((request, response) => {
    fixture.runtime.router(request, response, (error) => {
      middlewareError = error;
      response.statusCode = error.statusCode;
      response.end(error.message);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${route("temporary-failure")}`,
      { headers: { authorization: "Bearer actor-a" } },
    );
    assert.equal(response.status, 503);
    assert.equal(
      await response.text(),
      "Conversation draft snapshot temporarily unavailable",
    );
    assert.equal(
      middlewareError.code,
      CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE,
    );
    const serialized = `${middlewareError.name} ${middlewareError.message} ${middlewareError.stack}`;
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fixture.runtime.close();
  }
});
