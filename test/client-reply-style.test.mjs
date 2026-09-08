import assert from "node:assert/strict";
import test from "node:test";
const compiled = process.env.HANDRAIL_REPLY_STYLE_BUILD;
assert.ok(compiled, "Run node scripts/test-client-reply-style.mjs to compile fresh output first");
const { createReplyStyleRuntime } = await import(`${compiled}/client/reply-style-runtime.js`);
const { createChatCommandDispatcher } = await import(`${compiled}/client/command-dispatcher.js`);
const { createChatSnapshotReader } = await import(`${compiled}/client/snapshot-reader.js`);
const { createChatClient, createNormalizedChatCache, createApplicationChatStorage, CHAT_CLIENT_PACKAGE_VERSION } = await import(`${compiled}/client/index.js`);
const { CHAT_PROTOCOL_VERSION } = await import(`${compiled}/contracts/realtime.js`);
const identity = { tenantId: "tenant", userId: "alice", sessionId: "session-alice" };
const now = "2030-01-01T00:00:00.000Z";
const absent = { state: "absent", revision: 0 };
const saved = (revision, style = "discord") => ({ state: "saved", revision, style });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const result = (input, preference = saved(input.baseRevision + 1, input.style), reconciliationStatus = "applied") => ({
  operation: input.operation, baseRevision: input.baseRevision, idempotencyKey: input.idempotencyKey,
  requestedStyle: input.style, preference, reconciliationStatus,
});
let sequence = 0;
const event = (preference, mutation, extra = {}) => ({ eventId: `event-${++sequence}`, protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: identity.tenantId, streamId: `user:${identity.userId}`, type: "reply.style.updated", occurredAt: now,
  payload: { actorUserId: identity.userId, preference, updatedAt: now, ...(mutation === undefined ? {} : { mutation }) }, ...extra });
const metadata = () => ({ packageVersion: CHAT_CLIENT_PACKAGE_VERSION, protocolVersion: CHAT_PROTOCOL_VERSION, schemaVersion: 1,
  enabledFeatures: { reply_style_preference_v1: true }, supportedProtocolRange: { minimumVersion: CHAT_PROTOCOL_VERSION, maximumVersion: CHAT_PROTOCOL_VERSION } });
function harness({ preference = absent, configuration, override, feature = true, generateKey } = {}) {
  let canonical = preference, online = true, features = feature === null ? undefined : { reply_style_preference_v1: feature }, key = 0;
  const requests = [], cache = createNormalizedChatCache(identity);
  const fetch = async (url, init) => {
    const input = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url, method: init.method, input, key: init.headers["idempotency-key"] });
    const answer = await override?.(url, init, input);
    if (answer !== undefined) return answer;
    if (init.method === "GET") return response(canonical);
    return response(result(input));
  };
  const reader = createChatSnapshotReader({ endpoint: "/chat", getAccessToken: () => "token", fetch });
  const dispatcher = createChatCommandDispatcher({ endpoint: "/chat", getAccessToken: () => "token", fetch, options: { retry: { maxAttempts: 1 } } });
  const runtime = createReplyStyleRuntime({ cache, reader, dispatch: dispatcher.dispatch, online: () => online, enabledFeatures: () => features,
    generateIdempotencyKey: generateKey ?? (() => `style-${++key}`), configuration });
  return { runtime, api: runtime.api, cache, requests,
    canonical(value) { canonical = value; }, feature(value) { features = value; },
    online(value) { online = value; runtime.connectionChanged(value); },
  };
}
for (const [configuration, preference, style, origin, reason] of [
  [{}, absent, "current", "fallback", "supported"],
  [{ hostDefault: "discord" }, absent, "discord", "host_default", "supported"],
  [{ hostDefault: "discord" }, saved(1, "current"), "current", "saved", "supported"],
  [{ hostDefault: "discord" }, saved(1, " future "), "current", "saved", "unsupported_value"],
  [{ hostDefault: "discord" }, saved(1, ""), "current", "saved", "unsupported_value"],
  [{ enforcedOverride: "current" }, saved(1), "current", "override", "supported"],
  [{ enforcedOverride: "unknown", hostDefault: "discord" }, saved(1), "current", "override", "unsupported_value"],
  [{ enforcedOverride: "discord" }, saved(1, "unknown"), "discord", "override", "supported"],
  [{ hostDefault: "unknown" }, absent, "current", "host_default", "unsupported_value"],
]) test(`precedence ${JSON.stringify(configuration)} ${JSON.stringify(preference)}`, async () => {
  const h = harness({ configuration, preference });
  const notifications = []; h.api.subscribe(() => notifications.push(h.api.select()));
  assert.equal(h.api.getState().confirmedPreference, undefined);
  assert.equal(h.api.getState().editingAvailable, false);
  const state = await h.api.load();
  assert.equal(state.effectiveStyle, style); assert.equal(state.origin, origin); assert.equal(state.resolutionReason, reason);
  assert.deepEqual(state.confirmedPreference, preference); assert.ok(notifications.some(s => s.loading));
  if (configuration.enforcedOverride !== undefined) {
    assert.equal((await h.api.update("discord")).disabledReason, "enforced_override");
    assert.equal(h.requests.length, 1);
    h.api.configure({ hostDefault: "discord" }); assert.notEqual(h.api.getState().origin, "override");
  }
});

