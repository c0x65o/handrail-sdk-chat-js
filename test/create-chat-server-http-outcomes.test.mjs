import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE_CODE,
  CHAT_HTTP_CLIENT_DISCONNECTED_CODE,
  CHAT_HTTP_INTERNAL_ERROR_CODE,
  CHAT_HTTP_REQUEST_ID_HEADER,
  CHAT_REQUEST_ADMISSION_DENIED_CODE,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-safe",
  userId: "user-safe",
  roles: Object.freeze(["employee"]),
});

const migrations = createPostgresMigrationRunner({
  database: {},
  migrations: handrailChatPostgresMigrations,
}).migrations;

const metadataDatabase = (onQuery = () => undefined) => ({
  async query(sql) {
    onQuery(sql);
    if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: true }] };
    if (sql.includes("SELECT id, migration_order")) {
      return {
        rows: migrations.map(({ id, order, checksum }) => ({
          id,
          migration_order: order,
          checksum,
          applied_at: new Date("2026-01-01T00:00:00.000Z"),
        })),
      };
    }
    return { rows: [], rowCount: 0 };
  },
  async connect() {
    throw new Error("connect is not expected");
  },
});

const baseAdapters = () => ({
  auth: {
    async resolveActor() {
      return actor;
    },
  },
  directory: {
    async getUser() {
      return null;
    },
    async searchUsers() {
      return [];
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

const invoke = (
  runtime,
  { method, url, headers = {}, body = "", connectStyle = false },
) =>
  new Promise((resolve, reject) => {
    const request = Object.assign(new EventEmitter(), {
      method,
      url,
      headers,
      rawHeaders: Object.entries(headers).flatMap(([name, value]) => [
        name,
        String(value),
      ]),
      async *[Symbol.asyncIterator]() {
        if (body !== "") yield Buffer.from(body);
      },
    });
    const responseHeaders = new Map();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      writableFinished: false,
      setHeader(name, value) {
        responseHeaders.set(name.toLowerCase(), String(value));
      },
      end(responseBody = "") {
        this.headersSent = true;
        this.writableFinished = true;
        this.emit("finish");
        resolve({
          status: this.statusCode,
          headers: responseHeaders,
          body: String(responseBody),
          request,
          response,
        });
      },
    });
    try {
      if (connectStyle) {
        runtime.router(request, response, (error) =>
          resolve({ kind: "next", error, request, response, headers: responseHeaders }),
        );
      } else {
        runtime.router(request, response);
      }
    } catch (error) {
      reject(error);
    }
  });

test("HTTP outcomes report one frozen success with trusted correlation", async () => {
  let now = 10;
  const outcomes = [];
  const runtime = createChatServer({
    database: {
      pool: metadataDatabase(() => {
        now = 24;
      }),
    },
    ...baseAdapters(),
    httpObservability: {
      createRequestId(input) {
        assert.equal(Object.isFrozen(input), true);
        assert.equal(input.routeTemplate, "/_meta");
        return "host-request-1";
      },
      now: () => now,
      onOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
  });

  const response = await invoke(runtime, {
    method: "GET",
    url: "/_meta?private=raw-query-secret",
    headers: { authorization: "Bearer raw-header-secret" },
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get(CHAT_HTTP_REQUEST_ID_HEADER),
    "host-request-1",
  );
  assert.deepEqual(outcomes, [
    {
      requestId: "host-request-1",
      method: "GET",
      routeTemplate: "/_meta",
      statusCode: 200,
      durationMs: 14,
    },
  ]);
  assert.equal(Object.isFrozen(outcomes[0]), true);
  assert.deepEqual(Object.keys(outcomes[0]).sort(), [
    "durationMs",
    "method",
    "requestId",
    "routeTemplate",
    "statusCode",
  ]);
  assert.doesNotMatch(JSON.stringify(outcomes), /raw-query|raw-header/u);
  await runtime.close();
});

test("HTTP outcomes sanitize pre-auth denial and authentication failure", async () => {
  const secretSentinels = [
    "raw-path-secret",
    "raw-query-secret",
    "raw-header-secret",
    "raw-body-secret",
    "provider-error-secret",
  ];
  const cases = [
    {
      expectedStatus: 429,
      expectedCode: CHAT_REQUEST_ADMISSION_DENIED_CODE,
      configure: {
        admission: {
          async admit() {
            return { decision: "deny", retryAfterSeconds: 3 };
          },
        },
      },
    },
    {
      expectedStatus: 401,
      expectedCode: CHAT_AUTHENTICATION_ERROR_CODE,
      configure: {
        auth: {
          async resolveActor() {
            throw new Error("provider-error-secret");
          },
        },
      },
    },
  ];

  for (const { expectedStatus, expectedCode, configure } of cases) {
    const times = [0, 7];
    const outcomes = [];
    const runtime = createChatServer({
      database: { pool: metadataDatabase() },
      ...baseAdapters(),
      ...configure,
      httpObservability: {
        createRequestId: () => "preauth-request",
        now: () => times.shift() ?? 7,
        onOutcome(outcome) {
          outcomes.push(outcome);
        },
      },
    });
    const body = "raw-body-secret";
    const response = await invoke(runtime, {
      method: "POST",
      url: "/conversations/raw-path-secret/messages?token=raw-query-secret",
      headers: {
        authorization: "Bearer raw-header-secret",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].statusCode, expectedStatus);
    assert.equal(outcomes[0].outcomeCode, expectedCode);
    assert.equal(outcomes[0].durationMs, 7);
    assert.equal("tenantId" in outcomes[0], false);
    assert.equal("userId" in outcomes[0], false);
    const serialized = JSON.stringify(outcomes[0]);
    for (const sentinel of secretSentinels) {
      assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
    }
    await runtime.close();
  }
});

test("HTTP outcomes map authenticated unexpected and metadata failures", async () => {
  const cases = [
    {
      method: "GET",
      url: "/conversations?scope=organization",
      status: 503,
      code: CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE_CODE,
      authenticated: true,
      database: {
        async query() {
          throw new Error("database-provider-secret");
        },
        async connect() {
          throw new Error("connect must not run");
        },
      },
    },
    {
      method: "GET",
      url: "/_meta",
      status: 500,
      code: CHAT_HTTP_INTERNAL_ERROR_CODE,
      authenticated: false,
      database: {
        async query() {
          throw new Error("metadata-provider-secret");
        },
        async connect() {
          throw new Error("connect must not run");
        },
      },
    },
  ];

  for (const candidate of cases) {
    const times = [5, 16];
    const outcomes = [];
    const runtime = createChatServer({
      database: { pool: candidate.database },
      ...baseAdapters(),
      httpObservability: {
        createRequestId: () => "failure-request",
        now: () => times.shift() ?? 16,
        onOutcome(outcome) {
          outcomes.push(outcome);
        },
      },
    });
    const response = await invoke(runtime, candidate);
    assert.equal(response.status, candidate.status);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].statusCode, candidate.status);
    assert.equal(outcomes[0].outcomeCode, candidate.code);
    assert.equal(outcomes[0].durationMs, 11);
    assert.equal("tenantId" in outcomes[0], candidate.authenticated);
    assert.doesNotMatch(JSON.stringify(outcomes[0]), /provider-secret|raw-query/u);
    await runtime.close();
  }
});

test("HTTP outcomes settle an aborted response once before authentication", async () => {
  let now = 30;
  let authCalls = 0;
  const outcomes = [];
  const runtime = createChatServer({
    database: { pool: metadataDatabase() },
    ...baseAdapters(),
    admission: {
      async admit() {
        return await new Promise(() => undefined);
      },
    },
    auth: {
      async resolveActor() {
        authCalls += 1;
        return actor;
      },
    },
    httpObservability: {
      createRequestId: () => "aborted-request",
      now: () => now,
      onOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
  });
  const request = Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/conversations/raw-path-secret",
    headers: {},
    rawHeaders: [],
  });
  const headers = new Map();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), String(value));
    },
    end() {
      throw new Error("the pending request must not complete");
    },
  });
  runtime.router(request, response);
  now = 39;
  response.emit("close");
  response.emit("close");
  request.emit("aborted");

  assert.equal(authCalls, 0);
  assert.equal(headers.get(CHAT_HTTP_REQUEST_ID_HEADER), "aborted-request");
  assert.deepEqual(outcomes, [
    {
      requestId: "aborted-request",
      method: "GET",
      routeTemplate: "/conversations/:conversationId",
      statusCode: 499,
      outcomeCode: CHAT_HTTP_CLIENT_DISCONNECTED_CODE,
      durationMs: 9,
    },
  ]);
  await runtime.close();
});

