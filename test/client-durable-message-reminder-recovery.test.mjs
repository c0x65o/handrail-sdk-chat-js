import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedMessageReminderIntent,
  createApplicationChatQueuedMessageReminderIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserMessageReminderState,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-reminder-recovery";
const actorId = "user-reminder-recovery";
const conversationId = "conversation-reminder-recovery";
const messageId = "message-reminder-recovery";
const secondMessageId = "message-reminder-recovery-unrelated";
const at = (second = 0) =>
  `2038-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;
const due = (day = 1) => `2039-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
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
const pendingForever = new Promise(() => {});
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
  pendingDeliveries = [];
  paused = false;

  factory = (owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("construction failed");
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      listeners,
      postMessage: (message) => {
        if (channel.closed) return;
        if (behavior.postThrows) throw new Error("posting failed");
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        const deliver = () => {
          for (const peer of [...this.channels]) {
            if (peer === channel || peer.closed || peer.name !== name) continue;
            for (const listener of peer.listeners) {
              listener({ data: structuredClone(cloned) });
            }
          }
        };
        if (this.paused) this.pendingDeliveries.push(deliver);
        else deliver();
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

  flush() {
    this.paused = false;
    for (const deliver of this.pendingDeliveries.splice(0)) deliver();
  }

  injectTo(owner, data) {
    for (const channel of this.channels) {
      if (channel.owner !== owner) continue;
      for (const listener of channel.listeners) {
        listener({ data: structuredClone(data) });
      }
    }
  }
}

const crossTabTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

const reminderPage = (items = []) => ({
  kind: "message_reminder_list",
  privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
  items,
  page: { nextCursor: null },
});
const reminderEntry = (revision, scheduledAt = due(1), overrides = {}) => ({
  conversationId,
  messageId,
  reminderRevision: revision,
  reminder: {
    privacy: "affected_authenticated_actor",
    state: "scheduled",
    dueAt: scheduledAt,
  },
  ...overrides,
});
const reminderRequest = (overrides = {}) => ({
  operation: "message_reminder.v1",
  intent: "set",
  conversationId,
  messageId,
  expectedReminderRevision: 0,
  idempotencyKey: "retained-reminder-key",
  dueAt: due(2),
  ...overrides,
});
const reminderResult = (input, overrides = {}) => ({
  operation: input.operation,
  intent: input.intent,
  reconciliationStatus: "applied",
  conversationId: input.conversationId,
  messageId: input.messageId,
  expectedReminderRevision: input.expectedReminderRevision,
  idempotencyKey: input.idempotencyKey,
  reminderRevision: input.expectedReminderRevision + 1,
  reminder: input.intent === "set"
    ? { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: input.dueAt }
    : { privacy: "affected_authenticated_actor", state: "cancelled" },
  ...overrides,
});

function seedCache({ userId = actorId, revision = 0, scheduledAt } = {}) {
  const cache = createNormalizedChatCache(cacheIdentity(userId));
  if (revision > 0 && scheduledAt !== undefined) {
    cache.hydrateMessageReminderList(reminderPage([
      reminderEntry(revision, scheduledAt),
    ]));
  }
  return cache;
}

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let replaceGate;
  let race;
  let reminderReadGate;
  let reminderReadGateUser;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      if (
        kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
        reminderReadGate &&
        (reminderReadGateUser === undefined || reminderReadGateUser === scope.userId)
      ) {
        const gate = reminderReadGate;
        reminderReadGate = undefined;
        await gate.promise;
      }
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope: structuredClone(scope), kind, encoded });
      if (
        kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
        replaceGate
      ) await replaceGate.promise;
      rows.set(storageKey(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
      rows.delete(storageKey(scope, kind));
    },
    async compareExchange(scope, kind, expected, replacement) {
      calls.push({
        operation: "compareExchange",
        scope: structuredClone(scope),
        kind,
        expected,
        replacement,
      });
      if (
        kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
        replaceGate
      ) await replaceGate.promise;
      if (
        race !== undefined &&
        kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
        storageKey(scope, kind) === storageKey(storageIdentity(), kind) &&
        race.arrivals < 2
      ) {
        const ticket = ++race.arrivals;
        if (ticket === 2) race.barrier.resolve();
        await race.barrier.promise;
        if (ticket === 1) await new Promise((resolve) => setImmediate(resolve));
      }
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    },
    async clearForLogout() {},
  });
  return {
    rows,
    calls,
    storage,
    gateReplaces(gate) { replaceGate = gate; },
    armRace() {
      race = { arrivals: 0, barrier: deferred(), initialCallCount: calls.length };
    },
    raceArrivals: () => race?.arrivals ?? 0,
    raceCalls: () => calls.slice(race?.initialCallCount ?? calls.length),
    gateNextReminderRead(gate, userId) {
      reminderReadGate = gate;
      reminderReadGateUser = userId;
    },
    reminderWrites(userId = actorId) {
      return calls.filter((call) =>
        (call.operation === "replace" ||
          (call.operation === "compareExchange" && call.replacement !== null)) &&
        call.kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
        call.scope.userId === userId);
    },
  };
}

