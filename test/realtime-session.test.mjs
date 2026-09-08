import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createChatRealtimeSession,
  createNormalizedChatCache,
  selectConversationUnreadMentionCount,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  CHAT_REALTIME_SUBPROTOCOL,
  CHAT_REFRESH_REQUIRED_MESSAGE,
} from "../dist/index.js";

const metadata = {
  packageVersion: "0.1.3",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { realtime: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION - 1,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};

const accepted = (overrides = {}) => ({
  type: "chat.session.accepted",
  metadata,
  tenantId: "tenant-a",
  actorStreamId: "user:actor-a",
  deviceId: "device-a",
  sessionId: "session-a",
  ...overrides,
});

const event = (eventId, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: "tenant-a",
  streamId: "conversation-a",
  type: "message.created",
  occurredAt: "2026-08-25T20:00:00.000Z",
  payload: { body: "delivered" },
  ...overrides,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

class FakeClock {
  now = 0;
  sequence = 0;
  tasks = new Map();

  setTimeout(callback, delayMs) {
    const handle = ++this.sequence;
    this.tasks.set(handle, { callback, due: this.now + delayMs, delayMs });
    return handle;
  }

  clearTimeout(handle) {
    this.tasks.delete(handle);
  }

  get delays() {
    return [...this.tasks.values()].map(({ delayMs }) => delayMs);
  }

  runNext() {
    const entry = [...this.tasks.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        left.due - right.due || leftId - rightId,
    )[0];
    assert.ok(entry, "expected a pending fake-clock task");
    const [handle, task] = entry;
    this.tasks.delete(handle);
    this.now = task.due;
    task.callback();
  }
}

class FakeNetwork {
  online = true;
  listeners = { online: new Set(), offline: new Set() };

  isOnline() {
    return this.online;
  }

  addEventListener(type, listener) {
    this.listeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type].delete(listener);
  }

  setOnline(online) {
    this.online = online;
    for (const listener of this.listeners[online ? "online" : "offline"]) {
      listener();
    }
  }
}

class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  closeCalls = 0;

  send(serialized) {
    this.sent.push(JSON.parse(serialized));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  disconnect() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "transport detail" });
  }
}