test("unresolved, failed reads, and unsupported capabilities never fabricate an absent/saved choice", async () => {
  const gate = deferred(); const h = harness({ configuration: { hostDefault: "discord" }, override: () => gate.promise });
  const pending = h.api.load(); await flush();
  assert.equal((await h.api.update("current")).editingAvailable, false);
  gate.resolve(response({ state: "saved", revision: 1, style: null })); await pending;
  assert.equal(h.api.getState().confirmedPreference, undefined); assert.equal(h.api.getState().loadError, "malformed_response");
  assert.equal(h.api.getState().effectiveStyle, "discord");
  for (const feature of [false, null]) {
    const disabled = harness({ feature }); await disabled.api.load(); await disabled.api.update("discord");
    assert.equal(disabled.requests.length, 0); assert.equal(disabled.api.getState().editingAvailable, false);
    assert.notEqual(disabled.api.getState().saveStatus, "saved");
    assert.equal(disabled.api.getState().capability, feature === null ? "unknown" : "unsupported");
  }
});

test("successful save retains confirmed style while pending, survives reload, and host changes never PATCH", async () => {
  const gate = deferred(); const h = harness({ preference: saved(2, "current"), override: (_u, init, input) => init.method === "PATCH" ? gate.promise.then(() => response(result(input))) : undefined });
  await h.api.load(); const task = h.api.update("discord"); await flush();
  assert.equal(h.api.getState().effectiveStyle, "current"); assert.equal(h.api.getState().requestedStyle, "discord");
  assert.equal(h.api.getState().saveStatus, "saving"); gate.resolve(); await task;
  assert.equal(h.api.getState().saveStatus, "saved"); assert.equal(h.api.getState().effectiveStyle, "discord");
  assert.equal(h.requests[1].input.baseRevision, 2); assert.equal(h.requests[1].key, h.requests[1].input.idempotencyKey);
  const reload = harness({ preference: h.api.getState().confirmedPreference }); await reload.api.load();
  assert.equal(reload.api.getState().effectiveStyle, "discord");
  h.api.configure({ enforcedOverride: "current" }); h.api.configure({});
  assert.equal(h.requests.length, 2); assert.equal(h.api.getState().effectiveStyle, "discord");
});

test("newer private events notify, preserve raw values and ignore foreign/malformed/stale events and late reads", async () => {
  const gate = deferred(); const h = harness({ override: () => gate.promise });
  let calls = 0; h.api.subscribe(() => calls++);
  const load = h.api.load(); await flush(); h.runtime.handleCanonicalEvent(event(saved(4)));
  gate.resolve(response(saved(1, "current"))); await load;
  assert.equal(h.api.getState().confirmedPreference.revision, 4);
  const before = calls; h.runtime.handleCanonicalEvent(event(saved(5, "future"))); assert.ok(calls > before);
  for (const e of [event(saved(3)), event(saved(5, "current")), event(saved(99), undefined, { tenantId: "other" }),
    event(saved(99), undefined, { streamId: "user:bob" }), event(saved(99), undefined, { streamId: "conversation" }),
    event(saved(99), undefined, { payload: { actorUserId: "bob", preference: saved(99), updatedAt: now } }),
    event(saved(99), undefined, { protocolVersion: 0 }), event({ state: "absent", revision: 0 })]) h.runtime.handleCanonicalEvent(e);
  assert.deepEqual(h.api.getState().confirmedPreference, saved(5, "future"));
});

