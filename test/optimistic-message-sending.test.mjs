import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createConversationMessagesSelector,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-a";
const userId = "user-a";
const conversationId = "conversation-a";
const identity = { tenantId, userId, sessionId: "session-a" };

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() { return body; },
  ...overrides,
});

const canonicalResult = (clientMessageId, content, overrides = {}) => ({
  operation: "send",
  reconciliationStatus: "applied",
  clientMessageId,
  message: {
    id: overrides.id ?? `canonical-${clientMessageId}`,
    tenantId,
    conversationId: overrides.conversationId ?? conversationId,
    author: { type: "user", userId },
    sequence: overrides.sequence ?? 1,
    createdAt: "2026-08-26T10:00:01.000Z",
    updatedAt: "2026-08-26T10:00:01.000Z",
    revision: { revision: 1 },
    content,
  },
  canonicalRevision: 1,
});

const durable = (eventId, type, payload, second) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: conversationId,
  type,
  occurredAt: `2026-08-26T10:00:0${second}.000Z`,
  payload,
});

const seedConversation = (cache) => cache.applyDurableEvent(durable(
  "conversation-created",
  CHAT_DURABLE_EVENT_TYPES.conversationCreated,
  {
    conversation: {
      id: conversationId,
      tenantId,
      type: "channel",
      visibility: "public",
      name: "General",
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:00.000Z",
    },
  },
  0,
));

const createFixture = ({ fetch, commandOptions } = {}) => {
  const cache = createNormalizedChatCache(identity);
  seedConversation(cache);
  let clientId = 0;
  let keyId = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    fetch,
    cache,
    commands: commandOptions,
    optimisticMessages: {
      generateClientMessageId: () => `client-${++clientId}`,
      generateIdempotencyKey: () => `send-${++keyId}`,
      now: () => Date.parse("2026-08-26T10:00:00.500Z"),
    },
  });
  return { cache, client, select: createConversationMessagesSelector(conversationId) };
};

