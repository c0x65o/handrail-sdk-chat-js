import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  CHAT_DURABLE_EVENT_TYPES,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedSavedMessageIntent,
  createApplicationChatQueuedSavedMessageIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserSavedMessageState,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-saved-recovery";
const actorId = "user-saved-recovery";
const conversationId = "conversation-saved-recovery";
const messageId = "message-saved-recovery";
const privateState = ACTOR_PRIVATE_USER_STATE_PRIVACY;
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

  factory = (_owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("construction failed");
    const listeners = new Set();
    const channel = {
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
}

const crossTabTiming = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

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

const detail = (userId = actorId) => ({
  kind: "conversation_detail",
  conversation: {
    id: conversationId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: "Saved recovery",
    createdAt: at(0),
    updatedAt: at(0),
    latestSequence: 1,
    activityAt: at(0),
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
      lastReadSequence: 0,
      updatedAt: at(0),
    },
    memberUserIds: [userId],
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: at(0),
    },
  },
  _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
});

const timelineMessage = () => ({
  id: messageId,
  tenantId,
  conversationId,
  author: { type: "user", userId: "user-author" },
  sequence: 1,
  createdAt: at(0),
  updatedAt: at(0),
  revision: { revision: 1 },
  content: { format: "plain", text: "saved recovery message" },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
});

const savedEvent = (eventId, revision, savedMessage, userId = actorId) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.savedMessageUpdated,
  occurredAt: at(10 + revision),
  payload: {
    operation: "set_saved_message",
    messageId,
    savedMessageRevision: revision,
    savedMessage,
  },
});

function seedCache({ userId = actorId, revision = 0, saved = false, note } = {}) {
  const cache = createNormalizedChatCache(cacheIdentity(userId));
  cache.hydrateConversationDetail(detail(userId));
  cache.hydrateMessageTimeline({
    conversationId,
    messages: [timelineMessage()],
    pagination: { older: { available: false }, newer: { available: false } },
    replay: { resumeFrom: { eventId: `timeline-${userId}` } },
  });
  for (let current = 1; current <= revision; current += 1) {
    cache.applyDurableEvent(savedEvent(
      `seed-${userId}-${current}`,
      current,
      {
        messageId,
        isSaved: saved,
        ...(saved && note !== undefined ? { privateNote: note } : {}),
      },
      userId,
    ));
  }
  return cache;
}

const savedPage = (items = []) => ({
  kind: "saved_message_list",
  privacy: privateState,
  items,
  page: { nextCursor: null },
});

const savedEntry = (revision, note) => ({
  messageId,
  savedMessageRevision: revision,
  savedAt: at(20),
  updatedAt: at(20),
  ...(note === undefined ? {} : {
    privateNote: { privacy: privateState, text: note },
  }),
  message: {
    availability: "available",
    current: {
      id: messageId,
      conversationId,
      author: { type: "user", userId: "user-author" },
      sequence: 1,
      createdAt: at(0),
      updatedAt: at(0),
      revision: { revision: 1 },
      content: { format: "plain", text: "saved recovery message" },
      attachmentMetadata: [],
    },
  },
});

const savedRequest = (overrides = {}) => ({
  operation: "set_saved_message",
  intent: "save",
  messageId,
  expectedSavedMessageRevision: 0,
  idempotencyKey: "retained-saved-key",
  ...overrides,
});

const savedResult = (input, overrides = {}) => ({
  operation: "set_saved_message",
  intent: input.intent,
  reconciliationStatus: "applied",
  messageId: input.messageId,
  expectedSavedMessageRevision: input.expectedSavedMessageRevision,
  idempotencyKey: input.idempotencyKey,
  savedMessageRevision: input.expectedSavedMessageRevision + 1,
  savedMessage: {
    messageId: input.messageId,
    isSaved: input.intent === "save",
    ...(input.intent === "save" && input.privateNote !== undefined
      ? { privateNote: input.privateNote }
      : {}),
  },
  ...overrides,
});

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let replaceGate;
  let rejectSavedReplace = false;
  const beforeReplace = async (kind) => {
    if (kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents && replaceGate) {
      await replaceGate.promise;
    }
    if (
      kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents &&
      rejectSavedReplace
    ) throw new Error("private storage failure");
  };
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope: structuredClone(scope), kind, encoded });
      await beforeReplace(kind);
      rows.set(storageKey(scope, kind), encoded);
    },
    async compareExchange(scope, kind, expected, replacement) {
      calls.push({ operation: "compareExchange", scope: structuredClone(scope), kind, expected, replacement });
      if (replacement !== null) await beforeReplace(kind);
      // Keep comparison and mutation together after any simulated storage delay.
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
      rows.delete(storageKey(scope, kind));
    },
    async clearForLogout() {},
  });
  return {
    rows,
    calls,
    storage,
    gateReplaces(gate) { replaceGate = gate; },
    rejectSavedReplaces() { rejectSavedReplace = true; },
    savedWrites(userId = actorId) {
      return calls.filter((call) => (call.operation === "replace" ||
        (call.operation === "compareExchange" && call.replacement !== null)) &&
        call.kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents &&
        call.scope.userId === userId);
    },
  };
}