const createFixture = (overrides = {}) => {
  const sockets = [];
  const protocolChecks = [];
  const clock = overrides.clock ?? new FakeClock();
  const network = overrides.network ?? new FakeNetwork();
  let tokenCalls = 0;
  const expectedTokens = overrides.tokens ?? ["fresh-token-1", "fresh-token-2"];
  const getAccessToken = overrides.getAccessToken ?? (() => {
    const token = expectedTokens[tokenCalls] ?? `fresh-token-${tokenCalls + 1}`;
    tokenCalls += 1;
    return token;
  });
  const session = createChatRealtimeSession({
    endpoint: "https://chat.example.test/api/chat/",
    clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
    getAccessToken,
    clock,
    network,
    random: overrides.random ?? (() => 0.5),
    storage: overrides.storage,
    retry: overrides.retry,
    hydrateSnapshot: overrides.hydrateSnapshot,
    onEvent: overrides.onEvent,
    webSocketFactory(url, protocols) {
      const expectedToken = expectedTokens[sockets.length];
      protocolChecks.push(
        url === "wss://chat.example.test/api/chat/_realtime" &&
          protocols[0] === CHAT_REALTIME_SUBPROTOCOL &&
          protocols[1] ===
            `${CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX}${Buffer.from(expectedToken ?? "").toString("base64url")}` &&
          !url.includes(expectedToken ?? "fresh-token"),
      );
      if (overrides.socketError) throw overrides.socketError;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return {
    session,
    sockets,
    clock,
    network,
    protocolChecks,
    get tokenCalls() {
      return tokenCalls;
    },
  };
};

const openAndAccept = async (fixture, index, message = accepted()) => {
  await flush();
  const socket = fixture.sockets[index];
  assert.ok(socket);
  socket.open();
  socket.message(message);
  await flush();
  return socket;
};

test("connects lazily with browser-safe auth and a typed current handshake", async () => {
  const fixture = createFixture();
  fixture.session.subscribeConversation("conversation-a");
  assert.equal(fixture.tokenCalls, 0);
  fixture.session.start();
  const socket = await openAndAccept(fixture, 0);

  assert.deepEqual(fixture.protocolChecks, [true]);
  assert.deepEqual(socket.sent[0], {
    clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
    protocolVersion: CHAT_PROTOCOL_VERSION,
  });
  assert.deepEqual(
    socket.sent.slice(1).map(({ type, streamId }) => ({ type, streamId })),
    [
      { type: "chat.subscribe", streamId: "user:actor-a" },
      { type: "chat.subscribe", streamId: "conversation-a" },
    ],
  );
  assert.equal(fixture.session.state.state, "connected");
});

test("createChatClient starts and closes its configured realtime session", async () => {
  const sockets = [];
  let tokenCalls = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken() {
      tokenCalls += 1;
      return `lifecycle-token-${tokenCalls}`;
    },
    async fetch() {
      return { ok: true, status: 200, json: async () => metadata };
    },
    realtime: {
      webSocketFactory() {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  });

  assert.equal(client.realtime.state.state, "idle");
  assert.equal((await client.start()).state, "ready");
  await flush();
  assert.equal(tokenCalls, 2);
  assert.equal(sockets.length, 1);
  sockets[0].open();
  sockets[0].message({
    type: "chat.session.refresh_required",
    state: "refresh_required",
    reason: "unsupported_protocol",
    message: CHAT_REFRESH_REQUIRED_MESSAGE,
    requestedProtocolVersion: CHAT_PROTOCOL_VERSION,
    metadata,
  });
  assert.equal(client.state.state, "refresh_required");
  client.close();
  assert.equal(client.realtime.state.state, "idle");
  assert.equal(sockets[0].closeCalls, 1);
});

test("uses a fresh token, replays the durable cursor, and restores subscriptions", async () => {
  const writes = [];
  const fixture = createFixture({
    storage: {
      getItem() { return null; },
      setItem(_key, value) { writes.push(value); },
      removeItem() {},
    },
  });
  fixture.session.subscribeConversation("conversation-a");
  fixture.session.start();
  const first = await openAndAccept(fixture, 0);
  first.message(event("event-1"));
  first.disconnect();
  assert.deepEqual(fixture.clock.delays, [1_000]);
  fixture.clock.runNext();
  const second = await openAndAccept(fixture, 1, accepted({ resumeFrom: { eventId: "event-1" } }));

  assert.equal(fixture.tokenCalls, 2);
  assert.deepEqual(fixture.protocolChecks, [true, true]);
  assert.deepEqual(second.sent[0].resumeFrom, { eventId: "event-1" });
  assert.deepEqual(
    second.sent.slice(1).map(({ streamId }) => streamId),
    ["user:actor-a", "conversation-a"],
  );
  assert.deepEqual(writes, [JSON.stringify({ eventId: "event-1" })]);
});

test("applies deterministic jitter, caps exponential backoff, and resets after acceptance", async () => {
  let calls = 0;
  const fixture = createFixture({
    getAccessToken() {
      calls += 1;
      if (calls < 3) throw new Error("provider detail");
      return `token-${calls}`;
    },
    random: () => 1,
    retry: {
      initialDelayMs: 100,
      maximumDelayMs: 250,
      multiplier: 2,
      jitterRatio: 0.5,
    },
  });
  fixture.session.start();
  await flush();
  assert.equal(fixture.session.state.delayMs, 150);
  fixture.clock.runNext();
  await flush();
  assert.equal(fixture.session.state.delayMs, 250);
  fixture.clock.runNext();
  const socket = await openAndAccept(fixture, 0);
  socket.disconnect();
  assert.equal(fixture.session.state.delayMs, 150);
});

test("hydrates a snapshot once, replaces the expired cursor, and reconnects", async () => {
  const stored = [];
  const hydration = [];
  const fixture = createFixture({
    storage: {
      getItem() { return JSON.stringify({ eventId: "expired-event" }); },
      setItem(_key, value) { stored.push(value); },
      removeItem() { stored.push(null); },
    },
    async hydrateSnapshot(input) {
      hydration.push({ reason: input.reason, cursor: input.expiredCursor });
      return { eventId: "snapshot-boundary" };
    },
  });
  fixture.session.start();
  await flush();
  const first = fixture.sockets[0];
  first.open();
  assert.deepEqual(first.sent[0].resumeFrom, { eventId: "expired-event" });
  first.message({
    type: "chat.session.snapshot_required",
    state: "snapshot_required",
    reason: "replay_expired",
    metadata,
    resumeFrom: { eventId: "expired-event" },
  });
  await flush();
  assert.deepEqual(hydration, [
    { reason: "replay_expired", cursor: { eventId: "expired-event" } },
  ]);
  fixture.clock.runNext();
  await flush();
  const second = fixture.sockets[1];
  second.open();
  assert.deepEqual(second.sent[0].resumeFrom, { eventId: "snapshot-boundary" });
  assert.deepEqual(stored, [null, JSON.stringify({ eventId: "snapshot-boundary" })]);
});

test("surfaces refresh-required and stops reconnects until explicit restart", async () => {
  const fixture = createFixture();
  fixture.session.start();
  await flush();
  const socket = fixture.sockets[0];
  socket.open();
  socket.message({
    type: "chat.session.refresh_required",
    state: "refresh_required",
    reason: "unsupported_protocol",
    message: CHAT_REFRESH_REQUIRED_MESSAGE,
    requestedProtocolVersion: CHAT_PROTOCOL_VERSION,
    metadata,
  });
  assert.equal(fixture.session.state.state, "refresh_required");
  assert.equal(fixture.session.state.message, CHAT_REFRESH_REQUIRED_MESSAGE);
  assert.equal(fixture.clock.tasks.size, 0);
  fixture.session.start();
  assert.equal(fixture.sockets.length, 1);
  fixture.network.setOnline(false);
  fixture.network.setOnline(true);
  await flush();
  assert.equal(fixture.sockets.length, 1);
  fixture.session.restart();
  await flush();
  assert.equal(fixture.sockets.length, 2);
});

test("pauses while offline and resumes immediately on the online signal", async () => {
  const network = new FakeNetwork();
  network.online = false;
  const fixture = createFixture({ network });
  fixture.session.start();
  await flush();
  assert.equal(fixture.session.state.state, "offline");
  assert.equal(fixture.tokenCalls, 0);
  network.setOnline(true);
  await flush();
  assert.equal(fixture.tokenCalls, 1);
  const socket = await openAndAccept(fixture, 0);
  socket.disconnect();
  assert.equal(fixture.clock.tasks.size, 1);
  network.setOnline(false);
  assert.equal(fixture.clock.tasks.size, 0);
  network.setOnline(true);
  await flush();
  assert.equal(fixture.tokenCalls, 2);
});

test("close aborts token acquisition and removes every retry/listener effect", async () => {
  let resolveToken;
  let signal;
  const network = new FakeNetwork();
  const fixture = createFixture({
    network,
    getAccessToken(context) {
      signal = context.signal;
      return new Promise((resolve) => { resolveToken = resolve; });
    },
  });
  fixture.session.start();
  await flush();
  fixture.session.close();
  fixture.session.close();
  assert.equal(signal.aborted, true);
  resolveToken("late-secret");
  await flush();
  network.setOnline(false);
  network.setOnline(true);
  assert.equal(fixture.sockets.length, 0);
  assert.equal(fixture.clock.tasks.size, 0);
  assert.equal(network.listeners.online.size, 0);
  assert.equal(network.listeners.offline.size, 0);
});

test("tolerates throwing storage and persists only valid durable cursors", async () => {
  const fixture = createFixture({
    storage: {
      getItem() { throw new Error("storage read detail"); },
      setItem() { throw new Error("storage write detail"); },
      removeItem() { throw new Error("storage remove detail"); },
    },
  });
  fixture.session.start();
  const socket = await openAndAccept(fixture, 0);
  socket.message(event("wrong-tenant", { tenantId: "tenant-b" }));
  socket.message(event("ephemeral", { type: "typing.signal" }));
  socket.message(event("durable"));
  socket.disconnect();
  fixture.clock.runNext();
  await flush();
  fixture.sockets[1].open();
  assert.deepEqual(fixture.sockets[1].sent[0].resumeFrom, { eventId: "durable" });
});

test("public state and diagnostics structurally redact tokens and thrown secrets", async () => {
  const tokenSecret = "token-never-for-diagnostics";
  const thrownSecret = "provider-secret-never-for-diagnostics";
  const fixture = createFixture({
    getAccessToken() {
      throw new Error(thrownSecret);
    },
  });
  fixture.session.start();
  await flush();
  const serialized = JSON.stringify({ session: fixture.session, state: fixture.session.state });
  assert.doesNotMatch(serialized, new RegExp(`${tokenSecret}|${thrownSecret}`));
  assert.deepEqual(fixture.session.state.diagnostic, {
    code: "access_token_failed",
    message: "Chat realtime credentials could not be obtained.",
  });

  const socketFailure = createFixture({
    tokens: [tokenSecret],
    socketError: new Error(`socket leaked ${tokenSecret}`),
  });
  socketFailure.session.start();
  await flush();
  assert.doesNotMatch(JSON.stringify(socketFailure.session), new RegExp(tokenSecret));
  assert.equal(socketFailure.session.state.diagnostic.code, "socket_connection_failed");
});

const replyAt = "2026-08-25T20:00:00.000Z";
const replySnapshot = (count, latestSequence = 2, id = "conversation-a") => ({
  kind: "conversation_detail",
  conversation: { id, tenantId: "tenant-a", type: "channel", visibility: "public", name: id,
    createdAt: replyAt, updatedAt: replyAt, activityAt: replyAt, latestSequence,
    unreadCount: latestSequence, unreadMentionCount: count, memberUserIds: ["actor-a", "bob"], activeMemberUserIds: ["actor-a", "bob"],
    currentMember: { tenantId: "tenant-a", conversationId: id, userId: "actor-a", role: "member", state: "active", joinedAt: replyAt, updatedAt: replyAt },
    currentReadState: { conversationId: id, userId: "actor-a", lastReadSequence: 0, updatedAt: replyAt },
    currentPreference: { conversationId: id, userId: "actor-a", notificationPreference: "all", isStarred: false, preferenceRevision: 0, mute: { muted: false }, updatedAt: replyAt },
  },
  _meta: { ...metadata, feature: { name: "conversation_snapshots", version: 1 } },
});
const replyMessage = (id, sequence, overrides = {}) => ({
  id, tenantId: "tenant-a", conversationId: "conversation-a", author: { type: "user", userId: "bob" },
  sequence, createdAt: replyAt, updatedAt: replyAt, revision: { revision: 1 },
  content: { format: "plain", text: "Friday" }, ...overrides,
});
const replyEvent = (id, message, type = "message.created") => event(id, { type,
  payload: { message, ...(type === "message.created" ? { clientMessageId: id } : {}) } });
const settleReplyRefresh = () => new Promise(setImmediate);

const replyClientFixture = (read) => {
  const cache = createNormalizedChatCache({ tenantId: "tenant-a", userId: "actor-a", sessionId: "session-a" });
  cache.hydrateConversationDetail(replySnapshot(0, 0));
  const sockets = [];
  const network = new FakeNetwork();
  const client = createChatClient({ endpoint: "/chat", getAccessToken: () => "token", cache,
    fetch: async (url, init) => ({ ok: true, status: 200,
      json: async () => url.endsWith("/_meta") ? metadata : await read(url, init) }),
    realtime: { network, webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } },
  });
  const connect = async () => {
    if (client.state.state === "idle") await client.start();
    await settleReplyRefresh();
    const socket = sockets.at(-1);
    socket.open(); socket.message(accepted());
    await settleReplyRefresh();
    assert.equal(client.realtime.state.state, "connected");
    return socket;
  };
  return { cache, client, connect, network, count: () => selectConversationUnreadMentionCount(cache.getState(), "conversation-a") };
};

test("live reply pings use detail authority on create, replay, deletion, missing source and reconnect", async () => {
  let authority = replySnapshot(0, 0);
  let reads = 0;
  const fixture = replyClientFixture(async () => { reads++; return authority; });
  try {
    const socket = await fixture.connect();
    const source = replyMessage("source", 1, { author: { type: "user", userId: "actor-a" } });
    socket.message(replyEvent("source-created", source));
    const reply = replyMessage("reply", 2, { replyTo: { messageId: "source", notifyAuthor: true } });
    authority = replySnapshot(1);
    socket.message(replyEvent("reply-created", reply));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 1);
    const reload = await fixture.client.getConversation({ conversationId: "conversation-a" });
    assert.equal(reload.status, "success");
    assert.equal(fixture.count(), reload.value.conversation.unreadMentionCount);
    const afterReload = reads;
    for (let index = 0; index < 30; index++) socket.message(replyEvent("reply-created", reply));
    await settleReplyRefresh();
    assert.equal(reads, afterReload);
    assert.equal(fixture.count(), 1);
    authority = replySnapshot(0);
    const deleted = { ...reply, content: null, deletedAt: replyAt, deletedByUserId: "bob", revision: { revision: 2 } };
    socket.message(replyEvent("reply-deleted", deleted, "message.deleted"));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    authority = replySnapshot(1, 3);
    socket.message(replyEvent("reply-2", replyMessage("reply-2", 3, { replyTo: reply.replyTo })));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 1);
    authority = replySnapshot(0, 3);
    socket.message(replyEvent("source-deleted", { ...source,
      content: null, deletedAt: replyAt, deletedByUserId: "actor-a", revision: { revision: 2 } }, "message.deleted"));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    // The source need not be in the loaded page to request server authority.
    authority = replySnapshot(1, 4);
    socket.message(replyEvent("unknown-source-reply", replyMessage("reply-3", 4,
      { replyTo: { messageId: "unloaded-source", notifyAuthor: true } })));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 1);
    fixture.network.setOnline(false);
    authority = replySnapshot(0, 4); // Source invalidated while disconnected.
    fixture.network.setOnline(true);
    await fixture.connect();
    assert.equal(fixture.count(), 0);
  } finally { fixture.client.close(); }
});

