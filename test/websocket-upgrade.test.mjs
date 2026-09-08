import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  CHAT_REALTIME_SUBPROTOCOL,
} from "@handrail/chat";
import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  CHAT_REQUEST_ADMISSION_DENIED_CODE,
  CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
  DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  createChatServer,
} from "@handrail/chat/server";
import { WebSocket } from "ws";

const database = {
  async query(sql) {
    if (sql.includes("SELECT EXISTS")) {
      return { rows: [{ exists: false }] };
    }
    throw new Error(`unexpected WebSocket metadata query: ${sql}`);
  },
  async connect() {
    throw new Error("WebSocket tests do not run migrations");
  },
};

const directory = {
  async getUser() {
    return null;
  },
  async searchUsers() {
    return [];
  },
};

const actors = new Map([
  [
    "Bearer tenant-a",
    { tenantId: "tenant-a", userId: "user-a", roles: ["employee"] },
  ],
  [
    "Bearer tenant-b",
    { tenantId: "tenant-b", userId: "user-b", roles: ["manager"] },
  ],
  [
    "Bearer tenant-c",
    { tenantId: "tenant-c", userId: "user-c", roles: ["employee"] },
  ],
  [
    "Bearer tenant-d",
    { tenantId: "tenant-d", userId: "user-d", roles: ["employee"] },
  ],
  [
    "Bearer forbidden",
    { tenantId: "tenant-a", userId: "forbidden", roles: ["employee"] },
  ],
]);

