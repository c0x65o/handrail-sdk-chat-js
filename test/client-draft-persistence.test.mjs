import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatStorage,
  createChatClient,
  createChatDraftRuntime,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-draft-persistence";
const userId = "user-draft-persistence";
const cacheIdentity = { tenantId, userId, sessionId: "session-draft-persistence" };
const storageIdentity = { tenantId, userId, deviceId: "device-draft-persistence" };
const scope = Object.freeze({ identity: storageIdentity, generation: 1 });
const canonicalTime = "2026-09-03T18:00:00.000Z";

const content = (text, attachments = []) => ({
  format: "plain",
  text,
  attachments,
});
const replaced = (text) => ({ kind: "replaced", content: content(text) });
const appliedDraftResult = (request) => ({
  status: "success",
  value: {
    operation: "synchronize_draft",
    intent: request.intent,
    reconciliationStatus: "applied",
    conversationId: request.conversationId,
    baseRevision: request.baseRevision,
    deviceMutationId: request.deviceMutationId,
    idempotencyKey: request.idempotencyKey,
    canonicalRevision: request.baseRevision + 1,
    canonicalUpdatedAt: canonicalTime,
    draft: request.intent === "replace"
      ? { kind: "replaced", content: request.content }
      : { kind: "clear_tombstone", content: null },
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

class ManualTimer {
  next = 0;
  tasks = new Map();
  events;
  constructor(events = []) { this.events = events; }
  schedule = (task) => {
    const id = ++this.next;
    this.tasks.set(id, task);
    this.events.push("dispatch_scheduled");
    return id;
  };
  cancel = (id) => { this.tasks.delete(id); };
  runAll() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}

const createStorage = (overrides = {}) => {
  const records = new Map();
  const reads = [];
  const replacements = [];
  const removals = [];
  return {
    records,
    reads,
    replacements,
    removals,
    storage: {
      async read(identity, kind) {
        reads.push({ identity, kind });
        if (overrides.read) return overrides.read(identity, kind, records);
        return records.get(kind) ?? null;
      },
      async replace(record) {
        replacements.push(record);
        if (overrides.replace) await overrides.replace(record, records);
        else records.set(record.kind, record);
      },
      async remove(identity, kind) {
        removals.push({ identity, kind });
        records.delete(kind);
      },
      async mutate(identity, kind, updater) {
        reads.push({ identity, kind });
        const current = overrides.read
          ? await overrides.read(identity, kind, records)
          : records.get(kind) ?? null;
        const next = updater(current);
        if (next === null) {
          removals.push({ identity, kind });
          if (overrides.remove) await overrides.remove(identity, kind, records);
          else records.delete(kind);
        } else {
          replacements.push(next);
          if (overrides.replace) await overrides.replace(next, records);
          else records.set(kind, next);
        }
        return next;
      },
      async clearForLogout() {
        records.clear();
      },
    },
  };
};

const createAtomicStorageHarness = ({ onRead } = {}) => {
  const encodedRecords = new Map();
  let readCount = 0;
  let compareExchangeCount = 0;
  const adapter = {
    async read(_identity, kind) {
      const captured = encodedRecords.get(kind) ?? null;
      readCount += 1;
      await onRead?.({ captured, kind, readCount });
      return captured;
    },
    async replace(_identity, kind, encoded) {
      encodedRecords.set(kind, encoded);
    },
    async remove(_identity, kind) {
      encodedRecords.delete(kind);
    },
    async compareExchange(_identity, kind, expected, replacement) {
      compareExchangeCount += 1;
      if ((encodedRecords.get(kind) ?? null) !== expected) return false;
      if (replacement === null) encodedRecords.delete(kind);
      else encodedRecords.set(kind, replacement);
      return true;
    },
    async clearForLogout() {
      encodedRecords.clear();
    },
  };
  return {
    adapter,
    encodedRecords,
    get compareExchangeCount() { return compareExchangeCount; },
    get readCount() { return readCount; },
    createStorage: () => createApplicationChatStorage(adapter),
  };
};

const createRuntimeFixture = ({
  storageHarness = createStorage(),
  active = () => true,
  correlationPrefix = "draft",
} = {}) => {
  const events = [];
  const timer = new ManualTimer(events);
  const cache = createNormalizedChatCache(cacheIdentity);
  const dispatches = [];
  const diagnostics = [];
  let deviceMutationNumber = 0;
  let idempotencyNumber = 0;
  cache.subscribe(
    (state) => state.currentUser.drafts,
    () => events.push("projected"),
  );
  const runtime = createChatDraftRuntime({
    cache,
    snapshots: {
      async getConversationDraft() {
        throw new Error("draft hydration is not expected");
      },
    },
    dispatch(_descriptor, input, options) {
      events.push("dispatched");
      const pending = deferred();
      dispatches.push({ input, options, ...pending });
      return pending.promise;
    },
    options: {
      debounceMs: 25,
      timer,
      generateDeviceMutationId: () => `${correlationPrefix}-device-${++deviceMutationNumber}`,
      generateIdempotencyKey: () => `${correlationPrefix}-key-${++idempotencyNumber}`,
    },
    persistence: {
      storage: storageHarness.storage,
      getActiveScope: () => scope,
      isActiveScope: active,
      now: () => Date.parse(canonicalTime),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  return { cache, diagnostics, dispatches, events, runtime, storageHarness, timer };
};

test("draft intent is durable before projection and dispatch keeps exact correlation", async () => {
  const gate = deferred();
  const events = [];
  const storageHarness = createStorage({
    async replace(record, records) {
      events.push("persistence_started");
      await gate.promise;
      records.set(record.kind, record);
      events.push("persistence_completed");
    },
  });
  const fixture = createRuntimeFixture({ storageHarness });
  fixture.events.push = (...values) => events.push(...values);
  const conversationId = "persist-before-project";

  const immediate = fixture.runtime.replace({
    conversationId,
    content: content("private draft"),
  });
  assert.equal(immediate.draft, undefined);
  assert.equal(fixture.cache.getState().currentUser.drafts[conversationId], undefined);
  assert.equal(fixture.timer.tasks.size, 0);
  assert.equal(fixture.dispatches.length, 0);
  await eventually(() => events.includes("persistence_started"));
  assert.equal(fixture.cache.getState().currentUser.drafts[conversationId], undefined);

  gate.resolve();
  await eventually(() => fixture.timer.tasks.size === 1);
  assert.deepEqual(events.slice(0, 4), [
    "persistence_started",
    "persistence_completed",
    "projected",
    "dispatch_scheduled",
  ]);
  const stored = storageHarness.records.get(
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  ).intents[0].request;
  assert.equal(stored.deviceMutationId, "draft-device-1");
  assert.equal(stored.idempotencyKey, "draft-key-1");

  fixture.timer.runAll();
  await eventually(() => fixture.dispatches.length === 1);
  assert.equal(fixture.dispatches[0].input.deviceMutationId, stored.deviceMutationId);
  assert.equal(fixture.dispatches[0].input.idempotencyKey, stored.idempotencyKey);
  assert.equal(fixture.dispatches[0].options.idempotencyKey, stored.idempotencyKey);
  fixture.dispatches[0].resolve({
    status: "transport",
    message: "The chat command could not be completed.",
  });
  await eventually(() => fixture.runtime.select(conversationId).status === "retryable");
  await new Promise((resolve) => setImmediate(resolve));
  const retry = fixture.runtime.retry(conversationId);
  await eventually(() => fixture.dispatches.length === 2);
  assert.deepEqual(fixture.dispatches[1].input, stored);
  assert.equal(fixture.dispatches[1].options.idempotencyKey, stored.idempotencyKey);
  fixture.dispatches[1].resolve({
    status: "success",
    value: {
      operation: "synchronize_draft",
      intent: stored.intent,
      reconciliationStatus: "applied",
      conversationId: stored.conversationId,
      baseRevision: stored.baseRevision,
      deviceMutationId: stored.deviceMutationId,
      idempotencyKey: stored.idempotencyKey,
      canonicalRevision: stored.baseRevision + 1,
      canonicalUpdatedAt: canonicalTime,
      draft: { kind: "replaced", content: stored.content },
    },
  });
  assert.equal((await retry).status, "success");
});

test("repeated edits serialize storage writes and coalesce the waiting version", async () => {
  const firstWrite = deferred();
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const writtenTexts = [];
  const storageHarness = createStorage({
    async replace(record, records) {
      activeWrites += 1;
      maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
      writtenTexts.push(record.intents[0].request.content.text);
      if (writtenTexts.length === 1) await firstWrite.promise;
      records.set(record.kind, record);
      activeWrites -= 1;
    },
  });
  const fixture = createRuntimeFixture({ storageHarness });
  const conversationId = "serialized-draft";

  fixture.runtime.replace({ conversationId, content: content("first") });
  fixture.runtime.replace({ conversationId, content: content("second") });
  await eventually(() => writtenTexts.length === 1);
  assert.deepEqual(writtenTexts, ["second"], "synchronous edits coalesce before writing");
  fixture.runtime.replace({ conversationId, content: content("third") });
  fixture.runtime.replace({ conversationId, content: content("latest") });
  assert.equal(writtenTexts.length, 1);
  assert.equal(fixture.cache.getState().currentUser.drafts[conversationId], undefined);

  firstWrite.resolve();
  await eventually(() => writtenTexts.length === 2);
  await eventually(() =>
    fixture.cache.getState().currentUser.drafts[conversationId]?.content.text === "latest");
  assert.deepEqual(writtenTexts, ["second", "latest"]);
  assert.equal(maximumActiveWrites, 1);
  assert.equal(fixture.timer.tasks.size, 1);
  assert.equal(fixture.dispatches.length, 0);

  fixture.timer.runAll();
  await eventually(() => fixture.dispatches.length === 1);
  fixture.runtime.replace({ conversationId, content: content("after acknowledgement") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writtenTexts.length, 2, "the next durable base waits for the active request");
  const active = fixture.dispatches[0].input;
  fixture.dispatches[0].resolve({
    status: "success",
    value: {
      operation: "synchronize_draft",
      intent: active.intent,
      reconciliationStatus: "applied",
      conversationId: active.conversationId,
      baseRevision: active.baseRevision,
      deviceMutationId: active.deviceMutationId,
      idempotencyKey: active.idempotencyKey,
      canonicalRevision: active.baseRevision + 1,
      canonicalUpdatedAt: canonicalTime,
      draft: { kind: "replaced", content: active.content },
    },
  });
  await eventually(() => writtenTexts.length === 3);
  const retained = storageHarness.records.get(
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  ).intents[0].request;
  assert.equal(retained.content.text, "after acknowledgement");
  assert.equal(retained.baseRevision, 1);
});

test("two runtimes atomically preserve concurrent drafts for different conversations", async () => {
  const initialReadsReady = deferred();
  const releaseInitialReads = deferred();
  let waitingInitialReads = 0;
  const atomic = createAtomicStorageHarness({
    async onRead({ kind, readCount }) {
      if (kind !== ApplicationChatStorageRecordKind.queuedDraftIntents || readCount > 2) return;
      waitingInitialReads += 1;
      if (waitingInitialReads === 2) initialReadsReady.resolve();
      await releaseInitialReads.promise;
    },
  });
  const first = createRuntimeFixture({
    storageHarness: { storage: atomic.createStorage() },
    correlationPrefix: "first-runtime",
  });
  const second = createRuntimeFixture({
    storageHarness: { storage: atomic.createStorage() },
    correlationPrefix: "second-runtime",
  });

  first.runtime.replace({ conversationId: "atomic-first", content: content("first text") });
  second.runtime.replace({ conversationId: "atomic-second", content: content("second text") });
  await initialReadsReady.promise;
  releaseInitialReads.resolve();
  await eventually(() => first.timer.tasks.size === 1 && second.timer.tasks.size === 1);

  const stored = await atomic.createStorage().read(
    storageIdentity,
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  );
  assert.deepEqual(
    stored.intents.map((intent) => [
      intent.request.conversationId,
      intent.request.content.text,
    ]).sort(),
    [
      ["atomic-first", "first text"],
      ["atomic-second", "second text"],
    ],
  );
  assert.deepEqual(stored.intents.map((intent) => intent.enqueueOrder), [1, 2]);
  assert.ok(atomic.compareExchangeCount >= 3, "one stale proposal must be retried");
});

test("two runtimes coalesce one conversation to the latest atomic commit and correlation", async () => {
  const initialReadsReady = deferred();
  const releaseInitialReads = deferred();
  let waitingInitialReads = 0;
  const atomic = createAtomicStorageHarness({
    async onRead({ kind, readCount }) {
      if (kind !== ApplicationChatStorageRecordKind.queuedDraftIntents || readCount > 2) return;
      waitingInitialReads += 1;
      if (waitingInitialReads === 2) initialReadsReady.resolve();
      await releaseInitialReads.promise;
    },
  });
  const first = createRuntimeFixture({
    storageHarness: { storage: atomic.createStorage() },
    correlationPrefix: "same-first",
  });
  const second = createRuntimeFixture({
    storageHarness: { storage: atomic.createStorage() },
    correlationPrefix: "same-second",
  });
  const conversationId = "atomic-same-conversation";

  first.runtime.replace({ conversationId, content: content("first committed text") });
  second.runtime.replace({ conversationId, content: content("second committed text") });
  await initialReadsReady.promise;
  releaseInitialReads.resolve();
  await eventually(() => first.timer.tasks.size === 1 && second.timer.tasks.size === 1);

  const stored = await atomic.createStorage().read(
    storageIdentity,
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  );
  assert.equal(stored.intents.length, 1);
  const latest = stored.intents[0];
  assert.equal(latest.enqueueOrder, 2);
  const expectedCorrelation = latest.request.content.text === "first committed text"
    ? { deviceMutationId: "same-first-device-1", idempotencyKey: "same-first-key-1" }
    : { deviceMutationId: "same-second-device-1", idempotencyKey: "same-second-key-1" };
  assert.equal(latest.request.deviceMutationId, expectedCorrelation.deviceMutationId);
  assert.equal(latest.request.idempotencyKey, expectedCorrelation.idempotencyKey);
  assert.ok(atomic.compareExchangeCount >= 3, "the later commit must use a retried proposal");
});

test("settling an older runtime request cannot remove a newer same-conversation intent", async () => {
  const settlementReadStarted = deferred();
  const releaseSettlementRead = deferred();
  let blockNextDraftRead = false;
  const atomic = createAtomicStorageHarness({
    async onRead({ kind }) {
      if (
        kind !== ApplicationChatStorageRecordKind.queuedDraftIntents ||
        !blockNextDraftRead
      ) return;
      blockNextDraftRead = false;
      settlementReadStarted.resolve();
      await releaseSettlementRead.promise;
    },
  });
  const older = createRuntimeFixture({
    storageHarness: { storage: atomic.createStorage() },
    correlationPrefix: "older-runtime",
  });
  const newer = createRuntimeFixture({
    storageHarness: { storage: atomic.createStorage() },
    correlationPrefix: "newer-runtime",
  });
  const conversationId = "atomic-settlement";

  older.runtime.replace({ conversationId, content: content("older text") });
  await eventually(() => older.timer.tasks.size === 1);
  older.timer.runAll();
  await eventually(() => older.dispatches.length === 1);
  blockNextDraftRead = true;
  older.dispatches[0].resolve(appliedDraftResult(older.dispatches[0].input));
  await settlementReadStarted.promise;

  newer.runtime.replace({ conversationId, content: content("newer text") });
  await eventually(() => newer.timer.tasks.size === 1);
  releaseSettlementRead.resolve();
  await eventually(() => older.runtime.select(conversationId).status === "ready");

  const stored = await atomic.createStorage().read(
    storageIdentity,
    ApplicationChatStorageRecordKind.queuedDraftIntents,
  );
  assert.equal(stored.intents.length, 1);
  assert.equal(stored.intents[0].request.content.text, "newer text");
  assert.equal(stored.intents[0].request.deviceMutationId, "newer-runtime-device-1");
  assert.equal(stored.intents[0].request.idempotencyKey, "newer-runtime-key-1");
});

test("dirty normalized checkpoints retain only the acknowledged canonical draft", async () => {
  const cache = createNormalizedChatCache(cacheIdentity);
  const conversationId = "canonical-checkpoint-draft";
  cache.hydrateConversationDraft({
    kind: "conversation_draft",
    privacy: "actor_private",
    conversationId,
    state: "present",
    canonicalRevision: 4,
    canonicalUpdatedAt: canonicalTime,
    content: { privacy: "actor_private", value: content("acknowledged") },
  });
  const storageHarness = createStorage();
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "access-token-secret",
    cache,
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
          protocolVersion: CHAT_PROTOCOL_VERSION,
          schemaVersion: 1,
          enabledFeatures: {},
          supportedProtocolRange: {
            minimumVersion: CHAT_PROTOCOL_VERSION,
            maximumVersion: CHAT_PROTOCOL_VERSION,
          },
        };
      },
    }),
    drafts: { debounceMs: 60_000 },
    normalizedCachePersistence: {
      storage: storageHarness.storage,
      resolveIdentity: () => storageIdentity,
    },
  });
  assert.equal((await client.start()).state, "ready");
  client.replaceConversationDraft({ conversationId, content: content("projected") });
  await eventually(() =>
    cache.getState().currentUser.drafts[conversationId]?.content.text === "projected");
  const checkpoint = storageHarness.records.get(
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  ).snapshot;
  assert.equal(checkpoint.currentUser.drafts[conversationId].content.text, "acknowledged");
  assert.equal(checkpoint.currentUser.draftRevisions[conversationId], 4);
  assert.equal(JSON.stringify(checkpoint).includes("projected"), false);
  client.close();
});

test("storage failure leaves projection and dispatch untouched with a redacted diagnostic", async () => {
  const storageHarness = createStorage({
    async replace() {
      throw new Error("raw-error private-body attachment-secret access-token-secret payload-secret");
    },
  });
  const fixture = createRuntimeFixture({ storageHarness });
  const conversationId = "failed-draft-persistence";
  fixture.runtime.replace({
    conversationId,
    content: content("private-body", [{ attachmentId: "attachment-secret" }]),
  });
  assert.equal((await fixture.runtime.flush(conversationId)).status, "validation");
  assert.equal(fixture.cache.getState().currentUser.drafts[conversationId], undefined);
  assert.deepEqual(fixture.runtime.createCanonicalCheckpoint(), {
    drafts: {},
    draftRevisions: {},
  });
  assert.equal(fixture.timer.tasks.size, 0);
  assert.equal(fixture.dispatches.length, 0);
  assert.deepEqual(fixture.diagnostics, [{
    code: "draft_intents_write_failed",
    message: "The draft intent could not be stored.",
  }]);
  const serialized = JSON.stringify(fixture.diagnostics);
  assert.ok(serialized.length < 256);
  for (const excluded of [
    "private-body",
    "attachment-secret",
    "access-token-secret",
    "payload-secret",
    "raw-error",
  ]) assert.equal(serialized.includes(excluded), false, excluded);
});

test("closed and replaced identity generations ignore delayed persistence", async () => {
  for (const boundary of ["close", "identity"] ) {
    const gate = deferred();
    let scopeActive = true;
    const storageHarness = createStorage({
      async replace(record, records) {
        await gate.promise;
        records.set(record.kind, record);
      },
    });
    const fixture = createRuntimeFixture({
      storageHarness,
      active: () => scopeActive,
    });
    const conversationId = `delayed-${boundary}`;
    fixture.runtime.replace({ conversationId, content: content("old identity draft") });
    await eventually(() => storageHarness.replacements.length === 1);
    scopeActive = false;
    if (boundary === "close") fixture.runtime.closeActive();
    else fixture.cache.setIdentity({
      tenantId,
      userId: "replacement-user",
      sessionId: "replacement-session",
    });
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.cache.getState().currentUser.drafts[conversationId], undefined);
    assert.equal(fixture.timer.tasks.size, 0);
    assert.equal(fixture.dispatches.length, 0);
    assert.deepEqual(fixture.diagnostics, []);
  }
});

