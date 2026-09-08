import assert from "node:assert/strict";
import test from "node:test";
const compiled = process.env.HANDRAIL_MESSAGE_CONTEXT_BUILD;
assert.ok(compiled, "Run node scripts/test-client-message-context.mjs for fresh production output");
const { createMessageContextRuntime } = await import(`${compiled}/client/message-context.js`);
const { createChatSnapshotReader, createChatClient, createNormalizedChatCache, createApplicationChatStorage, CHAT_CLIENT_PACKAGE_VERSION } = await import(`${compiled}/client/index.js`);
const { CHAT_PROTOCOL_VERSION } = await import(`${compiled}/contracts/realtime.js`);
const now = "2030-01-01T00:00:00.000Z";
const identity = { tenantId: "tenant", userId: "alice", sessionId: "session" };
const target = { conversationId: "thread", messageId: "source" };
const metadata = () => ({ packageVersion: CHAT_CLIENT_PACKAGE_VERSION, protocolVersion: CHAT_PROTOCOL_VERSION, schemaVersion: 1,
  enabledFeatures: {}, supportedProtocolRange: { minimumVersion: CHAT_PROTOCOL_VERSION, maximumVersion: CHAT_PROTOCOL_VERSION } });
const message = (sequence = 50, overrides = {}) => ({ id: sequence === 50 ? "source" : `m${sequence}`, tenantId: identity.tenantId,
  conversationId: target.conversationId, author: { type: "user", userId: "alice" }, sequence, createdAt: now, updatedAt: now,
  revision: { revision: 1 }, content: { format: "plain", text: "Which launch date?" }, ...overrides });
const context = (overrides = {}) => ({ ...target, status: "available", sequence: 50, message: message(), ...overrides });
const page = (sequences, overrides = {}) => ({ conversationId: target.conversationId,
  messages: sequences.map(sequence => ({ ...message(sequence), isThreadRoot: false, reactions: [], attachmentMetadata: [] })),
  pagination: { older: sequences.length ? { available: true, cursor: sequences[0] } : { available: false },
    newer: sequences.length ? { available: true, cursor: sequences.at(-1) } : { available: false } },
  replay: { resumeFrom: { eventId: "snapshot" } }, ...overrides });
const detail = () => ({ kind: "conversation_detail", _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
  conversation: { id: "thread", tenantId: "tenant", type: "thread", visibility: "private", parentConversationId: "parent", rootMessageId: "root",
    createdAt: now, updatedAt: now, activityAt: now, latestSequence: 1000, unreadMentionCount: 0,
    activeMemberUserIds: ["alice"], memberUserIds: ["alice"],
    currentMember: { tenantId: "tenant", conversationId: "thread", userId: "alice", role: "member", state: "active", joinedAt: now, updatedAt: now },
    currentReadState: { conversationId: "thread", userId: "alice", lastReadSequence: 0, updatedAt: now },
    currentPreference: { conversationId: "thread", userId: "alice", notificationPreference: "all", isStarred: false, mute: { muted: false }, updatedAt: now },
  } });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const channelTarget = { conversationId: "channel", messageId: "source" };
const channelPage = sequences => ({ ...page(sequences), conversationId: "channel",
  messages: page(sequences).messages.map(m => ({ ...m, conversationId: "channel" })) });
const channelContext = () => ({ ...context(), ...channelTarget, message: { ...message(), conversationId: "channel" } });
const namedThread = () => {
  const conversation = detail();
  Object.assign(conversation.conversation, { parentConversationId: "channel", rootMessageId: "source",
    name: "Launch date decision", currentThreadFollow: { followRevision: 0, follow: null } });
  return { operation: "create_thread", reconciliationStatus: "created", parentConversationId: "channel",
    rootMessageId: "source", conversation,
    rootThreadSummary: { threadId: "thread", replyCount: 0, participantIds: [], unreadCount: 0 } };
};
const reconcileNamedThread = cache => cache.reconcileThreadOpening({ operation: "create_thread",
  parentConversationId: "channel", rootMessageId: "source", name: "Launch date decision", idempotencyKey: "create-key" },
  namedThread(), page([]));