const createFixture = async (webSocket = {}, serverConfig = {}) => {
  const sessions = [];
  const authRequests = [];
  const runtime = createChatServer({
    database: { pool: database },
    auth: {
      async resolveActor(request) {
        authRequests.push({
          request,
          protocol: request.headers["sec-websocket-protocol"],
          rawHeaders: [...request.rawHeaders],
        });
        const actor = actors.get(request.headers.authorization);
        if (!actor) {
          throw new Error("private auth token or session detail");
        }
        return actor;
      },
    },
    directory,
    permissions: {
      async getCapabilities({ actor }) {
        if (actor.userId === "forbidden") {
          throw new Error("private role mapping database detail");
        }
        return [`messages:${actor.tenantId}`];
      },
      async authorizeEntity() {
        return true;
      },
    },
    ...serverConfig,
    webSocket: {
      handshakeTimeoutMs: 1_000,
      ...webSocket,
      onSession(socket, session) {
        sessions.push({ socket, session });
        webSocket.onSession?.(socket, session);
      },
    },
  });
  const server = createServer(runtime.router);
  runtime.attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  return {
    runtime,
    server,
    sessions,
    authRequests,
    url(path = DEFAULT_CHAT_WEBSOCKET_PATH) {
      return `ws://127.0.0.1:${address.port}${path}`;
    },
    async close() {
      await runtime.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

const validHandshake = (overrides = {}) => ({
  clientPackageVersion: "0.1.2",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  ...overrides,
});

const connect = (url, authorization, handshake = validHandshake()) => {
  const socket = new WebSocket(url, {
    headers: {
      authorization,
      "x-tenant-id": "spoofed-header-tenant",
      "x-user-id": "spoofed-header-user",
    },
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const message = new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
  opened.then(() => socket.send(JSON.stringify(handshake))).catch(() => {});
  return { socket, opened, message, closed };
};

const connectBrowser = (
  url,
  token,
  handshake = validHandshake(),
  options = undefined,
) => {
  const socket = new WebSocket(
    url,
    [
      CHAT_REALTIME_SUBPROTOCOL,
      `${CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX}${Buffer.from(token).toString("base64url")}`,
    ],
    options,
  );
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const message = new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
  opened.then(() => socket.send(JSON.stringify(handshake))).catch(() => {});
  return { socket, opened, message, closed };
};

const connectWithoutHandshake = (url, authorization) => {
  const socket = new WebSocket(url, {
    headers: { authorization },
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
  return { socket, opened, closed };
};

const requestRawUpgrade = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
    let response = "";
    let socketError;
    const timeout = setTimeout(() => {
      socket.destroy(new Error("raw WebSocket upgrade timed out"));
    }, 2_000);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", (error) => {
      socketError = error;
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (response.length === 0) {
        reject(socketError ?? new Error("upgrade socket closed without response"));
        return;
      }
      const [head = "", body = ""] = response.split("\r\n\r\n", 2);
      const lines = head.split("\r\n");
      const statusCode = Number(lines[0]?.split(" ")[1]);
      const responseHeaders = new Map(
        lines.slice(1).map((line) => {
          const separator = line.indexOf(":");
          return [
            line.slice(0, separator).toLowerCase(),
            line.slice(separator + 1).trim(),
          ];
        }),
      );
      resolve({
        statusCode,
        headers: responseHeaders,
        body,
        byteLength: Buffer.byteLength(response),
        closed: true,
      });
    });
    socket.on("connect", () => {
      const serializedHeaders = Object.entries(headers).map(
        ([name, value]) => `${name}: ${value}`,
      );
      socket.write(
        [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...serializedHeaders,
          "",
          "",
        ].join("\r\n"),
      );
    });
  });

const closeSocket = async (connection) => {
  if (
    connection.socket.readyState === WebSocket.OPEN ||
    connection.socket.readyState === WebSocket.CONNECTING
  ) {
    connection.socket.close();
  }
  await connection.closed;
};

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
};

test("admits the untouched upgrade once before browser credentials and auth", async () => {
  const events = [];
  const admissionInputs = [];
  const admissionSnapshots = [];
  let authRequest;
  const fixture = await createFixture(
    {},
    {
      admission: {
        async admit(input) {
          events.push("admission");
          admissionInputs.push(input);
          admissionSnapshots.push({
            url: input.request.url,
            authorization: input.request.headers.authorization,
            cookie: input.request.headers.cookie,
            protocol: input.request.headers["sec-websocket-protocol"],
            rawHeaders: [...input.request.rawHeaders],
          });
          await Promise.resolve();
          return { decision: "allow" };
        },
      },
      auth: {
        async resolveActor(request) {
          events.push("auth");
          authRequest = request;
          assert.equal(request.headers.authorization, "Bearer tenant-a");
          return actors.get("Bearer tenant-a");
        },
      },
    },
  );

  try {
    const connection = connectBrowser(
      fixture.url("/_realtime?token=raw-query-secret&tenantId=spoofed"),
      "tenant-a",
      validHandshake(),
      {
        headers: {
          cookie: "session=raw-cookie-secret",
          "x-tenant-id": "spoofed-header-tenant",
          "x-user-id": "spoofed-header-user",
        },
      },
    );
    await connection.message;

    assert.deepEqual(events.slice(0, 2), ["admission", "auth"]);
    assert.equal(admissionInputs.length, 1);
    assert.equal(admissionInputs[0].request, authRequest);
    assert.deepEqual(Object.keys(admissionInputs[0]).sort(), [
      "method",
      "request",
      "routeTemplate",
    ]);
    assert.equal(Object.isFrozen(admissionInputs[0]), true);
    assert.equal(admissionInputs[0].method, "GET");
    assert.equal(admissionInputs[0].routeTemplate, "/_realtime");
    assert.equal(
      admissionSnapshots[0].url,
      "/_realtime?token=raw-query-secret&tenantId=spoofed",
    );
    assert.equal(admissionSnapshots[0].authorization, undefined);
    assert.equal(admissionSnapshots[0].cookie, "session=raw-cookie-secret");
    assert.match(
      admissionSnapshots[0].protocol,
      new RegExp(CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX.replaceAll(".", "\\.")),
    );
    assert.match(admissionSnapshots[0].rawHeaders.join("\n"), /raw-cookie-secret/u);
    assert.doesNotMatch(admissionInputs[0].routeTemplate, /raw-query|spoofed/u);

    await closeSocket(connection);
  } finally {
    await fixture.close();
  }
});

test("denies an upgrade with one bounded sanitized 429 and no downstream work", async () => {
  const calls = {
    admission: 0,
    auth: 0,
    permissions: 0,
    metadata: 0,
    replay: 0,
    realtimePublish: 0,
    realtimeSubscribe: 0,
    sessionHandler: 0,
  };
  const trackedDatabase = {
    async query(sql, parameters) {
      if (sql.includes("SELECT EXISTS")) calls.metadata += 1;
      if (sql.includes("chat_realtime_events")) calls.replay += 1;
      return database.query(sql, parameters);
    },
    connect: database.connect,
  };
  const fixture = await createFixture(
    {
      onSession() {
        calls.sessionHandler += 1;
      },
    },
    {
      database: { pool: trackedDatabase },
      admission: {
        async admit() {
          calls.admission += 1;
          return { decision: "deny", retryAfterSeconds: 7.01 };
        },
      },
      auth: {
        async resolveActor() {
          calls.auth += 1;
          throw new Error("raw-auth-provider-secret");
        },
      },
      permissions: {
        async getCapabilities() {
          calls.permissions += 1;
          return [];
        },
        async authorizeEntity() {
          calls.permissions += 1;
          return true;
        },
      },
      realtime: {
        async publish() {
          calls.realtimePublish += 1;
        },
        subscribe() {
          calls.realtimeSubscribe += 1;
          return () => undefined;
        },
      },
    },
  );

  try {
    const response = await requestRawUpgrade(
      fixture.url("/_realtime?credential=raw-query-secret"),
      {
        Authorization: "Bearer raw-header-secret",
        Cookie: "session=raw-cookie-secret",
        "X-Tenant-Id": "spoofed-tenant",
      },
    );

    assert.equal(response.statusCode, 429);
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("retry-after"), "8");
    assert.equal(
      response.headers.get("content-length"),
      String(Buffer.byteLength(response.body)),
    );
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        code: CHAT_REQUEST_ADMISSION_DENIED_CODE,
        message: CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
      },
    });
    assert.equal(response.closed, true);
    assert.ok(response.byteLength < 512);
    assert.doesNotMatch(
      response.body,
      /raw-|secret|credential|spoofed|Bearer/iu,
    );
    assert.deepEqual(calls, {
      admission: 1,
      auth: 0,
      permissions: 0,
      metadata: 0,
      replay: 0,
      realtimePublish: 0,
      realtimeSubscribe: 0,
      sessionHandler: 0,
    });
    assert.equal(fixture.sessions.length, 0);
    assert.equal(fixture.runtime.webSocketSessionCount, 0);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
  } finally {
    await fixture.close();
  }
});