async function seedIntent(harness, scope, request) {
  await harness.storage.replace(createApplicationChatQueuedMessageReminderIntentsRecord(
    scope,
    [createApplicationChatQueuedMessageReminderIntent(request, {
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
  recovery = {},
  keys = ["generated-reminder-key"],
  now = Date.parse(at(6)),
  sockets,
  crossTab,
  start = true,
} = {}) {
  const requests = [];
  const diagnostics = [];
  let keyIndex = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: {
      retry: { maxAttempts: 1, maxAuthRefreshes: 0 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    messageReminders: {
      generateIdempotencyKey: () => keys[keyIndex++] ?? `generated-${keyIndex}`,
      now: () => now,
      retainedRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 4,
        wait: retainedWait,
        ...recovery,
      },
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata(sockets !== undefined));
      if (init.method === "GET") {
        const observed = { kind: "authority", url, init };
        requests.push(observed);
        return authority?.(observed) ?? response(200, reminderPage());
      }
      const body = JSON.parse(init.body);
      const observed = {
        kind: "reminder",
        url,
        body,
        init,
        identity: structuredClone(identityRef.current),
      };
      requests.push(observed);
      return command?.(observed) ?? response(200, reminderResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    ...(crossTab === undefined ? {} : {
      crossTab: {
        sessionFingerprint: crossTab.fingerprint ??
          `${tenantId}:${identityRef.current.userId}:${identityRef.current.deviceId}`,
        tabId: crossTab.tabId,
        clock: crossTab.clock,
        timing: crossTabTiming,
        channelFactory: crossTab.hub.factory(
          crossTab.tabId,
          crossTab.behavior,
        ),
      },
    }),
    ...(sockets === undefined ? {} : {
      realtime: {
        network: sockets.network,
        webSocketFactory: sockets.factory,
        retry: { initialDelayMs: 0, maximumDelayMs: 0, jitterRatio: 0 },
      },
    }),
  });
  if (start) assert.equal((await client.start()).state, "ready");
  return { client, cache, harness, identityRef, requests, diagnostics };
}

const commands = (fixture) =>
  fixture.requests.filter((request) => request.kind === "reminder");
const authorities = (fixture) =>
  fixture.requests.filter((request) => request.kind === "authority");

test("retained reminder recovery validates bounded scheduling options", () => {
  assert.throws(() => createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token",
    fetch: async () => response(200, metadata()),
    messageReminders: {
      retainedRecovery: { initialDelayMs: 5, maximumDelayMs: 4 },
    },
  }), /messageReminders retainedRecovery options are invalid/);
});

test("durable reminder persists before projection, authority refresh, and dispatch", async () => {
  const gate = deferred();
  const command = deferred();
  const fixture = await createFixture({ command: () => command.promise });
  fixture.harness.gateReplaces(gate);
  const pending = fixture.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: due(4),
  });
  await eventually(() => fixture.harness.reminderWrites().length === 1);
  assert.equal(selectCurrentUserMessageReminderState(
    fixture.cache.getState(),
    messageId,
  ).pending, undefined);
  assert.equal(fixture.requests.length, 0);
  gate.resolve();
  await eventually(() => commands(fixture).length === 1);
  assert.equal(authorities(fixture).length, 1);
  const request = commands(fixture)[0].body;
  assert.equal(request.dueAt, due(4));
  assert.equal(commands(fixture)[0].init.headers["idempotency-key"], request.idempotencyKey);
  assert.deepEqual((await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  )).intents[0].request, request);
  await eventually(async () => (await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  )) !== null);
  const checkpoint = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(checkpoint.snapshot.currentUser.pendingMessageReminderUpdates, {});
  assert.equal(JSON.stringify(checkpoint).includes(due(4)), false);
  assert.equal(JSON.stringify(fixture.diagnostics).includes(due(4)), false);
  command.resolve(response(200, reminderResult(request)));
  assert.equal((await pending).status, "success");
  fixture.client.close();
});

