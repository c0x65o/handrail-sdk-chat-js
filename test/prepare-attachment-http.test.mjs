import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  MAX_ATTACHMENT_SIZE_BYTES,
  parsePrepareAttachmentResult,
} from "@handrail/chat";
import {
  CHAT_ATTACHMENT_PREPARATION_CONFLICT_CODE,
  CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE,
  CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE_CODE,
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  MAX_PREPARE_ATTACHMENT_REQUEST_BYTES,
  MAX_PREPARE_ATTACHMENT_RESPONSE_BYTES,
  PREPARE_ATTACHMENT_CAPABILITY,
  PREPARE_ATTACHMENT_ROUTE,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const preparePath = (conversationId) =>
  PREPARE_ATTACHMENT_ROUTE.replace(":conversationId", conversationId);

const prepareInput = (suffix, metadata = {}) => ({
  operation: "prepare_attachment",
  metadata: {
    fileName: `Quarterly report ${suffix}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 42_000,
    ...metadata,
  },
  idempotencyKey: `prepare-http-${suffix}`,
});

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

const rowFromAttachment = (attachment) => ({
  id: attachment.id,
  uploader_user_id: attachment.uploaderUserId,
  storage_key: attachment.storageKey,
  file_name: attachment.fileName,
  content_type: attachment.contentType,
  size_bytes: attachment.sizeBytes,
  state: "pending",
  created_at: attachment.createdAt,
  expires_at: attachment.expiresAt,
});

const createScriptedPrepareDatabase = () => {
  const conversations = new Map([
    ["active", { tenantId: "tenant-a", memberUserId: "actor-a" }],
    ["entity", {
      tenantId: "tenant-a",
      memberUserId: "actor-a",
      entityType: "invoice",
      entityId: "invoice-42",
    }],
    ["entity-denied", {
      tenantId: "tenant-a",
      memberUserId: "actor-a",
      entityType: "invoice",
      entityId: "invoice-denied",
    }],
    ["nonmember", { tenantId: "tenant-a", memberUserId: "other-user" }],
    ["cross-tenant", { tenantId: "tenant-b", memberUserId: "actor-a" }],
  ]);
  let committed = {
    attachments: new Map(),
    idempotency: new Map(),
  };
  let connectCount = 0;
  let failConnect = false;

  const database = {
    async query(sql) {
      throw new Error(`unexpected direct prepare HTTP query: ${sql}`);
    },
    async connect() {
      connectCount += 1;
      if (failConnect) {
        throw new Error("database-provider-secret credential=never-log");
      }
      let working = structuredClone(committed);
      let active = false;
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") {
            active = true;
            working = structuredClone(committed);
            return { rows: [], rowCount: null };
          }
          if (sql === "COMMIT") {
            committed = working;
            active = false;
            return { rows: [], rowCount: null };
          }
          if (sql === "ROLLBACK") {
            active = false;
            return { rows: [], rowCount: null };
          }
          assert.equal(active, true, "prepare command SQL must be transactional");

          if (sql.includes("claim_chat_idempotency_key")) {
            const [tenantId, userId, operation, key, requestHash] = values;
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const existing = working.idempotency.get(identity);
            if (existing !== undefined && existing.requestHash !== requestHash) {
              return { rows: [], rowCount: 0 };
            }
            if (existing !== undefined) {
              return {
                rows: [{
                  idempotency_state: existing.state,
                  stored_response_reference: existing.attachmentId,
                }],
                rowCount: 1,
              };
            }
            working.idempotency.set(identity, {
              requestHash,
              state: "pending",
              attachmentId: null,
            });
            return {
              rows: [{
                idempotency_state: "pending",
                stored_response_reference: null,
              }],
              rowCount: 1,
            };
          }

          if (sql.includes("FROM \"handrail_chat\".chat_conversations AS conversation")) {
            const [tenantId, conversationId, userId] = values;
            const conversation = conversations.get(conversationId);
            if (
              conversation === undefined ||
              conversation.tenantId !== tenantId ||
              conversation.memberUserId !== userId
            ) {
              return { rows: [], rowCount: 0 };
            }
            return {
              rows: [{
                entity_type: conversation.entityType ?? null,
                entity_id: conversation.entityId ?? null,
              }],
              rowCount: 1,
            };
          }

          if (
            sql.includes("SELECT id, uploader_user_id, storage_key") &&
            sql.includes("FROM \"handrail_chat\".chat_attachments")
          ) {
            const [tenantId, attachmentId, userId] = values;
            const attachment = working.attachments.get(attachmentId);
            if (
              attachment === undefined ||
              attachment.tenantId !== tenantId ||
              attachment.uploaderUserId !== userId
            ) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [rowFromAttachment(attachment)], rowCount: 1 };
          }

          if (sql.includes("INSERT INTO \"handrail_chat\".chat_attachments")) {
            const [
              tenantId,
              attachmentId,
              uploaderUserId,
              storageKey,
              fileName,
              contentType,
              sizeBytes,
              pendingTtlMs,
            ] = values;
            const createdAt = new Date();
            const attachment = {
              tenantId,
              id: attachmentId,
              uploaderUserId,
              storageKey,
              fileName,
              contentType,
              sizeBytes,
              createdAt,
              expiresAt: new Date(createdAt.valueOf() + pendingTtlMs),
            };
            working.attachments.set(attachmentId, attachment);
            return { rows: [rowFromAttachment(attachment)], rowCount: 1 };
          }

          if (sql.includes("UPDATE \"handrail_chat\".chat_idempotency_keys")) {
            const [attachmentId, tenantId, userId, operation, key, requestHash] =
              values;
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const existing = working.idempotency.get(identity);
            if (
              existing === undefined ||
              existing.state !== "pending" ||
              existing.requestHash !== requestHash
            ) {
              return { rows: [], rowCount: 0 };
            }
            existing.state = "completed";
            existing.attachmentId = attachmentId;
            return { rows: [], rowCount: 1 };
          }

          throw new Error(`unexpected prepare HTTP query: ${sql}`);
        },
        release() {},
      };
    },
    get connectCount() {
      return connectCount;
    },
    get reservationCount() {
      return committed.attachments.size;
    },
    setFailConnect(value) {
      failConnect = value;
    },
  };
  return database;
};

const createStorage = () => {
  const calls = [];
  let failure = null;
  return {
    calls,
    setFailure(value) {
      failure = value;
    },
    async createUploadUrl(request) {
      calls.push(request);
      if (failure === "throw") {
        throw new Error(
          "adapter-message=never-log provider-token=never-log object-key=never-log descriptor=never-log authorization-header=never-log",
        );
      }
      const response = {
        objectKey: `tenant-private/${request.actor.tenantId}/${request.attachmentId}`,
        method: "PUT",
        url: `https://storage.invalid/upload/${request.attachmentId}?signature=provider-secret-${calls.length}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        headers: { authorization: `Bearer provider-header-${calls.length}` },
      };
      if (failure === "invalid") {
        return { ...response, providerSecret: "provider-response-secret" };
      }
      return response;
    },
    async verifyObject() {
      throw new Error("verifyObject must not be called by prepare HTTP");
    },
    async createDownloadUrl() {
      throw new Error("createDownloadUrl must not be called by prepare HTTP");
    },
    async deleteObject() {
      throw new Error("deleteObject must not be called by prepare HTTP");
    },
  };
};

