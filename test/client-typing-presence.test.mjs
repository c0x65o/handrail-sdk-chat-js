import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatRealtimeSession,
  createNormalizedChatCache,
  selectPresenceSignals,
  selectTypingSignals,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const startTime = Date.parse("2026-08-26T12:00:00.000Z");

class FakeClock {
  time = startTime;
  sequence = 0;
  tasks = new Map();

  now() { return this.time; }
  setTimeout(callback, delayMs) {
    const handle = ++this.sequence;
    this.tasks.set(handle, { callback, due: this.time + delayMs });
    return handle;
  }
  clearTimeout(handle) { this.tasks.delete(handle); }
  advance(delayMs) {
    const target = this.time + delayMs;
    while (true) {
      const entry = [...this.tasks.entries()].sort(
        ([leftId, left], [rightId, right]) =>
          left.due - right.due || leftId - rightId,
      )[0];
      if (entry === undefined || entry[1].due > target) break;
      const [handle, task] = entry;
      this.tasks.delete(handle);
      this.time = task.due;
      task.callback();
    }
    this.time = target;
  }
}

class FakeNetwork {
  online = true;
  listeners = { online: new Set(), offline: new Set() };
  isOnline() { return this.online; }
  addEventListener(type, listener) { this.listeners[type].add(listener); }
  removeEventListener(type, listener) { this.listeners[type].delete(listener); }
  setOnline(online) {
    this.online = online;
    for (const listener of this.listeners[online ? "online" : "offline"]) listener();
  }
}

class FakeVisibility {
  visible = true;
  listeners = new Set();
  isVisible() { return this.visible; }
  addEventListener(_type, listener) { this.listeners.add(listener); }
  removeEventListener(_type, listener) { this.listeners.delete(listener); }
  setVisible(visible) {
    this.visible = visible;
    for (const listener of this.listeners) listener();
  }
}

class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  disconnect() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "lost" });
  }
}

const metadata = (features = { typing: true, presence: true }) => ({
  packageVersion: "0.1.3",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: features,
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION - 1,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
});

const accepted = (features, sessionId = "session-a") => ({
  type: "chat.session.accepted",
  metadata: metadata(features),
  tenantId: "tenant-a",
  actorStreamId: "user:user-a",
  deviceId: "device-a",
  sessionId,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function hydrateConversation(cache, conversationId, visibility = "private") {
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [{
      id: conversationId,
      tenantId: "tenant-a",
      type: visibility === "public" ? "channel" : "direct",
      visibility,
      ...(visibility === "public" ? { name: "General" } : {}),
      createdAt: new Date(startTime - 1_000).toISOString(),
      updatedAt: new Date(startTime).toISOString(),
      latestSequence: 0,
      activityAt: new Date(startTime).toISOString(),
      currentMember: {
        tenantId: "tenant-a",
        conversationId,
        userId: "user-a",
        role: "member",
        state: "active",
        joinedAt: new Date(startTime - 1_000).toISOString(),
        updatedAt: new Date(startTime).toISOString(),
      },
      currentReadState: {
        conversationId,
        userId: "user-a",
        lastReadSequence: 0,
        updatedAt: new Date(startTime).toISOString(),
      },
      currentPreference: {
        conversationId,
        userId: "user-a",
        notificationPreference: "all",
        mute: { muted: false },
        updatedAt: new Date(startTime).toISOString(),
      },
    }],
    page: {},
    _meta: {
      ...metadata(),
      feature: { name: "conversation_snapshots", version: 1 },
    },
  });
}

