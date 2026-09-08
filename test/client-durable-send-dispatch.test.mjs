import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const now = "2026-09-02T12:00:00.000Z";
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const storageIdentity = (userId = "user-a", deviceId = "device-a") => ({
  tenantId: "tenant-a",
  userId,
  deviceId,
});
const cacheIdentity = (userId = "user-a", sessionId = "session-a") => ({
  tenantId: "tenant-a",
  userId,
  sessionId,
});
const recordKey = (identity, kind) =>
  `${identity.tenantId}\0${identity.userId}\0${identity.deviceId}\0${kind}`;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const errorResponse = (status, code = "CHAT_COMMAND_REJECTED") =>
  response(status, { error: { code, message: "A generic server error" } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const eventually = async (predicate, message = "condition was not reached") => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

function createStorageHarness() {
  const rows = new Map();
  const calls = [];
  let queuedReplaceGate;
  let queuedReplaceFailure;
  const storage = createApplicationChatStorage({
    async read(identity, kind) {
      calls.push({ operation: "read", identity, kind });
      return rows.get(recordKey(identity, kind)) ?? null;
    },
    async replace(identity, kind, encoded) {
      calls.push({ operation: "replace", identity, kind, encoded });
      if (kind === ApplicationChatStorageRecordKind.queuedSendMessageIntents) {
        if (queuedReplaceGate !== undefined) await queuedReplaceGate.promise;
        if (queuedReplaceFailure !== undefined) throw queuedReplaceFailure;
      }
      rows.set(recordKey(identity, kind), encoded);
    },
    async remove(identity, kind) {
      calls.push({ operation: "remove", identity, kind });
      rows.delete(recordKey(identity, kind));
    },
    async clearForLogout(identity) {
      calls.push({ operation: "clearForLogout", identity });
      for (const kind of Object.values(ApplicationChatStorageRecordKind)) {
        rows.delete(recordKey(identity, kind));
      }
    },
  });
  return {
    rows,
    calls,
    storage,
    setQueuedReplaceGate(value) { queuedReplaceGate = value; },
    setQueuedReplaceFailure(value) { queuedReplaceFailure = value; },
    queuedWrites() {
      return calls.filter(({ operation, kind }) =>
        operation === "replace" &&
        kind === ApplicationChatStorageRecordKind.queuedSendMessageIntents);
    },
  };
}

function successfulSend(body, identity, id = "message-canonical") {
  return response(200, {
    operation: "send",
    reconciliationStatus: "applied",
    clientMessageId: body.clientMessageId,
    message: {
      id,
      tenantId: identity.tenantId,
      conversationId: body.conversationId,
      author: { type: "user", userId: identity.userId },
      sequence: 1,
      createdAt: now,
      updatedAt: now,
      revision: { revision: 1 },
      content: body.content,
    },
    canonicalRevision: 1,
  });
}

async function createFixture({ command, identityRef, cache, harness } = {}) {
  const storageHarness = harness ?? createStorageHarness();
  const trustedIdentity = identityRef ?? { current: storageIdentity() };
  const normalizedCache = cache ?? createNormalizedChatCache(cacheIdentity());
  const commandRequests = [];
  let generated = 0;
  const client = createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: () => "access-token-secret",
    cache: normalizedCache,
    fetch: async (url, init) => {
      if (init.method === "GET") return response(200, metadata);
      const body = JSON.parse(init.body);
      const request = { url, init, body };
      commandRequests.push(request);
      return command?.(request, trustedIdentity.current, commandRequests.length) ??
        successfulSend(body, trustedIdentity.current);
    },
    commands: { retry: { maxAttempts: 1 } },
    optimisticMessages: {
      generateClientMessageId: () => `client-${++generated}`,
      generateIdempotencyKey: () => `idempotency-${generated}`,
      now: () => Date.parse(now),
    },
    normalizedCachePersistence: {
      storage: storageHarness.storage,
      resolveIdentity: () => trustedIdentity.current,
    },
  });
  assert.equal((await client.start()).state, "ready");
  return { client, cache: normalizedCache, commandRequests, identityRef: trustedIdentity, harness: storageHarness };
}

