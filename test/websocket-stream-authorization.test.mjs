import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES,
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES,
  CHAT_WEBSOCKET_SUBSCRIPTION_POLICY_ACTION,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  createChatServer,
} from "@handrail/chat/server";
import { WebSocket } from "ws";

const actors = new Map([
  [
    "Bearer actor-a",
    { tenantId: "tenant-a", userId: "user-a", roles: ["employee"] },
  ],
  [
    "Bearer actor-a2",
    { tenantId: "tenant-a", userId: "user-a2", roles: ["employee"] },
  ],
  [
    "Bearer actor-b",
    { tenantId: "tenant-b", userId: "user-b", roles: ["employee"] },
  ],
]);

const conversationKey = (tenantId, id) => JSON.stringify([tenantId, id]);
const entityKey = (entity) => JSON.stringify([entity.type, entity.id]);

const addConversation = (conversations, input) => {
  const conversation = {
    archivedAt: null,
    members: new Map(),
    entity: null,
    ...input,
  };
  conversations.set(
    conversationKey(conversation.tenantId, conversation.id),
    conversation,
  );
  return conversation;
};

const createFixture = async ({ authorizeEntity } = {}) => {
  const conversations = new Map();
  const entityAccess = new Map();
  const entityFailures = new Set();
  const entityChecks = [];
  const sessions = [];

  const database = {
    async query(sql, values = []) {
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes("current_member.state AS member_state")) {
        const [tenantId, conversationId, userId] = values;
        const conversation = conversations.get(
          conversationKey(tenantId, conversationId),
        );
        if (conversation === undefined) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              type: conversation.type,
              visibility: conversation.visibility,
              entity_type: conversation.entity?.type ?? null,
              entity_id: conversation.entity?.id ?? null,
              archived_at: conversation.archivedAt,
              member_state: conversation.members.get(userId) ?? null,
            },
          ],
        };
      }
      if (sql.includes("WITH claimable AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected socket authorization query: ${sql}`);
    },
    async connect() {
      throw new Error("socket authorization tests do not run migrations");
    },
  };

  const runtime = createChatServer({
    database: { pool: database },
    auth: {
      async resolveActor(request) {
        const actor = actors.get(request.headers.authorization);
        if (actor === undefined) {
          throw new Error("private authentication detail");
        }
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
        return ["messages.read"];
      },
      async authorizeEntity(input) {
        entityChecks.push(input);
        if (authorizeEntity !== undefined) {
          return authorizeEntity(input);
        }
        const key = entityKey(input.entity);
        if (entityFailures.has(key)) {
          throw new Error("private host adapter failure detail");
        }
        return entityAccess.get(key) ?? true;
      },
    },
    webSocket: {
      handshakeTimeoutMs: 1_000,
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
    conversations,
    entityAccess,
    entityFailures,
    entityChecks,
    sessions,
    runtime,
    server,
    url: `ws://127.0.0.1:${address.port}${DEFAULT_CHAT_WEBSOCKET_PATH}`,
    async close() {
      await runtime.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

const connect = async (url, authorization) => {
  const socket = new WebSocket(url, { headers: { authorization } });
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
    if (waiter === undefined) {
      messages.push(message);
    } else {
      waiter(message);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const nextMessage = () =>
    messages.length > 0
      ? Promise.resolve(messages.shift())
      : new Promise((resolve) => waiters.push(resolve));
  socket.send(
    JSON.stringify({
      clientPackageVersion: "0.1.3",
      protocolVersion: CHAT_PROTOCOL_VERSION,
    }),
  );
  const accepted = await nextMessage();
  assert.equal(accepted.type, "chat.session.accepted");

  return { socket, closed, nextMessage };
};

let requestSequence = 0;
const sendRequest = async (connection, type, streamId, extra = {}) => {
  requestSequence += 1;
  const requestId = `request-${requestSequence}`;
  connection.socket.send(
    JSON.stringify({ type, requestId, streamId, ...extra }),
  );
  return connection.nextMessage();
};

const subscribe = (connection, streamId, extra) =>
  sendRequest(
    connection,
    CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
    streamId,
    extra,
  );

const unsubscribe = (connection, streamId) =>
  sendRequest(
    connection,
    CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe,
    streamId,
  );

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
};

// The fixed admission contract includes the active handler, not just waiters.
const MAX_PENDING_INBOUND_MESSAGES = 32;

const createGatedFixture = async () => {
  let nextGate;
  let failAuthorization = false;
  const gates = [];
  const fixture = await createFixture({
    async authorizeEntity() {
      const gate = nextGate;
      nextGate = undefined;
      if (gate !== undefined) {
        gate.entered.resolve();
        await gate.released.promise;
      }
      if (failAuthorization) throw new Error("private adapter rejection");
      return true;
    },
  });
  addConversation(fixture.conversations, {
    tenantId: "tenant-a",
    id: "gated",
    type: "channel",
    visibility: "public",
    entity: { type: "order", id: "gated" },
  });
  return {
    ...fixture,
    pause({ reject = false } = {}) {
      assert.equal(nextGate, undefined);
      failAuthorization = reject;
      const gate = {
        entered: Promise.withResolvers(),
        released: Promise.withResolvers(),
      };
      gates.push(gate);
      nextGate = gate;
      return { entered: gate.entered.promise, release: gate.released.resolve };
    },
    async close() {
      for (const gate of gates) gate.released.resolve();
      await fixture.close();
    },
  };
};

const sendGatedRequest = (connection, requestId) => {
  connection.socket.send(JSON.stringify({
    type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
    streamId: "gated",
    requestId,
  }));
};

// A pong proves all preceding frames reached the server's synchronous message
// listeners, even while application authorization is paused.
const flushInbound = async (connection) => {
  const pong = once(connection.socket, "pong");
  connection.socket.ping();
  await pong;
};

test("inbound admission closes on frame 33 while the active authorization is paused", { timeout: 5_000 }, async (t) => {
  const fixture = await createGatedFixture();
  t.after(() => fixture.close());
  const connection = await connect(fixture.url, "Bearer actor-a");
  const { socket, session } = fixture.sessions[0];
  const responses = [];
  connection.socket.on("message", (data) => responses.push(JSON.parse(data.toString())));
  const gate = fixture.pause();
  sendGatedRequest(connection, "active");
  await gate.entered;
  for (let index = 1; index < MAX_PENDING_INBOUND_MESSAGES; index += 1) {
    sendGatedRequest(connection, `queued-${index}`);
  }
  await flushInbound(connection);
  assert.equal(socket.readyState, WebSocket.OPEN, "all 32 slots are admitted");
  assert.equal(fixture.entityChecks.length, 1);

  const excessReceived = once(socket, "message");
  sendGatedRequest(connection, "excess");
  await excessReceived;
  assert.notEqual(socket.readyState, WebSocket.OPEN, "frame 33 closes synchronously at admission");
  assert.deepEqual(await connection.closed, { code: 4429, reason: "connection_limit" });
  assert.equal(fixture.entityChecks.length, 1, "closure does not wait for the adapter");
  assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);

  gate.release();
  // This control operation is a deterministic barrier behind all queued input.
  assert.equal(await session.subscriptions.revalidate(), 0);
  assert.equal(fixture.entityChecks.length, 1, "queued input never authorizes after cleanup");
  assert.equal(session.subscriptions.size, 0);
  assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
  assert.deepEqual(responses, []);
});

test("inbound capacity is reused in order after completion and adapter rejection", { timeout: 5_000 }, async (t) => {
  const fixture = await createGatedFixture();
  t.after(() => fixture.close());
  const connection = await connect(fixture.url, "Bearer actor-a");
  for (const [round, reject] of [false, true, false].entries()) {
    const gate = fixture.pause({ reject });
    const ids = Array.from({ length: MAX_PENDING_INBOUND_MESSAGES }, (_, index) => `round-${round}-${index}`);
    sendGatedRequest(connection, ids[0]);
    await gate.entered;
    for (const id of ids.slice(1)) sendGatedRequest(connection, id);
    await flushInbound(connection);
    assert.equal(connection.socket.readyState, WebSocket.OPEN);
    gate.release();
    for (const requestId of ids) {
      const response = await connection.nextMessage();
      assert.equal(response.requestId, requestId);
      assert.equal(response.type, reject
        ? CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.rejected
        : CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed);
      if (reject) assert.equal(response.code, CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessDenied);
    }
    assert.equal(fixture.runtime.webSocketSubscriptionCount, reject ? 0 : 1);
  }
  assert.equal(fixture.entityChecks.length, 3 * MAX_PENDING_INBOUND_MESSAGES);
});

test("disconnect skips pending inbound work and lets queued revalidation settle", { timeout: 5_000 }, async (t) => {
  const fixture = await createGatedFixture();
  t.after(() => fixture.close());
  const connection = await connect(fixture.url, "Bearer actor-a");
  const { socket, session } = fixture.sessions[0];
  await subscribe(connection, "user:user-a");
  const gate = fixture.pause();
  sendGatedRequest(connection, "active");
  await gate.entered;
  const revalidation = session.subscriptions.revalidate();
  for (let index = 1; index < MAX_PENDING_INBOUND_MESSAGES; index += 1) {
    sendGatedRequest(connection, `queued-${index}`);
  }
  await flushInbound(connection);
  assert.equal(socket.readyState, WebSocket.OPEN, "control work does not consume inbound slots");
  const serverClosed = once(socket, "close");
  connection.socket.close();
  await Promise.all([serverClosed, connection.closed]);
  assert.equal(session.subscriptions.size, 0);
  gate.release();
  assert.equal(await revalidation, 0);
  await session.subscriptions.revalidate();
  assert.equal(fixture.entityChecks.length, 1);
  assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
});

test("below-limit inbound requests stay ordered around subscription revalidation", { timeout: 5_000 }, async (t) => {
  const fixture = await createGatedFixture();
  t.after(() => fixture.close());
  const connection = await connect(fixture.url, "Bearer actor-a");
  const { session } = fixture.sessions[0];
  const gate = fixture.pause();
  sendGatedRequest(connection, "first");
  await gate.entered;
  const revalidation = session.subscriptions.revalidate();
  connection.socket.send(JSON.stringify({
    type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe,
    streamId: "gated",
    requestId: "second",
  }));
  sendGatedRequest(connection, "third");
  await flushInbound(connection);
  assert.equal(fixture.entityChecks.length, 1);
  gate.release();
  const responses = await Promise.all(Array.from({ length: 3 }, () => connection.nextMessage()));
  assert.deepEqual(responses.map(({ requestId, type }) => [requestId, type]), [
    ["first", CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed],
    ["second", CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed],
    ["third", CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed],
  ]);
  assert.equal(await revalidation, 0);
  assert.equal(fixture.entityChecks.length, 3, "revalidation runs before the queued unsubscribe");
  assert.deepEqual(session.subscriptions.streamIds, ["gated"]);
});

test("cleanup across the ephemeral-handler await prevents stream authorization", { timeout: 5_000 }, async (t) => {
  const fixture = await createGatedFixture();
  t.after(() => fixture.close());
  const connection = await connect(fixture.url, "Bearer actor-a");
  const { socket, session } = fixture.sessions[0];
  // The production listener queues handleMessage first. This microtask then
  // cleans up while handleMessage yields at its ephemeral-handler await.
  socket.once("message", () => queueMicrotask(() => fixture.runtime.detachWebSocket()));
  sendGatedRequest(connection, "closing");
  await connection.closed;
  await session.subscriptions.revalidate();
  assert.equal(fixture.entityChecks.length, 0);
  assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
});

test("authorizes only the actor's exact private user stream and rejects scoped input", async () => {
  const fixture = await createFixture();
  try {
    const connection = await connect(fixture.url, "Bearer actor-a");
    const accepted = await subscribe(connection, "user:user-a");
    assert.equal(
      accepted.type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );
    assert.equal(accepted.streamId, "user:user-a");
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 1);
    assert.deepEqual(fixture.sessions[0].session.subscriptions.streamIds, [
      "user:user-a",
    ]);

    const duplicate = await subscribe(connection, "user:user-a");
    assert.equal(
      duplicate.type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 1);

    const otherUser = await subscribe(connection, "user:user-b");
    assert.equal(
      otherUser.code,
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.identitySpoofing,
    );

    for (const streamId of ["*", "conversation-*", "tenant:tenant-a", "all"]) {
      const rejected = await subscribe(connection, streamId);
      assert.equal(
        rejected.code,
        CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.invalidStream,
      );
    }

    for (const injectedIdentity of [
      { tenantId: "tenant-a" },
      { userId: "user-a" },
      { payload: { tenantId: "tenant-a", userId: "user-a" } },
    ]) {
      const rejected = await subscribe(
        connection,
        "user:user-a",
        injectedIdentity,
      );
      assert.equal(
        rejected.code,
        CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.identitySpoofing,
      );
    }

    const malformed = await subscribe(connection, "user:user-a", {
      unexpected: true,
    });
    assert.equal(
      malformed.code,
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.malformedRequest,
    );

    const firstRemoved = await unsubscribe(connection, "user:user-a");
    const secondRemoved = await unsubscribe(connection, "user:user-a");
    assert.equal(
      firstRemoved.type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed,
    );
    assert.equal(
      secondRemoved.type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed,
    );
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
  } finally {
    await fixture.close();
  }
});

// Thread parent/membership SQL is covered by postgres-websocket-thread-authorization.test.mjs.
test("authorizes public, private, direct, group-direct, and entity conversation streams", async () => {
  const fixture = await createFixture();
  try {
    const acceptedIds = [
      ["public", "channel", "public", false],
      ["private", "channel", "private", true],
      ["direct", "direct", "private", true],
      ["group", "group_direct", "private", true],
    ];
    for (const [id, type, visibility, member] of acceptedIds) {
      const conversation = addConversation(fixture.conversations, {
        tenantId: "tenant-a",
        id,
        type,
        visibility,
      });
      if (member) conversation.members.set("user-a", "active");
    }
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "private-nonmember",
      type: "channel",
      visibility: "private",
    });
    addConversation(fixture.conversations, {
      tenantId: "tenant-b",
      id: "tenant-b-only",
      type: "channel",
      visibility: "public",
    });
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "archived",
      type: "channel",
      visibility: "public",
      archivedAt: new Date(),
    });
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "entity-allowed",
      type: "channel",
      visibility: "public",
      entity: { type: "order", id: "allowed" },
    });
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "entity-denied",
      type: "channel",
      visibility: "public",
      entity: { type: "order", id: "denied" },
    });
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "entity-failure",
      type: "channel",
      visibility: "public",
      entity: { type: "order", id: "failure" },
    });
    fixture.entityAccess.set(entityKey({ type: "order", id: "denied" }), false);
    fixture.entityFailures.add(entityKey({ type: "order", id: "failure" }));

    const connection = await connect(fixture.url, "Bearer actor-a");
    for (const [id] of acceptedIds) {
      const response = await subscribe(connection, id);
      assert.equal(
        response.type,
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
        id,
      );
    }
    assert.equal(
      (await subscribe(connection, "entity-allowed")).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );

    for (const id of [
      "private-nonmember",
      "tenant-b-only",
      "archived",
      "missing",
      "entity-denied",
      "entity-failure",
    ]) {
      const response = await subscribe(connection, id);
      assert.deepEqual(
        { type: response.type, code: response.code },
        {
          type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.rejected,
          code: CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessDenied,
        },
        id,
      );
      if (id === "entity-failure") {
        assert.doesNotMatch(JSON.stringify(response), /private host adapter/);
      }
    }
    assert.ok(
      fixture.entityChecks.every(
        ({ action, actor }) =>
          action === CHAT_WEBSOCKET_SUBSCRIPTION_POLICY_ACTION &&
          actor.tenantId === "tenant-a" &&
          actor.userId === "user-a",
      ),
    );
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 5);
  } finally {
    await fixture.close();
  }
});

