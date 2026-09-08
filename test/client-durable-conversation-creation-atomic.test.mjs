import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedConversationCreationIntent,
  createApplicationChatQueuedConversationCreationIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  deriveCanonicalParticipantIdentity,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-creation-atomic";
const userId = "user-creation-atomic";
const deviceId = "device-creation-atomic";
const now = "2035-08-09T10:11:12.000Z";
const storageIdentity = (currentUserId = userId) => ({
  tenantId,
  userId: currentUserId,
  deviceId: currentUserId === userId ? deviceId : `device-${currentUserId}`,
});
const cacheIdentity = (currentUserId = userId) => ({
  tenantId,
  userId: currentUserId,
  sessionId: `session-${currentUserId}`,
});
const storageKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const metadata = () => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { conversation_snapshots: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
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
const pendingForever = new Promise(() => {});
const retainedWait = (_delayMs, signal) => new Promise((_resolve, reject) => {
  if (signal.aborted) {
    reject(new Error("aborted"));
    return;
  }
  signal.addEventListener("abort", () => reject(new Error("aborted")), {
    once: true,
  });
});
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const channelRequest = (name, idempotencyKey, clientRequestId) => ({
  operation: "create_conversation",
  type: "channel",
  name,
  visibility: "public",
  idempotencyKey,
  clientRequestId,
});
const groupRequest = (members, idempotencyKey, clientRequestId) => ({
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: members,
  idempotencyKey,
  clientRequestId,
});

function detail(input, id, currentUserId = userId) {
  const memberUserIds = input.type === "channel"
    ? [currentUserId]
    : [currentUserId, ...input.intendedMemberUserIds].sort();
  return {
    kind: "conversation_detail",
    conversation: {
      id,
      tenantId,
      type: input.type,
      visibility: input.type === "channel" ? input.visibility : "private",
      ...(input.type === "channel" ? { name: input.name } : {}),
      createdAt: now,
      updatedAt: now,
      latestSequence: 0,
      activityAt: now,
      unreadMentionCount: 0,
      activeMemberUserIds: memberUserIds,
      memberUserIds,
      memberListRevision: 1,
      currentMember: {
        tenantId,
        conversationId: id,
        userId: currentUserId,
        role: "owner",
        state: "active",
        joinedAt: now,
        updatedAt: now,
      },
      currentReadState: {
        conversationId: id,
        userId: currentUserId,
        lastReadSequence: 0,
        updatedAt: now,
      },
      currentPreference: {
        conversationId: id,
        userId: currentUserId,
        notificationPreference: "all",
        isStarred: false,
        mute: { muted: false },
        updatedAt: now,
      },
    },
    _meta: {
      ...metadata(),
      feature: { name: "conversation_snapshots", version: 1 },
    },
  };
}

const creationResult = (input, id, currentUserId = userId) => ({
  operation: "create_conversation",
  type: input.type,
  reconciliationStatus: "created",
  clientRequestId: input.clientRequestId,
  conversation: detail(input, id, currentUserId),
  ...(input.type === "channel" ? {} : {
    participantIdentity: deriveCanonicalParticipantIdentity(
      currentUserId,
      input.intendedMemberUserIds,
    ),
  }),
});

function createSharedAtomicHarness() {
  const rows = new Map();
  const calls = [];
  let race;
  let pause;
  const createStorage = () => createApplicationChatStorage(adapter);
  const adapter = {
    async read(identity, kind) {
      calls.push({ operation: "read", identity, kind });
      return rows.get(storageKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity, kind, encoded });
      rows.set(storageKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity, kind });
      rows.delete(storageKey(identity, kind));
    },
    async compareExchange(identity, kind, expected, replacement) {
      const call = { operation: "compareExchange", identity, kind, expected, replacement };
      calls.push(call);
      if (
        race !== undefined &&
        kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents &&
        race.arrivals < 2
      ) {
        const ticket = ++race.arrivals;
        if (ticket === 2) race.barrier.resolve();
        await race.barrier.promise;
        if (ticket === 1) await new Promise((resolve) => setImmediate(resolve));
      }
      if (pause !== undefined && !pause.entered && pause.predicate(call)) {
        pause.entered = true;
        pause.arrived.resolve();
        await pause.release.promise;
      }
      const key = storageKey(identity, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    },
    async clearForLogout(identity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(storageKey(identity, kind));
      }
    },
  };
  return {
    calls,
    createStorage,
    armRace() {
      race = { arrivals: 0, barrier: deferred(), initialCallCount: calls.length };
    },
    raceArrivals: () => race?.arrivals ?? 0,
    raceCalls: () => calls.slice(race?.initialCallCount ?? calls.length),
    pauseNextCompareExchange(predicate) {
      pause = {
        predicate,
        entered: false,
        arrived: deferred(),
        release: deferred(),
      };
      return pause;
    },
    async readRecord(identity = storageIdentity()) {
      return createStorage().read(
        identity,
        ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
      );
    },
  };
}

