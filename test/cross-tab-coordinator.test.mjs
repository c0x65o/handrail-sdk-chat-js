import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createChatCrossTabCoordinator,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

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
  createdChannels = [];
  names = [];
  messages = [];

  factory = (owner, behavior = {}) => (name) => {
    if (behavior.constructThrows) throw new Error("construction failed");
    const listeners = new Set();
    const channel = {
      owner,
      name,
      closed: false,
      postMessage: (message) => {
        if (channel.closed) return;
        if (behavior.postThrows) throw new Error("posting failed");
        const cloned = structuredClone(message);
        this.messages.push(cloned);
        for (const peer of [...this.channels]) {
          if (peer !== channel && !peer.closed && peer.name === name) {
            for (const listener of peer.listeners) listener({ data: structuredClone(cloned) });
          }
        }
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
      listeners,
    };
    this.names.push(name);
    this.createdChannels.push(channel);
    this.channels.add(channel);
    return channel;
  };

  crash(owner) {
    for (const channel of [...this.channels]) {
      if (channel.owner === owner) {
        channel.closed = true;
        this.channels.delete(channel);
      }
    }
  }

  injectTo(owner, data) {
    for (const channel of this.channels) {
      if (channel.owner === owner) {
        for (const listener of channel.listeners) listener({ data: structuredClone(data) });
      }
    }
  }
}

const timing = {
  electionDelayMs: 10,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 60,
  commandClaimDelayMs: 5,
  commandClaimLeaseMs: 50,
};

const makeCoordinator = (hub, clock, tabId, callbacks = {}) =>
  createChatCrossTabCoordinator({
    endpoint: "https://chat.example.test/api/chat",
    sessionFingerprint: "tenant-1:user-1:session-1",
    channelFactory: hub.factory(tabId),
    clock,
    tabId,
    timing,
    ...callbacks,
  });

test("elects one deterministic leader, hydrates followers, and rejects foreign envelopes", () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  let leader;
  let follower;
  const hydrated = [];
  leader = makeCoordinator(hub, clock, "tab-b", {
    onHydrationRequest: () => leader.publishCanonicalState({ marker: "canonical" }),
  });
  follower = makeCoordinator(hub, clock, "tab-a", {
    onHydrationRequest: () => follower.publishCanonicalState({ marker: "canonical" }),
    onCanonicalState: (value) => hydrated.push(value),
  });

  leader.start();
  follower.start();
  clock.tick(10);

  assert.equal(follower.status.role, "leader");
  assert.equal(leader.status.role, "follower");
  leader.requestHydration();
  assert.deepEqual(hydrated, []);

  const receivedByFollower = [];
  leader.close();
  clock.tick(10);
  assert.equal(follower.status.role, "leader");

  const third = makeCoordinator(hub, clock, "tab-c", {
    onCanonicalState: (value) => receivedByFollower.push(value),
  });
  third.start();
  clock.tick(10);
  const canonicalStatesBeforeRequest = hub.messages.filter(
    (message) => message.kind === "canonical-state",
  ).length;
  const hydrationsBeforeRequest = receivedByFollower.length;
  third.requestHydration();
  assert.equal(
    hub.messages.filter((message) => message.kind === "canonical-state").length,
    canonicalStatesBeforeRequest + 1,
  );
  assert.equal(receivedByFollower.length, hydrationsBeforeRequest + 1);
  assert.deepEqual(receivedByFollower.at(-1), { marker: "canonical" });
  const acceptedCount = receivedByFollower.length;

  const valid = hub.messages.findLast((message) => message.kind === "canonical-state");
  hub.injectTo("tab-c", { ...valid, namespace: "foreign" });
  hub.injectTo("tab-c", { ...valid, version: 999 });
  hub.injectTo("tab-c", { ...valid, senderId: "bad sender" });
  hub.injectTo("tab-c", { ...valid, kind: "unknown" });
  hub.injectTo("tab-c", { ...valid, payload: { value: "not-an-object" } });
  assert.equal(receivedByFollower.length, acceptedCount);
});

