import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-a";
const userId = "user-a";
const conversationId = "conversation-a";
const identity = { tenantId, userId, sessionId: "session-a" };

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const message = (id, reactions = []) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId },
  sequence: id === "message-b" ? 2 : 1,
  createdAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:00:00.000Z",
  revision: { revision: 1 },
  content: { format: "plain", text: id },
  isThreadRoot: false,
  reactions,
  attachmentMetadata: [],
});

const seedCache = (reactions = []) => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateMessageTimeline({
    conversationId,
    messages: [message("message-a", reactions), message("message-b")],
    pagination: {
      older: { available: false },
      newer: { available: false },
    },
    replay: { resumeFrom: { eventId: "snapshot" } },
  });
  return cache;
};

const aggregate = (cache, messageId, reactionKey) =>
  cache.getState().entities.messages[messageId].reactions.find(
    (reaction) => reaction.reactionKey === reactionKey,
  );

const reactionResult = ({
  operation = "add_reaction",
  messageId = "message-a",
  reactionKey = "thumbsup",
  count = 1,
  reconciliationStatus = "applied",
} = {}) => ({
  operation,
  reconciliationStatus,
  messageId,
  reactionKey,
  count,
  reactedByCurrentUser: operation === "add_reaction",
});

const durableReaction = (eventId, result, second = 1) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: conversationId,
  type: CHAT_DURABLE_EVENT_TYPES.reactionUpdated,
  occurredAt: `2026-08-26T10:00:0${second}.000Z`,
  payload: {
    conversationId,
    operation: result.operation,
    reconciliationStatus: result.reconciliationStatus,
    messageId: result.messageId,
    reactionKey: result.reactionKey,
    count: result.count,
    reactedByCurrentUser: result.reactedByCurrentUser,
  },
});

const createFixture = ({ cache = seedCache(), fetch, commandOptions } = {}) => {
  let key = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    cache,
    fetch,
    commands: commandOptions,
    optimisticReactions: {
      generateIdempotencyKey: () => `reaction-${++key}`,
    },
  });
  return { cache, client };
};

test("add/add and remove/remove project one explicit current-user delta and serialize per message", async () => {
  const pending = [];
  const requests = [];
  const fixture = createFixture({
    fetch: (url, init) => {
      const request = deferred();
      pending.push(request);
      requests.push({ url, init, body: JSON.parse(init.body) });
      return request.promise;
    },
  });

  const first = fixture.client.setReaction({
    messageId: "message-a",
    reactionKey: "thumbsup",
    reacted: true,
  });
  const second = fixture.client.setReaction({
    messageId: "message-a",
    reactionKey: "thumbsup",
    reacted: true,
  });
  assert.deepEqual(aggregate(fixture.cache, "message-a", "thumbsup"), {
    reactionKey: "thumbsup",
    count: 1,
    reactedByCurrentUser: true,
  });
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  pending[0].resolve(response(reactionResult()));
  assert.equal((await first).status, "success");
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  pending[1].resolve(response(reactionResult({ reconciliationStatus: "replayed" })));
  assert.equal((await second).status, "success");
  assert.deepEqual(requests.map(({ init, body }) => [
    init.headers["idempotency-key"],
    body.idempotencyKey,
    body.operation,
  ]), [
    ["reaction-1", "reaction-1", "add_reaction"],
    ["reaction-2", "reaction-2", "add_reaction"],
  ]);

  const removePending = [];
  const removeCache = seedCache([
    { reactionKey: "thumbsup", count: 3, reactedByCurrentUser: true },
  ]);
  const remove = createFixture({
    cache: removeCache,
    fetch: () => {
      const request = deferred();
      removePending.push(request);
      return request.promise;
    },
  });
  const removeFirst = remove.client.setReaction({ messageId: "message-a", reactionKey: "thumbsup", reacted: false });
  const removeSecond = remove.client.setReaction({ messageId: "message-a", reactionKey: "thumbsup", reacted: false });
  assert.deepEqual(aggregate(remove.cache, "message-a", "thumbsup"), {
    reactionKey: "thumbsup",
    count: 2,
    reactedByCurrentUser: false,
  });
  await new Promise(setImmediate);
  removePending[0].resolve(response(reactionResult({ operation: "remove_reaction", count: 2 })));
  await removeFirst;
  await new Promise(setImmediate);
  removePending[1].resolve(response(reactionResult({ operation: "remove_reaction", count: 2, reconciliationStatus: "replayed" })));
  await removeSecond;
  assert.deepEqual(aggregate(remove.cache, "message-a", "thumbsup"), {
    reactionKey: "thumbsup",
    count: 2,
    reactedByCurrentUser: false,
  });
});

