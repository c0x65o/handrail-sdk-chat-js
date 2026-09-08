import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
let compiled = process.env.HANDRAIL_THREAD_LIFECYCLE_BUILD;
if (compiled === undefined) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(`${root}build`, { recursive: true });
  const output = await mkdtemp(`${root}build/thread-lifecycle-test-`);
  after(() => rm(output, { recursive: true, force: true }));
  const check = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc",
    "--project", "tsconfig.client-thread-lifecycle.json", "--outDir", output], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 0, check.error?.message ?? check.stdout + check.stderr);
  compiled = pathToFileURL(output).href;
}
const { createThreadLifecycleRuntime } = await import(`${compiled}/client/thread-lifecycle.js`);
const { createChatCommandDispatcher } = await import(`${compiled}/client/command-dispatcher.js`);
const { createChatSnapshotReader } = await import(`${compiled}/client/snapshot-reader.js`);
const { createChatClient, createNormalizedChatCache, CHAT_CLIENT_PACKAGE_VERSION } = await import(`${compiled}/client/index.js`);
const { CHAT_PROTOCOL_VERSION } = await import(`${compiled}/contracts/realtime.js`);
process.env.NODE_ENV = "test";
const { createElement, act } = await import("react");
const { create } = await import("react-test-renderer");
const { ChatProvider, useThreadLifecycle } = await import(`${compiled}/react/index.js`);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const now = "2030-01-01T00:00:00.000Z";
const tenantId = "tenant", userId = "alice", threadId = "thread", parentId = "parent";
const identity = { tenantId, userId, sessionId: "session-alice" };
const open = revision => ({ revision, locked: false });
const closed = (revision, locked = false) => ({ revision, locked, closedAt: now, closedByUserId: userId });
const metadata = (feature = true) => ({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION, protocolVersion: CHAT_PROTOCOL_VERSION, schemaVersion: 1,
  enabledFeatures: feature === undefined ? {} : { threadLifecycle: feature },
  supportedProtocolRange: { minimumVersion: CHAT_PROTOCOL_VERSION, maximumVersion: CHAT_PROTOCOL_VERSION },
});
const detail = (lifecycle = open(1), overrides = {}) => ({
  kind: "conversation_detail", _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
  conversation: {
    id: threadId, tenantId, type: "thread", visibility: "private", parentConversationId: parentId, rootMessageId: "root",
    createdAt: now, updatedAt: now, activityAt: now, latestSequence: 0, unreadMentionCount: 0,
    activeMemberUserIds: [userId], memberUserIds: [userId],
    currentMember: { tenantId, conversationId: threadId, userId, role: "member", state: "active", joinedAt: now, updatedAt: now },
    currentReadState: { conversationId: threadId, userId, lastReadSequence: 0, updatedAt: now },
    currentPreference: { conversationId: threadId, userId, notificationPreference: "all", isStarred: false, mute: { muted: false }, updatedAt: now },
    ...(lifecycle === null ? {} : { threadLifecycle: lifecycle }), ...overrides,
  },
});
const { parseConversationDetailSnapshot } = await import(`${compiled}/contracts/conversation-snapshot.js`);
parseConversationDetailSnapshot(detail());
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let eventNumber = 0;
const event = (lifecycle, parent = parentId, changed = false) => ({
  eventId: `event-${++eventNumber}`, protocolVersion: CHAT_PROTOCOL_VERSION, tenantId,
  streamId: changed ? parent : threadId, type: changed ? "thread.lifecycle.changed" : "thread.lifecycle.updated",
  occurredAt: now, payload: { threadId, parentConversationId: parent,
    ...(changed ? { revision: lifecycle.revision } : { threadLifecycle: lifecycle }) },
});
function harness({ fetch: override, feature = true, cache = createNormalizedChatCache(identity), actor = userId } = {}) {
  let canonical = open(1), online = true, sequence = 0;
  const requests = [];
  const fetch = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url, method: init.method, body, key: init.headers["idempotency-key"] });
    const result = await override?.(url, init, body);
    if (result !== undefined) return result;
    if (init.method === "GET") {
      const value = detail(canonical);
      value.conversation.currentMember.userId = actor;
      value.conversation.currentReadState.userId = actor;
      value.conversation.currentPreference.userId = actor;
      return response(value);
    }
    throw new Error("unconfigured command");
  };
  const dispatcher = createChatCommandDispatcher({ endpoint: "/chat", getAccessToken: () => "token", fetch,
    options: { retry: { maxAttempts: 1 } } });
  const reader = createChatSnapshotReader({ endpoint: "/chat", getAccessToken: () => "token", fetch,
    options: { retry: { maxAttempts: 1 } } });
  const runtime = createThreadLifecycleRuntime({ cache, reader, dispatch: dispatcher.dispatch,
    enabledFeatures: () => feature === null ? {} : { threadLifecycle: feature }, online: () => online,
    generateIdempotencyKey: () => `lifecycle-${++sequence}` });
  return { runtime, api: runtime.api, cache, requests,
    setCanonical(value) { canonical = value; },
    setOnline(value) { online = value; runtime.connectionChanged(value); },
  };
}
const result = (input, before, after, status = "applied") => ({ ...input, threadId,
  reconciliationStatus: status, previousLifecycle: before, threadLifecycle: after });

