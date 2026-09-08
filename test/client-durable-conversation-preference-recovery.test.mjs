import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedConversationPreferenceIntent,
  createApplicationChatQueuedConversationPreferenceIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserPreferenceState,
} from "../dist/client/index.js";
import {
  CHAT_DURABLE_EVENT_TYPES,
  CHAT_PROTOCOL_VERSION,
} from "../dist/index.js";

const tenantId = "tenant-preference-recovery";
const actorId = "user-preference-recovery";
const conversationId = "conversation-preference-recovery";
const at = (offset = 0) =>
  new Date(Date.UTC(2035, 0, 2, 3, 4, offset)).toISOString();
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
const snapshotMetadata = () => ({
  ...metadata(),
  feature: { name: "conversation_snapshots", version: 1 },
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
const retainedWait = (_delayMs, signal) => new Promise((_resolve, reject) => {
  if (signal.aborted) {
    reject(new Error("aborted"));
    return;
  }
  signal.addEventListener("abort", () => reject(new Error("aborted")), {
    once: true,
  });
});

class CrossTabClock {
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

class CrossTabChannelHub {
  channels = new Set();
  messages = [];

  factory = (owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("BroadcastChannel unavailable");
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      listeners,
      postMessage: (message) => {
        if (behavior.postThrows) throw new Error("BroadcastChannel post failed");
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        for (const peer of [...this.channels]) {
          if (peer !== channel && !peer.closed && peer.name === name) {
            for (const listener of peer.listeners) {
              listener({ data: structuredClone(cloned) });
            }
          }
        }
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => {
        channel.closed = true;
        this.channels.delete(channel);
      },
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

const preference = (overrides = {}) => ({
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  ...overrides,
});
const desired = (input) => ({
  notificationPreference: input.notificationPreference,
  isStarred: input.isStarred,
  mute: input.mute,
});
const preferenceRequest = (overrides = {}) => ({
  operation: "update_conversation_preference",
  conversationId,
  expectedPreferenceRevision: 0,
  idempotencyKey: "retained-preference-key",
  ...preference({ isStarred: true }),
  ...overrides,
});
const preferenceResult = (input, overrides = {}) => ({
  operation: "update_conversation_preference",
  reconciliationStatus: "applied",
  conversationId: input.conversationId,
  expectedPreferenceRevision: input.expectedPreferenceRevision,
  idempotencyKey: input.idempotencyKey,
  requestedPreference: desired(input),
  preferenceRevision: input.expectedPreferenceRevision + 1,
  preference: { ...desired(input), updatedAt: at(20) },
  ...overrides,
});

const detail = (userId = actorId, canonical = preference(), id = conversationId) => ({
  kind: "conversation_detail",
  conversation: {
    id,
    tenantId,
    type: "channel",
    visibility: "public",
    name: "Durable preferences",
    createdAt: at(0),
    updatedAt: at(0),
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
      updatedAt: at(0),
    },
    currentReadState: {
      conversationId: id,
      userId,
      lastReadSequence: 0,
      updatedAt: at(0),
    },
    currentPreference: {
      conversationId: id,
      userId,
      ...canonical,
      updatedAt: at(1),
    },
  },
  _meta: snapshotMetadata(),
});

function seedCache({ userId = actorId, revision = 0, canonical = preference() } = {}) {
  const cache = createNormalizedChatCache(cacheIdentity(userId));
  cache.hydrateConversationDetail(detail(userId, canonical));
  for (let current = 0; current < revision; current += 1) {
    const input = preferenceRequest({
      expectedPreferenceRevision: current,
      idempotencyKey: `seed-preference-${current}`,
      ...canonical,
    });
    cache.reconcileCurrentUserConversationPreference(
      input,
      preferenceResult(input, {
        preferenceRevision: current + 1,
        preference: { ...canonical, updatedAt: at(current + 2) },
      }),
    );
  }
  return cache;
}

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let preferenceReplaceGate;
  let preferenceReplaceFailure = false;
  const beforeReplace = async (kind) => {
    if (
      kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents &&
      preferenceReplaceGate !== undefined
    ) await preferenceReplaceGate.promise;
    if (
      kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents &&
      preferenceReplaceFailure
    ) throw new Error("preference storage unavailable");
  };
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      const call = {
        operation: "replace",
        scope: structuredClone(scope),
        kind,
        encoded,
      };
      calls.push(call);
      await beforeReplace(kind);
      rows.set(storageKey(scope, kind), encoded);
      call.persisted = true;
    },
    async compareExchange(scope, kind, expected, replacement) {
      const call = {
        operation: "compareExchange",
        scope: structuredClone(scope),
        kind,
        expected,
        replacement,
      };
      calls.push(call);
      if (replacement !== null) await beforeReplace(kind);
      // Compare and mutate together after any simulated storage delay.
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else {
        rows.set(key, replacement);
        call.persisted = true;
      }
      return true;
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
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
    setPreferenceReplaceGate(gate) { preferenceReplaceGate = gate; },
    setPreferenceReplaceFailure(value) { preferenceReplaceFailure = value; },
    preferenceWrites() {
      return calls.filter((call) =>
        call.persisted === true &&
        call.kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents);
    },
    preferenceWriteAttempts() {
      return calls.filter((call) =>
        (call.operation === "replace" ||
          (call.operation === "compareExchange" && call.replacement !== null)) &&
        call.kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents);
    },
  };
}

async function seedIntent(harness, scope, request) {
  await harness.storage.replace(
    createApplicationChatQueuedConversationPreferenceIntentsRecord(scope, [
      createApplicationChatQueuedConversationPreferenceIntent(request, {
        enqueueOrder: 1,
        enqueuedAt: at(0),
      }),
    ]),
  );
}

async function seedSnapshot(harness, scope, cache) {
  await harness.storage.replace(
    createApplicationChatNormalizedSnapshotRecord(scope, cache.getState()),
  );
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
        disconnect() {
          this.readyState = 3;
          this.onclose?.({});
        },
        event(value) { this.onmessage?.({ data: JSON.stringify(value) }); },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

const preferenceEvent = (input, result, userId = actorId) => ({
  eventId: `preference-event-${input.idempotencyKey}`,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.preferenceUpdated,
  occurredAt: at(30),
  payload: { actorUserId: userId, input, result },
});

async function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: storageIdentity() },
  cache = seedCache({ userId: identityRef.current.userId }),
  command,
  authority,
  keys = ["generated-preference-key"],
  sockets,
  recovery = {},
} = {}) {
  const requests = [];
  const diagnostics = [];
  let keyIndex = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationPreferences: {
      generateIdempotencyKey: () => keys[keyIndex++] ?? `generated-${keyIndex}`,
      now: () => Date.parse(at(10 + keyIndex)),
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) {
        return response(200, metadata(sockets !== undefined));
      }
      if (init.method === "GET") {
        const id = decodeURIComponent(String(url).split("/").at(-1));
        const observed = { kind: "authority", id, url, init };
        requests.push(observed);
        return authority?.(observed) ?? response(
          200,
          detail(identityRef.current.userId, preference(), id),
        );
      }
      const body = JSON.parse(init.body);
      const observed = {
        kind: "preference",
        url,
        init,
        body,
        identity: structuredClone(identityRef.current),
      };
      requests.push(observed);
      return command?.(observed, requests) ??
        response(200, preferenceResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      retainedConversationPreferenceRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 4,
        wait: retainedWait,
        ...recovery,
      },
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
  });
  const started = await client.start();
  assert.equal(started.state, "ready");
  return { client, cache, harness, identityRef, requests, diagnostics };
}