test("fails closed for thrown, rejected, and malformed admission outcomes", async () => {
  const hidden = Object.defineProperty(
    { decision: "allow" },
    "providerDetail",
    { value: "hidden-secret" },
  );
  const symbolExtra = Object.assign(
    { decision: "allow" },
    { [Symbol("provider-detail")]: "hidden-secret" },
  );
  const cases = [
    () => {
      throw new Error("thrown-provider-secret");
    },
    () => Promise.reject(new Error("rejected-provider-secret")),
    async () => undefined,
    async () => null,
    async () => [],
    async () => ({}),
    async () => ({ decision: "later" }),
    async () => ({ decision: "allow", providerDetail: "secret" }),
    async () => hidden,
    async () => symbolExtra,
    async () => ({ decision: "deny" }),
    async () => ({ decision: "deny", retryAfterSeconds: "30" }),
    async () => ({ decision: "deny", retryAfterSeconds: 0 }),
    async () => ({ decision: "deny", retryAfterSeconds: 3_601 }),
    async () => ({ decision: "deny", retryAfterSeconds: Number.NaN }),
    async () => ({ decision: "deny", retryAfterSeconds: Number.POSITIVE_INFINITY }),
    async () => ({
      decision: "deny",
      retryAfterSeconds: 30,
      providerDetail: "secret",
    }),
  ];

  for (const admit of cases) {
    let authCalls = 0;
    const fixture = await createFixture(
      {},
      {
        admission: { admit },
        auth: {
          async resolveActor() {
            authCalls += 1;
            return actors.get("Bearer tenant-a");
          },
        },
      },
    );
    try {
      const response = await requestRawUpgrade(fixture.url(), {
        Authorization: "Bearer outcome-test-secret",
      });
      assert.equal(response.statusCode, 429);
      assert.equal(
        response.headers.get("retry-after"),
        String(DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS),
      );
      assert.doesNotMatch(response.body, /provider|secret|outcome-test/iu);
      assert.equal(authCalls, 0);
    } finally {
      await fixture.close();
    }
  }
});

