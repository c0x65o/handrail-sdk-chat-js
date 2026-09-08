import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
const compiled = process.env.HANDRAIL_THREAD_LIST_BUILD;
assert.ok(compiled, "Run node scripts/test-client-thread-list.mjs for fresh compilation");
const { createThreadListRuntime } = await import(`${compiled}/client/thread-list.js`);
const { createChatSnapshotReader } = await import(`${compiled}/client/snapshot-reader.js`);
const { createNormalizedChatCache, createChatClient, createApplicationChatStorage, CHAT_CLIENT_PACKAGE_VERSION } = await import(`${compiled}/client/index.js`);
const { encodeThreadListCursor } = await import(`${compiled}/contracts/thread-list.js`);
const { CHAT_PROTOCOL_VERSION } = await import(`${compiled}/contracts/realtime.js`);
process.env.NODE_ENV = "test";
const { createElement, act } = await import("react");
const { create } = await import("react-test-renderer");
const { ChatProvider, useThreadList } = await import(`${compiled}/react/index.js`);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fixture = JSON.parse(await readFile(new URL("./fixtures/thread-list.json", import.meta.url)));
const base = fixture.base, parent = base.parentConversationId, tenantId = "tenant-1", userId = "alice";
const identity = { tenantId, userId, sessionId: "session" };
const query = { parentConversationId: parent, limit: 2 };
const clone = value => structuredClone(value);
const row = (id = "thread-a", createdAt = base.items[0].thread.createdAt) => {
  const item = clone(base.items[0]); item.thread.id = id; item.thread.createdAt = createdAt;
  item.thread.currentMember.conversationId = item.thread.currentReadState.conversationId = item.thread.currentPreference.conversationId = id;
  item.currentThreadFollow.follow.target.id = id;
  return item;
};
const page = (items = [row()], extra = {}) => ({ ...clone(base), items, ...extra });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
let eventNumber = 0;
const event = (type, payload, streamId = parent) => ({ eventId: `event-${++eventNumber}`, protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId, streamId, type, occurredAt: base.evaluatedAt, payload });
const lifecycle = (revision, child = "unopened", full = false) => event(full ? "thread.lifecycle.updated" : "thread.lifecycle.changed",
  { parentConversationId: parent, threadId: child, ...(full ? { threadLifecycle: { revision, locked: false, closedAt: base.evaluatedAt, closedByUserId: userId } } : { revision }) }, full ? child : parent);
function harness() {
  const cache = createNormalizedChatCache(identity), calls = [], streams = [], timers = new Set();
  let localNow = 100, online = true, reply = () => response(page());
  const reader = createChatSnapshotReader({ endpoint: "/chat", getAccessToken: () => "token", fetch: async (url, init) => {
    calls.push({ url, init }); return reply(url, init);
  } });
  const runtime = createThreadListRuntime({ cache, reader, online: () => online, now: () => localNow,
    subscribeConversation: id => { const entry = { id, released: false }; streams.push(entry); return () => { entry.released = true; }; },
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return () => timers.delete(timer); },
  });
  return { runtime, api: runtime.api, cache, calls, streams, timers,
    reply(fn) { reply = fn; }, async observe(q = query) { const release = runtime.api.subscribe(q, () => {}); await flush(); return release; },
    online(value) { online = value; runtime.connectionChanged(value); },
    tick(ms) { localNow += ms; const pending = [...timers]; timers.clear(); for (const timer of pending) timer.callback(); },
  };
}
const metadata = () => ({ packageVersion: CHAT_CLIENT_PACKAGE_VERSION, protocolVersion: CHAT_PROTOCOL_VERSION, schemaVersion: 1,
  enabledFeatures: {}, supportedProtocolRange: { minimumVersion: CHAT_PROTOCOL_VERSION, maximumVersion: CHAT_PROTOCOL_VERSION } });
const detail = (item = row()) => ({ kind: "conversation_detail", _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
  conversation: { ...item.thread, memberUserIds: [], currentThreadFollow: item.currentThreadFollow } });