test("revalidation revokes membership, archive, and host-entity access immediately", async () => {
  const fixture = await createFixture();
  try {
    const privateConversation = addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "private-revoke",
      type: "channel",
      visibility: "private",
      members: new Map([["user-a", "active"]]),
    });
    const archivedConversation = addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "archive-revoke",
      type: "channel",
      visibility: "public",
    });
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "entity-revoke",
      type: "channel",
      visibility: "public",
      entity: { type: "record", id: "7" },
    });

    const connection = await connect(fixture.url, "Bearer actor-a");
    for (const id of ["private-revoke", "archive-revoke", "entity-revoke"]) {
      assert.equal(
        (await subscribe(connection, id)).type,
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
      );
    }
    privateConversation.members.set("user-a", "removed");
    archivedConversation.archivedAt = new Date();
    fixture.entityAccess.set(entityKey({ type: "record", id: "7" }), false);

    const revokedCount = await fixture.runtime.revalidateWebSocketSubscriptions({
      tenantId: "tenant-a",
    });
    assert.equal(revokedCount, 3);
    const revoked = await Promise.all([
      connection.nextMessage(),
      connection.nextMessage(),
      connection.nextMessage(),
    ]);
    assert.deepEqual(
      new Set(revoked.map(({ streamId }) => streamId)),
      new Set(["private-revoke", "archive-revoke", "entity-revoke"]),
    );
    assert.ok(
      revoked.every(
        ({ type, code }) =>
          type === CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.revoked &&
          code === CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessRevoked,
      ),
    );
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
    assert.equal(fixture.sessions[0].session.subscriptions.size, 0);
    assert.equal(
      await fixture.runtime.revalidateWebSocketSubscriptions({
        tenantId: "tenant-a",
      }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("isolates concurrent sessions and releases socket, controller, and runtime resources", async () => {
  const fixture = await createFixture();
  try {
    addConversation(fixture.conversations, {
      tenantId: "tenant-a",
      id: "shared-public",
      type: "channel",
      visibility: "public",
    });
    const first = await connect(fixture.url, "Bearer actor-a");
    const second = await connect(fixture.url, "Bearer actor-a2");
    await subscribe(first, "shared-public");
    await subscribe(second, "shared-public");
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 2);
    assert.equal(fixture.sessions[0].session.subscriptions.size, 1);
    assert.equal(fixture.sessions[1].session.subscriptions.size, 1);

    await unsubscribe(first, "shared-public");
    assert.equal(fixture.sessions[0].session.subscriptions.size, 0);
    assert.equal(fixture.sessions[1].session.subscriptions.size, 1);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 1);

    first.socket.terminate();
    await first.closed;
    await waitFor(() => fixture.runtime.webSocketSessionCount === 1);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 1);

    fixture.runtime.detachWebSocket();
    await second.closed;
    assert.equal(fixture.runtime.webSocketSessionCount, 0);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
    assert.equal(fixture.sessions[1].session.subscriptions.size, 0);

    fixture.runtime.attachWebSocket(fixture.server);
    const third = await connect(fixture.url, "Bearer actor-a");
    await subscribe(third, "shared-public");
    await fixture.runtime.close();
    await third.closed;
    assert.equal(fixture.runtime.webSocketSessionCount, 0);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
  } finally {
    await fixture.close();
  }
});