const assertCanonicalRoot = cache => {
  assert.equal(cache.getState().timelines.channel.messageIds.filter(id => id === "source").length, 1);
  assert.deepEqual(cache.getState().entities.messages.source.threadSummary, namedThread().rootThreadSummary);
};
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
let eventId = 0;
const event = (deleted = false, id = "source") => ({ type: deleted ? "message.deleted" : "message.updated", eventId: `event-${++eventId}`,
  protocolVersion: CHAT_PROTOCOL_VERSION, tenantId: "tenant", streamId: "thread", occurredAt: now,
  payload: { message: message(id === "source" ? 50 : 51, { revision: { revision: 2 }, ...(deleted ? { content: null, deletedAt: now, deletedByUserId: "alice" } :
    { content: { format: "plain", text: "edited source" }, revision: { revision: 2, editedAt: now, editedByUserId: "alice" } }) }) } });
function harness(override, config = {}) {
  const cache = createNormalizedChatCache(identity), requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, ...init });
    const result = await override?.(url, init);
    if (result !== undefined) return result;
    if (url.endsWith("/_meta")) return response(metadata());
    if (url.endsWith("/context")) return response(context());
    if (url.includes("before=50")) return response(page([48, 49]));
    if (url.includes("after=50")) return response(page([51, 52]));
    if (url.endsWith("/thread")) return response(detail());
    throw new Error("Unconfigured transport");
  };
  let online = true;
  const reader = createChatSnapshotReader({ endpoint: "/chat", getAccessToken: () => "token", fetch });
  const runtime = createMessageContextRuntime({ cache, reader, online: () => online });
  return { cache, requests, fetch, reader, runtime, api: runtime.api, setOnline(value) { online = value; runtime.connectionChanged(value); }, ...config };
}

test("old source resolves with one shared lookup and two bounded exclusive pages; jump keeps outer cursors", async () => {
  const gate = deferred();
  const h = harness(url => url.endsWith("/context") ? gate.promise : undefined);
  h.cache.hydrateMessageTimeline(page([998, 999, 1000], { pagination: { older: { available: true, cursor: 998 }, newer: { available: false } } }));
  const states = []; const release = h.api.subscribe(target, () => states.push(h.api.getState(target).status));
  const first = h.api.resolve(target), second = h.api.resolve({ ...target });
  assert.equal(first, second);
  const window = h.api.loadSourceWindow(target);
  assert.equal(window, h.api.loadSourceWindow(target));
  await flush(); assert.equal(h.requests.length, 1);
  gate.resolve(response(context()));
  const result = await window;
  assert.equal(result.status, "available");
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests.slice(1).map(r => r.url).sort(), ["/chat/conversations/thread/messages?after=50&limit=25", "/chat/conversations/thread/messages?before=50&limit=25"]);
  assert.deepEqual(result.window.messages.map(m => m.sequence), [48,49,50,51,52]);
  assert.deepEqual(h.cache.getState().timelines.thread.messageIds, ["m48","m49","source","m51","m52"]);
  assert.deepEqual(h.cache.getState().timelines.thread.pagination, { older: { available: true, cursor: 48 }, newer: { available: true, cursor: 52 } });
  assert.ok(h.cache.getState().entities.messages.m1000, "other canonical entities remain cached");
  assert.ok(states.includes("loading") && states.includes("loading_window") && states.includes("available"));
  assert.ok(h.requests.every(r => r.method === "GET" && r.headers.authorization === "Bearer token"));
  release();
});

for (const phase of ["context", "page"]) for (const mutation of ["edit", "delete", "neighbour", "revoke", "actor", "tenant", "close", "disconnect"]) {
  test(`${mutation} invalidates a late ${phase} response before hydration`, async () => {
    const gate = deferred();
    const h = harness(url => (phase === "context" ? url.endsWith("/context") : url.includes("/messages?")) ? gate.promise : undefined);
    h.cache.hydrateConversationDetail(detail());
    const pending = h.api.loadSourceWindow(target); await flush();
    if (mutation === "revoke") h.runtime.revoke("parent");
    else if (mutation === "actor") h.cache.setIdentity({ ...identity, userId: "bob", sessionId: "bob-session" });
    else if (mutation === "tenant") h.cache.setIdentity({ ...identity, tenantId: "other" });
    else if (mutation === "close") h.runtime.closeActive();
    else if (mutation === "disconnect") h.setOnline(false);
    else h.runtime.handleCanonicalEvent(event(mutation === "delete", mutation === "neighbour" ? "m51" : "source"));
    gate.resolve(response(phase === "context" ? context() : page([49])));
    await pending; await flush();
    assert.equal(h.api.getState(target).result, undefined);
    assert.equal(h.api.getState(target).window, undefined);
    assert.equal(h.cache.getState().entities.messages.source, undefined);
    assert.equal(h.cache.getState().entities.messages.m49, undefined);
  });
}

