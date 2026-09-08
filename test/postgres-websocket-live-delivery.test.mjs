import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  CHAT_WEBSOCKET_SLOW_CONSUMER_CURSOR_PREFIX,
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";
import { WebSocket } from "ws";

const conversationKey = (tenantId, conversationId) =>
  JSON.stringify([tenantId, conversationId]);

const createFanoutAdapter = (onSubscribe = () => {}) => {
  const listeners = new Set();
  return {
    get subscriberCount() {
      return listeners.size;
    },
    subscribe(listener) {
      listeners.add(listener);
      onSubscribe(listener);
      let active = true;
      return () => {
        if (active) {
          active = false;
          listeners.delete(listener);
        }
      };
    },
    async publish(value) {
      await Promise.all([...listeners].map((listener) => listener(value)));
    },
  };
};

const createFixture = async ({
  maxPendingEvents = 8,
  realtime,
  realtimeDelivery,
  postgres,
} = {}) => {
  const conversations = new Map();
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
              entity_type: null,
              entity_id: null,
              archived_at: conversation.archivedAt ?? null,
              member_state: conversation.members?.get(userId) ?? null,
            },
          ],
        };
      }
      if (sql.includes("WITH claimable AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected live-delivery query: ${sql}`);
    },
    async connect() {
      throw new Error("live-delivery tests do not run migrations");
    },
  };

  const runtime = createChatServer({
    database: postgres ?? { pool: database },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization !== "Bearer actor-a") {
          throw new Error("private authentication detail");
        }
        return {
          tenantId: "tenant-a",
          userId: "user-a",
          roles: ["employee"],
        };
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
      async authorizeEntity() {
        return true;
      },
    },
    ...(realtime === undefined ? {} : { realtime }),
    ...(realtimeDelivery === undefined
      ? {}
      : {
          realtimeDelivery,
          features: { realtime: true },
        }),
    webSocket: {
      handshakeTimeoutMs: 1_000,
      maxPendingEvents,
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
    sessions,
    runtime,
    server,
    fanout: realtime ?? runtime.realtimeHub,
    url: `ws://127.0.0.1:${address.port}${DEFAULT_CHAT_WEBSOCKET_PATH}`,
    async close() {
      await runtime.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};

const connect = async (url, resumeFrom) => {
  const socket = new WebSocket(url, {
    headers: { authorization: "Bearer actor-a" },
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
    messages.push(message);
    waiters.shift()?.(message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      clientPackageVersion: "0.1.3",
      protocolVersion: CHAT_PROTOCOL_VERSION,
      ...(resumeFrom === undefined ? {} : { resumeFrom }),
    }),
  );

  let readIndex = 0;
  const nextMessage = () =>
    readIndex < messages.length
      ? Promise.resolve(messages[readIndex++])
      : new Promise((resolve) =>
          waiters.push((message) => {
            readIndex += 1;
            resolve(message);
          }),
        );
  const accepted = await Promise.race([
    nextMessage(),
    closed.then(({ code, reason }) => {
      throw new Error(`socket closed before acceptance: ${code} ${reason}`);
    }),
  ]);
  assert.equal(accepted.type, "chat.session.accepted");
  return {
    socket,
    closed,
    messages,
    nextMessage,
    get receivedCount() {
      return messages.length;
    },
  };
};

let requestSequence = 0;
const subscriptionRequest = async (connection, type, streamId) => {
  requestSequence += 1;
  connection.socket.send(
    JSON.stringify({
      type,
      requestId: `live-request-${requestSequence}`,
      streamId,
    }),
  );
  return connection.nextMessage();
};

const subscribe = (connection, streamId) =>
  subscriptionRequest(
    connection,
    CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
    streamId,
  );

const unsubscribe = (connection, streamId) =>
  subscriptionRequest(
    connection,
    CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe,
    streamId,
  );

const event = (eventId, streamId, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: "tenant-a",
  streamId,
  type: "message.created",
  occurredAt: "2026-08-26T02:00:00.000Z",
  payload: { messageId: `message-${eventId}` },
  ...overrides,
});

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
};