test("persisted commands use a closed set and reject malformed or cross-identity traffic", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const announcements = [];
  const results = [];
  const leader = makeCoordinator(hub, clock, "tab-a", {
    onPersistedCommandAvailable: (command, idempotencyKey) =>
      announcements.push({ command, idempotencyKey }),
  });
  const follower = makeCoordinator(hub, clock, "tab-b", {
    onCoordinatedCommandResult: (command, idempotencyKey, result) =>
      results.push({ command, idempotencyKey, result }),
  });
  leader.start();
  follower.start();
  clock.tick(timing.electionDelayMs);

  assert.equal(follower.announcePersistedCommand(
    "conversation.membership.mutate",
    "membership-key",
  ), true);
  assert.deepEqual(announcements, [{
    command: "conversation.membership.mutate",
    idempotencyKey: "membership-key",
  }]);
  assert.equal(follower.announcePersistedCommand(
    "conversation.create",
    "creation-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "conversation.create",
    idempotencyKey: "creation-key",
  });
  assert.equal(follower.announcePersistedCommand(
    "conversation.preference.update",
    "preference-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "conversation.preference.update",
    idempotencyKey: "preference-key",
  });
  assert.equal(follower.announcePersistedCommand(
    "conversation.archive.set",
    "archive-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "conversation.archive.set",
    idempotencyKey: "archive-key",
  });
  assert.equal(follower.announcePersistedCommand(
    "thread.follow.set",
    "thread-follow-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "thread.follow.set",
    idempotencyKey: "thread-follow-key",
  });
  assert.equal(follower.announcePersistedCommand(
    "saved_message.set",
    "saved-message-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "saved_message.set",
    idempotencyKey: "saved-message-key",
  });
  assert.equal(follower.announcePersistedCommand(
    "message.reminder.set",
    "message-reminder-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "message.reminder.set",
    idempotencyKey: "message-reminder-key",
  });
  assert.equal(follower.announcePersistedCommand(
    "huddle.command",
    "exact-huddle-key",
  ), true);
  assert.deepEqual(announcements.at(-1), {
    command: "huddle.command",
    idempotencyKey: "exact-huddle-key",
  });
  assert.equal(follower.announcePersistedCommand("conversation.unknown", "key"), false);
  assert.equal(follower.announcePersistedCommand(
    "conversation.membership.mutate",
    "bad key",
  ), false);

  const announcement = hub.messages.findLast(
    (message) => message.kind === "persisted-command-available",
  );
  hub.injectTo("tab-a", {
    ...announcement,
    payload: { ...announcement.payload, command: "conversation.unknown" },
  });
  hub.injectTo("tab-a", {
    ...announcement,
    namespace: `${announcement.namespace}:foreign`,
  });
  hub.injectTo("tab-a", {
    ...announcement,
    payload: { ...announcement.payload, request: { secret: true } },
  });
  assert.equal(announcements.length, 8);

  const coordinated = leader.coordinateCommand({
    command: "conversation.membership.mutate",
    idempotencyKey: "membership-key",
    execute: async () => ({ status: "success", value: { canonical: true } }),
    parseResult: (value) => value?.status === "success" &&
        value.value?.canonical === true
      ? value
      : undefined,
  });
  clock.tick(timing.commandClaimDelayMs);
  assert.equal((await coordinated).status, "success");
  await Promise.resolve();
  assert.equal(results.length, 1);

  const privateNote = "must-not-cross-the-channel";
  const saved = leader.coordinateCommand({
    command: "saved_message.set",
    idempotencyKey: "saved-message-key",
    execute: async () => ({
      status: "success",
      value: { savedMessage: { isSaved: true, privateNote } },
    }),
    parseResult: (value) => value?.status === "success" &&
        value.value?.savedMessage?.privateNote === privateNote
      ? value
      : undefined,
    projectResultForRelay: () => ({
      status: "success",
      value: { authorityRefresh: true },
    }),
  });
  clock.tick(timing.commandClaimDelayMs);
  assert.equal((await saved).value.savedMessage.privateNote, privateNote);
  await Promise.resolve();
  assert.deepEqual(results.at(-1), {
    command: "saved_message.set",
    idempotencyKey: "saved-message-key",
    result: { status: "success", value: { authorityRefresh: true } },
  });
  assert.equal(JSON.stringify(hub.messages).includes(privateNote), false);

  const privateReminder = {
    conversationId: "conversation-private",
    messageId: "message-private",
    dueAt: "2042-03-04T05:06:07.000Z",
    request: { private: true },
    reminder: { privacy: "affected_authenticated_actor", state: "scheduled" },
  };
  const reminder = leader.coordinateCommand({
    command: "message.reminder.set",
    idempotencyKey: "message-reminder-key",
    execute: async () => ({ status: "success", value: privateReminder }),
    parseResult: (value) => value?.status === "success" &&
        value.value?.messageId === privateReminder.messageId
      ? value
      : undefined,
    projectResultForRelay: () => ({
      status: "success",
      value: { authorityRefresh: true },
    }),
  });
  clock.tick(timing.commandClaimDelayMs);
  assert.deepEqual((await reminder).value, privateReminder);
  await Promise.resolve();
  assert.deepEqual(results.at(-1), {
    command: "message.reminder.set",
    idempotencyKey: "message-reminder-key",
    result: { status: "success", value: { authorityRefresh: true } },
  });
  for (const secret of [
    privateReminder.conversationId,
    privateReminder.messageId,
    privateReminder.dueAt,
    '"private":true',
    "affected_authenticated_actor",
    '"state":"scheduled"',
  ]) assert.equal(JSON.stringify(hub.messages).includes(secret), false);

  const privateArchive = {
    operation: "set_conversation_archive",
    intent: "archive",
    conversationId: "conversation-private-archive",
    expectedLifecycleRevision: 7,
    idempotencyKey: "archive-key",
  };
  const archived = leader.coordinateCommand({
    command: "conversation.archive.set",
    idempotencyKey: privateArchive.idempotencyKey,
    execute: async () => ({ status: "success", value: privateArchive }),
    parseResult: (value) => value?.status === "success" &&
        value.value?.idempotencyKey === privateArchive.idempotencyKey
      ? value
      : undefined,
    projectResultForRelay: () => ({
      status: "success",
      value: { authorityRefresh: true },
    }),
  });
  clock.tick(timing.commandClaimDelayMs);
  assert.deepEqual((await archived).value, privateArchive);
  await Promise.resolve();
  assert.deepEqual(results.at(-1), {
    command: "conversation.archive.set",
    idempotencyKey: "archive-key",
    result: { status: "success", value: { authorityRefresh: true } },
  });
  assert.equal(
    JSON.stringify(hub.messages).includes(privateArchive.conversationId),
    false,
  );

  const privateHuddle = {
    request: { operation: "set_huddle_screen_share", intent: "set" },
    conversationId: "conversation-private-huddle",
    huddleSessionId: "session-private-huddle",
    participants: [{ userId: "participant-private-huddle" }],
    mediaJoin: { descriptor: "media-private-huddle" },
    provider: { accessToken: "provider-private-token" },
  };
  const huddle = leader.coordinateCommand({
    command: "huddle.command",
    idempotencyKey: "exact-huddle-key",
    execute: async () => ({ status: "success", value: privateHuddle }),
    parseResult: (value) => value?.status === "success" &&
        value.value?.huddleSessionId === privateHuddle.huddleSessionId
      ? value
      : undefined,
    projectResultForRelay: () => ({
      status: "success",
      value: { authorityRefresh: true },
    }),
  });
  clock.tick(timing.commandClaimDelayMs);
  assert.deepEqual((await huddle).value, privateHuddle);
  await Promise.resolve();
  assert.deepEqual(results.at(-1), {
    command: "huddle.command",
    idempotencyKey: "exact-huddle-key",
    result: { status: "success", value: { authorityRefresh: true } },
  });
  const serializedMessages = JSON.stringify(hub.messages);
  for (const prohibited of [
    privateHuddle.conversationId,
    privateHuddle.huddleSessionId,
    privateHuddle.participants[0].userId,
    privateHuddle.mediaJoin.descriptor,
    privateHuddle.provider.accessToken,
    "set_huddle_screen_share",
    '"intent":"set"',
  ]) assert.equal(serializedMessages.includes(prohibited), false);
  const huddleAnnouncement = hub.messages.findLast((message) =>
    message.kind === "persisted-command-available" &&
    message.payload.command === "huddle.command");
  assert.deepEqual(Object.keys(huddleAnnouncement.payload).sort(), [
    "command",
    "idempotencyKey",
  ]);

  const validResult = hub.messages.findLast((message) => message.kind === "command-result");
  hub.injectTo("tab-b", {
    ...validResult,
    payload: { ...validResult.payload, command: "conversation.unknown" },
  });
  hub.injectTo("tab-b", {
    ...validResult,
    namespace: `${validResult.namespace}:foreign`,
  });
  hub.injectTo("tab-b", {
    ...validResult,
    payload: { ...validResult.payload, result: { status: "success", extra: true } },
  });
  hub.injectTo("tab-b", {
    ...validResult,
    payload: { ...validResult.payload, result: {
      status: "transport",
      message: "not canonical",
    } },
  });
  hub.injectTo("tab-b", { ...validResult, term: validResult.term + 1 });
  hub.injectTo("tab-b", { ...validResult, leaderId: "wrong-leader" });
  assert.equal(results.length, 5);
  leader.close();
  follower.close();
});