test("two sessions reconcile by canonical revision; historical retries keep key and revision", async () => {
  let tries = 0;
  const a = harness({ fetch: (_url, init, body) => {
    if (init.method === "PATCH") {
      if (++tries === 1) throw new Error("offline transport");
      return response(result(body, open(1), closed(2), "replayed"));
    }
  } });
  const b = harness({ cache: createNormalizedChatCache({ ...identity, userId: "bob", sessionId: "session-bob" }), actor: "bob" });
  await a.api.load(threadId, parentId); await b.api.load(threadId, parentId);
  assert.equal((await a.api.close(threadId)).error, "transport");
  for (const h of [a, b]) {
    h.runtime.handleCanonicalEvent(event(closed(4, true)));
    h.runtime.handleCanonicalEvent(event(open(3)));
    assert.equal(h.api.getState(threadId).lifecycle.revision, 4);
  }
  const retried = await a.api.retry(threadId);
  assert.equal(retried.lifecycle.revision, 4);
  assert.equal(retried.result.reconciliationStatus, "replayed");
  const writes = a.requests.filter(r => r.method === "PATCH");
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[1].body.expectedLifecycleRevision, 1);
  a.setCanonical(open(1)); await a.api.load(threadId, parentId);
  assert.equal(a.api.getState(threadId).lifecycle.revision, 4);
});

test("canonical 409 conflicts are distinct from key-reuse and malformed correlation", async () => {
  let mode = "canonical";
  const h = harness({ fetch: (_url, init, body) => {
    if (init.method !== "PATCH") return;
    if (mode === "key") return response({ error: { code: "idempotency_key_reuse", message: "key reuse" } }, 409);
    return response(result({ ...body, ...(mode === "wrong" ? { idempotencyKey: "wrong" } : {}) }, closed(5), closed(5), "lifecycle_conflict"), 409);
  } });
  await h.api.load(threadId, parentId);
  assert.equal((await h.api.close(threadId)).status, "conflict");
  const frozen = h.api.getState(threadId).pendingInput;
  assert.equal((await h.api.retry(threadId)).status, "conflict");
  assert.deepEqual(h.api.getState(threadId).pendingInput, frozen);
  mode = "key"; assert.equal((await h.api.retry(threadId)).error, "conflict");
  mode = "wrong"; assert.equal((await h.api.retry(threadId)).error, "malformed_response");
  assert.equal(h.api.getState(threadId).lifecycle.revision, 5);
});

test("reconnect supersedes late detail reads and ignores a newer event's older snapshot", async () => {
  const old = deferred(); let reads = 0;
  const h = harness({ fetch: (_url, init) => {
    if (init.method === "GET" && ++reads === 1) return old.promise;
  } });
  const first = h.api.load(threadId, parentId); await flush();
  h.setOnline(false); h.setCanonical(open(3)); h.setOnline(true); await flush();
  assert.equal(h.api.getState(threadId).lifecycle.revision, 3);
  old.resolve(response(detail(closed(9)))); await first;
  assert.equal(h.api.getState(threadId).lifecycle.revision, 3);
  h.runtime.handleCanonicalEvent(event(closed(7)));
  await h.api.load(threadId, parentId);
  assert.equal(h.api.getState(threadId).lifecycle.revision, 7);
});