test("persists before fetch and dispatches the queued request correlation unchanged", async () => {
  const gate = deferred();
  const harness = createStorageHarness();
  harness.setQueuedReplaceGate(gate);
  const fixture = await createFixture({ harness });
  const observed = [];
  fixture.client.subscribeSendMessageQueue((state) => observed.push(state));

  const pending = fixture.client.sendMessage({
    conversationId: "conversation-a",
    content: { format: "markdown", text: "durable **message**", attachments: [] },
  });
  await eventually(() => harness.queuedWrites().length === 1);
  assert.equal(fixture.commandRequests.length, 0);
  assert.equal(fixture.client.getSendMessageQueueState().intents.length, 0);

  gate.resolve();
  assert.equal((await pending).status, "success");
  assert.equal(fixture.commandRequests.length, 1);
  const [{ body, init }] = fixture.commandRequests;
  assert.equal(body.clientMessageId, "client-1");
  assert.equal(body.idempotencyKey, "idempotency-1");
  assert.equal(init.headers["idempotency-key"], body.idempotencyKey);
  assert.deepEqual(
    body,
    observed.find(({ intents }) => intents.length === 1).intents[0].request,
  );
  assert.equal(harness.queuedWrites()[0].encoded.includes(body.clientMessageId), true);
  assert.equal(harness.queuedWrites()[0].encoded.includes(body.idempotencyKey), true);
  assert.equal(fixture.client.getSendMessageQueueState().intents.length, 0);
  assert.equal(observed.some(({ intents }) => intents.length === 1), true);
  fixture.client.close();
});

test("terminal HTTP outcomes remove the exact durable intent", async (t) => {
  for (const [name, status, code, expected] of [
    ["validation rejection", 422, "CHAT_INVALID_COMMAND", "rejected"],
    ["authentication", 401, "CHAT_AUTHENTICATION_FAILED", "authentication"],
    ["authorization", 403, "CHAT_AUTHORIZATION_FAILED", "rejected"],
    ["conflict", 409, "CHAT_CONFLICT", "conflict"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({
        command: () => errorResponse(status, code),
      });
      const result = await fixture.client.sendMessage({
        conversationId: "conversation-a",
        content: { format: "plain", text: name },
      });
      assert.equal(result.status, expected);
      assert.equal(fixture.client.getSendMessageQueueState().intents.length, 0);
      fixture.client.close();
    });
  }
});

test("transport, 429, retryable HTTP, and ambiguous responses retain correlation", async (t) => {
  for (const [name, command, expected] of [
    ["transport", () => { throw new Error("offline"); }, "transport"],
    ["rate limit", () => errorResponse(429, "CHAT_RATE_LIMITED"), "transport"],
    ["temporary server", () => errorResponse(503, "CHAT_TEMPORARY"), "transport"],
    ["malformed success", () => response(200, { invalid: true }), "malformed_response"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ command });
      const result = await fixture.client.sendMessage({
        conversationId: "conversation-a",
        content: { format: "plain", text: name },
      });
      assert.equal(result.status, expected);
      const [intent] = fixture.client.getSendMessageQueueState().intents;
      assert.equal(intent.clientMessageId, "client-1");
      assert.equal(intent.idempotencyKey, "idempotency-1");
      fixture.client.close();
    });
  }
});

test("cancellation is durable and observable without another dispatch", async () => {
  const fixture = await createFixture({
    command: () => { throw new Error("offline"); },
  });
  assert.equal((await fixture.client.sendMessage({
    conversationId: "conversation-a",
    content: { format: "plain", text: "retain me" },
  })).status, "transport");
  const states = [];
  fixture.client.subscribeSendMessageQueue((state) => states.push(state));
  const commandCount = fixture.commandRequests.length;
  assert.equal(await fixture.client.cancelQueuedMessage("client-1"), true);
  assert.equal(fixture.client.getSendMessageQueueState().intents.length, 0);
  assert.equal(states.at(-1).intents.length, 0);
  assert.equal(fixture.commandRequests.length, commandCount);
  assert.equal(fixture.harness.rows.has(recordKey(
    storageIdentity(),
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
  )), false);
  fixture.client.close();
});