function createFixture(overrides = {}) {
  const clock = overrides.clock ?? new FakeClock();
  const network = overrides.network ?? new FakeNetwork();
  const visibility = overrides.visibility ?? new FakeVisibility();
  const cache = overrides.cache ?? createNormalizedChatCache();
  const sockets = [];
  const session = createChatRealtimeSession({
    endpoint: "/api/chat",
    clientPackageVersion: "0.1.3",
    getAccessToken: () => "token",
    cache,
    clock,
    network,
    random: () => 0.5,
    ephemeralSignals: {
      clock,
      visibility,
      typingTtlMs: 100,
      typingHeartbeatMs: 30,
      typingIdleMs: 70,
      presenceTtlMs: 300,
      presenceHeartbeatMs: 100,
      presenceIdleMs: 150,
      rateLimitMaxSignals: overrides.rateLimitMaxSignals ?? 20,
      rateLimitWindowMs: 100,
      ...overrides.ephemeralSignals,
    },
    webSocketFactory() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { session, cache, clock, network, visibility, sockets };
}

async function connect(fixture, features = { typing: true, presence: true }, index = 0) {
  fixture.session.start();
  await flush();
  const socket = fixture.sockets[index];
  socket.open();
  socket.message(accepted(features, `session-${index + 1}`));
  return socket;
}

function authorize(fixture, socket, conversationId, visibility = "private") {
  hydrateConversation(fixture.cache, conversationId, visibility);
  const unsubscribe = fixture.session.subscribeConversation(conversationId);
  socket.message({
    type: "chat.subscription.accepted",
    requestId: `subscription-${conversationId}`,
    streamId: conversationId,
  });
  return unsubscribe;
}

const frames = (socket, type) => socket.sent.filter((frame) => frame.type === type);

test("typing starts, heartbeats, refreshes idle, and sends a terminal stop", async () => {
  const fixture = createFixture();
  const socket = await connect(fixture);
  authorize(fixture, socket, "conversation-a");

  assert.equal(fixture.session.startTyping("conversation-a"), true);
  assert.deepEqual(frames(socket, "typing.signal").map((frame) => frame.payload.state), ["start"]);
  fixture.clock.advance(30);
  assert.deepEqual(frames(socket, "typing.signal").map((frame) => frame.payload.state), ["start", "start"]);

  assert.equal(fixture.session.startTyping("conversation-a"), true);
  fixture.clock.advance(60);
  assert.deepEqual(frames(socket, "typing.signal").map((frame) => frame.payload.state), ["start", "start", "start", "start"]);
  fixture.clock.advance(10);
  assert.equal(frames(socket, "typing.signal").at(-1).payload.state, "stop");
});

test("visibility, presence idle, offline, and reconnect transitions are safe", async () => {
  const fixture = createFixture();
  const socket = await connect(fixture);
  authorize(fixture, socket, "conversation-a");
  fixture.session.startTyping("conversation-a");

  fixture.visibility.setVisible(false);
  assert.equal(frames(socket, "typing.signal").at(-1).payload.state, "stop");
  assert.equal(frames(socket, "presence.signal").at(-1).payload.state, "away");
  fixture.visibility.setVisible(true);
  assert.equal(frames(socket, "presence.signal").at(-1).payload.state, "online");
  fixture.clock.advance(150);
  assert.equal(frames(socket, "presence.signal").at(-1).payload.state, "away");
  fixture.session.notifyActivity();
  assert.equal(frames(socket, "presence.signal").at(-1).payload.state, "online");

  fixture.network.setOnline(false);
  assert.equal(frames(socket, "presence.signal").at(-1).payload.state, "offline");
  assert.deepEqual(fixture.cache.getState().ephemeral, { typing: {}, presence: {} });
  fixture.network.setOnline(true);
  await flush();
  const next = fixture.sockets[1];
  assert.equal(frames(next, "presence.signal").length, 0);
  next.open();
  next.message(accepted({ typing: true, presence: true }, "session-2"));
  assert.equal(frames(next, "presence.signal").at(-1).payload.state, "online");
  const realtimeNow = fixture.clock.now();
  next.message({
    eventId: "remote-presence",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: "tenant-a",
    streamId: "user:user-a",
    type: "presence.signal",
    occurredAt: new Date(realtimeNow).toISOString(),
    payload: {
      capability: "presence",
      durability: "ephemeral",
      actorUserId: "user-b",
      deviceId: "device-b",
      sessionId: "session-b",
      sequence: 1,
      sentAt: new Date(realtimeNow).toISOString(),
      expiresAt: new Date(realtimeNow + 100).toISOString(),
      state: "online",
      scope: { type: "user_private", userId: "user-a" },
    },
  });
  assert.equal(selectPresenceSignals(fixture.cache.getState()).length, 1);
  fixture.session.restart();
  assert.deepEqual(fixture.cache.getState().ephemeral, { typing: {}, presence: {} });
  assert.equal(frames(next, "presence.signal").at(-1).payload.state, "offline");
});

test("client rate limits non-terminal signals and recovers after its window", async () => {
  const fixture = createFixture({ rateLimitMaxSignals: 2 });
  const socket = await connect(fixture);
  authorize(fixture, socket, "conversation-a");
  authorize(fixture, socket, "conversation-b");

  // Initial online presence consumes one slot; the first typing start consumes the other.
  assert.equal(fixture.session.startTyping("conversation-a"), true);
  assert.equal(fixture.session.startTyping("conversation-b"), false);
  fixture.clock.advance(100);
  assert.equal(fixture.session.startTyping("conversation-b"), true);
  fixture.session.stopTyping("conversation-b");
  assert.equal(frames(socket, "typing.signal").at(-1).payload.state, "stop");
});

test("incoming signals use fake wall time, expire, reject stale order, and clear on disconnect", async () => {
  const fixture = createFixture();
  const socket = await connect(fixture);
  const unsubscribe = authorize(fixture, socket, "conversation-a");
  const signal = (eventId, state, sentOffset, sessionId = "remote-session") => ({
    eventId,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: "tenant-a",
    streamId: "conversation-a",
    type: "typing.signal",
    occurredAt: new Date(startTime + sentOffset).toISOString(),
    payload: {
      capability: "typing",
      durability: "ephemeral",
      actorUserId: "user-b",
      deviceId: "remote-device",
      sessionId,
      sequence: Math.max(1, sentOffset),
      sentAt: new Date(startTime + sentOffset).toISOString(),
      expiresAt: new Date(startTime + sentOffset + 100).toISOString(),
      state,
      scope: {
        type: "conversation",
        conversationId: "conversation-a",
        visibility: "private",
        audience: "members",
      },
    },
  });

  socket.message(signal("newer", "start", 10));
  socket.message(signal("older", "stop", 5));
  assert.deepEqual(selectTypingSignals(fixture.cache.getState(), "conversation-a").map(({ userId }) => userId), ["user-b"]);
  fixture.clock.advance(110);
  assert.deepEqual(selectTypingSignals(fixture.cache.getState(), "conversation-a"), []);

  socket.message(signal("live-again", "start", 111, "remote-session-2"));
  assert.equal(selectTypingSignals(fixture.cache.getState(), "conversation-a").length, 1);
  unsubscribe();
  assert.deepEqual(fixture.cache.getState().ephemeral, { typing: {}, presence: {} });
  authorize(fixture, socket, "conversation-a");
  socket.message(signal("live-before-disconnect", "start", 112, "remote-session-3"));
  assert.equal(selectTypingSignals(fixture.cache.getState(), "conversation-a").length, 1);
  socket.disconnect();
  assert.deepEqual(fixture.cache.getState().ephemeral, { typing: {}, presence: {} });
});

for (const departingSession of ["remote-1", "remote-2"]) {
  for (const completion of ["stop", "expiry"]) {
    test(`typing survives ${departingSession} disconnect until survivor ${completion}`, async (t) => {
      const fixture = createFixture();
      t.after(() => fixture.session.close());
      const socket = await connect(fixture);
      authorize(fixture, socket, "conversation-a");
      const survivor = departingSession === "remote-1" ? "remote-2" : "remote-1";
      const signal = (sessionId, state, sequence) => {
        const sentAt = new Date(fixture.clock.now()).toISOString();
        socket.message({
          eventId: `${sessionId}-${sequence}`,
          protocolVersion: CHAT_PROTOCOL_VERSION,
          tenantId: "tenant-a",
          streamId: "conversation-a",
          type: "typing.signal",
          occurredAt: sentAt,
          payload: {
            capability: "typing",
            durability: "ephemeral",
            actorUserId: "user-b",
            deviceId: "remote-device",
            sessionId,
            sequence,
            sentAt,
            expiresAt: new Date(fixture.clock.now() + 100).toISOString(),
            state,
            scope: {
              type: "conversation",
              conversationId: "conversation-a",
              visibility: "private",
              audience: "members",
            },
          },
        });
      };
      const typing = () => selectTypingSignals(fixture.cache.getState(), "conversation-a");

      signal("remote-1", "start", 1);
      fixture.clock.advance(1);
      signal("remote-2", "start", 1);
      assert.deepEqual(typing().map(({ userId }) => userId), ["user-b"]);
      fixture.clock.advance(1);
      signal(survivor, "start", 9);
      const survivorTyping = typing();
      fixture.clock.advance(1);
      // Disconnect emits a stop for only the departing session. Its sequence
      // is independent of the survivor's sequence, as in the campaign trace.
      signal(departingSession, "stop", 7);
      assert.equal(Object.keys(fixture.cache.getState().ephemeral.typing).length, 2);
      assert.deepEqual(typing(), survivorTyping);

      fixture.clock.advance(50);
      signal(survivor, "start", 10);
      assert.equal(typing()[0].sentAt, new Date(fixture.clock.now()).toISOString());
      // The original starts and the departing stop expire before the refresh.
      fixture.clock.advance(50);
      assert.equal(typing().length, 1);
      if (completion === "stop") {
        signal(survivor, "stop", 11);
      } else {
        fixture.clock.advance(49);
        assert.equal(typing().length, 1);
        fixture.clock.advance(1);
      }
      assert.deepEqual(typing(), []);
    });
  }
}

test("disabled features send nothing and scoped selectors exclude unauthorized data", async () => {
  const fixture = createFixture();
  const socket = await connect(fixture, { typing: false, presence: false });
  authorize(fixture, socket, "conversation-a");
  assert.equal(fixture.session.startTyping("conversation-a"), false);
  fixture.session.setPresence("away");
  assert.equal(frames(socket, "typing.signal").length, 0);
  assert.equal(frames(socket, "presence.signal").length, 0);

  const cache = createNormalizedChatCache({
    tenantId: "tenant-a",
    userId: "user-a",
    sessionId: "selector-session",
  });
  hydrateConversation(cache, "authorized");
  const incoming = (conversationId) => ({
    eventId: `typing-${conversationId}`,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: "tenant-a",
    streamId: conversationId,
    type: "typing.signal",
    occurredAt: new Date(startTime).toISOString(),
    payload: {
      capability: "typing",
      durability: "ephemeral",
      actorUserId: "user-b",
      deviceId: "device-b",
      sessionId: "session-b",
      sequence: 1,
      sentAt: new Date(startTime).toISOString(),
      expiresAt: new Date(startTime + 100).toISOString(),
      state: "start",
      scope: {
        type: "conversation",
        conversationId,
        visibility: "private",
        audience: "members",
      },
    },
  });
  cache.applyEphemeralSignal(incoming("authorized"), startTime);
  cache.applyEphemeralSignal(incoming("unrelated"), startTime);
  assert.deepEqual(selectTypingSignals(cache.getState(), "authorized").map(({ userId }) => userId), ["user-b"]);
  assert.deepEqual(selectTypingSignals(cache.getState(), "unrelated"), []);
  const privatePresence = {
    eventId: "presence-authorized",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: "tenant-a",
    streamId: "user:user-a",
    type: "presence.signal",
    occurredAt: new Date(startTime).toISOString(),
    payload: {
      capability: "presence",
      durability: "ephemeral",
      actorUserId: "user-b",
      deviceId: "device-b",
      sessionId: "session-b",
      sequence: 1,
      sentAt: new Date(startTime).toISOString(),
      expiresAt: new Date(startTime + 100).toISOString(),
      state: "online",
      scope: { type: "user_private", userId: "user-a" },
    },
  };
  cache.applyEphemeralSignal(privatePresence, startTime);
  assert.deepEqual(selectPresenceSignals(cache.getState()).map(({ userId }) => userId), ["user-b"]);
  assert.throws(() =>
    cache.applyEphemeralSignal({
      ...privatePresence,
      eventId: "presence-unrelated",
      streamId: "user:user-other",
      payload: {
        ...privatePresence.payload,
        scope: { type: "user_private", userId: "user-other" },
      },
    }, startTime),
  );
});