test("rapid desired replacement survives stale failure and a still-current failure rolls back", async () => {
  const pending = [];
  const fixture = createFixture({
    fetch: () => {
      const request = deferred();
      pending.push(request);
      return request.promise;
    },
  });
  const add = fixture.client.setReaction({ messageId: "message-a", reactionKey: "eyes", reacted: true });
  const remove = fixture.client.setReaction({ messageId: "message-a", reactionKey: "eyes", reacted: false });
  assert.equal(aggregate(fixture.cache, "message-a", "eyes"), undefined);
  await new Promise(setImmediate);
  pending[0].resolve(response({ error: { code: "CHAT_INVALID_COMMAND", message: "rejected" } }, 422));
  assert.equal((await add).status, "rejected");
  assert.equal(aggregate(fixture.cache, "message-a", "eyes"), undefined);
  await new Promise(setImmediate);
  pending[1].resolve(response(reactionResult({ operation: "remove_reaction", reactionKey: "eyes", count: 0 })));
  assert.equal((await remove).status, "success");

  const failed = createFixture({
    fetch: async () => response({ error: { code: "CHAT_INVALID_COMMAND", message: "rejected" } }, 422),
  });
  const request = failed.client.setReaction({ messageId: "message-a", reactionKey: "eyes", reacted: true });
  assert.equal(aggregate(failed.cache, "message-a", "eyes").reactedByCurrentUser, true);
  assert.equal((await request).status, "rejected");
  assert.equal(aggregate(failed.cache, "message-a", "eyes"), undefined);
});

test("HTTP/event ordering, replay, and other-user aggregates preserve pending desired state", async () => {
  const request = deferred();
  const fixture = createFixture({ fetch: () => request.promise });
  const pending = fixture.client.setReaction({ messageId: "message-a", reactionKey: "eyes", reacted: true });
  const otherUsers = reactionResult({ operation: "remove_reaction", reactionKey: "eyes", count: 2 });
  assert.equal(
    fixture.cache.applyDurableEvent(durableReaction("other-users", otherUsers)).status,
    "applied",
  );
  assert.deepEqual(aggregate(fixture.cache, "message-a", "eyes"), {
    reactionKey: "eyes",
    count: 3,
    reactedByCurrentUser: true,
  });
  const own = reactionResult({ reactionKey: "eyes", count: 3 });
  assert.equal(
    fixture.cache.applyDurableEvent(durableReaction("own-event", own, 2)).status,
    "applied",
  );
  const eventFirst = fixture.cache.getState().entities.messages["message-a"].reactions;
  assert.deepEqual(aggregate(fixture.cache, "message-a", "eyes"), {
    reactionKey: "eyes",
    count: 4,
    reactedByCurrentUser: true,
  });
  assert.equal(
    fixture.cache.applyDurableEvent(durableReaction("own-event", own, 2)).status,
    "duplicate",
  );
  assert.equal(fixture.cache.getState().entities.messages["message-a"].reactions, eventFirst);
  request.resolve(response(own));
  assert.equal((await pending).status, "success");
  assert.deepEqual(aggregate(fixture.cache, "message-a", "eyes"), {
    reactionKey: "eyes",
    count: 3,
    reactedByCurrentUser: true,
  });

  const httpFixture = createFixture({ fetch: async () => response(reactionResult()) });
  const result = await httpFixture.client.setReaction({ messageId: "message-a", reactionKey: "thumbsup", reacted: true });
  const httpFirst = httpFixture.cache.getState().entities.messages["message-a"].reactions;
  httpFixture.cache.reconcileOptimisticReaction("reaction-1", {
    ...result.value,
    reconciliationStatus: "replayed",
  });
  assert.equal(httpFixture.cache.getState().entities.messages["message-a"].reactions, httpFirst);
  httpFixture.cache.applyDurableEvent(durableReaction("http-first-event", result.value));
  assert.deepEqual(httpFixture.cache.getState().entities.messages["message-a"].reactions, httpFirst);
});