test("contended reminder writes for different messages both survive atomically", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const firstDueAt = due(4);
  const secondDueAt = due(5);
  const first = await createFixture({
    harness,
    keys: ["distinct-reminder-key-a"],
    now: Date.parse(at(1)),
    command: () => pendingForever,
    crossTab: { hub, clock, tabId: "atomic-distinct-a" },
  });
  const second = await createFixture({
    harness,
    keys: ["distinct-reminder-key-b"],
    now: Date.parse(at(2)),
    command: () => pendingForever,
    crossTab: { hub, clock, tabId: "atomic-distinct-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);

  harness.armRace();
  const firstPending = first.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: firstDueAt,
  });
  await eventually(() => harness.raceArrivals() === 1);
  const secondPending = second.client.setMessageReminder({
    conversationId,
    messageId: secondMessageId,
    dueAt: secondDueAt,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ))?.intents.length === 2);

  const committed = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  );
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.messageId,
    request.idempotencyKey,
  ]), [
    [1, secondMessageId, "distinct-reminder-key-b"],
    [2, messageId, "distinct-reminder-key-a"],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale distinct-message proposal must retry",
  );
  const coordination = JSON.stringify(hub.messages);
  const telemetry = JSON.stringify([...first.diagnostics, ...second.diagnostics]);
  for (const secret of [conversationId, messageId, secondMessageId, firstDueAt, secondDueAt]) {
    assert.equal(coordination.includes(secret), false);
    assert.equal(telemetry.includes(secret), false);
  }

  first.client.close();
  second.client.close();
  await Promise.all([firstPending, secondPending]);
});

test("same-message set and cancel contention retains the later atomic commit", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const scheduledDueAt = due(6);
  const unavailableAuthority = () => response(503, {
    error: { code: "UNAVAILABLE", message: "later" },
  });
  const setter = await createFixture({
    harness,
    keys: ["set-later-commit-key"],
    now: Date.parse(at(1)),
    authority: unavailableAuthority,
    command: () => pendingForever,
    crossTab: { hub, clock, tabId: "atomic-set" },
  });
  const canceller = await createFixture({
    harness,
    keys: ["cancel-first-commit-key"],
    now: Date.parse(at(2)),
    authority: unavailableAuthority,
    command: () => pendingForever,
    crossTab: { hub, clock, tabId: "atomic-cancel" },
  });
  clock.tick(crossTabTiming.electionDelayMs);

  harness.armRace();
  const setPending = setter.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: scheduledDueAt,
  });
  await eventually(() => harness.raceArrivals() === 1);
  const cancelPending = canceller.client.cancelMessageReminder({
    conversationId,
    messageId,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ))?.intents[0]?.request.idempotencyKey === "set-later-commit-key");

  const committed = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  );
  assert.equal(committed.intents.length, 1);
  assert.equal(committed.intents[0].enqueueOrder, 1);
  assert.equal(committed.intents[0].enqueuedAt, at(2));
  assert.equal(committed.intents[0].request.intent, "set");
  assert.equal(committed.intents[0].request.idempotencyKey, "set-later-commit-key");
  assert.equal(committed.intents[0].request.dueAt, scheduledDueAt);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale same-message proposal must retry and become the later commit",
  );
  assert.equal(JSON.stringify(hub.messages).includes(scheduledDueAt), false);
  assert.equal(
    JSON.stringify([...setter.diagnostics, ...canceller.diagnostics]).includes(scheduledDueAt),
    false,
  );

  setter.client.close();
  canceller.client.close();
  await Promise.all([setPending, cancelPending]);
});