test("canonical creation/C ordering, page progression and repeated loadMore deduplication", async () => {
  const h = harness();
  const items = [row("Z"), row("a")];
  const cursor = encodeThreadListCursor({ parentConversationId: parent, view: "active", createdAt: items[1].thread.createdAt, threadId: "a" });
  const delayed = deferred();
  h.reply(url => url.includes("cursor=") ? delayed.promise : response(page(items, { nextCursor: cursor })));
  const release = await h.observe();
  assert.equal(h.api.getState(query).hasMore, true);
  const a = h.api.loadMore(query), b = h.api.loadMore(query); assert.equal(a, b); await flush();
  assert.equal(h.api.getState(query).status, "loading_more");
  delayed.resolve(response(page([row("z")]))); await a;
  assert.deepEqual(h.api.getState(query).items.map(i => i.thread.id), ["Z", "a", "z"]);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].init.headers.authorization, "Bearer token");
  assert.equal(h.calls[0].init.method, "GET");
  assert.equal(h.streams[0].id, parent); release(); h.runtime.dispose();
});

test("refresh supersedes a late page; malformed cursor/duplicate results fail safely and retry", async () => {
  const h = harness(), old = deferred();
  const items = [row("a"), row("b")];
  const nextCursor = encodeThreadListCursor({ parentConversationId: parent, view: "active", createdAt: items[1].thread.createdAt, threadId: "b" });
  h.reply(url => url.includes("cursor=") ? old.promise : response(page(items, { nextCursor })));
  const release = await h.observe();
  const pending = h.api.loadMore(query); await flush();
  h.reply(() => response(page([row("new")]))); await h.api.refresh(query);
  old.resolve(response(page([row("z")]))); await pending;
  assert.deepEqual(h.api.getState(query).items.map(i => i.thread.id), ["new"]);
  h.reply(() => response(page([row(), row()]))); await h.api.refresh(query);
  assert.equal(h.api.getState(query).error, "malformed_response");
  h.reply(() => response(page([]))); await h.api.retry(query);
  assert.equal(h.api.getState(query).empty, true); assert.equal(h.api.getState(query).status, "ready");
  release(); h.runtime.dispose();
});

test("initial loading, sanitized transport error, retry and empty have distinct states", async () => {
  const h = harness(), pending = deferred(); h.reply(() => pending.promise);
  assert.equal(h.api.getState(query).status, "idle"); const release = await h.observe();
  assert.equal(h.api.getState(query).status, "loading"); assert.equal(h.api.getState(query).empty, false);
  pending.resolve(response({ secret: "do not expose" }, 500)); await flush();
  assert.equal(h.api.getState(query).status, "error"); assert.ok(!JSON.stringify(h.api.getState(query)).includes("secret"));
  h.reply(() => response(page([]))); await h.api.retry(query);
  assert.equal(h.api.getState(query).empty, true); release(); h.runtime.dispose();
});

test("parent-stream unopened lifecycle invalidation deduplicates scoped revisions; reconnect catches missed events", async () => {
  const h = harness(); const release = await h.observe(); const count = h.calls.length;
  h.runtime.handleCanonicalEvent(lifecycle(3)); await flush(); assert.equal(h.calls.length, count + 1);
  h.runtime.handleCanonicalEvent(lifecycle(3)); h.runtime.handleCanonicalEvent(lifecycle(2)); await flush();
  assert.equal(h.calls.length, count + 1);
  h.runtime.handleCanonicalEvent({ ...lifecycle(4), tenantId: "wrong" });
  h.runtime.handleCanonicalEvent(event("thread.lifecycle.changed", { parentConversationId: "other", threadId: "unopened", revision: 4 }, "other"));
  await flush(); assert.equal(h.calls.length, count + 1);
  h.online(false); h.reply(() => response(page([]))); h.online(true); await flush();
  assert.equal(h.api.getState(query).empty, true);
  release(); assert.equal(h.streams[0].released, true); h.runtime.dispose();
});

