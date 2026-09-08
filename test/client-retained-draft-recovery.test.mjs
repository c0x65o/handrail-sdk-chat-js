import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatQueuedDraftIntent,
  createApplicationChatQueuedDraftIntentsRecord,
  createApplicationChatQueuedHuddleCommandIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createChatDraftRuntime,
  createNormalizedChatCache,
  encodeApplicationChatStorageRecord,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-retained-draft";
const userId = "writer-a";
const conversationId = "conversation-retained-draft";
const canonicalTime = "2033-01-01T00:00:00.000Z";
const identity = (user = userId, deviceId = "device-a") => ({
  tenantId, userId: user, deviceId,
});
const cacheIdentity = (user = userId) => ({
  tenantId, userId: user, sessionId: `session-${user}`,
});
const scope = (generation = 1, storageIdentity = identity()) => ({
  identity: storageIdentity, generation,
});
const storageKey = (storageIdentity, kind) =>
  `${storageIdentity.tenantId}\0${storageIdentity.userId}\0${storageIdentity.deviceId}\0${kind}`;
const content = (text) => ({ format: "plain", text, attachments: [] });
const input = ({
  intent = "replace",
  conversation = conversationId,
  baseRevision = 4,
  deviceMutationId = "retained-device-mutation",
  idempotencyKey = "retained-draft-key",
} = {}) => ({
  operation: "synchronize_draft",
  intent,
  conversationId: conversation,
  baseRevision,
  deviceMutationId,
  idempotencyKey,
  ...(intent === "replace" ? { content: content("retained private draft") } : {}),
});
const resultFor = (request, overrides = {}) => ({
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
  ...overrides,
});
const eventFor = (request, overrides = {}) => ({
  eventId: `draft-event:${request.idempotencyKey}`,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: `user:${userId}`,
  type: "conversation.draft.updated",
  occurredAt: canonicalTime,
  payload: {
    actorUserId: userId,
    input: request,
    result: resultFor(request),
  },
  ...overrides,
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
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
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
  factory = (owner) => (name) => {
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      postMessage: (message) => {
        if (channel.closed) return;
        for (const peer of [...this.channels]) {
          if (peer === channel || peer.closed || peer.name !== name) continue;
          for (const listener of peer.listeners) {
            listener({ data: structuredClone(message) });
          }
        }
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => {
        channel.closed = true;
        this.channels.delete(channel);
      },
      listeners,
    };
    this.channels.add(channel);
    return channel;
  };
}

const makeRecord = (storageIdentity, request = input()) =>
  createApplicationChatQueuedDraftIntentsRecord(storageIdentity, [
    createApplicationChatQueuedDraftIntent(request, {
      enqueueOrder: 1,
      enqueuedAt: canonicalTime,
    }),
  ]);

function createAtomicStorage(records, { read } = {}) {
  return createApplicationChatStorage({
    async read(storageIdentity, kind) {
      if (read !== undefined) return read(storageIdentity, kind, records);
      return records.get(storageKey(storageIdentity, kind)) ?? null;
    },
    async replace(storageIdentity, kind, encodedRecord) {
      records.set(storageKey(storageIdentity, kind), encodedRecord);
    },
    async remove(storageIdentity, kind) {
      records.delete(storageKey(storageIdentity, kind));
    },
    async compareExchange(storageIdentity, kind, expected, replacement) {
      const key = storageKey(storageIdentity, kind);
      if ((records.get(key) ?? null) !== expected) return false;
      if (replacement === null) records.delete(key);
      else records.set(key, replacement);
      return true;
    },
    async clearForLogout(storageIdentity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        records.delete(storageKey(storageIdentity, kind));
      }
    },
  });
}

