import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatQueuedReadCursorIntent,
  createApplicationChatQueuedReadCursorIntentsRecord,
  createApplicationChatStorage,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { createChatReadStateRuntime } from "../dist/client/read-state.js";
import {
  CHAT_PROTOCOL_VERSION,
  createReadCursorUpdatedEvent,
} from "../dist/index.js";

const tenantId = "tenant-atomic-read";
const userId = "reader-atomic";
const scope = Object.freeze({
  identity: Object.freeze({ tenantId, userId, deviceId: "device-atomic" }),
  generation: 1,
});
const firstConversationId = "conversation-atomic-first";
const secondConversationId = "conversation-atomic-second";
const at = (second) =>
  `2032-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
};
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
const recordKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;

function conversationSummary(conversationId) {
  return {
    id: conversationId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: conversationId,
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
    currentReadState: readState(conversationId, 1, 0),
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: at(0),
    },
  };
}

function readState(conversationId, lastReadSequence, second) {
  return {
    conversationId,
    userId,
    lastReadSequence,
    updatedAt: at(second),
  };
}

function createCache() {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: "session-atomic",
  });
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [
      conversationSummary(firstConversationId),
      conversationSummary(secondConversationId),
    ],
    page: {},
    _meta: metadata,
  });
  return cache;
}

function createSharedAtomicAdapter() {
  const rows = new Map();
  const successfulExchanges = [];
  let readBarrier;
  let quarantineGate;
  const adapter = {
    async read(identity, kind) {
      const encoded = rows.get(recordKey(identity, kind)) ?? null;
      const barrier = kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents
        ? readBarrier
        : undefined;
      if (barrier !== undefined && barrier.remaining > 0) {
        barrier.remaining -= 1;
        if (barrier.remaining === 0) {
          readBarrier = undefined;
          barrier.reached.resolve();
        }
        await barrier.release.promise;
      }
      return encoded;
    },
    async replace(identity, kind, encoded) {
      rows.set(recordKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      rows.delete(recordKey(identity, kind));
    },
    async compareExchange(identity, kind, expected, replacement) {
      const gate = quarantineGate;
      if (gate !== undefined && expected === gate.corruptValue) {
        quarantineGate = undefined;
        gate.reached.resolve();
        await gate.release.promise;
      }
      const key = recordKey(identity, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      successfulExchanges.push({ expected, replacement });
      return true;
    },
    async clearForLogout(identity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(recordKey(identity, kind));
      }
    },
  };
  return {
    adapter,
    rows,
    successfulExchanges,
    armReadBarrier(count = 2) {
      const reached = deferred();
      const release = deferred();
      readBarrier = { remaining: count, reached, release };
      return { reached: reached.promise, release: release.resolve };
    },
    armQuarantineGate(corruptValue) {
      const reached = deferred();
      const release = deferred();
      quarantineGate = { corruptValue, reached, release };
      return { reached: reached.promise, release: release.resolve };
    },
  };
}

function createRuntime(storage, keyPrefix) {
  const cache = createCache();
  const requests = [];
  const persisted = [];
  const diagnostics = [];
  let generatedKey = 0;
  const runtime = createChatReadStateRuntime({
    cache,
    async dispatch(_descriptor, input) {
      requests.push(input);
      return new Promise(() => {});
    },
    generateIdempotencyKey: () => `${keyPrefix}-${++generatedKey}`,
    persistence: {
      storage,
      getActiveScope: () => scope,
      isActiveScope: (candidate) =>
        candidate.generation === scope.generation &&
        candidate.identity.tenantId === scope.identity.tenantId &&
        candidate.identity.userId === scope.identity.userId &&
        candidate.identity.deviceId === scope.identity.deviceId,
      now: () => Date.parse(at(1)),
      onPersistedIntent: (command, idempotencyKey) => {
        persisted.push({ command, idempotencyKey });
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  return { cache, diagnostics, persisted, requests, runtime };
}

async function readIntents(storage) {
  return storage.read(
    scope.identity,
    ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  );
}

test("two runtimes atomically retain simultaneous intents for different conversations", async () => {
  const shared = createSharedAtomicAdapter();
  const firstStorage = createApplicationChatStorage(shared.adapter);
  const secondStorage = createApplicationChatStorage(shared.adapter);
  const first = createRuntime(firstStorage, "first");
  const second = createRuntime(secondStorage, "second");
  const barrier = shared.armReadBarrier();

  const firstResult = first.runtime.markRead({
    conversationId: firstConversationId,
    throughSequence: 3,
  });
  const secondResult = second.runtime.markRead({
    conversationId: secondConversationId,
    throughSequence: 4,
  });
  await barrier.reached;
  barrier.release();

  await eventually(async () => (await readIntents(firstStorage))?.intents.length === 2);
  const record = await readIntents(firstStorage);
  assert.deepEqual(record.intents.map((intent) => intent.request.conversationId), [
    firstConversationId,
    secondConversationId,
  ]);
  assert.deepEqual(record.intents.map((intent) => intent.enqueueOrder), [1, 2]);
  first.runtime.closeActive();
  second.runtime.closeActive();
  assert.equal((await firstResult).status, "closed");
  assert.equal((await secondResult).status, "closed");
});

test("two runtimes coalesce same-conversation commits onto the first committed correlation", async () => {
  const shared = createSharedAtomicAdapter();
  const firstStorage = createApplicationChatStorage(shared.adapter);
  const secondStorage = createApplicationChatStorage(shared.adapter);
  const first = createRuntime(firstStorage, "first");
  const second = createRuntime(secondStorage, "second");
  const barrier = shared.armReadBarrier();

  const firstResult = first.runtime.markRead({
    conversationId: firstConversationId,
    throughSequence: 3,
  });
  const secondResult = second.runtime.markRead({
    conversationId: firstConversationId,
    throughSequence: 5,
  });
  await barrier.reached;
  barrier.release();

  await eventually(() => first.persisted.length === 1 && second.persisted.length === 1);
  const record = await readIntents(firstStorage);
  assert.equal(record.intents.length, 1);
  assert.equal(record.intents[0].enqueueOrder, 1);
  assert.equal(record.intents[0].request.throughSequence, 5);
  assert.equal(record.intents[0].request.idempotencyKey, "first-1");
  assert.deepEqual(first.persisted, [{
    command: "conversation.mark_read",
    idempotencyKey: "first-1",
  }]);
  assert.deepEqual(second.persisted, first.persisted);
  first.runtime.closeActive();
  second.runtime.closeActive();
  assert.equal((await firstResult).status, "closed");
  assert.equal((await secondResult).status, "closed");
});

test("canonical settlement racing another runtime preserves the unrelated committed intent", async () => {
  const shared = createSharedAtomicAdapter();
  const firstStorage = createApplicationChatStorage(shared.adapter);
  const secondStorage = createApplicationChatStorage(shared.adapter);
  const first = createRuntime(firstStorage, "first");
  const second = createRuntime(secondStorage, "second");
  const settled = first.runtime.markRead({
    conversationId: firstConversationId,
    throughSequence: 3,
  });
  await eventually(async () => (await readIntents(firstStorage))?.intents.length === 1);

  const barrier = shared.armReadBarrier();
  first.runtime.handleCanonicalEvent(createReadCursorUpdatedEvent({
    eventId: "atomic-read-settlement",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(3),
    result: {
      operation: "mark_read",
      conversationId: firstConversationId,
      readState: readState(firstConversationId, 3, 3),
      latestSequence: 5,
      unreadCount: 2,
    },
  }));
  const retained = second.runtime.markRead({
    conversationId: secondConversationId,
    throughSequence: 4,
  });
  await barrier.reached;
  barrier.release();

  assert.equal((await settled).status, "success");
  await eventually(async () => {
    const record = await readIntents(firstStorage);
    return record?.intents.length === 1 &&
      record.intents[0].request.conversationId === secondConversationId;
  });
  const record = await readIntents(firstStorage);
  assert.equal(record.intents[0].request.idempotencyKey, "second-1");
  first.runtime.closeActive();
  second.runtime.closeActive();
  assert.equal((await retained).status, "closed");
});

test("settlement rejects reuse of a correlation by a different stored request", async () => {
  const shared = createSharedAtomicAdapter();
  const firstStorage = createApplicationChatStorage(shared.adapter);
  const secondStorage = createApplicationChatStorage(shared.adapter);
  const first = createRuntime(firstStorage, "first");
  const pending = first.runtime.markRead({
    conversationId: firstConversationId,
    throughSequence: 3,
  });
  await eventually(async () => (await readIntents(firstStorage))?.intents.length === 1);

  const reused = createApplicationChatQueuedReadCursorIntent(
    {
      operation: "mark_read",
      conversationId: firstConversationId,
      throughSequence: 5,
      idempotencyKey: "first-1",
    },
    readState(firstConversationId, 1, 0),
    { enqueueOrder: 1, enqueuedAt: at(1) },
  );
  await secondStorage.replace(createApplicationChatQueuedReadCursorIntentsRecord(
    scope.identity,
    [reused],
  ));
  const exchangeCountBeforeSettlement = shared.successfulExchanges.length;
  first.runtime.handleCanonicalEvent(createReadCursorUpdatedEvent({
    eventId: "atomic-read-mismatched-reuse",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(3),
    result: {
      operation: "mark_read",
      conversationId: firstConversationId,
      readState: readState(firstConversationId, 3, 3),
      latestSequence: 5,
      unreadCount: 2,
    },
  }));
  await eventually(() =>
    shared.successfulExchanges.length > exchangeCountBeforeSettlement);

  const record = await readIntents(firstStorage);
  assert.equal(record.intents.length, 1);
  assert.equal(record.intents[0].request.throughSequence, 5);
  first.runtime.closeActive();
  assert.equal((await pending).status, "closed");
});

test("activation cannot quarantine a valid replacement installed after a corrupt read", async () => {
  const shared = createSharedAtomicAdapter();
  const firstStorage = createApplicationChatStorage(shared.adapter);
  const secondStorage = createApplicationChatStorage(shared.adapter);
  const first = createRuntime(firstStorage, "first");
  const key = recordKey(
    scope.identity,
    ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  );
  const corruptValue = "{not-json";
  shared.rows.set(key, corruptValue);
  const quarantine = shared.armQuarantineGate(corruptValue);
  const activation = first.runtime.activateRetained(scope, [
    readState(firstConversationId, 1, 0),
  ]);
  await quarantine.reached;

  const replacementIntent = createApplicationChatQueuedReadCursorIntent(
    {
      operation: "mark_read",
      conversationId: secondConversationId,
      throughSequence: 4,
      idempotencyKey: "replacement-1",
    },
    readState(secondConversationId, 1, 0),
    { enqueueOrder: 1, enqueuedAt: at(1) },
  );
  await secondStorage.replace(createApplicationChatQueuedReadCursorIntentsRecord(
    scope.identity,
    [replacementIntent],
  ));
  quarantine.release();
  await activation;

  const record = await readIntents(secondStorage);
  assert.equal(record.intents.length, 1);
  assert.equal(record.intents[0].request.idempotencyKey, "replacement-1");
  assert.deepEqual(first.diagnostics.map(({ code }) => code), ["read_intents_rejected"]);
  first.runtime.closeActive();
});
