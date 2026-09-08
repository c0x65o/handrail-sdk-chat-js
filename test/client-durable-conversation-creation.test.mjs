import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedConversationCreationIntent,
  createApplicationChatQueuedConversationCreationIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  deriveCanonicalParticipantIdentity,
} from "../dist/client/index.js";
import {
  CHAT_DURABLE_EVENT_TYPES,
  CHAT_PROTOCOL_VERSION,
} from "../dist/index.js";

const tenantId = "tenant-creation-recovery";
const actorId = "user-a";
const timestamp = "2034-02-03T04:05:06.000Z";
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

  injectTo(owner, data) {
    for (const channel of this.channels) {
      if (channel.owner === owner) {
        for (const listener of channel.listeners) {
          listener({ data: structuredClone(data) });
        }
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

function detail(input, id, userId = actorId) {
  const memberUserIds = input.type === "channel"
    ? [userId]
    : [userId, ...input.intendedMemberUserIds].sort();
  return {
    kind: "conversation_detail",
    conversation: {
      id,
      tenantId,
      type: input.type,
      visibility: input.type === "channel" ? input.visibility : "private",
      ...(input.type === "channel" ? { name: input.name } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      latestSequence: 0,
      activityAt: timestamp,
      unreadMentionCount: 0,
      activeMemberUserIds: memberUserIds,
      memberUserIds,
      memberListRevision: 1,
      currentMember: {
        tenantId,
        conversationId: id,
        userId,
        role: "owner",
        state: "active",
        joinedAt: timestamp,
        updatedAt: timestamp,
      },
      currentReadState: {
        conversationId: id,
        userId,
        lastReadSequence: 0,
        updatedAt: timestamp,
      },
      currentPreference: {
        conversationId: id,
        userId,
        notificationPreference: "all",
        isStarred: false,
        mute: { muted: false },
        updatedAt: timestamp,
      },
    },
    _meta: snapshotMetadata(),
  };
}

function creationResult(input, id, userId = actorId, status = "created") {
  return {
    operation: "create_conversation",
    type: input.type,
    reconciliationStatus: status,
    clientRequestId: input.clientRequestId,
    conversation: detail(input, id, userId),
    ...(input.type === "channel" ? {} : {
      participantIdentity: deriveCanonicalParticipantIdentity(
        userId,
        input.intendedMemberUserIds,
      ),
    }),
  };
}

const requests = Object.freeze([
  {
    operation: "create_conversation",
    type: "channel",
    name: "Durable channel",
    visibility: "private",
    entity: { type: "project", id: "project-a" },
    idempotencyKey: "create-channel-key",
    clientRequestId: "create-channel-request",
  },
  {
    operation: "create_conversation",
    type: "direct",
    visibility: "private",
    intendedMemberUserIds: ["user-b"],
    idempotencyKey: "create-direct-key",
    clientRequestId: "create-direct-request",
  },
  {
    operation: "create_conversation",
    type: "group_direct",
    visibility: "private",
    intendedMemberUserIds: ["user-b", "user-c"],
    idempotencyKey: "create-group-key",
    clientRequestId: "create-group-request",
  },
]);

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let creationReplaceGate;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope, kind, encoded });
      if (
        kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents &&
        creationReplaceGate !== undefined
      ) await creationReplaceGate.promise;
      rows.set(storageKey(scope, kind), encoded);
    },
    async compareExchange(scope, kind, expected, replacement) {
      calls.push({ operation: "compareExchange", scope, kind, expected, replacement });
      if (
        replacement !== null &&
        kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents &&
        creationReplaceGate !== undefined
      ) await creationReplaceGate.promise;
      // Keep comparison and mutation together after any simulated storage delay.
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
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
    setCreationReplaceGate(gate) { creationReplaceGate = gate; },
  };
}

