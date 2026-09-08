import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedMessageMutationIntent,
  createApplicationChatQueuedMessageMutationIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_DURABLE_EVENT_TYPES,
  CHAT_PROTOCOL_VERSION,
} from "../dist/index.js";

const tenantId = "tenant-durable-forward";
const userId = "forwarder-a";
const sourceMessageId = "message-forward-source";
const destinationConversationId = "conversation-forward-destination";
const now = "2032-05-01T00:00:00.000Z";
const identity = (user = userId, deviceId = "device-a") => ({
  tenantId, userId: user, deviceId,
});
const cacheIdentity = (user = userId) => ({
  tenantId, userId: user, sessionId: `session-${user}`,
});
const key = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const metadata = (realtime = false) => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: realtime ? { realtime: true } : {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
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
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const authored = { sourceMessageId, destinationConversationId };
const forwardInput = (
  clientCorrelationId = "durable-forward-correlation",
  idempotencyKey = "durable-forward-key",
) => ({
  operation: "forward_message.v1",
  sourceMessageId,
  destinationConversationId,
  clientCorrelationId,
  idempotencyKey,
});
const forwardedMessage = (scope = identity()) => ({
  id: "message-forward-destination",
  tenantId,
  conversationId: destinationConversationId,
  author: { type: "user", userId: scope.userId },
  sequence: 1,
  createdAt: now,
  updatedAt: now,
  revision: { revision: 1 },
  content: {
    format: "plain",
    text: "durably forwarded text",
    forwarded: {
      sourceMessageId,
      originalAuthor: { userId: "original-user", displayName: "Original User" },
      originalCreatedAt: now,
    },
  },
});
const forwardResult = (request, scope = identity(), reconciliationStatus = "applied") => ({
  operation: "forward_message.v1",
  reconciliationStatus,
  clientCorrelationId: request.clientCorrelationId,
  destinationConversationId,
  message: forwardedMessage(scope),
  canonicalRevision: 1,
});
const durable = (
  eventId,
  type,
  payload,
  occurredAt = "2032-05-01T00:00:01.000Z",
) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: destinationConversationId,
  type,
  occurredAt,
  payload,
});
const seedCache = (scope = identity()) => {
  const cache = createNormalizedChatCache(cacheIdentity(scope.userId));
  cache.applyDurableEvent(durable(
    "forward-destination-created",
    CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    {
      conversation: {
        id: destinationConversationId,
        tenantId,
        type: "channel",
        visibility: "public",
        name: "Durable forwards",
        createdAt: now,
        updatedAt: now,
      },
    },
    now,
  ));
  return cache;
};

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let mutationReplaceGate;
  let completedMutationWrites = 0;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      return rows.get(key(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope, kind, encoded });
      if (kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
        if (mutationReplaceGate !== undefined) await mutationReplaceGate.promise;
        completedMutationWrites += 1;
      }
      rows.set(key(scope, kind), encoded);
    },
    async compareExchange(scope, kind, expected, replacement) {
      const call = { operation: "compareExchange", scope, kind, expected, replacement };
      calls.push(call);
      const isMutationWrite = replacement !== null &&
        kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents;
      if (isMutationWrite && mutationReplaceGate !== undefined) {
        await mutationReplaceGate.promise;
      }
      // Compare and mutate together after any simulated storage delay.
      const storageKey = key(scope, kind);
      if ((rows.get(storageKey) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(storageKey);
      else rows.set(storageKey, replacement);
      call.succeeded = true;
      if (isMutationWrite) completedMutationWrites += 1;
      return true;
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope, kind });
      rows.delete(key(scope, kind));
    },
    async clearForLogout(scope) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(key(scope, kind));
      }
    },
  });
  return {
    rows,
    calls,
    storage,
    get completedMutationWrites() { return completedMutationWrites; },
    setMutationReplaceGate(gate) { mutationReplaceGate = gate; },
    mutationWriteAttempts() {
      return calls.filter(({ operation, kind, replacement }) =>
        (operation === "replace" ||
          (operation === "compareExchange" && replacement !== null)) &&
        kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents);
    },
    mutationWrites() {
      return calls.filter(({ operation, kind, replacement, succeeded }) =>
        (operation === "replace" ||
          (operation === "compareExchange" && replacement !== null && succeeded)) &&
        kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents);
    },
  };
}

async function seedForward(harness, scope, request = forwardInput()) {
  await harness.storage.replace(createApplicationChatQueuedMessageMutationIntentsRecord(
    scope,
    [createApplicationChatQueuedMessageMutationIntent(request, {
      enqueueOrder: 1,
      enqueuedAt: now,
    })],
  ));
}

async function seedSnapshot(harness, scope, cache = seedCache(scope)) {
  await harness.storage.replace(createApplicationChatNormalizedSnapshotRecord(
    scope,
    cache.getState(),
  ));
}