test("sendMessage exposes an immediate pending row and HTTP success replaces it once", async () => {
  let release;
  const requests = [];
  const fixture = createFixture({
    fetch: (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const content = { format: "plain", text: "hello" };
  const pendingResult = fixture.client.sendMessage({ conversationId, content });
  const pending = fixture.select(fixture.cache.getState());
  assert.equal(pending.length, 1);
  assert.equal(pending[0].delivery.state, "sending");
  assert.equal(pending[0].delivery.clientMessageId, "client-1");
  await new Promise(setImmediate);
  assert.equal(requests[0].url, "/api/chat/conversations/conversation-a/messages");
  assert.equal(requests[0].init.headers["idempotency-key"], "send-1");
  assert.equal(requests[0].body.clientMessageId, "client-1");

  const canonical = canonicalResult("client-1", content);
  release(response(canonical));
  assert.equal((await pendingResult).status, "success");
  const settled = fixture.select(fixture.cache.getState());
  assert.deepEqual(settled.map(({ id }) => id), [canonical.message.id]);
  assert.equal("delivery" in settled[0], false);

  fixture.cache.reconcileOptimisticMessage({ ...canonical, reconciliationStatus: "replayed" });
  assert.deepEqual(fixture.select(fixture.cache.getState()).map(({ id }) => id), [canonical.message.id]);
});

test("thread send reconciliation advances the root summary exactly once", async () => {
  const threadId = "thread-a";
  const rootMessageId = "root-a";
  const content = { format: "plain", text: "thread reply" };
  const canonical = canonicalResult("client-1", content, {
    conversationId: threadId,
  });
  const fixture = createFixture({ fetch: async () => response(canonical) });
  fixture.cache.applyDurableEvent(durable(
    "root-created",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    {
      clientMessageId: "root-client",
      message: {
        ...canonicalResult("root-client", { format: "plain", text: "root" }).message,
        id: rootMessageId,
        threadSummary: {
          threadId,
          replyCount: 0,
          participantIds: [],
          unreadCount: 0,
        },
      },
    },
    1,
  ));
  fixture.cache.applyDurableEvent({
    ...durable(
      "thread-created",
      CHAT_DURABLE_EVENT_TYPES.threadCreated,
      {
        conversation: {
          id: threadId,
          tenantId,
          type: "thread",
          visibility: "private",
          parentConversationId: conversationId,
          rootMessageId,
          memberUserIds: [userId],
          createdAt: "2026-08-26T10:00:01.000Z",
          updatedAt: "2026-08-26T10:00:01.000Z",
        },
      },
      1,
    ),
    streamId: threadId,
  });

  assert.equal((await fixture.client.sendMessage({ conversationId: threadId, content })).status, "success");
  const summaryAfterHttp = fixture.cache.getState().entities.messages[rootMessageId].threadSummary;
  assert.equal(summaryAfterHttp.replyCount, 1);
  assert.deepEqual(summaryAfterHttp.participantIds, [userId]);
  assert.equal(summaryAfterHttp.lastReplyAt, canonical.message.createdAt);

  assert.equal(fixture.cache.applyDurableEvent({
    ...durable(
      "reply-created",
      CHAT_DURABLE_EVENT_TYPES.messageCreated,
      { clientMessageId: "client-1", message: canonical.message },
      2,
    ),
    streamId: threadId,
  }).status, "applied");
  assert.equal(
    fixture.cache.getState().entities.messages[rootMessageId].threadSummary.replyCount,
    1,
  );
});

test("matching realtime success wins before HTTP and a conflicting late failure is ignored", async () => {
  let release;
  const fixture = createFixture({
    fetch: () => new Promise((resolve) => { release = resolve; }),
    commandOptions: { retry: { maxAttempts: 1 } },
  });
  const content = { format: "markdown", text: "socket first" };
  const send = fixture.client.sendMessage({ conversationId, content });
  const canonical = canonicalResult("client-1", content);
  const created = durable(
    "message-created",
    CHAT_DURABLE_EVENT_TYPES.messageCreated,
    { clientMessageId: "client-1", message: canonical.message },
    1,
  );
  assert.equal(fixture.cache.applyDurableEvent(created).status, "applied");
  assert.equal(fixture.cache.applyDurableEvent(created).status, "duplicate");
  assert.deepEqual(fixture.select(fixture.cache.getState()).map(({ id }) => id), [canonical.message.id]);

  await new Promise(setImmediate);
  release(response({ error: { code: "rejected", message: "no" } }, { ok: false, status: 422 }));
  assert.equal((await send).status, "rejected");
  const afterFailure = fixture.select(fixture.cache.getState());
  assert.deepEqual(afterFailure.map(({ id }) => id), [canonical.message.id]);
  assert.equal("delivery" in afterFailure[0], false);
});

test("a nonmember send is rejected without retry while authorized sending stays available", async () => {
  const requests = [];
  const fixture = createFixture({
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.includes("/empty-room/")) {
        return response(
          { error: { code: "CHAT_AUTHORIZATION_FAILED", message: "Chat authorization failed" } },
          { ok: false, status: 403 },
        );
      }
      return response(canonicalResult(body.clientMessageId, body.content));
    },
  });
  const result = await fixture.client.sendMessage({
    conversationId: "empty-room",
    content: { format: "plain", text: "Keep this draft" },
  });
  assert.deepEqual(result, {
    status: "rejected",
    message: "The chat server rejected the command.",
    httpStatus: 403,
  });
  const [failed] = createConversationMessagesSelector("empty-room")(fixture.cache.getState());
  assert.equal(failed.delivery.failure, "rejected");
  assert.equal(failed.delivery.retryable, false);
  assert.equal(failed.content.text, "Keep this draft");
  assert.equal(requests.length, 1);
  assert.equal((await fixture.client.sendMessage({
    conversationId,
    content: { format: "plain", text: "General still works" },
  })).status, "success");
  assert.equal(requests.length, 2);
  fixture.client.close();
});

test("automatic transient retry reuses logical identity and leaves stable ordering", async () => {
  const requests = [];
  const content = { format: "plain", text: "retry automatically" };
  const fixture = createFixture({
    commandOptions: { retry: { maxAttempts: 2, wait: async () => {} } },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ body, key: init.headers["idempotency-key"] });
      if (requests.length === 1) throw new Error("offline");
      return response(canonicalResult(body.clientMessageId, body.content));
    },
  });
  const result = await fixture.client.sendMessage({ conversationId, content });
  assert.equal(result.status, "success");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.clientMessageId, requests[1].body.clientMessageId);
  assert.equal(requests[0].key, requests[1].key);
  assert.deepEqual(fixture.select(fixture.cache.getState()).map(({ sequence }) => sequence), [1]);
});