for (const status of ["deleted", "unavailable"]) test(`${status} is redacted and loads no surrounding pages`, async () => {
  const value = status === "unavailable" ? { ...target, status } : context({ status, message: message(50, { content: null, deletedAt: now, deletedByUserId: "alice" }) });
  const h = harness(() => response(value));
  h.cache.hydrateMessageTimeline(page([50]));
  const result = await h.api.loadSourceWindow(target);
  assert.equal(result.status, status); assert.equal(result.window, undefined);
  assert.equal(h.requests.length, 1); assert.equal(h.cache.getState().entities.messages.source, undefined);
  assert.ok(!JSON.stringify(result).includes("Which launch"));
});

for (const [name, reply, expected] of [
  ["network", () => { throw new Error("secret transport error"); }, "transport"],
  ["401", () => response({}, 401), "authentication"], ["403", () => response({}, 403), "authentication"],
  ["404", () => response({}, 404), "rejected"], ["503", () => response({}, 503), "transport"],
  ["malformed", () => response({ ...target, status: "unavailable", reason: "secret" }), "malformed_response"],
  ["identity mismatch", () => response(context({ messageId: "other" })), "malformed_response"],
  ["foreign tenant", () => response(context({ message: message(50, { tenantId: "other" }) })), "malformed_response"],
  ["non-200 success", () => response({ ...target, status: "unavailable" }, 201), "malformed_response"],
]) test(`${name} stays an error and retry retains target`, async () => {
  let failed = true;
  const h = harness(url => url.endsWith("/context") && failed ? reply() : undefined);
  const result = await h.api.resolve(target);
  assert.equal(result.status, "error"); assert.equal(result.error, expected); assert.equal(result.result, undefined);
  assert.ok(!JSON.stringify(result).includes("secret"));
  failed = false; assert.equal((await h.api.retry(target)).status, "available");
  assert.ok(h.requests.every(r => r.url === "/chat/conversations/thread/messages/source/context"));
});

test("window failure is atomic; retry repeats lookup and preserves the original target", async () => {
  let failure = true;
  const h = harness(url => url.includes("after=") && failure ? response({}, 503) : undefined);
  assert.equal((await h.api.loadSourceWindow(target)).error, "transport");
  assert.equal(h.cache.getState().entities.messages.m49, undefined);
  failure = false;
  assert.equal((await h.api.retry(target)).window.messages.length, 5);
  assert.equal(h.requests.filter(r => r.url.endsWith("/context")).length, 2);
});

test("cached windows invalidate on edits/reconnect and purge on deletion, access loss and actor/tenant switches", async () => {
  for (const boundary of ["reconnect", "edit", "delete", "revoke", "actor", "tenant"]) {
    const h = harness(); h.cache.hydrateConversationDetail(detail());
    await h.api.loadSourceWindow(target);
    if (boundary === "reconnect") h.setOnline(false);
    else if (boundary === "revoke") h.runtime.revoke("parent");
    else if (boundary === "actor") h.cache.setIdentity({ ...identity, userId: "bob" });
    else if (boundary === "tenant") h.cache.setIdentity({ ...identity, tenantId: "other" });
    else h.runtime.handleCanonicalEvent(event(boundary === "delete"));
    assert.equal(h.api.getState(target).result, undefined, boundary);
    if (boundary === "edit" || boundary === "reconnect") assert.ok(h.cache.getState().entities.messages.source, "revalidation cancels context without evicting authorized canonical data");
    else assert.equal(h.cache.getState().entities.messages.source, undefined, boundary);
    if (boundary === "reconnect") { h.setOnline(true); await flush(); assert.equal(h.api.getState(target).window.messages.length, 5); }
  }
});

