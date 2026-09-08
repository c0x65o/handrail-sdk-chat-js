import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  MAX_PRESENCE_SIGNAL_TTL_MS,
  MAX_TYPING_SIGNAL_TTL_MS,
  parseEphemeralSignalEvent,
} from "@handrail/chat";
import {
  EMPTY_EPHEMERAL_SIGNAL_STATE,
  presenceSignalKey,
  reduceEphemeralSignal,
  typingSignalKey,
} from "@handrail/chat/client";
import {
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  createChatServer,
} from "@handrail/chat/server";
import { WebSocket } from "ws";

const START_TIME = Date.parse("2026-08-26T05:30:00.000Z");
const key = (...values) => JSON.stringify(values);

class FakeClock {
  nowMs = START_TIME;
  sequence = 0;
  tasks = new Map();

  api = {
    now: () => this.nowMs,
    setTimeout: (callback, delayMs) => {
      const handle = ++this.sequence;
      this.tasks.set(handle, { callback, due: this.nowMs + delayMs });
      return handle;
    },
    clearTimeout: (handle) => this.tasks.delete(handle),
  };

  async advance(milliseconds) {
    const target = this.nowMs + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort(([leftId, left], [rightId, right]) =>
          left.due - right.due || leftId - rightId,
        )[0];
      if (next === undefined) break;
      const [handle, task] = next;
      this.tasks.delete(handle);
      this.nowMs = task.due;
      task.callback();
      await flush();
    }
    this.nowMs = target;
    await flush();
  }
}

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

const createFanout = () => {
  const listeners = new Set();
  const published = [];
  return {
    published,
    get subscriberCount() {
      return listeners.size;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async publish(event) {
      published.push(event);
      await Promise.all([...listeners].map((listener) => listener(event)));
    },
  };
};

const actors = new Map([
  ["Bearer user-a-1", { tenantId: "tenant-a", userId: "user-a", roles: [] }],
  ["Bearer user-a-2", { tenantId: "tenant-a", userId: "user-a", roles: [] }],
  ["Bearer user-b", { tenantId: "tenant-a", userId: "user-b", roles: [] }],
  ["Bearer user-c", { tenantId: "tenant-a", userId: "user-c", roles: [] }],
  ["Bearer tenant-b", { tenantId: "tenant-b", userId: "user-a", roles: [] }],
]);

const createFixture = async ({
  realtime,
  authorizeEntity = async () => true,
  maxPendingEvents,
  typingTtlMs = 100,
  presenceTtlMs = 300,
  rateLimitMaxSignals = 20,
  rateLimitWindowMs = 100,
} = {}) => {
  const clock = new FakeClock();
  const conversations = new Map();
  const sessions = [];
  const sql = [];
  let auditWrites = 0;
  let id = 0;

  const database = {
    async query(statement, values = []) {
      sql.push({ statement, values });
      if (statement.includes("WITH claimable AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("SELECT EXISTS")) {
        return { rows: [{ exists: false }] };
      }
      if (statement.includes("current_member.state AS member_state")) {
        const [tenantId, conversationId, userId] = values;
        const conversation = conversations.get(key(tenantId, conversationId));
        if (conversation === undefined) return { rows: [] };
        return {
          rows: [{
            type: conversation.type,
            visibility: conversation.visibility,
            entity_type: conversation.entity?.type ?? null,
            entity_id: conversation.entity?.id ?? null,
            archived_at: conversation.archivedAt ?? null,
            member_state: conversation.members.get(userId) ?? null,
          }],
        };
      }
      throw new Error(`unexpected ephemeral query: ${statement}`);
    },
    async connect() {
      throw new Error("ephemeral socket tests do not run migrations");
    },
  };

  const runtime = createChatServer({
    database: { pool: database },
    auth: {
      async resolveActor(request) {
        const actor = actors.get(request.headers.authorization);
        if (actor === undefined) throw new Error("private authentication detail");
        return actor;
      },
    },
    directory: {
      async getUser() { return null; },
      async searchUsers() { return []; },
    },
    permissions: {
      async getCapabilities() { return ["messages.read"]; },
      authorizeEntity,
    },
    audit: {
      async record() { auditWrites += 1; },
    },
    ...(realtime === undefined ? {} : { realtime }),
    features: { typing: true, presence: true },
    ephemeralSignals: {
      clock: clock.api,
      idFactory: () => `id-${++id}`,
      typingTtlMs,
      presenceTtlMs,
      rateLimitMaxSignals,
      rateLimitWindowMs,
    },
    webSocket: {
      ...(maxPendingEvents === undefined ? {} : { maxPendingEvents }),
      handshakeTimeoutMs: 1_000,
      onSession(socket, session) { sessions.push({ socket, session }); },
    },
  });
  const server = createServer(runtime.router);
  runtime.attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");

  const addConversation = (
    conversationId,
    visibility,
    members,
    archivedAt = null,
    entity = null,
  ) => conversations.set(key("tenant-a", conversationId), {
    type: "channel",
    visibility,
    members: new Map(members.map((userId) => [userId, "active"])),
    archivedAt,
    entity,
  });

  return {
    clock,
    runtime,
    sessions,
    server,
    sql,
    get auditWrites() { return auditWrites; },
    addConversation,
    url: `ws://127.0.0.1:${address.port}${DEFAULT_CHAT_WEBSOCKET_PATH}`,
    async close() {
      await runtime.close();
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    },
  };
};

const connect = async (fixture, authorization, resumeFrom) => {
  const socket = new WebSocket(fixture.url, { headers: { authorization } });
  const messages = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    waiters.shift()?.(message);
  });
  const closed = new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    clientPackageVersion: "0.1.3",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
  }));

  let readIndex = 0;
  const nextMessage = () =>
    readIndex < messages.length
      ? Promise.resolve(messages[readIndex++])
      : new Promise((resolve) => waiters.push((message) => {
          readIndex += 1;
          resolve(message);
        }));
  const accepted = await nextMessage();
  assert.equal(accepted.type, "chat.session.accepted");
  return {
    socket,
    messages,
    nextMessage,
    accepted,
    closed,
    get unreadCount() { return messages.length - readIndex; },
  };
};