test("canonical creation and cache follow/read updates refresh without joining a left/unfollowed child", async () => {
  const h = harness(); const release = await h.observe();
  assert.equal(h.api.getState(query).items[0].thread.currentMember.state, "left");
  const item = row("new"); const { currentMember, currentReadState, currentPreference, activeMemberUserIds, latestSequence, activityAt, unreadMentionCount, ...conversation } = item.thread;
  h.runtime.handleCanonicalEvent(event("conversation.created", { conversation }, conversation.id)); await flush();
  assert.equal(h.calls.length, 2);
  const initial = row(); initial.thread.currentMember.state = "active";
  h.cache.hydrateConversationDetail(detail(initial)); await flush();
  const updated = row(); updated.thread.currentMember.state = "active"; updated.thread.currentReadState.lastReadSequence = 3; updated.thread.currentReadState.updatedAt = "2026-09-06T12:00:01.000Z"; updated.currentThreadFollow.followRevision = 5;
  updated.currentThreadFollow.follow.isFollowing = true;
  h.cache.hydrateConversationDetail(detail(updated)); await flush();
  const state = h.api.getState(query);
  assert.equal(state.items[0].thread.currentReadState.lastReadSequence, 3);
  assert.equal(state.items[0].currentThreadFollow.followRevision, 5);
  assert.equal(state.items[0].currentThreadFollow.follow.isFollowing, true);
  assert.ok(h.calls.every(c => c.init.method === "GET")); release(); h.runtime.dispose();
});

test("child lifecycle facts survive older HTTP and duplicate/out-of-order child events", async () => {
  const h = harness(); const release = await h.observe();
  h.runtime.handleCanonicalEvent(lifecycle(4, "thread-a", true)); await flush();
  assert.equal(h.api.getState(query).items.length, 0);
  const count = h.calls.length;
  h.runtime.handleCanonicalEvent(lifecycle(4, "thread-a", true)); h.runtime.handleCanonicalEvent(lifecycle(2, "thread-a", true)); await flush();
  assert.equal(h.calls.length, count);
  release(); h.runtime.dispose();
});

for (const boundary of ["parent-release", "view-release", "actor", "tenant", "session", "parent-revoke", "child-revoke", "dispose"]) {
  test(`${boundary} isolates late HTTP authority and cancels retained work`, async () => {
    const h = harness(), old = deferred(); h.reply(() => old.promise);
    const release = await h.observe();
    h.reply(() => response(page([])));
    if (boundary === "parent-release" || boundary === "view-release") {
      release(); const q = boundary === "parent-release" ? { ...query, parentConversationId: "other" } : { ...query, view: "all" };
      h.reply(() => response(page([], { parentConversationId: q.parentConversationId, view: q.view ?? "active" })));
      const otherRelease = await h.observe(q); otherRelease();
    } else if (["actor", "tenant", "session"].includes(boundary)) {
      h.cache.setIdentity({ ...identity, [boundary === "actor" ? "userId" : boundary === "tenant" ? "tenantId" : "sessionId"]: "new" });
    } else if (boundary === "dispose") h.runtime.dispose();
    else h.runtime.revoke(boundary === "parent-revoke" ? parent : "thread-a");
    old.resolve(response(page())); await flush();
    assert.equal(h.api.getState(query).items.length, 0);
    assert.equal(h.calls[0].init.signal.aborted, true);
    if (boundary === "parent-revoke") {
      h.online(false); h.online(true); await flush();
      assert.equal(h.api.getState(query).status, "unavailable"); assert.equal(h.calls.length, 1);
    }
    release(); h.runtime.dispose();
  });
}

test("response actor/tenant/private preference mismatch cannot populate discovery", async () => {
  for (const field of ["tenantId", "currentMember", "currentReadState", "currentPreference"]) {
    const h = harness(), item = row();
    if (field === "tenantId") item.thread.tenantId = "other"; else item.thread[field].userId = "other";
    h.reply(() => response(page([item]))); await h.api.refresh(query);
    assert.equal(h.api.getState(query).error, "malformed_response"); assert.equal(h.api.getState(query).items.length, 0); h.runtime.dispose();
  }
});