const within = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("sequential subscriptions retain at most 1,024 streams and release capacity on overflow", async () => {
  const capacity = 1_024;
  const fanout = createFanoutAdapter();
  const fixture = await createFixture({ realtime: fanout });
  try {
    const connection = await connect(fixture.url);
    const retained = fixture.sessions[0].session.subscriptions;
    const request = (type, streamId) => within(Promise.race([
      subscriptionRequest(connection, type, streamId),
      connection.closed.then(({ code, reason }) => {
        throw new Error(`closed before acknowledgement: ${code} ${reason}`);
      }),
    ]), `acknowledgement for ${streamId}`);
    const add = async (streamId) => {
      assert.equal((await request(
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe, streamId,
      )).type, CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed);
    };
    const assertCount = (count) => {
      assert.equal(fixture.runtime.webSocketSubscriptionCount, count);
      assert.equal(retained.size, count);
      assert.equal(retained.streamIds.length, count);
      assert.equal(fanout.subscriberCount, 1);
    };
    // A normal handshake has no implicit subscriptions; explicitly count the
    // private user stream as one of the 1,024 retained slots.
    assert.equal(retained.size, 0);
    await add("user:user-a");
    for (let index = 0; index < capacity + 1; index += 1) {
      fixture.conversations.set(conversationKey("tenant-a", `capacity-${index}`), {
        type: "channel", visibility: "public",
      });
    }
    for (let index = 0; index < capacity - 1; index += 1) {
      await add(`capacity-${index}`);
    }
    assertCount(capacity);
    await add("capacity-0");
    assertCount(capacity);
    assert.equal((await request(
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe, "capacity-0",
    )).type, CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed);
    assertCount(capacity - 1);
    assert.equal(retained.has("capacity-0"), false);
    await add("capacity-1023");
    assertCount(capacity);
    assert.equal(retained.has("capacity-1023"), true);

    const delivered = event("before-capacity-overflow", "capacity-1023");
    await fanout.publish(delivered);
    assert.deepEqual(await within(connection.nextMessage(), "live delivery"), delivered);
    const beforeOverflow = connection.receivedCount;
    connection.socket.send(JSON.stringify({
      type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
      requestId: "capacity-overflow",
      streamId: "capacity-1024",
    }));
    assert.deepEqual(await within(connection.closed, "capacity close"),
      CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit);
    await waitFor(() => fixture.runtime.webSocketSessionCount === 0);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
    assert.equal(retained.size, 0);
    assert.deepEqual(retained.streamIds, []);
    assert.equal(fanout.subscriberCount, 0);
    await fanout.publish(event("after-overflow-retained", "capacity-1023"));
    await fanout.publish(event("after-overflow-private", "user:user-a"));
    await fanout.publish(event("after-overflow-distinct", "capacity-1024"));
    assert.equal(connection.receivedCount, beforeOverflow);
  } finally {
    await fixture.close();
  }
});