function createCrossTabPreferenceClient({
  tabId,
  clock,
  hub,
  harness,
  requests,
  command,
  behavior,
  keys,
}) {
  let keyIndex = 0;
  return createChatClient({
    endpoint: "https://chat.invalid/api",
    cache: seedCache(),
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationPreferences: {
      generateIdempotencyKey: () => keys[keyIndex++] ?? `generated-${tabId}-${keyIndex}`,
      now: () => Date.parse(at(10 + keyIndex)),
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
      if (init.method === "GET") {
        const id = decodeURIComponent(String(url).split("/").at(-1));
        requests.push({ tabId, kind: "authority", id });
        return response(200, detail(actorId, preference(), id));
      }
      const body = JSON.parse(init.body);
      const observed = {
        tabId,
        kind: "preference",
        body,
        signal: init.signal,
      };
      requests.push(observed);
      return command?.(observed) ?? response(200, preferenceResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => storageIdentity(),
      retainedConversationPreferenceRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 4,
        wait: retainedWait,
      },
    },
    crossTab: {
      sessionFingerprint: "preference-recovery-session",
      tabId,
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory(tabId, behavior),
    },
  });
}

const preferenceRequests = (fixture) =>
  fixture.requests.filter((request) => request.kind === "preference");

const crossTabPreferenceRequests = (requests) =>
  requests.filter((request) => request.kind === "preference");