class Socket {
  readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  accept() { this.receive({ type: "chat.session.accepted", metadata: metadata(), tenantId: "tenant", actorStreamId: "user:alice", deviceId: "device", sessionId: "session" }); }
  disconnect() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" }); }
  close() { this.readyState = 3; }
}
async function clientFixture(override) {
  const h = harness(override), sockets = [], timers = [], rows = new Map();
  const storage = createApplicationChatStorage({ read: async (_id, kind) => rows.get(kind) ?? null,
    replace: async (_id, kind, value) => { rows.set(kind, value); }, remove: async (_id, kind) => { rows.delete(kind); }, clearForLogout: async () => rows.clear() });
  const client = createChatClient({ endpoint: "/chat", cache: h.cache, getAccessToken: () => "token", fetch: h.fetch,
    commands: { retry: { maxAttempts: 1 } }, drafts: { timer: { schedule: () => 1, cancel() {} } },
    normalizedCachePersistence: { storage, resolveIdentity: () => ({ tenantId: "tenant", userId: "alice", deviceId: "device" }) },
    optimisticMessages: { generateClientMessageId: () => "queued", generateIdempotencyKey: () => "queued-key" },
    realtime: { clock: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} }, random: () => 0.5,
      webSocketFactory() { const socket = new Socket(); sockets.push(socket); return socket; } },
  });
  await client.start(); await flush(); sockets[0].open(); sockets[0].accept(); await flush();
  h.cache.hydrateConversationDetail(detail());
  return { ...h, client, sockets, timers };
}

test("client routes canonical mutations, reconnect, revocation and close; queued reply and draft stay in the thread", async () => {
  let source = message();
  const h = await clientFixture(url => url.endsWith("/context") ? response(context({ message: source })) : undefined);
  try {
    const api = h.client.messageContext;
    h.client.replaceConversationDraft({ conversationId: "thread", content: { format: "plain", text: "Friday", attachments: [], replyTo: { messageId: "source", notifyAuthor: false } } });
    await h.client.sendMessage({ conversationId: "thread", content: { format: "plain", text: "Friday" }, replyTo: { messageId: "source", notifyAuthor: false } });
    const draft = h.client.selectConversationDraft("thread").draft;
    const queue = h.client.getSendMessageQueueState().intents;
    assert.equal(queue.length, 1); assert.equal(queue[0].conversationId, "thread");
    await api.loadSourceWindow(target);
    assert.ok(h.sockets[0].sent.some(v => v.type === "chat.subscribe" && v.streamId === "thread"));
    const edited = event(); source = edited.payload.message;
    h.cache.hydrateMessageTimeline({ ...page([50]), messages: [{ ...page([50]).messages[0], ...source }] });
    assert.equal(api.getState(target).result, undefined);
    assert.equal(h.cache.getState().entities.messages.source.content.text, "edited source");
    assert.deepEqual(h.client.getSendMessageQueueState().intents, queue);
    assert.deepEqual(h.client.selectConversationDraft("thread").draft, draft);
    h.sockets[0].receive(edited); assert.equal(api.getState(target).result, undefined);
    await api.retry(target);
    h.sockets[0].disconnect(); assert.equal(api.getState(target).result, undefined);
    h.timers.shift()(); await flush(); h.sockets[1].open(); h.sockets[1].accept(); await flush();
    assert.equal(api.getState(target).status, "available", JSON.stringify(api.getState(target)));
    assert.equal(api.getState(target).window.messages.length, 5);
    assert.deepEqual(h.client.getSendMessageQueueState().intents, queue);
    assert.deepEqual(h.client.selectConversationDraft("thread").draft, draft);
    h.sockets[1].receive({ type: "chat.subscription.revoked", streamId: "parent" });
    assert.equal(api.getState(target).result, undefined);
    assert.equal(api.getState(target).error, "access_revoked");
    assert.equal(h.cache.getState().entities.messages.source, undefined);
    assert.deepEqual(h.client.getSendMessageQueueState().intents, queue);
    assert.ok(!h.requests.some(r => /\/threads(?:\?|$)|\/thread$/.test(r.url) && r.method !== "GET"));
    assert.ok(h.requests.filter(r => r.url.endsWith("/context")).every(r => r.url === "/chat/conversations/thread/messages/source/context"));
  } finally { h.client.close(); }
  assert.equal(h.client.messageContext.getState(target).result, undefined);
});

