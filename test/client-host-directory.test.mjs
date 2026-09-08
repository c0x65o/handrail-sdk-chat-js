import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_HOST_DIRECTORY_BATCH_SIZE,
  createChatClient,
  createNormalizedChatCache,
  encodeHostDirectorySearchCursor,
} from "../dist/client/index.js";
import { hostDirectoryMetadata } from "./fixtures/host-directory-snapshots.mjs";

const identity = (suffix = "a") => ({
  tenantId: `tenant-${suffix}`,
  userId: `actor-${suffix}`,
  sessionId: `session-${suffix}`,
});

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() {
    return body;
  },
  ...overrides,
});

const summary = (userId, overrides = {}) => ({
  kind: "active",
  userId,
  displayName: `User ${userId}`,
  avatar: { kind: "none" },
  ...overrides,
});

const batchResult = (users) => ({
  kind: "host_directory_batch",
  users,
  _meta: hostDirectoryMetadata,
});

const searchResult = (users, nextCursor) => ({
  kind: "host_directory_search",
  users,
  page: nextCursor === undefined ? {} : { nextCursor },
  _meta: hostDirectoryMetadata,
});

const waitFor = async (predicate) => {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
};

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

test("batches only missing visible ids, deduplicates, and coalesces overlapping work", async () => {
  const cache = createNormalizedChatCache(identity());
  const requests = [];
  const pending = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "directory-token",
    async fetch(url, init) {
      assert.equal(url, "/chat/directory/users:batch");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer directory-token");
      const userIds = JSON.parse(init.body).userIds;
      requests.push(userIds);
      const request = deferred();
      pending.push({ ...request, userIds });
      return request.promise;
    },
  });

  const firstIds = Array.from(
    { length: MAX_HOST_DIRECTORY_BATCH_SIZE + 1 },
    (_, index) => `user-${index}`,
  );
  const first = client.hydrateDirectoryUsers([...firstIds, "user-0"]);
  await waitFor(() => requests.length === 2);
  assert.deepEqual(requests.map((ids) => ids.length), [100, 1]);

  const concurrent = client.hydrateDirectoryUsers(["user-0", "user-new"]);
  await waitFor(() => requests.length === 3);
  assert.deepEqual(requests[2], ["user-new"]);

  for (const request of pending) {
    request.resolve(response(batchResult(request.userIds.map((id) => summary(id)))));
  }
  assert.equal((await first).status, "success");
  assert.equal((await concurrent).status, "success");

  const cached = await client.hydrateDirectoryUsers(["user-new", "user-0", "user-new"]);
  assert.equal(cached.status, "success");
  assert.deepEqual(cached.value.users.map(({ userId }) => userId), ["user-new", "user-0"]);
  assert.equal(requests.length, 3);
});

test("negative cache states and TTL refresh stay explicit and immutable", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = createNormalizedChatCache(identity());
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    directory: { cacheTtlMs: 1_000, now: () => now },
    async fetch(_url, init) {
      calls += 1;
      const ids = JSON.parse(init.body).userIds;
      return response(batchResult(ids.map((id) => {
        if (id === "redacted") return { kind: "redacted", userId: id };
        if (id === "missing") return { kind: "unavailable", userId: id, reason: "missing" };
        if (id === "temporary") {
          return { kind: "unavailable", userId: id, reason: "temporarily_unavailable" };
        }
        return summary(id, {
          avatar: { kind: "image", url: "/avatars/safe", altText: "Safe" },
          status: { availability: "online", text: "Available" },
        });
      })));
    },
  });

  const ids = ["active", "redacted", "missing", "temporary"];
  assert.equal((await client.hydrateDirectoryUsers(ids)).status, "success");
  assert.deepEqual(ids.map((id) => client.selectDirectoryUser(id)?.kind), [
    "active",
    "redacted",
    "unavailable",
    "unavailable",
  ]);
  assert.equal(client.selectDirectoryUser("missing").reason, "missing");
  assert.equal(
    client.selectDirectoryUser("temporary").reason,
    "temporarily_unavailable",
  );
  assert.equal(Object.isFrozen(client.selectDirectoryUser("active")), true);
  assert.equal(Object.isFrozen(client.selectDirectoryUser("active").avatar), true);
  assert.equal(Object.isFrozen(client.selectDirectoryUser("active").status), true);
  assert.deepEqual(Object.keys(client.selectDirectoryUser("active")).sort(), [
    "avatar",
    "displayName",
    "kind",
    "status",
    "userId",
  ]);
  assert.doesNotMatch(
    JSON.stringify(client.selectDirectoryUser("active")),
    /roles|permissions|tenant|session|auth|profile|metadata|credential|secret/,
  );

  await client.hydrateDirectoryUsers(ids);
  assert.equal(calls, 1);
  now = 2_000;
  assert.equal(client.selectDirectoryUser("active"), undefined);
  await client.hydrateDirectoryUsers(ids);
  assert.equal(calls, 2);
});