function expiring(hideAfterMs = 5000) {
  const item = row(); item.hideAt = Date.parse(item.lastActivityAt) + hideAfterMs;
  return page([item], { inactivityPolicy: { hideAfterMs } });
}
test("observed server expiry uses evaluatedAt clock offset, refreshes and cancels on release", async () => {
  const h = harness(); h.reply(() => response(expiring())); const release = await h.observe();
  assert.equal([...h.timers][0].delay, 5000);
  h.reply(() => response(page([]))); h.tick(5000); await flush();
  assert.equal(h.api.getState(query).empty, true); assert.equal(h.timers.size, 0);
  h.reply(() => response(expiring())); await h.api.refresh(query); assert.equal(h.timers.size, 1);
  release(); assert.equal(h.timers.size, 0); h.runtime.dispose();
});
test("tiny/overflow deadlines are bounded; unobserved, disabled and all lists have no timer", async () => {
  const h = harness(); h.reply(() => response(expiring(0.000001))); const release = await h.observe();
  assert.equal([...h.timers][0].delay, 1000);
  h.reply(() => response(expiring(1e15))); await h.api.refresh(query);
  assert.equal([...h.timers][0].delay, 2_147_483_647);
  h.tick(2_147_483_647); await flush(); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 1);
  h.reply(() => response(page())); await h.api.refresh(query); assert.equal(h.timers.size, 0);
  release(); h.reply(() => response(expiring())); await h.api.refresh(query); assert.equal(h.timers.size, 0);
  h.reply(() => response({ ...expiring(), view: "all" })); const allRelease = await h.observe({ ...query, view: "all" });
  assert.equal(h.timers.size, 0); allRelease(); h.runtime.dispose();
});

test("public hook switches parent/view, retries, and hiding preserves open thread, draft and queued destination", async () => {
  const cache = createNormalizedChatCache(identity), calls = [], rows = new Map();
  let list = page(), rendered, root;
  const storage = createApplicationChatStorage({ read: async (_id, kind) => rows.get(kind) ?? null,
    replace: async (_id, kind, value) => { rows.set(kind, value); }, remove: async (_id, kind) => { rows.delete(kind); }, clearForLogout: async () => rows.clear() });
  const client = createChatClient({ endpoint: "/chat", cache, getAccessToken: () => "token",
    normalizedCachePersistence: { storage, resolveIdentity: () => ({ tenantId, userId, deviceId: "device" }) },
    drafts: { timer: { schedule: () => 1, cancel() {} } }, commands: { retry: { maxAttempts: 1 } },
    optimisticMessages: { generateClientMessageId: () => "queued", generateIdempotencyKey: () => "queued-key" },
    fetch: async (url, init) => { calls.push({ url, init });
      if (url.endsWith("/_meta")) return response(metadata());
      if (url.includes("/threads?")) return response(list);
      if (url.endsWith("/conversations/thread-a")) { const item = row(); item.thread.currentMember.state = "active"; return response(detail(item)); }
      if (url.includes("/messages?")) {
        const conversationId = url.includes("/thread-a/") ? "thread-a" : parent;
        return response({ conversationId, messages: conversationId === parent ? [] : [{
          id: "history", tenantId, conversationId, author: { type: "user", userId }, sequence: 1,
          createdAt: base.evaluatedAt, updatedAt: base.evaluatedAt, revision: { revision: 1 },
          content: { format: "plain", text: "retained history" }, isThreadRoot: false, reactions: [], attachmentMetadata: [],
        }], pagination: { older: { available: false }, newer: { available: false } }, replay: { resumeFrom: { eventId: "snapshot" } } });
      }
      throw new Error("offline");
    },
  });
  function Probe({ target }) { rendered = useThreadList(target); return null; }
  const render = target => createElement(ChatProvider, { client }, createElement(Probe, { target }));
  try {
    await client.start();
    assert.equal((await client.openExistingThread("thread-a")).state, "ready");
    client.replaceConversationDraft({ conversationId: "thread-a", content: { format: "plain", text: "keep", attachments: [] } });
    await client.sendMessage({ conversationId: "thread-a", content: { format: "plain", text: "pending" } });
    const draft = client.selectConversationDraft("thread-a").draft, queued = client.getSendMessageQueueState().intents;
    const opening = client.getExistingThreadOpeningState("thread-a"); const history = cache.getState().entities.messages;
    assert.equal(queued.length, 1);
    await act(async () => { root = create(render(query)); }); assert.equal(rendered.items.length, 1);
    list = page([]); await act(async () => { await rendered.actions.refresh(); }); assert.equal(rendered.empty, true);
    assert.deepEqual(client.selectConversationDraft("thread-a").draft, draft);
    assert.deepEqual(client.getSendMessageQueueState().intents, queued);
    assert.deepEqual(client.getExistingThreadOpeningState("thread-a"), opening); assert.deepEqual(cache.getState().entities.messages, history);
    list = page([], { parentConversationId: "other", view: "all" });
    await act(async () => { root.update(render({ parentConversationId: "other", view: "all" })); });
    assert.equal(rendered.parentConversationId, "other"); assert.equal(rendered.view, "all"); assert.equal(rendered.empty, true);
    await act(async () => rendered.actions.retry());
    assert.ok(calls.filter(c => c.url.includes("/threads?")).every(c => c.init.method === "GET"));
  } finally { if (root) await act(async () => root.unmount()); client.close(); }
});