for (const phase of ["context", "page"]) test(`client revocation and deletion block late ${phase} responses`, async () => {
  for (const mutation of ["delete", "revoke"]) {
    const gate = deferred();
    const h = await clientFixture(url => (phase === "context" ? url.endsWith("/context") : url.includes("/messages?")) ? gate.promise : undefined);
    try {
      const pending = h.client.messageContext.loadSourceWindow(target); await flush();
      h.sockets[0].receive(mutation === "delete" ? event(true) : { type: "chat.subscription.revoked", streamId: "parent" });
      gate.resolve(response(phase === "context" ? context() : page([49])));
      await pending; await flush();
      assert.equal(h.client.messageContext.getState(target).result, undefined);
      assert.notEqual(h.cache.getState().entities.messages.source?.content?.text, "Which launch date?");
      assert.equal(h.cache.getState().entities.messages.m49, undefined);
    } finally { h.client.close(); }
  }
});

test("a newer source navigation supersedes a delayed window in the same conversation", async () => {
  const gate = deferred();
  const nextTarget = { ...target, messageId: "m80" };
  const h = harness(url => {
    if (url.includes("before=50")) return gate.promise;
    if (url.includes("/m80/context")) return response({ ...nextTarget, status: "available", sequence: 80, message: message(80) });
    if (url.includes("before=80")) return response(page([79]));
    if (url.includes("after=80")) return response(page([81]));
  });
  const old = h.api.loadSourceWindow(target); await flush();
  const next = await h.api.loadSourceWindow(nextTarget);
  assert.deepEqual(next.window.messages.map(m => m.sequence), [79,80,81]);
  gate.resolve(response(page([49]))); await old;
  assert.deepEqual(h.cache.getState().timelines.thread.messageIds, ["m79","m80","m81"]);
  assert.equal(h.api.getState(target).window, undefined);
});

test("an available response cannot supersede an already cached deletion or newer revision", async () => {
  for (const overrides of [{ revision: { revision: 3 } }, { deletedAt: now, deletedByUserId: "alice", content: null }]) {
    const h = harness(); const cached = page([50]);
    cached.messages[0] = { ...cached.messages[0], ...overrides };
    h.cache.hydrateMessageTimeline(cached);
    assert.equal((await h.api.resolve(target)).error, "stale_source");
    assert.equal(h.api.getState(target).result, undefined);
  }
});

test("attachment sources load exactly one enrichment row and keep the separately resolved source once", async () => {
  const source = message(50, { content: { format: "plain", text: "attachment", attachments: [{ attachmentId: "attachment" }] } });
  const metadata = { attachmentId: "attachment", fileName: "file.txt", contentType: "text/plain", sizeBytes: 12, downloadUrl: "https://example.test/file" };
  const h = harness(url => {
    if (url.endsWith("/context")) return response(context({ message: source }));
    if (url.includes("after=49&limit=1")) return response({ ...page([50]), messages: [{ ...source, isThreadRoot: false, reactions: [], attachmentMetadata: [metadata] }] });
  });
  const result = await h.api.loadSourceWindow(target);
  assert.equal(result.status, "available");
  assert.equal(h.requests.length, 4);
  assert.equal(result.window.messages.filter(m => m.id === "source").length, 1);
  assert.deepEqual(h.cache.getState().entities.messages.source.attachmentMetadata, [metadata]);
});

test("actor and tenant changes reauthenticate the same target without reusing previous results", async () => {
  let tenantId = "tenant", text = "Alice source";
  const h = harness(url => url.endsWith("/context") ? response(context({ message: message(50, { tenantId, content: { format: "plain", text } }) })) : undefined);
  assert.equal((await h.api.resolve(target)).result.message.content.text, "Alice source");
  text = "Bob source"; h.cache.setIdentity({ ...identity, userId: "bob", sessionId: "bob" });
  assert.equal(h.api.getState(target).result, undefined);
  assert.equal((await h.api.resolve(target)).result.message.content.text, "Bob source");
  tenantId = "tenant2"; text = "Tenant 2 source"; h.cache.setIdentity({ ...identity, tenantId });
  assert.equal((await h.api.resolve(target)).result.message.content.text, "Tenant 2 source");
  assert.equal(h.requests.length, 3);
});