test("internal reminders never enter socket delivery or replay buffering", async (t) => {
  const backend = await createPostgresTestBackend();
  t.after(() => backend.teardown());
  const harness = await backend.createHarness({ schemaPrefix: "live_reminder" });
  const schema = `"${harness.schema}"`;
  await createPostgresMigrationRunner({
    database: harness.pool,
    schema: harness.schema,
    migrations: handrailChatPostgresMigrations,
  }).apply();
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversations
       (tenant_id, id, type, visibility, name)
     VALUES ('tenant-a', 'private-a', 'channel', 'private', 'Allowed')`,
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversation_members
       (tenant_id, conversation_id, user_id, role, state)
     VALUES ('tenant-a', 'private-a', 'user-a', 'member', 'active')`,
  );
  const normal = event("normal", "private-a");
  const reminder = event("reminder", "private-a", { type: "message.reminder" });
  for (const value of [event("cursor", "private-a"), reminder, normal]) {
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_outbox_events
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, published_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [
        value.eventId,
        value.protocolVersion,
        value.tenantId,
        value.streamId,
        value.type,
        value.occurredAt,
        JSON.stringify(value.payload),
      ],
    );
  }

  await t.test("established live delivery excludes reminders before cursor and dedup admission", async () => {
    const fanout = createFanoutAdapter();
    const fixture = await createFixture({
      realtime: fanout,
      postgres: { pool: harness.pool, schema: harness.schema },
    });
    try {
      const connection = await connect(fixture.url);
      assert.equal(
        (await subscribe(connection, "private-a")).type,
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
      );
      await fanout.publish(reminder);
      // The control response is a socket barrier after the reminder admission.
      assert.equal(
        (await subscribe(connection, "private-a")).type,
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
      );
      assert.equal(fixture.sessions[0].session.lastDeliveredCursor, undefined);

      // An internal event must not reserve a durable event's deduplication ID.
      await fanout.publish({ ...reminder, eventId: normal.eventId });
      await fanout.publish(normal);
      assert.deepEqual(await connection.nextMessage(), normal);
      await waitFor(
        () => fixture.sessions[0].session.lastDeliveredCursor?.eventId === normal.eventId,
      );
      assert.deepEqual(fixture.sessions[0].session.lastDeliveredCursor, {
        eventId: normal.eventId,
      });
      assert.deepEqual(
        connection.messages.filter((message) => message.eventId),
        [normal],
      );
    } finally {
      await fixture.close();
    }
  });

  await t.test("pending replay excludes reminders before its one-event buffer fills", async () => {
    let admitted = false;
    const fanout = createFanoutAdapter((listener) => {
      // beginReplay subscribes before reading replay. Synchronous fanout here
      // guarantees all three events arrive while replay is still pending.
      listener(reminder);
      listener({ ...reminder, eventId: "second-reminder" });
      listener(normal);
      admitted = true;
    });
    const fixture = await createFixture({
      maxPendingEvents: 1,
      realtime: fanout,
      postgres: { pool: harness.pool, schema: harness.schema },
    });
    try {
      const connection = await connect(fixture.url, { eventId: "cursor" });
      assert.equal(admitted, true);
      assert.deepEqual(await connection.nextMessage(), normal);
      // Also proves buffered/replayed copies of the normal event deduplicate.
      assert.equal(
        (await subscribe(connection, "private-a")).type,
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
      );
      assert.deepEqual(fixture.sessions[0].session.lastDeliveredCursor, {
        eventId: normal.eventId,
      });
      assert.deepEqual(
        connection.messages.filter((message) => message.eventId),
        [normal],
      );
      assert.equal(connection.socket.readyState, WebSocket.OPEN);
    } finally {
      await fixture.close();
    }
  });
});