test("reports the canonical realtime route for a configured prefixed path", async () => {
  const inputs = [];
  const fixture = await createFixture(
    { path: "/chat/prefix/socket" },
    {
      admission: {
        async admit(input) {
          inputs.push(input);
          return { decision: "allow" };
        },
      },
    },
  );
  try {
    const connection = connect(
      fixture.url("/chat/prefix/socket?raw=secret"),
      "Bearer tenant-a",
    );
    await connection.message;
    assert.equal(inputs.length, 1);
    assert.deepEqual(
      { method: inputs[0].method, routeTemplate: inputs[0].routeTemplate },
      { method: "GET", routeTemplate: "/_realtime" },
    );
    await closeSocket(connection);
  } finally {
    await fixture.close();
  }
});

test("does not admit nonmatching upgrade paths", async () => {
  let admissionCalls = 0;
  const outcomes = [];
  const fixture = await createFixture(
    { onUpgradeOutcome: (outcome) => outcomes.push(outcome) },
    {
      admission: {
        async admit() {
          admissionCalls += 1;
          return { decision: "allow" };
        },
      },
    },
  );
  fixture.server.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  try {
    const response = await requestRawUpgrade(fixture.url("/not-chat?secret=1"));
    assert.equal(response.statusCode, 404);
    assert.equal(admissionCalls, 0);
    assert.deepEqual(outcomes, []);
  } finally {
    await fixture.close();
  }
});

test("emits one frozen sanitized accepted outcome with trusted identity and fake-clock duration", async () => {
  const outcomes = [];
  const clockValues = [40, 54];
  const fixture = await createFixture({
    now: () => clockValues.shift(),
    onUpgradeOutcome(outcome) {
      outcomes.push(outcome);
    },
  });
  try {
    const connection = connectBrowser(
      fixture.url("/_realtime?token=raw-query-secret&stream=private-stream-secret"),
      "tenant-a",
      validHandshake(),
      {
        headers: {
          cookie: "session=raw-cookie-secret",
          authorization: "Bearer tenant-a",
          "x-sensitive-header": "raw-header-secret",
        },
      },
    );
    await connection.message;
    await waitFor(() => outcomes.length === 1);
    assert.deepEqual(outcomes, [
      {
        status: "accepted",
        durationMs: 14,
        tenantId: "tenant-a",
        userId: "user-a",
      },
    ]);
    assert.equal(Object.isFrozen(outcomes[0]), true);
    assert.deepEqual(Object.keys(outcomes[0]).sort(), [
      "durationMs",
      "status",
      "tenantId",
      "userId",
    ]);
    assert.doesNotMatch(
      JSON.stringify(outcomes),
      /raw-query|private-stream|raw-cookie|raw-header|Bearer|handrail\.chat\.bearer/iu,
    );

    await closeSocket(connection);
    await Promise.resolve();
    assert.equal(outcomes.length, 1);
  } finally {
    await fixture.close();
  }
});

