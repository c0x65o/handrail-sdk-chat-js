import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES,
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES,
  MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  createChatServer,
} from "@handrail/chat/server";
import { WebSocket } from "ws";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const eventually = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("condition was not met");
};

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const createFixture = async (
  { revalidate, getCapabilities, authorizeEntity } = {},
) => {
  const sessions = [];
  const revalidationInputs = [];
  const capabilityInputs = [];
  let authenticatedRequest;
  const database = {
    async query(sql) {
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes("current_member.state AS member_state")) {
        return {
          rows: [
            {
              type: "channel",
              visibility: "public",
              entity_type: "project",
              entity_id: "secure",
              archived_at: null,
              member_state: null,
            },
          ],
        };
      }
      if (sql.includes("WITH claimable AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected session revalidation query: ${sql}`);
    },
    async connect() {
      throw new Error("session revalidation tests do not run migrations");
    },
  };
  const initialActor = {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["reader"],
  };
  const auth = {
    async resolveActor(request) {
      authenticatedRequest = request;
      request.hostSession = Object.freeze({ id: "host-session-a" });
      return initialActor;
    },
    ...(revalidate === undefined
      ? {}
      : {
          async revalidateActiveSession(input) {
            revalidationInputs.push(input);
            return revalidate(input);
          },
        }),
  };
  const runtime = createChatServer({
    database: { pool: database },
    auth,
    directory: {
      async getUser() {
        return null;
      },
      async searchUsers() {
        return [];
      },
    },
    permissions: {
      async getCapabilities(input) {
        capabilityInputs.push(input);
        return getCapabilities?.(input) ?? [
          input.actor.roles.includes("reader")
            ? "messages.read"
            : "messages.metadata",
        ];
      },
      async authorizeEntity(input) {
        return authorizeEntity?.(input) ?? input.actor.roles.includes("reader");
      },
    },
    webSocket: {
      handshakeTimeoutMs: 1_000,
      sessionRevalidationIntervalMs:
        MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
      onSession(socket, session) {
        sessions.push({ socket, session });
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
    revalidationInputs,
    capabilityInputs,
    get authenticatedRequest() {
      return authenticatedRequest;
    },
    url: `ws://127.0.0.1:${address.port}/_realtime`,
    async close() {
      await runtime.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

const connect = async (fixture) => {
  const socket = new WebSocket(fixture.url, {
    headers: { authorization: "Bearer private-session-credential" },
  });
  const messages = [];
  const waiters = [];
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter === undefined) messages.push(message);
    else waiter(message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      clientPackageVersion: "0.1.3",
      protocolVersion: CHAT_PROTOCOL_VERSION,
    }),
  );
  const nextMessage = () =>
    messages.length > 0
      ? Promise.resolve(messages.shift())
      : new Promise((resolve) => waiters.push(resolve));
  assert.equal((await nextMessage()).type, "chat.session.accepted");
  return { socket, closed, nextMessage };
};

const closeConnection = async (connection) => {
  if (connection.socket.readyState < WebSocket.CLOSING) {
    connection.socket.close();
  }
  await connection.closed;
};

const advanceRevalidation = async (mock) => {
  mock.timers.tick(MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS);
  await flush();
};

const cleanupSocket = async (kind, fixture, connection) => {
  if (kind === "socket") {
    await closeConnection(connection);
  } else if (kind === "detach") {
    fixture.runtime.detachWebSocket();
    await connection.closed;
  } else {
    await fixture.runtime.close();
    await connection.closed;
  }
};

test("resolveActor-only adapters retain existing behavior without periodic checks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await createFixture();
  try {
    const connection = await connect(fixture);
    t.mock.timers.tick(
      MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS * 10,
    );
    await flush();
    assert.equal(connection.socket.readyState, WebSocket.OPEN);
    assert.equal(fixture.runtime.webSocketSessionCount, 1);
    await closeConnection(connection);
  } finally {
    await fixture.close();
  }
});

test("active renewal retains the socket and reuses only the trusted session boundary", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await createFixture({
    revalidate: ({ actor }) => ({ ...actor, roles: [...actor.roles] }),
  });
  try {
    const connection = await connect(fixture);
    await advanceRevalidation(t.mock);
    await eventually(() => fixture.revalidationInputs.length === 1);

    assert.equal(connection.socket.readyState, WebSocket.OPEN);
    assert.equal(fixture.runtime.webSocketSessionCount, 1);
    assert.equal(
      fixture.revalidationInputs[0].request,
      fixture.authenticatedRequest,
    );
    assert.equal(
      fixture.revalidationInputs[0].request.headers.authorization,
      undefined,
    );
    assert.deepEqual(fixture.revalidationInputs[0].request.hostSession, {
      id: "host-session-a",
    });
    assert.doesNotMatch(
      fixture.revalidationInputs[0].request.rawHeaders.join("\n"),
      /private-session-credential/,
    );
    assert.deepEqual(Object.keys(fixture.revalidationInputs[0]).sort(), [
      "actor",
      "request",
    ]);
    assert.deepEqual(fixture.revalidationInputs[0].actor, {
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["reader"],
    });
    await closeConnection(connection);
  } finally {
    await fixture.close();
  }
});

test("revoked, expired, malformed, and identity-changing sessions fail closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cases = [
    ["revoked", () => null],
    ["expired", () => Promise.reject(new Error("private expiry timestamp"))],
    ["malformed", () => ({ tenantId: "tenant-a", userId: "user-a", roles: "reader" })],
    ["tenant changed", ({ actor }) => ({ ...actor, tenantId: "tenant-b" })],
    ["user changed", ({ actor }) => ({ ...actor, userId: "user-b" })],
  ];

  for (const [name, revalidate] of cases) {
    await t.test(name, async () => {
      const fixture = await createFixture({ revalidate });
      try {
        const connection = await connect(fixture);
        await advanceRevalidation(t.mock);
        assert.deepEqual(await connection.closed, {
          code: CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed.code,
          reason: CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed.reason,
        });
        assert.doesNotMatch(
          CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed.reason,
          /private|expiry|credential/,
        );
      } finally {
        await fixture.close();
      }
    });
  }
});

