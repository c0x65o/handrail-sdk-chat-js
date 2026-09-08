import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";


import {
  ATTACHMENT_LIFECYCLE_ROUTE,
  CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
  CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
  CHAT_AUTHENTICATION_ERROR_CODE,
  MAX_ATTACHMENT_LIFECYCLE_REQUEST_BYTES,
  MAX_ATTACHMENT_LIFECYCLE_RESPONSE_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const checksum = (character = "a") => `sha256:${character.repeat(64)}`;
const lifecyclePath = (attachmentId) =>
  ATTACHMENT_LIFECYCLE_ROUTE.replace(
    ":attachmentId",
    encodeURIComponent(attachmentId),
  );
const finalizeInput = (attachmentId, idempotencyKey = `finalize-${attachmentId}`) => ({
  operation: "finalize_attachment",
  attachmentId,
  idempotencyKey,
});
const forbiddenResponseFragments = [
  "private/tenant",
  "provider-secret",
  "credential=hidden",
  "verification-internal",
  "raw-provider-response",
  "storage_key",
  "storageKey",
  "objectKey",
  "signed-provider-url",
  "Bearer storage-secret",
];

const materializeResponse = async (response) => {
  const text = await response.text();
  assert.ok(
    Buffer.byteLength(text) <= MAX_ATTACHMENT_LIFECYCLE_RESPONSE_BYTES,
  );
  for (const fragment of forbiddenResponseFragments) {
    assert.equal(text.includes(fragment), false, fragment);
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text.length === 0 ? null : JSON.parse(text),
  };
};

const assertStableError = (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(response.json, { error: { code, message } });
};

class LifecycleStorage {
  constructor() {
    this.verifyCalls = [];
    this.deleteCalls = [];
    this.verifications = new Map();
    this.verifyFailures = new Set();
    this.deleteFailures = new Set();
  }

  verified(overrides = {}) {
    return {
      status: "verified",
      exists: true,
      sizeBytes: 42,
      checksum: checksum(),
      contentType: "application/pdf",
      safetyDisposition: "accepted",
      ...overrides,
    };
  }

  async verifyObject(request) {
    this.verifyCalls.push(request);
    if (this.verifyFailures.has(request.attachmentId)) {
      throw new Error(
        `verification-internal provider-secret ${request.objectKey}`,
      );
    }
    return this.verifications.get(request.attachmentId) ?? this.verified();
  }

  async deleteObject(request) {
    this.deleteCalls.push(request);
    if (this.deleteFailures.has(request.attachmentId)) {
      throw new Error(`raw-provider-response credential=hidden ${request.objectKey}`);
    }
  }

  async createUploadUrl() {
    throw new Error("createUploadUrl must not be called by lifecycle HTTP");
  }

  async createDownloadUrl() {
    throw new Error("createDownloadUrl must not be called by lifecycle HTTP");
  }
}

const createRuntime = (database, storage, { attachments = true } = {}) =>
  createChatServer({
    database: { pool: database },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization === "Bearer valid") return actor;
        if (request.headers.authorization === "Bearer forbidden") {
          return Object.freeze({ ...actor, roles: Object.freeze(["deny"]) });
        }
        throw new Error("authentication-token=never-log");
      },
    },
    directory: {
      async getUser() { return null; },
      async searchUsers() { return { users: [] }; },
    },
    permissions: {
      async getCapabilities({ actor: trustedActor }) {
        if (trustedActor.roles.includes("deny")) {
          throw new Error("permission-provider-secret");
        }
        return [];
      },
      async authorizeEntity() { return true; },
    },
    storage,
    features: { attachments },
    outbox: { pollIntervalMs: 60_000 },
  });

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const request = async (path, input, options = {}) => {
      const body = options.body ?? JSON.stringify(input);
      const idempotencyKey = options.idempotencyKey === undefined
        ? input?.idempotencyKey
        : options.idempotencyKey;
      return materializeResponse(await fetch(`${origin}${path}`, {
        method: "PATCH",
        headers: {
          authorization: options.authorization ?? "Bearer valid",
          "content-type": options.contentType ?? "application/json",
          ...(options.omitIdempotencyKey === true || idempotencyKey === undefined
            ? {}
            : { "idempotency-key": idempotencyKey }),
        },
        body,
      }));
    };
    const rawRequest = (path, { chunks, headers = [] }) =>
      new Promise((resolve, reject) => {
        const outgoing = httpRequest(
          `${origin}${path}`,
          {
            method: "PATCH",
            headers: ["host", new URL(origin).host, ...headers],
          },
          (response) => {
            const responseChunks = [];
            response.on("data", (chunk) => responseChunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(responseChunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                text,
                json: JSON.parse(text),
              });
            });
          },
        );
        outgoing.on("error", reject);
        const writeChunk = (index) => {
          const chunk = chunks[index];
          if (chunk === undefined) {
            outgoing.end();
            return;
          }
          outgoing.write(chunk);
          setImmediate(() => writeChunk(index + 1));
        };
        writeChunk(0);
      });
    return await callback(request, rawRequest);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

test("attachment lifecycle HTTP route rejects malformed requests before persistence", async () => {
  let connectCount = 0;
  const unavailableDatabase = {
    async query(sql) {
      throw new Error(`unexpected direct lifecycle HTTP query: ${sql}`);
    },
    async connect() {
      connectCount += 1;
      throw new Error("database must not be reached");
    },
  };
  const storage = new LifecycleStorage();
  const runtime = createRuntime(unavailableDatabase, storage, {
    attachments: false,
  });
  await withHttpServer(runtime, async (request, rawRequest) => {
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundConnectCount = connectCount;
    const input = finalizeInput("validation-only", "validation-key");
    assertStableError(
      await request(lifecyclePath(input.attachmentId), input),
      503,
      CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
      "Attachment lifecycle temporarily unavailable",
    );
    assertStableError(
      await request(lifecyclePath(input.attachmentId), {
        ...input,
        storageKey: "private/tenant/provider-secret",
      }),
      400,
      CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
      "Invalid attachment lifecycle request",
    );
    assertStableError(
      await request(lifecyclePath("different-path-claim"), input),
      400,
      CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
      "Invalid attachment lifecycle request",
    );
    assertStableError(
      await request(lifecyclePath(input.attachmentId), input, {
        authorization: "Bearer invalid",
      }),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    assertStableError(
      await rawRequest(lifecyclePath(input.attachmentId), {
        chunks: [
          " ".repeat(MAX_ATTACHMENT_LIFECYCLE_REQUEST_BYTES),
          "SECRET_ATTACHMENT_LIFECYCLE_STREAMED_OVERFLOW",
        ],
        headers: [
          "authorization", "Bearer valid",
          "content-type", "application/json",
          "transfer-encoding", "chunked",
          "idempotency-key", input.idempotencyKey,
        ],
      }),
      400,
      CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
      "Invalid attachment lifecycle request",
    );
    assert.equal(connectCount, backgroundConnectCount);
    assert.equal(storage.verifyCalls.length, 0);
    assert.equal(storage.deleteCalls.length, 0);
  });
});