async function createFixture({
  harness,
  label,
  command = () => pendingForever,
  identityRef = { current: storageIdentity() },
  cache = createNormalizedChatCache(cacheIdentity(identityRef.current.userId)),
  crossTab,
}) {
  const observed = [];
  const generated = { idempotency: 0, request: 0 };
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    cache,
    getAccessToken: () => "access-token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    conversationLifecycle: {
      generateIdempotencyKey: () => `${label}-key-${++generated.idempotency}`,
      generateClientRequestId: () => `${label}-request-${++generated.request}`,
    },
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/_meta")) return response(200, metadata());
      const body = JSON.parse(init.body);
      observed.push({ body, identity: { ...identityRef.current }, signal: init.signal });
      return command(body, observed);
    },
    normalizedCachePersistence: {
      storage: harness.createStorage(),
      resolveIdentity: () => identityRef.current,
      retainedConversationCreationRecovery: {
        initialDelayMs: 1,
        maximumDelayMs: 2,
        wait: retainedWait,
      },
    },
    ...(crossTab === undefined ? {} : { crossTab }),
  });
  assert.equal((await client.start()).state, "ready");
  return { client, cache, generated, observed };
}

test("contended distinct conversation creations both survive with retry-stable metadata", async () => {
  const harness = createSharedAtomicHarness();
  const first = await createFixture({ harness, label: "first" });
  const second = await createFixture({ harness, label: "second" });

  harness.armRace();
  const firstResult = first.client.createChannel({
    name: "Atomic channel",
    visibility: "public",
  });
  await eventually(() => harness.raceArrivals() === 1);
  const secondResult = second.client.createDirect({
    intendedMemberUserIds: ["user-b"],
  });
  await eventually(async () => (await harness.readRecord())?.intents.length === 2);

  const committed = await harness.readRecord();
  assert.deepEqual(committed.intents.map(({ enqueueOrder, request }) => [
    enqueueOrder,
    request.type,
    request.idempotencyKey,
    request.clientRequestId,
  ]), [
    [1, "direct", "second-key-1", "second-request-1"],
    [2, "channel", "first-key-1", "first-request-1"],
  ]);
  assert.deepEqual(committed.intents[0].request.intendedMemberUserIds, ["user-b"]);
  assert.deepEqual(first.generated, { idempotency: 1, request: 1 });
  assert.deepEqual(second.generated, { idempotency: 1, request: 1 });
  assert.ok(
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale creation proposal must retry",
  );
  const retriedFirstProposals = harness.raceCalls()
    .filter(({ operation, replacement }) =>
      operation === "compareExchange" && replacement?.includes('"first-key-1"'))
    .map(({ replacement }) => JSON.parse(replacement).payload.intents.find(
      ({ idempotencyKey }) => idempotencyKey === "first-key-1",
    ));
  assert.equal(retriedFirstProposals.length, 2);
  assert.deepEqual(
    new Set(retriedFirstProposals.map(({ enqueuedAt }) => enqueuedAt)).size,
    1,
  );
  assert.deepEqual(retriedFirstProposals.map(({ enqueueOrder }) => enqueueOrder), [1, 2]);

  first.client.close();
  second.client.close();
  await Promise.all([firstResult, secondResult]);
});

