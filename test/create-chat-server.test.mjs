import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  createSupportedProtocolRange,
} from "@handrail/chat";
import {
  CHAT_REQUEST_ADMISSION_DENIED_CODE,
  CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
  ChatAuditDeliveryError,
  ChatServerConfigurationError,
  DEFAULT_CHAT_AUDIT_BATCH_SIZE,
  DEFAULT_CHAT_AUDIT_INITIAL_RETRY_DELAY_MS,
  DEFAULT_CHAT_AUDIT_LEASE_DURATION_MS,
  DEFAULT_CHAT_AUDIT_MAX_RETRY_DELAY_MS,
  DEFAULT_CHAT_AUDIT_POLL_INTERVAL_MS,
  DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
  DEFAULT_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
  MIN_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
  MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  createChatServer,
  createLocalChatRealtimeHub,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";

const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const makeDatabase = () => {
  let endCount = 0;
  return {
    resource: {
      query() {
        throw new Error("database query must not run during bootstrap");
      },
      async connect() {
        throw new Error("database connection must not open during bootstrap");
      },
      async end() {
        endCount += 1;
      },
    },
    get endCount() {
      return endCount;
    },
  };
};

const requiredAdapters = () => ({
  auth: {
    async resolveActor() {
      throw new Error("auth must not run during bootstrap");
    },
  },
  directory: {
    async getUser() {
      throw new Error("directory must not run during bootstrap");
    },
    async searchUsers() {
      throw new Error("directory must not run during bootstrap");
    },
  },
  permissions: {
    async getCapabilities() {
      throw new Error("permissions must not run during bootstrap");
    },
    async authorizeEntity() {
      throw new Error("permissions must not run during bootstrap");
    },
  },
});

const makeMinimalConfig = (pool) => ({
  database: { pool },
  ...requiredAdapters(),
});

const makeOptionalAdapters = () => ({
  storage: {
    async createUploadUrl() {
      throw new Error("storage must not run during bootstrap");
    },
    async verifyObject() {
      throw new Error("storage must not run during bootstrap");
    },
    async createDownloadUrl() {
      throw new Error("storage must not run during bootstrap");
    },
    async deleteObject() {
      throw new Error("storage must not run during bootstrap");
    },
  },
  notifications: {
    async send() {
      throw new Error("notifications must not run during bootstrap");
    },
  },
  pushTokenProtector: {
    async protect() {
      throw new Error("push-token protection must not run during bootstrap");
    },
    async unprotect() {
      throw new Error("push-token protection must not run during bootstrap");
    },
  },
  audit: {
    async record() {
      throw new Error("audit must not run during bootstrap");
    },
  },
  realtime: {
    async publish() {
      throw new Error("realtime must not run during bootstrap");
    },
  },
  media: {
    async createRoom() {
      throw new Error("media must not run during bootstrap");
    },
    async createParticipantToken() {
      throw new Error("media must not run during bootstrap");
    },
    async terminateRoom() {
      throw new Error("media must not run during bootstrap");
    },
  },
});

const auditRow = (auditEventId) => ({
  tenant_id: "tenant-audit",
  audit_event_id: auditEventId,
  actor_user_id: "user-audit",
  action: "message.created",
  target_type: "message",
  target_id: `message-${auditEventId}`,
  occurred_at: new Date("2030-01-01T00:00:00.000Z"),
  metadata: { source: "create-chat-server-test" },
  request_id: `request-${auditEventId}`,
  correlation_id: null,
  attempt_count: "1",
});

const makeAuditRuntimeDatabase = ({ batches = [], onEnd } = {}) => {
  const auditQueries = [];
  let batchIndex = 0;
  let endCount = 0;
  const resource = {
    async query(sql, values = []) {
      if (sql.includes("chat_audit_deliveries")) auditQueries.push(sql);
      if (
        sql.includes("WITH claim_clock AS MATERIALIZED") ||
        sql.includes("WITH expired_keys AS MATERIALIZED")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("SET delivered_at") ||
        sql.includes("SET next_attempt_at")
      ) {
        return { rows: [{ audit_event_id: values[1] }], rowCount: 1 };
      }
      throw new Error(`unexpected runtime query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes("chat_audit_deliveries")) auditQueries.push(sql);
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rows: [], rowCount: 0 };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_audit_deliveries")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (
            sql.includes("claimable AS MATERIALIZED") &&
            sql.includes("chat_audit_deliveries")
          ) {
            const batch = batches[batchIndex++] ?? [];
            return { rows: batch, rowCount: batch.length };
          }
          if (
            sql.includes("FROM") &&
            sql.includes("chat_outbox_events") &&
            sql.includes("FOR UPDATE OF event SKIP LOCKED")
          ) {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`unexpected runtime connection query: ${sql}`);
        },
        release() {},
      };
    },
    async end() {
      endCount += 1;
      await onEnd?.();
    },
  };
  return {
    resource,
    auditQueries,
    get endCount() {
      return endCount;
    },
  };
};

const waitFor = async (condition) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
};

const migrationDescriptors = createPostgresMigrationRunner({
  database: {},
  migrations: handrailChatPostgresMigrations,
}).migrations;

const makeMetadataDatabase = ({ current }) => {
  const queryCalls = [];
  let connectCount = 0;
  return {
    resource: {
      async query(sql, values) {
        if (
          sql.includes("WITH claim_clock AS MATERIALIZED") ||
          sql.includes("WITH expired_keys AS MATERIALIZED") ||
          sql.includes("DELETE FROM")
        ) {
          return { rows: [], rowCount: 0 };
        }
        queryCalls.push({ sql, values });
        if (sql.includes("SELECT EXISTS")) {
          return { rows: [{ exists: current }] };
        }
        if (sql.includes("SELECT id, migration_order")) {
          return {
            rows: migrationDescriptors.map(({ id, order, checksum }) => ({
              id,
              migration_order: order,
              checksum,
              applied_at: new Date("2026-08-25T20:00:00.000Z"),
            })),
          };
        }
        throw new Error(`unexpected diagnostic query: ${sql}`);
      },
      async connect() {
        connectCount += 1;
        throw new Error("migration apply must not run for GET /_meta");
      },
    },
    get queryCalls() {
      return queryCalls;
    },
    get connectCount() {
      return connectCount;
    },
  };
};

const request = async (runtime, path = "/_meta", method = "GET") => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    return await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
};

const invokeRouter = (runtime, { method, url, request: requestFields = {} }) =>
  new Promise((resolve, reject) => {
    const headers = new Map();
    const requestValue = {
      method,
      url,
      headers: {},
      rawHeaders: [],
      ...requestFields,
    };
    const response = {
      statusCode: 200,
      headersSent: false,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), String(value));
      },
      end(body = "") {
        this.headersSent = true;
        resolve({
          kind: "response",
          status: this.statusCode,
          headers,
          body: String(body),
          request: requestValue,
        });
      },
    };
    try {
      runtime.router(requestValue, response, (error) => {
        resolve({ kind: "next", error, request: requestValue });
      });
    } catch (error) {
      reject(error);
    }
  });

test("GET /_meta reports the exact current-schema contract with disabled features", async () => {
  const database = makeMetadataDatabase({ current: true });
  const runtime = createChatServer(makeMinimalConfig(database.resource));

  const response = await request(runtime);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), {
    packageVersion: packageManifest.version,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    schemaVersion: migrationDescriptors.at(-1)?.order ?? 0,
    enabledFeatures: {
      attachments: false,
      notifications: false,
      audit: false,
      realtime: false,
      media: false,
      typing: false,
      presence: false,
      threadDiscovery: false,
      inlineReplies: false,
      namedThreads: false,
      threadLifecycle: false,
      threadInactivity: false,
      reply_style_preference_v1: false,
    },
    supportedProtocolRange: createSupportedProtocolRange(CHAT_PROTOCOL_VERSION),
  });
  assert.deepEqual(createSupportedProtocolRange(CHAT_PROTOCOL_VERSION), {
    minimumVersion: CHAT_PROTOCOL_VERSION - 1,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  });
  assert.equal(database.queryCalls.length, 2);
  assert.match(database.queryCalls[0].sql, /SELECT EXISTS/);
  assert.match(database.queryCalls[1].sql, /SELECT id, migration_order/);
  assert.equal(
    database.connectCount,
    2,
    "only the independently scheduled maintenance connections were attempted",
  );

  await runtime.close();
});

test("GET /_meta reports a pending schema and normalized enabled features", async () => {
  const database = makeMetadataDatabase({ current: false });
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    ...makeOptionalAdapters(),
    features: { attachments: true, realtime: true },
  });

  const response = await request(runtime, "/_meta?diagnostic=1");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    packageVersion: packageManifest.version,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    schemaVersion: 0,
    enabledFeatures: {
      attachments: true,
      notifications: false,
      audit: false,
      realtime: true,
      media: false,
      typing: false,
      presence: false,
      threadDiscovery: false,
      inlineReplies: false,
      namedThreads: false,
      threadLifecycle: false,
      threadInactivity: false,
      reply_style_preference_v1: false,
    },
    supportedProtocolRange: {
      minimumVersion: CHAT_PROTOCOL_VERSION - 1,
      maximumVersion: CHAT_PROTOCOL_VERSION,
    },
  });
  assert.equal(database.queryCalls.length, 1);
  assert.match(database.queryCalls[0].sql, /SELECT EXISTS/);
  assert.equal(
    database.connectCount,
    3,
    "only maintenance and attachment-cleanup worker connections were attempted",
  );

  await runtime.close();
});

test("request admission is optional, normalized, and allows recognized requests to proceed", async () => {
  const compatibleDatabase = makeMetadataDatabase({ current: true });
  const compatible = createChatServer(
    makeMinimalConfig(compatibleDatabase.resource),
  );
  assert.equal(compatible.config.adapters.admission, undefined);
  assert.equal((await request(compatible)).status, 200);
  await compatible.close();

  const calls = [];
  const admission = {
    async admit(input) {
      calls.push(input);
      return { decision: "allow" };
    },
  };
  const database = makeMetadataDatabase({ current: true });
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    admission,
  });
  assert.equal(runtime.config.adapters.admission, admission);

  const response = await request(runtime, "/_meta?private=raw-query");
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].routeTemplate, "/_meta");
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(calls[0].request.url, "/_meta?private=raw-query");
  assert.deepEqual(Object.keys(calls[0]).sort(), [
    "method",
    "request",
    "routeTemplate",
  ]);
  await runtime.close();
});

test("admission runs once before authentication, permissions, and body reads", async () => {
  const order = [];
  const body = JSON.stringify({ userIds: ["user-2"] });
  const runtime = createChatServer({
    database: {
      pool: {
        async query(sql) {
          if (sql.includes("WITH claim_clock") || sql.includes("DELETE FROM")) {
            return { rows: [], rowCount: 0 };
          }
          order.push("database");
          throw new Error("metadata database is unavailable in this unit test");
        },
        async connect() {
          throw new Error("connect must not run");
        },
      },
    },
    admission: {
      async admit() {
        order.push("admission");
        return { decision: "allow" };
      },
    },
    auth: {
      async resolveActor() {
        order.push("auth");
        return {
          tenantId: "tenant-1",
          userId: "user-1",
          roles: [],
        };
      },
    },
    directory: {
      async getUser() {
        order.push("directory");
        return null;
      },
      async searchUsers() {
        throw new Error("search must not run");
      },
    },
    permissions: {
      async getCapabilities() {
        order.push("capabilities");
        return [];
      },
      async authorizeEntity() {
        order.push("authorize");
        return true;
      },
    },
  });

  const result = await invokeRouter(runtime, {
    method: "POST",
    url: "/directory/users:batch",
    request: {
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      async *[Symbol.asyncIterator]() {
        order.push("body");
        yield Buffer.from(body);
      },
    },
  });

  assert.equal(result.kind, "next");
  assert.deepEqual(order.filter((step) => step !== "database"), [
    "admission",
    "auth",
    "capabilities",
    "authorize",
    "body",
    "directory",
  ]);
  await runtime.close();
});

test("every recognized HTTP route reports one stable method/template descriptor", async () => {
  const recognizedRoutes = [
    ["GET", "/preferences/reply-style", "/preferences/reply-style"],
    ["PATCH", "/preferences/reply-style", "/preferences/reply-style"],
    ["GET", "/_meta", "/_meta"],
    ["POST", "/directory/users:batch", "/directory/users:batch"],
    ["GET", "/directory/users/search?q=raw-query", "/directory/users/search"],
    ["GET", "/conversations", "/conversations"],
    ["GET", "/conversations/parent/threads?limit=1", "/conversations/:parentConversationId/threads"],
    ["POST", "/conversations", "/conversations"],
    ["GET", "/saved-messages", "/saved-messages"],
    ["GET", "/message-reminders", "/message-reminders"],
    ["POST", "/messages/forward", "/messages/forward"],
    ["POST", "/messages/search", "/messages/search"],
    ["GET", "/conversations/raw-conversation/draft", "/conversations/:conversationId/draft"],
    ["PATCH", "/conversations/raw-conversation/draft", "/conversations/:conversationId/draft"],
    ["GET", "/conversations/raw-conversation/messages?before=3", "/conversations/:conversationId/messages"],
    ["GET", "/conversations/raw-conversation/messages/raw-message/context", "/conversations/:conversationId/messages/:messageId/context"],
    ["POST", "/conversations/raw-conversation/messages", "/conversations/:conversationId/messages"],
    ["GET", "/conversations/raw-conversation/huddle", "/conversations/:conversationId/huddle"],
    ["POST", "/conversations/raw-conversation/huddles", "/conversations/:conversationId/huddles"],
    ["POST", "/conversations/raw-conversation/attachments", "/conversations/:conversationId/attachments"],
    ["PUT", "/conversations/raw-conversation/messages/raw-message/reminder", "/conversations/:conversationId/messages/:messageId/reminder"],
    ["PATCH", "/conversations/raw-conversation/lifecycle", "/conversations/:conversationId/lifecycle"],
    ["PATCH", "/conversations/raw-conversation/membership", "/conversations/:conversationId/membership"],
    ["PATCH", "/conversations/raw-conversation/preference", "/conversations/:conversationId/preference"],
    ["PATCH", "/conversations/raw-conversation/read-cursor", "/conversations/:conversationId/read-cursor"],
    ["PATCH", "/conversations/raw-thread/follow", "/conversations/:threadId/follow"],
    ["GET", "/conversations/raw-conversation?secret=query", "/conversations/:conversationId"],
    ["PUT", "/devices/raw-device/push-token", "/devices/:deviceId/push-token"],
    ["POST", "/messages/raw-root/thread", "/messages/:rootMessageId/thread"],
    ["PATCH", "/messages/raw-message/reactions/raw-reaction", "/messages/:messageId/reactions/:reactionKey"],
    ["PATCH", "/messages/raw-message/saved", "/messages/:messageId/saved"],
    ["PATCH", "/messages/raw-message", "/messages/:messageId"],
    ["DELETE", "/messages/raw-message", "/messages/:messageId"],
    ["POST", "/huddles/raw-huddle/join", "/huddles/:huddleSessionId/join"],
    ["POST", "/huddles/raw-huddle/leave", "/huddles/:huddleSessionId/leave"],
    ["PATCH", "/huddles/raw-huddle/screen-share", "/huddles/:huddleSessionId/screen-share"],
    ["POST", "/huddles/raw-huddle/end", "/huddles/:huddleSessionId/end"],
    ["PATCH", "/attachments/raw-attachment/lifecycle", "/attachments/:attachmentId/lifecycle"],
    ["GET", "/attachments/raw-attachment/download?disposition=attachment", "/attachments/:attachmentId/download"],
  ];
  const calls = [];
  let authCalls = 0;
  const database = makeDatabase();
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    admission: {
      async admit(input) {
        calls.push(input);
        return { decision: "deny", retryAfterSeconds: 1 };
      },
    },
    auth: {
      async resolveActor() {
        authCalls += 1;
        throw new Error("auth must be skipped after denial");
      },
    },
  });

  for (const [method, url] of recognizedRoutes) {
    const result = await invokeRouter(runtime, { method, url });
    assert.equal(result.kind, "response", `${method} ${url}`);
    assert.equal(result.status, 429, `${method} ${url}`);
  }

  assert.equal(calls.length, recognizedRoutes.length);
  assert.equal(authCalls, 0);
  assert.deepEqual(
    calls.map(({ method, routeTemplate }) => [method, routeTemplate]),
    recognizedRoutes.map(([method, , routeTemplate]) => [method, routeTemplate]),
  );
  for (const call of calls) {
    assert.doesNotMatch(call.routeTemplate, /raw-|\?|secret/u);
  }
  await runtime.close();
});

test("denial and adapter failures return one sanitized fail-closed 429", async () => {
  const providerText = "provider-secret-diagnostic";
  const cases = [
    {
      adapter: async () => ({ decision: "deny", retryAfterSeconds: 7.01 }),
      retryAfter: "8",
    },
    {
      adapter: async () => {
        throw new Error(providerText);
      },
      retryAfter: String(DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS),
    },
    {
      adapter: async () => ({ decision: "allow", providerText }),
      retryAfter: String(DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS),
    },
    {
      adapter: async () => ({ decision: "deny", retryAfterSeconds: 0 }),
      retryAfter: String(DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS),
    },
    {
      adapter: async () => ({
        decision: "deny",
        retryAfterSeconds: MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS + 1,
      }),
      retryAfter: String(DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS),
    },
    {
      adapter: async () => null,
      retryAfter: String(DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS),
    },
  ];

  for (const { adapter, retryAfter } of cases) {
    let authCalls = 0;
    let permissionCalls = 0;
    let databaseCalls = 0;
    let providerCalls = 0;
    let bodyReads = 0;
    const runtime = createChatServer({
      database: {
        pool: {
          async query(sql) {
            if (sql.includes("WITH claim_clock") || sql.includes("DELETE FROM")) {
              return { rows: [], rowCount: 0 };
            }
            databaseCalls += 1;
            throw new Error("database must be skipped");
          },
          async connect() {
            return {
              async query(sql) {
                if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
                  return { rows: [], rowCount: 0 };
                }
                if (
                  sql.includes("claimable AS MATERIALIZED") ||
                  sql.includes("FOR UPDATE OF event SKIP LOCKED") ||
                  sql.includes("attachment.state = 'pending'")
                ) {
                  return { rows: [], rowCount: 0 };
                }
                databaseCalls += 1;
                throw new Error("request database work must be skipped");
              },
              release() {},
            };
          },
        },
      },
      ...requiredAdapters(),
      admission: { admit: adapter },
      storage: {
        async createUploadUrl() {
          providerCalls += 1;
          throw new Error("provider must be skipped");
        },
        async verifyObject() {
          providerCalls += 1;
          throw new Error("provider must be skipped");
        },
        async createDownloadUrl() {
          providerCalls += 1;
          throw new Error("provider must be skipped");
        },
        async deleteObject() {
          providerCalls += 1;
          throw new Error("provider must be skipped");
        },
      },
      features: { attachments: true },
      auth: {
        async resolveActor() {
          authCalls += 1;
          throw new Error("auth must be skipped");
        },
      },
      permissions: {
        async getCapabilities() {
          permissionCalls += 1;
          return [];
        },
        async authorizeEntity() {
          permissionCalls += 1;
          return true;
        },
      },
    });
    const result = await invokeRouter(runtime, {
      method: "POST",
      url: "/conversations/raw-conversation/attachments",
      request: {
        async *[Symbol.asyncIterator]() {
          bodyReads += 1;
          yield Buffer.from(providerText);
        },
      },
    });

    assert.equal(result.kind, "response");
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), retryAfter);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(JSON.parse(result.body), {
      error: {
        code: CHAT_REQUEST_ADMISSION_DENIED_CODE,
        message: CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
      },
    });
    assert.doesNotMatch(result.body, new RegExp(providerText, "u"));
    assert.deepEqual(
      { authCalls, permissionCalls, databaseCalls, providerCalls, bodyReads },
      {
        authCalls: 0,
        permissionCalls: 0,
        databaseCalls: 0,
        providerCalls: 0,
        bodyReads: 0,
      },
    );
    await runtime.close();
  }

  assert.equal(MIN_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS, 1);
  assert.equal(MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS, 3_600);
});

test("unrecognized and malformed route shapes delegate without admission or auth", async () => {
  let admissionCalls = 0;
  let authCalls = 0;
  const database = makeDatabase();
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    admission: {
      async admit() {
        admissionCalls += 1;
        return { decision: "allow" };
      },
    },
    auth: {
      async resolveActor() {
        authCalls += 1;
        throw new Error("auth must not run");
      },
    },
  });
  const unrecognized = [
    ["GET", "/not-chat"],
    ["POST", "/_meta"],
    ["GET", "/conversations/raw/messages/extra"],
    ["POST", "/messages/raw/thread/extra"],
    ["PATCH", "/messages/raw/reactions"],
    ["PATCH", "/conversations/raw/lifecycle/extra"],
    ["GET", "/conversations/"],
  ];

  for (const [method, url] of unrecognized) {
    const result = await invokeRouter(runtime, { method, url });
    assert.equal(result.kind, "next", `${method} ${url}`);
    assert.equal(result.error, undefined);
  }
  assert.equal(admissionCalls, 0);
  assert.equal(authCalls, 0);
  await runtime.close();
});

test("the public server subpath constructs a minimal immutable runtime", async () => {
  const database = makeDatabase();
  const runtime = createChatServer(makeMinimalConfig(database.resource));

  assert.equal(typeof runtime.router, "function");
  assert.equal(typeof runtime.attachWebSocket, "function");
  assert.equal(runtime.database, database.resource);
  assert.deepEqual(runtime.config.database, {
    schema: "handrail_chat",
    owned: false,
  });
  assert.deepEqual(runtime.config.features, {
    attachments: false,
    notifications: false,
    audit: false,
    realtime: false,
    media: false,
    typing: false,
    presence: false,
    threadDiscovery: false,
      inlineReplies: false,
      namedThreads: false,
      threadLifecycle: false,
      threadInactivity: false,
    reply_style_preference_v1: false,
  });
  assert.equal(runtime.config.realtimeDelivery, "single_process");
  assert.equal(Object.isFrozen(runtime.config.features), true);
  assert.equal(Object.isFrozen(runtime.config), true);

  await runtime.close();
  assert.equal(runtime.closed, true);
  assert.equal(database.endCount, 0);
});

test("the local realtime fallback publishes to current in-process subscribers", async () => {
  const hub = createLocalChatRealtimeHub();
  const delivered = [];
  const unsubscribe = hub.subscribe((event) => {
    delivered.push(event.eventId);
  });
  const event = {
    eventId: "local-event",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: "tenant-local",
    streamId: "stream-local",
    type: "message.created",
    occurredAt: "2026-08-25T20:00:00.000Z",
    payload: { local: true },
  };

  assert.equal(hub.subscriberCount, 1);
  await hub.publish(event);
  unsubscribe();
  unsubscribe();
  await hub.publish({ ...event, eventId: "after-unsubscribe" });

  assert.equal(hub.subscriberCount, 0);
  assert.deepEqual(delivered, ["local-event"]);
});

test("explicit single-process delivery preserves publish-only adapter compatibility", async () => {
  const database = makeDatabase();
  const realtime = { async publish() {} };
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    realtime,
    realtimeDelivery: "single_process",
  });

  assert.equal(runtime.config.realtimeDelivery, "single_process");
  assert.equal(runtime.config.adapters.realtime, realtime);
  await runtime.close();
});

test("fully configured construction preserves an explicit schema without provider calls", async () => {
  const database = makeDatabase();
  const optionalAdapters = makeOptionalAdapters();
  let createPoolCount = 0;
  const runtime = createChatServer({
    database: {
      connectionString: "postgresql://chat.example/handrail",
      schema: "tenant_chat",
      createPool({ connectionString }) {
        createPoolCount += 1;
        assert.equal(connectionString, "postgresql://chat.example/handrail");
        return database.resource;
      },
    },
    ...requiredAdapters(),
    ...optionalAdapters,
    features: {
      attachments: true,
      notifications: true,
      audit: true,
      realtime: true,
      media: true,
    },
  });

  assert.equal(createPoolCount, 1);
  assert.deepEqual(runtime.config.database, {
    schema: "tenant_chat",
    owned: true,
  });
  assert.deepEqual(runtime.config.features, {
    attachments: true,
    notifications: true,
    audit: true,
    realtime: true,
    media: true,
    typing: false,
    presence: false,
    threadDiscovery: false,
      inlineReplies: false,
      namedThreads: false,
      threadLifecycle: false,
      threadInactivity: false,
    reply_style_preference_v1: false,
  });
  assert.equal(runtime.config.adapters.storage, optionalAdapters.storage);
  assert.equal(
    runtime.config.adapters.pushTokenProtector,
    optionalAdapters.pushTokenProtector,
  );

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await Promise.all([firstClose, secondClose, runtime.close()]);
  assert.equal(database.endCount, 1);
});

test("audit delivery options normalize fail closed before owned pool allocation", async () => {
  const database = makeAuditRuntimeDatabase();
  const onError = () => {};
  const onBatch = () => {};
  const monotonicNow = () => 42;
  const defaults = createChatServer(makeMinimalConfig(database.resource));
  assert.deepEqual(
    {
      batchSize: defaults.config.auditDelivery.batchSize,
      pollIntervalMs: defaults.config.auditDelivery.pollIntervalMs,
      leaseDurationMs: defaults.config.auditDelivery.leaseDurationMs,
      initialRetryDelayMs: defaults.config.auditDelivery.initialRetryDelayMs,
      maxRetryDelayMs: defaults.config.auditDelivery.maxRetryDelayMs,
    },
    {
      batchSize: DEFAULT_CHAT_AUDIT_BATCH_SIZE,
      pollIntervalMs: DEFAULT_CHAT_AUDIT_POLL_INTERVAL_MS,
      leaseDurationMs: DEFAULT_CHAT_AUDIT_LEASE_DURATION_MS,
      initialRetryDelayMs: DEFAULT_CHAT_AUDIT_INITIAL_RETRY_DELAY_MS,
      maxRetryDelayMs: DEFAULT_CHAT_AUDIT_MAX_RETRY_DELAY_MS,
    },
  );
  await defaults.close();

  const configured = createChatServer({
    ...makeMinimalConfig(database.resource),
    auditDelivery: {
      batchSize: 7,
      pollIntervalMs: 60_000,
      leaseDurationMs: 12_000,
      initialRetryDelayMs: 20,
      maxRetryDelayMs: 80,
      onError,
      onBatch,
      monotonicNow,
    },
  });
  assert.deepEqual(
    {
      ...configured.config.auditDelivery,
      onError: undefined,
      onBatch: undefined,
      monotonicNow: undefined,
    },
    {
      batchSize: 7,
      pollIntervalMs: 60_000,
      leaseDurationMs: 12_000,
      initialRetryDelayMs: 20,
      maxRetryDelayMs: 80,
      onError: undefined,
      onBatch: undefined,
      monotonicNow: undefined,
    },
  );
  assert.equal(configured.config.auditDelivery.onError, onError);
  assert.equal(configured.config.auditDelivery.onBatch, onBatch);
  assert.equal(configured.config.auditDelivery.monotonicNow, monotonicNow);
  assert.equal(Object.isFrozen(configured.config.auditDelivery), true);
  await configured.close();

  const invalidOptions = [
    null,
    [],
    "enabled",
    { unsupported: true },
    { batchSize: 0 },
    { batchSize: 1.5 },
    { pollIntervalMs: -1 },
    { leaseDurationMs: 0 },
    { initialRetryDelayMs: -1 },
    { maxRetryDelayMs: -1 },
    { initialRetryDelayMs: 2, maxRetryDelayMs: 1 },
    { onError: true },
    { onBatch: true },
    { monotonicNow: true },
  ];
  let createPoolCount = 0;
  for (const auditDelivery of invalidOptions) {
    assert.throws(
      () =>
        createChatServer({
          database: {
            connectionString: "postgresql://chat.example/handrail",
            createPool() {
              createPoolCount += 1;
              return database.resource;
            },
          },
          ...requiredAdapters(),
          auditDelivery,
        }),
      (error) => error instanceof ChatServerConfigurationError,
    );
  }
  assert.equal(createPoolCount, 0);
});

test("enabled audit polling starts without synchronous provider calls and supports manual drain", async () => {
  const database = makeAuditRuntimeDatabase({
    batches: [[auditRow("poll")], [auditRow("manual")]],
  });
  const calls = [];
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    audit: {
      async record(event) {
        calls.push(event.auditEventId);
      },
    },
    features: { audit: true },
    auditDelivery: { batchSize: 2, pollIntervalMs: 60_000 },
  });

  assert.ok(runtime.auditDispatcher);
  assert.equal(runtime.auditDispatcher.running, true);
  assert.deepEqual(calls, [], "construction and migration setup must not call the adapter");
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, ["poll"]);
  assert.deepEqual(await runtime.auditDispatcher.runOnce(), {
    materialized: 0,
    claimed: 1,
    delivered: 1,
    failed: 0,
  });
  assert.deepEqual(calls, ["poll", "manual"]);
  await runtime.close();
});

test("disabled audit constructs no dispatcher and performs no audit work", async () => {
  const database = makeAuditRuntimeDatabase({ batches: [[auditRow("disabled")]] });
  let providerCalls = 0;
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    audit: { async record() { providerCalls += 1; } },
    features: { audit: false },
    auditDelivery: { batchSize: 1, pollIntervalMs: 60_000 },
  });

  assert.equal(runtime.auditDispatcher, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 0);
  assert.deepEqual(database.auditQueries, []);
  await runtime.close();
});

test("runtime close awaits an in-flight audit batch before ending its owned database", async () => {
  let releaseRecord;
  let recordStarted;
  let recordFinished = false;
  const started = new Promise((resolve) => { recordStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRecord = resolve; });
  let runtime;
  const database = makeAuditRuntimeDatabase({
    batches: [[auditRow("closing")]],
    onEnd() {
      assert.equal(recordFinished, true);
      assert.equal(runtime.auditDispatcher.stopped, true);
    },
  });
  runtime = createChatServer({
    database: {
      connectionString: "postgresql://chat.example/handrail",
      createPool: () => database.resource,
    },
    ...requiredAdapters(),
    audit: {
      async record() {
        recordStarted();
        await gate;
        recordFinished = true;
      },
    },
    features: { audit: true },
    auditDelivery: { batchSize: 2, pollIntervalMs: 60_000 },
  });

  await started;
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(database.endCount, 0);
  releaseRecord();
  await Promise.all([firstClose, secondClose, runtime.close()]);
  assert.equal(database.endCount, 1);
});

test("audit adapter failures remain isolated from runtime workers and shutdown", async () => {
  const secret = "private-provider-detail";
  const database = makeAuditRuntimeDatabase({
    batches: [[auditRow("failure")]],
  });
  const dispatcherErrors = [];
  const outcomes = [];
  let batchFinished;
  const finished = new Promise((resolve) => { batchFinished = resolve; });
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    audit: {
      async record() {
        throw new ChatAuditDeliveryError("transient", secret);
      },
    },
    features: { audit: true },
    auditDelivery: {
      batchSize: 2,
      pollIntervalMs: 60_000,
      onError(error) { dispatcherErrors.push(error); },
      onBatch(outcome) {
        outcomes.push(outcome);
        batchFinished();
      },
    },
  });

  await finished;
  assert.equal(runtime.auditDispatcher.running, true);
  assert.equal(runtime.outboxPublisher.running, true);
  assert.equal(runtime.postgresMaintenance.running, true);
  assert.deepEqual(dispatcherErrors, []);
  assert.deepEqual(outcomes.map(({ outcome, retried, terminal }) => ({
    outcome,
    retried,
    terminal,
  })), [{ outcome: "failed", retried: 1, terminal: 0 }]);
  assert.equal(JSON.stringify(outcomes).includes(secret), false);
  await runtime.close();
  assert.equal(runtime.outboxPublisher.stopped, true);
  assert.equal(runtime.postgresMaintenance.stopped, true);
  assert.equal(runtime.auditDispatcher.stopped, true);
});

test("runtime close waits for in-flight outbox delivery and remains idempotent", async () => {
  let claimed = false;
  let finishPublish;
  let publishStarted;
  const started = new Promise((resolve) => {
    publishStarted = resolve;
  });
  const publishGate = new Promise((resolve) => {
    finishPublish = resolve;
  });
  const database = {
    async query(sql) {
      if (sql.includes("claimable AS MATERIALIZED")) {
        if (claimed) {
          return { rows: [], rowCount: 0 };
        }
        claimed = true;
        return {
          rows: [{
            event_id: "closing-event",
            protocol_version: "4",
            tenant_id: "tenant-close",
            stream_id: "stream-close",
            type: "message.created",
            occurred_at: new Date("2026-08-25T20:00:00.000Z"),
            payload: { closing: true },
            publish_attempts: "1",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("SET published_at")) {
        return { rows: [{ event_id: "closing-event" }], rowCount: 1 };
      }
      if (sql.includes("SET claimed_at")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected outbox query: ${sql}`);
    },
    async connect() {
      throw new Error("migration apply is not expected");
    },
  };
  const runtime = createChatServer({
    ...makeMinimalConfig(database),
    realtime: {
      async publish(event) {
        assert.equal(event.eventId, "closing-event");
        publishStarted();
        await publishGate;
      },
    },
    outbox: { pollIntervalMs: 1, leaseDurationMs: 1_000 },
  });

  await started;
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  assert.equal(runtime.closed, true);
  let closeSettled = false;
  void firstClose.then(() => { closeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  finishPublish();
  await Promise.all([firstClose, secondClose, runtime.close()]);
  assert.equal(runtime.outboxPublisher.stopped, true);
});

test("configured optional adapters remain disabled and unused unless flags enable them", async () => {
  const database = makeDatabase();
  const runtime = createChatServer({
    ...makeMinimalConfig(database.resource),
    ...makeOptionalAdapters(),
  });

  assert.equal(Object.values(runtime.config.features).every(value => value === false), true);
  await runtime.close();
});

test("the WebSocket attachment point installs and removes one stable upgrade listener", async () => {
  const database = makeDatabase();
  const runtime = createChatServer(makeMinimalConfig(database.resource));
  const server = createServer();

  runtime.attachWebSocket(server);
  runtime.attachWebSocket(server);
  assert.equal(server.listenerCount("upgrade"), 1);
  assert.throws(
    () => runtime.attachWebSocket(createServer()),
    /already attached to an HTTP server/,
  );

  runtime.detachWebSocket();
  runtime.detachWebSocket();
  assert.equal(server.listenerCount("upgrade"), 0);

  runtime.attachWebSocket(server);
  assert.equal(server.listenerCount("upgrade"), 1);

  await runtime.close();
  assert.equal(server.listenerCount("upgrade"), 0);
  assert.throws(() => runtime.attachWebSocket(server), /runtime is closed/);
});

test("missing and malformed required configuration fails before allocation", () => {
  const database = makeDatabase();
  const valid = makeMinimalConfig(database.resource);
  const cases = [
    [undefined, /configuration must be an object/],
    [{ ...valid, database: undefined }, /database must be an object/],
    [{ ...valid, database: {} }, /exactly one of connectionString or pool/],
    [
      { ...valid, database: { connectionString: "" } },
      /connectionString must be a non-empty string/,
    ],
    [{ ...valid, auth: {} }, /auth.resolveActor must be a function/],
    [{ ...valid, directory: {} }, /directory.getUser must be a function/],
    [
      { ...valid, directory: { getUser() {} } },
      /directory.searchUsers must be a function/,
    ],
    [{ ...valid, permissions: {} }, /permissions.getCapabilities must be a function/],
    [
      { ...valid, permissions: { getCapabilities() {} } },
      /permissions.authorizeEntity must be a function/,
    ],
    [{ ...valid, admission: null }, /admission must be an object/],
    [{ ...valid, admission: {} }, /admission\.admit must be a function/],
    [
      { ...valid, admission: { admit: true } },
      /admission\.admit must be a function/,
    ],
  ];

  for (const [config, expected] of cases) {
    assert.throws(
      () => createChatServer(config),
      (error) =>
        error instanceof ChatServerConfigurationError && expected.test(error.message),
    );
  }
});

test("normalizes bounded WebSocket active-session revalidation configuration", async () => {
  const database = makeDatabase();
  const compatible = createChatServer(makeMinimalConfig(database.resource));
  assert.equal(
    compatible.config.webSocket.sessionRevalidationIntervalMs,
    DEFAULT_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  );
  await compatible.close();

  for (const sessionRevalidationIntervalMs of [
    MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
    MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  ]) {
    const runtime = createChatServer({
      ...makeMinimalConfig(database.resource),
      webSocket: { sessionRevalidationIntervalMs },
    });
    assert.equal(
      runtime.config.webSocket.sessionRevalidationIntervalMs,
      sessionRevalidationIntervalMs,
    );
    await runtime.close();
  }

  for (const sessionRevalidationIntervalMs of [
    MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS - 1,
    MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS + 1,
    5_000.5,
    "5000",
    null,
  ]) {
    assert.throws(
      () =>
        createChatServer({
          ...makeMinimalConfig(database.resource),
          webSocket: { sessionRevalidationIntervalMs },
        }),
      /webSocket\.sessionRevalidationIntervalMs must be a safe integer between/,
    );
  }

  assert.throws(
    () =>
      createChatServer({
        ...makeMinimalConfig(database.resource),
        auth: {
          ...requiredAdapters().auth,
          revalidateActiveSession: true,
        },
      }),
    /auth\.revalidateActiveSession must be a function/,
  );
});

test("schema validation matches the migration runner and precedes pool allocation", () => {
  let createPoolCount = 0;
  assert.throws(
    () =>
      createChatServer({
        database: {
          connectionString: "postgresql://chat.example/handrail",
          schema: "unsafe; DROP SCHEMA public",
          createPool() {
            createPoolCount += 1;
            return makeDatabase().resource;
          },
        },
        ...requiredAdapters(),
      }),
    /database.schema must be a PostgreSQL identifier/,
  );
  assert.equal(createPoolCount, 0);
});

test("clustered realtime requirements fail before pool allocation, workers, or providers", () => {
  let createPoolCount = 0;
  let providerCallCount = 0;
  const database = makeDatabase();
  const ownedDatabase = {
    connectionString: "postgresql://chat.example/handrail",
    createPool() {
      createPoolCount += 1;
      return database.resource;
    },
  };
  const validRealtime = {
    async publish() {
      providerCallCount += 1;
    },
    subscribe() {
      providerCallCount += 1;
      return () => {};
    },
  };
  const cases = [
    [
      { realtime: validRealtime, features: { realtime: false } },
      /realtimeDelivery clustered requires features\.realtime to be true/,
    ],
    [
      { features: { realtime: true } },
      /realtimeDelivery clustered requires the realtime adapter/,
    ],
    [
      { realtime: { async publish() {} }, features: { realtime: true } },
      /realtime\.subscribe must be a function/,
    ],
    [
      {
        realtime: { async publish() {}, subscribe: true },
        features: { realtime: true },
      },
      /realtime\.subscribe must be a function/,
    ],
  ];

  for (const [overrides, expected] of cases) {
    assert.throws(
      () =>
        createChatServer({
          database: ownedDatabase,
          ...requiredAdapters(),
          ...overrides,
          realtimeDelivery: "clustered",
        }),
      (error) =>
        error instanceof ChatServerConfigurationError &&
        expected.test(error.message),
    );
  }

  assert.throws(
    () =>
      createChatServer({
        database: ownedDatabase,
        ...requiredAdapters(),
        realtimeDelivery: "multi_region",
      }),
    /realtimeDelivery must be "single_process" or "clustered"/,
  );

  assert.equal(createPoolCount, 0);
  assert.equal(providerCallCount, 0);
});

test("enabled provider-backed features require their matching adapters", () => {
  const database = makeDatabase();
  const requiredByFeature = {
    attachments: "storage",
    notifications: "notifications",
    audit: "audit",
    realtime: "realtime",
    media: "media",
  };

  for (const [feature, adapter] of Object.entries(requiredByFeature)) {
    assert.throws(
      () =>
        createChatServer({
          ...makeMinimalConfig(database.resource),
          features: { [feature]: true },
        }),
      new RegExp(`features\\.${feature} requires the ${adapter} adapter`),
    );
  }

  assert.throws(
    () =>
      createChatServer({
        ...makeMinimalConfig(database.resource),
        notifications: makeOptionalAdapters().notifications,
        features: { notifications: true },
      }),
    /features\.notifications requires the pushTokenProtector adapter/,
  );

  assert.throws(
    () =>
      createChatServer({
        ...makeMinimalConfig(database.resource),
        features: { notifications: "yes" },
      }),
    /features.notifications must be a boolean/,
  );
});

test("push-token protector shape is validated even when notifications are disabled", async () => {
  const database = makeDatabase();
  const compatibleRuntime = createChatServer({
    ...makeMinimalConfig(database.resource),
    features: { notifications: false },
  });
  assert.equal(compatibleRuntime.config.adapters.pushTokenProtector, undefined);
  await compatibleRuntime.close();

  const malformedProtectors = [
    [null, /pushTokenProtector must be an object/],
    [{}, /pushTokenProtector\.protect must be a function/],
    [
      { unprotect() {} },
      /pushTokenProtector\.protect must be a function/,
    ],
    [
      { protect() {} },
      /pushTokenProtector\.unprotect must be a function/,
    ],
    [
      { protect() {}, unprotect: true },
      /pushTokenProtector\.unprotect must be a function/,
    ],
    [
      { protect: true, unprotect() {} },
      /pushTokenProtector\.protect must be a function/,
    ],
  ];

  for (const [pushTokenProtector, expectedError] of malformedProtectors) {
    assert.throws(
      () =>
        createChatServer({
          ...makeMinimalConfig(database.resource),
          pushTokenProtector,
          features: { notifications: false },
        }),
      expectedError,
    );
  }
});

test("invalid owned resources are cleaned up when construction cannot continue", () => {
  let endCount = 0;
  assert.throws(
    () =>
      createChatServer({
        database: {
          connectionString: "postgresql://chat.example/handrail",
          createPool() {
            return {
              async end() {
                endCount += 1;
              },
            };
          },
        },
        ...requiredAdapters(),
      }),
    /database.createPool result.query must be a function/,
  );
  assert.equal(endCount, 1);
});

const inactivityScope = {
  tenantId: "tenant-1",
  parentConversationId: "parent-1",
};

const makeInactivityRuntime = (t, policyConfig = {}) => {
  const runtime = createChatServer({
    ...makeMinimalConfig(makeDatabase().resource),
    ...policyConfig,
  });
  t.after(() => runtime.close());
  return runtime;
};

test("thread inactivity defaults and explicit disabling preserve legacy discovery", async (t) => {
  for (const policyConfig of [
    {},
    { threadInactivityPolicy: false },
    { threadInactivityPolicy: () => false },
    { threadInactivityPolicy: async () => false },
  ]) {
    const runtime = makeInactivityRuntime(t, policyConfig);
    assert.equal(await runtime.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), false);
    assert.equal("threadInactivityPolicy" in runtime.config, false);
  }
});

test("thread inactivity resolves lazily for each explicit tenant and parent", async (t) => {
  const calls = [];
  const runtime = makeInactivityRuntime(t, {
    threadInactivityPolicy: async (scope) => {
      calls.push(scope);
      assert.ok(Object.isFrozen(scope));
      if (scope.tenantId === "tenant-2") return { hideAfterMs: 120_000 };
      if (scope.parentConversationId === "parent-1") return { hideAfterMs: 60_000 };
      if (scope.parentConversationId === "parent-2") return { hideAfterMs: 30_000 };
      return false;
    },
  });
  assert.deepEqual(calls, []);
  const options = runtime.threadListHandlerOptions;
  assert.ok(Object.isFrozen(options));
  const enabled = await options.resolveInactivityPolicy(inactivityScope);
  assert.deepEqual(enabled, { hideAfterMs: 60_000 });
  assert.ok(Object.isFrozen(enabled));
  assert.deepEqual(
    await options.resolveInactivityPolicy({ ...inactivityScope, parentConversationId: "parent-2" }),
    { hideAfterMs: 30_000 },
  );
  assert.equal(
    await options.resolveInactivityPolicy({ ...inactivityScope, parentConversationId: "parent-3" }),
    false,
  );
  assert.deepEqual(
    await options.resolveInactivityPolicy({ ...inactivityScope, tenantId: "tenant-2" }),
    { hideAfterMs: 120_000 },
  );
  assert.equal(calls.length, 4);
});

test("thread inactivity rejects malformed configuration and durations without coercion", async (t) => {
  for (const configured of [null, true, 1000, "enabled", { hideAfterMs: 1000 }]) {
    const runtime = makeInactivityRuntime(t, { threadInactivityPolicy: configured });
    assert.equal(await runtime.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), false);
  }
  for (const value of [
    undefined, null, true, 1000, "1000", {}, [],
    { hideAfterMs: 1000, enabled: false },
    ...[undefined, null, false, "1000", 0, -1, NaN, Infinity, -Infinity, 1n].map((hideAfterMs) => ({ hideAfterMs })),
  ]) {
    const runtime = makeInactivityRuntime(t, { threadInactivityPolicy: () => value });
    assert.equal(await runtime.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), false);
  }
  const fractional = makeInactivityRuntime(t, { threadInactivityPolicy: () => ({ hideAfterMs: 0.5 }) });
  assert.deepEqual(await fractional.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), { hideAfterMs: 0.5 });
});

