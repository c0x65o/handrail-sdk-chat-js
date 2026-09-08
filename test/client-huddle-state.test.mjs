import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createChatCrossTabCoordinator,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-huddle-client";
const userId = "user-huddle-client";
const conversationId = "conversation-huddle-client";
const sessionId = "huddle-session-client";
const nowMs = Date.parse("2030-01-01T00:00:00.000Z");
const startedAt = "2030-01-01T00:00:01.000Z";
const joinedAt = "2030-01-01T00:00:02.000Z";
const leftAt = "2030-01-01T00:00:03.000Z";
const endedAt = "2030-01-01T00:00:04.000Z";
const descriptorSentinel = "OPAQUE_HUDDLE_DESCRIPTOR_SENTINEL";
const identity = { tenantId, userId, sessionId: "browser-session" };

const inactive = { status: "inactive", conversationId };
const starting = {
  status: "starting",
  conversationId,
  huddleSessionId: sessionId,
  startedAt,
  participants: [],
  screenShareOwnerUserId: null,
};
const active = {
  ...starting,
  status: "active",
  participants: [{ userId, status: "joined", joinedAt }],
};
const sharing = { ...active, screenShareOwnerUserId: userId };
const left = {
  ...active,
  participants: [{ userId, status: "left", joinedAt, leftAt }],
};
const ended = {
  status: "ended",
  conversationId,
  huddleSessionId: sessionId,
  startedAt,
  endedAt,
  endedByUserId: userId,
  participants: [{ userId, status: "left", joinedAt, leftAt }],
  screenShareOwnerUserId: null,
};

const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { huddles: true, realtime: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
});

const mediaJoin = (descriptor = descriptorSentinel) => ({
  kind: "opaque_media_join",
  descriptor,
  expiresAt: "2030-01-01T00:04:00.000Z",
});

