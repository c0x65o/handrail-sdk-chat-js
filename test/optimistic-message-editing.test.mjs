import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  createReadCursorUpdatedEvent,
} from "../dist/index.js";

const tenantId = "tenant-a";
const userId = "user-a";
const conversationId = "conversation-a";
const messageId = "message-a";
const identity = { tenantId, userId, sessionId: "session-a" };
const at = (second) =>
  `2026-08-26T10:00:${String(second).padStart(2, "0")}.000Z`;

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() { return body; },
  ...overrides,
});

const durable = (eventId, type, payload, second, streamId = conversationId) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId,
  type,
  occurredAt: at(second),
  payload,
});

const message = (id, sequence, overrides = {}) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId },
  sequence,
  createdAt: at(sequence),
  updatedAt: at(sequence),
  revision: { revision: 1 },
  content: { format: "plain", text: id },
  ...overrides,
});

const editResult = (content, overrides = {}) => ({
  operation: "edit",
  reconciliationStatus: "applied",
  expectedRevision: 1,
  message: message(messageId, 1, {
    createdAt: at(1),
    updatedAt: at(5),
    revision: {
      revision: 2,
      editedAt: at(5),
      editedByUserId: userId,
    },
    content,
    threadSummary: {
      threadId: "thread-a",
      replyCount: 2,
      participantIds: [userId, "user-b"],
      lastReplyAt: at(3),
      unreadCount: 1,
    },
  }),
  canonicalRevision: 2,
  ...overrides,
});

const seedCache = () => {
  const cache = createNormalizedChatCache(identity);
  cache.applyDurableEvent(durable(
    "conversation-created",
    CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    {
      conversation: {
        id: conversationId,
        tenantId,
        type: "channel",
        visibility: "public",
        name: "General",
        createdAt: at(0),
        updatedAt: at(0),
      },
    },
    0,
  ));
  cache.applyDurableEvent(durable(
    "message-created-a",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    {
      message: message(messageId, 1, {
        threadSummary: {
          threadId: "thread-a",
          replyCount: 2,
          participantIds: [userId, "user-b"],
          lastReplyAt: at(3),
          unreadCount: 1,
        },
      }),
    },
    1,
  ));
  cache.applyDurableEvent(durable(
    "message-created-b",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message("message-b", 2) },
    2,
  ));
  cache.applyDurableEvent(durable(
    "reaction-a",
    CHAT_DURABLE_EVENT_TYPES.reactionUpdated,
    {
      operation: "add_reaction",
      messageId,
      reactionKey: "thumbsup",
      count: 1,
      reactedByCurrentUser: true,
    },
    3,
  ));
  cache.applyDurableEvent(createReadCursorUpdatedEvent({
    eventId: "read-a",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(3),
    result: {
      operation: "mark_read",
      conversationId,
      readState: {
        conversationId,
        userId,
        lastReadSequence: 1,
        updatedAt: at(3),
      },
      latestSequence: 2,
      unreadCount: 1,
    },
  }));
  return cache;
};

const createFixture = ({ fetch, commandOptions } = {}) => {
  const cache = seedCache();
  let key = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch,
    cache,
    commands: commandOptions,
    optimisticEdits: {
      generateIdempotencyKey: () => `edit-${++key}`,
    },
  });
  return { cache, client };
};

const invariantSnapshot = (cache) => {
  const state = cache.getState();
  const ids = state.timelines[conversationId].messageIds;
  const latestSequence = state.metadata.conversations[conversationId].latestSequence;
  const readState = state.currentUser.readStates[conversationId];
  return {
    ids: [...ids],
    sequences: ids.map((id) => state.entities.messages[id].sequence),
    latestSequence,
    readState,
    unreadCount: latestSequence - readState.lastReadSequence,
  };
};

test("projects edited content immediately and HTTP-first settlement is idempotent", async () => {
  let release;
  const requests = [];
  const fixture = createFixture({
    fetch: (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const before = fixture.cache.getState().entities.messages[messageId];
  const invariants = invariantSnapshot(fixture.cache);
  const content = { format: "markdown", text: "optimistic edit" };
  const pendingResult = fixture.client.editMessage({
    messageId,
    expectedRevision: 1,
    content,
  });

  const pending = fixture.cache.getState().entities.messages[messageId];
  assert.deepEqual(pending.content, content);
  assert.equal(pending.editState.state, "pending");
  assert.equal(pending.editState.idempotencyKey, "edit-1");
  assert.equal(pending.editState.expectedRevision, 1);
  assert.equal(pending.editState.previous, before);
  assert.equal(pending.revision.revision, 1);
  assert.equal(pending.createdAt, before.createdAt);
  assert.equal(pending.updatedAt, before.updatedAt);
  assert.equal(pending.reactions, before.reactions);
  assert.equal(pending.threadSummary, before.threadSummary);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);

  await new Promise(setImmediate);
  assert.equal(requests[0].url, "/api/chat/messages/message-a");
  assert.equal(requests[0].init.method, "PATCH");
  assert.equal(requests[0].init.headers["idempotency-key"], "edit-1");
  assert.equal(requests[0].body.idempotencyKey, "edit-1");
  const canonical = editResult(content);
  release(response(canonical));
  const result = await pendingResult;
  assert.equal(result.status, "success");
  assert.equal(result.value.reconciliationStatus, "applied");
  const settled = fixture.cache.getState().entities.messages[messageId];
  assert.equal("editState" in settled, false);
  assert.equal(settled.revision.revision, 2);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);

  const updated = durable(
    "message-updated",
    CHAT_DURABLE_EVENT_TYPES.messageUpdated,
    { message: canonical.message },
    5,
  );
  assert.equal(fixture.cache.applyDurableEvent(updated).status, "applied");
  assert.equal(fixture.cache.getState().entities.messages[messageId], settled);
  assert.equal(fixture.cache.applyDurableEvent(updated).status, "duplicate");
  const afterEvent = fixture.cache.getState();
  fixture.cache.reconcileOptimisticMessageEdit("edit-1", {
    ...canonical,
    reconciliationStatus: "replayed",
  });
  assert.equal(fixture.cache.getState(), afterEvent);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);
});

