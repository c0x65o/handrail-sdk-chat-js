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

const tenantId = "tenant-durable-edit";
const conversationId = "conversation-durable-edit";
const messageId = "message-durable-edit";
const now = "2032-02-01T00:00:00.000Z";
const at = (second) => `2032-02-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const identity = (userId = "editor-a", deviceId = "device-a") => ({
  tenantId, userId, deviceId,
});
const cacheIdentity = (userId = "editor-a") => ({
  tenantId, userId, sessionId: `session-${userId}`,
});
const key = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
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
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const message = (scope = identity(), revision = 1, content = {
  format: "plain", text: "canonical before edit",
}) => ({
  id: messageId,
  tenantId,
  conversationId,
  author: { type: "user", userId: scope.userId },
  sequence: 1,
  createdAt: at(1),
  updatedAt: revision === 1 ? at(1) : at(5),
  revision: revision === 1
    ? { revision: 1 }
    : { revision, editedAt: at(5), editedByUserId: scope.userId },
  content,
});
const durable = (eventId, type, payload, second = 1) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: conversationId,
  type,
  occurredAt: at(second),
  payload,
});
const seedCache = (scope = identity()) => {
  const cache = createNormalizedChatCache(cacheIdentity(scope.userId));
  cache.applyDurableEvent(durable("conversation-created", CHAT_DURABLE_EVENT_TYPES.conversationCreated, {
    conversation: {
      id: conversationId,
      tenantId,
      type: "channel",
      visibility: "public",
      name: "Durable edits",
      createdAt: now,
      updatedAt: now,
    },
  }, 0));
  cache.applyDurableEvent(durable("message-created", CHAT_DURABLE_EVENT_TYPES.messageCreated, {
    message: message(scope),
  }));
  return cache;
};
const editInput = (idempotencyKey = "durable-edit-key", text = "edited durably") => ({
  operation: "edit",
  messageId,
  expectedRevision: 1,
  content: { format: "plain", text },
  idempotencyKey,
});
const editResult = (request, scope = identity(), overrides = {}) => ({
  operation: "edit",
  reconciliationStatus: "applied",
  expectedRevision: request.expectedRevision,
  message: message(scope, request.expectedRevision + 1, request.content),
  canonicalRevision: request.expectedRevision + 1,
  ...overrides,
});

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let mutationReplaceGate;
  let mutationReplaceFailure;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      return rows.get(key(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      const call = { operation: "replace", scope, kind, encoded };
      calls.push(call);
      if (kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
        if (mutationReplaceGate !== undefined) await mutationReplaceGate.promise;
        if (mutationReplaceFailure !== undefined) throw mutationReplaceFailure;
      }
      rows.set(key(scope, kind), encoded);
      call.success = true;
    },
    async compareExchange(scope, kind, expected, replacement) {
      const call = { operation: "compareExchange", scope, kind, expected, replacement };
      calls.push(call);
      if (replacement !== null &&
          kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
        if (mutationReplaceGate !== undefined) await mutationReplaceGate.promise;
        if (mutationReplaceFailure !== undefined) throw mutationReplaceFailure;
      }
      // Compare and mutate together after any simulated storage delay.
      const storageKey = key(scope, kind);
      if ((rows.get(storageKey) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(storageKey);
      else rows.set(storageKey, replacement);
      call.success = true;
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
    setMutationReplaceGate(gate) { mutationReplaceGate = gate; },
    setMutationReplaceFailure(error) { mutationReplaceFailure = error; },
    mutationWriteAttempts() {
      return calls.filter(({ operation, kind, replacement }) =>
        (operation === "replace" ||
          (operation === "compareExchange" && replacement !== null)) &&
        kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents);
    },
    mutationWrites() {
      return this.mutationWriteAttempts().filter((call) => call.success === true);
    },
  };
}

async function seedEdit(harness, scope, request = editInput()) {
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
  idempotencyKey = "generated-edit-key",
  sockets,
  crossTab,
} = {}) {
  const requests = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    optimisticEdits: { generateIdempotencyKey: () => idempotencyKey },
    fetch: async (url, init) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata(sockets !== undefined));
      const body = JSON.parse(init.body);
      requests.push({ url, init, body, scope: identityRef.current });
      return command?.(body, requests.length) ?? response(200, editResult(body, identityRef.current));
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
      },
    }),
    ...(crossTab === undefined ? {} : { crossTab }),
  });
  assert.equal((await client.start()).state, "ready");
  return { client, cache, harness, identityRef, requests };
}

test("durable edits persist before projection or dispatch and fail closed on write failure", async (t) => {
  await t.test("persist first", async () => {
    const harness = createStorageHarness();
    const gate = deferred();
    harness.setMutationReplaceGate(gate);
    const fixture = await createFixture({ harness });
    const pending = fixture.client.editMessage({
      messageId,
      expectedRevision: 1,
      content: { format: "plain", text: "persisted first" },
    });
    await eventually(() => harness.mutationWriteAttempts().length === 1);
    assert.equal(harness.mutationWrites().length, 0);
    assert.equal(fixture.cache.getState().entities.messages[messageId].content.text, "canonical before edit");
    assert.equal(fixture.requests.length, 0);
    gate.resolve();
    assert.equal((await pending).status, "success");
    assert.equal(fixture.requests.length, 1);
    const write = harness.mutationWrites()[0];
    assert.equal((write.encoded ?? write.replacement).includes("persisted first"), true);
    fixture.client.close();
  });

  await t.test("failed write", async () => {
    const harness = createStorageHarness();
    harness.setMutationReplaceFailure(new Error("unavailable"));
    const fixture = await createFixture({ harness });
    const result = await fixture.client.editMessage({
      messageId,
      expectedRevision: 1,
      content: { format: "plain", text: "must stay invisible" },
    });
    assert.equal(result.status, "validation");
    assert.equal(harness.mutationWrites().length, 0);
    assert.equal(fixture.cache.getState().entities.messages[messageId].content.text, "canonical before edit");
    assert.equal(fixture.requests.length, 0);
    fixture.client.close();
  });
});

test("a retained edit replays the byte-equivalent request and original key after reload", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedSnapshot(harness, scope);
  const first = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    idempotencyKey: "process-one-key",
    command: () => { throw new Error("offline"); },
  });
  assert.equal((await first.client.editMessage({
    messageId,
    expectedRevision: 1,
    content: { format: "markdown", text: "survives **reload**" },
  })).status, "transport");
  const persisted = await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  const exact = persisted.intents[0].request;
  first.client.close();

  const second = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    idempotencyKey: "must-not-replace-key",
  });
  await eventually(() => second.requests.length === 1);
  assert.deepEqual(second.requests[0].body, exact);
  assert.equal(second.requests[0].init.headers["idempotency-key"], "process-one-key");
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  second.client.close();
});

test("canonical event-first settlement removes the intent before the HTTP result", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({
    harness,
    sockets,
    command: () => command.promise,
    idempotencyKey: "event-first-key",
  });
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  const content = { format: "plain", text: "canonical event wins" };
  const pending = fixture.client.editMessage({ messageId, expectedRevision: 1, content });
  await eventually(() => fixture.requests.length === 1);
  const canonical = editResult(fixture.requests[0].body, scope);
  sockets.sockets[0].event(durable(
    "message-updated-event-first",
    CHAT_DURABLE_EVENT_TYPES.messageUpdated,
    { message: canonical.message },
    5,
  ));
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  command.resolve(response(200, canonical));
  assert.equal((await pending).status, "success");
  fixture.client.close();
});

test("terminal outcomes remove edits while transport and malformed ambiguity remain durable", async (t) => {
  await t.test("authorization is terminal", async () => {
    const fixture = await createFixture({
      command: () => response(403, { error: { code: "CHAT_AUTHORIZATION_FAILED", message: "denied" } }),
    });
    assert.equal((await fixture.client.editMessage({
      messageId, expectedRevision: 1, content: { format: "plain", text: "denied" },
    })).status, "rejected");
    assert.equal(await fixture.harness.storage.read(
      identity(), ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ), null);
    assert.equal(fixture.cache.getState().entities.messages[messageId].content.text, "canonical before edit");
    fixture.client.close();
  });

  for (const [name, command, expected] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["malformed", () => response(200, { invalid: true }), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ command, idempotencyKey: `${name}-key` });
      assert.equal((await fixture.client.editMessage({
        messageId, expectedRevision: 1, content: { format: "plain", text: name },
      })).status, expected);
      const record = await fixture.harness.storage.read(
        identity(), ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
      );
      assert.equal(record.intents[0].request.idempotencyKey, `${name}-key`);
      assert.equal(fixture.cache.getState().entities.messages[messageId].editState.state, "pending");
      fixture.client.close();
    });
  }
});

test("a stale-base conflict preserves the canonical message and conflict projection", async () => {
  const canonicalContent = { format: "plain", text: "newer server content" };
  const fixture = await createFixture({
    idempotencyKey: "stale-key",
    command: (request) => response(409, editResult(request, identity(), {
      reconciliationStatus: "revision_conflict",
      message: message(identity(), 3, canonicalContent),
      canonicalRevision: 3,
    })),
  });
  const result = await fixture.client.editMessage({
    messageId,
    expectedRevision: 1,
    content: { format: "plain", text: "stale local content" },
  });
  assert.equal(result.status, "success");
  assert.equal(result.value.reconciliationStatus, "revision_conflict");
  const current = fixture.cache.getState().entities.messages[messageId];
  assert.equal(current.content.text, canonicalContent.text);
  assert.equal(current.editState.state, "revision_conflict");
  assert.equal(await fixture.harness.storage.read(
    identity(), ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  fixture.client.close();
});

test("reload awaits a real canonical base before projecting or dispatching", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const request = editInput("missing-base-key", "project only after hydration");
  await seedEdit(harness, scope, request);
  const cache = createNormalizedChatCache(cacheIdentity());
  const fixture = await createFixture({ harness, cache });
  assert.equal(fixture.requests.length, 0);
  assert.equal(cache.getState().entities.messages[messageId], undefined);
  cache.applyDurableEvent(durable("conversation-for-base", CHAT_DURABLE_EVENT_TYPES.conversationCreated, {
    conversation: {
      id: conversationId, tenantId, type: "channel", visibility: "public",
      name: "Hydrated base", createdAt: now, updatedAt: now,
    },
  }, 0));
  cache.applyDurableEvent(durable("message-for-base", CHAT_DURABLE_EVENT_TYPES.messageCreated, {
    message: message(scope),
  }));
  await eventually(() => fixture.requests.length === 1);
  assert.deepEqual(fixture.requests[0].body, request);
  fixture.client.close();
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
            for (const listener of peer.listeners) listener({ data: structuredClone(value) });
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

test("a follower pauses retained work and recovers it only after becoming leader", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedSnapshot(harness, scope);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leader = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: {
      sessionFingerprint: "durable-edit-session", tabId: "tab-a", clock,
      timing: crossTabTiming, channelFactory: hub.factory("tab-a"),
    },
  });
  const follower = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: {
      sessionFingerprint: "durable-edit-session", tabId: "tab-b", clock,
      timing: crossTabTiming, channelFactory: hub.factory("tab-b"),
    },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination.role, "leader");
  assert.equal(follower.client.coordination.role, "follower");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await seedEdit(harness, scope, editInput("failover-edit-key"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(follower.requests.length, 0);

  leader.client.close();
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(follower.client.coordination.role, "leader");
  await eventually(() => hub.messages.some((value) =>
    value.kind === "command-claim" &&
    value.payload.idempotencyKey === "failover-edit-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => follower.requests.length === 1);
  assert.equal(follower.requests[0].body.idempotencyKey, "failover-edit-key");
  follower.client.close();
});

test("close and identity change cannot project, dispatch, or remove an old-scope edit", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  harness.setMutationReplaceGate(gate);
  const identityRef = { current: identity("editor-a", "device-a") };
  const fixture = await createFixture({ harness, identityRef });
  const pending = fixture.client.editMessage({
    messageId,
    expectedRevision: 1,
    content: { format: "plain", text: "old identity edit" },
  });
  await eventually(() => harness.mutationWriteAttempts().length === 1);
  assert.equal(harness.mutationWrites().length, 0);
  fixture.client.close();
  identityRef.current = identity("editor-b", "device-b");
  fixture.cache.setIdentity(cacheIdentity("editor-b"));
  gate.resolve();
  assert.equal((await pending).status, "validation");
  assert.equal(harness.mutationWrites().length, 1);
  assert.equal(fixture.requests.length, 0);
  assert.notEqual(await harness.storage.read(
    identity("editor-a", "device-a"),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  await seedSnapshot(
    harness,
    identity("editor-b", "device-b"),
    seedCache(identity("editor-b", "device-b")),
  );
  assert.equal((await fixture.client.start()).state, "ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.cache.getState().identity.userId, "editor-b");
  fixture.client.close();
});