test("stale exact reminder settlement preserves replacement and unrelated work", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const settlement = deferred();
  let authorityAvailable = true;
  const authority = () => authorityAvailable
    ? response(200, reminderPage())
    : response(503, { error: { code: "UNAVAILABLE", message: "later" } });
  const oldDueAt = due(7);
  const unrelatedDueAt = due(8);
  const old = await createFixture({
    harness,
    keys: ["old-reminder-key"],
    now: Date.parse(at(1)),
    authority,
    command: (observed) => observed.body.idempotencyKey === "old-reminder-key"
      ? settlement.promise
      : pendingForever,
    crossTab: {
      hub,
      clock,
      tabId: "atomic-old",
      behavior: { postThrows: true },
    },
  });
  const newer = await createFixture({
    harness,
    keys: ["unrelated-reminder-key", "replacement-cancel-key"],
    now: Date.parse(at(2)),
    authority,
    command: () => pendingForever,
    crossTab: {
      hub,
      clock,
      tabId: "atomic-newer",
      behavior: { postThrows: true },
    },
  });
  clock.tick(crossTabTiming.electionDelayMs);

  const oldPending = old.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: oldDueAt,
  });
  await eventually(() => commands(old).length === 1);
  authorityAvailable = false;
  const unrelatedPending = newer.client.setMessageReminder({
    conversationId,
    messageId: secondMessageId,
    dueAt: unrelatedDueAt,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ))?.intents.length === 2);

  harness.armRace();
  settlement.resolve(response(200, reminderResult(commands(old)[0].body)));
  await eventually(() => harness.raceArrivals() === 1);
  const replacementPending = newer.client.cancelMessageReminder({
    conversationId,
    messageId,
  });

  assert.equal(
    (await oldPending).status,
    "closed",
    "a concurrently superseded caller must not observe the stale result as canonical",
  );
  await eventually(async () => {
    const intents = (await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    ))?.intents ?? [];
    return intents.some(({ request }) =>
      request.messageId === messageId &&
      request.idempotencyKey === "replacement-cancel-key") &&
      intents.some(({ request }) =>
        request.messageId === secondMessageId &&
        request.idempotencyKey === "unrelated-reminder-key");
  });
  const committed = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  );
  assert.deepEqual(committed.intents.map(({ request }) => [
    request.messageId,
    request.idempotencyKey,
  ]), [
    [messageId, "replacement-cancel-key"],
    [secondMessageId, "unrelated-reminder-key"],
  ]);
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale settlement proposal must retry against the replacement record",
  );
  const coordination = JSON.stringify(hub.messages);
  const telemetry = JSON.stringify([...old.diagnostics, ...newer.diagnostics]);
  for (const secret of [conversationId, messageId, secondMessageId, oldDueAt, unrelatedDueAt]) {
    assert.equal(coordination.includes(secret), false);
    assert.equal(telemetry.includes(secret), false);
  }

  old.client.close();
  newer.client.close();
  await Promise.all([unrelatedPending, replacementPending]);
});

test("reload replays exact set, reschedule, and cancel requests", async (t) => {
  const cases = [
    ["set", reminderRequest(), seedCache(), reminderPage()],
    ["reschedule", reminderRequest({ expectedReminderRevision: 1 }),
      seedCache({ revision: 1, scheduledAt: due(1) }), reminderPage([reminderEntry(1)])],
    ["cancel", reminderRequest({
      intent: "cancel",
      expectedReminderRevision: 1,
      idempotencyKey: "retained-cancel-key",
      dueAt: undefined,
    }), seedCache({ revision: 1, scheduledAt: due(1) }), reminderPage([reminderEntry(1)])],
  ];
  for (const [name, rawRequest, cache, page] of cases) {
    await t.test(name, async () => {
      const request = Object.fromEntries(
        Object.entries(rawRequest).filter(([, value]) => value !== undefined),
      );
      const harness = createStorageHarness();
      await seedIntent(harness, storageIdentity(), request);
      await seedSnapshot(harness, storageIdentity(), cache);
      const fixture = await createFixture({
        harness,
        cache: createNormalizedChatCache(cacheIdentity()),
        authority: () => response(200, page),
      });
      await eventually(() => commands(fixture).length === 1);
      assert.deepEqual(commands(fixture)[0].body, request);
      assert.equal(
        commands(fixture)[0].init.headers["idempotency-key"],
        request.idempotencyKey,
      );
      await eventually(async () => await harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
      ) === null);
      fixture.client.close();
    });
  }
});