test("uncertain outcome requires GET before exact replay; old replay cannot regress a newer private choice", async () => {
  let tries = 0;
  const h = harness({ override: (_u, init, input) => {
    if (init.method !== "PATCH") return;
    if (++tries === 1) throw new Error("lost acknowledgement");
    return response(result(input, saved(1), "replayed"));
  } });
  await h.api.load(); await h.api.update("discord");
  assert.equal(h.api.getState().reconciliationRequired, true); assert.equal(h.api.getState().effectiveStyle, "current");
  await h.api.update("current"); assert.equal(h.api.getState().saveError, "retry_required");
  h.canonical(saved(3, "current")); await h.api.retry();
  assert.deepEqual(h.requests.map(r => r.method), ["GET", "PATCH", "GET", "PATCH"]);
  assert.deepEqual(h.requests[1], h.requests[3]);
  assert.equal(h.api.getState().confirmedPreference.revision, 3); assert.equal(h.api.getState().saveStatus, "conflict");
  assert.equal(h.api.getState().requestedStyle, "discord");
});

test("failed reconciliation does not resend an uncertain write", async () => {
  let reads = 0;
  const h = harness({ override: (_u, init) => {
    if (init.method === "PATCH" || ++reads > 1) throw new Error("offline");
  } });
  await h.api.load(); await h.api.update("discord"); await h.api.retry();
  assert.equal(h.requests.filter(r => r.method === "PATCH").length, 1);
  assert.equal(h.api.getState().reconciliationRequired, true); assert.equal(h.api.getState().requestedStyle, "discord");
});

test("409 conflict exposes authority and explicit retry creates fresh key/base without automatic overwrite", async () => {
  let writes = 0;
  const h = harness({ override: (_u, init, input) => init.method === "PATCH" && ++writes === 1
    ? response(result(input, saved(4, "future"), "preference_revision_conflict"), 409) : undefined });
  await h.api.load(); const conflict = await h.api.update("discord");
  assert.equal(conflict.saveStatus, "conflict"); assert.deepEqual(conflict.confirmedPreference, saved(4, "future"));
  assert.equal(conflict.requestedStyle, "discord"); await flush(); assert.equal(writes, 1);
  await h.api.retry(); assert.equal(h.api.getState().saveStatus, "saved");
  const patches = h.requests.filter(r => r.method === "PATCH");
  assert.equal(patches[1].input.baseRevision, 4); assert.notEqual(patches[0].key, patches[1].key);
});

for (const field of ["idempotencyKey", "baseRevision", "requestedStyle", "operation"]) test(`mismatched HTTP ${field} never confirms a write`, async () => {
  const h = harness({ override: (_u, init, input) => init.method === "PATCH" ? response({ ...result(input), [field]: field === "baseRevision" ? 8 : "wrong" }) : undefined });
  await h.api.load(); await h.api.update("discord");
  assert.equal(h.api.getState().saveError, "malformed_response"); assert.equal(h.api.getState().reconciliationRequired, true);
  assert.deepEqual(h.api.getState().confirmedPreference, absent);
});

test("only exact event correlation acknowledges pending mutation; unrelated updates preserve retry intent", async () => {
  const gate = deferred(); const h = harness({ override: (_u, init) => init.method === "PATCH" ? gate.promise : undefined });
  await h.api.load(); const task = h.api.update("discord"); await flush();
  const input = h.api.getState().pendingInput;
  h.runtime.handleCanonicalEvent(event(saved(1), { ...input, idempotencyKey: "another-key" }));
  assert.equal(h.api.getState().saveStatus, "saving"); assert.equal(h.api.getState().requestedStyle, "discord");
  gate.resolve(response(result(input))); await task; assert.equal(h.api.getState().saveStatus, "saved");
  const gate2 = deferred(); const other = harness({ override: (_u, init) => init.method === "PATCH" ? gate2.promise : undefined });
  await other.api.load(); const task2 = other.api.update("discord"); await flush();
  other.runtime.handleCanonicalEvent(event(saved(1), other.api.getState().pendingInput));
  assert.equal(other.api.getState().saveStatus, "saved"); assert.equal(other.api.getState().requestedStyle, undefined);
  gate2.resolve(response({}, 500)); await task2; assert.equal(other.api.getState().saveStatus, "saved");
});