for (const reacted of [true, false]) {
  for (const settlement of ["success", "rollback"]) {
    const operation = reacted ? "add_reaction" : "remove_reaction";
    test(`matching teammate ${operation} preserves the pending viewer intent until exact-key ${settlement}`, async () => {
      const request = deferred();
      const requests = [];
      const fixture = createFixture({
        cache: seedCache([
          { reactionKey: "thumbsup", count: 3, reactedByCurrentUser: !reacted },
        ]),
        fetch: (_url, init) => {
          requests.push({ key: init.headers["idempotency-key"], body: JSON.parse(init.body) });
          return request.promise;
        },
      });
      const delta = reacted ? 1 : -1;
      const pending = fixture.client.setReaction({
        messageId: "message-a", reactionKey: "thumbsup", reacted,
      });
      assert.deepEqual(aggregate(fixture.cache, "message-a", "thumbsup"), {
        reactionKey: "thumbsup",
        count: 3 + delta,
        reactedByCurrentUser: reacted,
      });
      await new Promise(setImmediate);
      assert.equal(requests.length, 1);
      const { key, body } = requests[0];
      assert.equal(key, "reaction-1");
      assert.deepEqual(body, {
        operation, messageId: "message-a", reactionKey: "thumbsup", idempotencyKey: key,
      });

      // This teammate broadcast has no actor or request key. Its matching boolean
      // cannot acknowledge the viewer's intent or replace their seeded membership.
      const sharedCount = 3 + delta;
      const event = durableReaction("teammate-event", reactionResult({ operation, count: sharedCount }));
      assert.equal(fixture.cache.applyDurableEvent(event).status, "applied");
      assert.deepEqual(aggregate(fixture.cache, "message-a", "thumbsup"), {
        reactionKey: "thumbsup",
        count: sharedCount + delta,
        reactedByCurrentUser: reacted,
      }, "the broadcast updates the shared count while the viewer delta stays projected");
      const afterBroadcast = fixture.cache.getState().entities.messages["message-a"].reactions;
      assert.equal(fixture.cache.applyDurableEvent(event).status, "duplicate");
      assert.equal(fixture.cache.getState().entities.messages["message-a"].reactions, afterBroadcast);

      const authoritative = reactionResult({ operation, count: sharedCount + delta });
      fixture.cache.reconcileOptimisticReaction(`${key}-unrelated`, authoritative);
      fixture.cache.rollbackOptimisticReaction("message-a", "thumbsup", `${key}-unrelated`);
      assert.equal(fixture.cache.getState().entities.messages["message-a"].reactions, afterBroadcast);

      if (settlement === "success") {
        request.resolve(response(authoritative));
        const result = await pending;
        assert.equal(result.status, "success");
        assert.deepEqual(result.value, authoritative);
        assert.deepEqual(aggregate(fixture.cache, "message-a", "thumbsup"), {
          reactionKey: "thumbsup",
          count: authoritative.count,
          reactedByCurrentUser: reacted,
        }, "the captured request's success settles to its authoritative aggregate");
      } else {
        request.resolve(response({ error: { code: "CHAT_INVALID_COMMAND", message: "rejected" } }, 422));
        assert.equal((await pending).status, "rejected");
        assert.deepEqual(aggregate(fixture.cache, "message-a", "thumbsup"), {
          reactionKey: "thumbsup",
          count: sharedCount,
          reactedByCurrentUser: !reacted,
        }, "rollback restores authoritative viewer membership and retains the teammate count");
      }
      const afterSettlement = fixture.cache.getState().entities.messages["message-a"].reactions;
      fixture.cache.rollbackOptimisticReaction("message-a", "thumbsup", key);
      assert.equal(fixture.cache.getState().entities.messages["message-a"].reactions, afterSettlement,
        "the captured request key is already settled");
      assert.equal(fixture.cache.applyDurableEvent(event).status, "duplicate");
      assert.equal(fixture.cache.getState().entities.messages["message-a"].reactions, afterSettlement);
    });
  }
}

test("transient retries reuse one key, NFC-normalize keys, and unrelated messages proceed independently", async () => {
  const keys = [];
  let calls = 0;
  const retry = createFixture({
    commandOptions: {
      retry: { maxAttempts: 3, backoffMs: () => 0, wait: async () => undefined },
    },
    fetch: async (_url, init) => {
      calls += 1;
      keys.push(init.headers["idempotency-key"]);
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return response({ error: { code: "CHAT_TEMPORARY", message: "retry" } }, 503);
      return response(reactionResult({ reactionKey: "é" }));
    },
  });
  const retried = await retry.client.setReaction({ messageId: "message-a", reactionKey: "e\u0301", reacted: true });
  assert.equal(retried.status, "success");
  assert.deepEqual(keys, ["reaction-1", "reaction-1", "reaction-1"]);
  assert.deepEqual(aggregate(retry.cache, "message-a", "é"), {
    reactionKey: "é",
    count: 1,
    reactedByCurrentUser: true,
  });

  const pending = new Map();
  const parallel = createFixture({
    fetch: (_url, init) => {
      const body = JSON.parse(init.body);
      const request = deferred();
      pending.set(body.messageId, request);
      return request.promise;
    },
  });
  const first = parallel.client.setReaction({ messageId: "message-a", reactionKey: "eyes", reacted: true });
  const second = parallel.client.setReaction({ messageId: "message-b", reactionKey: "eyes", reacted: true });
  await new Promise(setImmediate);
  assert.deepEqual([...pending.keys()].sort(), ["message-a", "message-b"]);
  pending.get("message-a").resolve(response(reactionResult({ reactionKey: "eyes" })));
  pending.get("message-b").resolve(response(reactionResult({ messageId: "message-b", reactionKey: "eyes" })));
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.status), ["success", "success"]);
});