async function seedIntent(harness, scope, request) {
  await harness.storage.replace(createApplicationChatQueuedSavedMessageIntentsRecord(
    scope,
    [createApplicationChatQueuedSavedMessageIntent(request, {
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

async function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: storageIdentity() },
  cache = seedCache({ userId: identityRef.current.userId }),
  command,
  authority,
  recovery = {},
  keys = ["generated-saved-key"],
  sockets,
  crossTab,
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
    savedMessages: {
      generateIdempotencyKey: () => keys[keyIndex++] ?? `generated-${keyIndex}`,
      now: () => Date.parse(at(6 + keyIndex)),
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
        return authority?.(observed) ?? response(200, savedPage());
      }
      const body = JSON.parse(init.body);
      const observed = {
        kind: "saved-message",
        url,
        body,
        init,
        identity: structuredClone(identityRef.current),
      };
      requests.push(observed);
      return command?.(observed) ?? response(200, savedResult(body));
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
  assert.equal((await client.start()).state, "ready");
  return { client, cache, harness, identityRef, requests, diagnostics };
}

const commands = (fixture) =>
  fixture.requests.filter((request) => request.kind === "saved-message");

test("durable save persists exact private request before projection, authority, and dispatch", async () => {
  const gate = deferred();
  const command = deferred();
  const privateNote = "private-note-must-never-be-diagnostic";
  const fixture = await createFixture({ command: () => command.promise });
  fixture.harness.gateReplaces(gate);
  const pending = fixture.client.saveMessage({ messageId, privateNote });
  await eventually(() => fixture.harness.savedWrites().length === 1);
  assert.equal(selectCurrentUserSavedMessageState(fixture.cache.getState(), messageId).pending, undefined);
  assert.equal(fixture.requests.length, 0);
  gate.resolve();
  await eventually(() => commands(fixture).length === 1);
  const request = commands(fixture)[0].body;
  assert.equal(request.privateNote, privateNote);
  assert.equal(commands(fixture)[0].init.headers["idempotency-key"], request.idempotencyKey);
  assert.deepEqual((await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  )).intents[0].request, request);
  await eventually(async () => (await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  )) !== null);
  const checkpoint = await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(checkpoint.snapshot.currentUser.pendingSavedMessageUpdates, {});
  assert.equal(JSON.stringify(checkpoint).includes(privateNote), false);
  assert.equal(JSON.stringify(fixture.diagnostics).includes(privateNote), false);
  command.resolve(response(200, savedResult(request)));
  assert.equal((await pending).status, "success");
  fixture.client.close();
});

test("storage failure fails closed before projection or network work", async () => {
  const harness = createStorageHarness();
  const fixture = await createFixture({ harness });
  harness.rejectSavedReplaces();
  const result = await fixture.client.saveMessage({
    messageId,
    privateNote: "storage-failure-private",
  });
  assert.equal(result.status, "validation");
  assert.equal(selectCurrentUserSavedMessageState(
    fixture.cache.getState(),
    messageId,
  ).pending, undefined);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.diagnostics.at(-1).code, "saved_message_intents_write_failed");
  assert.equal(JSON.stringify(fixture.diagnostics).includes("storage-failure-private"), false);
  fixture.client.close();
});

test("reload replays exact save, unsave, and private-note requests", async (t) => {
  const cases = [
    ["save", savedRequest(), seedCache(), savedPage()],
    ["save with note", savedRequest({ idempotencyKey: "private-key", privateNote: "reload-private" }), seedCache(), savedPage()],
    ["unsave", savedRequest({ intent: "unsave", expectedSavedMessageRevision: 1, idempotencyKey: "unsave-key" }), seedCache({ revision: 1, saved: true }), savedPage([savedEntry(1)])],
  ];
  for (const [name, request, cache, page] of cases) {
    await t.test(name, async () => {
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
      assert.equal(commands(fixture)[0].init.headers["idempotency-key"], request.idempotencyKey);
      await eventually(async () => await harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
      ) === null);
      fixture.client.close();
    });
  }
});