for (const phase of ["load", "save"]) for (const boundary of ["logout", "user", "tenant", "away-back", "close"]) test(`${phase} ignores late result after ${boundary}`, async () => {
  const gate = deferred(); let block = phase === "load", intercepted = false;
  const h = harness({ override: (_u, init) => {
    if (block && !intercepted && init.method === (phase === "load" ? "GET" : "PATCH")) { intercepted = true; return gate.promise; }
  } });
  if (phase === "save") { await h.api.load(); block = true; }
  const task = phase === "load" ? h.api.load() : h.api.update("discord"); await flush();
  const input = h.api.getState().pendingInput;
  if (boundary === "close") h.runtime.closeActive();
  else if (boundary === "logout") h.cache.setIdentity(null);
  else { h.cache.setIdentity({ ...identity, [boundary === "tenant" ? "tenantId" : "userId"]: "other" });
    if (boundary === "away-back") h.cache.setIdentity(identity); }
  gate.resolve(response(phase === "load" ? saved(99) : result(input))); await task; await flush();
  assert.notEqual(h.api.getState().saveStatus, "saved"); assert.equal(h.api.getState().requestedStyle, undefined);
  assert.notEqual(h.api.getState().confirmedPreference?.revision, 99);
});

test("switch-away-and-back rejects old GET while a new GET independently establishes absence", async () => {
  const gate = deferred(); let reads = 0;
  const h = harness({ override: (_u, init) => init.method === "GET" && ++reads === 1 ? gate.promise : undefined });
  const old = h.api.load(); await flush(); h.cache.setIdentity({ ...identity, userId: "other" }); h.cache.setIdentity(identity);
  await flush(); gate.resolve(response(saved(99))); await old;
  assert.deepEqual(h.api.getState().confirmedPreference, absent);
});

test("offline request remains unsaved; reconnect rehydrates without writing, explicit retry saves", async () => {
  const h = harness({ preference: saved(1) }); await h.api.load(); h.online(false);
  await h.api.update("current"); assert.equal(h.api.getState().requestedStyle, "current"); assert.equal(h.api.getState().effectiveStyle, "discord");
  h.canonical(saved(3)); h.online(true); await flush();
  assert.equal(h.api.getState().confirmedPreference.revision, 3); assert.equal(h.requests.filter(r => r.method === "PATCH").length, 0);
  await h.api.retry(); assert.equal(h.api.getState().saveStatus, "saved"); assert.equal(h.api.getState().effectiveStyle, "current");
});

test("a host key generator cannot reuse a key for a changed request", async () => {
  const h = harness({ generateKey: () => "constant" }); await h.api.load(); await h.api.update("discord"); await h.api.update("current");
  assert.equal(h.api.getState().saveError, "validation"); assert.equal(h.requests.filter(r => r.method === "PATCH").length, 1);
});

class Socket {
  readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  accept() { this.receive({ type: "chat.session.accepted", metadata: metadata(), tenantId: identity.tenantId,
    actorStreamId: `user:${identity.userId}`, deviceId: "device", sessionId: identity.sessionId }); }
  disconnect() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" }); }
  close() { this.readyState = 3; }
}
test("public client loads at startup, receives validated socket events by revision, and rehydrates reconnect", async () => {
  const sockets = [], timers = []; let canonical = absent;
  const client = createChatClient({ endpoint: "/chat", cache: createNormalizedChatCache(identity), getAccessToken: () => "token",
    realtime: { clock: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} }, random: () => 0.5,
      webSocketFactory() { const socket = new Socket(); sockets.push(socket); return socket; } },
    fetch: async url => response(url.endsWith("/_meta") ? metadata() : canonical) });
  try {
    await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
    assert.deepEqual(client.replyStyle.select().confirmedPreference, absent);
    sockets[0].receive(event(saved(2))); await flush(); assert.equal(client.replyStyle.select().effectiveStyle, "discord");
    sockets[0].receive(event(saved(5, "current"), undefined, { occurredAt: "2020-01-01T00:00:00.000Z" }));
    sockets[0].receive(event(saved(3))); await flush(); assert.deepEqual(client.replyStyle.select().confirmedPreference, saved(5, "current"));
    sockets[0].disconnect(); canonical = saved(7); timers.shift()(); await flush(); sockets[1].open(); sockets[1].accept(); await flush();
    assert.deepEqual(client.replyStyle.select().confirmedPreference, saved(7));
    sockets[0].receive(event(saved(99))); await flush(); assert.equal(client.replyStyle.select().confirmedPreference.revision, 7);
  } finally { client.close(); }
});

