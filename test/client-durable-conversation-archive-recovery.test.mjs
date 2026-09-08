import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedConversationArchiveIntent,
  createApplicationChatQueuedConversationArchiveIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-archive-recovery";
const actorId = "user-archive-recovery";
const conversationId = "conversation-archive-recovery";
const at = (second = 0) =>
  `2038-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;
const storageIdentity = (userId = actorId) => ({
  tenantId,
  userId,
  deviceId: `device-${userId}`,
});
const cacheIdentity = (userId = actorId) => ({
  tenantId,
  userId,
  sessionId: `session-${userId}`,
});
const storageKey = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
const metadata = (realtime = false) => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: realtime
    ? { realtime: true, conversation_snapshots: true }
    : { conversation_snapshots: true },
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};
const retainedWait = (_delay, signal) => new Promise((_resolve, reject) => {
  if (signal.aborted) return reject(new Error("aborted"));
  signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});

class CoordinationClock {
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

class CoordinationChannelHub {
  channels = new Set();
  messages = [];
  deferredKinds = new Set();
  deferred = [];

  factory = (owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("construction failed");
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      listeners,
      postMessage: (message) => {
        if (behavior.postThrows) throw new Error("posting failed");
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        if (this.deferredKinds.has(cloned.kind)) {
          this.deferred.push({ channel, message: cloned });
          return;
        }
        this.deliver(channel, cloned);
      },
      addEventListener: (_type, listener) => {
        if (behavior.listenThrows) throw new Error("listening failed");
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => {
        channel.closed = true;
        this.channels.delete(channel);
      },
    };
    this.channels.add(channel);
    return channel;
  };

  deliver(sender, message) {
    for (const peer of [...this.channels]) {
      if (peer !== sender && !peer.closed && peer.name === sender.name) {
        for (const listener of peer.listeners) {
          listener({ data: structuredClone(message) });
        }
      }
    }
  }

  release(kind) {
    this.deferredKinds.delete(kind);
    const releasing = this.deferred.filter((item) => item.message.kind === kind);
    this.deferred = this.deferred.filter((item) => item.message.kind !== kind);
    for (const item of releasing) this.deliver(item.channel, item.message);
  }
}

const coordinationTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

const detail = ({
  id = conversationId,
  userId = actorId,
  archived = false,
  updatedAt = at(1),
} = {}) => ({
  kind: "conversation_detail",
  conversation: {
    id,
    tenantId,
    type: "channel",
    visibility: "public",
    name: `Channel ${id}`,
    createdAt: at(0),
    updatedAt,
    ...(archived
      ? { archivedAt: updatedAt, archivedByUserId: userId }
      : {}),
    latestSequence: 0,
    activityAt: at(0),
    unreadMentionCount: 0,
    activeMemberUserIds: [userId],
    memberUserIds: [userId],
    memberListRevision: 1,
    currentMember: {
      tenantId,
      conversationId: id,
      userId,
      role: "owner",
      state: "active",
      joinedAt: at(0),
      updatedAt,
    },
    currentReadState: {
      conversationId: id,
      userId,
      lastReadSequence: 0,
      updatedAt,
    },
    currentPreference: {
      conversationId: id,
      userId,
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: false },
      updatedAt,
    },
  },
  _meta: {
    ...metadata(),
    feature: { name: "conversation_snapshots", version: 1 },
  },
});

function seedCache({ userId = actorId, archived = false, revision = 1, id = conversationId } = {}) {
  const cache = createNormalizedChatCache(cacheIdentity(userId));
  cache.hydrateConversationDetail(detail({ id, userId, archived, updatedAt: at(revision) }));
  if (revision > 1) {
    const request = archiveRequest({
      intent: archived ? "archive" : "restore",
      conversationId: id,
      expectedLifecycleRevision: revision - 1,
      idempotencyKey: `seed-${id}-${revision}`,
    });
    cache.reconcileConversationArchive("seed", request, archiveResult(request, {
      lifecycleRevision: revision,
      archiveState: archived
        ? {
            status: "archived",
            archivedAt: at(revision),
            archivedByUserId: userId,
          }
        : { status: "active" },
    }));
  }
  return cache;
}

const archiveRequest = (overrides = {}) => ({
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId,
  expectedLifecycleRevision: 1,
  idempotencyKey: "retained-archive-key",
  ...overrides,
});

const archiveResult = (input, overrides = {}) => ({
  operation: input.operation,
  intent: input.intent,
  reconciliationStatus: "applied",
  conversationId: input.conversationId,
  expectedLifecycleRevision: input.expectedLifecycleRevision,
  lifecycleRevision: input.expectedLifecycleRevision + 1,
  archiveState: input.intent === "archive"
    ? {
        status: "archived",
        archivedAt: at(input.expectedLifecycleRevision + 1),
        archivedByUserId: actorId,
      }
    : { status: "active" },
  ...overrides,
});

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let replaceGate;
  let nextArchiveCompareExchangeGate;
  let archiveReadGate;
  let archiveReadGateUser;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      if (
        kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
        archiveReadGate !== undefined &&
        (archiveReadGateUser === undefined || archiveReadGateUser === scope.userId)
      ) {
        const gate = archiveReadGate;
        archiveReadGate = undefined;
        await gate.promise;
      }
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope: structuredClone(scope), kind, encoded });
      if (
        kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
        replaceGate !== undefined
      ) await replaceGate.promise;
      rows.set(storageKey(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
      rows.delete(storageKey(scope, kind));
    },
    async compareExchange(scope, kind, expectedEncoded, replacementEncoded) {
      const call = {
        operation: "compareExchange",
        scope: structuredClone(scope),
        kind,
        expectedEncoded,
        encoded: replacementEncoded,
        succeeded: undefined,
      };
      calls.push(call);
      if (
        kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
        (replaceGate !== undefined || nextArchiveCompareExchangeGate !== undefined)
      ) {
        const gate = nextArchiveCompareExchangeGate ?? replaceGate;
        nextArchiveCompareExchangeGate = undefined;
        await gate.promise;
      }
      const key = storageKey(scope, kind);
      const current = rows.get(key) ?? null;
      if (current !== expectedEncoded) {
        call.succeeded = false;
        return false;
      }
      if (replacementEncoded === null) rows.delete(key);
      else rows.set(key, replacementEncoded);
      call.succeeded = true;
      return true;
    },
    async clearForLogout() {},
  });
  return {
    rows,
    calls,
    storage,
    gateReplaces(gate) { replaceGate = gate; },
    gateNextArchiveRead(gate, userId) {
      archiveReadGate = gate;
      archiveReadGateUser = userId;
    },
    gateNextArchiveCompareExchange(gate) {
      nextArchiveCompareExchangeGate = gate;
    },
    archiveCompareExchanges(userId = actorId) {
      return calls.filter((call) => call.operation === "compareExchange" &&
        call.kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
        call.scope.userId === userId);
    },
    archiveWrites(userId = actorId) {
      return calls.filter((call) =>
        (call.operation === "replace" || call.operation === "compareExchange") &&
        call.encoded !== null &&
        call.kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
        call.scope.userId === userId);
    },
  };
}

async function seedIntent(harness, scope, request) {
  await harness.storage.replace(createApplicationChatQueuedConversationArchiveIntentsRecord(
    scope,
    [createApplicationChatQueuedConversationArchiveIntent(request, {
      enqueueOrder: 1,
      enqueuedAt: at(5),
    })],
  ));
}

async function seedSnapshot(harness, scope, cache) {
  await harness.storage.replace(createApplicationChatNormalizedSnapshotRecord(
    scope,
    cache.getState(),
  ));
}

function createSockets(scope, initiallyOnline = true) {
  const sockets = [];
  const listeners = { online: new Set(), offline: new Set() };
  let online = initiallyOnline;
  return {
    sockets,
    network: {
      isOnline: () => online,
      addEventListener(type, listener) { listeners[type].add(listener); },
      removeEventListener(type, listener) { listeners[type].delete(listener); },
    },
    goOnline() {
      online = true;
      for (const listener of [...listeners.online]) listener();
    },
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
  identityRef = { current: storageIdentity() },
  cache = seedCache({ userId: identityRef.current.userId }),
  command,
  authority,
  key = "generated-archive-key",
  recovery = {},
  sockets,
  crossTab,
  start = true,
} = {}) {
  const requests = [];
  const diagnostics = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: {
      generateIdempotencyKey: typeof key === "function" ? key : () => key,
      retainedRecovery: {
        initialDelayMs: 2,
        maximumDelayMs: 4,
        wait: retainedWait,
        ...recovery,
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) {
        return response(200, metadata(sockets !== undefined));
      }
      if (init.method === "GET") {
        const id = decodeURIComponent(String(url).split("/").at(-1));
        requests.push({ kind: "authority", id, scope: identityRef.current });
        return authority?.(id, requests) ?? response(200, detail({
          id,
          userId: identityRef.current.userId,
        }));
      }
      const body = JSON.parse(init.body);
      const observed = { kind: "archive", body, init, scope: identityRef.current };
      requests.push(observed);
      return command?.(observed, requests) ?? response(200, archiveResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    ...(crossTab === undefined ? {} : { crossTab }),
    ...(sockets === undefined ? {} : {
      realtime: {
        network: sockets.network,
        webSocketFactory: sockets.factory,
        retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
      },
    }),
  });
  if (start) {
    const started = await client.start();
    assert.equal(started.state, "ready", JSON.stringify({ started, requests }));
  }
  return { client, cache, harness, identityRef, requests, diagnostics };
}

const archiveRequests = (fixture) =>
  fixture.requests.filter((request) => request.kind === "archive");

test("persists complete input before projection or fetch and checkpoints canonical state", async () => {
  const harness = createStorageHarness();
  const persistGate = deferred();
  const commandGate = deferred();
  const fixture = await createFixture({
    harness,
    command: () => commandGate.promise,
  });
  harness.gateReplaces(persistGate);
  const pending = fixture.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => harness.archiveWrites().length === 1);
  assert.equal(archiveRequests(fixture).length, 0);
  assert.deepEqual(fixture.cache.getState().metadata.pendingConversationOperations, {});
  const stored = JSON.parse(harness.archiveWrites()[0].encoded);
  assert.deepEqual(stored.payload.intents[0], {
    contractVersion: 1,
    enqueueOrder: 1,
    enqueuedAt: stored.payload.intents[0].enqueuedAt,
    operation: "set_conversation_archive",
    intent: "archive",
    conversationId,
    expectedLifecycleRevision: 1,
    idempotencyKey: "generated-archive-key",
  });
  persistGate.resolve();
  await eventually(() => archiveRequests(fixture).length === 1);
  assert.equal(Object.keys(
    fixture.cache.getState().metadata.pendingConversationOperations,
  ).length, 1);
  await eventually(() => harness.calls.some((call) => call.operation === "replace" &&
    call.kind === ApplicationChatStorageRecordKind.normalizedSnapshot));
  const checkpoint = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(checkpoint.snapshot.metadata.pendingConversationOperations, {});
  commandGate.resolve(response(200, archiveResult(archiveRequests(fixture)[0].body)));
  assert.equal((await pending).status, "success");
  fixture.client.close();
});

test("reload replays exact archive and restore inputs and settles already-equal authority", async () => {
  for (const intent of ["archive", "restore"]) {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = archiveRequest({
      intent,
      expectedLifecycleRevision: 7,
      idempotencyKey: `exact-${intent}-key`,
    });
    await seedSnapshot(harness, scope, seedCache({
      archived: intent === "restore",
      revision: 7,
    }));
    await seedIntent(harness, scope, request);
    const fixture = await createFixture({ harness, cache: createNormalizedChatCache() });
    await eventually(() => archiveRequests(fixture).length === 1);
    assert.deepEqual(archiveRequests(fixture)[0].body, request);
    assert.equal(
      archiveRequests(fixture)[0].init.headers["idempotency-key"],
      request.idempotencyKey,
    );
    fixture.client.close();
  }

  const harness = createStorageHarness();
  const scope = storageIdentity();
  await seedSnapshot(harness, scope, seedCache({ archived: true, revision: 4 }));
  await seedIntent(harness, scope, archiveRequest({
    expectedLifecycleRevision: 3,
    idempotencyKey: "already-equal-key",
  }));
  const fixture = await createFixture({ harness, cache: createNormalizedChatCache() });
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ) === null);
  assert.equal(archiveRequests(fixture).length, 0);
  fixture.client.close();
});

test("canonical event wins an in-flight request and newer divergent authority conflicts", async () => {
  const harness = createStorageHarness();
  const sockets = createSockets(storageIdentity());
  const commandGate = deferred();
  const fixture = await createFixture({
    harness,
    sockets,
    command: () => commandGate.promise,
    authority: () => response(200, detail({ archived: true, updatedAt: at(2) })),
  });
  sockets.sockets[0].accept();
  const pending = fixture.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => archiveRequests(fixture).length === 1);
  sockets.sockets[0].event({
    eventId: "event-archive-2",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: "conversation.archived",
    occurredAt: at(2),
    payload: {
      conversationId,
      intent: "archive",
      previousState: "active",
      currentState: "archived",
      previousLifecycleRevision: 1,
      currentLifecycleRevision: 2,
    },
  });
  const eventResult = await pending;
  assert.equal(eventResult.status, "success");
  assert.equal(eventResult.value.reconciliationStatus, "replayed");
  assert.equal(commandGate.promise instanceof Promise, true);
  fixture.client.close();

  const conflictHarness = createStorageHarness();
  const scope = storageIdentity();
  await seedSnapshot(conflictHarness, scope, seedCache({ revision: 3 }));
  const conflict = await createFixture({
    harness: conflictHarness,
    cache: createNormalizedChatCache(),
    key: "newer-conflict-key",
  });
  const conflictResult = await conflict.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  assert.equal(conflictResult.status, "success");
  assert.equal(conflictResult.value.reconciliationStatus, "lifecycle_conflict");
  assert.equal(conflictResult.value.lifecycleRevision, 3);
  await eventually(async () => await conflictHarness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ) === null);
  assert.equal(archiveRequests(conflict).length, 0);
  assert.deepEqual(conflict.cache.getState().metadata.lifecycleRevisions, {
    [conversationId]: 3,
  });
  conflict.client.close();
});

test("ambiguous outcomes retain with bounded backoff while terminal outcomes remove", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  await seedSnapshot(harness, scope, seedCache());
  await seedIntent(harness, scope, archiveRequest());
  const delays = [];
  const stop = deferred();
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    command: () => response(200, { malformed: true }),
    recovery: {
      initialDelayMs: 2,
      maximumDelayMs: 4,
      multiplier: 3,
      wait: async (delay, signal) => {
        delays.push(delay);
        if (delays.length < 3) return;
        await Promise.race([
          stop.promise,
          new Promise((_, reject) => signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          )),
        ]);
      },
    },
  });
  await eventually(() => delays.length === 3);
  assert.deepEqual(delays, [2, 4, 4]);
  assert.notEqual(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ), null);
  fixture.client.close();

  const terminalHarness = createStorageHarness();
  await seedSnapshot(terminalHarness, scope, seedCache());
  await seedIntent(terminalHarness, scope, archiveRequest({ idempotencyKey: "terminal-key" }));
  const terminal = await createFixture({
    harness: terminalHarness,
    cache: createNormalizedChatCache(),
    command: () => response(403, {
      error: { code: "CHAT_PERMISSION_DENIED", message: "denied" },
    }),
  });
  await eventually(async () => await terminalHarness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ) === null);
  assert.equal(archiveRequests(terminal).length, 1);
  terminal.client.close();
});

test("offline recovery waits for reconnect and corrupt records are quarantined", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  await seedSnapshot(harness, scope, seedCache());
  await seedIntent(harness, scope, archiveRequest());
  const sockets = createSockets(scope, false);
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    sockets,
  });
  assert.equal(archiveRequests(fixture).length, 0);
  assert.equal(sockets.sockets.length, 0);
  sockets.goOnline();
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => archiveRequests(fixture).length === 1);
  fixture.client.close();

  const corrupt = createStorageHarness();
  corrupt.rows.set(
    storageKey(scope, ApplicationChatStorageRecordKind.queuedConversationArchiveIntents),
    "{not-json",
  );
  const rejected = await createFixture({ harness: corrupt });
  await eventually(() => rejected.diagnostics.some((diagnostic) =>
    diagnostic.code === "conversation_archive_intents_rejected"));
  assert.equal(corrupt.rows.has(storageKey(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  )), false);
  assert.equal(archiveRequests(rejected).length, 0);
  rejected.client.close();
});

test("delayed old-identity storage work cannot project or dispatch in the new scope", async () => {
  const harness = createStorageHarness();
  const oldScope = storageIdentity("old-user");
  const newScope = storageIdentity("new-user");
  await seedSnapshot(harness, oldScope, seedCache({ userId: oldScope.userId }));
  await seedSnapshot(harness, newScope, seedCache({ userId: newScope.userId }));
  await seedIntent(harness, oldScope, archiveRequest({ idempotencyKey: "old-key" }));
  await seedIntent(harness, newScope, archiveRequest({ idempotencyKey: "new-key" }));
  const gate = deferred();
  harness.gateNextArchiveRead(gate, oldScope.userId);
  const identityRef = { current: oldScope };
  const fixture = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(),
    start: false,
  });
  const oldStart = fixture.client.start();
  await eventually(() => harness.calls.some((call) => call.operation === "read" &&
    call.kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
    call.scope.userId === oldScope.userId));
  fixture.client.close();
  identityRef.current = newScope;
  const newStart = fixture.client.start();
  gate.resolve();
  assert.equal((await oldStart).state, "idle");
  assert.equal((await newStart).state, "ready");
  await eventually(() => archiveRequests(fixture).length === 1);
  assert.equal(archiveRequests(fixture)[0].body.idempotencyKey, "new-key");
  assert.equal(archiveRequests(fixture)[0].scope.userId, newScope.userId);
  fixture.client.close();
});

test("atomic contention retains archive intents for distinct conversations", async () => {
  const firstConversationId = "conversation-archive-contention-a";
  const secondConversationId = "conversation-archive-contention-b";
  const createContentionCache = () => {
    const cache = seedCache({ id: firstConversationId });
    cache.hydrateConversationDetail(detail({ id: secondConversationId }));
    return cache;
  };
  const harness = createStorageHarness();
  const commandGate = deferred();
  const first = await createFixture({
    harness,
    cache: createContentionCache(),
    key: "distinct-archive-key-a",
    command: () => commandGate.promise,
  });
  const second = await createFixture({
    harness,
    cache: createContentionCache(),
    key: "distinct-archive-key-b",
    command: () => commandGate.promise,
  });
  const firstCommitGate = deferred();
  harness.gateNextArchiveCompareExchange(firstCommitGate);

  const firstPending = first.client.archiveConversation({
    conversationId: firstConversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => harness.archiveCompareExchanges().length === 1);
  const secondPending = second.client.archiveConversation({
    conversationId: secondConversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "distinct-archive-key-b");
  firstCommitGate.resolve();

  let retained;
  await eventually(async () => {
    retained = await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
    );
    return retained?.intents.length === 2;
  });
  assert.deepEqual(retained.intents.map((intent) => ({
    enqueueOrder: intent.enqueueOrder,
    conversationId: intent.request.conversationId,
    expectedLifecycleRevision: intent.request.expectedLifecycleRevision,
    idempotencyKey: intent.request.idempotencyKey,
  })), [
    {
      enqueueOrder: 1,
      conversationId: secondConversationId,
      expectedLifecycleRevision: 1,
      idempotencyKey: "distinct-archive-key-b",
    },
    {
      enqueueOrder: 2,
      conversationId: firstConversationId,
      expectedLifecycleRevision: 1,
      idempotencyKey: "distinct-archive-key-a",
    },
  ]);
  assert.equal(harness.archiveCompareExchanges().some((call) =>
    call.succeeded === false), true, "the delayed writer must retry stale state");

  first.client.close();
  second.client.close();
  await Promise.all([firstPending, secondPending]);
});

test("archive and restore contention retains the latest committed request exactly", async () => {
  const harness = createStorageHarness();
  const commandGate = deferred();
  const archive = await createFixture({
    harness,
    cache: seedCache(),
    key: "contended-archive-key",
    command: () => commandGate.promise,
    sockets: createSockets(storageIdentity(), false),
  });
  const restore = await createFixture({
    harness,
    cache: seedCache({ archived: true, revision: 7 }),
    key: "contended-restore-key",
    command: () => commandGate.promise,
    sockets: createSockets(storageIdentity(), false),
  });
  const archiveCommitGate = deferred();
  harness.gateNextArchiveCompareExchange(archiveCommitGate);

  const archivePending = archive.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => harness.archiveCompareExchanges().length === 1);
  const restorePending = restore.client.restoreConversation({
    conversationId,
    expectedLifecycleRevision: 7,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "contended-restore-key");
  const restoreRecord = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  );
  archiveCommitGate.resolve();

  let retained;
  await eventually(async () => {
    retained = await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
    );
    return retained?.intents[0]?.request.idempotencyKey ===
      "contended-archive-key";
  });
  assert.equal(retained.intents.length, 1);
  assert.deepEqual(retained.intents[0].request, archiveRequest({
    expectedLifecycleRevision: 1,
    idempotencyKey: "contended-archive-key",
  }));
  assert.equal(retained.intents[0].enqueueOrder, restoreRecord.intents[0].enqueueOrder);
  assert.equal(retained.intents[0].enqueuedAt, restoreRecord.intents[0].enqueuedAt);

  archive.client.close();
  restore.client.close();
  await Promise.all([archivePending, restorePending]);
});

test("a stale canonical settlement cannot remove a concurrent replacement", async () => {
  const harness = createStorageHarness();
  const sockets = createSockets(storageIdentity());
  const oldCommandGate = deferred();
  const authorityGate = deferred();
  const old = await createFixture({
    harness,
    cache: seedCache(),
    sockets,
    key: "stale-canonical-key",
    command: () => oldCommandGate.promise,
    authority: () => authorityGate.promise,
  });
  const replacementCommandGate = deferred();
  const replacement = await createFixture({
    harness,
    cache: seedCache(),
    key: "canonical-replacement-key",
    command: () => replacementCommandGate.promise,
  });
  sockets.sockets[0].accept();

  const oldPending = old.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => archiveRequests(old).length === 1);
  sockets.sockets[0].event({
    eventId: "event-stale-canonical-archive",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: "conversation.archived",
    occurredAt: at(2),
    payload: {
      conversationId,
      intent: "archive",
      previousState: "active",
      currentState: "archived",
      previousLifecycleRevision: 1,
      currentLifecycleRevision: 2,
    },
  });
  await eventually(() => old.requests.some((request) => request.kind === "authority"));

  const replacementPending = replacement.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "canonical-replacement-key");
  authorityGate.resolve(response(200, detail({ archived: true, updatedAt: at(2) })));
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "canonical-replacement-key");

  const retained = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  );
  assert.equal(retained.intents.length, 1);
  assert.equal(retained.intents[0].request.idempotencyKey, "canonical-replacement-key");
  old.client.close();
  replacement.client.close();
  await Promise.all([oldPending, replacementPending]);
});

test("a stale coordinated settlement retains its replacement and sanitized announcements", async () => {
  const harness = createStorageHarness();
  const clock = new CoordinationClock();
  const hub = new CoordinationChannelHub();
  hub.deferredKinds.add("persisted-command-available");
  const authorityGate = deferred();
  const keys = ["stale-coordinated-key", "coordinated-replacement-key"];
  const crossTab = (tabId) => ({
    sessionFingerprint: "archive-stale-coordinated-scope",
    tabId,
    clock,
    timing: coordinationTiming,
    channelFactory: hub.factory(tabId),
  });
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    crossTab: crossTab("tab-a"),
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    key: () => keys.shift(),
    authority: () => authorityGate.promise,
    crossTab: crossTab("tab-b"),
  });
  clock.tick(coordinationTiming.electionDelayMs);
  assert.equal(leader.client.coordination?.role, "leader");
  assert.equal(follower.client.coordination?.role, "follower");

  const stalePending = follower.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "stale-coordinated-key");
  const leaderEnvelope = hub.messages.findLast((message) =>
    message.senderId === "tab-a" && message.leaderId === "tab-a");
  const leaderChannel = [...hub.channels].find((channel) => channel.owner === "tab-a");
  assert.notEqual(leaderEnvelope, undefined);
  assert.notEqual(leaderChannel, undefined);
  hub.deliver(leaderChannel, {
    ...leaderEnvelope,
    kind: "command-result",
    payload: {
      command: "conversation.archive.set",
      idempotencyKey: "stale-coordinated-key",
      result: { status: "success", value: { authorityRefresh: true } },
    },
  });
  await eventually(() => follower.requests.some((request) =>
    request.kind === "authority"));

  const replacementPending = follower.client.restoreConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "coordinated-replacement-key");
  assert.equal((await stalePending).status, "closed");
  authorityGate.resolve(response(200, detail({ archived: true, updatedAt: at(2) })));
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "coordinated-replacement-key");

  const announcements = hub.messages.filter((message) =>
    message.kind === "persisted-command-available" &&
    (message.payload.idempotencyKey === "stale-coordinated-key" ||
      message.payload.idempotencyKey === "coordinated-replacement-key"));
  assert.equal(announcements.length, 2);
  assert.deepEqual(announcements.map((message) => message.payload), [
    {
      command: "conversation.archive.set",
      idempotencyKey: "stale-coordinated-key",
    },
    {
      command: "conversation.archive.set",
      idempotencyKey: "coordinated-replacement-key",
    },
  ]);
  assert.equal(JSON.stringify(announcements).includes(conversationId), false);

  leader.client.close();
  follower.client.close();
  await replacementPending;
});

test("a stale HTTP completion cannot remove a concurrent replacement", async () => {
  const harness = createStorageHarness();
  const oldCommandGate = deferred();
  const replacementCommandGate = deferred();
  const old = await createFixture({
    harness,
    cache: seedCache(),
    key: "stale-http-key",
    command: () => oldCommandGate.promise,
  });
  const replacement = await createFixture({
    harness,
    cache: seedCache(),
    key: "http-replacement-key",
    command: () => replacementCommandGate.promise,
  });

  const oldPending = old.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => archiveRequests(old).length === 1);
  const replacementPending = replacement.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => archiveRequests(replacement).length === 1);
  oldCommandGate.resolve(response(200, archiveResult(archiveRequest({
    idempotencyKey: "stale-http-key",
  }))));
  assert.equal((await oldPending).status, "closed");

  const retained = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  );
  assert.equal(retained.intents.length, 1);
  assert.equal(retained.intents[0].request.idempotencyKey, "http-replacement-key");
  old.client.close();
  replacement.client.close();
  await replacementPending;
});

test("a follower announces only an archive correlation and the leader dispatches it once", async () => {
  const harness = createStorageHarness();
  const clock = new CoordinationClock();
  const hub = new CoordinationChannelHub();
  let authoritativeArchived = false;
  const command = ({ body }) => {
    authoritativeArchived = body.intent === "archive";
    return response(200, archiveResult(body));
  };
  const authority = (id) => response(200, detail({
    id,
    archived: authoritativeArchived,
    updatedAt: authoritativeArchived ? at(2) : at(1),
  }));
  const crossTab = (tabId) => ({
    sessionFingerprint: "archive-two-tab-scope",
    tabId,
    clock,
    timing: coordinationTiming,
    channelFactory: hub.factory(tabId),
  });
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    command,
    authority,
    key: "follower-archive-key",
    crossTab: crossTab("tab-a"),
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    command,
    authority,
    key: "follower-archive-key",
    crossTab: crossTab("tab-b"),
  });
  clock.tick(coordinationTiming.electionDelayMs);
  assert.equal(leader.client.coordination?.role, "leader");
  assert.equal(follower.client.coordination?.role, "follower");

  const first = follower.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  const duplicate = follower.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "follower-archive-key"));
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "follower-archive-key"));
  clock.tick(coordinationTiming.commandClaimDelayMs);
  assert.equal((await first).status, "success");
  assert.equal((await duplicate).status, "success");
  await eventually(() => archiveRequests(leader).length === 1);
  assert.equal(archiveRequests(follower).length, 0);

  const announcements = hub.messages.filter((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "follower-archive-key");
  assert.ok(announcements.length >= 1);
  for (const announcement of announcements) {
    assert.deepEqual(announcement.payload, {
      command: "conversation.archive.set",
      idempotencyKey: "follower-archive-key",
    });
  }
  assert.equal(JSON.stringify(announcements).includes(conversationId), false);
  assert.deepEqual(
    hub.messages.findLast((message) =>
      message.kind === "command-result" &&
      message.payload.idempotencyKey === "follower-archive-key")?.payload.result,
    { status: "success", value: { authorityRefresh: true } },
  );
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ) === null);
  leader.client.close();
  follower.client.close();
});

test("rapid archive then restore retains and coordinates only the latest exact key", async () => {
  const harness = createStorageHarness();
  const clock = new CoordinationClock();
  const hub = new CoordinationChannelHub();
  hub.deferredKinds.add("persisted-command-available");
  const keys = ["coalesced-archive-key", "coalesced-restore-key"];
  const crossTab = (tabId) => ({
    sessionFingerprint: "archive-coalescing-scope",
    tabId,
    clock,
    timing: coordinationTiming,
    channelFactory: hub.factory(tabId),
  });
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    key: () => keys.shift(),
    crossTab: crossTab("tab-a"),
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    key: () => keys.shift(),
    crossTab: crossTab("tab-b"),
  });
  clock.tick(coordinationTiming.electionDelayMs);

  const archive = follower.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ))?.intents[0]?.request.idempotencyKey === "coalesced-archive-key");
  const restore = follower.client.restoreConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  await eventually(async () => {
    const record = await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
    );
    return record?.intents.length === 1 &&
      record.intents[0].request.intent === "restore" &&
      record.intents[0].request.idempotencyKey === "coalesced-restore-key";
  });
  assert.equal((await archive).status, "closed");

  hub.release("persisted-command-available");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "coalesced-restore-key"));
  clock.tick(coordinationTiming.commandClaimDelayMs);
  assert.equal((await restore).status, "success");
  assert.equal(
    archiveRequests(leader).length + archiveRequests(follower).length,
    0,
    "the latest restore is settled from canonical active authority",
  );
  assert.equal(hub.messages.some((message) =>
    message.kind === "command-result" &&
    message.payload.idempotencyKey === "coalesced-archive-key"), false);
  assert.deepEqual(
    hub.messages.findLast((message) =>
      message.kind === "command-result" &&
      message.payload.idempotencyKey === "coalesced-restore-key")?.payload.result,
    { status: "success", value: { authorityRefresh: true } },
  );
  leader.client.close();
  follower.client.close();
});

test("leadership transfer honors the retained claim before one surviving dispatch", async () => {
  const harness = createStorageHarness();
  await seedSnapshot(harness, storageIdentity(), seedCache());
  await seedIntent(harness, storageIdentity(), archiveRequest({
    idempotencyKey: "transfer-archive-key",
  }));
  const clock = new CoordinationClock();
  const hub = new CoordinationChannelHub();
  const crossTab = (tabId) => ({
    sessionFingerprint: "archive-transfer-scope",
    tabId,
    clock,
    timing: coordinationTiming,
    channelFactory: hub.factory(tabId),
  });
  const first = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: crossTab("tab-a"),
  });
  const survivor = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    crossTab: crossTab("tab-b"),
  });
  clock.tick(coordinationTiming.electionDelayMs);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-a" &&
    message.payload.idempotencyKey === "transfer-archive-key"));
  assert.equal(archiveRequests(first).length, 0);
  first.client.close();
  clock.tick(coordinationTiming.electionDelayMs);
  assert.equal(survivor.client.coordination?.role, "leader");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-b" &&
    message.payload.idempotencyKey === "transfer-archive-key"));
  clock.tick(coordinationTiming.commandClaimLeaseMs +
    coordinationTiming.commandClaimDelayMs);
  await eventually(() => archiveRequests(survivor).length === 1);
  assert.equal(archiveRequests(first).length, 0);
  assert.equal(archiveRequests(survivor)[0].body.idempotencyKey, "transfer-archive-key");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  ) === null);
  survivor.client.close();
});

test("unavailable archive coordination fails open to exact local recovery", async () => {
  const clock = new CoordinationClock();
  const hub = new CoordinationChannelHub();
  const fixture = await createFixture({
    key: "fallback-archive-key",
    crossTab: {
      sessionFingerprint: "archive-fallback-scope",
      tabId: "tab-fallback",
      clock,
      timing: coordinationTiming,
      channelFactory: hub.factory("tab-fallback", { constructThrows: true }),
    },
  });
  assert.equal(fixture.client.coordination?.role, "fallback");
  const result = await fixture.client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(archiveRequests(fixture).length, 1);
  assert.equal(
    archiveRequests(fixture)[0].body.idempotencyKey,
    "fallback-archive-key",
  );
  fixture.client.close();
});
