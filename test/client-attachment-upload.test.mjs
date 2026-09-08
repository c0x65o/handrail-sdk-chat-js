import assert from "node:assert/strict";
import test from "node:test";

import { createChatClient, createNormalizedChatCache } from "@handrail/chat/client";

const metadata = Object.freeze({
  fileName: "notes.txt",
  contentType: "text/plain",
  sizeBytes: 5,
});
const source = new Uint8Array([1, 2, 3, 4, 5]);
const checksum = `sha256:${"a".repeat(64)}`;

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const states = (attachmentId = "attachment-1") => {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const finalizedAt = new Date(now + 1_000).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const pending = { status: "pending", attachmentId, metadata, createdAt, expiresAt };
  return {
    pending,
    finalized: { ...pending, status: "finalized", checksum, finalizedAt },
    rejected: {
      ...pending,
      status: "rejected",
      rejectionReason: "checksum_mismatch",
      rejectedAt: finalizedAt,
    },
    abandoned: { ...pending, status: "abandoned", abandonedAt: finalizedAt },
    upload: {
      kind: "opaque_attachment_upload",
      descriptor: "https://storage.invalid/upload?token=provider-secret",
      expiresAt: new Date(now + 30_000).toISOString(),
    },
  };
};

const createLifecycleFetch = ({ finalOutcome = "finalized", onRequest, upload } = {}) => {
  const lifecycle = states();
  return async (url, init) => {
    const body = JSON.parse(init.body);
    onRequest?.({ url, init, body });
    if (body.operation === "prepare_attachment") {
      return response({
        operation: "prepare_attachment",
        reconciliationStatus: "applied",
        idempotencyKey: body.idempotencyKey,
        attachment: lifecycle.pending,
        upload: upload ?? lifecycle.upload,
      });
    }
    if (body.operation === "abort_attachment") {
      return response({
        operation: "abort_attachment",
        reconciliationStatus: "applied",
        idempotencyKey: body.idempotencyKey,
        attachmentId: body.attachmentId,
        attachment: lifecycle.abandoned,
      });
    }
    if (body.operation === "finalize_attachment") {
      const attachment = finalOutcome === "rejected"
        ? lifecycle.rejected
        : lifecycle.finalized;
      return response({
        operation: "finalize_attachment",
        reconciliationStatus: "applied",
        idempotencyKey: body.idempotencyKey,
        attachmentId: body.attachmentId,
        outcome: finalOutcome,
        attachment,
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
};

const createClient = ({ fetch, transport, cache, diagnostics, resource, identities } = {}) => {
  let identityIndex = 0;
  const generated = identities ?? ["upload-1", "prepare-1", "finalize-1", "abort-1"];
  return createChatClient({
    endpoint: "https://chat.invalid/api",
    getAccessToken: async () => "chat-access-token-secret",
    fetch,
    cache,
    commands: {
      retry: { maxAttempts: 2, backoffMs: () => 0, wait: async () => {} },
      onDiagnostic: (event) => diagnostics?.push(event),
    },
    attachments: {
      transport,
      generateUploadId: () => generated[identityIndex++],
      generateIdempotencyKey: () => generated[identityIndex++],
      maxSafeTransferAttempts: 2,
      cleanupTimeoutMs: 100,
    },
  });
};

test("prepare-transfer-progress-finalize exposes only canonical safe state", async () => {
  const diagnostics = [];
  const requests = [];
  const progress = [];
  const cache = createNormalizedChatCache();
  cache.subscribe(
    (state) => state.attachmentUploads["upload-1"]?.progress.uploadedBytes,
    (value) => progress.push(value),
  );
  let receivedDescriptor;
  const client = createClient({
    cache,
    diagnostics,
    fetch: createLifecycleFetch({ onRequest: (request) => requests.push(request) }),
    transport: async (request) => {
      receivedDescriptor = request.upload.descriptor;
      request.onProgress(2);
      request.onProgress(5);
      return { status: "uploaded" };
    },
  });

  const handle = client.uploadAttachment({ conversationId: "conversation-1", metadata, source });
  const result = await handle.completion;
  assert.equal(result.status, "finalized");
  assert.equal(receivedDescriptor.includes("provider-secret"), true);
  assert.deepEqual(progress.filter((value) => value !== undefined), [0, 2, 5]);
  assert.equal(handle.state.status, "finalized");
  assert.equal(handle.state.progress.uploadedBytes, 5);
  assert.equal(requests.map(({ body }) => body.operation).join(","),
    "prepare_attachment,finalize_attachment");

  const serialized = JSON.stringify({ state: cache.getState(), diagnostics, result, handle });
  for (const forbidden of [
    "provider-secret",
    "chat-access-token-secret",
    "opaque_attachment_upload",
    "authorization",
    "headers",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  const leakedCanonicalState = JSON.parse(JSON.stringify(cache.getState()));
  leakedCanonicalState.attachmentUploads["upload-1"].descriptor =
    "opaque-provider-secret";
  assert.equal(cache.hydrateCanonicalState(leakedCanonicalState), false);
});

test("default transport consumes canonical opaque upload instructions", async () => {
  const instructions = {
    url: "https://storage.invalid/upload?token=provider-secret",
    method: "PUT",
    headers: { "x-upload-fixture": "canonical" },
  };
  const upload = {
    ...states().upload,
    descriptor: Buffer.from(JSON.stringify(instructions), "utf8").toString("base64url"),
  };
  const originalFetch = globalThis.fetch;
  const transfers = [];
  let client;
  try {
    globalThis.fetch = async (url, init) => {
      transfers.push({ url: String(url), init });
      return { ok: true, status: 204 };
    };
    client = createClient({ fetch: createLifecycleFetch({ upload }) });
    const result = await client.uploadAttachment({
      conversationId: "conversation-1",
      metadata,
      source,
    }).completion;
    assert.equal(result.status, "finalized");
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].url, instructions.url);
    assert.equal(transfers[0].init.method, "PUT");
    assert.deepEqual(transfers[0].init.headers, instructions.headers);
    assert.equal(transfers[0].init.credentials, "omit");
    assert.equal(transfers[0].init.redirect, "error");
  } finally {
    client?.close();
    globalThis.fetch = originalFetch;
  }
});

test("cancel during transfer stops progress and performs a stable best-effort abort", async () => {
  const requests = [];
  let releaseTransfer;
  let reportProgress;
  const transferStarted = new Promise((resolve) => { releaseTransfer = resolve; });
  const client = createClient({
    fetch: createLifecycleFetch({ onRequest: (request) => requests.push(request) }),
    transport: async (request) => {
      reportProgress = request.onProgress;
      releaseTransfer();
      return new Promise(() => {});
    },
  });
  const handle = client.uploadAttachment({ conversationId: "conversation-1", metadata, source });
  await transferStarted;
  reportProgress(2);
  handle.cancel();
  const result = await handle.completion;
  reportProgress(5);

  assert.equal(result.status, "cancelled");
  assert.equal(handle.state.status, "abandoned");
  assert.equal(handle.state.progress.uploadedBytes, 2);
  assert.deepEqual(requests.map(({ body }) => body.operation), [
    "prepare_attachment",
    "abort_attachment",
  ]);
  assert.equal(requests[1].body.idempotencyKey, "abort-1");
});

test("safe route and explicitly safe transfer retries retain stable identities", async () => {
  const requests = [];
  let prepareAttempts = 0;
  const baseFetch = createLifecycleFetch({ onRequest: (request) => requests.push(request) });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.operation === "prepare_attachment" && prepareAttempts++ === 0) {
      requests.push({ url, init, body });
      throw new Error("transient network detail must not escape");
    }
    return baseFetch(url, init);
  };
  const descriptors = [];
  let transferAttempts = 0;
  const client = createClient({
    fetch,
    transport: async ({ upload }) => {
      descriptors.push(upload.descriptor);
      transferAttempts += 1;
      return transferAttempts === 1
        ? { status: "failed", retry: "safe" }
        : { status: "uploaded" };
    },
  });
  const result = await client.uploadAttachment({
    conversationId: "conversation-1",
    metadata,
    source,
  }).completion;

  assert.equal(result.status, "finalized");
  const prepares = requests.filter(({ body }) => body.operation === "prepare_attachment");
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0].body.idempotencyKey, "prepare-1");
  assert.equal(prepares[1].body.idempotencyKey, "prepare-1");
  assert.equal(prepares[0].init.headers["idempotency-key"], "prepare-1");
  assert.equal(prepares[1].init.headers["idempotency-key"], "prepare-1");
  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0], descriptors[1]);
});

