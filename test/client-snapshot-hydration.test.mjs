import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createNormalizedChatCache,
  encodeConversationSnapshotCursor,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-client";
const userId = "user-client";
const identity = { tenantId, userId, sessionId: "session-client" };
const snapshotMetadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { conversation_snapshots: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
};

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() {
    return body;
  },
  ...overrides,
});

function summary(id, overrides = {}) {
  return {
    id,
    tenantId,
    type: "channel",
    visibility: "public",
    name: `Conversation ${id}`,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:05:00.000Z",
    latestSequence: 4,
    activityAt: "2030-01-01T00:05:00.000Z",
    unreadMentionCount: 0,
    activeMemberUserIds: [userId, "user-other"],
    currentMember: {
      tenantId,
      conversationId: id,
      userId,
      role: "member",
      state: "active",
      joinedAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:05:00.000Z",
    },
    currentReadState: {
      conversationId: id,
      userId,
      lastReadSequence: 2,
      updatedAt: "2030-01-01T00:05:00.000Z",
    },
    currentPreference: {
      conversationId: id,
      userId,
      isStarred: false,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: "2030-01-01T00:05:00.000Z",
    },
    ...overrides,
  };
}

const listSnapshot = (scope, items, nextCursor) => ({
  kind: "conversation_list",
  scope,
  items: items.map((item) => ({ ...item, hasActiveHuddle: false })),
  page: nextCursor === undefined ? {} : { nextCursor },
  _meta: snapshotMetadata,
});

const detailSnapshot = (item) => ({
  kind: "conversation_detail",
  conversation: {
    ...item,
    memberUserIds: [userId, "user-other"],
  },
  _meta: snapshotMetadata,
});

function message(conversationId, sequence) {
  return {
    id: `${conversationId}-message-${sequence}`,
    tenantId,
    conversationId,
    author: { type: "user", userId: "user-other" },
    sequence,
    createdAt: `2030-01-01T00:0${sequence}:00.000Z`,
    updatedAt: `2030-01-01T00:0${sequence}:00.000Z`,
    revision: { revision: 1 },
    content: { format: "plain", text: `message ${sequence}` },
    isThreadRoot: false,
    reactions: [],
    attachmentMetadata: [],
  };
}

const timeline = (conversationId, messages, pagination, eventId) => ({
  conversationId,
  messages,
  pagination,
  replay: { resumeFrom: { eventId } },
});

test("hydrates organization/entity lists and detail snapshots with canonical encoded URLs", async () => {
  const cache = createNormalizedChatCache(identity);
  const cursor = encodeConversationSnapshotCursor({
    isStarred: false,
    navigationRank: 1,
    activityAt: "2030-01-01T00:05:00.000Z",
    conversationId: "conversation-parent",
  });
  const requests = [];
  const organization = listSnapshot(
    { type: "organization" },
    [summary("conversation-parent")],
    cursor,
  );
  const organizationNext = listSnapshot(
    { type: "organization" },
    [summary("conversation-next")],
  );
  const entityScope = { type: "entity", entity: { type: "sales/order", id: "42 & 7" } };
  const entity = listSnapshot(entityScope, [summary("conversation-entity")]);
  const detail = detailSnapshot(summary("conversation-parent"));
  const bodies = [organization, organizationNext, entity, detail];
  const client = createChatClient({
    endpoint: "/api/chat/",
    cache,
    getAccessToken: () => "snapshot-secret",
    async fetch(url, init) {
      requests.push({ url, init });
      return response(bodies.shift());
    },
  });

  const organizationResult = await client.listConversations({
    scope: { type: "organization" },
    limit: 25,
  });
  const nextResult = await client.listConversations({
    scope: { type: "organization" },
    cursor,
    limit: 25,
  });
  const entityResult = await client.listConversations({ scope: entityScope });
  const detailResult = await client.getConversation({
    conversationId: "conversation-parent",
  });

  assert.equal(organizationResult.status, "success");
  assert.equal(nextResult.status, "success");
  assert.equal(entityResult.status, "success");
  assert.equal(detailResult.status, "success");
  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/chat/conversations?scope=organization&limit=25",
    `/api/chat/conversations?scope=organization&cursor=${encodeURIComponent(cursor)}&limit=25`,
    "/api/chat/conversations?scope=entity&entityType=sales%2Forder&entityId=42+%26+7",
    "/api/chat/conversations/conversation-parent",
  ]);
  for (const { init } of requests) {
    assert.deepEqual(init.headers, {
      accept: "application/json",
      authorization: "Bearer snapshot-secret",
    });
  }
  assert.deepEqual(
    Object.keys(cache.getState().entities.conversations),
    ["conversation-parent", "conversation-next", "conversation-entity"],
  );
  assert.deepEqual(
    cache.getState().metadata.conversationLists.organization.conversationIds,
    ["conversation-parent", "conversation-next"],
  );
  assert.deepEqual(
    cache.getState().entities.memberUserIdsByConversation["conversation-parent"],
    [userId, "user-other"],
  );
  assert.doesNotMatch(JSON.stringify(client), /snapshot-secret/);
});