let requestId = 0;
const subscribe = async (connection, streamId) => {
  connection.socket.send(JSON.stringify({
    type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
    requestId: `ephemeral-sub-${++requestId}`,
    streamId,
  }));
  const message = await connection.nextMessage();
  assert.equal(message.type, CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed);
};

const signal = (fixture, connection, type, state, sourceOffset = 0, overrides = {}) => {
  const isTyping = type === "typing.signal";
  const sentAt = new Date(fixture.clock.nowMs + sourceOffset).toISOString();
  const expiresAt = new Date(
    fixture.clock.nowMs + sourceOffset +
      (isTyping ? MAX_TYPING_SIGNAL_TTL_MS : MAX_PRESENCE_SIGNAL_TTL_MS),
  ).toISOString();
  const conversationId = overrides.conversationId ?? "private-a";
  return {
    eventId: `client-event-${++requestId}`,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: "tenant-a",
    streamId: isTyping ? conversationId : "user:user-a",
    type,
    occurredAt: sentAt,
    payload: {
      capability: isTyping ? "typing" : "presence",
      durability: "ephemeral",
      actorUserId: "user-a",
      deviceId: connection.accepted.deviceId,
      sessionId: connection.accepted.sessionId,
      sequence: requestId,
      sentAt,
      expiresAt,
      state,
      scope: isTyping
        ? {
            type: "conversation",
            conversationId,
            visibility: overrides.visibility ?? "private",
            audience: overrides.audience ?? "members",
          }
        : { type: "user_private", userId: "user-a" },
    },
    ...overrides.event,
  };
};

const sendSignal = (connection, value) =>
  connection.socket.send(JSON.stringify(value));

const expectNoMessage = async (connection) => {
  const count = connection.unreadCount;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(connection.unreadCount, count);
};

// Arm only after subscription acknowledgement so setup authorization cannot block.
const createDeliveryGate = () => {
  let current;
  let calls = 0;
  let pending = 0;
  return {
    get calls() { return calls; },
    get pending() { return pending; },
    arm() {
      const entered = Promise.withResolvers();
      const result = Promise.withResolvers();
      current = { entered, result };
      return { entered: entered.promise, resolve: result.resolve, reject: result.reject };
    },
    async authorizeEntity() {
      if (current === undefined) return true;
      calls += 1;
      pending += 1;
      const gate = current;
      gate.entered.resolve();
      try {
        return await gate.result.promise;
      } finally {
        pending -= 1;
      }
    },
    disarm() { current = undefined; },
  };
};

const publishTyping = async (realtime, fixture, recipient, offset) => {
  const event = signal(fixture, recipient, "typing.signal", "start", offset);
  // Validate at the same external boundary exercised by real fanout providers.
  parseEphemeralSignalEvent(event, {
    expectedTenantId: "tenant-a",
    enabledFeatures: { typing: true, presence: true },
    now: fixture.clock.nowMs,
  });
  await realtime.publish(event);
  return event;
};