test("durable preference persistence precedes projection, detail work, and exact replay", async () => {
  const gate = deferred();
  const command = deferred();
  const fixture = await createFixture({ command: () => command.promise });
  fixture.harness.setPreferenceReplaceGate(gate);

  const pending = fixture.client.updateConversationPreference({
    conversationId,
    ...preference({ notificationPreference: "mentions", isStarred: true }),
  });
  await eventually(() => fixture.harness.preferenceWriteAttempts().length === 1);
  assert.equal(fixture.harness.preferenceWrites().length, 0);
  assert.equal(selectCurrentUserPreferenceState(
    fixture.cache.getState(),
    conversationId,
  ).pending, undefined);
  assert.equal(fixture.requests.length, 0);

  gate.resolve();
  await eventually(() => preferenceRequests(fixture).length === 1);
  assert.equal(fixture.harness.preferenceWrites().length, 1);
  const request = preferenceRequests(fixture)[0].body;
  assert.equal(request.idempotencyKey, "generated-preference-key");
  const stored = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  );
  assert.deepEqual(stored.intents[0].request, request);
  const projected = selectCurrentUserPreferenceState(
    fixture.cache.getState(),
    conversationId,
  );
  assert.equal(projected.pending.idempotencyKey, request.idempotencyKey);
  assert.equal(projected.preference.isStarred, true);

  const checkpoint = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(checkpoint.snapshot.currentUser.pendingPreferenceUpdates, {});
  assert.equal(
    checkpoint.snapshot.currentUser.preferences[conversationId].isStarred,
    false,
  );

  command.resolve(response(200, preferenceResult(request)));
  assert.equal((await pending).status, "success");
  await eventually(async () => await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ) === null);
  fixture.client.close();
});

test("a preference storage failure fails closed before projection or dispatch", async () => {
  const fixture = await createFixture();
  fixture.harness.setPreferenceReplaceFailure(true);
  const result = await fixture.client.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  });
  assert.equal(result.status, "validation");
  assert.equal(fixture.harness.preferenceWriteAttempts().length, 1);
  assert.equal(fixture.harness.preferenceWrites().length, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(selectCurrentUserPreferenceState(
    fixture.cache.getState(),
    conversationId,
  ).pending, undefined);
  assert.equal(
    fixture.diagnostics.at(-1).code,
    "conversation_preference_intents_write_failed",
  );
  fixture.client.close();
});