test("fails over after graceful close and crash-style lease expiry", () => {
  const gracefulClock = new FakeClock();
  const gracefulHub = new FakeChannelHub();
  const gracefulA = makeCoordinator(gracefulHub, gracefulClock, "tab-a");
  const gracefulB = makeCoordinator(gracefulHub, gracefulClock, "tab-b");
  gracefulA.start();
  gracefulB.start();
  gracefulClock.tick(10);
  assert.equal(gracefulA.status.role, "leader");
  assert.equal(gracefulA.status.ownsPersistedSendIntents, true);
  assert.equal(gracefulB.status.ownsPersistedSendIntents, false);
  gracefulA.close();
  gracefulClock.tick(10);
  assert.equal(gracefulB.status.role, "leader");
  assert.equal(gracefulB.status.ownsPersistedSendIntents, true);

  const crashClock = new FakeClock();
  const crashHub = new FakeChannelHub();
  const crashA = makeCoordinator(crashHub, crashClock, "tab-a");
  const crashB = makeCoordinator(crashHub, crashClock, "tab-b");
  crashA.start();
  crashB.start();
  crashClock.tick(10);
  crashHub.crash("tab-a");
  crashClock.tick(70);
  assert.equal(crashB.status.role, "leader");
  assert.equal(crashB.status.ownsPersistedSendIntents, true);
});