test("emits every sanitized upgrade rejection status with exactly-once identity gating", async (t) => {
  const runSingle = async ({
    expectedStatus,
    webSocket = {},
    serverConfig = {},
    act,
    expectedIdentity,
  }) => {
    const outcomes = [];
    let now = 100;
    const fixture = await createFixture(
      {
        ...webSocket,
        now: () => now++,
        onUpgradeOutcome: (outcome) => outcomes.push(outcome),
      },
      serverConfig,
    );
    try {
      await act(fixture);
      await waitFor(() => outcomes.length === 1);
      assert.equal(outcomes[0].status, expectedStatus);
      assert.equal(outcomes[0].durationMs >= 0, true);
      assert.equal(Object.isFrozen(outcomes[0]), true);
      assert.deepEqual(
        Object.keys(outcomes[0]).sort(),
        expectedIdentity === undefined
          ? ["durationMs", "status"]
          : ["durationMs", "status", "tenantId", "userId"],
      );
      if (expectedIdentity !== undefined) {
        assert.deepEqual(
          {
            tenantId: outcomes[0].tenantId,
            userId: outcomes[0].userId,
          },
          expectedIdentity,
        );
      }
      assert.doesNotMatch(
        JSON.stringify(outcomes),
        /raw-query-secret|raw-header-secret|raw-cookie-secret|adapter-secret|stream-secret/iu,
      );
      await Promise.resolve();
      assert.equal(outcomes.length, 1);
    } finally {
      await fixture.close();
    }
  };

  await t.test("admission_denied", () =>
    runSingle({
      expectedStatus: "admission_denied",
      serverConfig: {
        admission: {
          async admit() {
            return { decision: "deny", retryAfterSeconds: 1 };
          },
        },
      },
      async act(fixture) {
        const response = await requestRawUpgrade(
          fixture.url("/_realtime?token=raw-query-secret"),
          {
            Authorization: "Bearer raw-header-secret",
            Cookie: "session=raw-cookie-secret",
          },
        );
        assert.equal(response.statusCode, 429);
      },
    }),
  );

  await t.test("authentication_failed", () =>
    runSingle({
      expectedStatus: "authentication_failed",
      async act(fixture) {
        const connection = connect(
          fixture.url("/_realtime?token=raw-query-secret"),
          "Bearer raw-header-secret",
        );
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed,
        );
      },
    }),
  );

  await t.test("authorization_failed", () =>
    runSingle({
      expectedStatus: "authorization_failed",
      async act(fixture) {
        const connection = connect(fixture.url(), "Bearer forbidden");
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed,
        );
      },
    }),
  );

  await t.test("malformed_handshake", () =>
    runSingle({
      expectedStatus: "malformed_handshake",
      expectedIdentity: { tenantId: "tenant-a", userId: "user-a" },
      async act(fixture) {
        const connection = connect(
          fixture.url(),
          "Bearer tenant-a",
          { protocolVersion: CHAT_PROTOCOL_VERSION },
        );
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
        );
      },
    }),
  );

  await t.test("handshake_timeout", () =>
    runSingle({
      expectedStatus: "handshake_timeout",
      webSocket: { handshakeTimeoutMs: 10 },
      expectedIdentity: { tenantId: "tenant-a", userId: "user-a" },
      async act(fixture) {
        const connection = connectWithoutHandshake(
          fixture.url(),
          "Bearer tenant-a",
        );
        await connection.opened;
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.handshakeTimeout,
        );
      },
    }),
  );

  await t.test("unsupported_protocol", () =>
    runSingle({
      expectedStatus: "unsupported_protocol",
      expectedIdentity: { tenantId: "tenant-a", userId: "user-a" },
      async act(fixture) {
        const connection = connect(
          fixture.url(),
          "Bearer tenant-a",
          validHandshake({ protocolVersion: CHAT_PROTOCOL_VERSION + 1 }),
        );
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.unsupportedProtocol,
        );
      },
    }),
  );

  await t.test("snapshot_required", () =>
    runSingle({
      expectedStatus: "snapshot_required",
      serverConfig: {
        features: { realtime: false },
        realtime: { async publish() {} },
      },
      expectedIdentity: { tenantId: "tenant-a", userId: "user-a" },
      async act(fixture) {
        const connection = connect(
          fixture.url(),
          "Bearer tenant-a",
          validHandshake({ resumeFrom: { eventId: "stream-secret" } }),
        );
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired,
        );
        assert.equal(
          (await connection.message).type,
          "chat.session.snapshot_required",
        );
      },
    }),
  );

  await t.test("connection_limit", async () => {
    const outcomes = [];
    let now = 200;
    const fixture = await createFixture({
      maxConnections: 3,
      maxConnectionsPerTenant: 1,
      now: () => now++,
      onUpgradeOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      const accepted = connect(fixture.url(), "Bearer tenant-a");
      await accepted.message;
      await waitFor(() => outcomes.length === 1);
      const limited = connect(fixture.url(), "Bearer tenant-a");
      assert.deepEqual(
        await limited.closed,
        CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit,
      );
      await waitFor(() => outcomes.length === 2);
      assert.deepEqual(
        outcomes.map(({ status }) => status),
        ["accepted", "connection_limit"],
      );
      assert.deepEqual(outcomes[1], {
        status: "connection_limit",
        durationMs: 1,
        tenantId: "tenant-a",
        userId: "user-a",
      });
      assert.equal(Object.isFrozen(outcomes[1]), true);
      await closeSocket(accepted);
      assert.equal(outcomes.length, 2);
    } finally {
      await fixture.close();
    }
  });

  await t.test("internal_error", () =>
    runSingle({
      expectedStatus: "internal_error",
      webSocket: {
        onSession() {
          throw new Error("adapter-secret");
        },
      },
      expectedIdentity: { tenantId: "tenant-a", userId: "user-a" },
      async act(fixture) {
        const connection = connect(fixture.url(), "Bearer tenant-a");
        assert.deepEqual(
          await connection.closed,
          CHAT_WEBSOCKET_CLOSE_REASONS.internalError,
        );
      },
    }),
  );
});