test("manual retry keeps clientMessageId/idempotency and attachment metadata", async () => {
  const requests = [];
  const fixture = createFixture({
    commandOptions: { retry: { maxAttempts: 1 } },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ body, key: init.headers["idempotency-key"] });
      if (requests.length === 1) throw new Error("disconnected");
      return response(canonicalResult(body.clientMessageId, body.content));
    },
  });
  fixture.cache.applyDurableEvent({
    ...durable("attachment-ready", CHAT_DURABLE_EVENT_TYPES.attachmentUpdated, {
      attachment: {
        attachmentId: "attachment-1",
        fileName: "one.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        downloadUrl: "/attachments/1",
      },
    }, 1),
    streamId: conversationId,
  });
  fixture.cache.setAttachmentUploadState({
    uploadId: "upload-attachment-1",
    conversationId,
    metadata: {
      fileName: "one.txt",
      contentType: "text/plain",
      sizeBytes: 3,
    },
    status: "finalized",
    progress: { uploadedBytes: 3, totalBytes: 3 },
    attachment: {
      status: "finalized",
      attachmentId: "attachment-1",
      metadata: {
        fileName: "one.txt",
        contentType: "text/plain",
        sizeBytes: 3,
      },
      createdAt: "2026-08-26T10:00:00.000Z",
      expiresAt: "2026-08-26T11:00:00.000Z",
      checksum: `sha256:${"a".repeat(64)}`,
      finalizedAt: "2026-08-26T10:01:00.000Z",
    },
  });
  const content = {
    format: "plain",
    text: "with attachment",
    mentions: [{ type: "user", userId: "user-b" }],
    attachments: [{ attachmentId: "attachment-1" }],
  };
  assert.equal((await fixture.client.sendMessage({ conversationId, content })).status, "transport");
  const failed = fixture.select(fixture.cache.getState());
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].delivery, {
    state: "failed",
    clientMessageId: "client-1",
    idempotencyKey: "send-1",
    retryable: true,
    attempt: 1,
    failure: "transport",
  });
  assert.equal(failed[0].attachmentMetadata[0].attachmentId, "attachment-1");

  assert.equal((await fixture.client.retryMessage("client-1")).status, "success");
  assert.equal(requests[0].body.clientMessageId, requests[1].body.clientMessageId);
  assert.equal(requests[0].key, requests[1].key);
  const settled = fixture.select(fixture.cache.getState());
  assert.equal(settled.length, 1);
  assert.equal(settled[0].attachmentMetadata[0].attachmentId, "attachment-1");
  assert.equal("delivery" in settled[0], false);
});

test("invalid content and unknown attachment references never reach transport", async () => {
  let requests = 0;
  const fixture = createFixture({ fetch: async () => { requests += 1; throw new Error("unexpected"); } });
  assert.equal((await fixture.client.sendMessage({
    conversationId,
    content: { format: "plain", text: "x", attachments: [{ attachmentId: "missing" }] },
  })).status, "validation");
  assert.equal((await fixture.client.sendMessage({
    conversationId,
    content: { format: "plain", text: "x", mentions: [{ type: "user", userId: "" }] },
  })).status, "validation");
  assert.equal(requests, 0);
  assert.deepEqual(fixture.select(fixture.cache.getState()), []);
});