test("debounces search, cancels replacements, and encodes opaque pagination", async () => {
  const tasks = [];
  const schedule = (task, delayMs) => {
    const entry = { task, delayMs, cancelled: false };
    tasks.push(entry);
    return () => { entry.cancelled = true; };
  };
  const urls = [];
  const cursor = encodeHostDirectorySearchCursor({
    query: "avery & team",
    continuation: "provider/page 2",
  });
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity()),
    getAccessToken: () => "token",
    directory: { searchDebounceMs: 300, schedule },
    async fetch(url) {
      urls.push(url);
      return response(url.includes("cursor=")
        ? searchResult([summary("page-2")])
        : searchResult([summary("page-1")], cursor));
    },
  });

  const replaced = client.searchDirectoryUsers({ query: "av", limit: 5 });
  assert.equal(client.getDirectorySearchState().state, "scheduled");
  const first = client.searchDirectoryUsers({ query: "avery & team", limit: 5 });
  assert.equal((await replaced).status, "aborted");
  assert.equal(tasks[0].cancelled, true);
  assert.equal(tasks[1].delayMs, 300);
  tasks[1].task();
  const firstResult = await first;
  assert.equal(firstResult.status, "success");
  assert.equal(firstResult.value.nextCursor, cursor);
  assert.equal(client.getDirectorySearchState().state, "success");
  assert.deepEqual(urls, ["/chat/directory/users/search?query=avery+%26+team&limit=5"]);

  const next = client.searchDirectoryUsers({
    query: "avery & team",
    cursor,
    limit: 5,
  });
  assert.equal(tasks[2].delayMs, 0);
  tasks[2].task();
  const nextResult = await next;
  assert.equal(nextResult.status, "success");
  assert.deepEqual(nextResult.value.users.map(({ userId }) => userId), ["page-2"]);
  assert.equal(
    urls[1],
    `/chat/directory/users/search?query=avery+%26+team&cursor=${encodeURIComponent(cursor)}&limit=5`,
  );

  const cancelled = client.searchDirectoryUsers({ query: "cancel me" });
  client.cancelDirectorySearch();
  assert.equal((await cancelled).status, "aborted");
  assert.deepEqual(client.getDirectorySearchState(), { state: "idle" });

  const controller = new AbortController();
  const callerAborted = client.searchDirectoryUsers(
    { query: "caller cancelled" },
    { signal: controller.signal },
  );
  controller.abort();
  assert.equal((await callerAborted).status, "aborted");
  assert.deepEqual(client.getDirectorySearchState(), { state: "idle" });
});