test("revocation purges a resolved source that was previously loaded by the ordinary timeline", async () => {
  const h = harness(); h.cache.hydrateConversationDetail(detail()); h.cache.hydrateMessageTimeline(page([50]));
  await h.api.resolve(target); h.runtime.revoke("parent");
  assert.equal(h.cache.getState().entities.messages.source, undefined);
  assert.equal(h.api.getState(target).result, undefined);
});

for (const issue of ["duplicate ID", "foreign tenant", "wrong cursor", "malformed"]) test(`invalid window ${issue} remains an error without partial hydration`, async () => {
  const bad = page([49]);
  if (issue === "duplicate ID") bad.messages[0].id = "source";
  if (issue === "foreign tenant") bad.messages[0].tenantId = "foreign";
  if (issue === "wrong cursor") { bad.messages[0].sequence = 50; }
  if (issue === "malformed") { bad.messages[0].content = null; }
  const h = harness(url => url.includes("before=") ? response(bad) : undefined);
  assert.equal((await h.api.loadSourceWindow(target)).error, "malformed_response");
  assert.equal(h.cache.getState().entities.messages.source, undefined);
  assert.equal(h.cache.getState().entities.messages.m51, undefined);
});

test("deletion during attachment enrichment cancels the final hydration", async () => {
  const gate = deferred();
  const source = message(50, { content: { format: "plain", text: "file", attachments: [{ attachmentId: "attachment" }] } });
  const h = harness(url => {
    if (url.endsWith("/context")) return response(context({ message: source }));
    if (url.includes("after=49&limit=1")) return gate.promise;
  });
  const work = h.api.loadSourceWindow(target); await flush();
  h.runtime.handleCanonicalEvent(event(true));
  gate.resolve(response(page([50]))); await work;
  assert.equal(h.cache.getState().entities.messages.source, undefined);
  assert.equal(h.api.getState(target).window, undefined);
});

test("timeline authentication failure purges cached source while remaining an error", async () => {
  const h = harness(url => url.includes("after=") ? response({}, 403) : undefined);
  h.cache.hydrateMessageTimeline(page([50]));
  const result = await h.api.loadSourceWindow(target);
  assert.equal(result.status, "error"); assert.equal(result.error, "authentication");
  assert.equal(result.result, undefined);
  assert.equal(h.cache.getState().entities.messages.source, undefined);
});

for (const loadedWindow of [false, true]) test(`named creation retains an ordinary channel root after ${loadedWindow ? "window loading" : "inline source resolution"}`, async () => {
  const canonical = namedThread();
  const h = harness((url, init) => {
    if (url.endsWith("/context")) return response(channelContext());
    if (init.method === "POST") return response(canonical, 201);
    if (url.endsWith("/conversations/thread")) return response(canonical.conversation);
    if (url.includes("/channel/messages?")) return response(channelPage(url.includes("before=") ? [49] : [51]));
    if (url.includes("/thread/messages?")) return response(page([]));
  });
  const client = createChatClient({ endpoint: "/chat", cache: h.cache, getAccessToken: () => "token", fetch: h.fetch });
  try {
    await client.start();
    h.cache.hydrateMessageTimeline(channelPage([49, 50, 51]));
    const api = client.messageContext;
    assert.equal((await (loadedWindow ? api.loadSourceWindow(channelTarget) : api.resolve(channelTarget))).status, "available");
    assert.equal(h.requests.filter(r => r.method === "POST").length, 0, "inline source context creates no thread");
    const ready = await client.createThread({ rootMessageId: "source", name: "Launch date decision" });
    assert.equal(ready.state, "ready");
    assertCanonicalRoot(h.cache);
    assert.equal(api.getState(channelTarget).result, undefined);
    assert.equal(api.getState(channelTarget).window, undefined);
    assert.equal(h.cache.getState().entities.conversations.thread.name, "Launch date decision");
    assert.equal(await client.openThread("source"), ready, "legacy opening reuses the canonical named thread");
    assert.equal(h.requests.filter(r => r.method === "POST").length, 1);
  } finally { client.close(); }
});