test("suppresses duplicate idempotency claims and relays the validated outcome", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const a = makeCoordinator(hub, clock, "tab-a");
  const b = makeCoordinator(hub, clock, "tab-b");
  a.start();
  b.start();
  clock.tick(10);
  let dispatches = 0;
  const parseResult = (value) =>
    value?.status === "success" && typeof value.value === "number" ? value : undefined;
  const command = {
    command: "message.send",
    idempotencyKey: "same-intent",
    execute: async () => ({ status: "success", value: ++dispatches }),
    parseResult,
  };
  const resultA = a.coordinateCommand(command);
  const resultB = b.coordinateCommand(command);
  clock.tick(5);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await resultA, { status: "success", value: 1 });
  assert.deepEqual(await resultB, { status: "success", value: 1 });
  assert.equal(dispatches, 1);
  assert.equal(
    JSON.stringify(hub.messages).includes("validateInput"),
    false,
  );
});

test("an unfulfilled command claim expires and a surviving contender recovers", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const a = makeCoordinator(hub, clock, "tab-a");
  const b = makeCoordinator(hub, clock, "tab-b");
  a.start();
  b.start();
  clock.tick(10);
  let attempts = 0;
  const parseResult = (value) =>
    value?.status === "success" && typeof value.value === "string" ? value : undefined;
  void a.coordinateCommand({
    command: "message.send",
    idempotencyKey: "recover-intent",
    execute: () => {
      attempts += 1;
      return new Promise(() => {});
    },
    parseResult,
  });
  const recovered = b.coordinateCommand({
    command: "message.send",
    idempotencyKey: "recover-intent",
    execute: async () => {
      attempts += 1;
      return { status: "success", value: "recovered" };
    },
    parseResult,
  });
  clock.tick(5);
  hub.crash("tab-a");
  clock.tick(100);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await recovered, { status: "success", value: "recovered" });
  assert.equal(attempts, 2);
});

const metadata = {
  packageVersion: "0.1.3",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { realtime: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};

const response = { ok: true, status: 200, json: async () => metadata };

class FakeSocket {
  constructor(tabId) {
    this.tabId = tabId;
  }

  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  send() {}

  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const acceptedSession = {
  type: "chat.session.accepted",
  metadata,
  tenantId: "tenant-1",
  actorStreamId: "user:user-1",
  deviceId: "device-1",
  sessionId: "session-1",
};

const canonicalConversationEvent = {
  eventId: "event-conversation-created",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: "tenant-1",
  streamId: "conversation-realtime",
  type: "conversation.created",
  occurredAt: "2026-08-27T12:00:00.000Z",
  payload: {
    conversation: {
      id: "conversation-realtime",
      tenantId: "tenant-1",
      type: "channel",
      visibility: "public",
      name: "Realtime",
      createdAt: "2026-08-27T12:00:00.000Z",
      updatedAt: "2026-08-27T12:00:00.000Z",
      memberUserIds: ["user-1"],
    },
  },
};

const makeClient = ({
  hub,
  clock,
  tabId,
  sockets,
  fingerprint = "scope-one",
  getSessionFingerprint,
  behavior,
  artifacts = { storage: [], diagnostics: [] },
}) =>
  createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "SECRET-BEARER-TOKEN",
    fetch: async () => response,
    crossTab: {
      ...(getSessionFingerprint === undefined
        ? { sessionFingerprint: fingerprint }
        : { getSessionFingerprint }),
      tabId,
      clock,
      timing,
      channelFactory: hub.factory(tabId, behavior),
    },
    realtime: {
      clock,
      random: () => 0.5,
      network: {
        isOnline: () => true,
        addEventListener() {},
        removeEventListener() {},
      },
      storage: {
        getItem: (key) => {
          artifacts.storage.push({ operation: "get", key });
          return null;
        },
        setItem(key, value) {
          artifacts.storage.push({ operation: "set", key, value });
        },
        removeItem(key) {
          artifacts.storage.push({ operation: "remove", key });
        },
      },
      onStateChange: (state) => artifacts.diagnostics.push(state),
      webSocketFactory: () => {
        const socket = new FakeSocket(tabId);
        sockets.push(socket);
        return socket;
      },
    },
  });