test("caller abort, close, and identity reset isolate late batch responses", async () => {
  const cache = createNormalizedChatCache(identity("old"));
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(_url, init) {
      const request = deferred();
      requests.push({ ...request, ids: JSON.parse(init.body).userIds, signal: init.signal });
      return request.promise;
    },
  });

  const controller = new AbortController();
  const callerRequest = client.hydrateDirectoryUsers(["caller-abort"], {
    signal: controller.signal,
  });
  await waitFor(() => requests.length === 1);
  controller.abort();
  assert.equal((await callerRequest).status, "aborted");
  assert.equal(requests[0].signal.aborted, true);

  const oldIdentityRequest = client.hydrateDirectoryUsers(["old-user"]);
  await waitFor(() => requests.length === 2);
  cache.setIdentity(identity("new"));
  assert.equal((await oldIdentityRequest).status, "aborted");
  requests[1].resolve(response(batchResult([summary("old-user")])));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.selectDirectoryUser("old-user"), undefined);

  const closeRequest = client.hydrateDirectoryUsers(["close-user"]);
  await waitFor(() => requests.length === 3);
  client.close();
  assert.equal((await closeRequest).status, "closed");
  requests[2].resolve(response(batchResult([summary("close-user")])));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.selectDirectoryUser("close-user"), undefined);
});

test("a new caller replaces an aborted batch before its transport settles", async () => {
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity()),
    getAccessToken: () => "token",
    async fetch(_url, init) {
      const request = deferred();
      requests.push({ ...request, ids: JSON.parse(init.body).userIds, signal: init.signal });
      return request.promise;
    },
  });
  const userIds = ["grace", "margaret"];
  const firstController = new AbortController();
  const first = client.hydrateDirectoryUsers(userIds, {
    signal: firstController.signal,
  });
  await waitFor(() => requests.length === 1);

  // React Strict Mode can dispose and immediately recreate a hydration effect.
  // The replacement must not attach to the fully-aborted batch while its
  // transport promise is still unwinding.
  firstController.abort();
  const replacement = client.hydrateDirectoryUsers(userIds);
  assert.equal((await first).status, "aborted");
  await waitFor(() => requests.length === 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(requests[1].ids, userIds);

  requests[1].resolve(response(batchResult(userIds.map((id) => summary(id)))));
  const replacementResult = await replacement;
  assert.equal(replacementResult.status, "success");
  assert.deepEqual(
    replacementResult.value.users.map(({ displayName }) => displayName),
    ["User grace", "User margaret"],
  );
});

test("rejects malformed or over-broad responses and returns sanitized failures", async () => {
  const bodies = [
    batchResult([summary("requested"), summary("unexpected")]),
    batchResult([{ ...summary("unsafe"), roles: ["admin"], metadata: { secret: true } }]),
  ];
  const statuses = [
    { ok: false, status: 403 },
    { ok: false, status: 422 },
    { ok: false, status: 503 },
  ];
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity()),
    getAccessToken: () => "super-secret-token",
    async fetch() {
      if (bodies.length > 0) return response(bodies.shift());
      return response({ secretBody: "must-not-leak" }, statuses.shift());
    },
  });

  assert.equal((await client.hydrateDirectoryUsers(["requested"])).status, "malformed_response");
  assert.equal((await client.hydrateDirectoryUsers(["unsafe"])).status, "malformed_response");
  assert.equal(client.selectDirectoryUser("unsafe"), undefined);
  const authentication = await client.hydrateDirectoryUsers(["auth"]);
  const rejected = await client.hydrateDirectoryUsers(["rejected"]);
  const transport = await client.hydrateDirectoryUsers(["transport"]);
  assert.deepEqual(authentication, {
    status: "authentication",
    message: "Chat authentication failed.",
    httpStatus: 403,
  });
  assert.deepEqual(rejected, {
    status: "rejected",
    message: "The chat server rejected the directory request.",
    httpStatus: 422,
  });
  assert.deepEqual(transport, {
    status: "transport",
    message: "The chat directory request could not be completed.",
    httpStatus: 503,
  });
  const serialized = JSON.stringify({ authentication, rejected, transport, client });
  assert.doesNotMatch(serialized, /super-secret-token|must-not-leak/);
  assert.equal(client.selectDirectoryUser("unsafe"), undefined);
});