test("events from the old identity lifetime are ignored even after switch-away-and-back loads", async () => {
  const h = harness(); await h.api.load(); h.cache.setIdentity({ ...identity, userId: "bob" }); h.cache.setIdentity(identity); await flush();
  h.runtime.handleCanonicalEvent(event(saved(99))); assert.deepEqual(h.api.getState().confirmedPreference, absent);
  h.online(true); await flush(); h.runtime.handleCanonicalEvent(event(saved(1))); assert.deepEqual(h.api.getState().confirmedPreference, saved(1));
});

// Existing HTTP and storage adapter boundaries; no fake database or persistence claim.
test("public preference save, conflict, retry and policy updates preserve an open thread, reply draft and frozen queued send", async () => {
  const { readFile } = await import("node:fs/promises");
  const item = JSON.parse(await readFile(new URL("fixtures/thread-list.json", import.meta.url), "utf8")).base.items[0];
  const actor = { tenantId: item.thread.tenantId, userId: item.thread.currentMember.userId, sessionId: "session" };
  item.thread.currentMember.state = "active";
  const cache = createNormalizedChatCache(actor), rows = new Map(), requests = [];
  const storage = createApplicationChatStorage({ read: async (_id, kind) => rows.get(kind) ?? null,
    replace: async (_id, kind, value) => { rows.set(kind, value); }, remove: async (_id, kind) => rows.delete(kind), clearForLogout: async () => rows.clear() });
  let writes = 0;
  const client = createChatClient({ endpoint: "/chat", cache, getAccessToken: () => "token",
    normalizedCachePersistence: { storage, resolveIdentity: () => ({ tenantId: actor.tenantId, userId: actor.userId, deviceId: "device" }) },
    drafts: { timer: { schedule: () => 1, cancel() {} } }, commands: { retry: { maxAttempts: 1 } },
    optimisticMessages: { generateClientMessageId: () => "queued", generateIdempotencyKey: () => "queued-key" },
    fetch: async (url, init) => {
      requests.push({ url, method: init.method });
      if (url.endsWith("/_meta")) return response(metadata());
      if (url.endsWith("/preferences/reply-style")) {
        if (init.method === "GET") return response(absent);
        const input = JSON.parse(init.body);
        return ++writes === 1 ? response(result(input, saved(3, "current"), "preference_revision_conflict"), 409) : response(result(input));
      }
      if (url.endsWith(`/conversations/${item.thread.id}`)) return response({ kind: "conversation_detail",
        _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
        conversation: { ...item.thread, memberUserIds: [], currentThreadFollow: item.currentThreadFollow } });
      if (url.includes("/messages?")) return response({ conversationId: url.includes(`/${item.thread.id}/`) ? item.thread.id : item.thread.parentConversationId,
        messages: [], pagination: { older: { available: false }, newer: { available: false } }, replay: { resumeFrom: { eventId: "snapshot" } } });
      throw new Error("offline send");
    },
  });
  try {
    await client.start(); await client.replyStyle.load();
    assert.equal((await client.openExistingThread(item.thread.id)).state, "ready");
    const content = { format: "plain", text: "keep", attachments: [], replyTo: { messageId: "source", notifyAuthor: false } };
    client.replaceConversationDraft({ conversationId: item.thread.id, content });
    await client.sendMessage({ conversationId: item.thread.id, content: { format: "plain", text: "pending" }, replyTo: { messageId: "source", notifyAuthor: false } });
    const draft = client.selectConversationDraft(item.thread.id).draft;
    const queue = client.getSendMessageQueueState().intents;
    const opening = client.getExistingThreadOpeningState(item.thread.id);
    const messages = cache.getState().entities.messages;
    assert.equal(queue.length, 1);
    assert.deepEqual(draft.content.replyTo, { messageId: "source", notifyAuthor: false });
    assert.deepEqual(queue[0].request.replyTo, { messageId: "source", notifyAuthor: false });
    assert.equal(queue[0].request.conversationId, item.thread.id);
    const count = requests.length;
    assert.equal((await client.replyStyle.update("discord")).saveStatus, "conflict");
    assert.equal((await client.replyStyle.retry()).saveStatus, "saved");
    client.replyStyle.configure({ enforcedOverride: "current" }); client.replyStyle.configure({});
    await client.replyStyle.load();
    assert.deepEqual(client.selectConversationDraft(item.thread.id).draft, draft);
    assert.deepEqual(client.getSendMessageQueueState().intents, queue);
    assert.deepEqual(client.getExistingThreadOpeningState(item.thread.id), opening);
    assert.deepEqual(cache.getState().entities.messages, messages);
    assert.ok(requests.slice(count).every(r => r.url.endsWith("/preferences/reply-style")));
  } finally { client.close(); }
});