test("three createChatClient tabs share one socket, hydrate, relay events, and fail over once", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const sockets = [];
  const artifacts = [
    { storage: [], diagnostics: [] },
    { storage: [], diagnostics: [] },
    { storage: [], diagnostics: [] },
  ];
  const clients = [
    makeClient({ hub, clock, tabId: "tab-a", sockets, artifacts: artifacts[0] }),
    makeClient({ hub, clock, tabId: "tab-b", sockets, artifacts: artifacts[1] }),
    makeClient({ hub, clock, tabId: "tab-c", sockets, artifacts: artifacts[2] }),
  ];
  const identity = {
    tenantId: "tenant-1",
    userId: "user-1",
    sessionId: "session-1",
  };
  clients[0].cache.setIdentity(identity);
  await Promise.all(clients.map((client) => client.start()));
  clock.tick(timing.electionDelayMs);
  await Promise.resolve();
  await Promise.resolve();

  const electedLeaders = clients.filter(
    (client) => client.coordination?.role === "leader",
  );
  assert.equal(electedLeaders.length, 1);
  const leader = electedLeaders[0];
  assert.equal(leader.coordination.tabId, "tab-a");
  const followers = clients.filter((client) => client !== leader);
  assert.deepEqual(
    followers.map((client) => client.coordination?.role),
    ["follower", "follower"],
  );
  assert.equal(sockets.length, 1);
  assert.equal(sockets.filter((socket) => socket.readyState !== 3).length, 1);
  for (const follower of followers) {
    assert.deepEqual(follower.cache.getState().identity, identity);
  }

  const canonicalStatesAfterHydration = hub.messages.filter(
    (message) => message.kind === "canonical-state",
  ).length;
  for (let index = 0; index < 3; index += 1) {
    leader.cache.setHuddleState({
      status: "inactive",
      conversationId: `leader-local-${index}`,
    });
    for (const follower of followers) {
      follower.cache.setHuddleState({
        status: "inactive",
        conversationId: `follower-local-${index}`,
      });
    }
  }
  assert.equal(
    hub.messages.filter((message) => message.kind === "canonical-state").length,
    canonicalStatesAfterHydration,
  );

  const followerEventApplications = followers.map(() => 0);
  const unsubscribeFollowerEvents = followers.map((follower, index) =>
    follower.cache.subscribe(
      (state) => state.entities.conversations["conversation-realtime"],
      (conversation, previous) => {
        if (conversation !== undefined && conversation !== previous) {
          followerEventApplications[index] += 1;
        }
      },
    ));
  sockets[0].open();
  sockets[0].message(acceptedSession);
  sockets[0].message(canonicalConversationEvent);
  assert.equal(
    artifacts[clients.indexOf(leader)].diagnostics.at(-1)?.state,
    "connected",
  );
  assert.equal(
    hub.messages.filter((message) => message.kind === "canonical-event").length,
    1,
  );
  assert.deepEqual(followerEventApplications, [1, 1]);
  for (const follower of followers) {
    assert.equal(
      follower.cache.getState().entities.conversations["conversation-realtime"].name,
      "Realtime",
    );
  }
  for (const unsubscribe of unsubscribeFollowerEvents) unsubscribe();

  leader.close();
  assert.equal(sockets.filter((socket) => socket.readyState !== 3).length, 0);
  clock.tick(timing.electionDelayMs);
  await Promise.resolve();
  await Promise.resolve();

  const survivingLeaders = followers.filter(
    (client) => client.coordination?.role === "leader",
  );
  assert.equal(survivingLeaders.length, 1);
  assert.deepEqual(
    followers.map((client) => client.coordination?.role).sort(),
    ["follower", "leader"],
  );
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].tabId, survivingLeaders[0].coordination.tabId);
  assert.equal(sockets.filter((socket) => socket.readyState !== 3).length, 1);

  for (const client of clients) client.close();
  assert.equal(sockets.filter((socket) => socket.readyState !== 3).length, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(hub.channels.size, 0);
  assert.equal(
    hub.createdChannels.every(
      (channel) => channel.closed && channel.listeners.size === 0,
    ),
    true,
  );
  const messagesAfterClose = hub.messages.length;
  leader.cache.setHuddleState({ status: "inactive", conversationId: "after-close" });
  assert.equal(hub.messages.length, messagesAfterClose);

  const transmitted = JSON.stringify({
    names: hub.names,
    messages: hub.messages,
    artifacts,
    lifecycle: clients.map((client) => client.state),
    coordination: clients.map((client) => client.coordination),
  });
  assert.equal(transmitted.includes("SECRET-BEARER-TOKEN"), false);
  assert.equal(transmitted.includes("scope-one"), false);
});

test("a resolved fingerprint change tears down the old scope and clears identity-bound state", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const sockets = [];
  let fingerprint = "first-user";
  const client = makeClient({
    hub,
    clock,
    tabId: "tab-a",
    sockets,
    getSessionFingerprint: () => fingerprint,
  });
  await client.start();
  clock.tick(10);
  await Promise.resolve();
  client.cache.setIdentity({
    tenantId: "tenant-1",
    userId: "user-1",
    sessionId: "session-1",
  });
  const firstChannel = hub.names.at(-1);

  client.close();
  fingerprint = "second-user";
  await client.start();
  clock.tick(10);
  await Promise.resolve();

  assert.notEqual(hub.names.at(-1), firstChannel);
  assert.equal(client.cache.getState().identity, null);
  assert.equal(JSON.stringify(hub.messages).includes("first-user"), false);
  assert.equal(JSON.stringify(hub.messages).includes("second-user"), false);
});

