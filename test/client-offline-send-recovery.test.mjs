import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const now = "2026-09-03T12:00:00.000Z";
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const identity = (userId = "user-a", deviceId = "device-a") => ({
  tenantId: "tenant-a",
  userId,
  deviceId,
});
const cacheIdentity = (userId = "user-a", sessionId = "session-a") => ({
  tenantId: "tenant-a",
  userId,
  sessionId,
});
const request = (suffix, conversationId = "conversation-a") => ({
  operation: "send",
  conversationId,
  content: { format: "plain", text: `retained ${suffix}` },
  clientMessageId: `client-${suffix}`,
  idempotencyKey: `idempotency-${suffix}`,
});
const key = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

function successfulSend(body, scope, messageId = `message-${body.clientMessageId}`) {
  return response(200, {
    operation: "send",
    reconciliationStatus: "applied",
    clientMessageId: body.clientMessageId,
    message: canonicalMessage(body, scope, messageId),
    canonicalRevision: 1,
  });
}

function canonicalMessage(body, scope, messageId = `message-${body.clientMessageId}`) {
  return {
    id: messageId,
    tenantId: scope.tenantId,
    conversationId: body.conversationId,
    author: { type: "user", userId: scope.userId },
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    revision: { revision: 1 },
    content: body.content,
    ...(body.replyTo === undefined ? {} : { replyTo: body.replyTo }),
  };
}

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  const adapter = {
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      return rows.get(key(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope, kind, encoded });
      rows.set(key(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope, kind });
      rows.delete(key(scope, kind));
    },
    async clearForLogout(scope) {
      calls.push({ operation: "clearForLogout", scope });
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(key(scope, kind));
      }
    },
  };
  return { rows, calls, adapter, storage: createApplicationChatStorage(adapter) };
}

async function seed(harness, scope, requests) {
  await harness.storage.replace(createApplicationChatQueuedSendMessageIntentsRecord(
    scope,
    requests.map((value, index) => createApplicationChatQueuedSendMessageIntent(value, {
      enqueueOrder: index + 1,
      enqueuedAt: new Date(Date.parse(now) + index).toISOString(),
    })),
  ));
}

function createNetwork(initiallyOnline) {
  let online = initiallyOnline;
  const listeners = { online: new Set(), offline: new Set() };
  return {
    isOnline: () => online,
    addEventListener(type, listener) { listeners[type].add(listener); },
    removeEventListener(type, listener) { listeners[type].delete(listener); },
    setOnline(next) {
      if (online === next) return;
      online = next;
      for (const listener of [...listeners[next ? "online" : "offline"]]) listener();
    },
  };
}

function createSocketHarness(scope) {
  const sockets = [];
  const factory = () => {
    const socket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      sent: [],
      send(value) { this.sent.push(JSON.parse(value)); },
      close() { this.readyState = 3; },
      accept() {
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({
          type: "chat.session.accepted",
          metadata,
          tenantId: scope.tenantId,
          actorStreamId: `user:${scope.userId}`,
          deviceId: scope.deviceId,
          sessionId: `session-${scope.userId}`,
        }) });
      },
      event(value) {
        this.onmessage?.({ data: JSON.stringify(value) });
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

function createWaitHarness() {
  const delays = [];
  const pending = [];
  return {
    delays,
    pending,
    wait(delayMs, signal) {
      delays.push(delayMs);
      const gate = deferred();
      const entry = { gate, signal };
      pending.push(entry);
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      signal.addEventListener("abort", () => gate.reject(new Error("aborted")), {
        once: true,
      });
      return gate.promise;
    },
    advance() {
      const entry = pending.shift();
      assert.ok(entry, "expected a scheduled recovery wait");
      entry.gate.resolve();
    },
  };
}

function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: identity() },
  command,
  network,
  sockets,
  recovery,
  optimisticMessages,
  features,
  serverMetadata = metadata,
} = {}) {
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "secret-token",
    cache: createNormalizedChatCache(cacheIdentity(identityRef.current.userId)),
    commands: { retry: { maxAttempts: 1 } },
    ...(features === undefined ? {} : { features }),
    ...(optimisticMessages === undefined ? {} : { optimisticMessages }),
    fetch: async (url, init) => {
      if (init.method === "GET") return response(200, serverMetadata);
      const body = JSON.parse(init.body);
      const observed = { url, init, body, scope: identityRef.current };
      requests.push(observed);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await (command?.(observed, requests.length) ??
          successfulSend(body, identityRef.current));
      } finally {
        active -= 1;
      }
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      ...(recovery === undefined ? {} : { retainedSendRecovery: recovery }),
    },
    ...(network === undefined || sockets === undefined ? {} : {
      realtime: {
        network,
        webSocketFactory: sockets.factory,
        retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
      },
    }),
  });
  return {
    client,
    harness,
    identityRef,
    requests,
    get maximumActive() { return maximumActive; },
  };
}