test("outbound typing capacity includes active and queued authorizations", { timeout: 5_000 }, async () => {
  const realtime = createFanout();
  const permissions = createDeliveryGate();
  const capacity = 3;
  const fixture = await createFixture({ realtime, authorizeEntity: permissions.authorizeEntity, maxPendingEvents: capacity });
  fixture.addConversation("private-a", "private", ["user-b"], null, { type: "project", id: "project-a" });
  let gate;
  try {
    const baseline = realtime.subscriberCount;
    const recipient = await connect(fixture, "Bearer user-b");
    await subscribe(recipient, "private-a");
    assert.equal(realtime.subscriberCount, baseline + 1);
    const registry = fixture.sessions[0].session.subscriptions;
    gate = permissions.arm();
    await publishTyping(realtime, fixture, recipient, 0);
    await gate.entered;
    for (let index = 1; index < capacity; index += 1) {
      await publishTyping(realtime, fixture, recipient, index);
    }
    assert.equal(permissions.calls, 1);
    assert.equal(permissions.pending, 1);
    assert.equal(fixture.sessions[0].socket.readyState, WebSocket.OPEN);
    await publishTyping(realtime, fixture, recipient, capacity);
    assert.deepEqual(await recipient.closed, { code: 4413, reason: "slow_consumer;cursor=" });
    assert.equal(realtime.subscriberCount, baseline);
    assert.equal(registry.size, 0);
    gate.resolve(true);
    // Public registry operations share the delivery queue, including after disposal.
    await registry.revalidate();
    await publishTyping(realtime, fixture, recipient, capacity + 1);
    assert.equal(permissions.calls, 1, "queued authorizations must be skipped after disposal");
    assert.equal(permissions.pending, 0);
    assert.equal(recipient.messages.filter((event) => event.type === "typing.signal").length, 0);
  } finally {
    gate?.resolve(true);
    await fixture.close();
  }
});

test("outbound typing below capacity preserves order and reuses drained reservations", { timeout: 5_000 }, async () => {
  const realtime = createFanout();
  const permissions = createDeliveryGate();
  const fixture = await createFixture({ realtime, authorizeEntity: permissions.authorizeEntity, maxPendingEvents: 3 });
  fixture.addConversation("private-a", "private", ["user-b"], null, { type: "project", id: "project-a" });
  let gate;
  try {
    const recipient = await connect(fixture, "Bearer user-b");
    await subscribe(recipient, "private-a");
    const delivered = [];
    const expected = [];
    for (let batch = 0; batch < 2; batch += 1) {
      gate = permissions.arm();
      expected.push(await publishTyping(realtime, fixture, recipient, batch * 2));
      await gate.entered;
      expected.push(await publishTyping(realtime, fixture, recipient, batch * 2 + 1));
      assert.equal(permissions.calls, batch * 2 + 1);
      gate.resolve(true);
      delivered.push(await recipient.nextMessage(), await recipient.nextMessage());
      permissions.disarm();
      await fixture.sessions[0].session.subscriptions.revalidate();
      assert.equal(permissions.pending, 0);
      assert.equal(permissions.calls, (batch + 1) * 2);
    }
    assert.deepEqual(delivered, expected);
    assert.equal(recipient.unreadCount, 0);
    assert.equal(recipient.socket.readyState, WebSocket.OPEN);
  } finally {
    gate?.resolve(true);
    await fixture.close();
  }
});