for (const phase of ["context", "page"]) test(`canonical refresh cancels a delayed ${phase} without evicting the root or admitting stale windows`, async () => {
  const gate = deferred();
  const h = harness(url => {
    if (phase === "context" && url.endsWith("/context")) return gate.promise;
    if (phase === "page" && url.includes("/messages?")) return gate.promise;
    if (url.endsWith("/context")) return response(channelContext());
  });
  h.cache.hydrateMessageTimeline(channelPage([50, 1000]));
  const pending = h.api.loadSourceWindow(channelTarget); await flush();
  reconcileNamedThread(h.cache);
  assertCanonicalRoot(h.cache);
  gate.resolve(response(phase === "context" ? channelContext() : channelPage([49])));
  await pending;
  assertCanonicalRoot(h.cache);
  assert.deepEqual(h.cache.getState().timelines.channel.messageIds, ["source", "m1000"]);
  assert.equal(h.cache.getState().entities.messages.m49, undefined);
  assert.equal(h.api.getState(channelTarget).result, undefined);
  assert.equal(h.api.getState(channelTarget).window, undefined);
  assert.ok(h.requests.filter(r => phase === "context" ? r.url.endsWith("/context") : r.url.includes("/messages?")).every(r => r.signal.aborted));
});

for (const boundary of ["deleted", "unavailable", "authentication", "revoke", "actor", "tenant", "cache deletion"]) {
  test(`${boundary} still purges retained source/window content after named-thread refresh`, async () => {
    let denial;
    const h = harness(url => {
      if (url.endsWith("/context")) return denial ?? response(channelContext());
      if (url.includes("/messages?")) return response(channelPage(url.includes("before=") ? [49] : [51]));
    });
    h.cache.hydrateMessageTimeline(channelPage([50]));
    await h.api.loadSourceWindow(channelTarget);
    reconcileNamedThread(h.cache);
    assertCanonicalRoot(h.cache);
    assert.ok(h.cache.getState().entities.messages.m49);
    if (boundary === "revoke") h.runtime.revoke("channel");
    else if (boundary === "actor") h.cache.setIdentity({ ...identity, userId: "bob" });
    else if (boundary === "tenant") h.cache.setIdentity({ ...identity, tenantId: "other" });
    else if (boundary === "cache deletion") h.cache.hydrateMessageTimeline({ ...channelPage([50]), messages: [
      { ...channelPage([50]).messages[0], revision: { revision: 2 }, content: null, deletedAt: now, deletedByUserId: "alice" },
    ] });
    else {
      denial = boundary === "authentication" ? response({}, 403) : response(boundary === "unavailable" ?
        { ...channelTarget, status: "unavailable" } : { ...channelContext(), status: "deleted",
          message: { ...channelContext().message, content: null, deletedAt: now, deletedByUserId: "alice" } });
      const result = await h.api.retry(channelTarget);
      assert.equal(result.status, boundary === "authentication" ? "error" : boundary);
      if (boundary === "authentication") assert.equal(result.error, "authentication");
    }
    assert.equal(h.api.getState(channelTarget).window, undefined);
    assert.ok(!JSON.stringify(h.api.getState(channelTarget)).includes("Which launch"));
    for (const id of ["source", "m49", "m51"]) assert.equal(h.cache.getState().entities.messages[id], undefined, id);
  });
}

test("parent revocation purges all historical windows after harmless refresh and reload", async () => {
  let sequences = [48, 49];
  const h = harness(url => url.includes("before=") ? response(page(sequences)) : undefined);
  h.cache.hydrateConversationDetail(detail());
  await h.api.loadSourceWindow(target);
  const refreshed = detail(); refreshed.conversation.currentMember.updatedAt = "2030-01-02T00:00:00.000Z";
  h.cache.hydrateConversationDetail(refreshed);
  assert.equal(h.api.getState(target).window, undefined);
  assert.ok(h.cache.getState().entities.messages.source);
  sequences = [49];
  await h.api.loadSourceWindow(target);
  assert.ok(h.cache.getState().entities.messages.m48, "previous authorized window entities remain canonical");
  h.runtime.revoke("parent");
  assert.equal(h.api.getState(target).error, "access_revoked");
  for (const id of ["source", "m48", "m49", "m51", "m52"]) assert.equal(h.cache.getState().entities.messages[id], undefined, id);
});