test("reply refresh coalesces bursts, rejects stale in-flight snapshots and isolates identity boundaries", async () => {
  const responses = [];
  const fixture = replyClientFixture(() => new Promise(resolve => responses.push(resolve)));
  try {
    fixture.client.realtime.applyCanonicalEvent(replyEvent("source", replyMessage("source", 1)));
    const reply = replyMessage("reply", 2, { replyTo: { messageId: "missing", notifyAuthor: true } });
    fixture.client.realtime.applyCanonicalEvent(replyEvent("created", reply));
    await settleReplyRefresh();
    assert.equal(responses.length, 1);
    for (let index = 0; index < 25; index++) fixture.client.realtime.applyCanonicalEvent(replyEvent("created", reply));
    const deleted = { ...reply, content: null, deletedAt: replyAt, deletedByUserId: "bob", revision: { revision: 2 } };
    fixture.client.realtime.applyCanonicalEvent(replyEvent("deleted", deleted, "message.deleted"));
    responses[0](replySnapshot(1));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0, "outdated create response must not restore the ping");
    assert.equal(responses.length, 2, "one follow-up covers changes during the read");
    responses[1](replySnapshot(0));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    fixture.client.realtime.applyCanonicalEvent(replyEvent("next", replyMessage("next", 3, { replyTo: reply.replyTo })));
    await settleReplyRefresh();
    assert.equal(responses.length, 3);
    fixture.cache.setIdentity({ tenantId: "tenant-b", userId: "actor-b", sessionId: "session-b" });
    responses[2](replySnapshot(7, 3));
    await settleReplyRefresh();
    assert.deepEqual(Object.keys(fixture.cache.getState().entities.conversations), []);
  } finally { fixture.client.close(); }
});