test("authoritative equality settles and newer divergence preserves conflict", async (t) => {
  await t.test("already equal", async () => {
    const harness = createStorageHarness();
    const request = reminderRequest({ expectedReminderRevision: 1 });
    await seedIntent(harness, storageIdentity(), request);
    await seedSnapshot(harness, storageIdentity(), seedCache({
      revision: 1,
      scheduledAt: request.dueAt,
    }));
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
      authority: () => response(200, reminderPage([
        reminderEntry(1, request.dueAt),
      ])),
    });
    await eventually(async () => await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    ) === null);
    assert.equal(commands(fixture).length, 0);
    fixture.client.close();
  });

  await t.test("newer divergent", async () => {
    const harness = createStorageHarness();
    const request = reminderRequest({ expectedReminderRevision: 1 });
    await seedIntent(harness, storageIdentity(), request);
    await seedSnapshot(harness, storageIdentity(), seedCache({
      revision: 1,
      scheduledAt: due(1),
    }));
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
      authority: () => response(200, reminderPage([reminderEntry(2, due(3))])),
    });
    await eventually(() => selectCurrentUserMessageReminderState(
      fixture.cache.getState(),
      messageId,
    ).pending?.state === "conflict");
    assert.equal(commands(fixture).length, 0);
    assert.notEqual(await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    ), null);
    fixture.client.close();
  });
});

test("expired set is removed before authority or replay", async () => {
  const harness = createStorageHarness();
  const request = reminderRequest({ dueAt: at(7) });
  await seedIntent(harness, storageIdentity(), request);
  await seedSnapshot(harness, storageIdentity(), seedCache());
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
    now: Date.parse(at(8)),
  });
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ) === null);
  assert.equal(fixture.requests.length, 0);
  fixture.client.close();
});

test("ambiguous outcomes retain with bounded backoff and terminal outcomes remove", async (t) => {
  await t.test("ambiguous", async () => {
    const waits = [];
    const waiters = [];
    const fixture = await createFixture({
      command: () => { throw new Error("private reminder transport detail"); },
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
    const pending = fixture.client.setMessageReminder({
      conversationId,
      messageId,
      dueAt: due(5),
    });
    assert.equal((await pending).status, "transport");
    await eventually(() => waits.length === 1);
    assert.deepEqual(waits, [2]);
    assert.notEqual(await fixture.harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    ), null);
    assert.equal(JSON.stringify(fixture.diagnostics).includes(due(5)), false);
    waiters[0].resolve();
    await eventually(() => commands(fixture).length === 2);
    await eventually(() => waits.length === 2);
    assert.deepEqual(waits, [2, 3]);
    assert.deepEqual(commands(fixture)[1].body, commands(fixture)[0].body);
    fixture.client.close();
  });

  for (const [name, command, expected] of [
    ["rate limit", () => response(429, { error: { code: "RATE_LIMITED", message: "later" } }), "transport"],
    ["server", () => response(503, { error: { code: "UNAVAILABLE", message: "later" } }), "transport"],
    ["malformed", () => response(200, { malformed: true }), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ command });
      assert.equal((await fixture.client.setMessageReminder({
        conversationId,
        messageId,
        dueAt: due(6),
      })).status, expected);
      assert.notEqual(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
      ), null);
      fixture.client.close();
    });
  }

  await t.test("terminal", async () => {
    for (const [status, code, expected] of [
      [400, "INVALID_REQUEST", "rejected"],
      [401, "UNAUTHORIZED", "authentication"],
      [403, "PERMISSION_DENIED", "rejected"],
      [404, "UNSUPPORTED", "unsupported"],
      [400, "FEATURE_DISABLED", "feature_disabled"],
    ]) {
      const fixture = await createFixture({
        command: () => response(status, { error: { code, message: "no" } }),
      });
      assert.equal((await fixture.client.setMessageReminder({
        conversationId,
        messageId,
        dueAt: due(7),
      })).status, expected);
      await eventually(async () => await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
      ) === null);
      fixture.client.close();
    }
  });
});