class Socket {
  readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  accept() { this.receive({ type: "chat.session.accepted", metadata: metadata(), tenantId,
    actorStreamId: `user:${userId}`, deviceId: "device", sessionId: identity.sessionId }); }
  disconnect() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" }); }
  close() { this.readyState = 3; }
}
test("public client retains parent stream, forwards unopened child invalidation, reconnect and revocation", async () => {
  const sockets = [], timers = [], calls = [];
  let list = page();
  const client = createChatClient({ endpoint: "/chat", cache: createNormalizedChatCache(identity), getAccessToken: () => "token",
    realtime: { clock: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} }, random: () => 0.5,
      webSocketFactory() { const socket = new Socket(); sockets.push(socket); return socket; } },
    fetch: async (url, init) => { calls.push({ url, init }); return response(url.endsWith("/_meta") ? metadata() : list); },
  });
  let release;
  try {
    await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
    release = client.threadList.subscribe(query, () => {}); await flush();
    assert.equal(client.threadList.getState(query).items.length, 1);
    assert.ok(sockets[0].sent.some(v => v.type === "chat.subscribe" && v.streamId === parent));
    assert.ok(!sockets[0].sent.some(v => v.type === "chat.subscribe" && v.streamId === "unopened"));
    const count = calls.length;
    sockets[0].receive(lifecycle(7)); await flush(); assert.equal(calls.length, count + 1);
    sockets[0].receive(lifecycle(7)); sockets[0].receive(lifecycle(6)); await flush(); assert.equal(calls.length, count + 1);
    sockets[0].disconnect(); list = page([]);
    timers.shift()(); await flush(); sockets[1].open(); sockets[1].accept(); await flush();
    assert.equal(client.threadList.getState(query).empty, true);
    sockets[1].receive({ type: "chat.subscription.revoked", streamId: parent });
    assert.equal(client.threadList.getState(query).status, "unavailable");
    const revokedCount = calls.length;
    sockets[1].receive(lifecycle(99)); sockets[1].disconnect(); timers.shift()(); await flush();
    sockets[2].open(); sockets[2].accept(); await flush();
    assert.equal(client.threadList.getState(query).status, "unavailable"); assert.equal(calls.length, revokedCount);
  } finally { release?.(); client.close(); }
});