test("storage failure and unfinished attachments prevent persistence or command fetch", async (t) => {
  await t.test("queued write failure", async () => {
    const harness = createStorageHarness();
    harness.setQueuedReplaceFailure(new Error("write failed"));
    const fixture = await createFixture({ harness });
    const result = await fixture.client.sendMessage({
      conversationId: "conversation-a",
      content: { format: "plain", text: "must not dispatch" },
    });
    assert.equal(result.status, "validation");
    assert.equal(fixture.commandRequests.length, 0);
    assert.equal(fixture.client.getSendMessageQueueState().intents.length, 0);
    fixture.client.close();
  });

  await t.test("unfinalized attachment", async () => {
    const cache = createNormalizedChatCache(cacheIdentity());
    const attachmentMetadata = {
      attachmentId: "attachment-a",
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      downloadUrl: "/download/attachment-a",
    };
    const createdAt = now;
    const pending = {
      status: "pending",
      attachmentId: "attachment-a",
      metadata: {
        fileName: "notes.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      },
      createdAt,
      expiresAt: "2026-09-02T12:05:00.000Z",
    };
    cache.setAttachmentUploadState({
      uploadId: "upload-a",
      conversationId: "conversation-a",
      metadata: pending.metadata,
      status: "finalized",
      progress: { uploadedBytes: 5, totalBytes: 5 },
      attachment: {
        ...pending,
        status: "finalized",
        checksum: `sha256:${"a".repeat(64)}`,
        finalizedAt: "2026-09-02T12:00:01.000Z",
      },
    }, attachmentMetadata);
    cache.setAttachmentUploadState({
      uploadId: "upload-a",
      conversationId: "conversation-a",
      metadata: pending.metadata,
      status: "failed",
      progress: { uploadedBytes: 5, totalBytes: 5 },
    });
    const fixture = await createFixture({ cache });
    const writesBefore = fixture.harness.queuedWrites().length;
    const result = await fixture.client.sendMessage({
      conversationId: "conversation-a",
      content: {
        format: "plain",
        text: "unfinished",
        attachments: [{ attachmentId: "attachment-a" }],
      },
    });
    assert.equal(result.status, "validation");
    assert.equal(fixture.harness.queuedWrites().length, writesBefore);
    assert.equal(fixture.commandRequests.length, 0);
    fixture.client.close();
  });
});

test("a delayed old-generation completion cannot settle the active identity queue", async () => {
  const firstCommand = deferred();
  const identityRef = { current: storageIdentity("user-a", "device-a") };
  const fixture = await createFixture({
    identityRef,
    command: (request, identity, count) => count === 1
      ? firstCommand.promise
      : Promise.reject(new Error("offline")),
  });
  const oldSend = fixture.client.sendMessage({
    conversationId: "conversation-a",
    content: { format: "plain", text: "old identity" },
  });
  await eventually(() => fixture.commandRequests.length === 1);
  fixture.client.close();

  identityRef.current = storageIdentity("user-b", "device-b");
  assert.equal((await fixture.client.start()).state, "ready");
  fixture.cache.setIdentity(cacheIdentity("user-b", "session-b"));
  assert.equal((await fixture.client.sendMessage({
    conversationId: "conversation-b",
    content: { format: "plain", text: "active identity" },
  })).status, "transport");
  const activeBefore = fixture.client.getSendMessageQueueState();
  assert.equal(activeBefore.identity.userId, "user-b");
  assert.equal(activeBefore.intents.length, 1);

  const oldBody = fixture.commandRequests[0].body;
  firstCommand.resolve(successfulSend(oldBody, storageIdentity("user-a", "device-a"), "old-message"));
  await oldSend;
  await new Promise((resolve) => setImmediate(resolve));
  const activeAfter = fixture.client.getSendMessageQueueState();
  assert.equal(activeAfter.identity.userId, "user-b");
  assert.deepEqual(
    activeAfter.intents.map(({ clientMessageId, idempotencyKey }) => ({ clientMessageId, idempotencyKey })),
    activeBefore.intents.map(({ clientMessageId, idempotencyKey }) => ({ clientMessageId, idempotencyKey })),
  );
  fixture.client.close();
});