test("events during initial hydration wait for authorization; parent invalidation reads detail", async () => {
  const delayed = deferred(); let reads = 0;
  const h = harness({ fetch: (_url, init) => init.method === "GET" && ++reads === 1 ? delayed.promise : undefined });
  const loading = h.api.load(threadId, parentId); await flush();
  h.runtime.handleCanonicalEvent(event(closed(4)));
  assert.equal(h.api.getState(threadId).lifecycle, undefined);
  delayed.resolve(response(detail(open(1)))); await loading;
  assert.equal(h.api.getState(threadId).lifecycle.revision, 4);
  h.setCanonical(open(6)); h.runtime.handleCanonicalEvent(event(open(6), parentId, true)); await flush();
  assert.equal(h.api.getState(threadId).lifecycle.revision, 6);
  h.runtime.handleCanonicalEvent(event(closed(99), "wrong-parent"));
  h.runtime.handleCanonicalEvent({ ...event(closed(99)), tenantId: "other" });
  assert.equal(h.api.getState(threadId).lifecycle.revision, 6);
});

for (const boundary of ["actor", "session", "parent", "thread", "parent-change"]) {
  test(`${boundary} boundary purges authority and blocks delayed command/detail/event restoration`, async () => {
    const command = deferred(), read = deferred(); let delayRead = false;
    const h = harness({ fetch: (_url, init) => init.method === "PATCH" ? command.promise : delayRead ? read.promise : undefined });
    h.cache.hydrateConversationDetail(detail());
    await h.api.load(threadId, parentId);
    const pendingCommand = h.api.close(threadId); await flush();
    delayRead = true; const pendingRead = h.api.load(threadId, parentId); await flush();
    if (boundary === "actor" || boundary === "session") h.cache.setIdentity({ ...identity,
      ...(boundary === "actor" ? { userId: "other" } : { sessionId: "new-session" }) });
    else if (boundary === "parent-change") h.cache.hydrateConversationDetail(detail(open(2), {
      parentConversationId: "new-parent", updatedAt: "2031-01-01T00:00:00.000Z" }));
    else h.runtime.revoke(boundary === "parent" ? parentId : threadId);
    assert.equal(h.api.getState(threadId).lifecycle, undefined);
    command.resolve(response(result(h.requests.find(r => r.method === "PATCH").body, open(1), closed(2))));
    read.resolve(response(detail(closed(8))));
    await pendingCommand; await pendingRead;
    h.runtime.handleCanonicalEvent(event(closed(99)));
    assert.equal(h.api.getState(threadId).lifecycle, undefined);
    assert.equal(h.api.getState(threadId).pendingInput, undefined);
    if (boundary !== "actor" && boundary !== "session") {
      h.setOnline(false); h.setOnline(true); await flush();
      assert.equal(h.api.getState(threadId).lifecycle, undefined);
      assert.equal(h.cache.getState().entities.conversations[threadId], undefined);
    }
  });
}

test("authorized opening restores denial only across an unchanged access boundary", async () => {
  for (const boundary of ["unchanged", "thread", "parent", "identity", "membership"]) {
    const h = harness();
    h.cache.hydrateConversationDetail(detail());
    await h.api.load(threadId, parentId);
    assert.equal(h.runtime.beginAuthorizedOpening(threadId), undefined);
    h.runtime.revoke(threadId);
    const reconcile = h.runtime.beginAuthorizedOpening(threadId);
    assert.equal(typeof reconcile, "function");
    if (boundary === "thread" || boundary === "parent") h.runtime.revoke(boundary === "thread" ? threadId : parentId);
    if (boundary === "identity") h.cache.setIdentity({ ...identity, sessionId: "other-session" });
    const snapshot = detail(closed(4), { archivedAt: now, archivedByUserId: userId });
    if (boundary === "membership") Object.assign(snapshot.conversation.currentMember, {
      state: "removed", updatedAt: "2030-01-02T00:00:00.000Z",
    });
    h.cache.hydrateConversationDetail(snapshot);
    assert.equal(h.api.getState(threadId).lifecycle, undefined, "cache hydration alone does not grant lifecycle authority");
    reconcile(parentId);
    const state = h.api.getState(threadId);
    if (boundary === "unchanged") {
      assert.equal(state.status, "ready");
      assert.equal(state.error, undefined);
      assert.deepEqual(state.lifecycle, closed(4));
      assert.equal(state.actionsAvailable, false, "archive still prevents lifecycle actions");
    } else {
      assert.equal(state.lifecycle, undefined, `${boundary} boundary rejects late recovery`);
    }
  }
});