test("role and capability refresh revokes only newly unauthorized streams", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await createFixture({
    revalidate: ({ actor }) => ({ ...actor, roles: ["limited"] }),
  });
  try {
    const connection = await connect(fixture);
    connection.socket.send(
      JSON.stringify({
        type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
        requestId: "subscribe-secure",
        streamId: "secure-conversation",
      }),
    );
    assert.equal(
      (await connection.nextMessage()).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );
    connection.socket.send(
      JSON.stringify({
        type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
        requestId: "subscribe-user",
        streamId: "user:user-a",
      }),
    );
    assert.equal(
      (await connection.nextMessage()).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );

    await advanceRevalidation(t.mock);
    const revoked = await connection.nextMessage();
    assert.deepEqual(revoked, {
      type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.revoked,
      code: CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessRevoked,
      streamId: "secure-conversation",
    });
    const { session } = fixture.sessions[0];
    assert.deepEqual(session.actor.roles, ["limited"]);
    assert.deepEqual(session.capabilities, ["messages.metadata"]);
    assert.equal(Object.isFrozen(session.actor), true);
    assert.equal(Object.isFrozen(session.capabilities), true);
    assert.deepEqual(session.subscriptions.streamIds, ["user:user-a"]);
    assert.equal(session.subscriptions.size, 1);
    assert.equal(connection.socket.readyState, WebSocket.OPEN);
    await closeConnection(connection);
  } finally {
    await fixture.close();
  }
});

test("capability refresh failures close with only the authorization reason", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let capabilityCalls = 0;
  const fixture = await createFixture({
    revalidate: ({ actor }) => actor,
    getCapabilities() {
      capabilityCalls += 1;
      if (capabilityCalls > 1) {
        throw new Error("private capability provider detail");
      }
      return ["messages.read"];
    },
  });
  try {
    const connection = await connect(fixture);
    await advanceRevalidation(t.mock);
    assert.deepEqual(await connection.closed, {
      code: CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed.code,
      reason: CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed.reason,
    });
  } finally {
    await fixture.close();
  }
});

test("elapsed intervals never overlap an in-flight session check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const fixture = await createFixture({
    revalidate() {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
  });
  try {
    const connection = await connect(fixture);
    await advanceRevalidation(t.mock);
    await eventually(() => calls === 1);
    t.mock.timers.tick(
      MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS * 10,
    );
    await flush();
    assert.equal(calls, 1);

    first.resolve({
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["reader"],
    });
    await eventually(() => fixture.capabilityInputs.length === 2);
    await flush();
    await advanceRevalidation(t.mock);
    await eventually(() => calls === 2);
    assert.equal(calls, 2);
    second.resolve({
      tenantId: "tenant-a",
      userId: "user-a",
      roles: ["reader"],
    });
    await closeConnection(connection);
  } finally {
    await fixture.close();
  }
});

test("socket close, detach, and runtime close suppress late checks and results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cleanup of ["socket", "detach", "runtime"]) {
    await t.test(cleanup, async () => {
      let scheduledCalls = 0;
      const scheduledFixture = await createFixture({
        revalidate({ actor }) {
          scheduledCalls += 1;
          return actor;
        },
      });
      try {
        const scheduledConnection = await connect(scheduledFixture);
        await cleanupSocket(cleanup, scheduledFixture, scheduledConnection);
        t.mock.timers.tick(
          MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS * 10,
        );
        await flush();
        assert.equal(scheduledCalls, 0);
      } finally {
        await scheduledFixture.close();
      }

      const pending = deferred();
      let calls = 0;
      const fixture = await createFixture({
        revalidate() {
          calls += 1;
          return pending.promise;
        },
      });
      try {
        const connection = await connect(fixture);
        await advanceRevalidation(t.mock);
        await eventually(() => calls === 1);
        await cleanupSocket(cleanup, fixture, connection);
        pending.resolve({
          tenantId: "tenant-a",
          userId: "user-a",
          roles: ["changed-after-close"],
        });
        await flush();
        t.mock.timers.tick(
          MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS * 10,
        );
        await flush();
        assert.equal(calls, 1);
        assert.equal(fixture.runtime.webSocketSessionCount, 0);
      } finally {
        await fixture.close();
      }
    });
  }
});