test("a matching durable event settles before the HTTP response exactly once", async () => {
  let release;
  const fixture = createFixture({
    fetch: () => new Promise((resolve) => { release = resolve; }),
  });
  const content = { format: "plain", text: "event first" };
  const request = fixture.client.editMessage({ messageId, expectedRevision: 1, content });
  const canonical = editResult(content);
  const updated = durable(
    "message-updated-event-first",
    CHAT_DURABLE_EVENT_TYPES.messageUpdated,
    { message: canonical.message },
    5,
  );
  assert.equal(fixture.cache.applyDurableEvent(updated).status, "applied");
  const settled = fixture.cache.getState().entities.messages[messageId];
  assert.equal("editState" in settled, false);
  assert.equal(settled.content.text, "event first");

  await new Promise(setImmediate);
  release(response(canonical));
  assert.equal((await request).status, "success");
  assert.equal(fixture.cache.getState().entities.messages[messageId], settled);
});

test("automatic transient retry preserves the exact edit body and idempotency identity", async () => {
  const requests = [];
  const content = { format: "plain", text: "retry edit" };
  const fixture = createFixture({
    commandOptions: { retry: { maxAttempts: 2, wait: async () => {} } },
    fetch: async (_url, init) => {
      requests.push({ body: init.body, key: init.headers["idempotency-key"] });
      if (requests.length === 1) throw new Error("offline");
      return response(editResult(content));
    },
  });
  assert.equal((await fixture.client.editMessage({
    messageId,
    expectedRevision: 1,
    content,
  })).status, "success");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(JSON.parse(requests[0].body).idempotencyKey, requests[0].key);
});

test("stale revision restores the canonical conflict message and exposes typed conflict state", async () => {
  const canonicalConflict = editResult(
    { format: "plain", text: "server current" },
    {
      reconciliationStatus: "revision_conflict",
      message: message(messageId, 1, {
        createdAt: at(1),
        updatedAt: at(4),
        revision: {
          revision: 3,
          editedAt: at(4),
          editedByUserId: "user-b",
        },
        content: { format: "plain", text: "server current" },
        threadSummary: {
          threadId: "thread-a",
          replyCount: 2,
          participantIds: [userId, "user-b"],
          lastReplyAt: at(3),
          unreadCount: 1,
        },
      }),
      canonicalRevision: 3,
    },
  );
  const fixture = createFixture({
    fetch: async () => response(canonicalConflict, { ok: false, status: 409 }),
  });
  const result = await fixture.client.editMessage({
    messageId,
    expectedRevision: 1,
    content: { format: "plain", text: "stale local" },
  });
  assert.equal(result.status, "success");
  assert.equal(result.value.reconciliationStatus, "revision_conflict");
  assert.equal(result.value.expectedRevision, 1);
  assert.equal(result.value.canonicalRevision, 3);

  const conflicted = fixture.cache.getState().entities.messages[messageId];
  assert.equal(conflicted.content.text, "server current");
  assert.deepEqual(conflicted.editState, {
    state: "revision_conflict",
    idempotencyKey: "edit-1",
    expectedRevision: 1,
    canonicalRevision: 3,
  });
  assert.equal(conflicted.revision.revision, 3);
});

test("permanent authentication failure rolls back unless a newer event already settled", async () => {
  const authResponse = response(
    { error: { code: "AUTHENTICATION_FAILED", message: "denied" } },
    { ok: false, status: 401 },
  );
  const rollbackFixture = createFixture({ fetch: async () => authResponse });
  const before = rollbackFixture.cache.getState().entities.messages[messageId];
  assert.equal((await rollbackFixture.client.editMessage({
    messageId,
    expectedRevision: 1,
    content: { format: "plain", text: "denied edit" },
  })).status, "authentication");
  assert.equal(rollbackFixture.cache.getState().entities.messages[messageId], before);

  let release;
  const eventFixture = createFixture({
    fetch: () => new Promise((resolve) => { release = resolve; }),
  });
  const content = { format: "plain", text: "canonical event" };
  const request = eventFixture.client.editMessage({ messageId, expectedRevision: 1, content });
  const canonical = editResult(content);
  eventFixture.cache.applyDurableEvent(durable(
    "message-updated-before-auth",
    CHAT_DURABLE_EVENT_TYPES.messageUpdated,
    { message: canonical.message },
    5,
  ));
  const settled = eventFixture.cache.getState().entities.messages[messageId];
  await new Promise(setImmediate);
  release(authResponse);
  assert.equal((await request).status, "authentication");
  assert.equal(eventFixture.cache.getState().entities.messages[messageId], settled);
  assert.equal(settled.content.text, "canonical event");
});