test("legacy metadata remains readable without fabricated revision; unsupported/offline actions send nothing", async () => {
  for (const feature of [null, false, true]) {
    const h = harness({ feature });
    await h.api.load(threadId, parentId);
    if (feature === true) h.setOnline(false);
    assert.equal((await h.api.lock(threadId)).error, feature === true ? "offline" : "unsupported");
    assert.equal(h.requests.filter(r => r.method === "PATCH").length, 0);
  }
  const h = harness(); h.setCanonical(null);
  const state = await h.api.load(threadId, parentId);
  assert.equal(state.legacy, true); assert.equal(state.lifecycle, undefined); assert.equal(state.actionsAvailable, false);
  await h.api.close(threadId); assert.equal(h.requests.length, 1);
});

for (const [intent, before, after] of [
  ["close", open(1), closed(2)], ["reopen", closed(2), open(3)],
  ["lock", open(3), closed(4, true)], ["unlock", closed(4, true), closed(5)],
]) {
  test(`explicit ${intent} uses canonical serializer and correlated parsing`, async () => {
    const h = harness({ fetch: (_url, init, body) => init.method === "PATCH" ? response(result(body, before, after)) : undefined });
    h.setCanonical(before); await h.api.load(threadId, parentId);
    const next = await h.api[intent](threadId);
    assert.equal(next.status, "ready"); assert.deepEqual(next.lifecycle, after);
    assert.equal(h.requests.at(-1).url, "/chat/conversations/thread/lifecycle");
    assert.equal(Object.hasOwn(h.requests.at(-1).body, "threadId"), false);
  });
}

const { createApplicationChatStorage } = await import(`${compiled}/client/index.js`);
async function clientFixture(mode = "conflict", realtime) {
  const rows = new Map(), requests = [];
  const cache = createNormalizedChatCache(identity);
  const storage = createApplicationChatStorage({
    read: async (_identity, kind) => rows.get(kind) ?? null,
    replace: async (_identity, kind, encoded) => { rows.set(kind, encoded); },
    remove: async (_identity, kind) => { rows.delete(kind); },
    clearForLogout: async () => { rows.clear(); },
  });
  let canonical = open(1);
  const client = createChatClient({ endpoint: "/chat", cache, getAccessToken: () => "token",
    commands: { retry: { maxAttempts: 1 }, generateIdempotencyKey: () => "lifecycle-key" },
    queries: { retry: { maxAttempts: 1 } },
    drafts: { timer: { schedule: () => 1, cancel() {} } },
    normalizedCachePersistence: { storage, resolveIdentity: () => ({ tenantId, userId, deviceId: "device" }) },
    optimisticMessages: { generateClientMessageId: () => "queued-message", generateIdempotencyKey: () => "queued-key" },
    ...(realtime === undefined ? {} : { realtime }),
    fetch: async (url, init) => {
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      requests.push({ url, method: init.method, body });
      if (url.endsWith("/_meta")) return response(mode === "missing" ? { ...metadata(), enabledFeatures: {} } : metadata(mode !== "unsupported"));
      if (init.method === "GET") return response(detail(canonical));
      if (url.endsWith("/lifecycle") && mode === "conflict") return response(result(body, closed(6), closed(6), "lifecycle_conflict"), 409);
      throw new Error("transport unavailable");
    },
  });
  await client.start();
  cache.hydrateConversationDetail(detail());
  return { client, cache, requests, setCanonical(value) { canonical = value; } };
}