test("offline reload gates exact replay until reconnect", async () => {
  const scope = storageIdentity();
  const harness = createStorageHarness();
  const request = reminderRequest();
  await seedIntent(harness, scope, request);
  await seedSnapshot(harness, scope, seedCache());
  const sockets = createSockets(scope, false);
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
    sockets,
  });
  assert.equal(fixture.requests.length, 0);
  sockets.goOnline();
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(fixture.requests.length, 0);
  sockets.sockets[0].accept();
  await eventually(() => commands(fixture).length === 1);
  assert.deepEqual(commands(fixture)[0].body, request);
  fixture.client.close();
});

test("close after dispatch retains the ambiguous reminder", async () => {
  const command = deferred();
  const fixture = await createFixture({ command: () => command.promise });
  const pending = fixture.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: due(8),
  });
  await eventually(() => commands(fixture).length === 1);
  fixture.client.close();
  assert.equal((await pending).status, "closed");
  assert.notEqual(await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ), null);
  command.resolve(response(200, reminderResult(commands(fixture)[0].body)));
});

test("corrupt rows quarantine narrowly with redacted diagnostics", async () => {
  const harness = createStorageHarness();
  const own = storageIdentity();
  const sibling = storageIdentity("user-sibling");
  await seedSnapshot(harness, own, seedCache());
  await seedSnapshot(harness, sibling, seedCache({ userId: sibling.userId }));
  await seedIntent(harness, sibling, reminderRequest({ idempotencyKey: "sibling-key" }));
  const secretDue = due(9);
  harness.rows.set(
    storageKey(own, ApplicationChatStorageRecordKind.queuedMessageReminderIntents),
    `{\"corruptDue\":\"${secretDue}\"}`,
  );
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
  });
  assert.equal(await harness.storage.read(
    own,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ), null);
  assert.notEqual(await harness.storage.read(
    sibling,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ), null);
  assert.equal(fixture.diagnostics.at(-1).code, "message_reminder_intents_rejected");
  assert.equal(JSON.stringify(fixture.diagnostics).includes(secretDue), false);
  fixture.client.close();
});

test("delayed old-identity authority and response cannot affect the new identity", async () => {
  const oldScope = storageIdentity();
  const nextScope = storageIdentity("user-next");
  const harness = createStorageHarness();
  const identityRef = { current: oldScope };
  await seedSnapshot(harness, oldScope, seedCache());
  await seedSnapshot(harness, nextScope, seedCache({ userId: nextScope.userId }));
  const oldRequest = reminderRequest({ idempotencyKey: "old-key" });
  const nextRequest = reminderRequest({ idempotencyKey: "next-key", dueAt: due(8) });
  await seedIntent(harness, oldScope, oldRequest);
  await seedIntent(harness, nextScope, nextRequest);
  const oldAuthority = deferred();
  const nextCommand = deferred();
  let authorityCount = 0;
  const fixture = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(cacheIdentity()),
    authority: () => ++authorityCount === 1
      ? oldAuthority.promise
      : response(200, reminderPage()),
    command: (observed) => observed.body.idempotencyKey === "next-key"
      ? nextCommand.promise
      : response(200, reminderResult(observed.body)),
  });
  await eventually(() => authorities(fixture).length === 1);
  fixture.client.close();
  identityRef.current = nextScope;
  assert.equal((await fixture.client.start()).state, "ready");
  oldAuthority.resolve(response(200, reminderPage([reminderEntry(4, due(7))])));
  await eventually(() => commands(fixture).some((item) =>
    item.body.idempotencyKey === nextRequest.idempotencyKey));
  assert.equal(commands(fixture).some((item) =>
    item.body.idempotencyKey === oldRequest.idempotencyKey), false);
  assert.equal(fixture.cache.getState().identity.userId, nextScope.userId);
  assert.notEqual(await harness.storage.read(
    nextScope,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ), null);
  fixture.client.close();
  nextCommand.resolve(response(200, reminderResult(nextRequest)));
});