async function seedCreations(harness, scope, values) {
  await harness.storage.replace(
    createApplicationChatQueuedConversationCreationIntentsRecord(
      scope,
      values.map((request, index) =>
        createApplicationChatQueuedConversationCreationIntent(request, {
          enqueueOrder: index + 1,
          enqueuedAt: `2034-02-03T04:05:${String(index).padStart(2, "0")}.000Z`,
        })),
    ),
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

async function createFixture({
  harness = createStorageHarness(),
  identityRef = { current: storageIdentity() },
  cache = createNormalizedChatCache(cacheIdentity(identityRef.current.userId)),
  command,
  sockets,
  recovery = {},
  generated = { idempotency: 0, request: 0 },
} = {}) {
  const observed = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: {
      generateIdempotencyKey: () => `generated-key-${++generated.idempotency}`,
      generateClientRequestId: () => `generated-request-${++generated.request}`,
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata(sockets !== undefined));
      const body = JSON.parse(init.body);
      observed.push({ url, init, body, scope: { ...identityRef.current } });
      return command?.(body, observed) ??
        response(201, creationResult(body, `conversation-${observed.length}`, identityRef.current.userId));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      retainedConversationCreationRecovery: {
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
  assert.equal(started.state, "ready", JSON.stringify(started));
  return { client, cache, harness, identityRef, observed };
}

function createCrossTabCreationClient({
  tabId,
  clock,
  hub,
  harness,
  observed,
  command,
  behavior,
  identity = storageIdentity(),
  fingerprint = "conversation-creation-recovery-session",
  idempotencyKey = "cross-tab-creation-key",
  clientRequestId = "cross-tab-creation-request",
}) {
  return createChatClient({
    endpoint: "https://chat.invalid/api",
    cache: createNormalizedChatCache(cacheIdentity(identity.userId)),
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: {
      generateIdempotencyKey: () => idempotencyKey,
      generateClientRequestId: () => clientRequestId,
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
      const body = JSON.parse(init.body);
      const request = { tabId, body, signal: init.signal };
      observed.push(request);
      return command?.(request) ?? response(
        201,
        creationResult(body, `conversation-${observed.length}`, identity.userId),
      );
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identity,
      retainedConversationCreationRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 4,
        wait: retainedWait,
      },
    },
    crossTab: {
      sessionFingerprint: fingerprint,
      tabId,
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory(tabId, behavior),
    },
  });
}

test("creation persists before dispatch and duplicate authored retries reuse correlation", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  harness.setCreationReplaceGate(gate);
  const fixture = await createFixture({ harness });
  const first = fixture.client.createChannel({
    name: "Durable channel",
    visibility: "private",
    entity: { type: "project", id: "project-a" },
  });
  const duplicate = fixture.client.createChannel({
    name: "Durable channel",
    visibility: "private",
    entity: { type: "project", id: "project-a" },
  });
  await eventually(() => harness.calls.some((call) =>
    call.operation === "compareExchange" && call.replacement !== null &&
    call.kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents));
  assert.equal(fixture.observed.length, 0);
  gate.resolve();
  assert.equal((await first).status, "success");
  assert.equal((await duplicate).status, "success");
  assert.equal(fixture.observed.length, 1);
  assert.equal(fixture.observed[0].body.idempotencyKey, "generated-key-1");
  assert.equal(fixture.observed[0].body.clientRequestId, "generated-request-1");
  fixture.client.close();
});

test("restart replays exact channel, direct, and group-direct requests in persisted order", async () => {
  const harness = createStorageHarness();
  await seedCreations(harness, storageIdentity(), requests);
  const fixture = await createFixture({ harness });
  await eventually(() => fixture.observed.length === 3);
  assert.deepEqual(fixture.observed.map(({ body }) => body), requests);
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ) === null);
  fixture.client.close();
});

test("a matching conversation.created event settles storage and the active caller first", async () => {
  const scope = storageIdentity();
  const harness = createStorageHarness();
  const sockets = createSockets(scope);
  const command = deferred();
  const fixture = await createFixture({ harness, sockets, command: () => command.promise });
  await eventually(() => sockets.sockets.length === 1);
  sockets.sockets[0].accept();
  const pending = fixture.client.createChannel({ name: "Event first", visibility: "public" });
  await eventually(() => fixture.observed.length === 1);
  const input = fixture.observed[0].body;
  sockets.sockets[0].event({
    eventId: "event-created-1",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: "event-conversation",
    type: CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    occurredAt: timestamp,
    payload: {
      clientRequestId: input.clientRequestId,
      conversation: {
        id: "event-conversation",
        tenantId,
        type: "channel",
        visibility: "public",
        name: "Event first",
        createdAt: timestamp,
        updatedAt: timestamp,
        memberUserIds: [actorId],
      },
    },
  });
  assert.equal((await pending).status, "success");
  assert.equal(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.observed.length, 1);
  command.resolve(response(201, creationResult(input, "event-conversation")));
  fixture.client.close();
});