test("storage harness logout clear removes every kind only for the exact identity", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const siblingScopes = [
    { ...scope, tenantId: "tenant-b" },
    identity("user-b", scope.deviceId),
    identity(scope.userId, "device-b"),
  ];
  const kinds = Object.values(ApplicationChatStorageRecordKind);

  for (const kind of kinds) {
    harness.rows.set(key(scope, kind), `own-${kind}`);
    for (const siblingScope of siblingScopes) {
      harness.rows.set(key(siblingScope, kind), `sibling-${kind}`);
    }
  }

  await harness.storage.clearForLogout(scope);

  for (const kind of kinds) {
    assert.equal(harness.rows.has(key(scope, kind)), false);
    for (const siblingScope of siblingScopes) {
      assert.equal(harness.rows.has(key(siblingScope, kind)), true);
    }
  }
  assert.deepEqual(
    harness.calls.filter(({ operation }) => operation === "clearForLogout"),
    [{ operation: "clearForLogout", scope }],
  );
});

test("a persisted request survives reload and drains only after realtime reconnect", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const retained = request("reload");
  await seed(harness, scope, [retained]);
  const network = createNetwork(false);
  const sockets = createSocketHarness(scope);
  const fixture = createFixture({ harness, network, sockets });

  assert.equal((await fixture.client.start()).state, "ready");
  assert.equal(fixture.client.realtime.state.state, "offline");
  assert.equal(fixture.client.getSendMessageQueueState().intents.length, 1);
  assert.equal(fixture.requests.length, 0);

  network.setOnline(true);
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => fixture.requests.length === 1);
  await eventually(() => fixture.client.getSendMessageQueueState().intents.length === 0);

  assert.deepEqual(fixture.requests[0].body, retained);
  assert.equal(
    fixture.requests[0].init.headers["idempotency-key"],
    retained.idempotencyKey,
  );
  fixture.client.close();
});

for (const [status, code, expectedStatus] of [
  [501, "REPLIES_UNSUPPORTED", "unsupported"],
  [403, "REPLIES_FEATURE_DISABLED", "feature_disabled"],
]) {
  test(`retained replies survive ${expectedStatus} and allow explicit retry without FIFO overtaking`, async (t) => {
    const harness = createStorageHarness();
    const scope = identity();
    const retained = { ...request("unsupported-reply"), replyTo: { messageId: "source", notifyAuthor: false } };
    const next = request("next", "conversation-b");
    await seed(harness, scope, [retained, next]);
    const fixture = createFixture({
      harness,
      command: ({ body }, attempt) => attempt === 1
        ? response(status, { error: { code, message: "Inline replies are unavailable" } })
        : successfulSend(body, scope),
    });
    t.after(() => fixture.client.close());
    await fixture.client.start();
    await eventually(() => fixture.client.cache.getState().entities.messages[`optimistic:${retained.clientMessageId}`]?.delivery.state === "failed");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.requests.length, 1, "unsupported head must pause the FIFO pump");
    const projection = fixture.client.cache.getState().entities.messages[`optimistic:${retained.clientMessageId}`];
    assert.equal(projection.delivery.failure, expectedStatus);
    assert.equal(projection.delivery.retryable, true);
    assert.deepEqual(projection.replyTo, retained.replyTo);
    assert.deepEqual(fixture.client.getSendMessageQueueState().intents.map(({ request }) => request), [retained, next]);
    const persisted = await createApplicationChatStorage(harness.adapter).read(scope, ApplicationChatStorageRecordKind.queuedSendMessageIntents);
    assert.deepEqual(persisted.intents.map(({ request }) => request), [retained, next]);

    assert.equal((await fixture.client.retryMessage(retained.clientMessageId)).status, "success");
    await eventually(() => fixture.client.getSendMessageQueueState().intents.length === 0);
    assert.deepEqual(fixture.requests.map(({ body }) => body), [retained, retained, next]);
    assert.equal(fixture.requests[1].init.headers["idempotency-key"], retained.idempotencyKey);
    assert.equal(fixture.maximumActive, 1);
  });
}