test("rejected outbound permission promises deny delivery and release capacity", { timeout: 5_000 }, async () => {
  const realtime = createFanout();
  const permissions = createDeliveryGate();
  const fixture = await createFixture({ realtime, authorizeEntity: permissions.authorizeEntity, maxPendingEvents: 2 });
  fixture.addConversation("private-a", "private", ["user-b"], null, { type: "project", id: "project-a" });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let gate;
  try {
    const baseline = realtime.subscriberCount;
    const recipient = await connect(fixture, "Bearer user-b");
    await subscribe(recipient, "private-a");
    const registry = fixture.sessions[0].session.subscriptions;
    gate = permissions.arm();
    await publishTyping(realtime, fixture, recipient, 0);
    await gate.entered;
    await publishTyping(realtime, fixture, recipient, 1);
    gate.reject(new Error("private permission provider detail"));
    // Both delivery checks and this barrier see the denial; revalidation revokes
    // the stream, giving a socket acknowledgement after all queued work settles.
    assert.equal(await registry.revalidate(), 1);
    assert.equal((await recipient.nextMessage()).type, CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.revoked);
    assert.equal(permissions.pending, 0);
    assert.equal(permissions.calls, 3);
    assert.equal(realtime.subscriberCount, baseline);
    assert.equal(recipient.messages.some((event) => event.type === "typing.signal"), false);
    assert.equal(JSON.stringify(recipient.messages).includes("private permission provider detail"), false);
    permissions.disarm();
    await subscribe(recipient, "private-a");
    gate = permissions.arm();
    const first = await publishTyping(realtime, fixture, recipient, 2);
    await gate.entered;
    const second = await publishTyping(realtime, fixture, recipient, 3);
    gate.resolve(true);
    assert.deepEqual([await recipient.nextMessage(), await recipient.nextMessage()], [first, second]);
    permissions.disarm();
    await registry.revalidate();
    recipient.socket.close();
    await recipient.closed;
    assert.equal(realtime.subscriberCount, baseline);
    assert.equal(permissions.pending, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    gate?.resolve(true);
    await fixture.close();
    process.off("unhandledRejection", onUnhandled);
  }
});

for (const cleanup of ["explicit stop", "backward-clock disconnect", "expiry"]) {
  test(`typing timestamps supersede live starts on ${cleanup}`, async () => {
    const typingTtlMs = cleanup === "expiry" ? 1 : 100;
    const fixture = await createFixture({ typingTtlMs });
    fixture.addConversation("private-a", "private", ["user-a", "user-b"]);
    try {
      const sender = await connect(fixture, "Bearer user-a-1");
      const recipient = await connect(fixture, "Bearer user-b");
      await subscribe(recipient, "private-a");
      const delivered = [];
      const receive = async () => {
        const event = parseEphemeralSignalEvent(await recipient.nextMessage(), {
          expectedTenantId: "tenant-a",
          enabledFeatures: { typing: true, presence: true },
          now: fixture.clock.nowMs,
        });
        assert.equal(event.type, "typing.signal");
        assert.equal(event.occurredAt, event.payload.sentAt);
        assert.equal(event.payload.actorUserId, "user-a");
        assert.equal(event.payload.deviceId, sender.accepted.deviceId);
        assert.equal(event.payload.sessionId, sender.accepted.sessionId);
        assert.equal(event.streamId, "private-a");
        assert.deepEqual(event.payload.scope, {
          type: "conversation",
          conversationId: "private-a",
          visibility: "private",
          audience: "members",
        });
        assert.equal(event.payload.sequence, delivered.length + 1);
        const ttl = Date.parse(event.payload.expiresAt) - Date.parse(event.payload.sentAt);
        assert.equal(ttl, typingTtlMs);
        assert.ok(ttl > 0 && ttl <= MAX_TYPING_SIGNAL_TTL_MS);
        delivered.push(event);
        return event;
      };

      sendSignal(sender, signal(fixture, sender, "typing.signal", "start", 0));
      const start = await receive();
      const stateKey = typingSignalKey(start);
      let state = reduceEphemeralSignal(EMPTY_EPHEMERAL_SIGNAL_STATE, start, START_TIME);
      assert.equal(state.typing[stateKey], start);
      assert.equal(state.typing[stateKey].payload.state, "start");

      // Source ordering advances while the server's wall clock stays frozen.
      sendSignal(sender, signal(fixture, sender, "typing.signal", "start", 1));
      const refresh = await receive();
      state = reduceEphemeralSignal(state, refresh, START_TIME);
      assert.equal(state.typing[stateKey], refresh);
      assert.deepEqual([...fixture.clock.tasks.values()].map((task) => task.due), [
        START_TIME + typingTtlMs,
      ]);

      if (cleanup === "explicit stop") {
        sendSignal(sender, signal(fixture, sender, "typing.signal", "stop", 2));
      } else if (cleanup === "backward-clock disconnect") {
        fixture.clock.nowMs -= 10;
        sender.socket.terminate();
        await sender.closed;
      } else {
        await fixture.clock.advance(typingTtlMs);
      }
      const stop = await receive();
      const clientNow = Math.max(START_TIME, fixture.clock.nowMs);
      if (cleanup !== "expiry") {
        assert.ok(clientNow < Date.parse(start.payload.expiresAt));
      }
      assert.ok(clientNow < Date.parse(refresh.payload.expiresAt));
      state = reduceEphemeralSignal(state, stop, clientNow);
      assert.equal(state.typing[stateKey], stop, "cleanup must replace live typing immediately");
      assert.equal(state.typing[stateKey].payload.state, "stop");
      assert.equal(typingSignalKey(stop), stateKey);
      assert.equal(typingSignalKey(refresh), stateKey);
      assert.equal(Date.parse(start.payload.sentAt), START_TIME);
      for (let index = 1; index < delivered.length; index += 1) {
        assert.ok(Date.parse(delivered[index].payload.sentAt) >
          Date.parse(delivered[index - 1].payload.sentAt));
      }
      assert.equal(fixture.clock.tasks.size, 0);
      await fixture.clock.advance(typingTtlMs + 10);
      await expectNoMessage(recipient);
    } finally {
      await fixture.close();
    }
  });
}

for (const cleanup of ["explicit stop", "disconnect", "expiry"]) {
  test(`typing cleanup clears each session on ${cleanup}`, { timeout: 5_000 }, async () => {
    const fixture = await createFixture();
    fixture.addConversation("private-a", "private", ["user-a", "user-b"]);
    try {
      const first = await connect(fixture, "Bearer user-a-1");
      const second = await connect(fixture, "Bearer user-a-2");
      const observer = await connect(fixture, "Bearer user-b");
      await subscribe(observer, "private-a");
      let state = EMPTY_EPHEMERAL_SIGNAL_STATE;
      const latest = new Map();
      const receive = async (owner, expectedState) => {
        let timeout;
        const message = await Promise.race([
          observer.nextMessage(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(
              `missing typing ${expectedState} for session ${owner.accepted.sessionId}`,
            )), 1_000);
          }),
        ]).finally(() => clearTimeout(timeout));
        const event = parseEphemeralSignalEvent(message, {
          expectedTenantId: "tenant-a",
          enabledFeatures: { typing: true, presence: true },
          now: fixture.clock.nowMs,
        });
        assert.equal(event.type, "typing.signal");
        assert.equal(event.streamId, "private-a");
        assert.equal(event.payload.actorUserId, "user-a");
        assert.equal(event.payload.deviceId, owner.accepted.deviceId);
        assert.equal(event.payload.sessionId, owner.accepted.sessionId);
        assert.equal(event.payload.state, expectedState);
        assert.equal(event.occurredAt, event.payload.sentAt);
        const stateKey = typingSignalKey(event);
        const previous = latest.get(owner);
        if (previous !== undefined) {
          assert.equal(stateKey, typingSignalKey(previous));
          assert.ok(Date.parse(event.payload.sentAt) > Date.parse(previous.payload.sentAt));
          if (expectedState === "stop") {
            assert.ok(fixture.clock.nowMs < Date.parse(previous.payload.expiresAt),
              "cleanup must replace a live start, not rely on TTL pruning");
          }
        }
        state = reduceEphemeralSignal(state, event, fixture.clock.nowMs);
        assert.equal(state.typing[stateKey], event);
        latest.set(owner, event);
        return event;
      };
      const activeKeys = () => Object.entries(state.typing)
        .filter(([, event]) => event.payload.state === "start")
        .map(([stateKey]) => stateKey).sort();

      for (const owner of [first, second]) {
        if (owner === second && cleanup === "expiry") await fixture.clock.advance(50);
        sendSignal(owner, signal(fixture, owner, "typing.signal", "start"));
        await receive(owner, "start");
        // Frozen-clock refresh keeps the wire start live even at timer expiry.
        sendSignal(owner, signal(fixture, owner, "typing.signal", "start", 1));
        await receive(owner, "start");
      }
      const firstKey = typingSignalKey(latest.get(first));
      const secondStart = latest.get(second);
      const secondKey = typingSignalKey(secondStart);
      assert.notEqual(firstKey, secondKey);
      assert.deepEqual(activeKeys(), [firstKey, secondKey].sort());

      for (const owner of [first, second]) {
        if (cleanup === "explicit stop") {
          sendSignal(owner, signal(fixture, owner, "typing.signal", "stop", 2));
        } else if (cleanup === "disconnect") {
          owner.socket.terminate();
          await owner.closed;
        } else {
          await fixture.clock.advance(50);
        }
        await receive(owner, "stop");
        assert.deepEqual(activeKeys(), owner === first ? [secondKey] : []);
        if (owner === first) assert.equal(state.typing[secondKey], secondStart);
        assert.equal(fixture.clock.tasks.size, owner === first ? 1 : 0);
        await expectNoMessage(observer);
      }
      await fixture.clock.advance(110);
      await expectNoMessage(observer);
    } finally {
      await fixture.close();
    }
  });
}