test("an equivalent canonical direct settles a retained request without dispatch", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  const canonical = createNormalizedChatCache(cacheIdentity());
  canonical.hydrateConversationDetail(detail(requests[1], "existing-direct"));
  await seedSnapshot(harness, scope, canonical);
  await seedCreations(harness, scope, [requests[1]]);
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
  });
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ) === null);
  assert.equal(fixture.observed.length, 0);
  fixture.client.close();
});

test("ambiguous failures retain work and use bounded injectable backoff", async () => {
  const harness = createStorageHarness();
  await seedCreations(harness, storageIdentity(), [requests[0]]);
  const delays = [];
  const gates = [];
  const fixture = await createFixture({
    harness,
    command: () => response(503, { error: { code: "UNAVAILABLE" } }),
    recovery: {
      initialDelayMs: 2,
      maximumDelayMs: 3,
      multiplier: 2,
      wait(delayMs, signal) {
        delays.push(delayMs);
        const gate = deferred();
        gates.push(gate);
        signal.addEventListener("abort", () => gate.reject(new Error("aborted")), {
          once: true,
        });
        return gate.promise;
      },
    },
  });
  await eventually(() => delays.length === 1);
  assert.deepEqual(delays, [2]);
  gates[0].resolve();
  await eventually(() => delays.length === 2);
  assert.deepEqual(delays, [2, 3]);
  const retained = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  );
  assert.deepEqual(retained.intents[0].request, requests[0]);
  fixture.client.close();
});

test("transport, rate-limit, and malformed acknowledgements retain exact work", async (t) => {
  for (const [name, command] of [
    ["transport", () => { throw new Error("offline"); }],
    ["rate limit", () => response(429, {
      error: { code: "RATE_LIMITED", message: "retry later" },
    })],
    ["malformed success", () => response(200, { invalid: true })],
  ]) {
    await t.test(name, async () => {
      const harness = createStorageHarness();
      await seedCreations(harness, storageIdentity(), [requests[0]]);
      const fixture = await createFixture({ harness, command });
      await eventually(() => fixture.observed.length === 1);
      const retained = await harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
      );
      assert.deepEqual(retained.intents[0].request, requests[0]);
      fixture.client.close();
    });
  }
});

test("terminal authentication, permission, validation, and conflict results remove work", async (t) => {
  for (const [name, status, code] of [
    ["authentication", 401, "CHAT_AUTHENTICATION_FAILED"],
    ["permission", 403, "CHAT_PERMISSION_DENIED"],
    ["validation", 422, "INVALID_CONVERSATION"],
    ["conflict", 409, "CONVERSATION_CONFLICT"],
  ]) {
    await t.test(name, async () => {
      const harness = createStorageHarness();
      await seedCreations(harness, storageIdentity(), [requests[0]]);
      const fixture = await createFixture({
        harness,
        command: () => response(status, {
          error: { code, message: "terminal result" },
        }),
      });
      await eventually(async () => await harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
      ) === null);
      assert.equal(fixture.observed.length, 1);
      fixture.client.close();
    });
  }
});

test("recovery pauses offline and resumes the same intent after reconnect", async () => {
  const scope = storageIdentity();
  const harness = createStorageHarness();
  await seedCreations(harness, scope, [requests[0]]);
  const sockets = createSockets(scope);
  let attempt = 0;
  const fixture = await createFixture({
    harness,
    sockets,
    command: (input, observed) => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise((_resolve, reject) => {
          observed[0].init.signal.addEventListener(
            "abort",
            () => reject(new Error("disconnected")),
            { once: true },
          );
        });
      }
      return response(201, creationResult(input, "reconnected-conversation"));
    },
  });
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(fixture.observed.length, 0);
  sockets.sockets[0].accept();
  await eventually(() => fixture.observed.length === 1);
  sockets.sockets[0].disconnect();
  await eventually(() => sockets.sockets.length === 2);
  sockets.sockets[1].accept();
  await eventually(() => fixture.observed.length === 2);
  assert.deepEqual(fixture.observed.map(({ body }) => body), [requests[0], requests[0]]);
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ) === null);
  fixture.client.close();
});