test("matching authority settles while newer divergent authority preserves conflict", async (t) => {
  await t.test("already equal", async () => {
    const harness = createStorageHarness();
    const request = savedRequest({ privateNote: "same-note" });
    await seedIntent(harness, storageIdentity(), request);
    await seedSnapshot(harness, storageIdentity(), seedCache());
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
      authority: () => response(200, savedPage([savedEntry(1, "same-note")])),
    });
    await eventually(async () => await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    ) === null);
    assert.equal(commands(fixture).length, 0);
    fixture.client.close();
  });

  await t.test("newer divergent", async () => {
    const harness = createStorageHarness();
    const request = savedRequest({ expectedSavedMessageRevision: 1 });
    await seedIntent(harness, storageIdentity(), request);
    await seedSnapshot(harness, storageIdentity(), seedCache({ revision: 2, saved: false }));
    const fixture = await createFixture({
      harness,
      cache: createNormalizedChatCache(cacheIdentity()),
      authority: () => response(200, savedPage()),
    });
    await eventually(() => selectCurrentUserSavedMessageState(
      fixture.cache.getState(),
      messageId,
    ).pending?.state === "conflict");
    assert.equal(commands(fixture).length, 0);
    assert.notEqual(await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    ), null);
    fixture.client.close();
  });
});

test("ambiguous failures retain with bounded backoff while terminal outcomes remove", async (t) => {
  await t.test("ambiguous", async () => {
    const waits = [];
    const waiters = [];
    const fixture = await createFixture({
      command: () => { throw new Error("private transport detail"); },
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
    const result = await fixture.client.saveMessage({ messageId, privateNote: "hidden" });
    assert.equal(result.status, "transport");
    await eventually(() => waits.length === 1);
    assert.deepEqual(waits, [2]);
    assert.notEqual(await fixture.harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    ), null);
    assert.equal(JSON.stringify(fixture.diagnostics).includes("hidden"), false);
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
      assert.equal((await fixture.client.saveMessage({ messageId })).status, expected);
      assert.notEqual(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
      ), null);
      fixture.client.close();
    });
  }

  await t.test("terminal", async () => {
    const cases = [
      [400, "INVALID_REQUEST", "rejected"],
      [401, "UNAUTHORIZED", "authentication"],
      [403, "PERMISSION_DENIED", "rejected"],
      [404, "UNSUPPORTED", "unsupported"],
      [400, "FEATURE_DISABLED", "feature_disabled"],
    ];
    for (const [status, code, expected] of cases) {
      const fixture = await createFixture({
        command: () => response(status, { error: { code, message: "no" } }),
      });
      assert.equal((await fixture.client.saveMessage({ messageId })).status, expected);
      await eventually(async () => await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
      ) === null);
      fixture.client.close();
    }
  });
});

test("actor-private event settles before HTTP and aborts redundant work", async () => {
  const scope = storageIdentity();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({ sockets, command: () => command.promise });
  const pending = fixture.client.saveMessage({ messageId, privateNote: "event-private" });
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(commands(fixture).length, 0);
  sockets.sockets[0].accept();
  await eventually(() => commands(fixture).length === 1);
  const request = commands(fixture)[0].body;
  sockets.sockets[0].event(savedEvent("event-first", 1, {
    messageId,
    isSaved: true,
    privateNote: "event-private",
  }));
  assert.equal((await pending).status, "success");
  await eventually(async () => await fixture.harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ) === null);
  assert.equal(selectCurrentUserSavedMessageState(
    fixture.cache.getState(),
    messageId,
  ).pending, undefined);
  command.resolve(response(200, savedResult(request)));
  fixture.client.close();
});

test("offline reload gates exact replay until realtime reconnect", async () => {
  const scope = storageIdentity();
  const harness = createStorageHarness();
  const request = savedRequest({ privateNote: "offline-private" });
  await seedIntent(harness, scope, request);
  await seedSnapshot(harness, scope, seedCache());
  const sockets = createSockets(scope, false);
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
    sockets,
  });
  assert.equal(commands(fixture).length, 0);
  assert.equal(sockets.sockets.length, 0);
  sockets.goOnline();
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(commands(fixture).length, 0);
  sockets.sockets[0].accept();
  await eventually(() => commands(fixture).length === 1);
  assert.deepEqual(commands(fixture)[0].body, request);
  fixture.client.close();
});