test("PostgreSQL replay bounds cumulative admissions across buffer drains", async (t) => {
  const backend = await createPostgresTestBackend();
  t.after(() => backend.teardown());

  for (const overflow of [true, false]) {
    await t.test(overflow
      ? "closes before acceptance when successive batches exceed capacity"
      : "orders and deduplicates overlapping batches below capacity", async () => {
      const harness = await backend.createHarness({ schemaPrefix: "live_drains" });
      const schema = `"${harness.schema}"`;
      await createPostgresMigrationRunner({
        database: harness.pool,
        schema: harness.schema,
        migrations: handrailChatPostgresMigrations,
      }).apply();
      // The private user stream is authorized without any conversation fixture.
      const streamId = "user:user-a";
      const values = ["cursor", "z-first", "a-second", "y-third", "b-fourth", "overflow"]
        .map((id) => event(id, streamId));
      const seed = async (events) => {
        for (const value of events) {
          await harness.pool.query(
            `INSERT INTO ${schema}.chat_outbox_events
               (event_id, protocol_version, tenant_id, stream_id, type,
                occurred_at, payload, published_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
                     clock_timestamp(), clock_timestamp() + interval '1 day')`,
            [value.eventId, value.protocolVersion, value.tenantId, value.streamId,
              value.type, value.occurredAt, JSON.stringify(value.payload)],
          );
        }
      };
      await seed(values.slice(0, 3));

      const deferred = () => {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { promise, resolve };
      };
      const gates = Array.from({ length: 3 }, () => ({
        entered: deferred(), release: deferred(), completed: deferred(),
      }));
      const lookups = [];
      const completedLookups = [];
      const pool = {
        connect: (...args) => harness.pool.connect(...args),
        async query(sql, parameters) {
          if (!sql.includes("event_id = ANY($2::text[])")) {
            return harness.pool.query(sql, parameters);
          }
          const index = lookups.length;
          lookups.push([...parameters[1]]);
          const gate = gates[index];
          // Hold actual PostgreSQL results at the resolver's await boundary.
          // Even unexpected extra lookups still execute against PostgreSQL.
          try {
            const result = await harness.pool.query(sql, parameters);
            gate?.entered.resolve(result.rows.map((row) => row.event_id));
            if (gate) await gate.release.promise;
            return result;
          } finally {
            completedLookups.push(index);
            gate?.completed.resolve();
          }
        },
      };
      const fanout = createFanoutAdapter((listener) => {
        listener(values[2]);
        listener(values[1]);
      });
      const fixture = await createFixture({
        maxPendingEvents: overflow ? 4 : 6,
        realtime: fanout,
        postgres: { pool, schema: harness.schema },
      });
      let socket;
      try {
        // Observe the handshake directly: connect() assumes successful acceptance.
        socket = new WebSocket(fixture.url, {
          headers: { authorization: "Bearer actor-a" },
        });
        const messages = [];
        socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
        const closed = new Promise((resolve) => socket.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() })));
        const waitMessage = async (predicate) => {
          const observed = messages.find(predicate);
          if (observed) return observed;
          let listener;
          try {
            return await within(new Promise((resolve) => {
              listener = (data) => {
                const message = JSON.parse(data.toString());
                if (predicate(message)) resolve(message);
              };
              socket.on("message", listener);
            }), "socket message barrier");
          } finally {
            socket.off("message", listener);
          }
        };
        await within(new Promise((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        }), "socket open");
        socket.send(JSON.stringify({
          clientPackageVersion: "0.1.3",
          protocolVersion: CHAT_PROTOCOL_VERSION,
          resumeFrom: { eventId: "cursor" },
        }));
        assert.deepEqual(await within(gates[0].entered.promise, "first drain"),
          ["z-first", "a-second"]);
        assert.equal(fixture.runtime.webSocketSubscriptionCount, 1);
        assert.equal(fanout.subscriberCount, 1);
        assert.deepEqual(messages, []);

        // These events are committed after the initial replay page was read.
        await seed(values.slice(3, 5));
        await fanout.publish(values[4]);
        await fanout.publish(values[3]);
        gates[0].release.resolve();
        assert.deepEqual(await within(gates[1].entered.promise, "second drain"),
          ["y-third", "b-fourth"]);
        assert.equal(fanout.subscriberCount, 1);
        assert.deepEqual(messages, []);

        if (overflow) {
          // Batches of 2, 2, and 1 each fit a four-event budget individually.
          await seed(values.slice(5));
          await fanout.publish(values[5]);
          assert.deepEqual(await within(closed, "cumulative overflow close"),
            CHAT_WEBSOCKET_CLOSE_REASONS.slowConsumer);
          assert.equal(fanout.subscriberCount, 0);
          assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
          assert.equal(fixture.runtime.webSocketSessionCount, 0);
          assert.deepEqual(fixture.sessions, []);
          assert.deepEqual(completedLookups, [0]);
          gates[1].release.resolve();
          await within(gates[1].completed.promise, "late PostgreSQL completion");
          // User-stream authorization and resolver/handshake continuations are
          // microtasks; cross an event-loop barrier after the held query returns.
          await new Promise((resolve) => setImmediate(resolve));
          await fanout.publish(values[1]);
          assert.deepEqual(completedLookups, [0, 1]);
          assert.equal(lookups.length, 2);
          assert.equal(fanout.subscriberCount, 0);
          assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
          assert.equal(fixture.runtime.webSocketSessionCount, 0);
          assert.deepEqual(fixture.sessions, []);
          assert.deepEqual(messages, []);
        } else {
          // Repeat an event present both in replay and in the first drain.
          await fanout.publish(values[1]);
          gates[1].release.resolve();
          assert.deepEqual(await within(gates[2].entered.promise, "third drain"),
            ["z-first"]);
          gates[2].release.resolve();
          await waitMessage((message) => message.type === "chat.session.accepted");
          await waitMessage((message) => message.eventId === "b-fourth");
          await fanout.publish(values[4]);
          socket.send(JSON.stringify({
            type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
            requestId: "drain-barrier", streamId,
          }));
          await waitMessage((message) => message.requestId === "drain-barrier");
          assert.deepEqual(messages.filter((message) => message.eventId), values.slice(1, 5));
          assert.equal(messages.filter((message) => message.type === "chat.session.accepted").length, 1);
          assert.equal(socket.readyState, WebSocket.OPEN);
          assert.equal(fixture.runtime.webSocketSubscriptionCount, 1);
          assert.deepEqual(fixture.sessions[0].session.lastDeliveredCursor, { eventId: "b-fourth" });
          assert.deepEqual(completedLookups, [0, 1, 2]);
        }
        assert.deepEqual(lookups, overflow
          ? [["a-second", "z-first"], ["b-fourth", "y-third"]]
          : [["a-second", "z-first"], ["b-fourth", "y-third"], ["z-first"]]);
      } finally {
        // A failed assertion must never leave a resolver or socket held open.
        for (const gate of gates) gate.release.resolve();
        socket?.terminate();
        await fixture.close();
        await Promise.all(gates.slice(0, lookups.length).map((gate) =>
          within(gate.completed.promise, "query cleanup")));
      }
    });
  }
});