class Clock {
  current = 0; next = 0; timers = new Map();
  now = () => this.current;
  setTimeout = (callback, delay) => { const id = ++this.next; this.timers.set(id, { callback, at: this.current + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  tick(ms) {
    const end = this.current + ms;
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]); this.current = next[1].at; next[1].callback();
    }
    this.current = end;
  }
}
class Channels {
  channels = new Set();
  create() {
    const listeners = new Set();
    const channel = { listeners,
      postMessage: message => { for (const peer of this.channels) if (peer !== channel) for (const listener of peer.listeners) listener({ data: structuredClone(message) }); },
      addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => this.channels.delete(channel),
    };
    this.channels.add(channel); return channel;
  }
}
test("follower receives the canonical cross-tab path and can load/save without owning a socket", async () => {
  const clock = new Clock(), channels = new Channels(), sockets = [];
  const create = tabId => createChatClient({ endpoint: "/chat", cache: createNormalizedChatCache(identity), getAccessToken: () => "token",
    crossTab: { sessionFingerprint: "trusted-session", tabId, clock, channelFactory: () => channels.create(),
      timing: { electionDelayMs: 10, heartbeatIntervalMs: 20, leaseDurationMs: 60, commandClaimDelayMs: 5, commandClaimLeaseMs: 50 } },
    realtime: { clock, webSocketFactory() { const socket = new Socket(); sockets.push(socket); return socket; } },
    fetch: async (url, init) => response(url.endsWith("/_meta") ? metadata() : init.method === "GET" ? absent : result(JSON.parse(init.body))) });
  const leader = create("tab-a"), follower = create("tab-b");
  try {
    await leader.start(); await follower.start(); clock.tick(10); await flush();
    assert.equal(leader.coordination.role, "leader"); assert.equal(follower.coordination.role, "follower");
    assert.equal(sockets.length, 1); sockets[0].open(); sockets[0].accept(); await flush();
    sockets[0].receive(event(saved(2))); await flush();
    assert.deepEqual(leader.replyStyle.select().confirmedPreference, saved(2));
    assert.deepEqual(follower.replyStyle.select().confirmedPreference, saved(2));
    assert.equal(follower.replyStyle.select().editingAvailable, true);
    const before = follower.replyStyle.select();
    sockets[0].receive(event(saved(99), undefined, { streamId: "user:bob" })); await flush();
    assert.deepEqual(follower.replyStyle.select(), before);
    const task = follower.replyStyle.update("current"); await flush(); clock.tick(5); await flush();
    assert.equal((await task).saveStatus, "saved");
  } finally { follower.close(); leader.close(); }
});

for (const status of [404, 501]) test(`HTTP ${status} disables persistence until reconnect without claiming success`, async () => {
  let unsupported = true;
  const h = harness({ override: (_u, init) => init.method === "PATCH" && unsupported ? response({ error: { code: "UNSUPPORTED", message: "Unavailable" } }, status) : undefined });
  await h.api.load(); await h.api.update("discord");
  assert.equal(h.api.getState().capability, "unsupported"); assert.equal(h.api.getState().editingAvailable, false);
  assert.deepEqual(h.api.getState().confirmedPreference, absent); assert.equal(h.api.getState().requestedStyle, "discord");
  await h.api.retry(); assert.equal(h.requests.filter(r => r.method === "PATCH").length, 1);
  unsupported = false; h.online(true); await flush(); await h.api.retry(); assert.equal(h.api.getState().saveStatus, "saved");
});