test("new authored preference durably coalesces and supersedes in-flight work", async () => {
  const firstCommand = deferred();
  const latestCommand = deferred();
  const fixture = await createFixture({
    keys: ["preference-first", "preference-latest"],
    command: ({ body }) => body.idempotencyKey === "preference-first"
      ? firstCommand.promise
      : latestCommand.promise,
  });
  const first = fixture.client.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  });
  await eventually(() => preferenceRequests(fixture).length === 1);
  const latest = fixture.client.updateConversationPreference({
    conversationId,
    ...preference({ notificationPreference: "none", isStarred: false }),
  });
  await eventually(() => preferenceRequests(fixture).length === 2);
  const stored = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  );
  assert.equal(stored.intents.length, 1);
  assert.equal(stored.intents[0].request.idempotencyKey, "preference-latest");
  assert.equal(stored.intents[0].request.notificationPreference, "none");
  assert.equal((await first).status, "closed");
  latestCommand.resolve(response(
    200,
    preferenceResult(preferenceRequests(fixture)[1].body),
  ));
  assert.equal((await latest).status, "success");
  firstCommand.resolve(response(200, preferenceResult(preferenceRequests(fixture)[0].body)));
  fixture.client.close();
});

test("restart reconciles older, equal, already-equal, and newer authority", async (t) => {
  await t.test("older authority waits for hydration without projection or dispatch", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = preferenceRequest({ expectedPreferenceRevision: 1 });
    const cache = seedCache({ revision: 0 });
    await seedIntent(harness, scope, request);
    await seedSnapshot(harness, scope, cache);
    const delays = [];
    const fixture = await createFixture({
      harness,
      cache,
      recovery: {
        wait: (delay, signal) => {
          delays.push(delay);
          return retainedWait(delay, signal);
        },
      },
    });
    await eventually(() => fixture.requests.some((item) => item.kind === "authority"));
    await eventually(() => delays.length === 1);
    assert.equal(preferenceRequests(fixture).length, 0);
    assert.equal(selectCurrentUserPreferenceState(
      cache.getState(),
      conversationId,
    ).pending, undefined);
    assert.notEqual(await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    ), null);
    fixture.client.close();
  });

  await t.test("equal differing authority restores overlay and replays the exact key", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = preferenceRequest({ expectedPreferenceRevision: 1 });
    const cache = seedCache({ revision: 1 });
    await seedIntent(harness, scope, request);
    await seedSnapshot(harness, scope, cache);
    const fixture = await createFixture({ harness, cache });
    await eventually(() => preferenceRequests(fixture).length === 1);
    assert.equal(preferenceRequests(fixture)[0].body.idempotencyKey, request.idempotencyKey);
    await eventually(async () => await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    ) === null);
    fixture.client.close();
  });

  for (const [name, revision] of [["equal", 1], ["newer", 2]]) {
    await t.test(`${name} already-equal authority settles without replay`, async () => {
      const harness = createStorageHarness();
      const scope = storageIdentity();
      const canonical = preference({ isStarred: true });
      const request = preferenceRequest({
        expectedPreferenceRevision: 1,
        ...canonical,
      });
      const cache = seedCache({ revision, canonical });
      await seedIntent(harness, scope, request);
      await seedSnapshot(harness, scope, cache);
      const fixture = await createFixture({ harness, cache });
      await eventually(async () => await harness.storage.read(
        scope,
        ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
      ) === null);
      assert.equal(preferenceRequests(fixture).length, 0);
      fixture.client.close();
    });
  }

  await t.test("newer differing authority preserves an explicit canonical conflict", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = preferenceRequest({ expectedPreferenceRevision: 1 });
    const cache = seedCache({ revision: 2, canonical: preference() });
    await seedIntent(harness, scope, request);
    await seedSnapshot(harness, scope, cache);
    const fixture = await createFixture({ harness, cache });
    await eventually(() => selectCurrentUserPreferenceState(
      cache.getState(),
      conversationId,
    ).pending?.state === "conflict");
    const selected = selectCurrentUserPreferenceState(cache.getState(), conversationId);
    assert.equal(selected.authoritativeRevision, 2);
    assert.equal(selected.preference.isStarred, false);
    assert.equal(selected.authoritativePreference.isStarred, false);
    assert.equal(selected.pending.desiredPreference.isStarred, true);
    assert.notEqual(await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    ), null);
    assert.equal(preferenceRequests(fixture).length, 0);
    fixture.client.close();
  });
});