test("delivers authorized events in order and safely filters invalid fanout", async () => {
  const fixture = await createFixture();
  try {
    fixture.conversations.set(conversationKey("tenant-a", "private-a"), {
      type: "channel",
      visibility: "private",
      members: new Map([["user-a", "active"]]),
    });
    const connection = await connect(fixture.url);
    assert.equal(
      (await subscribe(connection, "private-a")).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );
    assert.equal(fixture.fanout.subscriberCount, 1);

    const first = fixture.fanout.publish(event("event-1", "private-a"));
    const second = fixture.fanout.publish(event("event-2", "private-a"));
    await Promise.all([first, second]);
    const delivered = await Promise.all([
      connection.nextMessage(),
      connection.nextMessage(),
    ]);
    assert.deepEqual(
      delivered.map(({ eventId }) => eventId),
      ["event-1", "event-2"],
    );
    await waitFor(
      () => fixture.sessions[0].session.lastDeliveredCursor?.eventId === "event-2",
    );

    const receivedBeforeDrops = connection.receivedCount;
    await Promise.all([
      fixture.fanout.publish(event("event-2", "private-a")),
      fixture.fanout.publish(event("other-stream", "not-subscribed")),
      fixture.fanout.publish(
        event("other-tenant", "private-a", { tenantId: "tenant-b" }),
      ),
      fixture.fanout.publish({ malformed: true }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(connection.receivedCount, receivedBeforeDrops);
    assert.equal(connection.socket.readyState, WebSocket.OPEN);

    assert.equal(
      (await unsubscribe(connection, "private-a")).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed,
    );
    assert.equal(fixture.fanout.subscriberCount, 0);

    await subscribe(connection, "user:user-a");
    assert.equal(fixture.fanout.subscriberCount, 1);
    connection.socket.terminate();
    await connection.closed;
    await waitFor(() => fixture.fanout.subscriberCount === 0);
  } finally {
    await fixture.close();
  }
});

test("uses a configured subscribable fanout while retaining publish-only compatibility", async () => {
  const configuredFanout = createFanoutAdapter();
  const fixture = await createFixture({ realtime: configuredFanout });
  try {
    const connection = await connect(fixture.url);
    await subscribe(connection, "user:user-a");
    assert.equal(configuredFanout.subscriberCount, 1);
    assert.equal(fixture.runtime.realtimeHub.subscriberCount, 0);

    await configuredFanout.publish(event("configured-1", "user:user-a"));
    assert.equal((await connection.nextMessage()).eventId, "configured-1");

    fixture.runtime.detachWebSocket();
    await connection.closed;
    assert.equal(configuredFanout.subscriberCount, 0);
  } finally {
    await fixture.close();
  }

  const publishOnly = { async publish() {} };
  const publishOnlyFixture = await createFixture({ realtime: publishOnly });
  try {
    const connection = await connect(publishOnlyFixture.url);
    assert.equal(
      (await subscribe(connection, "user:user-a")).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
    );
  } finally {
    await publishOnlyFixture.close();
  }
});

test("clustered delivery fans out across runtimes and cleans up idempotently", async () => {
  const sharedFanout = createFanoutAdapter();
  const firstFixture = await createFixture({
    realtime: sharedFanout,
    realtimeDelivery: "clustered",
  });
  const secondFixture = await createFixture({
    realtime: sharedFanout,
    realtimeDelivery: "clustered",
  });
  try {
    const firstConnection = await connect(firstFixture.url);
    const secondConnection = await connect(secondFixture.url);
    await subscribe(firstConnection, "user:user-a");
    await subscribe(secondConnection, "user:user-a");
    assert.equal(sharedFanout.subscriberCount, 2);

    await sharedFanout.publish(event("clustered-1", "user:user-a"));
    assert.equal((await firstConnection.nextMessage()).eventId, "clustered-1");
    assert.equal((await secondConnection.nextMessage()).eventId, "clustered-1");

    await unsubscribe(secondConnection, "user:user-a");
    await unsubscribe(secondConnection, "user:user-a");
    assert.equal(sharedFanout.subscriberCount, 1);

    const firstClose = firstFixture.runtime.close();
    assert.equal(firstFixture.runtime.close(), firstClose);
    await firstClose;
    await firstFixture.runtime.close();
    assert.equal(sharedFanout.subscriberCount, 0);
  } finally {
    await firstFixture.close();
    await secondFixture.close();
  }
});

test("closes a bounded slow consumer with its last delivered cursor", async () => {
  const fixture = await createFixture({ maxPendingEvents: 1 });
  try {
    const connection = await connect(fixture.url);
    await subscribe(connection, "user:user-a");

    await fixture.fanout.publish(event("event-1", "user:user-a"));
    assert.equal((await connection.nextMessage()).eventId, "event-1");
    await waitFor(
      () => fixture.sessions[0].session.lastDeliveredCursor?.eventId === "event-1",
    );

    const second = fixture.fanout.publish(event("event-2", "user:user-a"));
    const overflow = fixture.fanout.publish(event("event-3", "user:user-a"));
    await Promise.all([second, overflow]);

    assert.deepEqual(await connection.closed, {
      code: CHAT_WEBSOCKET_CLOSE_REASONS.slowConsumer.code,
      reason: `${CHAT_WEBSOCKET_SLOW_CONSUMER_CURSOR_PREFIX}event-1`,
    });
    assert.equal(fixture.fanout.subscriberCount, 0);
    assert.equal(fixture.runtime.webSocketSubscriptionCount, 0);
  } finally {
    await fixture.close();
  }
});

test("revocation removes the fanout listener and queued stream work", async () => {
  const fixture = await createFixture();
  try {
    const privateConversation = {
      type: "channel",
      visibility: "private",
      members: new Map([["user-a", "active"]]),
    };
    fixture.conversations.set(
      conversationKey("tenant-a", "private-revoked"),
      privateConversation,
    );
    const connection = await connect(fixture.url);
    await subscribe(connection, "private-revoked");
    assert.equal(fixture.fanout.subscriberCount, 1);

    privateConversation.members.set("user-a", "removed");
    assert.equal(
      await fixture.runtime.revalidateWebSocketSubscriptions({
        tenantId: "tenant-a",
        streamId: "private-revoked",
      }),
      1,
    );
    assert.equal(
      (await connection.nextMessage()).type,
      CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.revoked,
    );
    assert.equal(fixture.fanout.subscriberCount, 0);

    const countBefore = connection.receivedCount;
    await fixture.fanout.publish(event("revoked", "private-revoked"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(connection.receivedCount, countBefore);
  } finally {
    await fixture.close();
  }
});