test("typing start, refresh, stop, expiry, ordering, and private authorization stay ephemeral", async () => {
  const fixture = await createFixture();
  fixture.addConversation("private-a", "private", ["user-a", "user-b"]);
  fixture.addConversation("private-denied", "private", ["user-b"]);
  fixture.addConversation("archived", "private", ["user-a", "user-b"], new Date());
  try {
    const sender = await connect(fixture, "Bearer user-a-1");
    const recipient = await connect(fixture, "Bearer user-b");
    await subscribe(recipient, "private-a");
    await subscribe(recipient, "private-denied");
    await subscribe(recipient, "archived").catch(() => undefined);
    const durableWriteCount = () => fixture.sql.filter(({ statement }) =>
      /\b(?:INSERT|UPDATE|DELETE)\b/i.test(statement),
    ).length;
    const baselineDurableWrites = durableWriteCount();

    const start = signal(fixture, sender, "typing.signal", "start");
    sendSignal(sender, start);
    const deliveredStart = await recipient.nextMessage();
    assert.equal(deliveredStart.payload.state, "start");
    assert.equal(deliveredStart.payload.actorUserId, "user-a");
    assert.equal(deliveredStart.payload.sentAt, new Date(START_TIME).toISOString());
    assert.equal(
      Date.parse(deliveredStart.payload.expiresAt) - Date.parse(deliveredStart.payload.sentAt),
      100,
    );

    sendSignal(sender, start);
    await expectNoMessage(recipient);
    sendSignal(sender, signal(fixture, sender, "typing.signal", "stop", -1));
    await expectNoMessage(recipient);

    await fixture.clock.advance(50);
    sendSignal(sender, signal(fixture, sender, "typing.signal", "start", 1));
    assert.equal((await recipient.nextMessage()).payload.state, "start");
    await fixture.clock.advance(99);
    await expectNoMessage(recipient);
    await fixture.clock.advance(1);
    assert.equal((await recipient.nextMessage()).payload.state, "stop");

    sendSignal(sender, signal(fixture, sender, "typing.signal", "start", 2));
    assert.equal((await recipient.nextMessage()).payload.state, "start");
    sendSignal(sender, signal(fixture, sender, "typing.signal", "stop", 3));
    assert.equal((await recipient.nextMessage()).payload.state, "stop");

    for (const rejected of [
      signal(fixture, sender, "typing.signal", "start", 4, {
        event: { tenantId: "tenant-b" },
      }),
      {
        ...signal(fixture, sender, "typing.signal", "start", 5),
        payload: {
          ...signal(fixture, sender, "typing.signal", "start", 5).payload,
          actorUserId: "user-b",
        },
      },
      signal(fixture, sender, "typing.signal", "start", 6, {
        conversationId: "private-denied",
      }),
      signal(fixture, sender, "typing.signal", "start", 7, {
        conversationId: "archived",
      }),
      { type: "typing.signal", malformed: true },
      {
        ...signal(fixture, sender, "typing.signal", "start", 8),
        occurredAt: new Date(fixture.clock.nowMs - 10).toISOString(),
        payload: {
          ...signal(fixture, sender, "typing.signal", "start", 8).payload,
          sentAt: new Date(fixture.clock.nowMs - 10).toISOString(),
          expiresAt: new Date(fixture.clock.nowMs).toISOString(),
        },
      },
    ]) sendSignal(sender, rejected);
    await expectNoMessage(recipient);

    assert.equal(durableWriteCount(), baselineDurableWrites);
    assert.equal(fixture.auditWrites, 0);
  } finally {
    await fixture.close();
  }
});