test("close after dispatch retains the ambiguous command for reload", async () => {
  const command = deferred();
  const fixture = await createFixture({ command: () => command.promise });
  const pending = fixture.client.saveMessage({ messageId });
  await eventually(() => commands(fixture).length === 1);
  fixture.client.close();
  assert.equal((await pending).status, "closed");
  assert.notEqual(await fixture.harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ), null);
  command.resolve(response(200, savedResult(commands(fixture)[0].body)));
});

test("superseded identity work cannot project, dispatch, diagnose, or delete new rows", async () => {
  const oldScope = storageIdentity();
  const newScope = storageIdentity("user-next");
  const harness = createStorageHarness();
  const identityRef = { current: oldScope };
  await seedSnapshot(harness, oldScope, seedCache());
  await seedSnapshot(harness, newScope, seedCache({ userId: newScope.userId }));
  const newRequest = savedRequest({ idempotencyKey: "new-user-key" });
  await seedIntent(harness, newScope, newRequest);
  const newCommand = deferred();
  const fixture = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(cacheIdentity()),
    command: () => newCommand.promise,
  });
  const gate = deferred();
  harness.gateReplaces(gate);
  const oldPending = fixture.client.saveMessage({
    messageId,
    privateNote: "old-user-private",
  });
  await eventually(() => harness.savedWrites(actorId).length >= 1);
  fixture.client.close();
  identityRef.current = newScope;
  const restarted = fixture.client.start();
  gate.resolve();
  assert.equal((await oldPending).status, "validation");
  assert.equal((await restarted).state, "ready");
  await eventually(() => commands(fixture).some((item) =>
    item.body.idempotencyKey === newRequest.idempotencyKey));
  assert.equal(commands(fixture).some((item) =>
    item.body.idempotencyKey === "generated-saved-key"), false);
  assert.equal(fixture.cache.getState().identity.userId, newScope.userId);
  assert.notEqual(await harness.storage.read(
    newScope,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ), null);
  assert.equal(JSON.stringify(fixture.diagnostics).includes("old-user-private"), false);
  fixture.client.close();
  newCommand.resolve(response(200, savedResult(newRequest)));
});

test("corrupt active rows quarantine only their identity and record kind", async () => {
  const harness = createStorageHarness();
  const own = storageIdentity();
  const sibling = storageIdentity("user-sibling");
  await seedSnapshot(harness, own, seedCache());
  await seedSnapshot(harness, sibling, seedCache({ userId: sibling.userId }));
  await seedIntent(harness, sibling, savedRequest({ idempotencyKey: "sibling-key" }));
  harness.rows.set(
    storageKey(own, ApplicationChatStorageRecordKind.queuedSavedMessageIntents),
    "{corrupt-saved-message-row",
  );
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
  });
  assert.equal(await harness.storage.read(
    own,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ), null);
  assert.notEqual(await harness.storage.read(
    sibling,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ), null);
  assert.equal(fixture.diagnostics.at(-1).code, "saved_message_intents_rejected");
  assert.equal(JSON.stringify(fixture.diagnostics).includes("corrupt-saved-message-row"), false);
  fixture.client.close();
});