test("isolates throwing and asynchronously rejecting upgrade outcome observers", async () => {
  for (const onUpgradeOutcome of [
    () => {
      throw new Error("observer throw");
    },
    async () => {
      throw new Error("observer rejection");
    },
  ]) {
    const fixture = await createFixture({ onUpgradeOutcome });
    try {
      const connection = connect(fixture.url(), "Bearer tenant-a");
      assert.equal((await connection.message).type, "chat.session.accepted");
      assert.equal(fixture.runtime.webSocketSessionCount, 1);
      await Promise.resolve();
      await closeSocket(connection);
    } finally {
      await fixture.close();
    }
  }
});

test("late admission cannot continue after WebSocket detach", async () => {
  let resolveAdmission;
  const pendingAdmission = new Promise((resolve) => {
    resolveAdmission = resolve;
  });
  let admissionCalls = 0;
  let authCalls = 0;
  const fixture = await createFixture(
    {},
    {
      admission: {
        admit() {
          admissionCalls += 1;
          return pendingAdmission;
        },
      },
      auth: {
        async resolveActor() {
          authCalls += 1;
          return actors.get("Bearer tenant-a");
        },
      },
    },
  );
  try {
    const connection = connect(fixture.url(), "Bearer tenant-a");
    await waitFor(() => admissionCalls === 1);
    fixture.runtime.detachWebSocket();
    resolveAdmission({ decision: "allow" });
    await connection.closed;
    await Promise.resolve();
    assert.equal(authCalls, 0);
    assert.equal(fixture.runtime.webSocketSessionCount, 0);
  } finally {
    await fixture.close();
  }
});

test("accepts a compatible trusted session and ignores request identity spoofing", async () => {
  const fixture = await createFixture();
  try {
    const connection = connect(
      fixture.url("/_realtime?tenantId=query-spoof&userId=query-spoof"),
      "Bearer tenant-a",
    );
    const accepted = await connection.message;

    assert.equal(accepted.type, "chat.session.accepted");
    assert.equal(accepted.metadata.protocolVersion, CHAT_PROTOCOL_VERSION);
    assert.equal(fixture.authRequests.length, 1);
    assert.equal(fixture.runtime.webSocketSessionCount, 1);
    assert.equal(fixture.sessions.length, 1);
    const { session } = fixture.sessions[0];
    assert.deepEqual(session.actor, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["employee"],
    });
    assert.deepEqual(session.capabilities, ["messages:tenant-a"]);
    assert.equal(Object.isFrozen(session), true);
    assert.equal(Object.isFrozen(session.actor), true);
    assert.equal(Object.isFrozen(session.metadata), true);
    assert.throws(() => {
      session.actor.userId = "spoofed";
    }, TypeError);

    await closeSocket(connection);
    await waitFor(() => fixture.runtime.webSocketSessionCount === 0);
  } finally {
    await fixture.close();
  }
});

test("accepts browser subprotocol authentication without reflecting the credential", async () => {
  const fixture = await createFixture();
  try {
    const connection = connectBrowser(fixture.url(), "tenant-a");
    const accepted = await connection.message;

    assert.equal(connection.socket.protocol, CHAT_REALTIME_SUBPROTOCOL);
    assert.equal(accepted.tenantId, "tenant-a");
    assert.equal(accepted.actorStreamId, "user:user-a");
    assert.equal(
      fixture.authRequests.at(-1).protocol,
      CHAT_REALTIME_SUBPROTOCOL,
    );
    assert.doesNotMatch(
      fixture.authRequests.at(-1).rawHeaders.join("\n"),
      new RegExp(CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX.replaceAll(".", "\\.")),
    );
    assert.deepEqual(fixture.sessions[0].session.actor, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["employee"],
    });
    assert.doesNotMatch(JSON.stringify(accepted), /Bearer|tenant-a\.$/);
    await closeSocket(connection);
  } finally {
    await fixture.close();
  }
});

