import assert from "node:assert/strict";
import test from "node:test";
import { createUnreadMentionRefresh } from "../dist/client/unread-mention-refresh.js";
import { createChatSnapshotReader } from "../dist/client/snapshot-reader.js";
import { createNormalizedChatCache, selectConversationUnreadCount, selectConversationUnreadMentionCount } from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const identity = { tenantId: "read-tenant", userId: "grace", sessionId: "read-session" };
const at = n => `2035-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const meta = { packageVersion: "1.0.41", protocolVersion: CHAT_PROTOCOL_VERSION, schemaVersion: 44,
  enabledFeatures: {}, supportedProtocolRange: { minimumVersion: CHAT_PROTOCOL_VERSION, maximumVersion: CHAT_PROTOCOL_VERSION },
  feature: { name: "conversation_snapshots", version: 1 } };
const summary = (id = "dm", overrides = {}) => ({
  id, tenantId: identity.tenantId, type: "direct", visibility: "private", createdAt: at(0), updatedAt: at(0), activityAt: at(0),
  latestSequence: 2, unreadMentionCount: 0, activeMemberUserIds: ["ada", "grace"],
  currentMember: { tenantId: identity.tenantId, conversationId: id, userId: "grace", role: "member", state: "active", joinedAt: at(0), updatedAt: at(0) },
  currentReadState: { conversationId: id, userId: "grace", lastReadSequence: 2, updatedAt: at(0) },
  currentPreference: { conversationId: id, userId: "grace", isStarred: false, notificationPreference: "all", mute: { muted: false }, updatedAt: at(0) }, ...overrides,
});
const detail = item => ({ kind: "conversation_detail", conversation: { ...item, memberUserIds: ["ada", "grace"], memberListRevision: 1 }, _meta: meta });
const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function harness(t, items = [summary()]) {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationList({ kind: "conversation_list", scope: { type: "organization" }, items, page: {}, _meta: meta });
  let answer = id => response(detail(items.find(item => item.id === id)));
  const requests = [];
  const reader = createChatSnapshotReader({ endpoint: "/chat", getAccessToken: () => "test-token", fetch: async (url, init) => {
    const id = decodeURIComponent(url.split("/").at(-1)); requests.push({ id, signal: init.signal }); return answer(id, init);
  } });
  const runtime = createUnreadMentionRefresh(cache, reader);
  t.after(() => runtime.closeActive());
  return { cache, runtime, requests, answer(fn) { answer = fn; } };
}

test("socket owner and follower reconcile offscreen badges independently with one timer per client", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tabs = [harness(t), harness(t)];
  const releases = tabs.map(h => h.runtime.retain("dm")); await flush();
  for (const h of tabs) {
    assert.equal(h.requests.length, 1);
    h.answer(() => response(detail(summary("dm", { latestSequence: 3, unreadMentionCount: 1, updatedAt: at(1) }))));
  }
  t.mock.timers.tick(5000); await flush();
  for (const h of tabs) {
    assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 1);
    assert.equal(selectConversationUnreadMentionCount(h.cache.getState(), "dm"), 1);
    assert.equal(Object.keys(h.cache.getState().entities.messages).length, 0, "poll never loads message contents");
  }
  releases.forEach(release => release());
  const counts = tabs.map(h => h.requests.length); t.mock.timers.tick(20000); await flush();
  assert.deepEqual(tabs.map(h => h.requests.length), counts);
});

test("duplicate owners share a queue, at most four HTTP reads run, and last release aborts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t, Array.from({ length: 9 }, (_, i) => summary(`dm-${i}`)));
  const gates = [];
  h.answer(id => new Promise(resolve => gates.push({ id, resolve })));
  const releases = Array.from({ length: 9 }, (_, i) => h.runtime.retain(`dm-${i}`));
  const duplicate = h.runtime.retain("dm-0"); await flush();
  assert.equal(h.requests.length, 4);
  t.mock.timers.tick(20000); await flush(); assert.equal(h.requests.length, 4, "slow requests do not accumulate timer work");
  releases[0](); assert.equal(h.requests[0].signal.aborted, false);
  duplicate(); await flush(); assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.requests.length, 5);
  releases.forEach(release => release()); await flush();
  assert.ok(h.requests.every(request => request.signal.aborted));
  const before = h.requests.length; t.mock.timers.tick(20000); await flush(); assert.equal(h.requests.length, before);
  for (const gate of gates) gate.resolve(response(detail(summary(gate.id, { latestSequence: 99 }))));
  await flush(); assert.equal(h.cache.getState().metadata.conversations["dm-0"].latestSequence, 2);
});

test("cursor advancement and manual unread survive repeated authoritative snapshots", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t); let item = summary("dm", { latestSequence: 3, unreadMentionCount: 1 });
  h.answer(() => response(detail(item))); h.runtime.retain("dm"); await flush();
  assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 1);
  item = { ...item, unreadMentionCount: 0, currentReadState: { ...item.currentReadState, lastReadSequence: 3, updatedAt: at(2) } };
  t.mock.timers.tick(5000); await flush(); assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 0);
  item = { ...item, currentReadState: { ...item.currentReadState, manualUnreadFromSequence: 3, updatedAt: at(3) } };
  t.mock.timers.tick(5000); await flush(); assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 1);
  t.mock.timers.tick(5000); await flush(); assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 1);
  assert.equal(h.cache.getState().currentUser.readStates.dm.manualUnreadFromSequence, 3);
  // An older HTTP answer cannot erase the user's newer cursor or manual marker.
  item = summary("dm", { latestSequence: 3, unreadMentionCount: 1 });
  t.mock.timers.tick(5000); await flush(); assert.equal(h.cache.getState().currentUser.readStates.dm.manualUnreadFromSequence, 3);
});

for (const status of [403, 404]) test(`HTTP ${status} evicts unread state and inherited threads without retry leakage`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t, [summary(), summary("thread", { type: "thread", parentConversationId: "dm", rootMessageId: "root" })]);
  h.answer(() => response({}, status)); h.runtime.retain("dm"); await flush();
  for (const id of ["dm", "thread"]) {
    assert.equal(h.cache.getState().entities.conversations[id], undefined);
    assert.equal(h.cache.getState().currentUser.readStates[id], undefined);
    assert.equal(h.cache.getState().metadata.conversationListUnreadMentionCounts[id], undefined);
  }
  const before = h.requests.length; t.mock.timers.tick(20000); await flush(); assert.equal(h.requests.length, before);
});

test("revocation, session replacement and close reject late in-flight snapshots", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const boundary of ["revoke", "session", "tenant", "close"]) {
    const h = harness(t); let resolve;
    h.answer(() => new Promise(done => { resolve = done; }));
    const release = h.runtime.retain("dm"); await flush();
    if (boundary === "revoke") h.runtime.revoke("dm");
    else if (boundary === "close") h.runtime.closeActive();
    else h.cache.setIdentity({ ...identity, [boundary === "session" ? "sessionId" : "tenantId"]: "replacement" });
    resolve(response(detail(summary("dm", { latestSequence: 99, unreadMentionCount: 9 })))); await flush();
    assert.equal(h.requests[0].signal.aborted, true);
    assert.notEqual(h.cache.getState().metadata.conversations.dm?.latestSequence, 99);
    release(); const before = h.requests.length; t.mock.timers.tick(20000); await flush(); assert.equal(h.requests.length, before);
  }
});

test("transient failures retry at the bounded interval and reconnect reconciles immediately", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t); h.answer(() => response({}, 503)); h.runtime.retain("dm"); await flush();
  assert.equal(h.requests.length, 1); assert.ok(h.cache.getState().entities.conversations.dm);
  h.answer(() => response(detail(summary("dm", { latestSequence: 3, unreadMentionCount: 1 }))));
  h.runtime.connected(); await flush(); assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 1);
  t.mock.timers.tick(5000); await flush(); assert.equal(selectConversationUnreadMentionCount(h.cache.getState(), "dm"), 1);
});

test("a removed offscreen membership evicts the observed row and cancels polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t); h.runtime.retain("dm"); await flush();
  const item = summary();
  h.cache.hydrateConversationDetail(detail({ ...item, currentMember: { ...item.currentMember, state: "removed", updatedAt: at(4) } }));
  assert.equal(h.cache.getState().entities.conversations.dm, undefined);
  const before = h.requests.length; t.mock.timers.tick(20000); await flush(); assert.equal(h.requests.length, before);
});

test("mute and explicit unfollow are not changed by unread reconciliation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const item = summary("thread", { type: "thread", parentConversationId: "dm", rootMessageId: "root" });
  item.currentPreference = { ...item.currentPreference, mute: { muted: true }, notificationPreference: "mentions" };
  const h = harness(t, [summary(), item]);
  h.cache.hydrateConversationDetail(detail({ ...item, currentThreadFollow: { followRevision: 1,
    follow: { target: { type: "thread", id: "thread" }, isFollowing: false, source: "manual", updatedAt: at(0) } } }));
  h.answer(id => response(detail(id === "thread" ? { ...item, latestSequence: 3, unreadMentionCount: 1 } : summary())));
  h.runtime.retain("thread"); await flush();
  assert.equal(selectConversationUnreadCount(h.cache.getState(), "thread"), 1);
  assert.equal(selectConversationUnreadMentionCount(h.cache.getState(), "thread"), 1);
  assert.equal(h.cache.getState().currentUser.preferences.thread.mute.muted, true);
  assert.equal(h.cache.getState().currentUser.threadFollows.thread.isFollowing, false);
});


test("parent removal revokes inherited thread access even when only the thread is observed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t, [summary(), summary("thread", { type: "thread", parentConversationId: "dm", rootMessageId: "root" })]);
  h.runtime.retain("thread"); await flush();
  const parent = summary();
  h.cache.hydrateConversationDetail(detail({ ...parent, currentMember: { ...parent.currentMember, state: "removed", updatedAt: at(4) } }));
  assert.equal(h.cache.getState().entities.conversations.thread, undefined);
  assert.equal(h.cache.getState().currentUser.readStates.thread, undefined);
  const before = h.requests.length; t.mock.timers.tick(20000); await flush(); assert.equal(h.requests.length, before);
});


test("fresh authorized rediscovery can retain again without an old release cancelling it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(t); const oldRelease = h.runtime.retain("dm"); await flush();
  h.runtime.revoke("dm");
  h.cache.hydrateConversationDetail(detail(summary()));
  h.answer(() => response(detail(summary("dm", { latestSequence: 3, unreadMentionCount: 1 }))));
  const release = h.runtime.retain("dm"); oldRelease(); await flush();
  assert.equal(selectConversationUnreadCount(h.cache.getState(), "dm"), 1);
  const before = h.requests.length; t.mock.timers.tick(5000); await flush(); assert.equal(h.requests.length, before + 1);
  release();
});