test("a follower announces only a saved-message correlation and both tabs settle from private authority", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  const privateNote = "cross-tab-private-note";
  let applied = false;
  const authority = () => response(200, applied
    ? savedPage([savedEntry(1, privateNote)])
    : savedPage());
  const leader = await createFixture({
    harness,
    cache: seedCache(),
    authority,
    command: ({ body }) => {
      applied = true;
      return response(200, savedResult(body));
    },
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const follower = await createFixture({
    harness,
    cache: seedCache(),
    authority,
    command: () => { throw new Error("follower must not dispatch"); },
    keys: ["cross-tab-saved-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.client.coordination?.role, "leader");
  assert.equal(follower.client.coordination?.role, "follower");
  hub.paused = true;

  const pending = follower.client.saveMessage({ messageId, privateNote });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.idempotencyKey === "cross-tab-saved-key"));
  const announcement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available");
  assert.deepEqual(announcement.payload, {
    command: "saved_message.set",
    idempotencyKey: "cross-tab-saved-key",
  });
  assert.equal(JSON.stringify(announcement).includes(messageId), false);
  assert.equal(JSON.stringify(announcement).includes(privateNote), false);
  const readsAfterFollowerPersistence = harness.calls.filter((call) =>
    call.operation === "read" &&
    call.kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents &&
    call.scope.userId === actorId).length;
  assert.equal(commands(follower).length, 0);
  hub.flush();
  await eventually(() => harness.calls.filter((call) =>
    call.operation === "read" &&
    call.kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents &&
    call.scope.userId === actorId).length > readsAfterFollowerPersistence);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "cross-tab-saved-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);

  assert.equal((await pending).status, "success");
  await eventually(() => selectCurrentUserSavedMessageState(
    leader.cache.getState(),
    messageId,
  ).pending === undefined);
  assert.equal(commands(leader).length, 1);
  assert.equal(commands(follower).length, 0);
  assert.equal(commands(leader)[0].body.idempotencyKey, "cross-tab-saved-key");
  const relayed = hub.messages.filter((message) =>
    message.kind === "command-result" &&
    message.payload.idempotencyKey === "cross-tab-saved-key");
  assert.deepEqual(relayed.map((message) => message.payload.result), [{
    status: "success",
    value: { authorityRefresh: true },
  }]);
  assert.equal(JSON.stringify(hub.messages).includes(privateNote), false);
  assert.equal(JSON.stringify([
    ...leader.diagnostics,
    ...follower.diagnostics,
  ]).includes(privateNote), false);
  assert.equal(selectCurrentUserSavedMessageState(
    follower.cache.getState(),
    messageId,
  ).pending, undefined);

  leader.client.close();
  follower.client.close();
});

test("rapid save then unsave keeps only the latest correlation for leader dispatch", async () => {
  const harness = createStorageHarness();
  const hub = new FakeChannelHub();
  const clock = new FakeClock();
  let applied = false;
  const authority = () => response(200, applied
    ? savedPage()
    : savedPage([savedEntry(1, "old-note")]));
  const leader = await createFixture({
    harness,
    cache: seedCache({ revision: 1, saved: true, note: "old-note" }),
    authority,
    command: ({ body }) => {
      applied = true;
      return response(200, savedResult(body));
    },
    crossTab: { hub, clock, tabId: "tab-a" },
  });
  const follower = await createFixture({
    harness,
    cache: seedCache({ revision: 1, saved: true, note: "old-note" }),
    authority,
    command: () => { throw new Error("follower must not dispatch"); },
    keys: ["save-superseded-key", "unsave-latest-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);
  hub.paused = true;

  const first = follower.client.saveMessage({ messageId, privateNote: "new-note" });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ))?.intents[0]?.request.idempotencyKey === "save-superseded-key");
  const latest = follower.client.unsaveMessage({ messageId });
  await eventually(async () => (await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  ))?.intents[0]?.request.idempotencyKey === "unsave-latest-key");
  assert.equal((await first).status, "closed");

  hub.flush();
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "unsave-latest-key"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  assert.equal((await latest).status, "success");
  assert.deepEqual(commands(leader).map(({ body }) => ({
    intent: body.intent,
    idempotencyKey: body.idempotencyKey,
  })), [{ intent: "unsave", idempotencyKey: "unsave-latest-key" }]);
  assert.equal(hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.idempotencyKey === "save-superseded-key"), false);
  assert.equal(commands(follower).length, 0);

  leader.client.close();
  follower.client.close();
});

test("leadership transfer retains the saved-message key without double dispatch", async () => {
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
    keys: ["saved-transfer-key"],
    crossTab: { hub, clock, tabId: "tab-b" },
  });
  clock.tick(crossTabTiming.electionDelayMs);

  const pending = successor.client.saveMessage({ messageId });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-a" &&
    message.payload.idempotencyKey === "saved-transfer-key"));
  firstLeader.client.close();
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(successor.client.coordination?.role, "leader");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-b" &&
    message.payload.idempotencyKey === "saved-transfer-key"));
  clock.tick(crossTabTiming.commandClaimLeaseMs + crossTabTiming.commandClaimDelayMs);
  assert.equal((await pending).status, "success");
  assert.equal(commands(firstLeader).length, 0);
  assert.deepEqual(commands(successor).map(({ body }) => body.idempotencyKey), [
    "saved-transfer-key",
  ]);

  successor.client.close();
});

test("unavailable coordination fails open and recovers the saved-message locally", async (t) => {
  for (const failure of ["constructThrows", "postThrows"]) {
    await t.test(failure, async () => {
      const hub = new FakeChannelHub();
      const clock = new FakeClock();
      const fixture = await createFixture({
        keys: [`fallback-saved-${failure}`],
        crossTab: {
          hub,
          clock,
          tabId: `tab-fallback-${failure}`,
          behavior: { [failure]: true },
        },
      });
      assert.equal(fixture.client.coordination?.role, "fallback");
      assert.equal((await fixture.client.saveMessage({ messageId })).status, "success");
      assert.deepEqual(commands(fixture).map(({ body }) => body.idempotencyKey), [
        `fallback-saved-${failure}`,
      ]);
      assert.equal(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
      ), null);
      fixture.client.close();
    });
  }
});