const createRuntime = (
  database,
  storage,
  { attachments = true, state = {} } = {},
) => createChatServer({
  database: { pool: database },
  auth: {
    async resolveActor(request) {
      if (request.headers.authorization !== "Bearer valid") {
        throw new Error("authentication-token=never-log");
      }
      return actor;
    },
  },
  directory: {
    async getUser() { return null; },
    async searchUsers() { return { users: [] }; },
  },
  permissions: {
    async getCapabilities({ actor: trustedActor }) {
      assert.deepEqual(trustedActor, actor);
      return state.capabilities ?? [PREPARE_ATTACHMENT_CAPABILITY];
    },
    async authorizeEntity(request) {
      state.entityCalls?.push(request);
      return state.entityAllowed ?? true;
    },
  },
  storage,
  features: { attachments },
});

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const rawRequest = (path, { body = "", headers = [] } = {}) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          `${origin}${path}`,
          {
            method: "POST",
            headers: ["host", new URL(origin).host, ...headers],
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                text: async () => text,
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        request.end(body);
      });

    return await callback({
      request(path, requestInput, options = {}) {
        const body = options.body ?? JSON.stringify(requestInput);
        const idempotencyKey = options.idempotencyKey === undefined
          ? requestInput?.idempotencyKey
          : options.idempotencyKey;
        return fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey === true || idempotencyKey === undefined
              ? {}
              : { "idempotency-key": idempotencyKey }),
          },
          body,
        });
      },
      rawRequest,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