test("HTTP outcomes isolate throwing and rejecting observers", async () => {
  for (const onOutcome of [
    () => {
      throw new Error("observer throw");
    },
    async () => {
      throw new Error("observer rejection");
    },
  ]) {
    const runtime = createChatServer({
      database: { pool: metadataDatabase() },
      ...baseAdapters(),
      httpObservability: { onOutcome },
    });
    const response = await invoke(runtime, { method: "GET", url: "/_meta" });
    assert.equal(response.status, 200);
    await Promise.resolve();
    await runtime.close();
  }
});

test("HTTP outcomes isolate invalid ids and settle connect-style errors", async () => {
  const outcomes = [];
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          throw new Error("metadata-secret");
        },
        async connect() {
          throw new Error("connect must not run");
        },
      },
    },
    ...baseAdapters(),
    httpObservability: {
      createRequestId: () => "raw header value\nsecret",
      onOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
  });
  const result = await invoke(runtime, {
    method: "GET",
    url: "/_meta?raw-query-secret=1",
    headers: { "x-request-id": "untrusted-header-id" },
    connectStyle: true,
  });

  assert.equal(result.kind, "next");
  assert.equal(result.error instanceof Error, true);
  assert.equal(outcomes.length, 1);
  assert.match(outcomes[0].requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(
    result.headers.get(CHAT_HTTP_REQUEST_ID_HEADER),
    outcomes[0].requestId,
  );
  assert.equal(outcomes[0].statusCode, 500);
  assert.equal(outcomes[0].outcomeCode, CHAT_HTTP_INTERNAL_ERROR_CODE);
  assert.doesNotMatch(
    JSON.stringify(outcomes[0]),
    /raw header|untrusted-header|raw-query|metadata-secret/u,
  );
  await runtime.close();
});