for (const cleanup of ["explicit offline", "disconnect", "expiry", "staggered expiry"]) {
  for (const survivorState of [undefined, "away", "online"]) {
    const remainingSupport = survivorState !== undefined;
    const senderState = survivorState === "online" ? "away" : "online";
    test(`presence timestamps supersede live state on ${cleanup}, survivor: ${survivorState}`, { timeout: 5_000 }, async () => {
      const presenceTtlMs = cleanup === "expiry" ? 1 : 300;
      const survivorDelay = cleanup === "staggered expiry" && remainingSupport ? 150 : 0;
      const expiring = cleanup.endsWith("expiry");
      const fixture = await createFixture({ presenceTtlMs });
      try {
        const sender = await connect(fixture, "Bearer user-a-1");
        const supporter = remainingSupport
          ? await connect(fixture, "Bearer user-a-2")
          : undefined;
        const observer = await connect(fixture, "Bearer user-a-1");
        await subscribe(observer, "user:user-a");
        let state = EMPTY_EPHEMERAL_SIGNAL_STATE;
        const delivered = new Map();
        const eventIds = new Set();
        const receive = async (owner, expectedState, sequence) => {
          let timeout;
          const message = await Promise.race([
            observer.nextMessage(),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error(
                `missing presence ${expectedState} for session ${owner.accepted.sessionId}`,
              )), 1_000);
            }),
          ]).finally(() => clearTimeout(timeout));
          const event = parseEphemeralSignalEvent(message, {
            expectedTenantId: "tenant-a",
            enabledFeatures: { typing: true, presence: true },
            now: fixture.clock.nowMs,
          });
          assert.equal(event.type, "presence.signal");
          assert.equal(event.occurredAt, event.payload.sentAt);
          assert.equal(event.payload.actorUserId, "user-a");
          assert.equal(event.payload.deviceId, owner.accepted.deviceId);
          assert.equal(event.payload.sessionId, owner.accepted.sessionId);
          assert.equal(event.streamId, "user:user-a");
          assert.deepEqual(event.payload.scope, { type: "user_private", userId: "user-a" });
          assert.equal(event.payload.state, expectedState);
          assert.equal(event.payload.sequence, sequence);
          assert.match(event.eventId, /^ephemeral-/);
          assert.equal(eventIds.has(event.eventId), false);
          eventIds.add(event.eventId);
          const ttl = Date.parse(event.payload.expiresAt) - Date.parse(event.payload.sentAt);
          assert.equal(ttl, presenceTtlMs);
          assert.ok(ttl > 0 && ttl <= MAX_PRESENCE_SIGNAL_TTL_MS);
          const stateKey = presenceSignalKey(event);
          const previous = delivered.get(stateKey);
          state = reduceEphemeralSignal(state, event, fixture.clock.nowMs);
          assert.equal(state.presence[stateKey], event, "presence must replace the prior state immediately");
          if (previous !== undefined) {
            assert.ok(Date.parse(event.payload.sentAt) > Date.parse(previous.payload.sentAt));
          } else {
            assert.equal(Date.parse(event.payload.sentAt), fixture.clock.nowMs);
          }
          delivered.set(stateKey, event);
          return event;
        };

        const activeKeys = () => Object.entries(state.presence)
          .filter(([, event]) => event.payload.state !== "offline")
          .map(([stateKey]) => stateKey).sort();

        sendSignal(sender, signal(fixture, sender, "presence.signal", senderState, 0));
        await receive(sender, senderState, 1);
        // Inbound source timestamps advance while server time remains frozen.
        sendSignal(sender, signal(fixture, sender, "presence.signal", senderState, 1));
        const previous = await receive(sender, senderState, 2);
        let survivor;
        if (supporter !== undefined) {
          await fixture.clock.advance(survivorDelay);
          sendSignal(supporter, signal(fixture, supporter, "presence.signal", survivorState, 0));
          await receive(supporter, survivorState, 1);
          sendSignal(supporter, signal(fixture, supporter, "presence.signal", survivorState, 1));
          survivor = await receive(supporter, survivorState, 2);
        }
        const senderKey = presenceSignalKey(previous);
        const survivorKeys = survivor === undefined ? [] : [presenceSignalKey(survivor)];
        assert.deepEqual(activeKeys(), [senderKey, ...survivorKeys].sort());
        assert.equal(fixture.clock.nowMs, START_TIME + survivorDelay);
        assert.deepEqual([...fixture.clock.tasks.values()].map((task) => task.due),
          [START_TIME + presenceTtlMs,
            ...(remainingSupport ? [START_TIME + survivorDelay + presenceTtlMs] : [])]);

        if (cleanup === "explicit offline") {
          sendSignal(sender, signal(fixture, sender, "presence.signal", "offline", 2));
        } else if (cleanup === "disconnect") {
          sender.socket.terminate();
          await sender.closed;
        } else {
          await fixture.clock.advance(presenceTtlMs - survivorDelay);
        }
        assert.ok(fixture.clock.nowMs < Date.parse(previous.payload.expiresAt),
          "prior presence must still be live when cleanup arrives");
        const transition = await receive(sender, "offline", 3);
        assert.equal(presenceSignalKey(transition), presenceSignalKey(previous));
        assert.deepEqual(activeKeys(), survivorKeys);
        if (supporter !== undefined) {
          assert.equal(state.presence[presenceSignalKey(survivor)], survivor);
          if (!expiring || survivorDelay > 0) {
            assert.deepEqual([...fixture.clock.tasks.values()].map((task) => task.due), [
              START_TIME + survivorDelay + presenceTtlMs,
            ]);
            await expectNoMessage(observer);
            if (expiring) {
              await fixture.clock.advance(survivorDelay);
            } else if (cleanup === "explicit offline") {
              sendSignal(supporter, signal(fixture, supporter, "presence.signal", "offline", 2));
            } else {
              supporter.socket.terminate();
              await supporter.closed;
            }
          }
          assert.ok(fixture.clock.nowMs < Date.parse(survivor.payload.expiresAt));
          await receive(supporter, "offline", 3);
        }
        assert.deepEqual(activeKeys(), []);
        assert.equal(Object.keys(state.presence).length, remainingSupport ? 2 : 1);
        assert.equal(fixture.clock.tasks.size, 0);
        await fixture.clock.advance(presenceTtlMs + 10);
        await expectNoMessage(observer);
      } finally {
        await fixture.close();
      }
    });
  }
}

