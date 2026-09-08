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
  parseKnownDurableEvent,
} from "../dist/index.js";

const tenantId = "tenant-durable-reaction";
const conversationId = "conversation-durable-reaction";
const messageId = "message-durable-reaction";
const now = "2032-04-01T00:00:00.000Z";
const at = (second) => `2032-04-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const identity = (userId = "reactor-a", deviceId = "device-a") => ({
  tenantId, userId, deviceId,
});
const cacheIdentity = (userId = "reactor-a") => ({
  tenantId, userId, sessionId: `session-${userId}`,
});
const storageKey = (scope, kind) =>
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
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const message = (scope = identity(), reactions = []) => ({
  id: messageId,
  tenantId,
  conversationId,
  author: { type: "user", userId: scope.userId },
  sequence: 1,
  createdAt: at(1),
  updatedAt: at(1),
  revision: { revision: 1 },
  content: { format: "plain", text: "canonical reaction base" },
  ...(reactions.length === 0 ? {} : { reactions }),
});
const conversation = () => ({
  id: conversationId,
  tenantId,
  type: "channel",
  visibility: "public",
  name: "Durable reactions",
  createdAt: now,
  updatedAt: now,
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
const seedCache = (scope = identity(), reactions = []) => {
  const cache = createNormalizedChatCache(cacheIdentity(scope.userId));
  cache.applyDurableEvent(durable(
    "conversation-created",
    CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    { conversation: conversation() },
    0,
  ));
  cache.applyDurableEvent(durable(
    "message-created",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message(scope, reactions) },
  ));
  return cache;
};
const reactionInput = (
  idempotencyKey = "durable-reaction-key",
  operation = "add_reaction",
  reactionKey = "thumbsup",
) => ({ operation, messageId, reactionKey, idempotencyKey });
const reactionResult = (request, overrides = {}) => ({
  operation: request.operation,
  reconciliationStatus: "applied",
  messageId: request.messageId,
  reactionKey: request.reactionKey,
  count: request.operation === "add_reaction" ? 1 : 0,
  reactedByCurrentUser: request.operation === "add_reaction",
  ...overrides,
});
const aggregate = (cache, reactionKey = "thumbsup") =>
  cache.getState().entities.messages[messageId]?.reactions.find(
    (reaction) => reaction.reactionKey === reactionKey,
  );

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  const mutationWriteAttempts = () => calls.filter(({ operation, kind, replacement }) =>
    (operation === "replace" || (operation === "compareExchange" && replacement !== null)) &&
    kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents);
  let mutationReplaceGate;
  let mutationReplaceFailure;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      const call = { operation: "replace", scope, kind, encoded, written: false };
      calls.push(call);
      if (kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
        if (mutationReplaceGate !== undefined) await mutationReplaceGate.promise;
        if (mutationReplaceFailure !== undefined) throw mutationReplaceFailure;
      }
      rows.set(storageKey(scope, kind), encoded);
      call.written = true;
    },
    async compareExchange(scope, kind, expected, replacement) {
      const call = { operation: "compareExchange", scope, kind, expected, replacement, written: false };
      calls.push(call);
      if (replacement !== null && kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
        if (mutationReplaceGate !== undefined) await mutationReplaceGate.promise;
        if (mutationReplaceFailure !== undefined) throw mutationReplaceFailure;
      }
      // Compare and mutate together after any simulated storage delay.
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else {
        rows.set(key, replacement);
        call.written = true;
      }
      return true;
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope, kind });
      rows.delete(storageKey(scope, kind));
    },
    async clearForLogout(scope) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(storageKey(scope, kind));
      }
    },
  });
  return {
    rows,
    calls,
    storage,
    setMutationReplaceGate(gate) { mutationReplaceGate = gate; },
    setMutationReplaceFailure(error) { mutationReplaceFailure = error; },
    mutationWriteAttempts,
    mutationWrites() {
      return mutationWriteAttempts().filter(({ written }) => written);
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
        disconnect() {
          this.readyState = 3;
          this.onclose?.({ code: 1006, reason: "offline" });
        },
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
  idempotencyKeys = ["generated-reaction-key"],
  sockets,
  crossTab,
} = {}) {
  const requests = [];
  let keyIndex = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    optimisticReactions: {
      generateIdempotencyKey: () =>
        idempotencyKeys[keyIndex++] ?? `generated-reaction-${keyIndex}`,
    },
    fetch: async (url, init) => {
      if (String(url).endsWith("/_meta")) {
        return response(200, metadata(sockets !== undefined));
      }
      const body = JSON.parse(init.body);
      requests.push({ url, init, body, scope: identityRef.current });
      return command?.(body, requests.length) ??
        response(200, reactionResult(body));
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

test("durable reactions persist before projection or dispatch and fail closed", async (t) => {
  await t.test("persist first", async () => {
    const harness = createStorageHarness();
    const gate = deferred();
    const fixture = await createFixture({ harness });
    harness.setMutationReplaceGate(gate);
    const pending = fixture.client.setReaction({
      messageId, reactionKey: "thumbsup", reacted: true,
    });
    await eventually(() => harness.mutationWriteAttempts().length === 1);
    assert.equal(harness.mutationWrites().length, 0);
    assert.equal(aggregate(fixture.cache), undefined);
    assert.equal(fixture.requests.length, 0);
    gate.resolve();
    assert.equal((await pending).status, "success");
    assert.equal(harness.mutationWrites().length, 1);
    assert.equal(fixture.requests.length, 1);
    fixture.client.close();
  });

  await t.test("failed write", async () => {
    const harness = createStorageHarness();
    harness.setMutationReplaceFailure(new Error("unavailable"));
    const fixture = await createFixture({ harness });
    const result = await fixture.client.setReaction({
      messageId, reactionKey: "thumbsup", reacted: true,
    });
    assert.equal(result.status, "validation");
    assert.equal(harness.mutationWrites().length, 0);
    assert.equal(aggregate(fixture.cache), undefined);
    assert.equal(fixture.requests.length, 0);
    fixture.client.close();
  });
});

test("successive same-key desired states coalesce to the latest stored request", async () => {
  const pendingRequests = [];
  const fixture = await createFixture({
    idempotencyKeys: ["reaction-add", "reaction-remove"],
    command: () => {
      const request = deferred();
      pendingRequests.push(request);
      return request.promise;
    },
  });
  const add = fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  });
  await eventually(() => fixture.requests.length === 1);
  const remove = fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: false,
  });
  await eventually(() => fixture.harness.mutationWrites().length === 2);
  const retained = await fixture.harness.storage.read(
    identity(),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.deepEqual(retained.intents.map((intent) => ({
    enqueueOrder: intent.enqueueOrder,
    operation: intent.request.operation,
    idempotencyKey: intent.request.idempotencyKey,
  })), [{ enqueueOrder: 1, operation: "remove_reaction", idempotencyKey: "reaction-remove" }]);
  assert.equal(aggregate(fixture.cache, "eyes"), undefined);

  pendingRequests[0].resolve(response(200, reactionResult(fixture.requests[0].body)));
  assert.equal((await add).status, "success");
  await eventually(() => fixture.requests.length === 2);
  pendingRequests[1].resolve(response(200, reactionResult(fixture.requests[1].body)));
  assert.equal((await remove).status, "success");
  fixture.client.close();
});

test("reaction FIFO survives unrelated keys and intervening mutation lanes", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const edit = {
    operation: "edit",
    messageId: "unavailable-sibling-message",
    expectedRevision: 1,
    content: { format: "plain", text: "independent lane" },
    idempotencyKey: "sibling-edit",
  };
  await seedSnapshot(harness, scope);
  await seedMutations(harness, scope, [
    reactionInput("thumb-add", "add_reaction", "thumbsup"),
    edit,
    reactionInput("thumb-remove", "remove_reaction", "thumbsup"),
    reactionInput("heart-add", "add_reaction", "heart"),
  ]);
  const fixture = await createFixture({ harness, cache: createNormalizedChatCache() });
  await eventually(() => fixture.requests.length === 3);
  assert.deepEqual(fixture.requests.map(({ body }) => [
    body.reactionKey,
    body.operation,
    body.idempotencyKey,
  ]), [
    ["thumbsup", "add_reaction", "thumb-add"],
    ["thumbsup", "remove_reaction", "thumb-remove"],
    ["heart", "add_reaction", "heart-add"],
  ]);
  const retained = await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.deepEqual(retained.intents.map((intent) => intent.request), [edit]);
  fixture.client.close();
});

test("an ambiguous reaction replays the exact request and idempotency key", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedSnapshot(harness, scope);
  const first = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    idempotencyKeys: ["process-one-reaction-key"],
    command: () => { throw new Error("offline"); },
  });
  assert.equal((await first.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
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
    idempotencyKeys: ["must-not-replace-key"],
  });
  await eventually(() => second.requests.length === 1);
  assert.deepEqual(second.requests[0].body, exact);
  assert.equal(
    second.requests[0].init.headers["idempotency-key"],
    "process-one-reaction-key",
  );
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  second.client.close();
});

test("connectivity restoration replays a retained reaction with the same key", async () => {
  const scope = identity();
  const sockets = createSockets(scope);
  const fixture = await createFixture({
    sockets,
    idempotencyKeys: ["reconnect-reaction-key"],
    command: (request, attempt) => {
      if (attempt === 1) throw new Error("offline");
      return response(200, reactionResult(request));
    },
  });
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  assert.equal((await fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  })).status, "transport");
  sockets.sockets[0].disconnect();
  await eventually(() => sockets.sockets.length >= 2);
  sockets.sockets.at(-1).accept();
  await eventually(() => fixture.requests.length === 2);
  assert.deepEqual(fixture.requests.map(({ body }) => body.idempotencyKey), [
    "reconnect-reaction-key",
    "reconnect-reaction-key",
  ]);
  await eventually(async () => await fixture.harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  fixture.client.close();
});

test("a matching canonical reaction.updated event retains the command until HTTP settles", async (t) => {
  const harness = createStorageHarness();
  const scope = identity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({
    harness,
    sockets,
    command: () => command.promise,
    idempotencyKeys: ["event-first-reaction-key"],
  });
  t.after(() => fixture.client.close());
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  const pending = fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  });
  let settled = false;
  void pending.then(() => { settled = true; });
  await eventually(() => fixture.requests.length === 1);
  const canonical = reactionResult(fixture.requests[0].body);
  sockets.sockets[0].event(durable(
    "reaction-event-first",
    CHAT_DURABLE_EVENT_TYPES.reactionUpdated,
    {
      operation: canonical.operation,
      messageId: canonical.messageId,
      reactionKey: canonical.reactionKey,
      count: canonical.count,
      reactedByCurrentUser: canonical.reactedByCurrentUser,
    },
    2,
  ));
  await new Promise((resolve) => setImmediate(resolve));
  const retained = await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.equal(retained?.intents.length, 1);
  assert.deepEqual(retained.intents[0].request, fixture.requests[0].body);
  assert.equal(settled, false);
  assert.equal(aggregate(fixture.cache, "eyes").count, canonical.count + 1);
  const httpResult = reactionResult(fixture.requests[0].body, { count: 3 });
  command.resolve(response(200, httpResult));
  assert.deepEqual(await pending, { status: "success", value: httpResult });
  assert.equal(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  assert.equal(aggregate(fixture.cache, "eyes").count, httpResult.count);
});

test("uncorrelated reaction broadcasts retain the intent until terminal HTTP failure", async (t) => {
  const harness = createStorageHarness();
  const scope = identity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({
    harness,
    sockets,
    command: () => command.promise,
    idempotencyKeys: ["broadcast-before-denied-key"],
  });
  t.after(() => fixture.client.close());
  await eventually(() => sockets.sockets.length === 1);
  const socket = sockets.sockets[0];
  socket.accept();
  const pending = fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  });
  let settled = false;
  void pending.then(() => { settled = true; });
  await eventually(() => fixture.requests.length === 1);
  const original = await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.equal(original.intents.length, 1);
  assert.deepEqual(original.intents[0].request, fixture.requests[0].body);
  const broadcast = durable(
    "reaction-before-denied",
    CHAT_DURABLE_EVENT_TYPES.reactionUpdated,
    { conversationId, ...reactionResult(fixture.requests[0].body, { count: 2 }) },
    2,
  );
  assert.deepEqual(parseKnownDurableEvent(broadcast, scope), broadcast);
  for (let delivery = 0; delivery < 2; delivery += 1) {
    socket.event(broadcast);
    await eventually(() =>
      fixture.cache.getState().metadata.realtimeCursor?.eventId === broadcast.eventId);
    // Flush delivery callbacks and any erroneous asynchronous settlement, including
    // the duplicate delivery, before checking the storage and caller boundaries.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      retained: await harness.storage.read(
        scope,
        ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
      ),
      settled,
    }, { retained: original, settled: false },
    "an uncorrelated broadcast must retain the exact intent and leave the caller unresolved");
    assert.deepEqual(aggregate(fixture.cache, "eyes"), {
      reactionKey: "eyes", count: 3, reactedByCurrentUser: true,
    });
  }

  command.resolve(response(401, {
    error: { code: "CHAT_AUTHENTICATION_FAILED", message: "denied" },
  }));
  assert.deepEqual(await pending, {
    status: "authentication",
    message: "Chat authentication failed.",
    httpStatus: 401,
  });
  assert.equal(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  // Roll back only our optimistic add; preserve the broadcast's canonical count.
  assert.deepEqual(aggregate(fixture.cache, "eyes"), {
    reactionKey: "eyes", count: 2, reactedByCurrentUser: false,
  });
  assert.equal(fixture.requests.length, 1);
});

test("uncorrelated reaction broadcast preserves ambiguous work across restart until HTTP success", async (t) => {
  const harness = createStorageHarness();
  const scope = identity();
  const identityRef = { current: scope };
  const sockets = createSockets(scope);
  const command = deferred();
  await seedSnapshot(harness, scope);
  const first = await createFixture({
    harness,
    identityRef,
    sockets,
    cache: createNormalizedChatCache(),
    command: () => command.promise,
    idempotencyKeys: ["broadcast-before-offline-key"],
  });
  t.after(() => first.client.close());
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  const pending = first.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  });
  let settled = false;
  void pending.then(() => { settled = true; });
  await eventually(() => first.requests.length === 1);
  const original = await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
  assert.equal(original.intents.length, 1);
  const exact = original.intents[0].request;
  assert.deepEqual(first.requests[0].body, exact);
  assert.equal(exact.idempotencyKey, "broadcast-before-offline-key");
  assert.equal(first.requests[0].init.headers["idempotency-key"], exact.idempotencyKey);
  const broadcast = durable(
    "reaction-before-offline",
    CHAT_DURABLE_EVENT_TYPES.reactionUpdated,
    { conversationId, ...reactionResult(exact, { count: 2 }) },
    2,
  );
  assert.deepEqual(parseKnownDurableEvent(broadcast, scope), broadcast);
  sockets.sockets[0].event(broadcast);
  await eventually(() =>
    first.cache.getState().metadata.realtimeCursor?.eventId === broadcast.eventId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({
    retained: await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ),
    settled,
  }, { retained: original, settled: false },
  "an uncorrelated broadcast must retain the exact intent and leave the caller unresolved");
  assert.deepEqual(aggregate(first.cache, "eyes"), {
    reactionKey: "eyes", count: 3, reactedByCurrentUser: true,
  });

  command.reject(new Error("connection lost after dispatch"));
  assert.equal((await pending).status, "transport");
  assert.deepEqual(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), original);
  assert.equal(aggregate(first.cache, "eyes").reactedByCurrentUser, true);
  assert.equal(first.requests.length, 1);
  first.client.close();

  const recovery = deferred();
  const second = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(),
    command: () => recovery.promise,
    idempotencyKeys: ["must-not-replace-broadcast-key"],
  });
  t.after(() => second.client.close());
  await eventually(() => second.requests.length === 1);
  assert.deepEqual(second.requests[0].body, exact);
  assert.deepEqual(second.requests[0].scope, scope);
  assert.equal(second.requests[0].init.headers["idempotency-key"], exact.idempotencyKey);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), original, "recovery must retain the original intent while its HTTP response is pending");

  const canonical = reactionResult(exact, { count: 4 });
  recovery.resolve(response(200, canonical));
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  assert.deepEqual(aggregate(second.cache, "eyes"), {
    reactionKey: "eyes", count: canonical.count, reactedByCurrentUser: true,
  });
  assert.equal(second.requests.length, 1);
});

test("terminal reaction failures roll back and remove; ambiguous failures remain", async (t) => {
  await t.test("authentication is terminal", async () => {
    const fixture = await createFixture({
      command: () => response(401, {
        error: { code: "CHAT_AUTHENTICATION_FAILED", message: "denied" },
      }),
    });
    assert.equal((await fixture.client.setReaction({
      messageId, reactionKey: "eyes", reacted: true,
    })).status, "authentication");
    assert.equal(aggregate(fixture.cache, "eyes"), undefined);
    assert.equal(await fixture.harness.storage.read(
      identity(),
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    ), null);
    fixture.client.close();
  });

  for (const [name, command, expected] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["malformed", () => response(200, { invalid: true }), "malformed_response"],
    ["mismatched", (request) => response(200, reactionResult(request, {
      reactionKey: "different",
    })), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        command,
        idempotencyKeys: [`${name}-reaction-key`],
      });
      assert.equal((await fixture.client.setReaction({
        messageId, reactionKey: "eyes", reacted: true,
      })).status, expected);
      const retained = await fixture.harness.storage.read(
        identity(),
        ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
      );
      assert.equal(retained.intents[0].request.idempotencyKey, `${name}-reaction-key`);
      assert.equal(aggregate(fixture.cache, "eyes").reactedByCurrentUser, true);
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

test("only the elected leader dispatches a retained reaction and followers observe it", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedSnapshot(harness, scope);
  await seedMutations(harness, scope, [reactionInput("leader-reaction-key")]);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const leader = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: {
      sessionFingerprint: "durable-reaction-session",
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
      sessionFingerprint: "durable-reaction-session",
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
    value.payload.idempotencyKey === "leader-reaction-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => leader.requests.length + follower.requests.length === 1);
  assert.equal(leader.requests.length, 1);
  assert.equal(follower.requests.length, 0);
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  assert.equal(hub.messages.some((value) =>
    value.kind === "command-result" &&
    value.payload.idempotencyKey === "leader-reaction-key"), true);
  leader.client.close();
  follower.client.close();
});

test("retained projection waits for a canonical message", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  await seedMutations(harness, scope, [reactionInput("missing-base-reaction", "add_reaction", "eyes")]);
  const command = deferred();
  const cache = createNormalizedChatCache(cacheIdentity());
  const fixture = await createFixture({
    harness,
    cache,
    command: () => command.promise,
  });
  await eventually(() => fixture.requests.length === 1);
  assert.equal(cache.getState().entities.messages[messageId], undefined);
  cache.applyDurableEvent(durable(
    "conversation-for-reaction-base",
    CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    { conversation: conversation() },
    0,
  ));
  cache.applyDurableEvent(durable(
    "message-for-reaction-base",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message(scope) },
  ));
  await eventually(() => aggregate(cache, "eyes")?.reactedByCurrentUser === true);
  command.resolve(response(200, reactionResult(fixture.requests[0].body)));
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ) === null);
  fixture.client.close();
});

test("recovery restores only the latest desired projection for a reaction lane", async () => {
  const harness = createStorageHarness();
  const scope = identity();
  const pendingRequests = [];
  await seedSnapshot(harness, scope);
  await seedMutations(harness, scope, [
    reactionInput("older-add", "add_reaction", "eyes"),
    {
      operation: "edit",
      messageId: "intervening-message",
      expectedRevision: 1,
      content: { format: "plain", text: "preserve ordering" },
      idempotencyKey: "intervening-edit",
    },
    reactionInput("latest-remove", "remove_reaction", "eyes"),
  ]);
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    command: () => {
      const request = deferred();
      pendingRequests.push(request);
      return request.promise;
    },
  });
  await eventually(() => fixture.requests.length === 1);
  assert.equal(aggregate(fixture.cache, "eyes"), undefined);
  pendingRequests[0].resolve(response(200, reactionResult(fixture.requests[0].body)));
  await eventually(() => fixture.requests.length === 2);
  assert.equal(aggregate(fixture.cache, "eyes"), undefined);
  pendingRequests[1].resolve(response(200, reactionResult(fixture.requests[1].body)));
  await eventually(async () => (await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  )).intents.length === 1);
  fixture.client.close();
});

test("close and identity replacement isolate a pending reaction persistence write", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  harness.setMutationReplaceGate(gate);
  const identityRef = { current: identity("reactor-a", "device-a") };
  const fixture = await createFixture({ harness, identityRef });
  const pending = fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  });
  await eventually(() => harness.mutationWriteAttempts().length === 1);
  assert.equal(harness.mutationWrites().length, 0);
  fixture.client.close();
  identityRef.current = identity("reactor-b", "device-b");
  fixture.cache.setIdentity(cacheIdentity("reactor-b"));
  gate.resolve();
  assert.equal((await pending).status, "validation");
  assert.equal(fixture.requests.length, 0);
  assert.notEqual(await harness.storage.read(
    identity("reactor-a", "device-a"),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  await seedSnapshot(
    harness,
    identity("reactor-b", "device-b"),
    seedCache(identity("reactor-b", "device-b")),
  );
  assert.equal((await fixture.client.start()).state, "ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.cache.getState().identity.userId, "reactor-b");
  fixture.client.close();
});

test("a logout boundary cannot project or dispatch a pending reaction write", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  harness.setMutationReplaceGate(gate);
  const fixture = await createFixture({ harness });
  const pending = fixture.client.setReaction({
    messageId, reactionKey: "eyes", reacted: true,
  });
  await eventually(() => harness.mutationWriteAttempts().length === 1);
  assert.equal(harness.mutationWrites().length, 0);
  fixture.cache.setIdentity(null);
  gate.resolve();
  assert.equal((await pending).status, "validation");
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.cache.getState().identity, null);
  assert.notEqual(await harness.storage.read(
    identity(),
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  ), null);
  fixture.client.close();
});