for (const boundary of ["identity", "revoke", "disconnect", "dispose"]) {
  test(`expiry timer cancels on ${boundary}`, async () => {
    const h = harness(); h.reply(() => response(expiring())); const release = await h.observe();
    assert.equal(h.timers.size, 1); h.reply(() => response(page([])));
    if (boundary === "identity") h.cache.setIdentity({ ...identity, sessionId: "replacement" });
    else if (boundary === "revoke") h.runtime.revoke(parent);
    else if (boundary === "disconnect") h.online(false);
    else h.runtime.dispose();
    assert.equal(h.timers.size, 0); await flush(); assert.equal(h.timers.size, 0); release(); h.runtime.dispose();
  });
}

test("HTTP access denial stays revoked across reconnect and late results", async () => {
  const h = harness(); const release = await h.observe();
  h.reply(() => response({}, 403)); await h.api.refresh(query);
  assert.equal(h.api.getState(query).status, "unavailable");
  h.reply(() => response(page())); h.online(false); h.online(true); await flush();
  assert.equal(h.api.getState(query).items.length, 0); assert.equal(h.calls.length, 2);
  release(); h.runtime.dispose();
});

test("parent revision invalidation rejects an older HTTP lifecycle until explicit retry catches up", async () => {
  const h = harness(); const release = await h.observe();
  h.runtime.handleCanonicalEvent(lifecycle(5, "thread-a")); await flush();
  assert.equal(h.api.getState(query).error, "stale_response");
  const item = row(); item.thread.threadLifecycle = { revision: 5, locked: false };
  h.reply(() => response(page([item], { lifecycleSupported: true })));
  await h.api.retry(query); assert.equal(h.api.getState(query).items[0].thread.threadLifecycle.revision, 5);
  release(); h.runtime.dispose();
});

test("pagination retry retains its cursor and invalidates non-advancing pages", async () => {
  const h = harness(), items = [row("a"), row("b")];
  const nextCursor = encodeThreadListCursor({ parentConversationId: parent, view: "active", createdAt: items[1].thread.createdAt, threadId: "b" });
  h.reply(() => response(page(items, { nextCursor }))); const release = await h.observe();
  h.reply(() => response(page([row("b")]))); await h.api.loadMore(query);
  assert.equal(h.api.getState(query).error, "malformed_response");
  const failedUrl = h.calls.at(-1).url;
  h.reply(() => response(page([row("c")]))); await h.api.retry(query);
  assert.equal(h.calls.at(-1).url, failedUrl);
  assert.deepEqual(h.api.getState(query).items.map(i => i.thread.id), ["a", "b", "c"]);
  release(); h.runtime.dispose();
});

test("future subsecond expiry schedules at the nearest server deadline", async () => {
  const h = harness(); h.reply(() => response(expiring(20))); const release = await h.observe();
  assert.equal([...h.timers][0].delay, 20); release(); h.runtime.dispose();
});

test("a newer normalized lifecycle cannot be replaced by an older discovery snapshot", async () => {
  const h = harness(); const release = await h.observe();
  const item = row(); item.thread.currentMember.state = "active";
  item.thread.threadLifecycle = { revision: 10, locked: true, closedAt: base.evaluatedAt, closedByUserId: userId };
  h.cache.hydrateConversationDetail(detail(item)); await flush();
  assert.equal(h.api.getState(query).items.length, 0);
  assert.equal(h.cache.getState().entities.conversations["thread-a"].threadLifecycle.revision, 10);
  release(); h.runtime.dispose();
});

test("normalized child removal cannot be restored by discovery HTTP", async () => {
  const h = harness(); h.cache.hydrateConversationDetail(detail()); const release = await h.observe();
  h.cache.dispatch({ type: "threads/discard-history", threadId: "thread-a" }); await flush();
  assert.equal(h.api.getState(query).items.length, 0);
  h.online(false); h.online(true); await flush(); assert.equal(h.api.getState(query).items.length, 0);
  release(); h.runtime.dispose();
});