const commandResult = (operation, state, extra = {}) => ({
  operation,
  outcome: "ok",
  reconciliationStatus: "applied",
  state,
  ...extra,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

class FakeClock {
  current = nowMs;
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

const createClient = ({ cache, fetch, clock = new FakeClock(), diagnostics } = {}) =>
  createChatClient({
    endpoint: "/chat",
    cache: cache ?? createNormalizedChatCache(identity),
    getAccessToken: () => "BEARER_TOKEN_SENTINEL",
    fetch,
    commands: {
      retry: { maxAttempts: 2, wait: async () => undefined },
      ...(diagnostics === undefined ? {} : { onDiagnostic: (value) => diagnostics.push(value) }),
    },
    huddles: {
      generateIdempotencyKey: (() => {
        let sequence = 0;
        return () => `huddle-key-${++sequence}`;
      })(),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
  });

test("hydrates inactive and already-active huddles into canonical renderer state", async () => {
  for (const snapshot of [inactive, active]) {
    const cache = createNormalizedChatCache(identity);
    const client = createClient({
      cache,
      fetch: async (url, init) => {
        assert.equal(url, `/chat/conversations/${conversationId}/huddle`);
        assert.equal(init.method, "GET");
        return response(snapshot);
      },
    });

    const states = [];
    const unsubscribe = client.subscribeHuddle(conversationId, (state) => states.push(state));
    const result = await client.hydrateHuddle(conversationId);
    unsubscribe();

    assert.equal(result.status, "success");
    assert.equal(result.applied, true);
    assert.deepEqual(cache.getState().huddles[conversationId], snapshot);
    assert.equal(client.getHuddleState(conversationId).hydrationStatus, "ready");
    assert.equal(
      client.getHuddleState(conversationId).media.state,
      snapshot.status === "active" ? "rejoin_required" : "idle",
    );
    assert.ok(states.some((state) => state.hydrationStatus === "loading"));
    assert.ok(states.some((state) => state.hydrationStatus === "ready"));
  }
});

test("runs every lifecycle action through safe idempotent dispatch and canonical reconciliation", async () => {
  const clock = new FakeClock();
  const cache = createNormalizedChatCache(identity);
  cache.setHuddleState(inactive);
  const requests = [];
  let failFirstStart = true;
  const client = createClient({
    cache,
    clock,
    async fetch(url, init) {
      const input = JSON.parse(init.body);
      requests.push({ url, method: init.method, key: init.headers["idempotency-key"], input });
      if (input.operation === "start_huddle" && failFirstStart) {
        failFirstStart = false;
        throw new Error("PROVIDER_THROW_SECRET_SENTINEL");
      }
      if (input.operation === "start_huddle") {
        return response(commandResult(input.operation, starting, { mediaJoin: mediaJoin("START_DESCRIPTOR_SENTINEL") }));
      }
      if (input.operation === "join_huddle") {
        return response(commandResult(input.operation, active, { mediaJoin: mediaJoin() }));
      }
      if (input.operation === "set_huddle_screen_share") {
        return response(commandResult(input.operation, input.intent === "set" ? sharing : active));
      }
      if (input.operation === "leave_huddle") {
        return response(commandResult(input.operation, left));
      }
      return response(commandResult(input.operation, ended));
    },
  });

  assert.equal((await client.startHuddle(conversationId)).status, "success");
  assert.equal(requests[0].key, requests[1].key, "transport retry must preserve the key");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId).descriptor, "START_DESCRIPTOR_SENTINEL");
  assert.equal((await client.joinHuddle(conversationId)).status, "success");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId).descriptor, descriptorSentinel);
  const screenOwners = [];
  const unsubscribeScreen = cache.subscribe(
    (state) => state.huddles[conversationId]?.screenShareOwnerUserId,
    (owner) => screenOwners.push(owner),
  );
  const setShare = client.setHuddleScreenShare(conversationId);
  const clearShare = client.clearHuddleScreenShare(conversationId);
  const [setShareResult, clearShareResult] = await Promise.all([setShare, clearShare]);
  unsubscribeScreen();
  assert.equal(setShareResult.status, "success");
  assert.equal(clearShareResult.status, "success");
  assert.deepEqual(screenOwners, [userId, null]);
  assert.equal(cache.getState().huddles[conversationId].screenShareOwnerUserId, null);
  assert.equal((await client.leaveHuddle(conversationId)).status, "success");
  assert.equal(cache.getState().huddles[conversationId].participants[0].status, "left");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId), undefined);
  assert.equal((await client.endHuddle(conversationId)).status, "success");
  assert.equal(cache.getState().huddles[conversationId].status, "ended");

  assert.deepEqual(requests.slice(1).map(({ url, method }) => [url, method]), [
    [`/chat/conversations/${conversationId}/huddles`, "POST"],
    [`/chat/huddles/${sessionId}/join`, "POST"],
    [`/chat/huddles/${sessionId}/screen-share`, "PATCH"],
    [`/chat/huddles/${sessionId}/screen-share`, "PATCH"],
    [`/chat/huddles/${sessionId}/leave`, "POST"],
    [`/chat/huddles/${sessionId}/end`, "POST"],
  ]);
});

test("watermarks reject late snapshots and responses while later durable events remain authoritative", async () => {
  const cache = createNormalizedChatCache(identity);
  const snapshotResponse = deferred();
  const client = createClient({
    cache,
    fetch: async () => snapshotResponse.promise,
  });
  const hydration = client.hydrateHuddle(conversationId);
  await flush();
  cache.setHuddleState(active);
  snapshotResponse.resolve(response(inactive));
  const hydrationResult = await hydration;
  assert.equal(hydrationResult.status, "success");
  assert.equal(hydrationResult.applied, false);
  assert.deepEqual(cache.getState().huddles[conversationId], active);

  const commandCache = createNormalizedChatCache(identity);
  commandCache.setHuddleState(inactive);
  const commandResponse = deferred();
  const commandClient = createClient({
    cache: commandCache,
    fetch: async () => commandResponse.promise,
  });
  const start = commandClient.startHuddle(conversationId);
  await flush();
  commandCache.setHuddleState(active);
  commandResponse.resolve(response(commandResult("start_huddle", starting, {
    mediaJoin: mediaJoin(),
  })));
  const startResult = await start;
  assert.equal(startResult.status, "success");
  assert.equal(startResult.applied, false);
  assert.deepEqual(commandCache.getState().huddles[conversationId], active);

  const eventCache = createNormalizedChatCache(identity);
  eventCache.applyDurableEvent({
    eventId: "conversation-created",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    occurredAt: "2030-01-01T00:00:00.000Z",
    payload: {
      conversation: {
        id: conversationId,
        tenantId,
        type: "channel",
        visibility: "public",
        name: "Huddle",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        memberUserIds: [userId],
      },
    },
  });
  eventCache.setHuddleState(inactive);
  const eventClient = createClient({
    cache: eventCache,
    fetch: async () => response(commandResult("start_huddle", starting, {
      mediaJoin: mediaJoin(),
    })),
  });
  assert.equal((await eventClient.startHuddle(conversationId)).status, "success");
  eventCache.applyDurableEvent({
    eventId: "huddle-active",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.huddleUpdated,
    occurredAt: "2030-01-01T00:00:02.000Z",
    payload: { state: sharing },
  });
  assert.deepEqual(eventCache.getState().huddles[conversationId], sharing);
  assert.equal(eventClient.getHuddleState(conversationId).canonicalState.screenShareOwnerUserId, userId);
});