test("canonical preference event settles first and aborts duplicate HTTP work", async () => {
  const scope = storageIdentity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({ sockets, command: () => command.promise });
  const pending = fixture.client.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  });
  await eventually(async () => await fixture.harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ) !== null);
  assert.equal(preferenceRequests(fixture).length, 0, "disconnected realtime gates replay");
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  await eventually(() => preferenceRequests(fixture).length === 1);
  const request = preferenceRequests(fixture)[0].body;
  const canonical = preferenceResult(request);
  sockets.sockets[0].event(preferenceEvent(request, canonical));
  assert.equal((await pending).status, "success");
  await eventually(async () => await fixture.harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ) === null);
  assert.equal(preferenceRequests(fixture)[0].init.signal.aborted, true);
  command.resolve(response(200, canonical));
  fixture.client.close();
});

test("ambiguous outcomes remain durable and terminal outcomes are removed", async (t) => {
  const ambiguous = [
    ["transport", () => { throw new Error("network unavailable"); }],
    ["rate limit", () => response(429, { error: { code: "RATE_LIMITED", message: "later" } })],
    ["server", () => response(500, { error: { code: "SERVER_ERROR", message: "later" } })],
    ["malformed", () => response(200, {})],
  ];
  for (const [name, command] of ambiguous) {
    await t.test(name, async () => {
      const harness = createStorageHarness();
      const scope = storageIdentity();
      const request = preferenceRequest({ expectedPreferenceRevision: 1 });
      const cache = seedCache({ revision: 1 });
      await seedIntent(harness, scope, request);
      await seedSnapshot(harness, scope, cache);
      const fixture = await createFixture({ harness, cache, command });
      await eventually(() => preferenceRequests(fixture).length === 1);
      await eventually(() => selectCurrentUserPreferenceState(
        cache.getState(),
        conversationId,
      ).pending?.idempotencyKey === request.idempotencyKey);
      assert.notEqual(await harness.storage.read(
        scope,
        ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
      ), null);
      fixture.client.close();
    });
  }

  await t.test("close after dispatch retains the command", async () => {
    const command = deferred();
    const fixture = await createFixture({ command: () => command.promise });
    void fixture.client.updateConversationPreference({
      conversationId,
      ...preference({ isStarred: true }),
    });
    await eventually(() => preferenceRequests(fixture).length === 1);
    fixture.client.close();
    assert.notEqual(await fixture.harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    ), null);
    command.resolve(response(200, preferenceResult(preferenceRequests(fixture)[0].body)));
  });

  await t.test("disconnect cancellation after dispatch retains the command", async () => {
    const scope = storageIdentity();
    const sockets = createSockets(scope);
    const command = deferred();
    const fixture = await createFixture({ sockets, command: () => command.promise });
    const pending = fixture.client.updateConversationPreference({
      conversationId,
      ...preference({ isStarred: true }),
    });
    await eventually(() => sockets.sockets.length === 1);
    sockets.sockets[0].accept();
    await eventually(() => preferenceRequests(fixture).length === 1);
    sockets.sockets[0].disconnect();
    assert.equal((await pending).status, "closed");
    assert.notEqual(await fixture.harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    ), null);
    command.resolve(response(
      200,
      preferenceResult(preferenceRequests(fixture)[0].body),
    ));
    fixture.client.close();
  });

  const terminal = [
    ["authentication", 401, "UNAUTHORIZED"],
    ["permission", 403, "PERMISSION_DENIED"],
    ["feature disabled", 403, "CHAT_FEATURE_DISABLED"],
    ["unsupported", 404, "UNSUPPORTED"],
    ["rejected", 400, "INVALID_REQUEST"],
    ["definitive conflict", 409, "CONFLICT"],
  ];
  for (const [name, status, code] of terminal) {
    await t.test(name, async () => {
      const harness = createStorageHarness();
      const scope = storageIdentity();
      const request = preferenceRequest({ expectedPreferenceRevision: 1 });
      const cache = seedCache({ revision: 1 });
      await seedIntent(harness, scope, request);
      await seedSnapshot(harness, scope, cache);
      const fixture = await createFixture({
        harness,
        cache,
        command: () => response(status, { error: { code, message: name } }),
      });
      await eventually(async () => await harness.storage.read(
        scope,
        ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
      ) === null);
      fixture.client.close();
    });
  }

  await t.test("authored validation fails without creating a durable record", async () => {
    const fixture = await createFixture();
    const result = await fixture.client.updateConversationPreference({
      conversationId,
      ...preference({ notificationPreference: "invalid" }),
    });
    assert.equal(result.status, "validation");
    assert.equal(fixture.harness.preferenceWrites().length, 0);
    assert.equal(fixture.harness.preferenceWriteAttempts().length, 0);
    fixture.client.close();
  });
});