test("unavailable, construction-failing, listening-failing, and posting-failing channels fall back locally", async () => {
  for (const behavior of [
    { constructThrows: true },
    { listenThrows: true },
    { postThrows: true },
  ]) {
    const clock = new FakeClock();
    const hub = new FakeChannelHub();
    const sockets = [];
    const client = makeClient({ hub, clock, tabId: "tab-local", sockets, behavior });
    await client.start();
    await Promise.resolve();
    assert.equal(client.coordination?.role, "fallback");
    assert.deepEqual(sockets.map(({ tabId }) => tabId), ["tab-local"]);
  }

  const sockets = [];
  const local = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "SECRET-BEARER-TOKEN",
    fetch: async () => response,
    realtime: {
      webSocketFactory: () => {
        sockets.push("local");
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send() {},
          close() {},
        };
      },
    },
  });
  await local.start();
  await Promise.resolve();
  assert.equal(local.coordination, undefined);
  assert.deepEqual(sockets, ["local"]);
});

test("only the elected tab drains a shared retained-send queue without realtime", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const storageIdentity = {
    tenantId: "tenant-1",
    userId: "user-1",
    deviceId: "device-1",
  };
  const cacheIdentity = {
    tenantId: "tenant-1",
    userId: "user-1",
    sessionId: "session-1",
  };
  const retained = {
    operation: "send",
    conversationId: "conversation-retained",
    content: { format: "plain", text: "retained across tabs" },
    clientMessageId: "client-retained",
    idempotencyKey: "idempotency-retained",
  };
  const rowKey = `${storageIdentity.tenantId}\0${storageIdentity.userId}\0${storageIdentity.deviceId}\0${ApplicationChatStorageRecordKind.queuedSendMessageIntents}`;
  const rows = new Map();
  const storage = createApplicationChatStorage({
    async read(identity, kind) {
      return rows.get(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`) ?? null;
    },
    async replace(identity, kind, encoded) {
      rows.set(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`, encoded);
    },
    async remove(identity, kind) {
      rows.delete(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`);
    },
    async compareExchange(identity, kind, expected, replacement) {
      const key = `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    },
    async clearForLogout(identity) {
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`);
      }
    },
  });
  await storage.replace(createApplicationChatQueuedSendMessageIntentsRecord(
    storageIdentity,
    [createApplicationChatQueuedSendMessageIntent(retained, {
      enqueueOrder: 1,
      enqueuedAt: "2026-09-03T12:00:00.000Z",
    })],
  ));

  const dispatches = [];
  const makeRetainedClient = (tabId) => createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "SECRET-BEARER-TOKEN",
    cache: createNormalizedChatCache(cacheIdentity),
    commands: { retry: { maxAttempts: 1 } },
    fetch: async (_url, init) => {
      if (init.method === "GET") return response;
      const body = JSON.parse(init.body);
      dispatches.push({ tabId, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          operation: "send",
          reconciliationStatus: "applied",
          clientMessageId: body.clientMessageId,
          message: {
            id: "message-retained",
            tenantId: storageIdentity.tenantId,
            conversationId: body.conversationId,
            author: { type: "user", userId: storageIdentity.userId },
            sequence: 1,
            createdAt: "2026-09-03T12:00:00.000Z",
            updatedAt: "2026-09-03T12:00:00.000Z",
            revision: { revision: 1 },
            content: body.content,
          },
          canonicalRevision: 1,
        }),
      };
    },
    normalizedCachePersistence: {
      storage,
      resolveIdentity: () => storageIdentity,
    },
    crossTab: {
      sessionFingerprint: "tenant-1:user-1:session-1",
      tabId,
      clock,
      timing,
      channelFactory: hub.factory(tabId),
    },
  });
  const a = makeRetainedClient("tab-a");
  const b = makeRetainedClient("tab-b");

  await Promise.all([a.start(), b.start()]);
  clock.tick(timing.electionDelayMs);
  for (let attempt = 0; attempt < 20 && !hub.messages.some(
    (message) => message.kind === "command-claim",
  ); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock.tick(timing.commandClaimDelayMs);
  for (let attempt = 0; attempt < 20 && rows.has(rowKey); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(a.coordination?.role, "leader");
  assert.equal(b.coordination?.role, "follower");
  assert.deepEqual(dispatches.map(({ tabId }) => tabId), ["tab-a"]);
  assert.deepEqual(
    [...new Set(hub.messages
      .filter((message) => message.kind === "command-claim")
      .map((message) => message.senderId))],
    ["tab-a"],
    "the follower must not start a retained-send command claim",
  );
  assert.equal(rows.has(rowKey), false);
  a.close();
  b.close();
});

const recoveryStorageIdentity = {
  tenantId: "tenant-recovery",
  userId: "user-recovery",
  deviceId: "device-recovery",
};
const recoveryCacheIdentity = {
  tenantId: recoveryStorageIdentity.tenantId,
  userId: recoveryStorageIdentity.userId,
  sessionId: "session-recovery",
};
const recoveryRowKey = `${recoveryStorageIdentity.tenantId}\0${recoveryStorageIdentity.userId}\0${recoveryStorageIdentity.deviceId}\0${ApplicationChatStorageRecordKind.queuedSendMessageIntents}`;
const recoveryRequest = (suffix, conversationId = `conversation-${suffix}`) => ({
  operation: "send",
  conversationId,
  content: { format: "plain", text: `retained ${suffix}` },
  clientMessageId: `client-${suffix}`,
  idempotencyKey: `idempotency-${suffix}`,
});

const createRecoveryDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createSharedRecoveryStorage = () => {
  const rows = new Map();
  const calls = [];
  const storage = createApplicationChatStorage({
    async read(identity, kind) {
      calls.push({ operation: "read", identity, kind });
      return rows.get(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity, kind, encoded });
      rows.set(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`, encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity, kind });
      rows.delete(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`);
    },
    async compareExchange(identity, kind, expected, replacement) {
      calls.push({ operation: "compareExchange", identity, kind, expected, replacement });
      const key = `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      return true;
    },
    async clearForLogout(identity) {
      calls.push({ operation: "clearForLogout", identity });
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(`${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`);
      }
    },
  });
  return { rows, calls, storage };
};