test("presence and typing disconnect cleanup preserve other active sessions", async () => {
  const fixture = await createFixture();
  fixture.addConversation("private-a", "private", ["user-a", "user-b"]);
  try {
    const first = await connect(fixture, "Bearer user-a-1");
    const second = await connect(fixture, "Bearer user-a-2");
    const observer = await connect(fixture, "Bearer user-a-1");
    const typingObserver = await connect(fixture, "Bearer user-b");
    await subscribe(observer, "user:user-a");
    await subscribe(typingObserver, "private-a");

    sendSignal(first, signal(fixture, first, "presence.signal", "online", 1));
    assert.equal((await observer.nextMessage()).payload.state, "online");
    sendSignal(first, signal(fixture, first, "presence.signal", "offline", 2));
    assert.equal((await observer.nextMessage()).payload.state, "offline");
    sendSignal(first, signal(fixture, first, "presence.signal", "online", 3));
    assert.equal((await observer.nextMessage()).payload.state, "online");
    sendSignal(second, signal(fixture, second, "presence.signal", "away", 3));
    assert.equal((await observer.nextMessage()).payload.state, "away");

    sendSignal(first, signal(fixture, first, "typing.signal", "start", 2));
    assert.equal((await typingObserver.nextMessage()).payload.state, "start");
    sendSignal(second, signal(fixture, second, "typing.signal", "start", 2));
    assert.equal((await typingObserver.nextMessage()).payload.state, "start");

    first.socket.terminate();
    await first.closed;
    const firstOffline = await observer.nextMessage();
    assert.equal(firstOffline.payload.state, "offline");
    assert.equal(firstOffline.payload.sessionId, first.accepted.sessionId);
    const firstStop = await typingObserver.nextMessage();
    assert.equal(firstStop.payload.state, "stop");
    assert.equal(firstStop.payload.sessionId, first.accepted.sessionId);

    second.socket.terminate();
    await second.closed;
    assert.equal((await observer.nextMessage()).payload.state, "offline");
    assert.equal((await typingObserver.nextMessage()).payload.state, "stop");

    const expiring = await connect(fixture, "Bearer user-a-2");
    sendSignal(expiring, signal(fixture, expiring, "presence.signal", "online", 3));
    assert.equal((await observer.nextMessage()).payload.state, "online");
    await fixture.clock.advance(300);
    assert.equal((await observer.nextMessage()).payload.state, "offline");
  } finally {
    await fixture.close();
  }
});