function createSockets(scope) {
  const sockets = [];
  return {
    sockets,
    factory() {
      const socket = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send() {},
        close() { this.readyState = 3; },
        accept() {
          this.readyState = 1;
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({
            type: "chat.session.accepted",
            metadata: metadata(true),
            tenantId: scope.tenantId,
            actorStreamId: `user:${scope.userId}`,
            deviceId: scope.deviceId,
            sessionId: `session-${scope.userId}`,
          }) });
        },
        event(value) { this.onmessage?.({ data: JSON.stringify(value) }); },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

async function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: identity() },
  cache = seedCache(identityRef.current),
  command,
  sockets,
  crossTab,
  canonicalEvents,
  recoveryDiagnostics,
} = {}) {
  const requests = [];
  let correlations = 0;
  let idempotencyKeys = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    forwardMessages: {
      generateClientCorrelationId: () => `generated-forward-correlation-${++correlations}`,
      generateIdempotencyKey: () => `generated-forward-key-${++idempotencyKeys}`,
    },
    fetch: async (url, init) => {
      if (String(url).endsWith("/_meta")) {
        return response(200, metadata(sockets !== undefined));
      }
      const body = JSON.parse(init.body);
      requests.push({ url, init, body, scope: identityRef.current });
      return command?.(body, requests.length) ??
        response(200, forwardResult(body, identityRef.current));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
    },
    ...(sockets === undefined ? {} : {
      realtime: {
        network: {
          isOnline: () => true,
          addEventListener() {},
          removeEventListener() {},
        },
        webSocketFactory: sockets.factory,
        retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
        onCanonicalEvent: (event) => canonicalEvents?.push(event),
        onRecoveryDiagnostic: (diagnostic) => recoveryDiagnostics?.push(diagnostic),
      },
    }),
    ...(crossTab === undefined ? {} : { crossTab }),
  });
  assert.equal((await client.start()).state, "ready");
  return { client, cache, harness, identityRef, requests };
}

test("durable forwards persist before fetch and duplicate retries reuse one request", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  const command = deferred();
  harness.setMutationReplaceGate(gate);
  const fixture = await createFixture({
    harness,
    command: () => {
      assert.equal(harness.completedMutationWrites, 1);
      return command.promise;
    },
  });
  const first = fixture.client.forwardMessage(authored);
  await eventually(() => harness.mutationWriteAttempts().length === 1);
  assert.equal(harness.mutationWrites().length, 0);
  assert.equal(harness.completedMutationWrites, 0);
  assert.equal(fixture.requests.length, 0);
  gate.resolve();
  await eventually(() => fixture.requests.length === 1);
  assert.equal(harness.mutationWrites().length, 1);

  const duplicate = fixture.client.forwardMessage(authored);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 1);
  const record = await harness.storage.read(
    identity(),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.equal(record.intents.length, 1);
  assert.deepEqual(record.intents[0].request, fixture.requests[0].body);

  command.resolve(response(200, forwardResult(fixture.requests[0].body)));
  assert.equal((await first).status, "success");
  assert.equal((await duplicate).status, "success");
  assert.equal(fixture.requests.length, 1);
  fixture.client.close();
});

test("a user retry after ambiguous delivery reuses the retained identifiers", async () => {
  const fixture = await createFixture({
    command: (request, attempt) => {
      if (attempt === 1) throw new Error("delivery acknowledgement lost");
      return response(200, forwardResult(request, identity(), "replayed"));
    },
  });
  assert.equal((await fixture.client.forwardMessage(authored)).status, "transport");
  const replayed = await fixture.client.forwardMessage(authored);
  assert.equal(replayed.status, "success");
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].body, fixture.requests[0].body);
  assert.equal(
    fixture.requests[1].init.headers["idempotency-key"],
    fixture.requests[0].init.headers["idempotency-key"],
  );
  fixture.client.close();
});