for (const notifyAuthor of [false, true]) {
  test(`authored reply with notifyAuthor=${notifyAuthor} survives client recreation, reconnect and retry`, async (t) => {
    const harness = createStorageHarness();
    const scope = identity();
    const network = createNetwork(false);
    const authored = {
      ...request(`authored-${notifyAuthor}`, notifyAuthor ? "existing-thread" : "conversation-a"),
      replyTo: { messageId: "original-source", notifyAuthor },
    };
    const retained = structuredClone(authored);
    // Exercise the existing host feature/presentation configuration seam.
    // The saved reply-style runtime is a separate item and is not implemented here.
    const serverMetadata = { ...metadata, enabledFeatures: { huddles: true } };
    const first = createFixture({
      harness, network, sockets: createSocketHarness(scope),
      features: { huddles: false }, serverMetadata,
      optimisticMessages: {
        generateClientMessageId: () => retained.clientMessageId,
        generateIdempotencyKey: () => retained.idempotencyKey,
      },
    });
    t.after(() => first.client.close());
    assert.equal((await first.client.start()).enabledFeatures.huddles, false);
    const pending = first.client.sendMessage(authored);
    authored.conversationId = "changed-destination";
    authored.replyTo.messageId = "changed-source";
    authored.replyTo.notifyAuthor = !notifyAuthor;
    authored.content.text = "changed-content";
    await eventually(() => first.client.getSendMessageQueueState().intents.length === 1);
    assert.deepEqual(first.client.getSendMessageQueueState().intents[0].request, retained);
    first.client.close();
    await pending;

    const sockets = createSocketHarness(scope);
    const clock = createWaitHarness();
    const restarted = createFixture({
      harness: { ...harness, storage: createApplicationChatStorage(harness.adapter) },
      network,
      sockets,
      features: { huddles: true }, serverMetadata,
      recovery: { wait: clock.wait },
      command: ({ body }, attempt) => attempt === 1
        ? Promise.reject(new Error("temporary transport failure"))
        : successfulSend(body, scope),
    });
    t.after(() => restarted.client.close());
    assert.equal((await restarted.client.start()).enabledFeatures.huddles, true);
    const restored = restarted.client.getSendMessageQueueState().intents[0];
    assert.deepEqual(restored.request, retained);
    assert.ok(Object.isFrozen(restored.request.replyTo));
    assert.equal(restarted.requests.length, 0);
    network.setOnline(true);
    await eventually(() => sockets.sockets.length === 1);
    sockets.sockets[0].accept();
    await eventually(() => clock.pending.length === 1);
    assert.deepEqual(restarted.client.getSendMessageQueueState().intents[0].request, retained);
    clock.advance();
    await eventually(() => restarted.client.getSendMessageQueueState().intents.length === 0);
    assert.deepEqual(restarted.requests.map(({ body }) => body), [retained, retained]);
    assert.ok(restarted.requests.every(({ url, init }) => url.endsWith(`/conversations/${retained.conversationId}/messages`) && init.headers["idempotency-key"] === retained.idempotencyKey));
    const messages = Object.values(restarted.client.cache.getState().entities.messages);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].replyTo, retained.replyTo);
    assert.equal(messages[0].conversationId, retained.conversationId);
    assert.equal(harness.calls.filter(({ operation, kind }) => operation === "remove" && kind === ApplicationChatStorageRecordKind.queuedSendMessageIntents).length, 1);
  });
}

test("HTTP-first recovery is a single strict FIFO pump with stable correlations", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const first = request("first");
  const second = request("second", "conversation-b");
  await seed(harness, scope, [first, second]);
  const firstResponse = deferred();
  const fixture = createFixture({
    harness,
    command: ({ body }, attempt) => attempt === 1
      ? firstResponse.promise
      : successfulSend(body, scope),
  });

  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => fixture.requests.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 1, "the second FIFO entry cannot overtake the head");
  firstResponse.resolve(successfulSend(first, scope));
  await eventually(() => fixture.requests.length === 2);
  await eventually(() => fixture.client.getSendMessageQueueState().intents.length === 0);

  assert.deepEqual(fixture.requests.map(({ body }) => body), [first, second]);
  assert.deepEqual(
    fixture.requests.map(({ init }) => init.headers["idempotency-key"]),
    [first.idempotencyKey, second.idempotencyKey],
  );
  assert.equal(fixture.maximumActive, 1);
  fixture.client.close();
});