test("a stale identity completion cannot settle either identity's later scope", async () => {
  const harness = createStorageHarness();
  const identityRef = { current: storageIdentity(actorId) };
  const command = deferred();
  const fixture = await createFixture({ harness, identityRef, command: () => command.promise });
  const pending = fixture.client.createChannel({ name: "Old identity", visibility: "public" });
  await eventually(() => fixture.observed.length === 1);
  const oldInput = fixture.observed[0].body;
  fixture.client.close();
  assert.equal((await pending).status, "closed");

  identityRef.current = storageIdentity("user-z");
  await seedSnapshot(
    harness,
    identityRef.current,
    createNormalizedChatCache(cacheIdentity("user-z")),
  );
  assert.equal((await fixture.client.start()).state, "ready");
  command.resolve(response(201, creationResult(oldInput, "stale-created")));
  await new Promise((resolve) => setImmediate(resolve));
  const oldRecord = await harness.storage.read(
    storageIdentity(actorId),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  );
  assert.equal(oldRecord.intents[0].request.clientRequestId, oldInput.clientRequestId);
  assert.equal(await harness.storage.read(
    identityRef.current,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  assert.equal(fixture.cache.getState().identity.userId, "user-z");
  fixture.client.close();
});

test("a follower persists creation before the leader dispatches and reconciles its canonical fanout", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const observed = [];
  const gate = deferred();
  const command = ({ body }) => gate.promise.then(() => response(
    201,
    creationResult(body, "cross-tab-created"),
  ));
  const leader = createCrossTabCreationClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    observed,
    command,
  });
  const follower = createCrossTabCreationClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    observed,
    command,
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.coordination?.role, "leader");
  assert.equal(follower.coordination?.role, "follower");

  const pending = follower.createChannel({
    name: "Cross-tab channel",
    visibility: "private",
  });
  await eventually(() => hub.messages.some(
    (message) => message.kind === "persisted-command-available" &&
      message.payload.command === "conversation.create",
  ));
  const announcement = hub.messages.findLast(
    (message) => message.kind === "persisted-command-available",
  );
  assert.deepEqual(announcement.payload, {
    command: "conversation.create",
    idempotencyKey: "cross-tab-creation-key",
  });
  const stored = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  );
  assert.equal(stored.intents[0].request.clientRequestId, "cross-tab-creation-request");
  assert.equal(observed.length, 0);

  await eventually(() => hub.messages.some(
    (message) => message.kind === "command-claim" &&
      message.payload.command === "conversation.create",
  ));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => observed.length === 1);
  assert.equal(observed[0].tabId, "tab-a");
  assert.equal(observed[0].body.idempotencyKey, "cross-tab-creation-key");
  assert.equal(observed[0].body.clientRequestId, "cross-tab-creation-request");

  const duplicate = follower.createChannel({
    name: "Cross-tab channel",
    visibility: "private",
  });
  await eventually(() => hub.messages.filter(
    (message) => message.kind === "persisted-command-available" &&
      message.payload.command === "conversation.create",
  ).length === 2);
  clock.tick(crossTabTiming.commandClaimLeaseMs * 2);
  assert.equal(observed.length, 1);

  gate.resolve();
  const [result, duplicateResult] = await Promise.all([pending, duplicate]);
  assert.equal(result.status, "success");
  assert.equal(duplicateResult.status, "success");
  assert.equal(result.value.conversation.conversation.id, "cross-tab-created");
  assert.equal(
    follower.cache.getState().entities.conversations["cross-tab-created"].name,
    "Cross-tab channel",
  );
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ) === null);
  assert.equal(observed.length, 1);
  assert.equal(hub.messages.filter((message) =>
    message.kind === "command-result" &&
    message.payload.command === "conversation.create").length, 1);
  leader.close();
  follower.close();
});

test("creation leadership transfer retains and reuses the exact persisted correlation", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const observed = [];
  const abandoned = deferred();
  const command = ({ tabId, body }) => tabId === "tab-a"
    ? abandoned.promise
    : response(201, creationResult(body, "created-after-transfer"));
  const leader = createCrossTabCreationClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    observed,
    command,
    idempotencyKey: "transfer-key",
    clientRequestId: "transfer-request",
  });
  const follower = createCrossTabCreationClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    observed,
    command,
    idempotencyKey: "unused-replacement-key",
    clientRequestId: "unused-replacement-request",
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  const pending = follower.createChannel({
    name: "Transfer channel",
    visibility: "public",
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.command === "conversation.create"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => observed.length === 1);
  const exactRequest = structuredClone(observed[0].body);
  assert.equal(exactRequest.idempotencyKey, "unused-replacement-key");
  assert.equal(exactRequest.clientRequestId, "unused-replacement-request");

  leader.close();
  assert.equal(observed[0].signal.aborted, true);
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  clock.tick(crossTabTiming.electionDelayMs);
  await eventually(() => follower.coordination?.role === "leader");
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.senderId === "tab-b" &&
    message.payload.command === "conversation.create"));
  clock.tick(crossTabTiming.commandClaimLeaseMs - 1);
  assert.equal(observed.length, 1);
  clock.tick(crossTabTiming.commandClaimDelayMs + 1);
  await eventually(() => observed.length === 2);
  assert.deepEqual(observed[1].body, exactRequest);
  assert.equal((await pending).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ) === null);
  abandoned.resolve(response(201, creationResult(exactRequest, "abandoned-result")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 2);
  follower.close();
});