test("hydrates backward/forward pages in stable order and keeps thread timelines separate", async () => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationList(listSnapshot({ type: "organization" }, [
    summary("parent"),
    summary("thread", {
      type: "thread",
      visibility: "private",
      name: undefined,
      parentConversationId: "parent",
      rootMessageId: "parent-message-1",
    }),
  ]));
  const requests = [];
  const bodies = [
    timeline("parent", [message("parent", 2), message("parent", 3)], {
      older: { available: true, cursor: 2 },
      newer: { available: true, cursor: 3 },
    }, "event-parent-old"),
    timeline("parent", [message("parent", 4)], {
      older: { available: true, cursor: 4 },
      newer: { available: false },
    }, "event-parent-new"),
    timeline("thread", [message("thread", 1)], {
      older: { available: false },
      newer: { available: false },
    }, "event-thread"),
  ];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url) {
      requests.push(url);
      return response(bodies.shift());
    },
  });

  assert.equal((await client.getMessageTimeline({
    conversationId: "parent", direction: "backward", cursor: 4, limit: 2,
  })).status, "success");
  assert.equal((await client.getMessageTimeline({
    conversationId: "parent", direction: "forward", cursor: 3, limit: 2,
  })).status, "success");
  assert.equal((await client.getMessageTimeline({
    conversationId: "thread", direction: "forward", limit: 10,
  })).status, "success");

  assert.deepEqual(requests, [
    "/chat/conversations/parent/messages?before=4&limit=2",
    "/chat/conversations/parent/messages?after=3&limit=2",
    "/chat/conversations/thread/messages?after=0&limit=10",
  ]);
  assert.deepEqual(cache.getState().timelines.parent.messageIds, [
    "parent-message-2", "parent-message-3", "parent-message-4",
  ]);
  assert.deepEqual(cache.getState().timelines.thread.messageIds, ["thread-message-1"]);
});

test("deduplicates identical reads while isolating partial and all-consumer cancellation", async () => {
  const pending = [];
  const transportSignals = [];
  let fetchCalls = 0;
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity),
    getAccessToken: () => "dedupe-token",
    fetch(_url, init) {
      fetchCalls += 1;
      transportSignals.push(init.signal);
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        init.signal.addEventListener("abort", () => reject(new Error("secret abort")), {
          once: true,
        });
      });
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const input = { scope: { type: "organization" }, limit: 10 };
  const first = client.listConversations(input, { signal: firstController.signal });
  const second = client.listConversations(input, { signal: secondController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  firstController.abort();
  assert.equal((await first).status, "aborted");
  assert.equal(transportSignals[0].aborted, false);
  pending[0](response(listSnapshot({ type: "organization" }, [])));
  assert.equal((await second).status, "success");

  const allOne = new AbortController();
  const allTwo = new AbortController();
  const allInput = { scope: { type: "entity", entity: { type: "order", id: "9" } } };
  const allFirst = client.listConversations(allInput, { signal: allOne.signal });
  const allSecond = client.listConversations(allInput, { signal: allTwo.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 2);
  allOne.abort();
  allTwo.abort();
  assert.equal((await allFirst).status, "aborted");
  assert.equal((await allSecond).status, "aborted");
  assert.equal(transportSignals[1].aborted, true);
});

test("close cancels reads and authentication refresh obtains a new token", async () => {
  const tokens = [];
  let mode = "auth";
  let closeSignal;
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity),
    getAccessToken: () => `token-${tokens.length + 1}`,
    fetch(_url, init) {
      tokens.push(init.headers.authorization);
      if (mode === "auth") {
        mode = "success";
        return Promise.resolve(response({}, { ok: false, status: 401 }));
      }
      if (mode === "success") {
        mode = "close";
        return Promise.resolve(response(listSnapshot({ type: "organization" }, [])));
      }
      closeSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("secret close")), {
          once: true,
        });
      });
    },
  });
  assert.equal((await client.listConversations({
    scope: { type: "organization" },
  })).status, "success");
  assert.deepEqual(tokens.slice(0, 2), ["Bearer token-1", "Bearer token-2"]);

  const active = client.getConversation({ conversationId: "close-me" });
  await new Promise((resolve) => setImmediate(resolve));
  client.close();
  assert.equal(closeSignal.aborted, true);
  assert.equal((await active).status, "closed");
});