test("realtime-first settlement requires the queued author and ignores late HTTP", async (t) => {
  const harness = createStorageHarness();
  const scope = identity();
  const retained = {
    ...request("realtime"),
    replyTo: { messageId: "realtime-source", notifyAuthor: false },
  };
  await seed(harness, scope, [retained]);
  const network = createNetwork(true);
  const sockets = createSocketHarness(scope);
  const losingResponse = deferred();
  const fixture = createFixture({
    harness,
    network,
    sockets,
    command: () => losingResponse.promise,
  });
  t.after(() => fixture.client.close());

  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => fixture.requests.length === 1);
  const queued = fixture.client.getSendMessageQueueState().intents[0];
  assert.deepEqual(queued.request, retained);
  assert.deepEqual(queued.identity, scope);
  assert.deepEqual(fixture.requests[0].body, retained);
  assert.equal(fixture.requests[0].init.headers["idempotency-key"], retained.idempotencyKey);
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const storageKey = key(scope, kind);
  const persisted = harness.rows.get(storageKey);
  assert.ok(persisted);
  const queueWrites = () => harness.calls.filter((call) =>
    call.kind === kind && ["replace", "remove"].includes(call.operation));
  const writesBeforeEvents = queueWrites();
  assert.equal(writesBeforeEvents.length, 1, "only the seeded intent has been written");
  const queueStates = [];
  fixture.client.subscribeSendMessageQueue((state) => {
    // Storage reloads may publish the same intents again without a transition.
    if (!isDeepStrictEqual(queueStates.at(-1), state.intents)) queueStates.push(state.intents);
  });
  const teammate = identity("user-b");
  sockets.sockets[0].event({
    eventId: "event-conversation",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: scope.tenantId,
    streamId: retained.conversationId,
    type: "conversation.created",
    occurredAt: "2026-09-03T11:59:59.000Z",
    payload: {
      conversation: {
        id: retained.conversationId,
        tenantId: scope.tenantId,
        type: "channel",
        visibility: "public",
        name: "Recovery",
        createdAt: now,
        updatedAt: now,
        memberUserIds: [scope.userId, teammate.userId],
      },
    },
  });
  const teammateMessage = canonicalMessage(retained, teammate, "message-teammate");
  sockets.sockets[0].event({
    eventId: "event-teammate",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: scope.tenantId,
    streamId: retained.conversationId,
    type: "message.created",
    occurredAt: now,
    payload: {
      message: teammateMessage,
      clientMessageId: retained.clientMessageId,
    },
  });
  await eventually(() => fixture.client.cache.getState().entities.messages[teammateMessage.id]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.client.cache.getState().entities.messages[teammateMessage.id].author.userId, teammate.userId);
  assert.deepEqual(fixture.client.getSendMessageQueueState().intents, [queued]);
  assert.equal(harness.rows.get(storageKey), persisted, "teammate cannot mutate the durable request");
  assert.deepEqual(queueWrites(), writesBeforeEvents);
  assert.deepEqual(queueStates, [[queued]], "teammate cannot acknowledge the local send");
  assert.equal(fixture.requests[0].init.signal.aborted, false);

  const ownMessage = {
    ...canonicalMessage(retained, scope, "message-realtime"),
    sequence: 2,
    createdAt: "2026-09-03T12:00:01.000Z",
    updatedAt: "2026-09-03T12:00:01.000Z",
  };
  sockets.sockets[0].event({
    eventId: "event-realtime",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId: scope.tenantId,
    streamId: retained.conversationId,
    type: "message.created",
    occurredAt: ownMessage.createdAt,
    payload: {
      message: ownMessage,
      clientMessageId: retained.clientMessageId,
    },
  });

  await eventually(() => fixture.client.getSendMessageQueueState().intents.length === 0);
  assert.equal(fixture.requests[0].init.signal.aborted, true);
  assert.equal(harness.rows.has(storageKey), false);
  assert.deepEqual(queueWrites(), [
    ...writesBeforeEvents,
    { operation: "remove", scope, kind },
  ]);
  assert.deepEqual(queueStates, [[queued], []], "the exact intent settles once");
  const realtimeResult = fixture.client.cache.getState().entities.messages[ownMessage.id];
  assert.ok(realtimeResult);
  assert.equal(realtimeResult.author.userId, scope.userId);
  assert.equal(realtimeResult.sequence, 2);
  assert.deepEqual(realtimeResult.replyTo, retained.replyTo);
  const writesAfterSettlement = queueWrites();
  losingResponse.resolve(successfulSend(retained, scope, "message-losing-http"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.client.getSendMessageQueueState().intents.length, 0);
  assert.equal(harness.rows.has(storageKey), false);
  assert.deepEqual(queueWrites(), writesAfterSettlement, "late HTTP cannot remove or rewrite storage");
  assert.deepEqual(queueStates, [[queued], []], "late HTTP cannot settle twice");
  assert.deepEqual(fixture.client.cache.getState().entities.messages[ownMessage.id], realtimeResult);
  assert.equal(fixture.client.cache.getState().entities.messages["message-losing-http"], undefined);
});