function createHarness({
  initialScope = scope(),
  record = makeRecord(initialScope.identity),
  ready = false,
  read,
} = {}) {
  const records = new Map([[
    storageKey(initialScope.identity, ApplicationChatStorageRecordKind.queuedDraftIntents),
    encodeApplicationChatStorageRecord(record),
  ]]);
  const dispatches = [];
  const waits = [];
  const diagnostics = [];
  const announcements = [];
  let activeScope = initialScope;
  let recoveryReady = ready;
  const cache = createNormalizedChatCache(cacheIdentity(initialScope.identity.userId));
  cache.hydrateConversationDraft({
    kind: "conversation_draft",
    privacy: "actor_private",
    conversationId,
    state: "present",
    canonicalRevision: 4,
    canonicalUpdatedAt: canonicalTime,
    content: { privacy: "actor_private", value: content("acknowledged") },
  });
  const storage = createAtomicStorage(records, { read });
  const runtime = createChatDraftRuntime({
    cache,
    snapshots: { async getConversationDraft() { throw new Error("not expected"); } },
    dispatch(_descriptor, request, options) {
      const pending = deferred();
      dispatches.push({ request, options, ...pending });
      return pending.promise;
    },
    options: {
      debounceMs: 0,
      retainedRecovery: {
        initialDelayMs: 10,
        maximumDelayMs: 20,
        multiplier: 2,
        wait(delayMs, signal) {
          const pending = deferred();
          const waiting = { delayMs, signal, ...pending };
          signal.addEventListener("abort", () => pending.reject(new Error("aborted")), {
            once: true,
          });
          waits.push(waiting);
          return pending.promise;
        },
      },
    },
    persistence: {
      storage,
      getActiveScope: () => activeScope,
      isActiveScope: (candidate) => candidate.generation === activeScope.generation &&
        storageKey(candidate.identity, "scope") === storageKey(activeScope.identity, "scope"),
      isRecoveryReady: () => recoveryReady,
      onPersistedIntent: (command, idempotencyKey) =>
        announcements.push({ command, idempotencyKey }),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  return {
    announcements,
    cache,
    diagnostics,
    dispatches,
    records,
    runtime,
    waits,
    setReady(value) { recoveryReady = value; },
    setScope(value) { activeScope = value; },
  };
}

test("reload restores replace and clear projections, then exact HTTP success settles after readiness", async () => {
  for (const intent of ["replace", "clear"]) {
    const request = input({ intent, idempotencyKey: `retained-${intent}` });
    const active = scope();
    const fixture = createHarness({ record: makeRecord(active.identity, request) });

    await fixture.runtime.activateRetained(active);
    const restored = fixture.runtime.select(conversationId);
    assert.equal(restored.dirty, true);
    assert.equal(restored.draft.kind, intent === "replace" ? "replaced" : "clear_tombstone");
    assert.equal(fixture.dispatches.length, 0);

    fixture.runtime.resumeRetained();
    assert.equal(fixture.dispatches.length, 0, "not ready does not replay");
    fixture.setReady(true);
    fixture.runtime.resumeRetained();
    await eventually(() => fixture.dispatches.length === 1);
    assert.deepEqual(fixture.dispatches[0].request, request);
    assert.equal(fixture.dispatches[0].options.idempotencyKey, request.idempotencyKey);
    fixture.dispatches[0].resolve({ status: "success", value: resultFor(request) });
    await eventually(() => fixture.runtime.select(conversationId).dirty === false);
    assert.equal(
      fixture.records.has(storageKey(active.identity, ApplicationChatStorageRecordKind.queuedDraftIntents)),
      false,
    );
  }
});

test("createChatClient activates retained drafts after hydration and close pauses without deletion", async () => {
  const activeIdentity = identity();
  const request = input({ idempotencyKey: "client-retained-key" });
  const record = makeRecord(activeIdentity, request);
  const records = new Map([[
    storageKey(activeIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents),
    encodeApplicationChatStorageRecord(record),
  ]]);
  const patch = deferred();
  const patchCalls = [];
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.hydrateConversationDraft({
    kind: "conversation_draft",
    privacy: "actor_private",
    conversationId,
    state: "present",
    canonicalRevision: 4,
    canonicalUpdatedAt: canonicalTime,
    content: { privacy: "actor_private", value: content("acknowledged") },
  });
  const storage = createAtomicStorage(records);
  let client;
  client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "test-token",
    cache,
    fetch: async (url) => {
      if (String(url).endsWith("/_meta")) {
        return response(200, {
          packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
          protocolVersion: CHAT_PROTOCOL_VERSION,
          schemaVersion: 1,
          enabledFeatures: {},
          supportedProtocolRange: {
            minimumVersion: CHAT_PROTOCOL_VERSION,
            maximumVersion: CHAT_PROTOCOL_VERSION,
          },
        });
      }
      patchCalls.push({ state: client.state.state, url: String(url) });
      return patch.promise;
    },
    normalizedCachePersistence: {
      storage,
      resolveIdentity: () => activeIdentity,
    },
  });

  assert.equal((await client.start()).state, "ready");
  assert.equal(client.selectConversationDraft(conversationId).dirty, true);
  assert.equal(client.selectConversationDraft(conversationId).draft.content.text, "retained private draft");
  await eventually(() => patchCalls.length === 1);
  assert.equal(patchCalls[0].state, "ready", "retained dispatch starts only after lifecycle readiness");
  client.close();
  patch.resolve(response(200, resultFor(request)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.has(storageKey(activeIdentity, ApplicationChatStorageRecordKind.queuedDraftIntents)), true);
});

test("cross-tab follower pauses and resumes as leader without duplicate retained dispatch", async () => {
  const activeIdentity = identity();
  const request = input({ idempotencyKey: "cross-tab-retained-key" });
  const kind = ApplicationChatStorageRecordKind.queuedDraftIntents;
  const recordKey = storageKey(activeIdentity, kind);
  const records = new Map([[
    recordKey,
    encodeApplicationChatStorageRecord(makeRecord(activeIdentity, request)),
  ]]);
  const storage = createAtomicStorage(records);
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const dispatches = [];
  const clients = [];
  const createClient = (tabId) => {
    const cache = createNormalizedChatCache(cacheIdentity());
    cache.hydrateConversationDraft({
      kind: "conversation_draft",
      privacy: "actor_private",
      conversationId,
      state: "present",
      canonicalRevision: 4,
      canonicalUpdatedAt: canonicalTime,
      content: { privacy: "actor_private", value: content("acknowledged") },
    });
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "test-token",
      cache,
      fetch: async (url) => {
        if (String(url).endsWith("/_meta")) {
          return response(200, {
            packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
            protocolVersion: CHAT_PROTOCOL_VERSION,
            schemaVersion: 1,
            enabledFeatures: {},
            supportedProtocolRange: {
              minimumVersion: CHAT_PROTOCOL_VERSION,
              maximumVersion: CHAT_PROTOCOL_VERSION,
            },
          });
        }
        const pending = deferred();
        dispatches.push({ tabId, ...pending });
        return pending.promise;
      },
      crossTab: {
        sessionFingerprint: "retained-draft-session",
        tabId,
        channelFactory: hub.factory(tabId),
        clock,
        timing: {
          electionDelayMs: 10,
          heartbeatIntervalMs: 20,
          leaseDurationMs: 60,
          commandClaimDelayMs: 1,
          commandClaimLeaseMs: 50,
        },
      },
      normalizedCachePersistence: {
        storage,
        resolveIdentity: () => activeIdentity,
      },
    });
    clients.push(client);
    return client;
  };
  const first = createClient("tab-a");
  const second = createClient("tab-b");
  await Promise.all([first.start(), second.start()]);
  assert.equal(dispatches.length, 0);

  clock.tick(10);
  await eventually(() => clients.some((client) => client.coordination?.role === "leader"));
  await eventually(() => [...clock.timers.values()].some((timer) => timer.at <= clock.current + 1));
  clock.tick(1);
  await eventually(() => dispatches.length === 1);
  const leader = first.coordination?.role === "leader" ? first : second;
  const follower = leader === first ? second : first;
  assert.equal(follower.coordination?.role, "follower");
  leader.close();
  dispatches[0].resolve(response(200, resultFor(request)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(records.has(recordKey), true, "the closed leader cannot delete retained work");

  clock.tick(10);
  await eventually(() => follower.coordination?.role === "leader");
  await eventually(() => follower.selectConversationDraft(conversationId).status === "saving");
  clock.tick(51);
  await eventually(() => dispatches.length === 2);
  assert.equal(follower.coordination?.role, "leader");
  dispatches[1].resolve(response(200, resultFor(request)));
  await eventually(() => records.has(recordKey) === false);
  assert.equal(dispatches.length, 2);
  follower.close();
});

test("only an exactly correlated canonical or coordinated success settles retained work", async () => {
  const active = scope();
  const request = input();
  const fixture = createHarness({ initialScope: active, ready: false });
  await fixture.runtime.activateRetained(active);

  const wrong = input({ deviceMutationId: "other-device-mutation", idempotencyKey: "other-key" });
  fixture.runtime.handleCanonicalEvent(eventFor(wrong));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.runtime.select(conversationId).dirty, true);
  assert.equal(fixture.records.size, 1);

  fixture.runtime.handleCoordinatedResult(
    "conversation.draft.synchronize",
    request.idempotencyKey,
    { status: "success", value: resultFor(request, { idempotencyKey: "ambiguous-key" }) },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.records.size, 1);

  fixture.runtime.handleCanonicalEvent(eventFor(request));
  await eventually(() => fixture.runtime.select(conversationId).dirty === false);
  assert.equal(fixture.records.size, 0);

  const coordinatedRequest = input({ idempotencyKey: "coordinated-draft-key" });
  const coordinated = createHarness({
    initialScope: active,
    record: makeRecord(active.identity, coordinatedRequest),
    ready: false,
  });
  await coordinated.runtime.activateRetained(active);
  coordinated.runtime.handleCoordinatedResult(
    "conversation.draft.synchronize",
    coordinatedRequest.idempotencyKey,
    { status: "success", value: resultFor(coordinatedRequest) },
  );
  await eventually(() => coordinated.runtime.select(conversationId).dirty === false);
  assert.equal(coordinated.records.size, 0);
});

test("transport and malformed ambiguity retain correlation with bounded backoff and pause/resume", async () => {
  const active = scope();
  const request = input();
  const fixture = createHarness({ initialScope: active, ready: true });
  await fixture.runtime.activateRetained(active);
  await eventually(() => fixture.dispatches.length === 1);

  fixture.dispatches[0].resolve({ status: "transport", message: "The chat command could not be completed." });
  await eventually(() => fixture.waits.length === 1);
  assert.equal(fixture.waits[0].delayMs, 10);
  assert.equal(fixture.records.size, 1);
  fixture.waits[0].resolve();
  await eventually(() => fixture.dispatches.length === 2);
  assert.deepEqual(fixture.dispatches[1].request, request);

  fixture.dispatches[1].resolve({ status: "success", value: { ambiguous: true } });
  await eventually(() => fixture.waits.length === 2);
  assert.equal(fixture.waits[1].delayMs, 20);
  fixture.waits[1].resolve();
  await eventually(() => fixture.dispatches.length === 3);

  fixture.setReady(false);
  fixture.runtime.pauseRetained();
  assert.equal(fixture.runtime.select(conversationId).dirty, true);
  fixture.dispatches[2].resolve({ status: "success", value: resultFor(request) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.records.size, 1, "a completion abandoned on follower transition is inert");
  fixture.runtime.resumeRetained();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.dispatches.length, 3, "paused follower does not duplicate dispatch");
  fixture.setReady(true);
  fixture.runtime.resumeRetained();
  await eventually(() => fixture.dispatches.length === 4);
  fixture.dispatches[3].resolve({ status: "success", value: resultFor(request) });
  await eventually(() => fixture.records.size === 0);
});

test("rejected retained drafts preserve a concurrent valid same-key replacement", async () => {
  const activeIdentity = identity();
  const siblingIdentity = identity("sibling-private-user", "sibling-private-device");
  const active = scope(1, activeIdentity);
  const kind = ApplicationChatStorageRecordKind.queuedDraftIntents;
  const siblingKind = ApplicationChatStorageRecordKind.queuedHuddleCommandIntents;
  const activeKey = storageKey(activeIdentity, kind);
  const siblingIdentityKey = storageKey(siblingIdentity, kind);
  const siblingKindKey = storageKey(activeIdentity, siblingKind);
  const malformed = '{"malformed-private-bytes":"malformed-draft-secret"';
  const replacementRequest = input({
    deviceMutationId: "replacement-private-device-mutation",
    idempotencyKey: "replacement-private-idempotency-key",
  });
  const replacementEncoded = encodeApplicationChatStorageRecord(
    makeRecord(activeIdentity, replacementRequest),
  );
  const siblingIdentityEncoded = encodeApplicationChatStorageRecord(
    makeRecord(siblingIdentity, input({
      deviceMutationId: "sibling-private-device-mutation",
      idempotencyKey: "sibling-private-idempotency-key",
    })),
  );
  const siblingKindEncoded = encodeApplicationChatStorageRecord(
    createApplicationChatQueuedHuddleCommandIntentsRecord(activeIdentity, []),
  );
  const rawAdapterError = "raw-private-adapter-remove-error";
  const rows = new Map([
    [activeKey, malformed],
    [siblingIdentityKey, siblingIdentityEncoded],
    [siblingKindKey, siblingKindEncoded],
  ]);
  let compareExchangeCount = 0;
  let removeCount = 0;
  const storage = createApplicationChatStorage({
    async read(candidate, recordKind) {
      return rows.get(storageKey(candidate, recordKind)) ?? null;
    },
    async replace(candidate, recordKind, encoded) {
      rows.set(storageKey(candidate, recordKind), encoded);
    },
    async remove(candidate, recordKind) {
      removeCount += 1;
      rows.delete(storageKey(candidate, recordKind));
      throw new Error(rawAdapterError);
    },
    async compareExchange(candidate, recordKind, expected, encoded) {
      compareExchangeCount += 1;
      const key = storageKey(candidate, recordKind);
      assert.equal(key, activeKey);
      assert.equal(expected, malformed);
      assert.equal(encoded, null);
      rows.set(key, replacementEncoded);
      if ((rows.get(key) ?? null) !== expected) return false;
      rows.delete(key);
      return true;
    },
    async clearForLogout() {},
  });
  const cache = createNormalizedChatCache(cacheIdentity());
  cache.hydrateConversationDraft({
    kind: "conversation_draft",
    privacy: "actor_private",
    conversationId,
    state: "present",
    canonicalRevision: 4,
    canonicalUpdatedAt: canonicalTime,
    content: { privacy: "actor_private", value: content("acknowledged") },
  });
  const diagnostics = [];
  const runtime = createChatDraftRuntime({
    cache,
    snapshots: { async getConversationDraft() { throw new Error("not expected"); } },
    async dispatch() { throw new Error("not expected"); },
    persistence: {
      storage,
      getActiveScope: () => active,
      isActiveScope: (candidate) => candidate.generation === active.generation &&
        storageKey(candidate.identity, "scope") === storageKey(active.identity, "scope"),
      isRecoveryReady: () => false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });

  await runtime.activateRetained(active);

  assert.equal(compareExchangeCount, 1);
  assert.equal(removeCount, 0, "runtime must not follow conditional quarantine with remove");
  assert.equal(rows.get(activeKey), replacementEncoded);
  assert.equal(rows.get(siblingIdentityKey), siblingIdentityEncoded);
  assert.equal(rows.get(siblingKindKey), siblingKindEncoded);
  assert.equal(runtime.select(conversationId).dirty, false);
  assert.deepEqual(diagnostics, [{
    code: "draft_intents_rejected",
    message: "The stored draft intent record was rejected and quarantined.",
  }]);
  const renderedDiagnostic = JSON.stringify(diagnostics);
  for (const privateValue of [
    malformed,
    "retained private draft",
    replacementRequest.deviceMutationId,
    replacementRequest.idempotencyKey,
    replacementRequest.conversationId,
    activeIdentity.tenantId,
    activeIdentity.userId,
    activeIdentity.deviceId,
    siblingIdentity.userId,
    siblingIdentity.deviceId,
    rawAdapterError,
  ]) {
    assert.equal(renderedDiagnostic.includes(privateValue), false);
  }

  await runtime.reloadRetained(active);

  assert.equal(removeCount, 0);
  assert.equal(rows.get(activeKey), replacementEncoded);
  assert.equal(rows.get(siblingIdentityKey), siblingIdentityEncoded);
  assert.equal(rows.get(siblingKindKey), siblingKindEncoded);
  const restored = runtime.select(conversationId);
  assert.equal(restored.dirty, true);
  assert.equal(restored.status, "retryable");
  assert.equal(restored.draft.kind, "replaced");
  assert.equal(restored.draft.content.text, "retained private draft");
});

test("corrupt active records quarantine only that identity and delayed old identities stay inert", async () => {
  const rows = new Map();
  const activeIdentity = identity();
  const siblingIdentity = identity("writer-b", "device-b");
  const kind = ApplicationChatStorageRecordKind.queuedDraftIntents;
  rows.set(storageKey(activeIdentity, kind), "{malformed");
  rows.set(storageKey(siblingIdentity, kind), encodeApplicationChatStorageRecord(
    makeRecord(siblingIdentity, input({ idempotencyKey: "sibling-key" })),
  ));
  const storage = createAtomicStorage(rows);
  const cache = createNormalizedChatCache(cacheIdentity());
  let active = scope(1, activeIdentity);
  const diagnostics = [];
  const runtime = createChatDraftRuntime({
    cache,
    snapshots: { async getConversationDraft() { throw new Error("not expected"); } },
    async dispatch() { throw new Error("not expected"); },
    persistence: {
      storage,
      getActiveScope: () => active,
      isActiveScope: (candidate) => candidate.generation === active.generation &&
        candidate.identity.userId === active.identity.userId,
      isRecoveryReady: () => false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  await runtime.activateRetained(active);
  assert.equal(rows.has(storageKey(activeIdentity, kind)), false);
  assert.equal(rows.has(storageKey(siblingIdentity, kind)), true);
  assert.deepEqual(diagnostics.map(({ code }) => code), ["draft_intents_rejected"]);

  const oldRead = deferred();
  const oldScope = scope(2, activeIdentity);
  const newIdentity = identity("writer-new", "device-new");
  const newScope = scope(3, newIdentity);
  const delayed = createHarness({
    initialScope: oldScope,
    record: makeRecord(oldScope.identity),
    read: async (candidate, _kind, records) => candidate.userId === oldScope.identity.userId
      ? oldRead.promise
      : records.get(storageKey(candidate, kind)) ?? null,
  });
  const activation = delayed.runtime.activateRetained(oldScope);
  delayed.cache.setIdentity(cacheIdentity(newIdentity.userId));
  delayed.setScope(newScope);
  await delayed.runtime.activateRetained(newScope);
  oldRead.resolve(encodeApplicationChatStorageRecord(makeRecord(oldScope.identity)));
  await activation;
  assert.equal(delayed.cache.getState().currentUser.drafts[conversationId], undefined);
  assert.equal(delayed.dispatches.length, 0);
  assert.equal(delayed.records.has(storageKey(oldScope.identity, kind)), true);

  const completing = createHarness({ initialScope: oldScope, ready: true });
  await completing.runtime.activateRetained(oldScope);
  await eventually(() => completing.dispatches.length === 1);
  completing.cache.setIdentity(cacheIdentity(newIdentity.userId));
  completing.setScope(newScope);
  await completing.runtime.activateRetained(newScope);
  completing.dispatches[0].resolve({
    status: "success",
    value: resultFor(completing.dispatches[0].request),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completing.cache.getState().currentUser.drafts[conversationId], undefined);
  assert.equal(completing.records.has(storageKey(oldScope.identity, kind)), true);
  assert.equal(completing.dispatches.length, 1);
});