for (const mode of ["conflict", "transport", "unsupported", "missing"]) {
  test(`client and hook preserve draft/queued destination after ${mode}; dismissal sends no lifecycle command`, async () => {
    const f = await clientFixture(mode);
    let rendered, root;
    function Probe() { rendered = useThreadLifecycle(threadId, parentId); return null; }
    try {
      f.client.replaceConversationDraft({ conversationId: threadId, content: { format: "plain", text: "keep draft", attachments: [] } });
      await f.client.sendMessage({ conversationId: threadId, content: { format: "plain", text: "queued send" } });
      const draft = f.client.selectConversationDraft(threadId).draft;
      const queued = f.client.getSendMessageQueueState().intents;
      assert.equal(queued.length, 1); assert.equal(queued[0].conversationId, threadId);
      await act(async () => { root = create(createElement(ChatProvider, { client: f.client }, createElement(Probe))); });
      assert.equal(rendered.lifecycle.revision, 1);
      assert.equal(rendered.actionsAvailable, mode !== "unsupported" && mode !== "missing");
      assert.equal(f.requests.filter(r => r.url.endsWith("/lifecycle")).length, 0);
      await act(async () => { await rendered.actions.close(); });
      assert.equal(rendered.status, mode === "conflict" ? "conflict" : mode === "transport" ? "error" : "unavailable");
      assert.deepEqual(f.client.selectConversationDraft(threadId).draft, draft);
      assert.deepEqual(f.client.getSendMessageQueueState().intents, queued);
      const writes = f.requests.filter(r => r.url.endsWith("/lifecycle")).length;
      await act(async () => root.unmount()); root = undefined;
      assert.equal(f.requests.filter(r => r.url.endsWith("/lifecycle")).length, writes);
      assert.deepEqual(f.client.selectConversationDraft(threadId).draft, draft);
      assert.deepEqual(f.client.getSendMessageQueueState().intents, queued);
    } finally { if (root) await act(async () => root.unmount()); f.client.close(); }
  });
}

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
test("client realtime routes revision events, reconnect hydration, offline retry and revocation", async () => {
  const sockets = [], timers = [];
  const f = await clientFixture("conflict", {
    clock: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} }, random: () => 0.5,
    webSocketFactory() { const s = new Socket(); sockets.push(s); return s; },
  });
  try {
    await flush(); sockets[0].open(); sockets[0].accept(); await flush();
    await f.client.threadLifecycle.load(threadId, parentId);
    assert.ok(sockets[0].sent.some(v => v.type === "chat.subscribe" && v.streamId === threadId));
    sockets[0].receive(event(closed(4, true)));
    sockets[0].receive(event(open(3)));
    assert.equal(f.client.threadLifecycle.getState(threadId).lifecycle.revision, 4);
    f.client.replaceConversationDraft({ conversationId: threadId, content: { format: "plain", text: "offline draft", attachments: [] } });
    await f.client.sendMessage({ conversationId: threadId, content: { format: "plain", text: "queued offline" } });
    const draft = f.client.selectConversationDraft(threadId).draft;
    const queue = f.client.getSendMessageQueueState().intents;
    assert.equal(queue.length, 1);
    sockets[0].disconnect();
    const count = f.requests.filter(r => r.url.endsWith("/lifecycle")).length;
    assert.equal((await f.client.threadLifecycle.unlock(threadId)).error, "offline");
    const original = f.client.threadLifecycle.getState(threadId).pendingInput;
    assert.equal(f.requests.filter(r => r.url.endsWith("/lifecycle")).length, count);
    f.setCanonical(open(7)); timers.shift()(); await flush(); sockets[1].open(); sockets[1].accept(); await flush();
    assert.equal(f.client.threadLifecycle.getState(threadId).lifecycle.revision, 7);
    assert.equal((await f.client.threadLifecycle.retry(threadId)).status, "conflict");
    assert.equal(f.client.threadLifecycle.getState(threadId).lifecycle.revision, 7);
    assert.deepEqual(f.client.threadLifecycle.getState(threadId).pendingInput, original);
    assert.deepEqual(f.client.selectConversationDraft(threadId).draft, draft);
    assert.deepEqual(f.client.getSendMessageQueueState().intents, queue);
    sockets[1].receive({ type: "chat.subscription.revoked", streamId: parentId });
    assert.equal(f.client.threadLifecycle.getState(threadId).lifecycle, undefined);
    sockets[1].receive(event(closed(99)));
    assert.equal(f.client.threadLifecycle.getState(threadId).lifecycle, undefined);
  } finally { f.client.close(); }
});