const seedRecoveryQueue = (harness, intents) => harness.storage.replace(
  createApplicationChatQueuedSendMessageIntentsRecord(
    recoveryStorageIdentity,
    intents.map((intent, index) => createApplicationChatQueuedSendMessageIntent(
      intent,
      {
        enqueueOrder: index + 1,
        enqueuedAt: new Date(Date.parse("2026-09-03T12:00:00.000Z") + index)
          .toISOString(),
      },
    )),
  ),
);

const recoverySuccess = (body, messageId = `message-${body.clientMessageId}`) => ({
  ok: true,
  status: 200,
  json: async () => ({
    operation: "send",
    reconciliationStatus: "applied",
    clientMessageId: body.clientMessageId,
    message: {
      id: messageId,
      tenantId: recoveryStorageIdentity.tenantId,
      conversationId: body.conversationId,
      author: { type: "user", userId: recoveryStorageIdentity.userId },
      sequence: 1,
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
      revision: { revision: 1 },
      content: body.content,
    },
    canonicalRevision: 1,
  }),
});

const eventuallyRecovery = async (predicate, message = "recovery condition was not reached") => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const createRecoveryClient = ({
  tabId,
  hub,
  clock,
  harness,
  requests,
  behavior,
  command,
}) => createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "SECRET-BEARER-TOKEN",
  cache: createNormalizedChatCache(recoveryCacheIdentity),
  commands: { retry: { maxAttempts: 1 } },
  optimisticMessages: {
    generateClientMessageId: () => `client-live-${tabId}`,
    generateIdempotencyKey: () => `idempotency-live-${tabId}`,
    now: () => Date.parse("2026-09-03T12:00:00.000Z"),
  },
  fetch: async (_url, init) => {
    if (init.method === "GET") return response;
    const body = JSON.parse(init.body);
    const observed = { tabId, body, signal: init.signal };
    requests.push(observed);
    return command?.(observed, requests.length) ?? recoverySuccess(body);
  },
  normalizedCachePersistence: {
    storage: harness.storage,
    resolveIdentity: () => recoveryStorageIdentity,
  },
  crossTab: {
    sessionFingerprint: "tenant-recovery:user-recovery:session-recovery",
    tabId,
    clock,
    timing,
    channelFactory: hub.factory(tabId, behavior),
  },
});

const startRecoveryPair = async (a, b, clock, hub) => {
  await Promise.all([a.start(), b.start()]);
  clock.tick(timing.electionDelayMs);
  await eventuallyRecovery(() => hub.messages.some(
    (message) => message.kind === "command-claim",
  ));
  clock.tick(timing.commandClaimDelayMs);
};

test("a follower announces a durable send but never dispatches it", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const harness = createSharedRecoveryStorage();
  const requests = [];
  const a = createRecoveryClient({ tabId: "tab-a", hub, clock, harness, requests });
  const b = createRecoveryClient({ tabId: "tab-b", hub, clock, harness, requests });
  await Promise.all([a.start(), b.start()]);
  clock.tick(timing.electionDelayMs);

  const pending = b.sendMessage({
    conversationId: "conversation-live",
    content: { format: "plain", text: "queued by follower" },
  });
  await eventuallyRecovery(() => hub.messages.some(
    (message) => message.kind === "persisted-command-available",
  ));
  await eventuallyRecovery(() => hub.messages.some(
    (message) => message.kind === "command-claim",
  ));
  clock.tick(timing.commandClaimDelayMs);
  assert.equal((await pending).status, "success");
  assert.deepEqual(requests.map(({ tabId }) => tabId), ["tab-a"]);
  assert.equal(
    JSON.stringify(hub.messages.filter(
      (message) => message.kind === "persisted-command-available",
    )).includes("queued by follower"),
    false,
  );
  a.close();
  b.close();
});