test("checksum rejection is canonical terminal state and never aborts", async () => {
  const requests = [];
  const client = createClient({
    fetch: createLifecycleFetch({
      finalOutcome: "rejected",
      onRequest: (request) => requests.push(request),
    }),
    transport: async () => ({ status: "uploaded" }),
  });
  const handle = client.uploadAttachment({ conversationId: "conversation-1", metadata, source });
  const result = await handle.completion;
  assert.equal(result.status, "rejected");
  assert.equal(result.attachment.rejectionReason, "checksum_mismatch");
  assert.equal(handle.state.status, "rejected");
  assert.equal(requests.some(({ body }) => body.operation === "abort_attachment"), false);
});

test("transport failures cannot expose descriptor, token, or provider internals", async () => {
  const diagnostics = [];
  const client = createClient({
    diagnostics,
    fetch: createLifecycleFetch(),
    transport: async () => {
      throw new Error(
        "provider-secret token=raw storageKey=private headers=Authorization",
      );
    },
  });
  const handle = client.uploadAttachment({ conversationId: "conversation-1", metadata, source });
  const result = await handle.completion;
  assert.deepEqual(result, { status: "failed", phase: "transfer" });
  const serialized = JSON.stringify({ result, state: handle.state, diagnostics });
  for (const forbidden of [
    "provider-secret",
    "token=raw",
    "storageKey",
    "Authorization",
    "opaque_attachment_upload",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("client close cancels transfer, aborts prepared state, and revokes temporary resources", async () => {
  const requests = [];
  let started;
  const transferStarted = new Promise((resolve) => { started = resolve; });
  let revocations = 0;
  const client = createClient({
    fetch: createLifecycleFetch({ onRequest: (request) => requests.push(request) }),
    transport: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const handle = client.uploadAttachment({
    conversationId: "conversation-1",
    metadata,
    source,
    temporaryResource: { revoke() { revocations += 1; } },
  });
  await transferStarted;
  client.close();
  const result = await handle.completion;
  client.close();

  assert.equal(result.status, "cancelled");
  assert.equal(handle.state.status, "abandoned");
  assert.equal(revocations, 1);
  assert.equal(requests.some(({ body }) => body.operation === "abort_attachment"), true);
});

test("send and retry reject every non-finalized attachment state before transport", async () => {
  const cache = createNormalizedChatCache({
    tenantId: "tenant-1",
    userId: "user-1",
    sessionId: "session-1",
  });
  let sendCalls = 0;
  const client = createClient({
    cache,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.operation === "send") {
        sendCalls += 1;
        throw new Error("offline");
      }
      return createLifecycleFetch()(url, init);
    },
    transport: async () => ({ status: "uploaded" }),
  });
  const lifecycle = states();
  const messageMetadata = {
    attachmentId: lifecycle.finalized.attachmentId,
    fileName: metadata.fileName,
    contentType: metadata.contentType,
    sizeBytes: metadata.sizeBytes,
    downloadUrl: "/safe-download",
  };
  const uploadState = (status, attachment) => ({
    uploadId: "manual-upload",
    conversationId: "conversation-1",
    metadata,
    status,
    progress: { uploadedBytes: status === "pending" ? 0 : 5, totalBytes: 5 },
    attachment,
  });
  cache.setAttachmentUploadState(uploadState("finalized", lifecycle.finalized), messageMetadata);
  const content = {
    format: "plain",
    text: "attachment",
    attachments: [{ attachmentId: lifecycle.finalized.attachmentId }],
  };
  assert.equal((await client.sendMessage({ conversationId: "conversation-1", content })).status,
    "transport");
  const initialSendCalls = sendCalls;
  assert.equal(initialSendCalls, 2);
  const failedClientMessageId = Object.values(cache.getState().entities.messages)
    .find((message) => "delivery" in message)?.delivery.clientMessageId;
  assert.equal(typeof failedClientMessageId, "string");

  for (const [status, attachment] of [
    ["pending", lifecycle.pending],
    ["uploading", lifecycle.pending],
    ["rejected", lifecycle.rejected],
    ["abandoned", lifecycle.abandoned],
  ]) {
    cache.setAttachmentUploadState(uploadState(status, attachment));
    assert.equal((await client.sendMessage({ conversationId: "conversation-1", content })).status,
      "validation", status);
    assert.equal((await client.retryMessage(failedClientMessageId)).status, "validation", status);
  }
  assert.equal(sendCalls, initialSendCalls);
});
