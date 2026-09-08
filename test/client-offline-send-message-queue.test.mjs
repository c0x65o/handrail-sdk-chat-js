import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS,
  OfflineSendMessageQueueError,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatStorage,
  createOfflineSendMessageQueue,
  encodeApplicationChatStorageRecord,
} from "../dist/client/index.js";

const identityA = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  deviceId: "device-a",
});
const identityB = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  deviceId: "device-b",
});
const identityC = Object.freeze({
  tenantId: "tenant-b",
  userId: "user-b",
  deviceId: "device-c",
});

const request = (suffix, overrides = {}) => ({
  operation: "send",
  conversationId: "conversation-1",
  content: { format: "plain", text: `message ${suffix}` },
  clientMessageId: `client-${suffix}`,
  idempotencyKey: `idempotency-${suffix}`,
  ...overrides,
});

const identityKey = (identity, kind) =>
  `${identity.tenantId}\u0000${identity.userId}\u0000${identity.deviceId}\u0000${kind}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAdapter() {
  const records = new Map();
  const calls = [];
  const failures = { read: undefined, replace: undefined, remove: undefined };
  const gates = { read: undefined, replace: undefined, remove: undefined };
  const adapter = {
    records,
    calls,
    failures,
    gates,
    async read(identity, kind) {
      calls.push({ operation: "read", identity, kind });
      if (gates.read !== undefined) await gates.read.promise;
      if (failures.read !== undefined) throw failures.read;
      return records.get(identityKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encodedRecord) {
      calls.push({ operation: "replace", identity, kind, encodedRecord });
      if (gates.replace !== undefined) await gates.replace.promise;
      if (failures.replace !== undefined) throw failures.replace;
      records.set(identityKey(identity, kind), encodedRecord);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity, kind });
      if (gates.remove !== undefined) await gates.remove.promise;
      if (failures.remove !== undefined) throw failures.remove;
      records.delete(identityKey(identity, kind));
    },
    async clearForLogout(identity) {
      calls.push({ operation: "clearForLogout", identity });
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        records.delete(identityKey(identity, kind));
      }
    },
  };
  return adapter;
}

function createAtomicAdapter() {
  const adapter = createAdapter();
  adapter.failures.compareExchange = undefined;
  adapter.gates.compareExchange = undefined;
  adapter.compareExchange = async (
    identity,
    kind,
    expectedEncodedRecord,
    replacementEncodedRecord,
  ) => {
    adapter.calls.push({
      operation: "compareExchange",
      identity,
      kind,
      expectedEncodedRecord,
      replacementEncodedRecord,
    });
    if (adapter.gates.compareExchange !== undefined) {
      await adapter.gates.compareExchange.promise;
    }
    if (adapter.failures.compareExchange !== undefined) {
      throw adapter.failures.compareExchange;
    }
    const key = identityKey(identity, kind);
    const current = adapter.records.get(key) ?? null;
    if (current !== expectedEncodedRecord) return false;
    if (replacementEncodedRecord === null) adapter.records.delete(key);
    else adapter.records.set(key, replacementEncodedRecord);
    return true;
  };
  return adapter;
}

function createQuarantineReplacementRaceAdapter(
  malformedEncodedRecord,
  replacementEncodedRecord,
) {
  const adapter = createAtomicAdapter();
  const compareExchange = adapter.compareExchange;
  let installedReplacement = false;
  adapter.compareExchange = async (
    identity,
    kind,
    expectedEncodedRecord,
    nextEncodedRecord,
  ) => {
    const exchanged = await compareExchange(
      identity,
      kind,
      expectedEncodedRecord,
      nextEncodedRecord,
    );
    if (
      exchanged &&
      !installedReplacement &&
      expectedEncodedRecord === malformedEncodedRecord &&
      nextEncodedRecord === null
    ) {
      installedReplacement = true;
      adapter.records.set(identityKey(identity, kind), replacementEncodedRecord);
    }
    return exchanged;
  };
  return adapter;
}

function createFixture(options = {}) {
  const adapter = options.adapter ?? createAdapter();
  const storage = createApplicationChatStorage(adapter);
  let clockTick = 0;
  const queue = createOfflineSendMessageQueue({
    storage,
    ...(options.initialIdentity === undefined
      ? {}
      : { initialIdentity: options.initialIdentity }),
    clock: options.clock ?? (() =>
      new Date(`2026-09-02T12:00:${String(++clockTick).padStart(2, "0")}.000Z`)),
  });
  return { adapter, storage, queue };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForOperationCount(adapter, operation, expectedCount) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (adapter.calls.filter((call) => call.operation === operation).length >= expectedCount) {
      return;
    }
    await nextTurn();
  }
  assert.fail(`Timed out waiting for ${expectedCount} ${operation} calls`);
}

test("validates the complete request before writes and persists before publishing", async () => {
  const { adapter, queue } = createFixture();
  await queue.activate(identityA);
  const observed = [];
  queue.subscribe((state) => observed.push(state));

  await assert.rejects(() => queue.enqueue({
    ...request("invalid"),
    accessToken: "must-not-be-retained",
  }));
  assert.equal(adapter.calls.filter((call) => call.operation !== "read").length, 0);
  assert.equal(observed.length, 1);

  adapter.gates.replace = deferred();
  const pending = queue.enqueue(request("durable", {
    content: {
      format: "markdown",
      text: "hello **durable**",
      mentions: [],
      attachments: [],
      blocks: [{ type: "paragraph", data: { text: "complete request" } }],
    },
  }));
  await nextTurn();
  assert.equal(adapter.calls.at(-1).operation, "replace");
  assert.equal(queue.getState().intents.length, 0);
  assert.equal(observed.length, 1);

  adapter.gates.replace.resolve();
  const intent = await pending;
  assert.equal(queue.getState().intents[0], intent);
  assert.equal(observed.length, 2);
  assert.deepEqual(intent.request.content, {
    format: "markdown",
    text: "hello **durable**",
    mentions: [],
    attachments: [],
    blocks: [{ type: "paragraph", data: { text: "complete request" } }],
  });
});

test("publishes an atomic enqueue only after compare/exchange commits", async () => {
  const adapter = createAtomicAdapter();
  const { queue } = createFixture({ adapter });
  await queue.activate(identityA);
  const observed = [];
  queue.subscribe((state) => observed.push(state));

  adapter.gates.compareExchange = deferred();
  const pending = queue.enqueue(request("atomic-durable"));
  await waitForOperationCount(adapter, "compareExchange", 1);
  assert.equal(queue.getState().intents.length, 0);
  assert.equal(observed.length, 1);

  adapter.gates.compareExchange.resolve();
  const intent = await pending;
  assert.equal(queue.getState().intents[0], intent);
  assert.equal(observed.length, 2);
});

test("survives restart with stable FIFO metadata and correlation identities", async () => {
  const adapter = createAdapter();
  const first = createFixture({ adapter });
  await first.queue.activate(identityA);
  const firstIntent = await first.queue.enqueue(request("a"));
  const secondIntent = await first.queue.enqueue(request("b"));
  await first.queue.close();

  const restarted = createFixture({ adapter });
  const state = await restarted.queue.activate(identityA);
  assert.deepEqual(
    state.intents.map((intent) => ({
      enqueueOrder: intent.enqueueOrder,
      enqueuedAt: intent.enqueuedAt,
      clientMessageId: intent.clientMessageId,
      idempotencyKey: intent.idempotencyKey,
      request: intent.request,
    })),
    [firstIntent, secondIntent].map((intent) => ({
      enqueueOrder: intent.enqueueOrder,
      enqueuedAt: intent.enqueuedAt,
      clientMessageId: intent.clientMessageId,
      idempotencyKey: intent.idempotencyKey,
      request: intent.request,
    })),
  );
  assert.deepEqual(state.intents.map((intent) => intent.enqueueOrder), [1, 2]);
});

test("reply requests detach before writes and survive recreated storage in exact identity scopes", async () => {
  const adapter = createAtomicAdapter();
  const first = createFixture({ adapter });
  await first.queue.activate(identityA);
  const authored = request("reply", {
    replyTo: { messageId: "source-a", notifyAuthor: false },
    content: { format: "plain", text: "Friday", blocks: [{ type: "paragraph", data: { nested: ["original"] } }] },
  });
  const expected = structuredClone(authored);
  const pending = first.queue.enqueue(authored);
  authored.replyTo.messageId = "mutated-source";
  authored.replyTo.notifyAuthor = true;
  authored.conversationId = "mutated-destination";
  authored.content.blocks[0].data.nested[0] = "mutated-content";
  const intent = await pending;
  assert.deepEqual(intent.request, expected);
  assert.ok(Object.isFrozen(intent.request.replyTo));
  assert.ok(Object.isFrozen(intent.request.content.blocks[0].data.nested));
  assert.notEqual(intent.request.replyTo, authored.replyTo);
  const threadReply = request("thread-reply", {
    conversationId: "existing-thread",
    replyTo: { messageId: "thread-source", notifyAuthor: true },
  });
  await first.queue.enqueue(threadReply);
  await first.queue.enqueue(request("legacy"));
  await first.queue.close();

  const restarted = createFixture({ adapter });
  const state = await restarted.queue.activate(identityA);
  assert.deepEqual(state.intents.map(({ request }) => request), [expected, threadReply, request("legacy")]);
  assert.deepEqual(state.intents.map(({ enqueueOrder }) => enqueueOrder), [1, 2, 3]);
  assert.ok(Object.isFrozen(state.intents[0].request.replyTo));
  assert.throws(() => { state.intents[0].request.replyTo.notifyAuthor = true; }, TypeError);
  for (const scope of [
    { ...identityA, tenantId: "other-tenant" },
    { ...identityA, userId: "other-user" },
    { ...identityA, deviceId: "other-device" },
  ]) {
    assert.deepEqual((await restarted.queue.activate(scope)).intents, []);
    await restarted.queue.enqueue(request("reply", { replyTo: { messageId: "sibling-source", notifyAuthor: true } }));
  }
  assert.deepEqual((await restarted.queue.activate(identityA)).intents, state.intents);
  await restarted.queue.close();
});

test("reload observes writes and removals from another queue instance", async () => {
  const adapter = createAdapter();
  const first = createFixture({ adapter });
  const second = createFixture({ adapter });
  await Promise.all([
    first.queue.activate(identityA),
    second.queue.activate(identityA),
  ]);

  const intent = await first.queue.enqueue(request("shared"));
  assert.equal(second.queue.getState().intents.length, 0);
  assert.deepEqual((await second.queue.reload()).intents, [intent]);

  await first.queue.cancel(intent.clientMessageId);
  assert.equal(second.queue.getState().intents.length, 1);
  assert.equal((await second.queue.reload()).intents.length, 0);
});

test("concurrent distinct enqueues from two queues both survive in FIFO order", async () => {
  const adapter = createAtomicAdapter();
  const first = createFixture({ adapter });
  const second = createFixture({ adapter });
  await Promise.all([
    first.queue.activate(identityA),
    second.queue.activate(identityA),
  ]);

  adapter.gates.compareExchange = deferred();
  const requestA = request("concurrent-a", { replyTo: { messageId: "source-a", notifyAuthor: false } });
  const requestB = request("concurrent-b", { replyTo: { messageId: "source-b", notifyAuthor: true } });
  const enqueueA = first.queue.enqueue(requestA);
  const enqueueB = second.queue.enqueue(requestB);
  await waitForOperationCount(adapter, "compareExchange", 2);
  assert.equal(first.queue.getState().intents.length, 0);
  assert.equal(second.queue.getState().intents.length, 0);

  adapter.gates.compareExchange.resolve();
  const [intentA, intentB] = await Promise.all([enqueueA, enqueueB]);
  const committed = await first.storage.read(
    identityA,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  );
  assert.deepEqual(committed.intents.map(({ request }) => request), [requestA, requestB]);
  assert.deepEqual(
    committed.intents.map((intent) => [
      intent.request.clientMessageId,
      intent.enqueueOrder,
    ]),
    [
      [intentA.clientMessageId, 1],
      [intentB.clientMessageId, 2],
    ],
  );
  assert.deepEqual(
    second.queue.getState().intents.map((intent) => intent.clientMessageId),
    [intentA.clientMessageId, intentB.clientMessageId],
  );
});

test("settling one intent cannot erase another queue's concurrent enqueue", async () => {
  const adapter = createAtomicAdapter();
  const first = createFixture({ adapter });
  const second = createFixture({ adapter });
  await Promise.all([
    first.queue.activate(identityA),
    second.queue.activate(identityA),
  ]);
  const settled = await first.queue.enqueue(request("settled"));
  await second.queue.reload();

  const priorCompareCount = adapter.calls.filter(
    (call) => call.operation === "compareExchange",
  ).length;
  adapter.gates.compareExchange = deferred();
  const enqueue = second.queue.enqueue(request("survivor"));
  await waitForOperationCount(adapter, "compareExchange", priorCompareCount + 1);
  const cancel = first.queue.cancel(settled.clientMessageId);
  await waitForOperationCount(adapter, "compareExchange", priorCompareCount + 2);
  adapter.gates.compareExchange.resolve();

  const [removed, survivor] = await Promise.all([cancel, enqueue]);
  assert.equal(removed, true);
  const committed = await first.storage.read(
    identityA,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  );
  assert.deepEqual(
    committed.intents.map((intent) => intent.request.clientMessageId),
    [survivor.clientMessageId],
  );
  assert.deepEqual(
    first.queue.getState().intents.map((intent) => intent.clientMessageId),
    [survivor.clientMessageId],
  );
});

test("an absent settlement synchronizes stale local state to committed storage", async () => {
  const adapter = createAtomicAdapter();
  const first = createFixture({ adapter });
  const second = createFixture({ adapter });
  await Promise.all([
    first.queue.activate(identityA),
    second.queue.activate(identityA),
  ]);
  const durable = await first.queue.enqueue(request("durable-elsewhere"));

  assert.equal(await second.queue.cancel("client-absent"), false);
  assert.deepEqual(second.queue.getState().intents, [durable]);
});

test("concurrent duplicate clientMessageIds produce one durable winner", async () => {
  const adapter = createAtomicAdapter();
  const first = createFixture({ adapter });
  const second = createFixture({ adapter });
  await Promise.all([
    first.queue.activate(identityA),
    second.queue.activate(identityA),
  ]);

  adapter.gates.compareExchange = deferred();
  const attempts = [
    first.queue.enqueue(request("duplicate-client-a", {
      clientMessageId: "shared-client-message-id",
    })),
    second.queue.enqueue(request("duplicate-client-b", {
      clientMessageId: "shared-client-message-id",
    })),
  ];
  await waitForOperationCount(adapter, "compareExchange", 2);
  adapter.gates.compareExchange.resolve();

  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection.reason instanceof OfflineSendMessageQueueError);
  assert.equal(rejection.reason.code, "duplicate_client_message_id");
  const committed = await first.storage.read(
    identityA,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  );
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].request.clientMessageId, "shared-client-message-id");
});

test("concurrent duplicate idempotency keys produce one durable winner", async () => {
  const adapter = createAtomicAdapter();
  const first = createFixture({ adapter });
  const second = createFixture({ adapter });
  await Promise.all([
    first.queue.activate(identityA),
    second.queue.activate(identityA),
  ]);

  adapter.gates.compareExchange = deferred();
  const attempts = [
    first.queue.enqueue(request("duplicate-key-a", {
      idempotencyKey: "shared-idempotency-key",
    })),
    second.queue.enqueue(request("duplicate-key-b", {
      idempotencyKey: "shared-idempotency-key",
    })),
  ];
  await waitForOperationCount(adapter, "compareExchange", 2);
  adapter.gates.compareExchange.resolve();

  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection.reason instanceof OfflineSendMessageQueueError);
  assert.equal(rejection.reason.code, "duplicate_idempotency_key");
  const committed = await first.storage.read(
    identityA,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  );
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].request.idempotencyKey, "shared-idempotency-key");
});

test("rejects duplicate clientMessageId and idempotencyKey without writing", async () => {
  const { adapter, queue } = createFixture();
  await queue.activate(identityA);
  await queue.enqueue(request("original"));
  const writes = adapter.calls.filter((call) => call.operation === "replace").length;

  await assert.rejects(
    () => queue.enqueue(request("other", { clientMessageId: "client-original" })),
    (error) => error instanceof OfflineSendMessageQueueError &&
      error.code === "duplicate_client_message_id",
  );
  await assert.rejects(
    () => queue.enqueue(request("other", { idempotencyKey: "idempotency-original" })),
    (error) => error instanceof OfflineSendMessageQueueError &&
      error.code === "duplicate_idempotency_key",
  );
  assert.equal(
    adapter.calls.filter((call) => call.operation === "replace").length,
    writes,
  );
  assert.equal(queue.getState().intents.length, 1);
});

test("enforces queue count and aggregate serialized-record bounds", async () => {
  const countAdapter = createAdapter();
  const countStorage = createApplicationChatStorage(countAdapter);
  const countIntents = Array.from(
    { length: MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS },
    (_, index) => createApplicationChatQueuedSendMessageIntent(
      request(`count-${index}`),
      {
        enqueueOrder: index + 1,
        enqueuedAt: "2026-09-02T12:00:00.000Z",
      },
    ),
  );
  await countStorage.replace(createApplicationChatQueuedSendMessageIntentsRecord(
    identityA,
    countIntents,
  ));
  const countQueue = createOfflineSendMessageQueue({ storage: countStorage });
  await countQueue.activate(identityA);
  const countState = countQueue.getState();
  await assert.rejects(
    () => countQueue.enqueue(request("over-count")),
    /at most 1000 entries/,
  );
  assert.equal(countQueue.getState(), countState);

  const largeIntents = [];
  let lastValidRecord;
  let rejectedSuffix;
  for (let index = 0; index < 100; index += 1) {
    const intent = createApplicationChatQueuedSendMessageIntent(
      request(`large-${index}`, {
        content: { format: "plain", text: "x".repeat(100_000) },
      }),
      {
        enqueueOrder: index + 1,
        enqueuedAt: "2026-09-02T12:00:00.000Z",
      },
    );
    largeIntents.push(intent);
    try {
      lastValidRecord = createApplicationChatQueuedSendMessageIntentsRecord(
        identityB,
        largeIntents,
      );
    } catch (error) {
      assert.match(error.message, /record exceeds/);
      rejectedSuffix = index;
      largeIntents.pop();
      break;
    }
  }
  assert.ok(lastValidRecord);
  assert.ok(rejectedSuffix !== undefined);
  const sizeAdapter = createAdapter();
  sizeAdapter.records.set(
    identityKey(identityB, ApplicationChatStorageRecordKind.queuedSendMessageIntents),
    encodeApplicationChatStorageRecord(lastValidRecord),
  );
  const sizeQueue = createOfflineSendMessageQueue({
    storage: createApplicationChatStorage(sizeAdapter),
  });
  await sizeQueue.activate(identityB);
  const sizeState = sizeQueue.getState();
  await assert.rejects(
    () => sizeQueue.enqueue(request(`large-${rejectedSuffix}`, {
      content: { format: "plain", text: "x".repeat(100_000) },
    })),
    /record exceeds/,
  );
  assert.equal(sizeQueue.getState(), sizeState);
});

test("quarantines only the corrupt identity queue after narrow removal succeeds", async () => {
  const adapter = createAdapter();
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const sibling = createApplicationChatQueuedSendMessageIntentsRecord(identityB, [
    createApplicationChatQueuedSendMessageIntent(request("sibling"), {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-02T12:00:00.000Z",
    }),
  ]);
  adapter.records.set(identityKey(identityA, kind), "{corrupt");
  adapter.records.set(identityKey(identityB, kind), encodeApplicationChatStorageRecord(sibling));
  adapter.records.set(
    identityKey(identityA, ApplicationChatStorageRecordKind.normalizedSnapshot),
    "unrelated-record",
  );

  const queue = createOfflineSendMessageQueue({
    storage: createApplicationChatStorage(adapter),
  });
  const state = await queue.activate(identityA);
  assert.equal(state.isHydrated, true);
  assert.deepEqual(state.intents, []);
  assert.equal(adapter.records.has(identityKey(identityA, kind)), false);
  assert.equal(
    adapter.records.get(identityKey(identityB, kind)),
    encodeApplicationChatStorageRecord(sibling),
  );
  assert.equal(
    adapter.records.get(
      identityKey(identityA, ApplicationChatStorageRecordKind.normalizedSnapshot),
    ),
    "unrelated-record",
  );
  assert.deepEqual(
    adapter.calls.filter((call) => call.operation === "remove").map((call) => ({
      identity: call.identity,
      kind: call.kind,
    })),
    [
      { identity: identityA, kind },
    ],
  );
});

test("does not delete a valid queue installed after atomic quarantine", async () => {
  const kind = ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  const malformedEncodedRecord = "{corrupt";
  const replacement = createApplicationChatQueuedSendMessageIntentsRecord(identityA, [
    createApplicationChatQueuedSendMessageIntent(request("replacement"), {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-02T12:00:00.000Z",
    }),
  ]);
  const replacementEncodedRecord = encodeApplicationChatStorageRecord(replacement);
  const sibling = createApplicationChatQueuedSendMessageIntentsRecord(identityB, [
    createApplicationChatQueuedSendMessageIntent(request("sibling-race"), {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-02T12:00:00.000Z",
    }),
  ]);
  const siblingEncodedRecord = encodeApplicationChatStorageRecord(sibling);
  const adapter = createQuarantineReplacementRaceAdapter(
    malformedEncodedRecord,
    replacementEncodedRecord,
  );
  adapter.records.set(identityKey(identityA, kind), malformedEncodedRecord);
  adapter.records.set(identityKey(identityB, kind), siblingEncodedRecord);
  adapter.records.set(
    identityKey(identityA, ApplicationChatStorageRecordKind.normalizedSnapshot),
    "unrelated-record",
  );

  const queue = createOfflineSendMessageQueue({
    storage: createApplicationChatStorage(adapter),
  });
  const activated = await queue.activate(identityA);
  assert.equal(activated.isHydrated, true);
  assert.deepEqual(activated.intents, []);
  assert.equal(adapter.records.get(identityKey(identityA, kind)), replacementEncodedRecord);
  assert.equal(adapter.calls.filter((call) => call.operation === "remove").length, 0);
  assert.deepEqual(
    adapter.calls.filter((call) => call.operation === "compareExchange").map((call) => ({
      identity: call.identity,
      kind: call.kind,
      expectedEncodedRecord: call.expectedEncodedRecord,
      replacementEncodedRecord: call.replacementEncodedRecord,
    })),
    [{
      identity: identityA,
      kind,
      expectedEncodedRecord: malformedEncodedRecord,
      replacementEncodedRecord: null,
    }],
  );

  const reloaded = await queue.reload();
  assert.deepEqual(
    reloaded.intents.map((intent) => intent.clientMessageId),
    ["client-replacement"],
  );
  assert.equal(adapter.records.get(identityKey(identityB, kind)), siblingEncodedRecord);
  assert.equal(
    adapter.records.get(
      identityKey(identityA, ApplicationChatStorageRecordKind.normalizedSnapshot),
    ),
    "unrelated-record",
  );
});

test("switches exact tenant/user/device identities without queue leakage", async () => {
  const { queue } = createFixture();
  await queue.activate(identityA);
  await queue.enqueue(request("a"));

  const deviceState = await queue.activate(identityB);
  assert.deepEqual(deviceState.intents, []);
  await queue.enqueue(request("b"));

  const tenantState = await queue.activate(identityC);
  assert.deepEqual(tenantState.intents, []);
  await queue.enqueue(request("c"));

  assert.deepEqual(
    (await queue.activate(identityA)).intents.map((intent) => intent.clientMessageId),
    ["client-a"],
  );
  assert.deepEqual(
    (await queue.activate(identityB)).intents.map((intent) => intent.clientMessageId),
    ["client-b"],
  );
  assert.deepEqual(
    (await queue.activate(identityC)).intents.map((intent) => intent.clientMessageId),
    ["client-c"],
  );
});

test("serializes concurrent enqueue and cancel calls in invocation order", async () => {
  const { adapter, queue } = createFixture({ initialIdentity: identityA });
  adapter.gates.replace = deferred();
  const enqueueA = queue.enqueue(request("a"));
  const enqueueB = queue.enqueue(request("b"));
  const cancelA = queue.cancel("client-a");
  await nextTurn();
  assert.deepEqual(
    adapter.calls.map((call) => call.operation),
    ["read", "read", "replace"],
  );

  adapter.gates.replace.resolve();
  const [intentA, intentB, removed] = await Promise.all([enqueueA, enqueueB, cancelA]);
  assert.equal(intentA.enqueueOrder, 1);
  assert.equal(intentB.enqueueOrder, 2);
  assert.equal(removed, true);
  assert.deepEqual(
    queue.getState().intents.map((intent) => [intent.clientMessageId, intent.enqueueOrder]),
    [["client-b", 2]],
  );
  assert.deepEqual(
    adapter.calls.map((call) => call.operation),
    ["read", "read", "replace", "read", "replace", "read", "replace"],
  );
});

test("read, replace, and remove failures retain the prior public state", async () => {
  const { adapter, queue } = createFixture();
  await queue.activate(identityA);
  await queue.enqueue(request("retained"));
  const prior = queue.getState();
  const observed = [];
  queue.subscribe((state) => observed.push(state));

  adapter.failures.read = new Error("read failed");
  await assert.rejects(() => queue.activate(identityB), /read failed/);
  assert.equal(queue.getState(), prior);
  assert.deepEqual(observed, [prior]);
  adapter.failures.read = undefined;

  adapter.failures.replace = new Error("replace failed");
  await assert.rejects(() => queue.enqueue(request("not-published")), /replace failed/);
  assert.equal(queue.getState(), prior);
  adapter.failures.replace = undefined;

  adapter.failures.remove = new Error("remove failed");
  await assert.rejects(() => queue.cancel("client-retained"), /remove failed/);
  assert.equal(queue.getState(), prior);
  assert.deepEqual(observed, [prior]);
});

test("exposes deeply immutable current and observable snapshots", async () => {
  const { queue } = createFixture();
  const observed = [];
  const unsubscribe = queue.subscribe((state) => observed.push(state));
  assert.equal(observed.length, 1);
  assert.equal(observed[0], queue.getState());
  await queue.activate(identityA);
  await queue.enqueue(request("immutable", {
    content: {
      format: "plain",
      text: "immutable",
      blocks: [{ type: "paragraph", data: { nested: ["value"] } }],
    },
  }));

  const snapshot = queue.getState();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.identity));
  assert.ok(Object.isFrozen(snapshot.intents));
  assert.ok(Object.isFrozen(snapshot.intents[0]));
  assert.ok(Object.isFrozen(snapshot.intents[0].request));
  assert.ok(Object.isFrozen(snapshot.intents[0].content));
  assert.ok(Object.isFrozen(snapshot.intents[0].content.blocks));
  assert.ok(Object.isFrozen(snapshot.intents[0].content.blocks[0].data.nested));
  assert.throws(() => snapshot.intents.push("mutated"), TypeError);
  assert.throws(() => {
    snapshot.intents[0].request.content.text = "mutated";
  }, TypeError);
  assert.equal(observed.length, 3);
  assert.equal(observed.at(-1), snapshot);
  assert.deepEqual(observed[1].intents, []);
  unsubscribe();
  unsubscribe();
});

test("close is idempotent, waits for accepted work, and rejects later operations", async () => {
  const { adapter, queue } = createFixture();
  await queue.activate(identityA);
  const observed = [];
  queue.subscribe((state) => observed.push(state));
  adapter.gates.replace = deferred();
  const pending = queue.enqueue(request("before-close"));
  await nextTurn();

  const firstClose = queue.close();
  const secondClose = queue.close();
  assert.equal(firstClose, secondClose);
  await assert.rejects(
    () => queue.activate(identityB),
    (error) => error instanceof OfflineSendMessageQueueError && error.code === "closed",
  );
  await assert.rejects(
    () => queue.enqueue(request("after-close")),
    (error) => error instanceof OfflineSendMessageQueueError && error.code === "closed",
  );
  await assert.rejects(
    () => queue.cancel("client-before-close"),
    (error) => error instanceof OfflineSendMessageQueueError && error.code === "closed",
  );
  assert.throws(() => queue.subscribe(() => {}), /closed/);

  let closed = false;
  firstClose.then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  adapter.gates.replace.resolve();
  await pending;
  await firstClose;
  assert.equal(closed, true);
  assert.equal(queue.getState().intents.length, 1);
  assert.equal(observed.at(-1).intents.length, 1);
  assert.equal(await queue.close(), undefined);
});
