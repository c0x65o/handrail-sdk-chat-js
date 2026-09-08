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

const tenantId = "tenant-durable-delete";
const conversationId = "conversation-durable-delete";
const messageId = "message-durable-delete";
const now = "2032-03-01T00:00:00.000Z";
const at = (second) => `2032-03-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const identity = (userId = "deleter-a", deviceId = "device-a") => ({
  tenantId, userId, deviceId,
});
const cacheIdentity = (userId = "deleter-a") => ({
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

const message = (scope = identity(), revision = 1, deleted = false) => ({
  id: messageId,
  tenantId,
  conversationId,
  author: { type: "user", userId: scope.userId },
  sequence: 1,
  createdAt: at(1),
  updatedAt: revision === 1 ? at(1) : at(5),
  revision: { revision },
  content: deleted ? null : { format: "plain", text: "canonical before delete" },
  ...(deleted ? { deletedAt: at(5), deletedByUserId: scope.userId } : {}),
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
const seedCache = (scope = identity(), deleted = false) => {
  const cache = createNormalizedChatCache(cacheIdentity(scope.userId));
  cache.applyDurableEvent(durable(
    "conversation-created",
    CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    { conversation: {
      id: conversationId,
      tenantId,
      type: "channel",
      visibility: "public",
      name: "Durable deletes",
      createdAt: now,
      updatedAt: now,
    } },
    0,
  ));
  cache.applyDurableEvent(durable(
    "message-created",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message(scope) },
  ));
  if (deleted) {
    cache.applyDurableEvent(durable(
      "message-deleted",
      CHAT_DURABLE_EVENT_TYPES.messageDeleted,
      { message: message(scope, 2, true) },
      5,
    ));
  }
  return cache;
};
const deleteInput = (idempotencyKey = "durable-delete-key") => ({
  operation: "soft_delete",
  messageId,
  expectedRevision: 1,
  idempotencyKey,
});
const deleteResult = (request, scope = identity(), overrides = {}) => ({
  operation: "soft_delete",
  reconciliationStatus: "applied",
  expectedRevision: request.expectedRevision,
  message: message(scope, request.expectedRevision + 1, true),
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

async function seedMutations(harness, scope, requests) {
  await harness.storage.replace(createApplicationChatQueuedMessageMutationIntentsRecord(
    scope,
    requests.map((request, index) =>
      createApplicationChatQueuedMessageMutationIntent(request, {
        enqueueOrder: index + 1,
        enqueuedAt: at(index),
      })),
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
  idempotencyKey = "generated-delete-key",
  sockets,
  crossTab,
} = {}) {
  const requests = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    optimisticDeletes: { generateIdempotencyKey: () => idempotencyKey },
    fetch: async (url, init) => {
      if (String(url).endsWith("/_meta")) {
        return response(200, metadata(sockets !== undefined));
      }
      const body = JSON.parse(init.body);
      requests.push({ url, init, body, scope: identityRef.current });
      return command?.(body, requests.length) ??
        response(200, deleteResult(body, identityRef.current));
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

test("durable deletes persist before projection or dispatch and preserve sibling mutations", async (t) => {
  await t.test("persist first and remove only the delete", async () => {
    const harness = createStorageHarness();
    const scope = identity();
    const siblingEdit = {
      operation: "edit",
      messageId: "other-message",
      expectedRevision: 1,
      content: { format: "plain", text: "preserve me" },
      idempotencyKey: "sibling-edit-key",
    };
    await seedMutations(harness, scope, [siblingEdit]);
    const fixture = await createFixture({ harness });
    const gate = deferred();
    harness.setMutationReplaceGate(gate);
    const pending = fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
    await eventually(() => harness.mutationWriteAttempts().length === 2);
    assert.equal(harness.mutationWrites().length, 1);
    assert.equal(
      fixture.cache.getState().entities.messages[messageId].content.text,
      "canonical before delete",
    );
    assert.equal(fixture.requests.length, 0);
    gate.resolve();
    assert.equal((await pending).status, "success");
    const retained = await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    );
    assert.deepEqual(retained.intents.map((intent) => intent.request), [siblingEdit]);
    fixture.client.close();
  });

  await t.test("failed write fails closed", async () => {
    const harness = createStorageHarness();
    harness.setMutationReplaceFailure(new Error("unavailable"));
    const fixture = await createFixture({ harness });
    const result = await fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
    assert.equal(result.status, "validation");
    assert.equal(harness.mutationWrites().length, 0);
    assert.equal(
      fixture.cache.getState().entities.messages[messageId].content.text,
      "canonical before delete",
    );
    assert.equal(fixture.requests.length, 0);
    fixture.client.close();
  });
});

test("an ambiguous delete replays the byte-equivalent request and original key", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedSnapshot(harness, scope);
  const first = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    idempotencyKey: "process-one-delete-key",
    command: () => { throw new Error("offline"); },
  });
  assert.equal((await first.client.deleteMessage({
    messageId,
    expectedRevision: 1,
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
    idempotencyKey: "must-not-replace-delete-key",
  });
  await eventually(() => second.requests.length === 1);
  assert.deepEqual(second.requests[0].body, exact);
  assert.equal(
    second.requests[0].init.headers["idempotency-key"],
    "process-one-delete-key",
  );
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  second.client.close();
});

test("a canonical message.deleted event settles storage before HTTP completion", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({
    harness,
    sockets,
    command: () => command.promise,
    idempotencyKey: "event-first-delete-key",
  });
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  const pending = fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
  await eventually(() => fixture.requests.length === 1);
  const canonical = deleteResult(fixture.requests[0].body, scope);
  sockets.sockets[0].event(durable(
    "message-deleted-event-first",
    CHAT_DURABLE_EVENT_TYPES.messageDeleted,
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

test("terminal outcomes remove and reconcile while ambiguous outcomes remain durable", async (t) => {
  await t.test("authorization rolls back and removes", async () => {
    const fixture = await createFixture({
      command: () => response(403, {
        error: { code: "CHAT_AUTHORIZATION_FAILED", message: "denied" },
      }),
    });
    assert.equal((await fixture.client.deleteMessage({
      messageId,
      expectedRevision: 1,
    })).status, "rejected");
    assert.equal(await fixture.harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ), null);
    assert.equal(
      fixture.cache.getState().entities.messages[messageId].content.text,
      "canonical before delete",
    );
    fixture.client.close();
  });

  await t.test("revision conflict reconciles and removes", async () => {
    const fixture = await createFixture({
      command: (request) => response(409, deleteResult(request, identity(), {
        reconciliationStatus: "revision_conflict",
        message: {
          ...message(identity(), 3),
          updatedAt: at(6),
          content: { format: "plain", text: "newer canonical content" },
        },
        canonicalRevision: 3,
      })),
    });
    const result = await fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
    assert.equal(result.status, "success");
    assert.equal(result.value.reconciliationStatus, "revision_conflict");
    assert.equal(
      fixture.cache.getState().entities.messages[messageId].content.text,
      "newer canonical content",
    );
    assert.equal(await fixture.harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ), null);
    fixture.client.close();
  });

  for (const [name, command, expected] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["malformed", () => response(200, { invalid: true }), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        command,
        idempotencyKey: `${name}-delete-key`,
      });
      assert.equal((await fixture.client.deleteMessage({
        messageId,
        expectedRevision: 1,
      })).status, expected);
      const record = await fixture.harness.storage.read(
        identity(),
        ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
      );
      assert.equal(record.intents[0].request.idempotencyKey, `${name}-delete-key`);
      assert.equal(
        fixture.cache.getState().entities.messages[messageId].deleteState.state,
        "pending",
      );
      fixture.client.close();
    });
  }
});

test("reload converges already-deleted state and waits for a missing authoritative base", async (t) => {
  await t.test("already deleted", async () => {
    const harness = createStorageHarness();
    const scope = identity();
    await seedMutations(harness, scope, [deleteInput("already-deleted-key")]);
    await seedSnapshot(harness, scope, seedCache(scope, true));
    const fixture = await createFixture({ harness, cache: createNormalizedChatCache() });
    await eventually(async () => await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ) === null);
    assert.equal(fixture.requests.length, 0);
    const current = fixture.cache.getState().entities.messages[messageId];
    assert.equal(current.content, null);
    assert.equal("deleteState" in current, false);
    fixture.client.close();
  });

  await t.test("missing base", async () => {
    const harness = createStorageHarness();
    const scope = identity();
    const request = deleteInput("missing-base-delete-key");
    await seedMutations(harness, scope, [request]);
    const cache = createNormalizedChatCache(cacheIdentity());
    const fixture = await createFixture({ harness, cache });
    assert.equal(fixture.requests.length, 0);
    assert.equal(cache.getState().entities.messages[messageId], undefined);
    cache.applyDurableEvent(durable(
      "conversation-for-delete-base",
      CHAT_DURABLE_EVENT_TYPES.conversationCreated,
      { conversation: {
        id: conversationId,
        tenantId,
        type: "channel",
        visibility: "public",
        name: "Hydrated base",
        createdAt: now,
        updatedAt: now,
      } },
      0,
    ));
    cache.applyDurableEvent(durable(
      "message-for-delete-base",
      CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { message: message(scope) },
    ));
    await eventually(() => fixture.requests.length === 1);
    assert.deepEqual(fixture.requests[0].body, request);
    fixture.client.close();
  });
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
      owner,
      name,
      listeners,
      closed: false,
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

test("a follower pauses retained deletes and recovers them after leadership", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedSnapshot(harness, scope);
  await seedMutations(harness, scope, [deleteInput("failover-delete-key")]);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leader = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: {
      sessionFingerprint: "durable-delete-session",
      tabId: "tab-a",
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory("tab-a"),
    },
  });
  const follower = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: {
      sessionFingerprint: "durable-delete-session",
      tabId: "tab-b",
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory("tab-b"),
    },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination.role, "leader");
  assert.equal(follower.client.coordination.role, "follower");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(follower.requests.length, 0);
  assert.equal(hub.messages.some((value) =>
    value.kind === "persisted-command-available" &&
    value.payload.command === "message.delete" &&
    value.payload.idempotencyKey === "failover-delete-key"), true);

  const priorClaims = hub.messages.filter((value) =>
    value.kind === "command-claim" &&
    value.payload.idempotencyKey === "failover-delete-key").length;
  leader.client.close();
  clock.tick(
    crossTabTiming.commandClaimLeaseMs + crossTabTiming.electionDelayMs,
  );
  assert.equal(follower.client.coordination.role, "leader");
  await eventually(() => hub.messages.filter((value) =>
    value.kind === "command-claim" &&
    value.payload.idempotencyKey === "failover-delete-key").length > priorClaims);
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => follower.requests.length === 1);
  assert.equal(follower.requests[0].body.idempotencyKey, "failover-delete-key");
  follower.client.close();
});

test("close and identity replacement isolate a pending delete storage write", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  harness.setMutationReplaceGate(gate);
  const identityRef = { current: identity("deleter-a", "device-a") };
  const fixture = await createFixture({ harness, identityRef });
  const pending = fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
  await eventually(() => harness.mutationWriteAttempts().length === 1);
  assert.equal(harness.mutationWrites().length, 0);
  fixture.client.close();
  identityRef.current = identity("deleter-b", "device-b");
  fixture.cache.setIdentity(cacheIdentity("deleter-b"));
  gate.resolve();
  assert.equal((await pending).status, "validation");
  assert.equal(harness.mutationWrites().length, 1);
  assert.equal(fixture.requests.length, 0);
  assert.notEqual(await harness.storage.read(
    identity("deleter-a", "device-a"),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  await seedSnapshot(
    harness,
    identity("deleter-b", "device-b"),
    seedCache(identity("deleter-b", "device-b")),
  );
  assert.equal((await fixture.client.start()).state, "ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.cache.getState().identity.userId, "deleter-b");
  fixture.client.close();
});