test("reply refresh never applies a late snapshot after stream revocation or close", async () => {
  let deferred = false;
  const responses = [];
  const fixture = replyClientFixture(() => deferred
    ? new Promise(resolve => responses.push(resolve)) : replySnapshot(0, 0));
  try {
    const socket = await fixture.connect();
    deferred = true;
    fixture.client.realtime.applyCanonicalEvent(replyEvent("source", replyMessage("source", 1)));
    fixture.client.realtime.applyCanonicalEvent(replyEvent("ping", replyMessage("ping", 2,
      { replyTo: { messageId: "unloaded", notifyAuthor: true } })));
    await settleReplyRefresh();
    assert.equal(responses.length, 1);
    socket.message({ type: "chat.subscription.revoked", streamId: "conversation-a", code: "access_denied" });
    const before = fixture.cache.getState().entities.conversations;
    const stale = replySnapshot(9);
    stale.conversation.name = "must not restore revoked data";
    responses[0](stale);
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    assert.equal(fixture.cache.getState().entities.conversations, before);
    fixture.client.realtime.applyCanonicalEvent(replyEvent("ping-2", replyMessage("ping-2", 3,
      { replyTo: { messageId: "unloaded", notifyAuthor: true } })));
    await settleReplyRefresh();
    assert.equal(responses.length, 1, "revoked streams remain suppressed until reconnect");
    fixture.network.setOnline(false);
    fixture.network.setOnline(true);
    await fixture.connect();
    assert.equal(responses.length, 2);
    fixture.client.close();
    responses[1](replySnapshot(9, 3));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
  } finally { fixture.client.close(); }
});