test("multiple pending sends keep authoring order and reconcile without duplicate rows", async () => {
  const releases = [];
  const fixture = createFixture({
    fetch: () => new Promise((resolve) => releases.push(resolve)),
  });
  const first = fixture.client.sendMessage({
    conversationId,
    content: { format: "plain", text: "first" },
  });
  const second = fixture.client.sendMessage({
    conversationId,
    content: { format: "plain", text: "second" },
  });
  assert.deepEqual(
    fixture.select(fixture.cache.getState()).map((message) => message.content.text),
    ["first", "second"],
  );
  await new Promise(setImmediate);
  releases[1](response(canonicalResult("client-2", { format: "plain", text: "second" }, {
    id: "canonical-second",
    sequence: 2,
  })));
  releases[0](response(canonicalResult("client-1", { format: "plain", text: "first" }, {
    id: "canonical-first",
    sequence: 1,
  })));
  await Promise.all([first, second]);
  const settled = fixture.select(fixture.cache.getState());
  assert.deepEqual(settled.map(({ id }) => id), ["canonical-first", "canonical-second"]);
  assert.equal(new Set(settled.map(({ id }) => id)).size, 2);
});

for (const destination of [conversationId, "thread-existing"]) {
  for (const notifyAuthor of [true, false]) {
    for (const eventFirst of [true, false]) {
      test(`inline reply retains ${destination}, ping=${notifyAuthor}, eventFirst=${eventFirst}`, async () => {
        let release;
        const requests = [];
        const fixture = createFixture({ fetch: (url, init) => {
          if (init.method === "GET") return Promise.resolve(response({}, { ok: false, status: 503 }));
          requests.push({ url, body: JSON.parse(init.body) });
          return new Promise(resolve => { release = resolve; });
        } });
        if (destination !== conversationId) fixture.cache.applyDurableEvent(durable(
          "root-for-thread", CHAT_DURABLE_EVENT_TYPES.messageCreated, {
            message: { ...canonicalResult("root", { format: "plain", text: "root" }).message,
              id: "root", threadSummary: { threadId: destination, replyCount: 0, participantIds: [], unreadCount: 0 } },
          }, 1));
        if (destination !== conversationId) fixture.cache.applyDurableEvent({
          ...durable("existing-thread", CHAT_DURABLE_EVENT_TYPES.threadCreated, {
            conversation: { id: destination, tenantId, type: "thread", visibility: "public",
              parentConversationId: conversationId, rootMessageId: "root", memberUserIds: [userId],
              createdAt: "2026-08-26T10:00:00.000Z", updatedAt: "2026-08-26T10:00:00.000Z" },
          }, 0), streamId: destination,
        });
        const select = createConversationMessagesSelector(destination);
        const replyTo = { messageId: "source", notifyAuthor };
        const content = { format: "plain", text: "Friday" };
        const send = fixture.client.sendMessage({ conversationId: destination, content, replyTo });
        assert.deepEqual(select(fixture.cache.getState())[0].replyTo, replyTo);
        assert.equal(select(fixture.cache.getState())[0].conversationId, destination);
        await new Promise(setImmediate);
        assert.equal(requests[0].url, `/api/chat/conversations/${destination}/messages`);
        assert.deepEqual(requests[0].body.replyTo, replyTo);
        const canonical = canonicalResult("client-1", content, { conversationId: destination });
        canonical.message.replyTo = replyTo;
        const created = { ...durable("reply-event", CHAT_DURABLE_EVENT_TYPES.messageCreated,
          { clientMessageId: "client-1", message: canonical.message }, 1), streamId: destination };
        if (eventFirst) fixture.cache.applyDurableEvent(created);
        release(response(canonical));
        assert.equal((await send).status, "success");
        if (!eventFirst) fixture.cache.applyDurableEvent(created);
        fixture.cache.applyDurableEvent(created);
        assert.equal(select(fixture.cache.getState()).length, 1);
        assert.deepEqual(select(fixture.cache.getState())[0].replyTo, replyTo);
        assert.equal(select(fixture.cache.getState())[0].content.mentions, undefined);
        assert.equal(Object.keys(fixture.cache.getState().entities.conversations).length, destination === conversationId ? 1 : 2);
        fixture.client.close();
      });
    }
  }
}