test("recovery backoff is bounded and pauses until realtime reconnects", async () => {
  const scope = storageIdentity();
  const sockets = createSockets(scope);
  const waits = [];
  const waiters = [];
  const fixture = await createFixture({
    sockets,
    command: () => { throw new Error("ambiguous transport"); },
    recovery: {
      initialDelayMs: 2,
      maximumDelayMs: 3,
      multiplier: 10,
      wait: (delay, signal) => {
        waits.push(delay);
        const waiter = deferred();
        waiters.push(waiter);
        signal.addEventListener("abort", () => waiter.reject(new Error("aborted")), {
          once: true,
        });
        return waiter.promise;
      },
    },
  });
  void fixture.client.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  });
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(preferenceRequests(fixture).length, 0);
  sockets.sockets[0].accept();
  await eventually(() => waits.length === 1);
  assert.deepEqual(waits, [2]);
  waiters[0].resolve();
  await eventually(() => waits.length === 2);
  assert.deepEqual(waits, [2, 3]);
  sockets.sockets[0].disconnect();
  waiters[1].resolve();
  const beforeReconnect = preferenceRequests(fixture).length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preferenceRequests(fixture).length, beforeReconnect);
  await eventually(() => sockets.sockets.length === 2);
  sockets.sockets[1].accept();
  await eventually(() => preferenceRequests(fixture).length > beforeReconnect);
  fixture.client.close();
});