test("reply reconnect refreshes have at most four concurrent requests", async () => {
  const responses = [];
  const fixture = replyClientFixture((url) => new Promise(resolve => {
    responses.push({ resolve, id: url.split("/").at(-1) });
  }));
  for (let index = 0; index < 9; index++) fixture.cache.hydrateConversationDetail(replySnapshot(0, 0, `channel-${index}`));
  try {
    await fixture.connect();
    assert.equal(responses.length, 4);
    for (const pending of responses.slice(0, 4)) pending.resolve(replySnapshot(0, 0, pending.id));
    await settleReplyRefresh();
    assert.equal(responses.length, 8);
    for (const pending of responses.slice(4, 8)) pending.resolve(replySnapshot(0, 0, pending.id));
    await settleReplyRefresh();
    assert.equal(responses.length, 10);
    for (const pending of responses.slice(8)) pending.resolve(replySnapshot(0, 0, pending.id));
    await settleReplyRefresh();
    assert.equal(responses.length, 10);
  } finally { fixture.client.close(); }
});

test("reply refresh rejects a wrong-actor snapshot and a read cursor advanced during transport", async () => {
  const responses = [];
  const fixture = replyClientFixture(() => new Promise(resolve => responses.push(resolve)));
  try {
    fixture.client.realtime.applyCanonicalEvent(replyEvent("source", replyMessage("source", 1)));
    fixture.client.realtime.applyCanonicalEvent(replyEvent("ping", replyMessage("ping", 2,
      { replyTo: { messageId: "unknown", notifyAuthor: true } })));
    await settleReplyRefresh();
    const wrong = replySnapshot(7);
    wrong.conversation.currentReadState.userId = "another-actor";
    wrong.conversation.currentMember.userId = "another-actor";
    wrong.conversation.currentPreference.userId = "another-actor";
    responses[0](wrong);
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    fixture.client.realtime.applyCanonicalEvent(replyEvent("ping-2", replyMessage("ping-2", 3,
      { replyTo: { messageId: "unknown", notifyAuthor: true } })));
    await settleReplyRefresh();
    fixture.cache.reconcileCurrentUserReadState({ operation: "mark_read", conversationId: "conversation-a",
      readState: { conversationId: "conversation-a", userId: "actor-a", lastReadSequence: 3, updatedAt: replyAt }, latestSequence: 3, unreadCount: 0 });
    responses[1](replySnapshot(2, 3));
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    assert.equal(responses.length, 3);
    responses[2](replySnapshot(2, 3)); // Even a stale server read cursor cannot undo the newer local authority.
    await settleReplyRefresh();
    assert.equal(fixture.count(), 0);
    assert.equal(responses.length, 3);
  } finally { fixture.client.close(); }
});

test("reply events with disabled pings or a known different recipient do not refresh", async () => {
  let reads = 0;
  const fixture = replyClientFixture(() => { reads++; return replySnapshot(0, 3); });
  try {
    fixture.client.realtime.applyCanonicalEvent(replyEvent("source", replyMessage("source", 1)));
    fixture.client.realtime.applyCanonicalEvent(replyEvent("other-recipient", replyMessage("reply-2", 2,
      { replyTo: { messageId: "source", notifyAuthor: true } })));
    fixture.client.realtime.applyCanonicalEvent(replyEvent("ping-disabled", replyMessage("reply-3", 3,
      { replyTo: { messageId: "unloaded", notifyAuthor: false } })));
    await settleReplyRefresh();
    assert.equal(reads, 0);
    assert.equal(fixture.count(), 0);
  } finally { fixture.client.close(); }
});