test("retry backoff is deterministic, bounded, and close cancels its timer", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const retained = request("backoff");
  await seed(harness, scope, [retained]);
  const clock = createWaitHarness();
  const fixture = createFixture({
    harness,
    command: () => Promise.reject(new Error("offline")),
    recovery: {
      initialDelayMs: 10,
      maximumDelayMs: 25,
      multiplier: 2,
      wait: clock.wait,
    },
  });

  assert.equal((await fixture.client.start()).state, "ready");
  for (const [index, expected] of [10, 20, 25, 25].entries()) {
    await eventually(() => clock.delays.length === index + 1 && clock.pending.length > 0);
    assert.equal(clock.delays.at(-1), expected);
    clock.advance();
    await eventually(() => fixture.requests.length === index + 2);
  }
  await eventually(() => clock.pending.length === 1);
  assert.equal(fixture.requests.every(({ body, init }) =>
    JSON.stringify(body) === JSON.stringify(retained) &&
    init.headers["idempotency-key"] === retained.idempotencyKey), true);
  const countBeforeClose = fixture.requests.length;
  fixture.client.close();
  assert.equal(clock.pending[0].signal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, countBeforeClose);
});

test("offline pauses an active recovery attempt and reconnect resumes it once", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const retained = request("pause");
  await seed(harness, scope, [retained]);
  const network = createNetwork(true);
  const sockets = createSocketHarness(scope);
  const firstResponse = deferred();
  const fixture = createFixture({
    harness,
    network,
    sockets,
    command: ({ body }, attempt) => attempt === 1
      ? firstResponse.promise
      : successfulSend(body, scope),
  });

  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => fixture.requests.length === 1);
  network.setOnline(false);
  await eventually(() => fixture.requests[0].init.signal.aborted);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 1);

  network.setOnline(true);
  await eventually(() => sockets.sockets.length === 2);
  sockets.sockets[1].accept();
  await eventually(() => fixture.requests.length === 2);
  await eventually(() => fixture.client.getSendMessageQueueState().intents.length === 0);
  firstResponse.resolve(successfulSend(retained, scope, "stale-response"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 2);
  fixture.client.close();
});

test("close and trusted identity switch prevent stale completion from removing replacement intent", async () => {
  const harness = createStorageHarness();
  const identityRef = { current: identity("user-a", "device-a") };
  const oldRequest = request("same", "conversation-old");
  await seed(harness, identityRef.current, [oldRequest]);
  const oldResponse = deferred();
  const clock = createWaitHarness();
  const fixture = createFixture({
    harness,
    identityRef,
    command: ({ body }, attempt) => attempt === 1
      ? oldResponse.promise
      : Promise.reject(new Error(`retain ${body.conversationId}`)),
    recovery: { initialDelayMs: 10, maximumDelayMs: 10, wait: clock.wait },
  });

  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => fixture.requests.length === 1);
  fixture.client.close();
  assert.equal(fixture.requests[0].init.signal.aborted, true);

  identityRef.current = identity("user-b", "device-b");
  const replacement = request("same", "conversation-replacement");
  await seed(harness, identityRef.current, [replacement]);
  fixture.client.cache.setIdentity(cacheIdentity("user-b", "session-b"));
  assert.equal((await fixture.client.start()).state, "ready");
  await eventually(() => fixture.requests.length === 2);
  await eventually(() => clock.pending.length === 1);
  assert.deepEqual(fixture.client.getSendMessageQueueState().intents[0].request, replacement);

  oldResponse.resolve(successfulSend(oldRequest, identity("user-a", "device-a")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.client.getSendMessageQueueState().intents[0].request, replacement);
  assert.equal(fixture.requests.length, 2);
  fixture.client.close();
});
