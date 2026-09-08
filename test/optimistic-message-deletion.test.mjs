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
const attachmentId = "attachment-a";
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

const threadSummary = {
  threadId: "thread-a",
  replyCount: 2,
  participantIds: [userId, "user-b"],
  lastReplyAt: at(3),
  unreadCount: 1,
};

const deleteResult = (overrides = {}) => ({
  operation: "soft_delete",
  reconciliationStatus: "applied",
  expectedRevision: 1,
  message: message(messageId, 1, {
    createdAt: at(1),
    updatedAt: at(6),
    revision: { revision: 2 },
    content: null,
    deletedAt: at(6),
    deletedByUserId: userId,
    threadSummary,
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
    "attachment-created",
    CHAT_DURABLE_EVENT_TYPES.attachmentUpdated,
    {
      attachment: {
        attachmentId,
        fileName: "proof.txt",
        contentType: "text/plain",
        sizeBytes: 5,
        downloadUrl: "/attachments/attachment-a",
      },
    },
    1,
  ));
  cache.applyDurableEvent(durable(
    "message-created-a",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    {
      message: message(messageId, 1, {
        content: {
          format: "plain",
          text: "delete me",
          attachments: [{ attachmentId }],
        },
        threadSummary,
      }),
    },
    2,
  ));
  cache.applyDurableEvent(durable(
    "message-created-b",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { message: message("message-b", 2) },
    3,
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
    4,
  ));
  cache.applyDurableEvent(createReadCursorUpdatedEvent({
    eventId: "read-a",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    occurredAt: at(4),
    result: {
      operation: "mark_read",
      conversationId,
      readState: {
        conversationId,
        userId,
        lastReadSequence: 1,
        updatedAt: at(4),
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
    optimisticDeletes: {
      generateIdempotencyKey: () => `delete-${++key}`,
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

test("projects a pending tombstone immediately and settles HTTP-first exactly once", async () => {
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
  const request = fixture.client.deleteMessage({ messageId, expectedRevision: 1 });

  const pending = fixture.cache.getState().entities.messages[messageId];
  assert.equal(pending.content, null);
  assert.equal(pending.deleteState.state, "pending");
  assert.equal(pending.deleteState.idempotencyKey, "delete-1");
  assert.equal(pending.deleteState.expectedRevision, 1);
  assert.equal(pending.deleteState.previous, before);
  assert.equal(pending.sequence, before.sequence);
  assert.equal(pending.author, before.author);
  assert.equal(pending.reactions, before.reactions);
  assert.equal(pending.attachmentMetadata, before.attachmentMetadata);
  assert.equal(pending.threadSummary, before.threadSummary);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);

  await new Promise(setImmediate);
  assert.equal(requests[0].url, "/api/chat/messages/message-a");
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].init.headers["idempotency-key"], "delete-1");
  assert.deepEqual(requests[0].body, {
    operation: "soft_delete",
    messageId,
    expectedRevision: 1,
    idempotencyKey: "delete-1",
  });

  const canonical = deleteResult();
  release(response(canonical));
  assert.equal((await request).status, "success");
  const settled = fixture.cache.getState().entities.messages[messageId];
  assert.equal("deleteState" in settled, false);
  assert.equal(settled.content, null);
  assert.equal(settled.revision.revision, 2);
  assert.equal(settled.threadSummary.threadId, "thread-a");
  assert.equal(settled.reactions, pending.reactions);
  assert.deepEqual(settled.attachmentMetadata, []);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);

  const deleted = durable(
    "message-deleted-http-first",
    CHAT_DURABLE_EVENT_TYPES.messageDeleted,
    { message: canonical.message },
    6,
  );
  assert.equal(fixture.cache.applyDurableEvent(deleted).status, "applied");
  assert.equal(fixture.cache.getState().entities.messages[messageId], settled);
  assert.equal(fixture.cache.applyDurableEvent(deleted).status, "duplicate");
  const afterEvent = fixture.cache.getState();
  fixture.cache.reconcileOptimisticMessageDelete("delete-1", {
    ...canonical,
    reconciliationStatus: "replayed",
  });
  assert.equal(fixture.cache.getState(), afterEvent);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);
});

test("a matching durable delete settles before the HTTP response and guards rollback", async () => {
  let release;
  const fixture = createFixture({
    fetch: () => new Promise((resolve) => { release = resolve; }),
  });
  const request = fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
  const canonical = deleteResult();
  const deleted = durable(
    "message-deleted-event-first",
    CHAT_DURABLE_EVENT_TYPES.messageDeleted,
    { message: canonical.message },
    6,
  );
  assert.equal(fixture.cache.applyDurableEvent(deleted).status, "applied");
  const settledState = fixture.cache.getState();
  const settled = settledState.entities.messages[messageId];
  assert.equal("deleteState" in settled, false);
  assert.equal(settled.content, null);
  assert.equal(fixture.cache.applyDurableEvent(deleted).status, "duplicate");

  await new Promise(setImmediate);
  release(response(canonical));
  assert.equal((await request).status, "success");
  assert.equal(fixture.cache.getState(), settledState);
});

test("automatic transient retry preserves the exact delete body and idempotency identity", async () => {
  const requests = [];
  const fixture = createFixture({
    commandOptions: { retry: { maxAttempts: 2, wait: async () => {} } },
    fetch: async (_url, init) => {
      requests.push({ body: init.body, key: init.headers["idempotency-key"] });
      if (requests.length === 1) throw new Error("offline");
      return response(deleteResult());
    },
  });
  assert.equal((await fixture.client.deleteMessage({
    messageId,
    expectedRevision: 1,
  })).status, "success");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(JSON.parse(requests[0].body).idempotencyKey, requests[0].key);
});

test("stale revision restores the authoritative canonical conflict message", async () => {
  const conflict = deleteResult({
    reconciliationStatus: "revision_conflict",
    message: message(messageId, 1, {
      createdAt: at(1),
      updatedAt: at(5),
      revision: {
        revision: 3,
        editedAt: at(5),
        editedByUserId: "user-b",
      },
      content: {
        format: "plain",
        text: "server current",
        attachments: [{ attachmentId }],
      },
      threadSummary,
    }),
    canonicalRevision: 3,
  });
  const fixture = createFixture({
    fetch: async () => response(conflict, { ok: false, status: 409 }),
  });
  const invariants = invariantSnapshot(fixture.cache);
  const result = await fixture.client.deleteMessage({ messageId, expectedRevision: 1 });
  assert.equal(result.status, "success");
  assert.equal(result.value.reconciliationStatus, "revision_conflict");

  const restored = fixture.cache.getState().entities.messages[messageId];
  assert.equal("deleteState" in restored, false);
  assert.equal(restored.content.text, "server current");
  assert.equal(restored.revision.revision, 3);
  assert.equal(restored.threadSummary.threadId, "thread-a");
  assert.equal(restored.attachmentMetadata[0].attachmentId, attachmentId);
  assert.deepEqual(invariantSnapshot(fixture.cache), invariants);
});

test("authentication and permanent failures restore the prior projection unless an event settled", async () => {
  for (const [status, body, expectedStatus] of [
    [401, { error: { code: "AUTHENTICATION_FAILED", message: "denied" } }, "authentication"],
    [422, { error: { code: "MESSAGE_DELETE_REJECTED", message: "denied" } }, "rejected"],
  ]) {
    const fixture = createFixture({
      fetch: async () => response(body, { ok: false, status }),
    });
    const before = fixture.cache.getState().entities.messages[messageId];
    assert.equal((await fixture.client.deleteMessage({
      messageId,
      expectedRevision: 1,
    })).status, expectedStatus);
    assert.equal(fixture.cache.getState().entities.messages[messageId], before);
  }

  let release;
  const eventFixture = createFixture({
    fetch: () => new Promise((resolve) => { release = resolve; }),
  });
  const request = eventFixture.client.deleteMessage({ messageId, expectedRevision: 1 });
  const canonical = deleteResult();
  eventFixture.cache.applyDurableEvent(durable(
    "message-deleted-before-auth",
    CHAT_DURABLE_EVENT_TYPES.messageDeleted,
    { message: canonical.message },
    6,
  ));
  const settled = eventFixture.cache.getState().entities.messages[messageId];
  await new Promise(setImmediate);
  release(response(
    { error: { code: "AUTHENTICATION_FAILED", message: "denied" } },
    { ok: false, status: 401 },
  ));
  assert.equal((await request).status, "authentication");
  assert.equal(eventFixture.cache.getState().entities.messages[messageId], settled);
  assert.equal(settled.content, null);
});
