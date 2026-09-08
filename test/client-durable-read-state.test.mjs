import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatQueuedReadCursorIntent,
  createApplicationChatQueuedReadCursorIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  createReadCursorUpdatedEvent,
} from "../dist/index.js";

const tenantId = "tenant-durable-read";
const conversationId = "conversation-durable-read";
const at = (second) =>
  `2031-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const storageIdentity = (userId = "reader-a", deviceId = "device-a") => ({
  tenantId,
  userId,
  deviceId,
});
const cacheIdentity = (userId = "reader-a", sessionId = "session-a") => ({
  tenantId,
  userId,
  sessionId,
});
const recordKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
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
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const errorResponse = (status, code) =>
  response(status, { error: { code, message: "read cursor rejected" } });
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const summary = (userId, lastReadSequence = 1) => ({
  id: conversationId,
  tenantId,
  type: "channel",
  visibility: "public",
  name: "Durable read state",
  createdAt: at(0),
  updatedAt: at(0),
  latestSequence: 5,
  unreadMentionCount: 0,
  activityAt: at(0),
  activeMemberUserIds: [userId],
  currentMember: {
    tenantId,
    conversationId,
    userId,
    role: "member",
    state: "active",
    joinedAt: at(0),
    updatedAt: at(0),
  },
  currentReadState: {
    conversationId,
    userId,
    lastReadSequence,
    updatedAt: at(0),
  },
  currentPreference: {
    conversationId,
    userId,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: at(0),
  },
});

function seedCache(userId = "reader-a", sessionId = "session-a", lastReadSequence = 1) {
  const cache = createNormalizedChatCache(cacheIdentity(userId, sessionId));
  hydrateCache(cache, userId, lastReadSequence);
  return cache;
}

function hydrateCache(cache, userId, lastReadSequence = 1) {
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [summary(userId, lastReadSequence)],
    page: {},
    _meta: { ...metadata, feature: { name: "conversation_snapshots", version: 1 } },
  });
}

function readResult(userId, operation, second, sequence = 5) {
  return {
    operation,
    conversationId,
    readState: {
      conversationId,
      userId,
      lastReadSequence: sequence,
      updatedAt: at(second),
      ...(operation === "mark_unread" ? { manualUnreadFromSequence: 2 } : {}),
    },
    latestSequence: 5,
    unreadCount: operation === "mark_unread" ? 4 : 5 - sequence,
  };
}

function httpReadResult(userId, operation, second, idempotencyKey, sequence = 5) {
  return {
    ...readResult(userId, operation, second, sequence),
    reconciliationStatus: "applied",
    idempotencyKey,
  };
}

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let replaceGate;
  let replaceFailure;
  const storage = createApplicationChatStorage({
    async read(identity, kind) {
      calls.push({ operation: "read", identity, kind });
      return rows.get(recordKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity, kind, encoded });
      if (kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents) {
        if (replaceGate !== undefined) await replaceGate.promise;
        if (replaceFailure !== undefined) throw replaceFailure;
      }
      rows.set(recordKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity, kind });
      rows.delete(recordKey(identity, kind));
    },
    async clearForLogout(identity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(recordKey(identity, kind));
      }
    },
  });
  return {
    rows,
    calls,
    storage,
    setReplaceGate(gate) { replaceGate = gate; },
    setReplaceFailure(error) { replaceFailure = error; },
    readWrites() {
      return calls.filter(({ operation, kind }) =>
        operation === "replace" &&
        kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents);
    },
    async readRecord(identity) {
      return storage.read(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents);
    },
  };
}

async function createFixture({
  userId = "reader-a",
  lastReadSequence = 1,
  identityRef = { current: storageIdentity(userId) },
  cache = seedCache(userId, `session-${userId}`, lastReadSequence),
  harness = createStorageHarness(),
  command,
} = {}) {
  const requests = [];
  let generatedKey = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    cache,
    fetch: async (url, init) => {
      if (init.method === "GET") return response(200, metadata);
      const request = { url, init, body: JSON.parse(init.body) };
      requests.push(request);
      return command?.(request, identityRef.current, requests.length) ??
        response(200, httpReadResult(
          identityRef.current.userId,
          request.body.operation,
          5,
          request.body.idempotencyKey,
        ));
    },
    commands: { retry: { maxAttempts: 1 } },
    readState: {
      generateIdempotencyKey: () => `read-key-${++generatedKey}`,
      now: () => Date.parse(at(1)),
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
    },
  });
  assert.equal((await client.start()).state, "ready");
  return { cache, client, harness, identityRef, requests };
}

test("durably coalesces before projection and dispatch with one stable correlation", async () => {
  const gate = deferred();
  const command = deferred();
  const harness = createStorageHarness();
  harness.setReplaceGate(gate);
  const fixture = await createFixture({
    harness,
    command: () => command.promise,
  });
  const first = fixture.client.markRead({ conversationId, throughSequence: 3 });
  const second = fixture.client.markRead({ conversationId, throughSequence: 5 });

  await eventually(() => harness.readWrites().length === 1);
  assert.equal(fixture.cache.getState().currentUser.readStates[conversationId].lastReadSequence, 1);
  assert.equal(fixture.requests.length, 0);

  gate.resolve();
  await eventually(() => fixture.requests.length === 1);
  const persisted = await harness.readRecord(storageIdentity());
  assert.equal(persisted.intents.length, 1);
  assert.equal(persisted.intents[0].request.throughSequence, 5);
  assert.equal(persisted.intents[0].request.idempotencyKey, "read-key-1");
  assert.equal(persisted.intents[0].acknowledgedReadState.lastReadSequence, 1);
  assert.equal(fixture.cache.getState().currentUser.readStates[conversationId].lastReadSequence, 5);
  assert.equal(fixture.requests[0].body.idempotencyKey, "read-key-1");
  assert.equal(fixture.requests[0].init.headers["idempotency-key"], "read-key-1");

  command.resolve(response(200, httpReadResult(
    "reader-a",
    "mark_read",
    5,
    "read-key-1",
  )));
  assert.equal((await first).status, "success");
  assert.equal((await second).status, "success");
  assert.equal(await harness.readRecord(storageIdentity()), null);
  fixture.client.close();
});

test("never coalesces mark-read work across an explicit mark-unread boundary", async () => {
  const gates = [deferred(), deferred()];
  const fixture = await createFixture({
    lastReadSequence: 5,
    command: (_request, identity, requestNumber) => gates[requestNumber - 1].promise,
  });
  const unread = fixture.client.markUnread({ conversationId, fromSequence: 2 });
  const read = fixture.client.markRead({ conversationId, throughSequence: 5 });
  const coalescedRead = fixture.client.markRead({ conversationId, throughSequence: 5 });

  await eventually(async () => (await fixture.harness.readRecord(storageIdentity()))?.intents.length === 2);
  const persisted = await fixture.harness.readRecord(storageIdentity());
  assert.deepEqual(persisted.intents.map((intent) => intent.request.operation), [
    "mark_unread",
    "mark_read",
  ]);
  assert.deepEqual(persisted.intents.map((intent) => intent.request.idempotencyKey), [
    "read-key-1",
    "read-key-2",
  ]);
  assert.equal(persisted.intents[1].request.throughSequence, 5);

  gates[0].resolve(response(200, httpReadResult(
    "reader-a",
    "mark_unread",
    2,
    "read-key-1",
  )));
  assert.equal((await unread).status, "success");
  await eventually(() => fixture.requests.length === 2);
  const remaining = await fixture.harness.readRecord(storageIdentity());
  assert.equal(remaining.intents.length, 1);
  assert.equal(remaining.intents[0].request.idempotencyKey, "read-key-2");
  gates[1].resolve(response(200, httpReadResult(
    "reader-a",
    "mark_read",
    3,
    "read-key-2",
  )));
  assert.equal((await read).status, "success");
  assert.equal((await coalescedRead).status, "success");
  assert.equal(await fixture.harness.readRecord(storageIdentity()), null);
  fixture.client.close();
});

test("an exact canonical read-cursor event settles the matching persisted intent", async () => {
  const command = deferred();
  const fixture = await createFixture({ command: () => command.promise });
  const pending = fixture.client.markRead({ conversationId, throughSequence: 3 });
  await eventually(() => fixture.requests.length === 1);
  fixture.cache.applyDurableEvent(createReadCursorUpdatedEvent({
    eventId: "durable-read-settlement",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(3),
    result: readResult("reader-a", "mark_read", 3, 3),
  }));
  assert.equal((await pending).status, "success");
  assert.equal(await fixture.harness.readRecord(storageIdentity()), null);
  command.resolve(response(503, { error: { code: "LATE", message: "late" } }));
  fixture.client.close();
});

test("transient, rate-limited, server, malformed, and close outcomes retain intent", async (t) => {
  for (const [name, command, expected] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["rate limited", () => errorResponse(429, "RATE_LIMITED"), "transport"],
    ["server failure", () => errorResponse(503, "TEMPORARY"), "transport"],
    ["malformed success", () => response(200, { invalid: true }), "malformed_response"],
    ["mismatched correlation", (request) => response(200, httpReadResult(
      "reader-a",
      "mark_read",
      3,
      `${request.body.idempotencyKey}-other`,
      3,
    )), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ command });
      const result = await fixture.client.markRead({ conversationId, throughSequence: 3 });
      assert.equal(result.status, expected);
      assert.equal((await fixture.harness.readRecord(storageIdentity())).intents.length, 1);
      fixture.client.close();
    });
  }

  await t.test("client close", async () => {
    const command = deferred();
    const fixture = await createFixture({ command: () => command.promise });
    const pending = fixture.client.markRead({ conversationId, throughSequence: 3 });
    await eventually(() => fixture.requests.length === 1);
    fixture.client.close();
    assert.equal((await pending).status, "closed");
    assert.equal((await fixture.harness.readRecord(storageIdentity())).intents.length, 1);
    command.resolve(response(200, readResult("reader-a", "mark_read", 4, 3)));
  });
});

test("terminal outcomes remove the exact intent and restore only the stored baseline", async (t) => {
  for (const [name, status, code, expected] of [
    ["validation", 422, "INVALID_READ", "rejected"],
    ["authorization", 403, "FORBIDDEN", "rejected"],
    ["conflict", 409, "READ_CONFLICT", "conflict"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        lastReadSequence: 5,
        command: () => errorResponse(status, code),
      });
      const result = await fixture.client.markUnread({ conversationId, fromSequence: 2 });
      assert.equal(result.status, expected);
      assert.equal(await fixture.harness.readRecord(storageIdentity()), null);
      const readState = fixture.cache.getState().currentUser.readStates[conversationId];
      assert.equal(readState.lastReadSequence, 5);
      assert.equal(readState.manualUnreadFromSequence, undefined);
      fixture.client.close();
    });
  }

  await t.test("newer canonical state is not overwritten", async () => {
    const command = deferred();
    const fixture = await createFixture({
      lastReadSequence: 5,
      command: () => command.promise,
    });
    const pending = fixture.client.markUnread({ conversationId, fromSequence: 2 });
    await eventually(() => fixture.requests.length === 1);
    fixture.cache.applyDurableEvent(createReadCursorUpdatedEvent({
      eventId: "newer-canonical-before-terminal",
      protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId,
      occurredAt: at(8),
      result: readResult("reader-a", "mark_read", 8, 5),
    }));
    command.resolve(errorResponse(409, "READ_CONFLICT"));
    assert.equal((await pending).status, "conflict");
    assert.equal(await fixture.harness.readRecord(storageIdentity()), null);
    assert.equal(
      fixture.cache.getState().currentUser.readStates[conversationId].updatedAt,
      at(8),
    );
    fixture.client.close();
  });
});

test("storage write failure prevents both projection and dispatch", async () => {
  const harness = createStorageHarness();
  harness.setReplaceFailure(new Error("storage unavailable"));
  const fixture = await createFixture({ harness });
  const result = await fixture.client.markRead({ conversationId, throughSequence: 3 });
  assert.equal(result.status, "validation");
  assert.equal(fixture.cache.getState().currentUser.readStates[conversationId].lastReadSequence, 1);
  assert.equal(fixture.requests.length, 0);
  assert.equal(await harness.readRecord(storageIdentity()), null);
  fixture.client.close();
});

test("delayed old-identity storage and transport completions cannot alter the active identity", async () => {
  const storageGate = deferred();
  const oldTransport = deferred();
  const harness = createStorageHarness();
  const identityRef = { current: storageIdentity() };
  const fixture = await createFixture({
    harness,
    identityRef,
    command: () => oldTransport.promise,
  });
  harness.setReplaceGate(storageGate);
  const oldPending = fixture.client.markRead({ conversationId, throughSequence: 3 });
  await eventually(() => harness.readWrites().length === 1);
  fixture.client.close();
  assert.equal((await oldPending).status, "closed");

  identityRef.current = storageIdentity("reader-b", "device-b");
  assert.equal((await fixture.client.start()).state, "ready");
  fixture.cache.setIdentity(cacheIdentity("reader-b", "session-b"));
  hydrateCache(fixture.cache, "reader-b", 4);
  const before = fixture.cache.getState().currentUser.readStates[conversationId];
  storageGate.resolve();
  oldTransport.resolve(response(200, readResult("reader-a", "mark_read", 9, 3)));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.cache.getState().identity.userId, "reader-b");
  assert.equal(fixture.cache.getState().currentUser.readStates[conversationId], before);
  assert.equal(await harness.readRecord(storageIdentity("reader-b", "device-b")), null);
  fixture.client.close();
});

test("delayed old-identity transport completion leaves a newer persisted record untouched", async () => {
  const oldTransport = deferred();
  const harness = createStorageHarness();
  const identityRef = { current: storageIdentity() };
  const fixture = await createFixture({
    harness,
    identityRef,
    command: () => oldTransport.promise,
  });
  const oldPending = fixture.client.markRead({ conversationId, throughSequence: 3 });
  await eventually(() => fixture.requests.length === 1);
  fixture.client.close();
  assert.equal((await oldPending).status, "closed");

  const nextIdentity = storageIdentity("reader-b", "device-b");
  const retained = createApplicationChatQueuedReadCursorIntent(
    {
      operation: "mark_read",
      conversationId,
      throughSequence: 4,
      idempotencyKey: "reader-b-retained",
    },
    {
      conversationId,
      userId: "reader-b",
      lastReadSequence: 1,
      updatedAt: at(0),
    },
    { enqueueOrder: 1, enqueuedAt: at(1) },
  );
  await harness.storage.replace(
    createApplicationChatQueuedReadCursorIntentsRecord(nextIdentity, [retained]),
  );
  identityRef.current = nextIdentity;
  assert.equal((await fixture.client.start()).state, "ready");
  fixture.cache.setIdentity(cacheIdentity("reader-b", "session-b"));
  hydrateCache(fixture.cache, "reader-b", 4);

  oldTransport.resolve(response(200, readResult("reader-a", "mark_read", 9, 3)));
  await new Promise((resolve) => setImmediate(resolve));
  const activeRecord = await harness.readRecord(nextIdentity);
  assert.equal(activeRecord.intents.length, 1);
  assert.equal(activeRecord.intents[0].request.idempotencyKey, "reader-b-retained");
  assert.equal(fixture.cache.getState().identity.userId, "reader-b");
  fixture.client.close();
});
