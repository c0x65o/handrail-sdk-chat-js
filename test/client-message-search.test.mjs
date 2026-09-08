import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";

const identity = (suffix = "a") => ({
  tenantId: `tenant-${suffix}`,
  userId: `actor-${suffix}`,
  sessionId: `session-${suffix}`,
});

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() { return body; },
  ...overrides,
});

const messageHit = (messageId, overrides = {}) => ({
  type: "message",
  conversationId: "conversation-search",
  messageId,
  snippet: `Result ${messageId}`,
  ...overrides,
});

const conversationHit = (conversationId) => ({
  type: "conversation",
  conversationId,
  title: "Project channel",
  snippet: "Matching conversation",
});

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

const waitFor = async (predicate) => {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
};

test("blank searches reset to idle without transport and first pages debounce", async () => {
  const tasks = [];
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity()),
    getAccessToken: () => "search-token",
    messageSearch: {
      debounceMs: 300,
      schedule(task, delayMs) {
        const entry = { task, delayMs, cancelled: false };
        tasks.push(entry);
        return () => { entry.cancelled = true; };
      },
    },
    async fetch(url, init) {
      requests.push({ url, init });
      return response({ hits: [] });
    },
  });

  const blank = await client.searchMessages({ query: " \n\t ", pageSize: 10 });
  assert.equal(blank.status, "success");
  assert.deepEqual(client.getMessageSearchState(), { state: "idle" });
  assert.equal(requests.length, 0);

  const pending = client.searchMessages({ query: "  release   notes ", pageSize: 10 });
  assert.equal(client.getMessageSearchState().state, "scheduled");
  assert.equal(tasks[0].delayMs, 300);
  tasks[0].task();
  assert.equal((await pending).status, "success");
  assert.equal(requests[0].url, "/chat/messages/search");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.authorization, "Bearer search-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    query: "release notes",
    pageSize: 10,
  });
});

test("superseded scheduled and in-flight searches cannot publish late responses", async () => {
  const tasks = [];
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity()),
    getAccessToken: () => "token",
    messageSearch: {
      schedule(task, delayMs) {
        const entry = { task, delayMs, cancelled: false };
        tasks.push(entry);
        return () => { entry.cancelled = true; };
      },
    },
    async fetch(_url, init) {
      const request = deferred();
      requests.push({ ...request, body: JSON.parse(init.body), signal: init.signal });
      return request.promise;
    },
  });

  const scheduled = client.searchMessages({ query: "old scheduled", pageSize: 5 });
  const inFlight = client.searchMessages({ query: "old in flight", pageSize: 5 });
  assert.equal((await scheduled).status, "aborted");
  assert.equal(tasks[0].cancelled, true);
  tasks[1].task();
  await waitFor(() => requests.length === 1);

  const current = client.searchMessages({ query: "current", pageSize: 5 });
  assert.equal((await inFlight).status, "aborted");
  assert.equal(requests[0].signal.aborted, true);
  tasks[2].task();
  await waitFor(() => requests.length === 2);
  requests[1].resolve(response({ hits: [messageHit("message-current")] }));
  assert.equal((await current).status, "success");

  requests[0].resolve(response({ hits: [messageHit("message-stale")] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    client.getMessageSearchState().hits.map((hit) => hit.messageId),
    ["message-current"],
  );
});

test("opaque pagination accumulates relevance order and deduplicates across pages", async () => {
  const tasks = [];
  const bodies = [];
  const cursor = "opaque/provider cursor?page=2";
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity()),
    getAccessToken: () => "token",
    messageSearch: {
      schedule(task, delayMs) {
        tasks.push({ task, delayMs });
        return () => {};
      },
    },
    async fetch(_url, init) {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? response({
            hits: [messageHit("message-1"), conversationHit("conversation-2")],
            nextCursor: cursor,
          })
        : response({
            hits: [messageHit("message-1"), messageHit("message-3")],
          });
    },
  });

  const first = client.searchMessages({ query: "project", pageSize: 10 });
  tasks[0].task();
  assert.equal((await first).status, "success");
  const next = client.searchMessages({ query: "project", pageSize: 10, cursor });
  assert.equal(tasks[1].delayMs, 0);
  tasks[1].task();
  const result = await next;
  assert.equal(result.status, "success");
  assert.deepEqual(result.value.hits.map((hit) =>
    hit.type === "message" ? `message:${hit.messageId}` : `conversation:${hit.conversationId}`), [
    "message:message-1",
    "conversation:conversation-2",
    "message:message-3",
  ]);
  assert.equal(bodies[1].cursor, cursor);
  assert.equal(Object.isFrozen(result.value.hits), true);
});

test("malformed responses, identity changes, and close use sanitized terminal results", async () => {
  const tasks = [];
  const cache = createNormalizedChatCache(identity("old"));
  const pending = [];
  const client = createChatClient({
    endpoint: "https://secret.example/chat",
    cache,
    getAccessToken: () => "super-secret-token",
    messageSearch: {
      schedule(task) {
        tasks.push(task);
        return () => {};
      },
    },
    async fetch(_url, init) {
      const request = deferred();
      pending.push({ ...request, signal: init.signal });
      return request.promise;
    },
  });

  const malformed = client.searchMessages({ query: "malformed", pageSize: 5 });
  tasks.shift()();
  await waitFor(() => pending.length === 1);
  pending[0].resolve(response({ hits: [{ ...messageHit("unsafe"), roles: ["admin"] }] }));
  const malformedResult = await malformed;
  assert.deepEqual(malformedResult, {
    status: "malformed_response",
    message: "The chat server returned an invalid message search response.",
    httpStatus: 200,
  });

  const oldIdentity = client.searchMessages({ query: "old identity", pageSize: 5 });
  tasks.shift()();
  await waitFor(() => pending.length === 2);
  cache.setIdentity(identity("new"));
  assert.equal((await oldIdentity).status, "aborted");
  assert.equal(pending[1].signal.aborted, true);
  assert.deepEqual(client.getMessageSearchState(), { state: "idle" });

  const closing = client.searchMessages({ query: "closing", pageSize: 5 });
  tasks.shift()();
  await waitFor(() => pending.length === 3);
  client.close();
  const closed = await closing;
  assert.deepEqual(closed, {
    status: "closed",
    message: "The chat client was closed.",
  });
  assert.equal(pending[2].signal.aborted, true);
  assert.deepEqual(client.getMessageSearchState(), { state: "idle" });
  assert.doesNotMatch(
    JSON.stringify({ malformedResult, closed, state: client.getMessageSearchState() }),
    /super-secret-token|secret\.example|roles|admin|unsafe/,
  );
});