test("losing queue ownership aborts the old pump and ignores its stale completion", async () => {
  const clock = new FakeClock();
  const hub = new FakeChannelHub();
  const harness = createSharedRecoveryStorage();
  const retained = recoveryRequest("stale", "conversation-old");
  await seedRecoveryQueue(harness, [retained]);
  const requests = [];
  const oldResponse = createRecoveryDeferred();
  const a = createRecoveryClient({
    tabId: "tab-a",
    hub,
    clock,
    harness,
    requests,
    command: () => oldResponse.promise,
  });
  const b = createRecoveryClient({ tabId: "tab-b", hub, clock, harness, requests });
  await startRecoveryPair(a, b, clock, hub);
  await eventuallyRecovery(() => requests.length === 1);

  const heartbeat = hub.messages.findLast((message) => message.kind === "heartbeat");
  hub.injectTo("tab-a", {
    ...heartbeat,
    senderId: "tab-b",
    leaderId: "tab-b",
    term: heartbeat.term + 1,
    payload: { leaseUntil: clock.now() + timing.leaseDurationMs },
  });
  assert.equal(a.coordination?.role, "follower");
  assert.equal(requests[0].signal.aborted, true);

  const replacement = { ...retained, conversationId: "conversation-replacement" };
  await seedRecoveryQueue(harness, [replacement]);
  oldResponse.resolve(recoverySuccess(retained, "message-stale"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.rows.get(recoveryRowKey).includes("conversation-replacement"), true);
  a.close();
  b.close();
});

test("graceful close and lease expiry each reload and resume the shared queue", async (t) => {
  for (const mode of ["graceful", "lease-expiry"]) {
    await t.test(mode, async () => {
      const clock = new FakeClock();
      const hub = new FakeChannelHub();
      const harness = createSharedRecoveryStorage();
      const retained = recoveryRequest(mode);
      await seedRecoveryQueue(harness, [retained]);
      const requests = [];
      const oldResponse = createRecoveryDeferred();
      const a = createRecoveryClient({
        tabId: "tab-a",
        hub,
        clock,
        harness,
        requests,
        command: () => oldResponse.promise,
      });
      const b = createRecoveryClient({ tabId: "tab-b", hub, clock, harness, requests });
      await startRecoveryPair(a, b, clock, hub);
      await eventuallyRecovery(() => requests.length === 1);

      if (mode === "graceful") a.close();
      else hub.crash("tab-a");
      clock.tick(timing.leaseDurationMs + timing.electionDelayMs);
      await eventuallyRecovery(() => b.coordination?.role === "leader");
      const previousClaimCount = hub.messages.filter(
        (message) => message.kind === "command-claim",
      ).length;
      await eventuallyRecovery(() => hub.messages.filter(
        (message) => message.kind === "command-claim",
      ).length > previousClaimCount);
      clock.tick(timing.commandClaimLeaseMs + timing.commandClaimDelayMs);
      await eventuallyRecovery(() => requests.some(({ tabId }) => tabId === "tab-b"));
      await eventuallyRecovery(() => !harness.rows.has(recoveryRowKey));

      assert.equal(b.coordination?.ownsPersistedSendIntents, true);
      assert.deepEqual(requests.map(({ tabId }) => tabId), ["tab-a", "tab-b"]);
      const replacement = {
        ...retained,
        conversationId: `conversation-replacement-${mode}`,
      };
      await harness.storage.replace(createApplicationChatQueuedSendMessageIntentsRecord(
        recoveryStorageIdentity,
        [createApplicationChatQueuedSendMessageIntent(replacement, {
          enqueueOrder: 2,
          enqueuedAt: "2026-09-03T12:00:01.000Z",
        })],
      ));
      oldResponse.resolve(recoverySuccess(retained, "message-old-leader"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        harness.rows.get(recoveryRowKey).includes(replacement.conversationId),
        true,
      );
      b.close();
      if (mode !== "graceful") a.close();
    });
  }
});

test("channel failures are fail-open and server idempotency remains canonical", async (t) => {
  for (const behavior of [
    { constructThrows: true },
    { listenThrows: true },
    { postThrows: true },
  ]) {
    await t.test(Object.keys(behavior)[0], async () => {
      const clock = new FakeClock();
      const hub = new FakeChannelHub();
      const harness = createSharedRecoveryStorage();
      const retained = recoveryRequest(`fallback-${Object.keys(behavior)[0]}`);
      await seedRecoveryQueue(harness, [retained]);
      const requests = [];
      const canonicalMessages = new Map();
      const command = ({ body }) => {
        const messageId = canonicalMessages.get(body.idempotencyKey) ??
          `canonical-${canonicalMessages.size + 1}`;
        canonicalMessages.set(body.idempotencyKey, messageId);
        return recoverySuccess(body, messageId);
      };
      const a = createRecoveryClient({
        tabId: "tab-a", hub, clock, harness, requests, behavior, command,
      });
      const b = createRecoveryClient({
        tabId: "tab-b", hub, clock, harness, requests, behavior, command,
      });

      await Promise.all([a.start(), b.start()]);
      await eventuallyRecovery(() => requests.length === 2);
      await eventuallyRecovery(() => !harness.rows.has(recoveryRowKey));
      assert.deepEqual(
        [a.coordination?.role, b.coordination?.role],
        ["fallback", "fallback"],
      );
      assert.equal(canonicalMessages.size, 1);
      assert.equal(new Set(requests.map(({ body }) => body.idempotencyKey)).size, 1);
      a.close();
      b.close();
    });
  }
});
