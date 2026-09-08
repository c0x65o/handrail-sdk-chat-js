import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createConversationMessagesSelector,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-forward";
const userId = "user-forward";
const destinationConversationId = "conversation-destination";
const sourceMessageId = "message-source-elsewhere";
const identity = { tenantId, userId, sessionId: "session-forward" };

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() { return body; },
  ...overrides,
});

const forwardedResult = (input, reconciliationStatus = "applied") => ({
  operation: "forward_message.v1",
  reconciliationStatus,
  clientCorrelationId: input.clientCorrelationId,
  destinationConversationId,
  message: {
    id: "message-forwarded",
    tenantId,
    conversationId: destinationConversationId,
    author: { type: "user", userId },
    sequence: 1,
    createdAt: "2026-08-28T17:00:01.000Z",
    updatedAt: "2026-08-28T17:00:01.000Z",
    revision: { revision: 1 },
    content: {
      format: "plain",
      text: "forwarded text",
      forwarded: {
        sourceMessageId,
        originalAuthor: {
          userId: "user-original",
          displayName: "Original Author",
        },
        originalCreatedAt: "2026-08-28T16:00:00.000Z",
      },
    },
  },
  canonicalRevision: 1,
});

const seedConversation = (cache) => cache.applyDurableEvent({
  eventId: "destination-created",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: destinationConversationId,
  type: CHAT_DURABLE_EVENT_TYPES.conversationCreated,
  occurredAt: "2026-08-28T17:00:00.000Z",
  payload: {
    conversation: {
      id: destinationConversationId,
      tenantId,
      type: "channel",
      visibility: "public",
      name: "Destination",
      createdAt: "2026-08-28T17:00:00.000Z",
      updatedAt: "2026-08-28T17:00:00.000Z",
    },
  },
});

const createFixture = (fetch, overrides = {}) => {
  const cache = createNormalizedChatCache(identity);
  seedConversation(cache);
  let correlation = 0;
  let idempotency = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch,
    cache,
    commands: { retry: { maxAttempts: 1 } },
    forwardMessages: {
      generateClientCorrelationId: () => `forward-correlation-${++correlation}`,
      generateIdempotencyKey: () => `forward-key-${++idempotency}`,
    },
    ...overrides,
  });
  return {
    cache,
    client,
    select: createConversationMessagesSelector(destinationConversationId),
  };
};

const authored = { sourceMessageId, destinationConversationId };

test("forwardMessage sends the generated contract and reconciles applied HTTP plus durable success once", async () => {
  const requests = [];
  const fixture = createFixture(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    return response(forwardedResult(body));
  });

  const result = await fixture.client.forwardMessage(authored);
  assert.equal(result.status, "success");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/chat/messages/forward");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["idempotency-key"], "forward-key-1");
  assert.deepEqual(requests[0].body, {
    operation: "forward_message.v1",
    sourceMessageId,
    destinationConversationId,
    clientCorrelationId: "forward-correlation-1",
    idempotencyKey: "forward-key-1",
  });
  assert.deepEqual(fixture.select(fixture.cache.getState()).map(({ id }) => id), [
    "message-forwarded",
  ]);
  assert.equal(
    fixture.cache.getState().metadata.conversations[destinationConversationId].latestSequence,
    1,
  );

  const durable = fixture.cache.applyDurableEvent({
    eventId: "forward-created-durable",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: destinationConversationId,
    type: CHAT_DURABLE_EVENT_TYPES.messageCreated,
    occurredAt: "2026-08-28T17:00:02.000Z",
    payload: {
      clientMessageId: "server-forward-correlation",
      message: result.value.message,
    },
  });
  assert.equal(durable.status, "applied");
  assert.deepEqual(fixture.select(fixture.cache.getState()).map(({ id }) => id), [
    "message-forwarded",
  ]);
});

test("ambiguous concurrent retries serialize and replay with one correlation pair", async () => {
  const requests = [];
  let releaseFirst;
  let active = 0;
  let maxActive = 0;
  const fixture = createFixture(async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, key: init.headers["idempotency-key"] });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (requests.length === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        throw new Error("ambiguous delivery");
      }
      return response(forwardedResult(body, "replayed"));
    } finally {
      active -= 1;
    }
  });

  const first = fixture.client.forwardMessage(authored);
  await new Promise(setImmediate);
  const retry = fixture.client.forwardMessage(authored);
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  releaseFirst();

  assert.equal((await first).status, "transport");
  const replayed = await retry;
  assert.equal(replayed.status, "success");
  assert.equal(replayed.value.reconciliationStatus, "replayed");
  assert.equal(maxActive, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ body }) => body.clientCorrelationId), [
    "forward-correlation-1",
    "forward-correlation-1",
  ]);
  assert.deepEqual(requests.map(({ key }) => key), ["forward-key-1", "forward-key-1"]);
  assert.deepEqual(requests.map(({ body }) => body.idempotencyKey), [
    "forward-key-1",
    "forward-key-1",
  ]);
});

test("terminal failures are not replayed by an already queued duplicate", async () => {
  let requests = 0;
  let release;
  const fixture = createFixture(async () => {
    requests += 1;
    await new Promise((resolve) => { release = resolve; });
    return response(
      { error: { code: "source_message_forbidden", message: "forbidden" } },
      { ok: false, status: 403 },
    );
  });

  const first = fixture.client.forwardMessage(authored);
  await new Promise(setImmediate);
  const queued = fixture.client.forwardMessage(authored);
  release();
  assert.equal((await first).status, "authentication");
  assert.equal((await queued).status, "authentication");
  assert.equal(requests, 1);
});

test("malformed correlation is sanitized and the next call retains request identity", async () => {
  const requests = [];
  const fixture = createFixture(async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, key: init.headers["idempotency-key"] });
    const result = forwardedResult(body, requests.length === 1 ? "applied" : "replayed");
    if (requests.length === 1) result.clientCorrelationId = "mismatched";
    return response(result);
  });

  assert.deepEqual(await fixture.client.forwardMessage(authored), {
    status: "malformed_response",
    message: "The chat server returned an invalid command response.",
    httpStatus: 200,
  });
  assert.equal((await fixture.client.forwardMessage(authored)).status, "success");
  assert.equal(requests[0].body.clientCorrelationId, requests[1].body.clientCorrelationId);
  assert.equal(requests[0].key, requests[1].key);
});

test("identity replacement and close abort work and clear retained forward identity", async () => {
  const requests = [];
  const fixture = createFixture((_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });

  const identityBound = fixture.client.forwardMessage(authored);
  await new Promise(setImmediate);
  fixture.cache.setIdentity({ tenantId, userId, sessionId: "session-replaced" });
  assert.equal((await identityBound).status, "aborted");

  const afterIdentity = fixture.client.forwardMessage(authored);
  await new Promise(setImmediate);
  assert.equal(requests[1].clientCorrelationId, "forward-correlation-2");
  fixture.client.close();
  assert.equal((await afterIdentity).status, "closed");

  const afterClose = fixture.client.forwardMessage(authored);
  await new Promise(setImmediate);
  assert.equal(requests[2].clientCorrelationId, "forward-correlation-3");
  fixture.client.close();
  assert.equal((await afterClose).status, "closed");
});