test("delayed old-identity storage read cannot publish or dispatch after restart", async () => {
  const oldScope = storageIdentity();
  const nextScope = storageIdentity("user-read-next");
  const harness = createStorageHarness();
  const identityRef = { current: oldScope };
  const oldRequest = reminderRequest({ idempotencyKey: "old-read-key" });
  const nextRequest = reminderRequest({ idempotencyKey: "next-read-key", dueAt: due(7) });
  await seedSnapshot(harness, oldScope, seedCache());
  await seedSnapshot(harness, nextScope, seedCache({ userId: nextScope.userId }));
  await seedIntent(harness, oldScope, oldRequest);
  await seedIntent(harness, nextScope, nextRequest);
  const readGate = deferred();
  harness.gateNextReminderRead(readGate, oldScope.userId);
  const fixture = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(cacheIdentity()),
    start: false,
  });
  const oldStart = fixture.client.start();
  await eventually(() => harness.calls.some((call) =>
    call.operation === "read" &&
    call.kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
    call.scope.userId === oldScope.userId));
  fixture.client.close();
  identityRef.current = nextScope;
  const nextStart = fixture.client.start();
  readGate.resolve();
  assert.equal((await oldStart).state, "idle");
  assert.equal((await nextStart).state, "ready");
  await eventually(() => commands(fixture).some((item) =>
    item.body.idempotencyKey === nextRequest.idempotencyKey));
  assert.equal(commands(fixture).some((item) =>
    item.body.idempotencyKey === oldRequest.idempotencyKey), false);
  assert.equal(fixture.cache.getState().identity.userId, nextScope.userId);
  fixture.client.close();
});

test("a follower announces only a reminder correlation for one leader dispatch and private authority refresh", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const dispatched = deferred();
  let applied = false;
  const authority = () => response(200, applied
    ? reminderPage([reminderEntry(1, due(4))])
    : reminderPage());
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    authority,
    command: () => dispatched.promise,
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    authority,
    command: () => { throw new Error("follower must not dispatch"); },
    keys: ["cross-tab-reminder-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination?.role, "leader");
  assert.equal(follower.client.coordination?.role, "follower");
  hub.paused = true;

  const pending = follower.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: due(4),
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "cross-tab-reminder-key"));
  const announcement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "cross-tab-reminder-key");
  assert.deepEqual(announcement.payload, {
    command: "message.reminder.set",
    idempotencyKey: "cross-tab-reminder-key",
  });
  for (const secret of [
    conversationId,
    messageId,
    due(4),
    "message_reminder.v1",
    "affected_authenticated_actor",
    '"state":"scheduled"',
  ]) assert.equal(JSON.stringify(announcement).includes(secret), false);
  const readsAfterFollowerPersistence = harness.calls.filter((call) =>
    call.operation === "read" &&
    call.kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents).length;
  assert.equal(commands(follower).length, 0);

  hub.flush();
  await eventually(() => harness.calls.filter((call) =>
    call.operation === "read" &&
    call.kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents).length >
      readsAfterFollowerPersistence);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-reminder-key"));
  hub.injectTo("tab-a", announcement);
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => commands(leader).length === 1);
  hub.injectTo("tab-a", announcement);
  clock.tick(crossTabTiming.commandClaimDelayMs);
  assert.equal(commands(leader).length, 1);
  assert.equal(commands(follower).length, 0);
  assert.equal(
    commands(leader)[0].init.headers["idempotency-key"],
    "cross-tab-reminder-key",
  );

  applied = true;
  dispatched.resolve(response(200, reminderResult(commands(leader)[0].body)));
  assert.equal((await pending).status, "success");
  await eventually(() => selectCurrentUserMessageReminderState(
    follower.cache.getState(),
    messageId,
  ).pending === undefined);
  const relayed = hub.messages.filter((message) =>
    message.kind === "command-result" &&
    message.payload.idempotencyKey === "cross-tab-reminder-key");
  assert.deepEqual(relayed.map((message) => message.payload.result), [{
    status: "success",
    value: { authorityRefresh: true },
  }]);
  for (const secret of [
    conversationId,
    messageId,
    due(4),
    "message_reminder.v1",
    "affected_authenticated_actor",
    '"state":"scheduled"',
  ]) assert.equal(JSON.stringify(hub.messages).includes(secret), false);

  leader.client.close();
  follower.client.close();
});