test("detail denial purges cached history and pending intent; subsequent events cannot restore it", async () => {
  let denied = false;
  const h = harness({ fetch: () => denied ? response({ error: { code: "denied", message: "unavailable" } }, 403) : undefined });
  h.cache.hydrateConversationDetail(detail());
  await h.api.load(threadId, parentId);
  denied = true; await h.api.load(threadId, parentId);
  assert.equal(h.api.getState(threadId).error, "access_revoked");
  assert.equal(h.api.getState(threadId).lifecycle, undefined);
  h.runtime.handleCanonicalEvent(event(closed(50)));
  assert.equal(h.api.getState(threadId).lifecycle, undefined);
  assert.equal(h.cache.getState().entities.conversations[threadId], undefined);
});

test("equal revisions, malformed scope and actor-mismatched detail cannot replace confirmed lifecycle", async () => {
  const h = harness(); await h.api.load(threadId, parentId);
  h.runtime.handleCanonicalEvent(event(closed(2)));
  h.runtime.handleCanonicalEvent(event(open(2)));
  h.runtime.handleCanonicalEvent({ ...event(open(9)), streamId: parentId });
  assert.deepEqual(h.api.getState(threadId).lifecycle, closed(2));
  const wrongActor = harness({ fetch: () => response(detail(open(9), {
    currentMember: { ...detail().conversation.currentMember, userId: "other-actor" },
  })) });
  assert.equal((await wrongActor.api.load(threadId, parentId)).error, "malformed_response");
  assert.equal(wrongActor.api.getState(threadId).lifecycle, undefined);
});

test("active membership generation changes invalidate delayed hydration without conflating unfollow", async () => {
  const read = deferred(), refreshed = deferred(); let reads = 0;
  const h = harness({ fetch: () => ++reads === 1 ? read.promise : refreshed.promise });
  h.cache.hydrateConversationDetail(detail());
  const pending = h.api.load(threadId, parentId); await flush();
  h.cache.hydrateConversationDetail(detail(open(1), {
    currentMember: { ...detail().conversation.currentMember, updatedAt: "2031-01-01T00:00:00.000Z", role: "admin" },
  }));
  read.resolve(response(detail(closed(20)))); await pending;
  assert.equal(h.api.getState(threadId).lifecycle, undefined);
  assert.equal(h.api.getState(threadId).status, "loading");
  refreshed.resolve(response(detail(open(2)))); await flush();
  assert.equal(h.api.getState(threadId).status, "ready");
  assert.deepEqual(h.api.getState(threadId).lifecycle, open(2));
  assert.equal(h.api.getState(threadId).actionsAvailable, true);
});

test("membership refresh after hydration recovers automatically; denial still purges authority", async () => {
  let denied = false;
  const h = harness({ fetch: () => denied ? response({ error: { code: "denied" } }, 403) : undefined });
  h.cache.hydrateConversationDetail(detail());
  await h.api.load(threadId, parentId);
  h.setCanonical(open(2));
  h.cache.hydrateConversationDetail(detail(open(2), {
    currentMember: { ...detail().conversation.currentMember, updatedAt: "2031-01-01T00:00:00.000Z" },
  }));
  await flush();
  assert.equal(h.api.getState(threadId).status, "ready");
  assert.deepEqual(h.api.getState(threadId).lifecycle, open(2));
  assert.equal(h.api.getState(threadId).actionsAvailable, true);
  denied = true;
  h.cache.hydrateConversationDetail(detail(open(2), {
    currentMember: { ...detail().conversation.currentMember, updatedAt: "2032-01-01T00:00:00.000Z" },
  }));
  await flush();
  assert.equal(h.api.getState(threadId).status, "unavailable");
  assert.equal(h.api.getState(threadId).lifecycle, undefined);
  assert.equal(h.api.getState(threadId).actionsAvailable, false);
});