test("offline edits cannot change the request bound to an uncertain idempotency key", async () => {
  const h = harness({ override: (_u, init) => { if (init.method === "PATCH") throw new Error("lost"); } });
  await h.api.load(); await h.api.update("discord"); h.online(false); await h.api.update("current");
  assert.equal(h.api.getState().requestedStyle, "discord"); assert.equal(h.api.getState().pendingInput.style, "discord");
});

test("reentrant logout cancels a save before dispatch", async () => {
  const h = harness(); await h.api.load();
  h.api.subscribe(() => { if (h.api.getState().saveStatus === "saving") h.cache.setIdentity(null); });
  await h.api.update("discord"); assert.equal(h.requests.filter(r => r.method === "PATCH").length, 0);
  assert.equal(h.api.getState().confirmedPreference, undefined); assert.equal(h.api.getState().requestedStyle, undefined);
});

test("server rejection retains explicit intent; retry after a successful fresh read uses a new request", async () => {
  let reject = true;
  const h = harness({ override: (_u, init) => init.method === "PATCH" && reject ? response({ error: { code: "INVALID_REQUEST", message: "Rejected" } }, 400) : undefined });
  await h.api.load(); await h.api.update("discord");
  assert.equal(h.api.getState().saveError, "rejected"); assert.equal(h.api.getState().requestedStyle, "discord");
  reject = false; h.canonical(saved(3, "current")); await h.api.load(); await h.api.retry();
  assert.equal(h.api.getState().saveStatus, "saved"); assert.equal(h.api.getState().confirmedPreference.revision, 4);
});

test("explicit Current persists absence and canonical no-op results settle without inventing revisions", async () => {
  let noOp = false;
  const h = harness({ configuration: { hostDefault: "discord" }, override: (_u, init, input) => init.method === "PATCH" && noOp
    ? response(result(input, saved(input.baseRevision, input.style), "already_requested_state")) : undefined });
  await h.api.load(); await h.api.update("current");
  assert.deepEqual(h.api.getState().confirmedPreference, saved(1, "current"));
  assert.equal(h.api.getState().origin, "saved"); noOp = true; await h.api.update("current");
  assert.equal(h.api.getState().saveStatus, "saved"); assert.equal(h.api.getState().confirmedPreference.revision, 1);
});

test("reconnect interrupts a pending write, loads authority and waits for an explicit exact replay", async () => {
  const gate = deferred(); let writes = 0;
  const h = harness({ override: (_u, init, input) => init.method === "PATCH"
    ? ++writes === 1 ? gate.promise : response(result(input, saved(1), "replayed")) : undefined });
  await h.api.load(); const task = h.api.update("discord"); await flush();
  const input = h.api.getState().pendingInput; h.online(false); h.canonical(saved(1)); h.online(true); await flush();
  assert.equal(h.api.getState().reconciliationRequired, true); assert.equal(writes, 1);
  gate.resolve(response(result(input))); await task;
  assert.equal(h.api.getState().saveStatus, "error"); await h.api.retry();
  assert.equal(h.api.getState().saveStatus, "saved");
  assert.deepEqual(h.requests.filter(r => r.method === "PATCH").map(r => r.input), [input, input]);
});

test("private event reducer diagnostics reject foreign actors/streams before cursor admission", () => {
  for (const [value, code] of [
    [event(saved(1), undefined, { tenantId: "foreign" }), "tenant_mismatch"],
    [event(saved(1), undefined, { streamId: "user:bob" }), "private_stream_mismatch"],
    [event(saved(1), undefined, { payload: { actorUserId: "bob", preference: saved(1), updatedAt: now } }), "private_stream_mismatch"],
    [event(saved(1), undefined, { streamId: "conversation" }), "incoherent_payload"],
  ]) {
    const cache = createNormalizedChatCache(identity), before = cache.getState();
    assert.throws(() => cache.applyDurableEvent(value), error => error.diagnostic.code === code);
    assert.equal(cache.getState(), before);
  }
});