test("set then cancel coalesces before leader reload to the latest reminder correlation", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  let applied = false;
  const authority = () => response(200, applied
    ? reminderPage()
    : reminderPage([reminderEntry(1, due(1))]));
  const leader = await createFixture({
    harness,
    cache: seedCache({ revision: 1, scheduledAt: due(1) }),
    authority,
    command: ({ body }) => {
      applied = true;
      return response(200, reminderResult(body));
    },
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const follower = await createFixture({
    harness,
    cache: seedCache({ revision: 1, scheduledAt: due(1) }),
    authority,
    command: () => { throw new Error("follower must not dispatch"); },
    keys: ["set-superseded-key", "cancel-latest-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  hub.paused = true;

  const first = follower.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: due(2),
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ))?.intents[0]?.request.idempotencyKey === "set-superseded-key");
  const latest = follower.client.cancelMessageReminder({
    conversationId,
    messageId,
  });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  ))?.intents[0]?.request.idempotencyKey === "cancel-latest-key");
  assert.equal((await first).status, "closed");

  hub.flush();
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cancel-latest-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  assert.equal((await latest).status, "success");
  assert.deepEqual(commands(leader).map(({ body }) => ({
    intent: body.intent,
    idempotencyKey: body.idempotencyKey,
  })), [{ intent: "cancel", idempotencyKey: "cancel-latest-key" }]);
  assert.equal(hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "set-superseded-key"), false);
  assert.equal(commands(follower).length, 0);

  leader.client.close();
  follower.client.close();
});

test("leadership transfer preserves the exact reminder key without duplicate dispatch", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const firstLeader = await createFixture({
    harness,
    cache: seedCache(),
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const successor = await createFixture({
    harness,
    cache: seedCache(),
    keys: ["reminder-transfer-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);

  const pending = successor.client.setMessageReminder({
    conversationId,
    messageId,
    dueAt: due(5),
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-a" &&
    message.payload.idempotencyKey === "reminder-transfer-key"));
  firstLeader.client.close();
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(successor.client.coordination?.role, "leader");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-b" &&
    message.payload.idempotencyKey === "reminder-transfer-key"));
  clock.tick(crossTabTiming.commandClaimLeaseMs + crossTabTiming.commandClaimDelayMs);
  assert.equal((await pending).status, "success");
  assert.equal(commands(firstLeader).length, 0);
  assert.deepEqual(commands(successor).map(({ body }) => body.idempotencyKey), [
    "reminder-transfer-key",
  ]);

  successor.client.close();
});

test("unavailable coordination fails open and recovers the reminder locally", async (t) => {
  for (const failure of ["constructThrows", "postThrows"]) {
    await t.test(failure, async () => {
      const hub = new FakeChannelHub();
      const clock = new FakeClock();
      const fixture = await createFixture({
        keys: [`fallback-reminder-${failure}`],
        crossTab: {
          hub,
          clock,
          tabId: `tab-fallback-${failure}`,
          behavior: { [failure]: true },
        },
      });
      assert.equal(fixture.client.coordination?.role, "fallback");
      assert.equal((await fixture.client.setMessageReminder({
        conversationId,
        messageId,
        dueAt: due(6),
      })).status, "success");
      assert.deepEqual(commands(fixture).map(({ body }) => body.idempotencyKey), [
        `fallback-reminder-${failure}`,
      ]);
      assert.equal(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
      ), null);
      fixture.client.close();
    });
  }
});