test("thread inactivity callback failures disable hiding and can recover on the next resolution", async (t) => {
  for (const fail of [
    () => { throw new Error("host policy failed"); },
    async () => { throw new Error("host lookup rejected"); },
    () => ({ get hideAfterMs() { throw new Error("invalid policy getter"); } }),
  ]) {
    let failing = true;
    const runtime = makeInactivityRuntime(t, {
      threadInactivityPolicy: () => failing ? fail() : { hideAfterMs: 1000 },
    });
    assert.equal(await runtime.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), false);
    failing = false;
    assert.deepEqual(await runtime.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), { hideAfterMs: 1000 });
    failing = true;
    assert.equal(await runtime.threadListHandlerOptions.resolveInactivityPolicy(inactivityScope), false);
  }
});

test("thread inactivity is independent of user identity and saved reply style", async (t) => {
  const scopes = [];
  const hostResult = { hideAfterMs: 1000 };
  const runtime = makeInactivityRuntime(t, {
    threadInactivityPolicy: (scope) => {
      scopes.push(scope);
      return hostResult;
    },
  });
  for (const [userId, replyStyle] of [["alice", "current"], ["bob", "discord"], ["alice", "discord"]]) {
    const result = await runtime.threadListHandlerOptions.resolveInactivityPolicy({
      ...inactivityScope, userId, replyStyle,
    });
    assert.deepEqual(result, { hideAfterMs: 1000 });
    assert.notEqual(result, hostResult);
  }
  assert.deepEqual(scopes, [inactivityScope, inactivityScope, inactivityScope]);
});