test("sanitizes malformed, authentication, provider, and transport failures", async () => {
  const providerSecret = "provider-secret-value";
  const transportSecret = "transport-secret-value";
  const bodySecret = "body-secret-value";
  const scenarios = [
    {
      getAccessToken() { throw new Error(providerSecret); },
      fetch: async () => response({}),
      expected: "authentication",
    },
    {
      getAccessToken: () => "token",
      fetch: async () => { throw new Error(transportSecret); },
      expected: "transport",
    },
    {
      getAccessToken: () => "token",
      fetch: async () => response({ secret: bodySecret }),
      expected: "malformed_response",
    },
    {
      getAccessToken: () => "token",
      fetch: async () => response({}, {
        async json() { throw new SyntaxError(`invalid JSON ${bodySecret}`); },
      }),
      expected: "malformed_response",
    },
    {
      getAccessToken: () => "token",
      fetch: async () => response({}, { ok: false, status: 403 }),
      expected: "authentication",
    },
  ];
  for (const scenario of scenarios) {
    const diagnostics = [];
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: scenario.getAccessToken,
      fetch: scenario.fetch,
      queries: { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    });
    const result = await client.listConversations({ scope: { type: "organization" } });
    assert.equal(result.status, scenario.expected);
    assert.doesNotMatch(
      JSON.stringify({ result, diagnostics, client }),
      new RegExp(`${providerSecret}|${transportSecret}|${bodySecret}`),
    );
  }
});

test("discovery rejects reordered roots, detached pages, and responses from a prior identity", async () => {
  const cache = createNormalizedChatCache(identity);
  const scope = { type: "organization" };
  const requests = [];
  const client = createChatClient({
    endpoint: "https://fixture.test/chat", getAccessToken: () => "fixture-only", cache, realtime: false,
    fetch: (url) => new Promise(resolve => requests.push({ url, resolve })),
  });
  const waitRequests = async count => {
    for (let i = 0; i < 100 && requests.length < count; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, count);
  };
  const cursor = encodeConversationSnapshotCursor({ isStarred: false, navigationRank: 1, activityAt: "2030-01-01T00:05:00.000Z", conversationId: "A" });
  const ids = () => cache.getState().metadata.conversationLists.organization?.conversationIds;
  try {
    const older = client.listConversations({ scope, limit: 10 });
    await waitRequests(1);
    const newer = client.listConversations({ scope, limit: 20 });
    await waitRequests(2);
    requests[1].resolve(response(listSnapshot(scope, [summary("new")], cursor)));
    assert.equal((await newer).status, "success");
    requests[0].resolve(response(listSnapshot(scope, [summary("old")])));
    await older;
    assert.deepEqual(ids(), ["new"]);
    const page = client.listConversations({ scope, cursor });
    await waitRequests(3);
    const refresh = client.listConversations({ scope });
    await waitRequests(4);
    requests[3].resolve(response(listSnapshot(scope, [summary("fresh")], cursor)));
    await refresh;
    requests[2].resolve(response(listSnapshot(scope, [summary("detached")])));
    await page;
    assert.deepEqual(ids(), ["fresh"]);
    assert.equal(cache.getState().metadata.conversationLists.organization.nextCursor, cursor);
    const currentPage = client.listConversations({ scope, cursor });
    await waitRequests(5);
    requests[4].resolve(response(listSnapshot(scope, [summary("fresh"), summary("page")])));
    await currentPage;
    assert.deepEqual(ids(), ["fresh", "page"]);
    const priorIdentity = client.listConversations({ scope });
    await waitRequests(6);
    cache.setIdentity({ ...identity, sessionId: "new-session" });
    requests[5].resolve(response(listSnapshot(scope, [summary("secret-old-identity")])));
    await priorIdentity;
    assert.equal(ids(), undefined);
    assert.deepEqual(cache.getState().entities.conversations, {});
  } finally { client.close(); }
});

test('an authoritative detail denial cancels older discovery that could resurrect the row', async () => {
  const cache = createNormalizedChatCache(identity);
  const scope = { type: 'organization' };
  cache.hydrateConversationList(listSnapshot(scope, [summary('denied')]));
  let finish;
  const client = createChatClient({
    endpoint: '/chat', cache, realtime: false, getAccessToken: () => 'fixture-only',
    fetch: url => String(url).includes('?')
      ? new Promise(resolve => { finish = () => resolve(response(listSnapshot(scope, [summary('denied')]))); })
      : Promise.resolve(response({}, { ok: false, status: 403 })),
  });
  try {
    const pending = client.listConversations({ scope });
    for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish);
    await client.getConversation({ conversationId: 'denied' });
    finish();
    assert.equal((await pending).status, 'aborted');
    assert.deepEqual(cache.getState().metadata.conversationLists.organization.conversationIds, []);
    assert.equal(cache.getState().entities.conversations.denied, undefined);
  } finally { client.close(); }
});