for (const [label, before, after] of [
  ["add", undefined, { messageId: "private-source-a", notifyAuthor: false }],
  ["change", { messageId: "private-source-a", notifyAuthor: false }, { messageId: "private-source-b", notifyAuthor: false }],
  ["ping", { messageId: "private-source-a", notifyAuthor: false }, { messageId: "private-source-a", notifyAuthor: true }],
  ["remove", { messageId: "private-source-a", notifyAuthor: false }, undefined],
]) {
  for (const acknowledgeInitial of [false, true]) {
    test(`reply-only ${label} persists through restart and stale-base retry (initial acknowledged: ${acknowledgeInitial})`, async () => {
      const atomic = createAtomicStorageHarness();
      const storageHarness = { storage: atomic.createStorage() };
      const first = createRuntimeFixture({ storageHarness });
      const conversationId = `retained-reply-${label}`;
      const makeContent = (replyTo) => ({
        ...content("private reply text", [{ attachmentId: "private-upload" }]),
        ...(replyTo === undefined ? {} : { replyTo: structuredClone(replyTo) }),
      });
      first.runtime.replace({ conversationId, content: makeContent(before) });
      await eventually(() => first.timer.tasks.size === 1);
      if (acknowledgeInitial) {
        const initialFlush = first.runtime.flush(conversationId);
        await eventually(() => first.dispatches.length === 1);
        first.dispatches[0].resolve(appliedDraftResult(first.dispatches[0].input));
        assert.equal((await initialFlush).status, "success");
      }
      const local = makeContent(after);
      const expected = structuredClone(local);
      first.runtime.replace({ conversationId, content: local });
      if (local.replyTo) local.replyTo.messageId = "mutated-source";
      local.text = "mutated-text";
      local.attachments[0].attachmentId = "mutated-upload";
      await eventually(() => first.timer.tasks.size === 1);
      const stored = await storageHarness.storage.read(storageIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents);
      const original = stored.intents[0].request;
      assert.deepEqual(original.content, expected);
      assert.deepEqual(first.runtime.select(conversationId).draft.content, expected);
      if (after !== undefined) {
        assert.equal(Object.isFrozen(original.content.replyTo), true);
        assert.equal(Object.isFrozen(first.runtime.select(conversationId).draft.content.replyTo), true);
      }
      first.runtime.closeActive();

      const restarted = createRuntimeFixture({ storageHarness: { storage: atomic.createStorage() } });
      await restarted.runtime.activateRetained(scope);
      await eventually(() => restarted.dispatches.length === 1);
      assert.deepEqual(restarted.runtime.select(conversationId).draft.content, expected);
      assert.deepEqual(restarted.dispatches[0].input, original);
      const stale = appliedDraftResult(original);
      stale.value.reconciliationStatus = "stale_base";
      stale.value.canonicalRevision = 6;
      stale.value.draft = { kind: "replaced", content: makeContent({ messageId: "remote-private-source", notifyAuthor: true }) };
      restarted.dispatches[0].resolve(stale);
      await eventually(() => restarted.runtime.select(conversationId).status === "conflict");
      assert.deepEqual(restarted.runtime.select(conversationId).draft.content, expected);
      assert.equal(restarted.runtime.select(conversationId).conflict.code, "stale_base");
      const redacted = JSON.stringify([restarted.runtime.select(conversationId).conflict, restarted.diagnostics]);
      for (const secret of ["private-source", "private reply text", "private-upload"]) {
        assert.equal(redacted.includes(secret), false);
      }
      const retry = restarted.runtime.retry(conversationId);
      await eventually(() => restarted.dispatches.length === 2);
      const retried = restarted.dispatches[1].input;
      assert.equal(retried.baseRevision, 6);
      assert.equal(retried.conversationId, conversationId);
      assert.notEqual(retried.idempotencyKey, original.idempotencyKey);
      assert.deepEqual(retried.content, expected);
      restarted.dispatches[1].resolve(appliedDraftResult(retried));
      assert.equal((await retry).status, "success");
      assert.deepEqual(restarted.runtime.select(conversationId).draft.content, expected);
      assert.equal(Object.hasOwn(retried.content, "replyTo"), after !== undefined);
      assert.equal(await storageHarness.storage.read(storageIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents), null);
      restarted.runtime.closeActive();
    });
  }
}