test("a follower persists a preference before announcing and only the leader dispatches once", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const requests = [];
  const persistenceGate = deferred();
  const commandGate = deferred();
  const command = ({ body }) => commandGate.promise.then(() =>
    response(200, preferenceResult(body)));
  const leader = createCrossTabPreferenceClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    requests,
    command,
    keys: ["cross-tab-preference"],
  });
  const follower = createCrossTabPreferenceClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    requests,
    command,
    keys: ["cross-tab-preference"],
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.coordination?.role, "leader");
  assert.equal(follower.coordination?.role, "follower");

  harness.setPreferenceReplaceGate(persistenceGate);
  const pending = follower.updateConversationPreference({
    conversationId,
    ...preference({ notificationPreference: "mentions", isStarred: true }),
  });
  await eventually(() => harness.preferenceWriteAttempts().length === 1);
  assert.equal(harness.preferenceWrites().length, 0);
  assert.equal(hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.command === "conversation.preference.update"), false);
  assert.equal(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ), null);
  assert.equal(selectCurrentUserPreferenceState(
    follower.cache.getState(),
    conversationId,
  ).pending, undefined);

  persistenceGate.resolve();
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "cross-tab-preference"));
  assert.equal(harness.preferenceWrites().length, 1);
  const announcement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available");
  assert.deepEqual(announcement.payload, {
    command: "conversation.preference.update",
    idempotencyKey: "cross-tab-preference",
  });
  assert.deepEqual(Object.keys(announcement.payload).sort(), ["command", "idempotencyKey"]);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-preference"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => crossTabPreferenceRequests(requests).length === 1);
  assert.equal(crossTabPreferenceRequests(requests)[0].tabId, "tab-a");
  clock.tick(crossTabTiming.commandClaimLeaseMs * 2);
  assert.equal(crossTabPreferenceRequests(requests).length, 1);

  commandGate.resolve();
  assert.equal((await pending).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ) === null);
  assert.equal(crossTabPreferenceRequests(requests).length, 1);
  assert.equal(hub.messages.filter((message) =>
    message.kind === "command-result" &&
    message.payload.command === "conversation.preference.update").length, 1);
  const selected = selectCurrentUserPreferenceState(
    follower.cache.getState(),
    conversationId,
  );
  assert.equal(selected.pending, undefined);
  assert.equal(selected.preference.notificationPreference, "mentions");
  assert.equal(selected.preference.isStarred, true);
  leader.close();
  follower.close();
});

test("cross-tab preference coalescing keeps the latest desired correlation authoritative", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const requests = [];
  const firstCommand = deferred();
  const latestCommand = deferred();
  const command = ({ body }) => body.idempotencyKey === "cross-tab-preference-first"
    ? firstCommand.promise
    : latestCommand.promise;
  const leader = createCrossTabPreferenceClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    requests,
    command,
    keys: ["unused-leader"],
  });
  const follower = createCrossTabPreferenceClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    requests,
    command,
    keys: ["cross-tab-preference-first", "cross-tab-preference-latest"],
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);

  const first = follower.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-preference-first"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => crossTabPreferenceRequests(requests).length === 1);

  const latest = follower.updateConversationPreference({
    conversationId,
    ...preference({ notificationPreference: "none", isStarred: false }),
  });
  assert.equal((await first).status, "closed");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-preference-latest"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => crossTabPreferenceRequests(requests).length === 2);
  assert.deepEqual(
    crossTabPreferenceRequests(requests).map(({ tabId, body }) => ({
      tabId,
      idempotencyKey: body.idempotencyKey,
    })),
    [
      { tabId: "tab-a", idempotencyKey: "cross-tab-preference-first" },
      { tabId: "tab-a", idempotencyKey: "cross-tab-preference-latest" },
    ],
  );
  const retained = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  );
  assert.equal(retained.intents.length, 1);
  assert.equal(
    retained.intents[0].request.idempotencyKey,
    "cross-tab-preference-latest",
  );

  firstCommand.reject(new Error("ambiguous first request"));
  await new Promise((resolve) => setImmediate(resolve));
  const whileLatestPending = selectCurrentUserPreferenceState(
    leader.cache.getState(),
    conversationId,
  );
  assert.equal(
    whileLatestPending.pending.idempotencyKey,
    "cross-tab-preference-latest",
  );
  assert.equal(whileLatestPending.preference.notificationPreference, "none");
  assert.equal((await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  )).intents[0].request.idempotencyKey, "cross-tab-preference-latest");

  const latestRequest = crossTabPreferenceRequests(requests)[1].body;
  latestCommand.resolve(response(200, preferenceResult(latestRequest)));
  assert.equal((await latest).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ) === null);
  const finalState = selectCurrentUserPreferenceState(
    follower.cache.getState(),
    conversationId,
  );
  assert.equal(finalState.pending, undefined);
  assert.equal(finalState.preference.notificationPreference, "none");
  assert.equal(finalState.preference.isStarred, false);
  leader.close();
  follower.close();
});