test('a failed refresh preserves usable pagination and a repeated cursor does not join an obsolete page', async () => {
  const cache = createNormalizedChatCache(identity);
  const scope = { type: 'organization' };
  const cursor = encodeConversationSnapshotCursor({ isStarred: false, navigationRank: 1, activityAt: '2030-01-01T00:05:00.000Z', conversationId: 'root' });
  const pending = [];
  const client = createChatClient({ endpoint: '/chat', cache, realtime: false, getAccessToken: () => 'fixture-only',
    fetch: url => new Promise(resolve => pending.push({ url, resolve })),
  });
  const wait = async n => {
    for (let i = 0; i < 100 && pending.length < n; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, n);
  };
  try {
    const root = client.listConversations({ scope }); await wait(1);
    pending[0].resolve(response(listSnapshot(scope, [summary('root')], cursor))); await root;
    const oldPage = client.listConversations({ scope, cursor }); await wait(2);
    const refresh = client.listConversations({ scope }); await wait(3);
    pending[2].resolve(response(listSnapshot(scope, [summary('new-root')], cursor))); await refresh;
    const newPage = client.listConversations({ scope, cursor }); await wait(4);
    pending[3].resolve(response(listSnapshot(scope, [summary('current-page')]))); await newPage;
    pending[1].resolve(response(listSnapshot(scope, [summary('old-page')]))); await oldPage;
    assert.deepEqual(cache.getState().metadata.conversationLists.organization.conversationIds, ['new-root', 'current-page']);
    const reset = client.listConversations({ scope }); await wait(5);
    pending[4].resolve(response(listSnapshot(scope, [summary('root')], cursor))); await reset;
    const failed = client.listConversations({ scope }); await wait(6);
    pending[5].resolve(response({}, { ok: false, status: 503 })); assert.equal((await failed).status, 'transport');
    const page = client.listConversations({ scope, cursor }); await wait(7);
    pending[6].resolve(response(listSnapshot(scope, [summary('after-error')]))); await page;
    assert.deepEqual(cache.getState().metadata.conversationLists.organization.conversationIds, ['root', 'after-error']);
  } finally { client.close(); }
});

test('cancelling one discovery consumer does not invalidate a shared live refresh', async () => {
  const cache = createNormalizedChatCache(identity);
  const scope = { type: 'organization' };
  let finish;
  let calls = 0;
  const client = createChatClient({ endpoint: '/chat', cache, realtime: false, getAccessToken: () => 'fixture-only',
    fetch: () => { calls++; return new Promise(resolve => { finish = () => resolve(response(listSnapshot(scope, [summary('shared')]))); }); },
  });
  try {
    const controller = new AbortController();
    const cancelled = client.listConversations({ scope }, { signal: controller.signal });
    const retained = client.listConversations({ scope });
    for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish); assert.equal(calls, 1);
    controller.abort();
    assert.equal((await cancelled).status, 'aborted');
    finish();
    assert.equal((await retained).status, 'success');
    assert.deepEqual(cache.getState().metadata.conversationLists.organization.conversationIds, ['shared']);
  } finally { client.close(); }
});

test('discovery respects cache reset but tolerates canonical hydration within the same identity', async () => {
  for (const reset of [false, true]) {
    const cache = createNormalizedChatCache(identity);
    let finish;
    const client = createChatClient({ endpoint: '/chat', cache, realtime: false, getAccessToken: () => 'fixture-only',
      fetch: () => new Promise(resolve => { finish = () => resolve(response(listSnapshot({ type: 'organization' }, [summary('response')]))); }),
    });
    try {
      const pending = client.listConversations({ scope: { type: 'organization' } });
      for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
      assert.ok(finish);
      if (reset) cache.reset();
      else {
        const restored = createNormalizedChatCache(identity);
        restored.hydrateConversationList(listSnapshot({ type: 'organization' }, [summary('restored')]));
        assert.equal(cache.hydrateCanonicalState(JSON.parse(JSON.stringify(restored.getState()))), true);
      }
      finish(); await pending;
      assert.deepEqual(cache.getState().metadata.conversationLists.organization?.conversationIds, reset ? undefined : ['response']);
    } finally { client.close(); }
  }
});
