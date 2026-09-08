import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedConversationMembershipIntent,
  createApplicationChatQueuedConversationMembershipIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_DURABLE_EVENT_TYPES,
  CHAT_PROTOCOL_VERSION,
} from "../dist/index.js";

const tenantId = "tenant-membership-recovery";
const actorId = "user-a";
const targetId = "user-b";
const timestamp = "2033-01-02T03:04:05.000Z";
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
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};
const retainedWait = (_delayMs, signal) => new Promise((resolve, reject) => {
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

const canonicalMember = (userId, role = "member", state = "active") => ({
  userId,
  role,
  state,
  joinedAt: timestamp,
  updatedAt: timestamp,
});

const requestFor = (intent, conversationId, idempotencyKey, overrides = {}) => ({
  operation: "mutate_conversation_membership",
  intent,
  conversationId,
  expectedMemberListRevision: 1,
  idempotencyKey,
  ...(intent === "add_member" || intent === "remove_member" ||
      intent === "change_member_role"
    ? { targetUserId: targetId }
    : {}),
  ...(intent === "add_member" || intent === "change_member_role"
    ? { requestedRole: intent === "change_member_role" ? "moderator" : "member" }
    : {}),
  ...overrides,
});

function membersFor(request) {
  const actor = canonicalMember(
    actorId,
    "owner",
    request.intent === "leave" ? "left" : "active",
  );
  const target = canonicalMember(
    targetId,
    request.intent === "change_member_role" ? request.requestedRole : "member",
    request.intent === "remove_member" ? "removed" : "active",
  );
  return [actor, target];
}

function membershipResult(request, reconciliationStatus = "applied", extra = {}) {
  const targeted = Object.hasOwn(request, "targetUserId");
  return {
    operation: request.operation,
    intent: request.intent,
    reconciliationStatus,
    conversationId: request.conversationId,
    expectedMemberListRevision: request.expectedMemberListRevision,
    memberListRevision:
      reconciliationStatus === "applied" || reconciliationStatus === "replayed"
        ? request.expectedMemberListRevision + 1
        : reconciliationStatus === "member_list_conflict"
          ? request.expectedMemberListRevision + 2
          : request.expectedMemberListRevision,
    memberUserId: targeted ? request.targetUserId : actorId,
    members: membersFor(request),
    ...(targeted ? { targetUserId: request.targetUserId } : {}),
    ...(Object.hasOwn(request, "requestedRole")
      ? { requestedRole: request.requestedRole }
      : {}),
    ...extra,
  };
}

const detail = (
  conversationId,
  revision = 1,
  memberUserIds = [actorId, targetId],
  userId = actorId,
) => ({
  kind: "conversation_detail",
  conversation: {
    id: conversationId,
    tenantId,
    type: "channel",
    visibility: "public",
    name: `Channel ${conversationId}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestSequence: 0,
    activityAt: timestamp,
    unreadMentionCount: 0,
    activeMemberUserIds: memberUserIds,
    memberListRevision: revision,
    memberUserIds,
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: "owner",
      state: memberUserIds.includes(userId) ? "active" : "left",
      joinedAt: timestamp,
      updatedAt: timestamp,
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: 0,
      updatedAt: timestamp,
    },
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: false },
      updatedAt: timestamp,
    },
  },
  _meta: snapshotMetadata(),
});

function seedCache(conversationIds = ["conversation-a"], userId = actorId) {
  const cache = createNormalizedChatCache(cacheIdentity(userId));
  for (const conversationId of conversationIds) {
    cache.hydrateConversationDetail(detail(conversationId, 1, [userId, targetId], userId));
  }
  return cache;
}

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let membershipReplaceGate;
  const storage = createApplicationChatStorage({
    async read(scope, kind) {
      calls.push({ operation: "read", scope, kind });
      return rows.get(storageKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      const call = { operation: "replace", scope, kind, encoded, completed: false };
      calls.push(call);
      if (
        kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents &&
        membershipReplaceGate !== undefined
      ) await membershipReplaceGate.promise;
      rows.set(storageKey(scope, kind), encoded);
      call.completed = true;
    },
    async compareExchange(scope, kind, expected, replacement) {
      const call = {
        operation: "compareExchange", scope, kind, expected, replacement, completed: false,
      };
      calls.push(call);
      if (
        replacement !== null &&
        kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents &&
        membershipReplaceGate !== undefined
      ) await membershipReplaceGate.promise;
      // Keep comparison and mutation together after any simulated storage delay.
      const key = storageKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      call.completed = true;
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
    setMembershipReplaceGate(gate) { membershipReplaceGate = gate; },
    membershipWriteAttempts() {
      return calls.filter((call) =>
        (call.operation === "replace" ||
          (call.operation === "compareExchange" && call.replacement !== null)) &&
        call.kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents);
    },
    membershipWrites() {
      return this.membershipWriteAttempts().filter((call) => call.completed);
    },
  };
}

async function seedMemberships(harness, scope, requests) {
  await harness.storage.replace(
    createApplicationChatQueuedConversationMembershipIntentsRecord(
      scope,
      requests.map((request, index) =>
        createApplicationChatQueuedConversationMembershipIntent(request, {
          enqueueOrder: index + 1,
          enqueuedAt: `2033-01-02T03:04:${String(index).padStart(2, "0")}.000Z`,
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
  cache = seedCache(["conversation-a"], identityRef.current.userId),
  command,
  authority,
  idempotencyKey = "generated-membership-key",
  sockets,
  recovery = {},
} = {}) {
  const requests = [];
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: { generateIdempotencyKey: () => idempotencyKey },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata(sockets !== undefined));
      if (init.method === "GET") {
        const conversationId = decodeURIComponent(String(url).split("/").at(-1));
        requests.push({ kind: "authority", url, conversationId });
        return authority?.(conversationId, requests) ?? response(
          200,
          detail(conversationId, 1, [identityRef.current.userId, targetId], identityRef.current.userId),
        );
      }
      const body = JSON.parse(init.body);
      requests.push({ kind: "membership", url, init, body, scope: identityRef.current });
      return command?.(body, requests) ?? response(200, membershipResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => identityRef.current,
      retainedMembershipRecovery: {
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
  assert.equal(started.state, "ready", JSON.stringify({ started, requests }));
  return { client, cache, harness, identityRef, requests };
}

function createCrossTabMembershipClient({
  tabId,
  clock,
  hub,
  harness,
  requests,
  command,
  behavior,
  idempotencyKey,
}) {
  return createChatClient({
    endpoint: "https://chat.invalid/api",
    cache: seedCache(),
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: { generateIdempotencyKey: () => idempotencyKey },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
      if (init.method === "GET") {
        const conversationId = decodeURIComponent(String(url).split("/").at(-1));
        requests.push({ tabId, kind: "authority", conversationId });
        return response(200, detail(conversationId, 2));
      }
      const body = JSON.parse(init.body);
      const observed = { tabId, kind: "membership", body, signal: init.signal };
      requests.push(observed);
      return command?.(observed) ?? response(200, membershipResult(body));
    },
    normalizedCachePersistence: {
      storage: harness.storage,
      resolveIdentity: () => storageIdentity(),
      retainedMembershipRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 4,
        wait: retainedWait,
      },
    },
    crossTab: {
      sessionFingerprint: "membership-recovery-session",
      tabId,
      clock,
      timing: crossTabTiming,
      channelFactory: hub.factory(tabId, behavior),
    },
  });
}

const crossTabMembershipRequests = (requests) =>
  requests.filter(({ kind }) => kind === "membership");

const membershipRequests = (fixture) =>
  fixture.requests.filter((request) => request.kind === "membership");

test("membership persists before pending projection and dispatch, and snapshots stay canonical", async () => {
  const harness = createStorageHarness();
  const gate = deferred();
  const command = deferred();
  const fixture = await createFixture({ harness, command: () => command.promise });
  harness.setMembershipReplaceGate(gate);
  const pending = fixture.client.joinConversation({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
  });
  await eventually(() => harness.membershipWriteAttempts().length === 1);
  assert.equal(harness.membershipWrites().length, 0);
  assert.equal(membershipRequests(fixture).length, 0);
  assert.deepEqual(fixture.cache.getState().metadata.pendingConversationOperations, {});
  gate.resolve();
  await eventually(() => membershipRequests(fixture).length === 1);
  assert.equal(harness.membershipWrites().length, 1);
  assert.equal(
    Object.keys(fixture.cache.getState().metadata.pendingConversationOperations).length,
    1,
  );
  await eventually(() => harness.calls.some((call) =>
    call.completed &&
    (call.operation === "replace" ||
      (call.operation === "compareExchange" && call.replacement !== null)) &&
    call.kind === ApplicationChatStorageRecordKind.normalizedSnapshot));
  const snapshot = await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.normalizedSnapshot,
  );
  assert.deepEqual(snapshot.snapshot.metadata.pendingConversationOperations, {});
  command.resolve(response(200, membershipResult(membershipRequests(fixture)[0].body)));
  assert.equal((await pending).status, "success");
  fixture.client.close();
});

test("process-loss replay preserves exact requests and FIFO order for all five intents", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  const intents = ["join", "leave", "add_member", "remove_member", "change_member_role"];
  const conversationIds = intents.map((intent) => `conversation-${intent}`);
  const requests = intents.map((intent, index) => requestFor(
    intent,
    conversationIds[index],
    `persisted-${intent}-key`,
  ));
  const canonical = createNormalizedChatCache(cacheIdentity());
  for (const [index, intent] of intents.entries()) {
    const members = intent === "join"
      ? [targetId]
      : intent === "add_member"
        ? [actorId]
        : [actorId, targetId];
    canonical.hydrateConversationDetail(detail(conversationIds[index], 1, members));
  }
  await seedSnapshot(harness, scope, canonical);
  await seedMemberships(harness, scope, requests);
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    idempotencyKey: "must-not-replace-persisted-key",
  });
  await eventually(() => membershipRequests(fixture).length === requests.length);
  assert.deepEqual(membershipRequests(fixture).map(({ body }) => body), requests);
  assert.deepEqual(
    membershipRequests(fixture).map(({ init }) => init.headers["idempotency-key"]),
    requests.map(({ idempotencyKey }) => idempotencyKey),
  );
  await eventually(async () => await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ) === null);
  fixture.client.close();
});

test("recovery awaits a canonical conversation and authoritative revision before replay", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  const request = requestFor("leave", "conversation-missing", "await-authority-key");
  await seedMemberships(harness, scope, [request]);
  const authorityGate = deferred();
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(cacheIdentity()),
    authority: () => authorityGate.promise,
  });
  await eventually(() => fixture.requests.some(({ kind }) => kind === "authority"));
  assert.equal(membershipRequests(fixture).length, 0);
  authorityGate.resolve(response(
    200,
    detail("conversation-missing", 1, [actorId, targetId]),
  ));
  await eventually(() => membershipRequests(fixture).length === 1);
  assert.deepEqual(membershipRequests(fixture)[0].body, request);
  fixture.client.close();
});

test("HTTP, event-first, and already-applied canonical state each settle durable work", async (t) => {
  await t.test("HTTP", async () => {
    const fixture = await createFixture();
    assert.equal((await fixture.client.addConversationMember({
      conversationId: "conversation-a",
      expectedMemberListRevision: 1,
      targetUserId: targetId,
      requestedRole: "member",
    })).status, "success");
    assert.equal(await fixture.harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ), null);
    fixture.client.close();
  });

  await t.test("event first", async () => {
    const scope = storageIdentity();
    const sockets = createSockets(scope);
    const command = deferred();
    const fixture = await createFixture({ sockets, command: () => command.promise });
    await eventually(() => sockets.sockets.length === 1);
    sockets.sockets[0].accept();
    const pending = fixture.client.changeConversationMemberRole({
      conversationId: "conversation-a",
      expectedMemberListRevision: 1,
      targetUserId: targetId,
      requestedRole: "moderator",
    });
    await eventually(() => membershipRequests(fixture).length === 1);
    const request = membershipRequests(fixture)[0].body;
    const result = membershipResult(request);
    sockets.sockets[0].event({
      eventId: "membership-event-first",
      protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId,
      streamId: request.conversationId,
      type: CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
      occurredAt: timestamp,
      payload: { input: request, result },
    });
    assert.equal((await pending).status, "success");
    await eventually(async () => await fixture.harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ) === null);
    command.resolve(response(200, result));
    fixture.client.close();
  });

  await t.test("already applied", async () => {
    const harness = createStorageHarness();
    const scope = storageIdentity();
    const request = requestFor(
      "change_member_role",
      "conversation-a",
      "already-applied-role-key",
    );
    const canonical = seedCache();
    const logicalKey = JSON.stringify([
      "membership",
      request.intent,
      request.conversationId,
      request.expectedMemberListRevision,
      request.targetUserId,
      request.requestedRole,
    ]);
    canonical.beginConversationOperation({
      logicalKey,
      idempotencyKey: request.idempotencyKey,
      family: "membership",
      conversationId: request.conversationId,
    });
    canonical.reconcileConversationMembership(logicalKey, request, membershipResult(request));
    await seedSnapshot(harness, scope, canonical);
    await seedMemberships(harness, scope, [request]);
    const fixture = await createFixture({ harness, cache: createNormalizedChatCache() });
    await eventually(async () => await harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ) === null);
    assert.equal(membershipRequests(fixture).length, 0);
    fixture.client.close();
  });
});

test("ambiguous outcomes retain the exact membership intent", async (t) => {
  for (const [name, command, expectedStatus] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["rate limit", () => response(429, {
      error: { code: "RATE_LIMITED", message: "slow down" },
    }), "transport"],
    ["server failure", () => response(503, {
      error: { code: "UNAVAILABLE", message: "later" },
    }), "transport"],
    ["malformed response", () => response(200, { invalid: true }), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const key = `ambiguous-${name.replaceAll(" ", "-")}`;
      const fixture = await createFixture({ command, idempotencyKey: key });
      assert.equal((await fixture.client.removeConversationMember({
        conversationId: "conversation-a",
        expectedMemberListRevision: 1,
        targetUserId: targetId,
      })).status, expectedStatus);
      const record = await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
      );
      assert.equal(record.intents[0].request.idempotencyKey, key);
      fixture.client.close();
    });
  }

  await t.test("disconnect cancellation after dispatch", async () => {
    const scope = storageIdentity();
    const sockets = createSockets(scope);
    const command = deferred();
    const fixture = await createFixture({ sockets, command: () => command.promise });
    await eventually(() => sockets.sockets.length === 1);
    sockets.sockets[0].accept();
    const pending = fixture.client.leaveConversation({
      conversationId: "conversation-a",
      expectedMemberListRevision: 1,
    });
    await eventually(() => membershipRequests(fixture).length === 1);
    sockets.sockets[0].disconnect();
    assert.ok(["aborted", "closed"].includes((await pending).status));
    assert.notEqual(await fixture.harness.storage.read(
      scope,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ), null);
    command.resolve(response(200, membershipResult(membershipRequests(fixture)[0].body)));
    fixture.client.close();
  });

  await t.test("client close", async () => {
    const command = deferred();
    const fixture = await createFixture({ command: () => command.promise });
    const pending = fixture.client.joinConversation({
      conversationId: "conversation-a",
      expectedMemberListRevision: 1,
    });
    await eventually(() => membershipRequests(fixture).length === 1);
    fixture.client.close();
    assert.equal((await pending).status, "closed");
    assert.notEqual(await fixture.harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ), null);
    command.resolve(response(200, membershipResult(membershipRequests(fixture)[0].body)));
  });
});

test("ambiguous recovery uses the injected bounded exponential backoff", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  const request = requestFor("leave", "conversation-a", "backoff-key");
  await seedSnapshot(harness, scope, seedCache());
  await seedMemberships(harness, scope, [request]);
  const delays = [];
  const gates = [];
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    command: () => { throw new Error("offline"); },
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
  assert.notEqual(await harness.storage.read(
    scope,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), null);
  fixture.client.close();
});

test("terminal outcomes refresh authority before removing the intent", async (t) => {
  for (const [name, command] of [
    ["authentication", () => response(401, {
      error: { code: "CHAT_AUTHENTICATION_FAILED", message: "login" },
    })],
    ["permission", () => response(403, {
      error: { code: "CHAT_PERMISSION_DENIED", message: "denied" },
    })],
    ["validation", () => response(422, {
      error: { code: "INVALID_MEMBERSHIP", message: "invalid" },
    })],
    ["conflict", (request) => response(409, membershipResult(
      request,
      "member_list_conflict",
    ))],
    ["safety", (request) => response(409, membershipResult(
      request,
      "safety_rejected",
      { safetyError: { code: "last_owner", message: "last owner" } },
    ))],
  ]) {
    await t.test(name, async () => {
      const authorityGate = deferred();
      const fixture = await createFixture({
        command,
        authority: () => authorityGate.promise,
      });
      const pending = fixture.client.changeConversationMemberRole({
        conversationId: "conversation-a",
        expectedMemberListRevision: 1,
        targetUserId: name === "safety" ? actorId : targetId,
        requestedRole: "member",
      });
      await eventually(() => fixture.requests.some(({ kind }) => kind === "authority"));
      assert.notEqual(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
      ), null);
      assert.equal(fixture.harness.calls.some((call) =>
        (call.operation === "remove" ||
          (call.operation === "compareExchange" && call.replacement === null)) &&
        call.kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents), false);
      authorityGate.resolve(response(200, detail("conversation-a", 2)));
      await pending;
      assert.equal(await fixture.harness.storage.read(
        storageIdentity(),
        ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
      ), null);
      fixture.client.close();
    });
  }
});

test("recovery pauses while disconnected and resumes on reconnect in conversation FIFO order", async () => {
  const harness = createStorageHarness();
  const scope = storageIdentity();
  const requests = [
    requestFor("leave", "conversation-a", "fifo-one"),
    requestFor("join", "conversation-a", "fifo-two", {
      expectedMemberListRevision: 2,
    }),
  ];
  await seedSnapshot(harness, scope, seedCache());
  await seedMemberships(harness, scope, requests);
  const sockets = createSockets(scope);
  const first = deferred();
  const fixture = await createFixture({
    harness,
    cache: createNormalizedChatCache(),
    sockets,
    command: (request, allRequests) => {
      const count = allRequests.filter(({ kind }) => kind === "membership").length;
      return count === 1 ? first.promise : response(200, membershipResult(request));
    },
  });
  await eventually(() => sockets.sockets.length === 1);
  assert.equal(membershipRequests(fixture).length, 0);
  sockets.sockets[0].accept();
  await eventually(() => membershipRequests(fixture).length === 1);
  assert.equal(membershipRequests(fixture)[0].body.idempotencyKey, "fifo-one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(membershipRequests(fixture).length, 1);
  first.resolve(response(200, membershipResult(requests[0])));
  await eventually(() => membershipRequests(fixture).length === 2);
  assert.equal(membershipRequests(fixture)[1].body.idempotencyKey, "fifo-two");
  fixture.client.close();
});

test("a delayed old-identity completion cannot mutate or remove the new identity", async () => {
  const harness = createStorageHarness();
  const identityRef = { current: storageIdentity(actorId) };
  await seedSnapshot(harness, identityRef.current, seedCache());
  const command = deferred();
  const first = await createFixture({
    harness,
    identityRef,
    cache: createNormalizedChatCache(),
    command: () => command.promise,
    idempotencyKey: "old-identity-key",
  });
  const pending = first.client.joinConversation({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
  });
  await eventually(() => membershipRequests(first).length === 1);
  first.client.close();
  assert.equal((await pending).status, "closed");

  identityRef.current = storageIdentity("user-c");
  await seedSnapshot(harness, identityRef.current, seedCache(["conversation-a"], "user-c"));
  assert.equal((await first.client.start()).state, "ready");
  command.resolve(response(200, membershipResult(membershipRequests(first)[0].body)));
  await new Promise((resolve) => setImmediate(resolve));
  const oldRecord = await harness.storage.read(
    storageIdentity(actorId),
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  );
  assert.equal(oldRecord.intents[0].request.idempotencyKey, "old-identity-key");
  assert.equal(await harness.storage.read(
    identityRef.current,
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), null);
  assert.equal(first.cache.getState().identity.userId, "user-c");
  first.client.close();
});

test("a follower announces a persisted membership intent and the leader settles it once", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const requests = [];
  const gate = deferred();
  const command = ({ body }) => gate.promise.then(() =>
    response(200, membershipResult(body)));
  const leader = createCrossTabMembershipClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    requests,
    command,
    idempotencyKey: "cross-tab-success",
  });
  const follower = createCrossTabMembershipClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    requests,
    command,
    idempotencyKey: "cross-tab-success",
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  assert.equal(leader.coordination?.role, "leader");
  assert.equal(follower.coordination?.role, "follower");

  const pending = follower.removeConversationMember({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
    targetUserId: targetId,
  });
  await eventually(() => hub.messages.some(
    (message) => message.kind === "persisted-command-available",
  ));
  const announcement = hub.messages.findLast(
    (message) => message.kind === "persisted-command-available",
  );
  assert.deepEqual(announcement.payload, {
    command: "conversation.membership.mutate",
    idempotencyKey: "cross-tab-success",
  });
  await eventually(() => hub.messages.some((message) => message.kind === "command-claim"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => crossTabMembershipRequests(requests).length === 1);
  assert.equal(crossTabMembershipRequests(requests)[0].tabId, "tab-a");
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), null);

  clock.tick(crossTabTiming.commandClaimLeaseMs * 2);
  assert.equal(crossTabMembershipRequests(requests).length, 1);
  gate.resolve();
  assert.equal((await pending).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ) === null);
  assert.equal(crossTabMembershipRequests(requests).length, 1);
  assert.equal(hub.messages.filter((message) =>
    message.kind === "command-result" &&
    message.payload.command === "conversation.membership.mutate").length, 1);
  leader.close();
  follower.close();
});

test("membership leadership transfer retains ambiguous work until the old claim expires", async () => {
  const clock = new CrossTabClock();
  const hub = new CrossTabChannelHub();
  const harness = createStorageHarness();
  const requests = [];
  const oldResponse = deferred();
  const command = ({ tabId, body }) => tabId === "tab-a"
    ? oldResponse.promise
    : response(200, membershipResult(body));
  const leader = createCrossTabMembershipClient({
    tabId: "tab-a",
    clock,
    hub,
    harness,
    requests,
    command,
    idempotencyKey: "cross-tab-transfer",
  });
  const follower = createCrossTabMembershipClient({
    tabId: "tab-b",
    clock,
    hub,
    harness,
    requests,
    command,
    idempotencyKey: "cross-tab-transfer",
  });
  await Promise.all([leader.start(), follower.start()]);
  clock.tick(crossTabTiming.electionDelayMs);
  const pending = follower.removeConversationMember({
    conversationId: "conversation-a",
    expectedMemberListRevision: 1,
    targetUserId: targetId,
  });
  await eventually(() => hub.messages.some((message) => message.kind === "command-claim"));
  clock.tick(crossTabTiming.commandClaimDelayMs);
  await eventually(() => crossTabMembershipRequests(requests).length === 1);

  leader.close();
  assert.equal(crossTabMembershipRequests(requests)[0].signal.aborted, true);
  assert.notEqual(await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ), null);
  clock.tick(crossTabTiming.electionDelayMs);
  await eventually(() => follower.coordination?.role === "leader");
  await eventually(() => hub.messages.some(
    (message) => message.kind === "command-claim" && message.senderId === "tab-b",
  ));
  clock.tick(crossTabTiming.commandClaimLeaseMs - 1);
  assert.equal(crossTabMembershipRequests(requests).length, 1);
  clock.tick(crossTabTiming.commandClaimDelayMs + 1);
  await eventually(() => crossTabMembershipRequests(requests).length === 2);
  assert.equal(crossTabMembershipRequests(requests)[1].tabId, "tab-b");
  assert.equal((await pending).status, "success");
  await eventually(async () => await harness.storage.read(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
  ) === null);
  oldResponse.resolve(response(
    200,
    membershipResult(crossTabMembershipRequests(requests)[0].body),
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(crossTabMembershipRequests(requests).length, 2);
  follower.close();
});

test("terminal membership fanout settles a follower and channel failure stays fail-open", async (t) => {
  await t.test("terminal result fanout", async () => {
    const clock = new CrossTabClock();
    const hub = new CrossTabChannelHub();
    const harness = createStorageHarness();
    const requests = [];
    const command = () => response(401, {
      error: { code: "CHAT_AUTHENTICATION_FAILED", message: "login" },
    });
    const leader = createCrossTabMembershipClient({
      tabId: "tab-a",
      clock,
      hub,
      harness,
      requests,
      command,
      idempotencyKey: "cross-tab-terminal",
    });
    const follower = createCrossTabMembershipClient({
      tabId: "tab-b",
      clock,
      hub,
      harness,
      requests,
      command,
      idempotencyKey: "cross-tab-terminal",
    });
    await Promise.all([leader.start(), follower.start()]);
    clock.tick(crossTabTiming.electionDelayMs);
    const pending = follower.changeConversationMemberRole({
      conversationId: "conversation-a",
      expectedMemberListRevision: 1,
      targetUserId: targetId,
      requestedRole: "moderator",
    });
    await eventually(() => hub.messages.some((message) => message.kind === "command-claim"));
    clock.tick(crossTabTiming.commandClaimDelayMs);
    assert.equal((await pending).status, "authentication");
    assert.equal(crossTabMembershipRequests(requests).length, 1);
    assert.equal(crossTabMembershipRequests(requests)[0].tabId, "tab-a");
    assert.equal(await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ), null);
    assert.equal(hub.messages.some((message) =>
      message.kind === "command-result" &&
      message.payload.result.status === "authentication"), true);
    leader.close();
    follower.close();
  });

  await t.test("BroadcastChannel unavailable", async () => {
    const clock = new CrossTabClock();
    const hub = new CrossTabChannelHub();
    const harness = createStorageHarness();
    const requests = [];
    const client = createCrossTabMembershipClient({
      tabId: "tab-local",
      clock,
      hub,
      harness,
      requests,
      behavior: { constructThrows: true },
      idempotencyKey: "cross-tab-fallback",
    });
    assert.equal((await client.start()).state, "ready");
    assert.equal(client.coordination?.role, "fallback");
    assert.equal((await client.leaveConversation({
      conversationId: "conversation-a",
      expectedMemberListRevision: 1,
    })).status, "success");
    assert.equal(crossTabMembershipRequests(requests).length, 1);
    assert.equal(hub.messages.length, 0);
    assert.equal(await harness.storage.read(
      storageIdentity(),
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    ), null);
    client.close();
  });
});