test("reply retry retains detached destination, keys, ping and nested content under caller mutation", async () => {
  const requests = [];
  const fixture = createFixture({ commandOptions: { retry: { maxAttempts: 1 } }, fetch: async (url, init) => {
    if (init.method === "GET") return response({}, { ok: false, status: 503 });
    const body = JSON.parse(init.body);
    requests.push({ url, body, key: init.headers["idempotency-key"] });
    if (requests.length === 1) throw new Error("offline");
    const result = canonicalResult(body.clientMessageId, body.content);
    result.message.replyTo = body.replyTo;
    return response(result);
  } });
  const authored = { conversationId, replyTo: { messageId: "source", notifyAuthor: true },
    content: { format: "plain", text: "original", blocks: [{ type: "card", data: { label: "original" } }] } };
  const original = structuredClone(authored);
  const send = fixture.client.sendMessage(authored);
  authored.conversationId = "elsewhere";
  authored.replyTo.messageId = "another-source";
  authored.replyTo.notifyAuthor = false;
  authored.content.text = "edited";
  authored.content.blocks[0].data.label = "edited";
  assert.equal((await send).status, "transport");
  const failed = fixture.select(fixture.cache.getState())[0];
  assert.deepEqual(failed.replyTo, original.replyTo);
  assert.ok(Object.isFrozen(failed.replyTo));
  assert.ok(Object.isFrozen(failed.content.blocks[0].data));
  assert.equal((await fixture.client.retryMessage("client-1")).status, "success");
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1].body.replyTo, original.replyTo);
  assert.deepEqual(requests[1].body.content, original.content);
  fixture.client.close();
});

test("authored reply references use canonical validation", async () => {
  let calls = 0;
  const fixture = createFixture({ fetch: async () => { calls++; throw new Error("unexpected"); } });
  for (const replyTo of [{ messageId: "", notifyAuthor: true }, { messageId: "source", notifyAuthor: "yes" },
    { messageId: "source", notifyAuthor: true, authorId: "invented" }]) {
    assert.equal((await fixture.client.sendMessage({ conversationId, content: { format: "plain", text: "reply" }, replyTo })).status, "validation");
  }
  assert.equal(calls, 0);
  fixture.client.close();
});

test("reply success clears the authored conversation draft even if the caller changes destination", async () => {
  let release;
  const fixture = createFixture({ fetch: (url) => url.endsWith("/messages")
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response({})) });
  const otherId = "other-draft";
  fixture.cache.applyDurableEvent({ ...durable("other-conversation", CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    { conversation: { id: otherId, tenantId, type: "channel", visibility: "public", name: "Other",
      createdAt: "2026-08-26T10:00:00.000Z", updatedAt: "2026-08-26T10:00:00.000Z" } }, 0), streamId: otherId });
  const content = { format: "plain", text: "Friday", attachments: [] };
  fixture.client.replaceConversationDraft({ conversationId, content });
  fixture.client.replaceConversationDraft({ conversationId: otherId, content: { ...content, text: "keep" } });
  const replyTo = { messageId: "source", notifyAuthor: false };
  const authored = { conversationId, content, replyTo };
  const send = fixture.client.sendMessage(authored);
  authored.conversationId = otherId;
  await new Promise(setImmediate);
  const canonical = canonicalResult("client-1", content);
  canonical.message.replyTo = replyTo;
  release(response(canonical));
  assert.equal((await send).status, "success");
  assert.equal(fixture.client.selectConversationDraft(conversationId).draft.kind, "clear_tombstone");
  assert.equal(fixture.client.selectConversationDraft(otherId).draft.content.text, "keep");
  fixture.client.close();
});