test("prepare-attachment HTTP route reserves, replays, validates, authorizes, and redacts", async (t) => {
  const database = createScriptedPrepareDatabase();
  const storage = createStorage();
  const state = { entityCalls: [] };
  const runtime = createRuntime(database, storage, { state });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await t.test("returns one opaque reservation and reconciles an identical retry", async () => {
      const input = prepareInput("replay");
      const beforeConnects = database.connectCount;
      const response = await request(preparePath("entity"), input);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const responseText = await response.text();
      assert.ok(Buffer.byteLength(responseText) <= MAX_PREPARE_ATTACHMENT_RESPONSE_BYTES);
      const applied = parsePrepareAttachmentResult(JSON.parse(responseText), input);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.attachment.status, "pending");
      assert.deepEqual(applied.attachment.metadata, input.metadata);
      assert.deepEqual(Object.keys(applied.upload).sort(), [
        "descriptor", "expiresAt", "kind",
      ]);
      assert.equal(applied.upload.kind, "opaque_attachment_upload");
      for (const providerDetail of [
        "storage.invalid",
        "signature",
        "authorization",
        "tenant-private",
      ]) {
        assert.equal(responseText.includes(providerDetail), false);
      }
      const decoded = JSON.parse(
        Buffer.from(applied.upload.descriptor, "base64url").toString("utf8"),
      );
      assert.equal(decoded.method, "PUT");
      assert.match(decoded.url, /^https:\/\/storage\.invalid\/upload\//);

      const replayResponse = await request(preparePath("entity"), input);
      assert.equal(replayResponse.status, 200);
      const replayed = parsePrepareAttachmentResult(
        await replayResponse.json(),
        input,
      );
      assert.equal(replayed.reconciliationStatus, "replayed");
      assert.deepEqual(replayed.attachment, applied.attachment);
      assert.equal(database.reservationCount, 1);
      assert.equal(database.connectCount - beforeConnects, 2);
      assert.equal(storage.calls.length, 2);
      assert.equal(state.entityCalls.length, 2);
      assert.deepEqual(state.entityCalls[0], {
        actor,
        entity: { type: "invoice", id: "invoice-42" },
        action: "attachment.prepare",
      });

      await assertStableError(
        await request(preparePath("entity"), {
          ...input,
          metadata: { ...input.metadata, sizeBytes: input.metadata.sizeBytes + 1 },
        }),
        409,
        CHAT_ATTACHMENT_PREPARATION_CONFLICT_CODE,
        "Attachment preparation conflicts with current server state",
      );
      assert.equal(database.reservationCount, 1);
    });

    await t.test("rejects unsupported metadata and bounded transport input before storage", async () => {
      const invalidInputs = [
        prepareInput("oversized", { sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1 }),
        prepareInput("type", { contentType: "application/octet-stream" }),
      ];
      for (const input of invalidInputs) {
        const beforeConnects = database.connectCount;
        const beforeStorage = storage.calls.length;
        await assertStableError(
          await request(preparePath("active"), input),
          400,
          CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE,
          "Invalid attachment preparation request",
        );
        assert.equal(database.connectCount, beforeConnects);
        assert.equal(storage.calls.length, beforeStorage);
      }

      const overDeclared = prepareInput("request-bound");
      const overLimitBody = JSON.stringify(overDeclared).padEnd(
        MAX_PREPARE_ATTACHMENT_REQUEST_BYTES + 1,
        " ",
      );
      const beforeConnects = database.connectCount;
      const beforeStorage = storage.calls.length;
      const response = await rawRequest(preparePath("active"), {
        body: overLimitBody,
        headers: [
          "authorization", "Bearer valid",
          "content-type", "application/json",
          "idempotency-key", overDeclared.idempotencyKey,
          "content-length", String(Buffer.byteLength(overLimitBody)),
        ],
      });
      await assertStableError(
        response,
        400,
        CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE,
        "Invalid attachment preparation request",
      );
      assert.equal(database.connectCount, beforeConnects);
      assert.equal(storage.calls.length, beforeStorage);
    });

    await t.test("rejects malformed, spoofed, secret-bearing, and mismatched requests", async () => {
      const valid = prepareInput("invalid-base");
      const invalidRequests = [
        () => request(preparePath("active"), valid, { body: "{" }),
        () => request(preparePath("active"), valid, { contentType: "text/plain" }),
        () => request(`${preparePath("active")}?unexpected=true`, valid),
        () => request(`${preparePath("active")}/extra`, valid),
        () => request(preparePath("active%2Fchild"), valid),
        () => request(preparePath("active"), { ...valid, tenantId: "tenant-b" }),
        () => request(preparePath("active"), { ...valid, userId: "spoofed" }),
        () => request(preparePath("active"), { ...valid, roles: ["admin"] }),
        () => request(preparePath("active"), { ...valid, permissions: ["all"] }),
        () => request(preparePath("active"), { ...valid, provider: "s3" }),
        () => request(preparePath("active"), { ...valid, storageKey: "private/key" }),
        () => request(preparePath("active"), { ...valid, credentials: "secret" }),
        () => request(preparePath("active"), {
          ...valid,
          metadata: { ...valid.metadata, authorizationHeader: "Bearer secret" },
        }),
        () => request(preparePath("active"), {
          ...valid,
          metadata: { ...valid.metadata, descriptor: "provider-descriptor" },
        }),
        () => request(preparePath("active"), valid, { omitIdempotencyKey: true }),
        () => request(preparePath("active"), valid, { idempotencyKey: "other-key" }),
        () => request(
          preparePath("active"),
          { ...valid, idempotencyKey: "unsafe,key" },
          { idempotencyKey: "unsafe,key" },
        ),
        () => request(
          preparePath("active"),
          { ...valid, idempotencyKey: "x".repeat(256) },
          { idempotencyKey: "x".repeat(256) },
        ),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeConnects = database.connectCount;
        const beforeStorage = storage.calls.length;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE,
          "Invalid attachment preparation request",
        );
        assert.equal(database.connectCount, beforeConnects);
        assert.equal(storage.calls.length, beforeStorage);
      }

      const duplicateBody = JSON.stringify(valid);
      const beforeConnects = database.connectCount;
      await assertStableError(
        await rawRequest(preparePath("active"), {
          body: duplicateBody,
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "idempotency-key", valid.idempotencyKey,
            "idempotency-key", valid.idempotencyKey,
            "content-length", String(Buffer.byteLength(duplicateBody)),
          ],
        }),
        400,
        CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE,
        "Invalid attachment preparation request",
      );
      assert.equal(database.connectCount, beforeConnects);
    });

    await t.test("uses trusted authentication and denies capability, membership, tenant, and entity access", async () => {
      const unauthenticated = prepareInput("unauthenticated");
      await assertStableError(
        await request(preparePath("active"), unauthenticated, {
          authorization: "Bearer invalid",
        }),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      state.capabilities = [];
      await assertStableError(
        await request(preparePath("active"), prepareInput("capability")),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      state.capabilities = undefined;

      for (const conversationId of ["nonmember", "cross-tenant", "missing"]) {
        await assertStableError(
          await request(
            preparePath(conversationId),
            prepareInput(`denied-${conversationId}`),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
      }

      state.entityAllowed = false;
      await assertStableError(
        await request(
          preparePath("entity-denied"),
          prepareInput("entity-denied"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      state.entityAllowed = undefined;
    });

    await t.test("sanitizes storage and database failures without console leakage", async () => {
      const secrets = [
        "sensitive-file-name.pdf",
        "sensitive-idempotency-value",
        "provider-descriptor",
        "provider-response-secret",
        "provider-token",
        "descriptor=never-log",
        "authorization-header=never-log",
        "tenant-private",
        "database-provider-secret",
        "credential=never-log",
        "adapter-message=never-log",
      ];
      const captured = [];
      const originalConsole = {
        error: console.error,
        log: console.log,
        warn: console.warn,
      };
      console.error = (...values) => captured.push(values.join(" "));
      console.log = (...values) => captured.push(values.join(" "));
      console.warn = (...values) => captured.push(values.join(" "));
      try {
        for (const failure of ["throw", "invalid"]) {
          storage.setFailure(failure);
          const input = {
            ...prepareInput(`storage-${failure}`),
            metadata: {
              fileName: "sensitive-file-name.pdf",
              contentType: "application/pdf",
              sizeBytes: 123,
            },
            idempotencyKey: `sensitive-idempotency-value-${failure}`,
          };
          const response = await request(preparePath("active"), input);
          const text = await response.text();
          assert.equal(response.status, 503);
          assert.deepEqual(JSON.parse(text), {
            error: {
              code: CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE_CODE,
              message: "Attachment preparation temporarily unavailable",
            },
          });
          for (const secret of secrets) assert.equal(text.includes(secret), false);
        }
        storage.setFailure(null);

        database.setFailConnect(true);
        const response = await request(
          preparePath("active"),
          prepareInput("database-failure"),
        );
        await assertStableError(
          response,
          503,
          CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE_CODE,
          "Attachment preparation temporarily unavailable",
        );
        database.setFailConnect(false);

        const logs = captured.join("\n");
        for (const secret of secrets) assert.equal(logs.includes(secret), false);
      } finally {
        console.error = originalConsole.error;
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        database.setFailConnect(false);
        storage.setFailure(null);
      }
    });
  });
});

test("prepare-attachment HTTP route reports disabled attachment storage stably", async () => {
  const database = createScriptedPrepareDatabase();
  const storage = createStorage();
  const runtime = createRuntime(database, storage, { attachments: false });
  await withHttpServer(runtime, async ({ request }) => {
    await assertStableError(
      await request(preparePath("active"), prepareInput("disabled")),
      503,
      CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE_CODE,
      "Attachment preparation temporarily unavailable",
    );
    assert.equal(database.connectCount, 0);
    assert.equal(storage.calls.length, 0);
  });
});