test("rejects malformed snapshot and command bodies before canonical or ephemeral application", async () => {
  const snapshotCache = createNormalizedChatCache(identity);
  const snapshotClient = createClient({
    cache: snapshotCache,
    fetch: async () => response({
      ...inactive,
      mediaJoin: mediaJoin("MALFORMED_SNAPSHOT_DESCRIPTOR_SENTINEL"),
    }),
  });
  const snapshotResult = await snapshotClient.hydrateHuddle(conversationId);
  assert.equal(snapshotResult.status, "error");
  assert.equal(snapshotResult.code, "malformed_response");
  assert.equal(snapshotCache.getState().huddles[conversationId], undefined);

  const commandCache = createNormalizedChatCache(identity);
  commandCache.setHuddleState(inactive);
  const commandClient = createClient({
    cache: commandCache,
    fetch: async () => response(commandResult("start_huddle", {
      ...starting,
      screenShareOwnerUserId: "not-a-participant",
    }, {
      mediaJoin: mediaJoin("MALFORMED_COMMAND_DESCRIPTOR_SENTINEL"),
    })),
  });
  const command = await commandClient.startHuddle(conversationId);
  assert.equal(command.status, "error");
  assert.equal(command.code, "malformed_response");
  assert.deepEqual(commandCache.getState().huddles[conversationId], inactive);
  assert.equal(commandClient.getHuddleMediaJoinDescriptor(conversationId), undefined);
  assert.doesNotMatch(
    JSON.stringify({ command, client: commandClient, cache: commandCache.getState() }),
    /MALFORMED_(?:SNAPSHOT|COMMAND)_DESCRIPTOR_SENTINEL/u,
  );
});

test("maps failures safely, supports retry/rejoin, expires and clears descriptors, and excludes them from serialization", async () => {
  const clock = new FakeClock();
  const cache = createNormalizedChatCache(identity);
  cache.setHuddleState(inactive);
  const diagnostics = [];
  const requestKeys = [];
  let mode = "provider_failure";
  const client = createClient({
    cache,
    clock,
    diagnostics,
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      requestKeys.push(init.headers["idempotency-key"]);
      if (mode === "provider_failure") {
        return response({
          error: {
            code: "CHAT_HUDDLE_START_UNAVAILABLE",
            message: "RAW_PROVIDER_BODY_SECRET_SENTINEL",
          },
        }, 503);
      }
      if (mode === "feature_disabled") {
        return response({
          operation: input.operation,
          outcome: "feature_disabled",
          reconciliationStatus: "applied",
          feature: "huddles",
          reason: "media_unavailable",
          state: inactive,
        });
      }
      return response(commandResult(input.operation, starting, {
        mediaJoin: {
          ...mediaJoin(),
          expiresAt: new Date(clock.current + 4 * 60_000).toISOString(),
        },
      }));
    },
  });

  const failed = await client.startHuddle(conversationId);
  assert.deepEqual(
    { status: failed.status, code: failed.code, retryable: failed.retryable },
    { status: "error", code: "transport", retryable: true },
  );
  mode = "success";
  assert.equal((await client.retryHuddle(conversationId)).status, "success");
  assert.equal(requestKeys[0], requestKeys[1]);
  assert.equal(requestKeys[1], requestKeys[2], "manual retry must reuse the original key");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId).descriptor, descriptorSentinel);

  clock.tick(4 * 60_000);
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId), undefined);
  assert.deepEqual(client.getHuddleState(conversationId).media, {
    state: "rejoin_required",
    reason: "descriptor_expired",
  });

  cache.setHuddleState(inactive);
  mode = "feature_disabled";
  const disabled = await client.startHuddle(conversationId);
  assert.equal(disabled.status, "feature_disabled");
  assert.equal(client.getHuddleState(conversationId).media.state, "unavailable");

  mode = "success";
  assert.equal((await client.startHuddle(conversationId)).status, "success");
  cache.setIdentity({ ...identity, sessionId: "replacement-session" });
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId), undefined);

  cache.setHuddleState(inactive);
  assert.equal((await client.startHuddle(conversationId)).status, "success");
  cache.setHuddleState({
    ...starting,
    huddleSessionId: "replacement-huddle-session",
  });
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId), undefined);
  const crossTabMessages = [];
  const coordinator = createChatCrossTabCoordinator({
    endpoint: "/chat",
    sessionFingerprint: "safe-session-fingerprint",
    tabId: "tab-huddle",
    clock: {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    },
    channelFactory: () => ({
      postMessage(value) { crossTabMessages.push(structuredClone(value)); },
      addEventListener() {},
      removeEventListener() {},
      close() {},
    }),
  });
  coordinator.start();
  coordinator.publishCanonicalState(cache.getState());

  const serialized = JSON.stringify({
    client,
    cache: cache.getState(),
    diagnostics,
    crossTabMessages,
  });
  assert.equal(serialized.includes(descriptorSentinel), false);
  assert.equal(serialized.includes("RAW_PROVIDER_BODY_SECRET_SENTINEL"), false);
  assert.equal(serialized.includes("BEARER_TOKEN_SENTINEL"), false);
  coordinator.close();
  client.close();
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId), undefined);
});