test("public typing reaches active participants only and rate limits recover", async () => {
  const fixture = await createFixture({
    rateLimitMaxSignals: 2,
    typingTtlMs: 300,
  });
  fixture.addConversation("public-a", "public", ["user-a", "user-b"]);
  try {
    const sender = await connect(fixture, "Bearer user-a-1");
    const secondSender = await connect(fixture, "Bearer user-a-2");
    const participant = await connect(fixture, "Bearer user-b");
    const inactive = await connect(fixture, "Bearer user-c");
    await subscribe(participant, "public-a");
    await subscribe(inactive, "public-a");

    const publicOptions = {
      conversationId: "public-a",
      visibility: "public",
      audience: "active_participants",
    };
    sendSignal(sender, signal(fixture, sender, "typing.signal", "start", 1, publicOptions));
    assert.equal((await participant.nextMessage()).payload.state, "start");
    await expectNoMessage(inactive);
    sendSignal(
      secondSender,
      signal(fixture, secondSender, "typing.signal", "start", 1, publicOptions),
    );
    assert.equal((await participant.nextMessage()).payload.state, "start");
    sendSignal(sender, signal(fixture, sender, "typing.signal", "stop", 2, publicOptions));
    await expectNoMessage(participant);

    secondSender.socket.terminate();
    await secondSender.closed;
    const disconnectedStop = await participant.nextMessage();
    assert.equal(disconnectedStop.payload.state, "stop");
    assert.equal(disconnectedStop.payload.sessionId, secondSender.accepted.sessionId);
    await expectNoMessage(inactive);
    await fixture.clock.advance(100);
    sendSignal(sender, signal(fixture, sender, "typing.signal", "stop", 3, publicOptions));
    assert.equal((await participant.nextMessage()).payload.state, "stop");
  } finally {
    await fixture.close();
  }
});

test("external adapter fanout retains local delivery and ephemeral events never advance replay cursors", async () => {
  const realtime = createFanout();
  const fixture = await createFixture({ realtime });
  try {
    const sender = await connect(fixture, "Bearer user-a-1");
    const recipient = await connect(fixture, "Bearer user-a-2");
    await subscribe(recipient, "user:user-a");
    sendSignal(sender, signal(fixture, sender, "presence.signal", "online", 1));
    const delivered = await recipient.nextMessage();
    assert.equal(delivered.type, "presence.signal");
    assert.equal(realtime.published.length, 1);
    assert.equal(realtime.published[0].eventId, delivered.eventId);

    assert.equal(fixture.sessions[1].session.lastDeliveredCursor, undefined);
    assert.equal(
      fixture.sql.some(({ statement }) => statement.includes("chat_outbox_events") && /INSERT/i.test(statement)),
      false,
    );
    assert.equal(fixture.auditWrites, 0);
  } finally {
    await fixture.close();
  }
});