test("HTTP request id correlates the response and existing message audit", async () => {
  let auditRequestId;
  const database = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
            return { rows: [], rowCount: null };
          }
          if (sql.includes("claim_chat_idempotency_key")) {
            return {
              rows: [{ idempotency_state: "pending", stored_response_body: null }],
              rowCount: 1,
            };
          }
          if (sql.includes("chat_conversations AS conversation")) {
            return {
              rows: [{
                sequence: 1,
                occurred_at: "2026-01-01T00:00:00.000Z",
                entity_type: null,
                entity_id: null,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("chat_audit_events")) {
            auditRequestId = values.at(-1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("chat_idempotency_keys")) {
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("chat_messages") ||
            sql.includes("chat_message_revisions") ||
            sql.includes("chat_outbox_events")
          ) {
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected query shape: ${sql.slice(0, 40)}`);
        },
        release() {},
      };
    },
  };
  const outcomes = [];
  const runtime = createChatServer({
    database: { pool: database },
    ...baseAdapters(),
    permissions: {
      async getCapabilities() {
        return ["message.send"];
      },
      async authorizeEntity() {
        return true;
      },
    },
    httpObservability: {
      createRequestId: () => "audit-correlated-request",
      onOutcome(outcome) {
        outcomes.push(outcome);
      },
    },
  });
  const body = JSON.stringify({
    operation: "send",
    conversationId: "conversation-safe",
    clientMessageId: "client-message-safe",
    idempotencyKey: "idempotency-safe",
    content: { format: "plain", text: "secret message content" },
  });
  const response = await invoke(runtime, {
    method: "POST",
    url: "/conversations/conversation-safe/messages",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "idempotency-key": "idempotency-safe",
    },
    body,
  });

  assert.equal(response.status, 201);
  assert.equal(
    response.headers.get(CHAT_HTTP_REQUEST_ID_HEADER),
    "audit-correlated-request",
  );
  assert.equal(auditRequestId, "audit-correlated-request");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].requestId, auditRequestId);
  assert.deepEqual(
    { tenantId: outcomes[0].tenantId, userId: outcomes[0].userId },
    { tenantId: actor.tenantId, userId: actor.userId },
  );
  assert.doesNotMatch(JSON.stringify(outcomes[0]), /secret message content/u);
  await runtime.close();
});