test("realtime disconnect clears join material and exposes rejoin-required state", async () => {
  const clock = new FakeClock();
  const cache = createNormalizedChatCache(identity);
  cache.setHuddleState(inactive);
  let offline;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    fetch: async (url, init) => {
      if (url.endsWith("/_meta")) return response(metadata);
      const input = JSON.parse(init.body);
      return response(commandResult(
        input.operation,
        input.operation === "join_huddle" ? active : starting,
        { mediaJoin: mediaJoin() },
      ));
    },
    huddles: {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      generateIdempotencyKey: () => "disconnect-key",
    },
    realtime: {
      clock,
      random: () => 0.5,
      network: {
        isOnline: () => true,
        addEventListener(type, listener) {
          if (type === "offline") offline = listener;
        },
        removeEventListener() {},
      },
      webSocketFactory: () => ({
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send() {},
        close() {},
      }),
    },
  });

  assert.equal((await client.start()).state, "ready");
  assert.equal((await client.startHuddle(conversationId)).status, "success");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId).descriptor, descriptorSentinel);
  offline();
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId), undefined);
  assert.deepEqual(client.getHuddleState(conversationId).media, {
    state: "rejoin_required",
    reason: "realtime_disconnected",
  });
  assert.equal((await client.rejoinHuddle(conversationId)).status, "success");
  assert.equal(client.getHuddleState(conversationId).media.state, "ready");
});

test("accepts a join when the server includes another participant absent from the local snapshot", async () => {
  const cache = createNormalizedChatCache(identity);
  cache.setHuddleState(starting);
  const concurrent = { ...active, participants: [
    { userId: "another-user", status: "joined", joinedAt },
    { userId, status: "joined", joinedAt: leftAt },
  ] };
  const client = createClient({ cache, fetch: async () => response(commandResult("join_huddle", concurrent, { mediaJoin: mediaJoin() })) });
  const result = await client.joinHuddle(conversationId);
  assert.equal(result.status, "success");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId).descriptor, descriptorSentinel);
  assert.equal(cache.getState().huddles[conversationId].participants.length, 2);
  client.close();
});

test("a queued leave arriving during rejoin does not discard the newer join credential", async () => {
  const cache = createNormalizedChatCache(identity);
  cache.setHuddleState(left);
  const rejoined = { ...active, participants: [{ userId, status: "joined", joinedAt: endedAt }] };
  const client = createClient({ cache, fetch: async () => {
    cache.setHuddleState({ ...left, participants: [...left.participants] });
    return response(commandResult("join_huddle", rejoined, { mediaJoin: mediaJoin() }));
  } });
  const result = await client.joinHuddle(conversationId);
  assert.equal(result.status, "success");
  assert.equal(cache.getState().huddles[conversationId].participants[0].status, "joined");
  assert.equal(client.getHuddleMediaJoinDescriptor(conversationId).descriptor, descriptorSentinel);
  client.close();
});