test("creation announcements reject malformed envelopes and foreign identity records", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const observed = [];
  const foreignRequest = {
    ...requests[0],
    idempotencyKey: "foreign-creation-key",
    clientRequestId: "foreign-creation-request",
  };
  await seedCreations(harness, storageIdentity("user-z"), [foreignRequest]);
  const leader = createCrossTabCreationClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    observed,
  });
  const follower = createCrossTabCreationClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    observed,
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  const base = hub.messages.findLast((message) => message.senderId === "tab-b");
  const announcement = {
    ...base,
    kind: "persisted-command-available",
    payload: {
      command: "conversation.create",
      idempotencyKey: "foreign-creation-key",
    },
  };
  hub.injectTo("tab-a", announcement);
  hub.injectTo("tab-a", {
    ...announcement,
    payload: { ...announcement.payload, request: foreignRequest },
  });
  hub.injectTo("tab-a", {
    ...announcement,
    namespace: `${announcement.namespace}:foreign`,
  });
  hub.injectTo("tab-a", {
    ...announcement,
    payload: { ...announcement.payload, command: "conversation.unknown" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observed.length, 0);
  assert.notEqual(await harness.storage.read(
    storageIdentity("user-z"),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  assert.equal(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  leader.close();
  follower.close();
});

test("a descriptor-valid but identity-mismatched creation result is not reconciled", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const observed = [];
  const gate = deferred();
  const command = ({ body }) => gate.promise.then(() => response(
    201,
    creationResult(body, "authoritative-created"),
  ));
  const leader = createCrossTabCreationClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    observed,
    command,
    idempotencyKey: "identity-result-key",
    clientRequestId: "identity-result-request",
  });
  const follower = createCrossTabCreationClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    observed,
    command,
    idempotencyKey: "identity-result-key",
    clientRequestId: "identity-result-request",
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  const pending = follower.createChannel({
    name: "Identity channel",
    visibility: "public",
  });
  await eventually(() => hub.messages.some((message) =>
    message.kind === "command-claim" &&
    message.payload.command === "conversation.create"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => observed.length === 1);
  const claim = hub.messages.findLast((message) =>
    message.kind === "command-claim" && message.senderId === "tab-a");
  hub.injectTo("tab-b", {
    ...claim,
    kind: "command-result",
    payload: {
      command: "conversation.create",
      idempotencyKey: "identity-result-key",
      result: {
        status: "success",
        value: creationResult(
          observed[0].body,
          "foreign-result",
          "user-z",
        ),
      },
    },
  });
  assert.equal((await pending).status, "malformed_response");
  assert.equal(
    follower.cache.getState().entities.conversations["foreign-result"],
    undefined,
  );
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  gate.resolve();
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ) === null);
  assert.equal(
    follower.cache.getState().entities.conversations["authoritative-created"].name,
    "Identity channel",
  );
  leader.close();
  follower.close();
});

test("conversation creation remains fail-open when cross-tab coordination falls back", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const observed = [];
  const client = createCrossTabCreationClient({
    tabId: "tab-local",
    clock,
    hub,
    harness,
    observed,
    behavior: { constructThrows: true },
    idempotencyKey: "fallback-key",
    clientRequestId: "fallback-request",
  });
  assert.equal((await client.start()).state, "ready");
  assert.equal(client.coordination?.role, "fallback");
  const result = await client.createChannel({
    name: "Fallback channel",
    visibility: "public",
  });
  assert.equal(result.status, "success");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].body.idempotencyKey, "fallback-key");
  assert.equal(observed[0].body.clientRequestId, "fallback-request");
  assert.equal(hub.messages.length, 0);
  assert.equal(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  ), null);
  client.close();
});