test("preference leadership transfer retains ambiguous work and its exact correlation", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const requests = [];
  const oldResponse = deferred();
  const command = ({ tabId, body }) => tabId === "tab-a"
    ? oldResponse.promise
    : response(200, preferenceResult(body));
  const leader = createCrossTabPreferenceClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    requests,
    command,
    keys: ["unused-leader"],
  });
  const follower = createCrossTabPreferenceClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    requests,
    command,
    keys: ["cross-tab-preference-transfer"],
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  const pending = follower.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-preference-transfer"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => crossTabPreferenceRequests(requests).length === 1);

  leader.close();
  assert.equal(crossTabPreferenceRequests(requests)[0].signal.aborted, true);
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ), null);
  clock.tick(crossTabTiming.electionDelayMs);
  await eventually(() => follower.coordination?.role === "leader");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" && message.senderId === "tab-b"));
  clock.tick(crossTabTiming.commandClaimLeaseMs - 1);
  assert.equal(crossTabPreferenceRequests(requests).length, 1);
  clock.tick(crossTabTiming.commandClaimDelayMs + 1);
  await eventually(() => crossTabPreferenceRequests(requests).length === 2);
  assert.deepEqual(crossTabPreferenceRequests(requests).map(({ tabId, body }) => ({
    tabId,
    idempotencyKey: body.idempotencyKey,
  })), [
    { tabId: "tab-a", idempotencyKey: "cross-tab-preference-transfer" },
    { tabId: "tab-b", idempotencyKey: "cross-tab-preference-transfer" },
  ]);
  assert.equal((await pending).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ) === null);
  oldResponse.resolve(response(
    200,
    preferenceResult(crossTabPreferenceRequests(requests)[0].body),
  ));
  follower.close();
});

test("unavailable preference cross-tab transport remains single-tab fail-open", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const requests = [];
  const client = createCrossTabPreferenceClient({
    tabId: "tab-local",
    clock,
    hub,
    harness,
    requests,
    behavior: { constructThrows: true },
    keys: ["cross-tab-preference-fallback"],
  });
  assert.equal((await client.start()).state, "ready");
  assert.equal(client.coordination?.role, "fallback");
  assert.equal((await client.updateConversationPreference({
    conversationId,
    ...preference({ isStarred: true }),
  })).status, "success");
  assert.equal(crossTabPreferenceRequests(requests).length, 1);
  assert.equal(crossTabPreferenceRequests(requests)[0].tabId, "tab-local");
  assert.equal(hub.messages.length, 0);
  assert.equal(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ), null);
  client.close();
});

test("old-identity authority completion cannot project or settle in the new identity", async () => {
  const userB = "user-preference-b";
  const identityRef = { current: storageIdentity() };
  const harness = createStorageHarness();
  const requestA = preferenceRequest({ expectedPreferenceRevision: 1 });
  const cacheA = seedCache({ revision: 0 });
  await seedIntent(harness, identityRef.current, requestA);
  await seedSnapshot(harness, identityRef.current, cacheA);
  const authorityA = deferred();
  const fixture = await createFixture({
    harness,
    identityRef,
    cache: cacheA,
    authority: () => authorityA.promise,
  });
  await eventually(() => fixture.requests.some((request) => request.kind === "authority"));
  fixture.client.close();

  identityRef.current = storageIdentity(userB);
  const cacheB = seedCache({ userId: userB });
  await seedSnapshot(harness, identityRef.current, cacheB);
  assert.equal((await fixture.client.start()).state, "ready");
  authorityA.resolve(response(200, detail(actorId)));
  await new Promise((resolve) => setImmediate(resolve));
  const state = fixture.cache.getState();
  assert.equal(state.identity.userId, userB);
  assert.deepEqual(state.currentUser.pendingPreferenceUpdates, {});
  assert.equal(preferenceRequests(fixture).length, 0);
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  ), null);
  fixture.client.close();
});