test("acknowledgement loss survives close and reload with exact correlation", async () => {
  const harness = createStorageHarness();
  const first = await createFixture({
    harness,
    command: () => { throw new Error("response lost"); },
  });
  assert.equal((await first.client.forwardMessage(authored)).status, "transport");
  const retained = await harness.storage.read(
    identity(),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  const exact = retained.intents[0].request;
  first.client.close();

  const second = await createFixture({ harness });
  await eventually(() => second.requests.length === 1);
  assert.deepEqual(second.requests[0].body, exact);
  assert.equal(second.requests[0].init.headers["idempotency-key"], exact.idempotencyKey);
  await eventually(async () => await harness.storage.read(
    identity(),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  second.client.close();
});

test("a matching canonical destination settles storage before HTTP completes", async () => {
  const harness = createStorageHarness();
  const sockets = createSockets(identity());
  const command = deferred();
  const canonicalEvents = [];
  const recoveryDiagnostics = [];
  const fixture = await createFixture({
    harness,
    sockets,
    command: () => command.promise,
    canonicalEvents,
    recoveryDiagnostics,
  });
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  const pending = fixture.client.forwardMessage(authored);
  await eventually(() => fixture.requests.length === 1);
  const request = fixture.requests[0].body;
  sockets.sockets[0].event(durable(
    "forward-message-created",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    {
      clientMessageId: request.clientCorrelationId,
      message: forwardedMessage(),
    },
  ));
  await eventually(
    () => canonicalEvents.length === 1,
    `canonical event was not applied: ${JSON.stringify(recoveryDiagnostics)}`,
  );
  await eventually(async () => await harness.storage.read(
    identity(),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  assert.equal((await pending).status, "success");
  command.resolve(response(200, forwardResult(request, identity(), "replayed")));
  fixture.client.close();
});

test("terminal forward results remove intents while ambiguous results retain them", async (t) => {
  await t.test("authorization is terminal", async () => {
    const fixture = await createFixture({
      command: () => response(403, {
        error: { code: "source_message_forbidden", message: "denied" },
      }),
    });
    assert.equal((await fixture.client.forwardMessage(authored)).status, "rejected");
    assert.equal(await fixture.harness.storage.read(
      identity(), ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ), null);
    fixture.client.close();
  });

  for (const [name, command, expected] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["malformed", () => response(200, { invalid: true }), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ command });
      assert.equal((await fixture.client.forwardMessage(authored)).status, expected);
      const record = await fixture.harness.storage.read(
        identity(), ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
      );
      assert.equal(record.intents.length, 1);
      assert.equal(record.intents[0].request.operation, "forward_message.v1");
      fixture.client.close();
    });
  }
});

class FakeClock {
  current = 0;
  nextId = 1;
  timers = new Map();
  now = () => this.current;
  setTimeout = (callback, delayMs) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.current + delayMs });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  tick(milliseconds) {
    const target = this.current + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.at;
      timer.callback();
    }
    this.current = target;
  }
}

class FakeChannelHub {
  channels = new Set();
  messages = [];
  factory = (owner) => (name) => {
    const listeners = new Set();
    const channel = {
      owner, name, listeners, closed: false,
      postMessage: (value) => {
        if (channel.closed) return;
        this.messages.push(structuredClone(value));
        for (const peer of [...this.channels]) {
          if (peer !== channel && !peer.closed && peer.name === name) {
            for (const listener of peer.listeners) {
              listener({ data: structuredClone(value) });
            }
          }
        }
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => { channel.closed = true; this.channels.delete(channel); },
    };
    this.channels.add(channel);
    return channel;
  };
}

const crossTabTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

test("only the elected leader dispatches a retained forward", async () => {
  const harness = createStorageHarness();
  await seedForward(harness, identity());
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leader = await createFixture({
    harness,
    crossTab: {
      sessionFingerprint: "durable-forward-session",
      tabId: "tab-a",
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory("tab-a"),
    },
  });
  const follower = await createFixture({
    harness,
    crossTab: {
      sessionFingerprint: "durable-forward-session",
      tabId: "tab-b",
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory("tab-b"),
    },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination.role, "leader");
  assert.equal(follower.client.coordination.role, "follower");
  await eventually(() => hub.messages.some((value) =>
    value.kind === "command-claim" &&
    value.payload.idempotencyKey === "durable-forward-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => leader.requests.length === 1);
  assert.equal(follower.requests.length, 0);
  leader.client.close();
  follower.client.close();
});

test("identity switching cannot dispatch another identity's retained forward", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  harness.setMutationReplaceGate(gate);
  const identityRef = { current: identity("forwarder-a", "device-a") };
  const fixture = await createFixture({ harness, identityRef });
  const pending = fixture.client.forwardMessage(authored);
  await eventually(() => harness.mutationWriteAttempts().length === 1);
  assert.equal(harness.mutationWrites().length, 0);
  assert.equal(harness.completedMutationWrites, 0);
  assert.equal(fixture.requests.length, 0);
  fixture.client.close();
  identityRef.current = identity("forwarder-b", "device-b");
  fixture.cache.setIdentity(cacheIdentity("forwarder-b"));
  gate.resolve();
  assert.equal((await pending).status, "validation");
  assert.notEqual(await harness.storage.read(
    identity("forwarder-a", "device-a"),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  await seedSnapshot(
    harness,
    identity("forwarder-b", "device-b"),
    seedCache(identity("forwarder-b", "device-b")),
  );
  assert.equal((await fixture.client.start()).state, "ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.cache.getState().identity.userId, "forwarder-b");
  assert.equal(fixture.cache.getState().entities.messages["message-forward-destination"], undefined);
  fixture.client.close();
});