test("equivalent reordered group directs coalesce to the first committed correlation", async () => {
  const harness = createSharedAtomicHarness();
  const stale = await createFixture({ harness, label: "stale" });
  const committed = await createFixture({ harness, label: "committed" });

  harness.armRace();
  const staleResult = stale.client.createGroupDirect({
    intendedMemberUserIds: ["user-b", "user-c"],
  });
  await eventually(() => harness.raceArrivals() === 1);
  const committedResult = committed.client.createGroupDirect({
    intendedMemberUserIds: ["user-c", "user-b"],
  });
  await eventually(async () => (await harness.readRecord())?.intents.length === 1);
  await eventually(() => stale.observed.length + committed.observed.length >= 1);

  const record = await harness.readRecord();
  assert.equal(record.intents[0].request.idempotencyKey, "committed-key-1");
  assert.equal(record.intents[0].request.clientRequestId, "committed-request-1");
  assert.deepEqual(record.intents[0].request.intendedMemberUserIds, ["user-b", "user-c"]);
  const duplicateResult = stale.client.createGroupDirect({
    intendedMemberUserIds: ["user-c", "user-b"],
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (const { body } of [...stale.observed, ...committed.observed]) {
    assert.equal(body.idempotencyKey, "committed-key-1");
    assert.equal(body.clientRequestId, "committed-request-1");
    assert.deepEqual(body.intendedMemberUserIds, ["user-b", "user-c"]);
  }
  assert.deepEqual(stale.generated, { idempotency: 1, request: 1 });
  assert.deepEqual(committed.generated, { idempotency: 1, request: 1 });

  stale.client.close();
  committed.client.close();
  await Promise.all([staleResult, committedResult, duplicateResult]);
});

test("retried exact settlement preserves a newer correlation and unrelated creation", async () => {
  const harness = createSharedAtomicHarness();
  const oldRequest = channelRequest("Replacement lane", "old-key", "old-request");
  const oldIntent = createApplicationChatQueuedConversationCreationIntent(oldRequest, {
    enqueueOrder: 1,
    enqueuedAt: now,
  });
  await harness.createStorage().replace(
    createApplicationChatQueuedConversationCreationIntentsRecord(
      storageIdentity(),
      [oldIntent],
    ),
  );
  const command = deferred();
  const remover = await createFixture({
    harness,
    label: "remover",
    command: () => command.promise,
  });
  await eventually(() => remover.observed.length === 1);

  harness.armRace();
  command.resolve(response(201, creationResult(oldRequest, "old-created")));
  await eventually(() => harness.raceArrivals() === 1);
  const newerIntent = createApplicationChatQueuedConversationCreationIntent(
    channelRequest("Replacement lane", "new-key", "new-request"),
    { enqueueOrder: 2, enqueuedAt: "2035-08-09T10:11:13.000Z" },
  );
  const unrelatedIntent = createApplicationChatQueuedConversationCreationIntent(
    groupRequest(["user-d", "user-c"], "unrelated-key", "unrelated-request"),
    { enqueueOrder: 3, enqueuedAt: "2035-08-09T10:11:14.000Z" },
  );
  await harness.createStorage().mutate(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
    () => createApplicationChatQueuedConversationCreationIntentsRecord(
      storageIdentity(),
      [newerIntent, unrelatedIntent],
    ),
  );
  await eventually(async () => {
    const record = await harness.readRecord();
    return record?.intents.length === 2 &&
      record.intents[0].request.idempotencyKey === "new-key";
  });
  await eventually(() =>
    harness.raceCalls().filter(({ operation }) => operation === "compareExchange").length >= 3,
    "the stale settlement proposal did not retry",
  );

  const record = await harness.readRecord();
  assert.deepEqual(record.intents.map(({ request }) => [
    request.idempotencyKey,
    request.clientRequestId,
  ]), [
    ["new-key", "new-request"],
    ["unrelated-key", "unrelated-request"],
  ]);
  remover.client.close();
});

test("channel, direct, group-direct, intent, and record bounds stay enforced", () => {
  const channel = createApplicationChatQueuedConversationCreationIntent(
    channelRequest("Valid", "channel-key", "channel-request"),
    { enqueueOrder: 1, enqueuedAt: now },
  );
  const direct = createApplicationChatQueuedConversationCreationIntent({
    operation: "create_conversation",
    type: "direct",
    visibility: "private",
    intendedMemberUserIds: ["user-b"],
    idempotencyKey: "direct-key",
    clientRequestId: "direct-request",
  }, { enqueueOrder: 2, enqueuedAt: now });
  const group = createApplicationChatQueuedConversationCreationIntent(
    groupRequest(["user-c", "user-b"], "group-key", "group-request"),
    { enqueueOrder: 3, enqueuedAt: now },
  );
  const record = createApplicationChatQueuedConversationCreationIntentsRecord(
    storageIdentity(),
    [channel, direct, group],
  );
  assert.deepEqual(record.intents.map(({ request }) => request.type), [
    "channel",
    "direct",
    "group_direct",
  ]);
  assert.deepEqual(record.intents[2].request.intendedMemberUserIds, ["user-b", "user-c"]);

  assert.throws(() => createApplicationChatQueuedConversationCreationIntent(
    channelRequest("x".repeat(4_097), "too-long-key", "too-long-request"),
    { enqueueOrder: 4, enqueuedAt: now },
  ));
  assert.throws(() => createApplicationChatQueuedConversationCreationIntent({
    operation: "create_conversation",
    type: "direct",
    visibility: "private",
    intendedMemberUserIds: ["x".repeat(4_097)],
    idempotencyKey: "direct-too-long-key",
    clientRequestId: "direct-too-long-request",
  }, { enqueueOrder: 4, enqueuedAt: now }));
  assert.throws(() => createApplicationChatQueuedConversationCreationIntent(
    groupRequest(
      Array.from(
        { length: MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS + 1 },
        (_, index) => `member-${index}`,
      ),
      "group-too-large-key",
      "group-too-large-request",
    ),
    { enqueueOrder: 4, enqueuedAt: now },
  ));
  assert.throws(() => createApplicationChatQueuedConversationCreationIntentsRecord(
    storageIdentity(),
    Array(MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS + 1).fill(channel),
  ));
});

test("stale identity-generation persistence cannot publish or remove replacement work", async () => {
  const harness = createSharedAtomicHarness();
  const identityRef = { current: storageIdentity() };
  const fixture = await createFixture({
    harness,
    label: "identity",
    identityRef,
  });
  const pause = harness.pauseNextCompareExchange(({ identity, kind }) =>
    identity.userId === userId &&
    kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents);
  const oldPending = fixture.client.createChannel({
    name: "Old identity",
    visibility: "public",
  });
  await pause.arrived.promise;

  fixture.client.close();
  identityRef.current = storageIdentity("replacement-user");
  await harness.createStorage().replace(createApplicationChatNormalizedSnapshotRecord(
    identityRef.current,
    createNormalizedChatCache(cacheIdentity("replacement-user")).getState(),
  ));
  pause.release.resolve();
  assert.equal((await oldPending).status, "validation");
  assert.equal((await fixture.client.start()).state, "ready");
  const replacementPending = fixture.client.createChannel({
    name: "Replacement identity",
    visibility: "private",
  });
  await eventually(async () =>
    (await harness.readRecord(identityRef.current))?.intents.length === 1);
  const replacementBeforeRelease = await harness.readRecord(identityRef.current);

  assert.deepEqual(await harness.readRecord(identityRef.current), replacementBeforeRelease);
  assert.equal(fixture.cache.getState().identity.userId, "replacement-user");
  assert.equal(fixture.observed.some(({ identity }) => identity.userId === userId), false);

  fixture.client.close();
  await replacementPending;
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

class CrossTabHub {
  channels = new Set();
  messages = [];
  factory = (name) => {
    const listeners = new Set();
    const channel = {
      name,
      listeners,
      closed: false,
      postMessage: (message) => {
        const clone = structuredClone(message);
        this.messages.push(clone);
        for (const peer of this.channels) {
          if (peer !== channel && !peer.closed && peer.name === name) {
            for (const listener of peer.listeners) listener({ data: structuredClone(clone) });
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

test("persisted conversation-creation announcements contain correlation metadata only", async () => {
  const harness = createSharedAtomicHarness();
  const clock = new CrossTabClock();
  const hub = new CrossTabHub();
  const crossTab = (tabId) => ({
    sessionFingerprint: "atomic-creation-session",
    tabId,
    clock,
    timing: {
      electionDelayMs: 10,
      heartbeatIntervalMs: 20,
      leaseDurationMs: 60,
      commandClaimDelayMs: 5,
      commandClaimLeaseMs: 50,
    },
    channelFactory: hub.factory,
  });
  const leader = await createFixture({
    harness,
    label: "leader",
    crossTab: crossTab("atomic-creation-tab-a"),
  });
  const follower = await createFixture({
    harness,
    label: "announcement",
    crossTab: crossTab("atomic-creation-tab-b"),
  });
  clock.tick(10);
  assert.equal(leader.client.coordination?.role, "leader");
  assert.equal(follower.client.coordination?.role, "follower");
  const pending = follower.client.createGroupDirect({
    intendedMemberUserIds: ["private-user-c", "private-user-b"],
  });
  await eventually(async () => (await harness.readRecord()) !== null,
    `creation was not persisted: ${JSON.stringify(harness.calls)}`);
  await eventually(() => hub.messages.some((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.command === "conversation.create"),
  `announcement missing: ${JSON.stringify(hub.messages)}`);

  const announcement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available");
  assert.deepEqual(announcement.payload, {
    command: "conversation.create",
    idempotencyKey: "announcement-key-1",
  });
  const encoded = JSON.stringify(announcement);
  assert.equal(encoded.includes("private-user"), false);
  assert.equal(encoded.includes("announcement-request-1"), false);
  assert.equal(Object.hasOwn(announcement.payload, "request"), false);

  leader.client.close();
  follower.client.close();
  await pending;
});