test("an older lookup after canonical edit cannot purge the refreshed source", async () => {
  const h = harness(); h.cache.hydrateMessageTimeline(page([50]));
  await h.api.resolve(target);
  const refreshed = { ...page([50]), messages: [{ ...page([50]).messages[0], revision: { revision: 2 },
    content: { format: "plain", text: "Newer source" } }] };
  h.cache.hydrateMessageTimeline(refreshed);
  assert.equal((await h.api.retry(target)).error, "stale_source");
  assert.equal(h.cache.getState().entities.messages.source.content.text, "Newer source");
  h.runtime.revoke(target.conversationId);
  assert.equal(h.cache.getState().entities.messages.source, undefined);
});

test("actor switch, remote thread summaries and reconnect retain the channel source and entry point", async () => {
  const h = await clientFixture(url => url.endsWith("/context") ? response(channelContext()) : undefined);
  try {
    // Bob's private state must be discarded before Alice loads authorized history.
    h.cache.setIdentity({ ...identity, userId: "bob", sessionId: "bob-session" });
    h.cache.hydrateMessageTimeline(channelPage([50]));
    h.cache.setIdentity(identity);
    assert.equal(h.cache.getState().entities.messages.source, undefined);
    const history = channelPage([50, 51, 52]);
    history.messages = history.messages.map(m => m.id === "source" ? m : {
      ...m, author: { type: "user", userId: "bob" }, content: { format: "plain", text: "Friday" },
      replyTo: { messageId: "source", notifyAuthor: false },
    });
    h.cache.hydrateMessageTimeline(history);
    await h.client.messageContext.resolve(channelTarget);
    const summary = namedThread().rootThreadSummary;
    const remoteSummary = replyCount => ({ type: "message.thread_summary.updated", eventId: `remote-summary-${replyCount}`,
      protocolVersion: CHAT_PROTOCOL_VERSION, tenantId: "tenant", streamId: "channel", occurredAt: now,
      payload: { parentConversationId: "channel", rootMessageId: "source",
        rootThreadSummary: { ...summary, replyCount } } });
    h.sockets[0].receive(remoteSummary(0));
    assertCanonicalRoot(h.cache);
    await h.client.messageContext.resolve(channelTarget);

    h.sockets[0].disconnect();
    assert.equal(h.client.messageContext.getState(channelTarget).error, "offline");
    assertCanonicalRoot(h.cache);
    h.timers.shift()(); await flush(); h.sockets[1].open(); h.sockets[1].accept(); await flush();
    assert.equal(h.client.messageContext.getState(channelTarget).status, "available");
    assertCanonicalRoot(h.cache);
    h.sockets[1].receive(remoteSummary(1));
    assert.deepEqual(h.cache.getState().timelines.channel.messageIds, ["source", "m51", "m52"]);
    assert.equal(h.cache.getState().entities.messages.source.threadSummary.replyCount, 1);
    assert.equal(h.cache.getState().entities.messages.source.threadSummary.threadId, "thread");
    assert.equal(h.requests.filter(r => r.url.includes("/messages?")).length, 0,
      "retention needs neither jump-to-original nor a replacement timeline fetch");
  } finally { h.client.close(); }
});

for (const loadedWindow of [false, true]) for (const failure of ["offline", "transport"]) {
  test(`${failure} revalidation retains the ${loadedWindow ? "source window" : "inline source"} until access is revoked`, async () => {
    let transportFailure = false;
    const h = harness(url => {
      if (transportFailure) throw new Error("temporary network failure");
      if (url.endsWith("/context")) return response(channelContext());
      if (url.includes("/messages?")) return response(channelPage(url.includes("before=") ? [49] : [51]));
    });
    h.cache.hydrateMessageTimeline(channelPage([50]));
    await (loadedWindow ? h.api.loadSourceWindow(channelTarget) : h.api.resolve(channelTarget));
    reconcileNamedThread(h.cache);
    if (failure === "offline") h.setOnline(false);
    else transportFailure = true;
    assert.equal((await h.api.retry(channelTarget)).error, failure);
    assertCanonicalRoot(h.cache);
    assert.equal(h.api.getState(channelTarget).result, undefined);
    assert.equal(h.api.getState(channelTarget).window, undefined);
    if (loadedWindow) assert.ok(h.cache.getState().entities.messages.m49);
    h.runtime.revoke("channel");
    for (const id of ["source", "m49", "m51"]) assert.equal(h.cache.getState().entities.messages[id], undefined);
  });
}