test("returns sanitized authentication, authorization, and spoofing reasons", async () => {
  const fixture = await createFixture();
  try {
    const unauthenticated = connect(fixture.url(), "Bearer invalid");
    assert.deepEqual(
      await unauthenticated.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed,
    );

    const unauthorized = connect(fixture.url(), "Bearer forbidden");
    assert.deepEqual(
      await unauthorized.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed,
    );

    const spoofed = connect(
      fixture.url(),
      "Bearer tenant-a",
      validHandshake({ tenantId: "tenant-b", userId: "user-b" }),
    );
    assert.deepEqual(
      await spoofed.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.identitySpoofing,
    );
    assert.equal(fixture.sessions.length, 0);
  } finally {
    await fixture.close();
  }
});

test("returns stable reasons for malformed and unsupported handshakes", async () => {
  const fixture = await createFixture();
  try {
    const malformed = connect(fixture.url(), "Bearer tenant-a", {
      protocolVersion: CHAT_PROTOCOL_VERSION,
    });
    assert.deepEqual(
      await malformed.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
    );

    const unsupported = connect(
      fixture.url(),
      "Bearer tenant-a",
      validHandshake({ protocolVersion: CHAT_PROTOCOL_VERSION + 1 }),
    );
    assert.deepEqual(
      await unsupported.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.unsupportedProtocol,
    );
    assert.equal(fixture.sessions.length, 0);
  } finally {
    await fixture.close();
  }
});

test("enforces and releases global and per-tenant connection limits", async () => {
  const fixture = await createFixture({
    maxConnections: 3,
    maxConnectionsPerTenant: 1,
  });
  try {
    const [tenantA, tenantB] = [
      connect(fixture.url(), "Bearer tenant-a"),
      connect(fixture.url(), "Bearer tenant-b"),
    ];
    await Promise.all([tenantA.message, tenantB.message]);
    assert.equal(fixture.runtime.webSocketSessionCount, 2);

    const sameTenant = connect(fixture.url(), "Bearer tenant-a");
    assert.deepEqual(
      await sameTenant.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit,
    );

    const tenantC = connect(fixture.url(), "Bearer tenant-c");
    await tenantC.message;
    const globalLimit = connect(fixture.url(), "Bearer tenant-d");
    assert.deepEqual(
      await globalLimit.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit,
    );

    const trustedSessions = fixture.sessions
      .map(({ session }) => [
        session.actor.tenantId,
        session.actor.userId,
        session.capabilities[0],
      ])
      .sort(([left], [right]) => left.localeCompare(right));
    assert.deepEqual(trustedSessions, [
      ["tenant-a", "user-a", "messages:tenant-a"],
      ["tenant-b", "user-b", "messages:tenant-b"],
      ["tenant-c", "user-c", "messages:tenant-c"],
    ]);

    await closeSocket(tenantA);
    await waitFor(() => fixture.runtime.webSocketSessionCount === 2);
    const replacement = connect(fixture.url(), "Bearer tenant-d");
    await replacement.message;
    assert.equal(fixture.runtime.webSocketSessionCount, 3);

    await Promise.all([
      closeSocket(tenantB),
      closeSocket(tenantC),
      closeSocket(replacement),
    ]);
  } finally {
    await fixture.close();
  }
});

test("detach and runtime close remove listeners and sessions idempotently", async () => {
  const fixture = await createFixture();
  try {
    assert.equal(fixture.server.listenerCount("upgrade"), 1);
    const first = connect(fixture.url(), "Bearer tenant-a");
    await first.message;
    assert.equal(fixture.runtime.webSocketSessionCount, 1);

    fixture.runtime.detachWebSocket();
    fixture.runtime.detachWebSocket();
    assert.equal(fixture.server.listenerCount("upgrade"), 0);
    assert.equal(fixture.runtime.webSocketSessionCount, 0);
    await first.closed;

    fixture.runtime.attachWebSocket(fixture.server);
    assert.equal(fixture.server.listenerCount("upgrade"), 1);
    const second = connect(fixture.url(), "Bearer tenant-b");
    await second.message;

    const firstClose = fixture.runtime.close();
    const secondClose = fixture.runtime.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.equal(fixture.server.listenerCount("upgrade"), 0);
    assert.equal(fixture.runtime.webSocketSessionCount, 0);
    assert.equal(fixture.server.listening, true);
    await second.closed;
    assert.throws(
      () => fixture.runtime.attachWebSocket(fixture.server),
      /runtime is closed/,
    );
  } finally {
    await fixture.close();
  }
});
