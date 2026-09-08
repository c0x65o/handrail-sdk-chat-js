import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  parseAbortAttachmentResult,
  parseFinalizeAttachmentResult,
} from "@handrail/chat";
import {
  ATTACHMENT_LIFECYCLE_ROUTE,
  CHAT_ATTACHMENT_LIFECYCLE_ATTACHMENT_UNAVAILABLE_CODE,
  CHAT_ATTACHMENT_LIFECYCLE_CONFLICT_CODE,
  CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
  CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  MAX_ATTACHMENT_LIFECYCLE_RESPONSE_BYTES,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

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
const abortInput = (attachmentId, idempotencyKey = `abort-${attachmentId}`) => ({
  operation: "abort_attachment",
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

test("attachment lifecycle HTTP route is actor-bound, idempotent, and secret-safe", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_attachment_lifecycle_http",
  });
  const schema = `"${harness.schema.replaceAll('"', '""')}"`;
  const tables = {
    attachments: `${schema}.chat_attachments`,
    audit: `${schema}.chat_audit_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
    outbox: `${schema}.chat_outbox_events`,
  };
  const storage = new LifecycleStorage();

  const seedAttachment = async ({
    attachmentId,
    tenantId = "tenant-a",
    uploaderUserId = "actor-a",
    expired = false,
    state = "pending",
    storedChecksum = null,
    abandoned = false,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, checksum, state, created_at, updated_at,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'application/pdf', 42, $6, 'pending',
         clock_timestamp() - interval '1 minute',
         clock_timestamp() - interval '1 minute',
         clock_timestamp() + $7::interval
       )`,
      [
        tenantId,
        attachmentId,
        uploaderUserId,
        `private/${tenantId}/${attachmentId}?credential=hidden`,
        `${attachmentId}.pdf`,
        storedChecksum,
        expired ? "-1 second" : "1 hour",
      ],
    );
    if (state === "abandoned" || abandoned) {
      await harness.pool.query(
        `WITH timestamp AS (SELECT clock_timestamp() AS value)
         UPDATE ${tables.attachments}
            SET state = 'abandoned', abandoned_at = timestamp.value,
                updated_at = timestamp.value
           FROM timestamp
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, attachmentId],
      );
    }
  };

  const sideEffectCounts = async (attachmentId) => {
    const row = (await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE target_type = 'attachment' AND target_id = $1) AS audits,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE payload -> 'attachment' ->> 'attachmentId' = $1) AS outbox,
         (SELECT count(*)::integer FROM ${tables.idempotency}
           WHERE response_body ->> 'attachmentId' = $1) AS outcomes`,
      [attachmentId],
    )).rows[0];
    return row;
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    const runtime = createRuntime(harness.pool, storage);

    await withHttpServer(runtime, async (request) => {
      await t.test("finalizes once and returns a canonical replay", async () => {
        await seedAttachment({ attachmentId: "finalize-success" });
        storage.verifications.set(
          "finalize-success",
          storage.verified({ checksum: checksum("b") }),
        );
        const input = finalizeInput("finalize-success");
        const appliedResponse = await request(lifecyclePath(input.attachmentId), input);
        assert.equal(appliedResponse.status, 200);
        assert.equal(appliedResponse.headers.get("cache-control"), "private, no-store");
        const applied = parseFinalizeAttachmentResult(appliedResponse.json, input);
        assert.equal(applied.reconciliationStatus, "applied");
        assert.equal(applied.outcome, "finalized");
        assert.equal(applied.attachment.checksum, checksum("b"));

        const replayResponse = await request(lifecyclePath(input.attachmentId), input);
        assert.equal(replayResponse.status, 200);
        const replayed = parseFinalizeAttachmentResult(replayResponse.json, input);
        assert.deepEqual(replayed, {
          ...applied,
          reconciliationStatus: "replayed",
        });
        assert.equal(
          storage.verifyCalls.filter(({ attachmentId }) =>
            attachmentId === input.attachmentId).length,
          1,
        );
        assert.deepEqual(await sideEffectCounts(input.attachmentId), {
          audits: 1,
          outbox: 1,
          outcomes: 1,
        });

        await seedAttachment({ attachmentId: "finalize-conflict" });
        assertStableError(
          await request(
            lifecyclePath("finalize-conflict"),
            finalizeInput("finalize-conflict", input.idempotencyKey),
          ),
          409,
          CHAT_ATTACHMENT_LIFECYCLE_CONFLICT_CODE,
          "Attachment lifecycle request conflicts with current server state",
        );
      });

      await t.test("aborts once and resumes cleanup without duplicate effects", async () => {
        await seedAttachment({ attachmentId: "abort-success" });
        const input = abortInput("abort-success");
        const appliedResponse = await request(lifecyclePath(input.attachmentId), input);
        assert.equal(appliedResponse.status, 200);
        const applied = parseAbortAttachmentResult(appliedResponse.json, input);
        assert.equal(applied.reconciliationStatus, "applied");
        assert.equal(applied.attachment.status, "abandoned");

        const replayResponse = await request(lifecyclePath(input.attachmentId), input);
        const replayed = parseAbortAttachmentResult(replayResponse.json, input);
        assert.equal(replayed.reconciliationStatus, "replayed");
        assert.equal(
          storage.deleteCalls.filter(({ attachmentId }) =>
            attachmentId === input.attachmentId).length,
          1,
        );
        assert.deepEqual(await sideEffectCounts(input.attachmentId), {
          audits: 1,
          outbox: 1,
          outcomes: 1,
        });

        await seedAttachment({ attachmentId: "abort-recovery" });
        const recoveryInput = abortInput("abort-recovery");
        storage.deleteFailures.add(recoveryInput.attachmentId);
        assertStableError(
          await request(lifecyclePath(recoveryInput.attachmentId), recoveryInput),
          503,
          CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
          "Attachment lifecycle temporarily unavailable",
        );
        storage.deleteFailures.delete(recoveryInput.attachmentId);
        const recoveredResponse = await request(
          lifecyclePath(recoveryInput.attachmentId),
          recoveryInput,
        );
        assert.equal(recoveredResponse.status, 200);
        assert.equal(
          parseAbortAttachmentResult(recoveredResponse.json, recoveryInput)
            .reconciliationStatus,
          "replayed",
        );
        assert.deepEqual(await sideEffectCounts(recoveryInput.attachmentId), {
          audits: 1,
          outbox: 1,
          outcomes: 1,
        });
      });

      await t.test("returns canonical metadata and provider-neutral rejection outcomes", async () => {
        const cases = [
          ["size-rejected", storage.verified({ sizeBytes: 43 }), "size_mismatch"],
          ["unsafe-rejected", { status: "rejected", reason: "unsafe" }, "unsafe"],
        ];
        for (const [attachmentId, verification, reason] of cases) {
          await seedAttachment({ attachmentId });
          storage.verifications.set(attachmentId, verification);
          const input = finalizeInput(attachmentId);
          const response = await request(lifecyclePath(attachmentId), input);
          assert.equal(response.status, 200);
          const result = parseFinalizeAttachmentResult(response.json, input);
          assert.equal(result.outcome, "rejected");
          assert.equal(result.attachment.status, "rejected");
          assert.equal(result.attachment.rejectionReason, reason);
          assert.deepEqual(result.attachment.metadata, {
            fileName: `${attachmentId}.pdf`,
            contentType: "application/pdf",
            sizeBytes: 42,
          });
        }
      });

      await t.test("does not enumerate invalid state, uploader, tenant, or absence", async () => {
        await seedAttachment({ attachmentId: "expired", expired: true });
        await seedAttachment({
          attachmentId: "already-finalized",
          storedChecksum: checksum("c"),
        });
        await seedAttachment({
          attachmentId: "already-abandoned",
          state: "abandoned",
          abandoned: true,
        });
        await seedAttachment({
          attachmentId: "foreign-uploader",
          uploaderUserId: "actor-b",
        });
        await seedAttachment({
          attachmentId: "cross-tenant",
          tenantId: "tenant-b",
        });
        for (const attachmentId of [
          "expired",
          "already-finalized",
          "already-abandoned",
          "foreign-uploader",
          "cross-tenant",
          "missing",
        ]) {
          assertStableError(
            await request(
              lifecyclePath(attachmentId),
              finalizeInput(attachmentId),
            ),
            404,
            CHAT_ATTACHMENT_LIFECYCLE_ATTACHMENT_UNAVAILABLE_CODE,
            "Attachment is unavailable",
          );
        }
      });

      await t.test("rejects malformed, mismatched, and spoofed requests before effects", async () => {
        const valid = finalizeInput("never-dispatched", "valid-lifecycle-key");
        const invalidRequests = [
          () => request(lifecyclePath(valid.attachmentId), valid, { body: "{" }),
          () => request(lifecyclePath(valid.attachmentId), valid, { contentType: "text/plain" }),
          () => request(`${lifecyclePath(valid.attachmentId)}?secret=true`, valid),
          () => request(`${lifecyclePath(valid.attachmentId)}/extra`, valid),
          () => request("/attachments/encoded%2Fchild/lifecycle", valid),
          () => request(lifecyclePath("path-claim"), { ...valid, attachmentId: "body-claim" }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, operation: "prepare_attachment" }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, tenantId: "tenant-b" }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, userId: "spoofed" }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, roles: ["admin"] }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, permissions: ["all"] }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, provider: "s3" }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, storageKey: "private/forged-provider-secret" }),
          () => request(lifecyclePath(valid.attachmentId), { ...valid, credentials: "Bearer storage-secret" }),
          () => request(lifecyclePath(valid.attachmentId), valid, { omitIdempotencyKey: true }),
          () => request(lifecyclePath(valid.attachmentId), valid, { idempotencyKey: "different-key" }),
          () => request(
            lifecyclePath(valid.attachmentId),
            { ...valid, idempotencyKey: "unsafe,key" },
            { idempotencyKey: "unsafe,key" },
          ),
        ];
        const beforeVerify = storage.verifyCalls.length;
        const beforeDelete = storage.deleteCalls.length;
        for (const makeRequest of invalidRequests) {
          assertStableError(
            await makeRequest(),
            400,
            CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
            "Invalid attachment lifecycle request",
          );
        }
        assert.equal(storage.verifyCalls.length, beforeVerify);
        assert.equal(storage.deleteCalls.length, beforeDelete);
      });

      await t.test("preserves stable authentication, authorization, and storage failures", async () => {
        const authInput = finalizeInput("auth-check");
        assertStableError(
          await request(lifecyclePath(authInput.attachmentId), authInput, {
            authorization: "Bearer invalid",
          }),
          401,
          CHAT_AUTHENTICATION_ERROR_CODE,
          "Chat authentication failed",
        );
        assertStableError(
          await request(lifecyclePath(authInput.attachmentId), authInput, {
            authorization: "Bearer forbidden",
          }),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );

        await seedAttachment({ attachmentId: "verify-unavailable" });
        storage.verifyFailures.add("verify-unavailable");
        const failureInput = finalizeInput("verify-unavailable");
        assertStableError(
          await request(lifecyclePath(failureInput.attachmentId), failureInput),
          503,
          CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
          "Attachment lifecycle temporarily unavailable",
        );
      });
    });

    await t.test("maps idempotency-in-progress and runtime unavailability safely", async () => {
      await seedAttachment({ attachmentId: "in-progress" });
      const inProgressDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              if (
                typeof sql === "string" &&
                sql.includes("UPDATE") &&
                sql.includes("chat_idempotency_keys")
              ) {
                return { rows: [], rowCount: 0 };
              }
              return connection.query(sql, values);
            },
            release: () => connection.release(),
          };
        },
      };
      await withHttpServer(
        createRuntime(inProgressDatabase, storage),
        async (request) => {
          const input = finalizeInput("in-progress");
          assertStableError(
            await request(lifecyclePath(input.attachmentId), input),
            409,
            CHAT_ATTACHMENT_LIFECYCLE_CONFLICT_CODE,
            "Attachment lifecycle request conflicts with current server state",
          );
        },
      );

      const unavailableDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          throw new Error("database-provider-secret credential=hidden");
        },
      };
      await withHttpServer(
        createRuntime(unavailableDatabase, storage),
        async (request) => {
          const input = finalizeInput("runtime-unavailable");
          assertStableError(
            await request(lifecyclePath(input.attachmentId), input),
            503,
            CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
            "Attachment lifecycle temporarily unavailable",
          );
        },
      );

      await withHttpServer(
        createRuntime(harness.pool, storage, { attachments: false }),
        async (request) => {
          const input = abortInput("disabled");
          assertStableError(
            await request(lifecyclePath(input.attachmentId), input),
            503,
            CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
            "Attachment lifecycle temporarily unavailable",
          );
        },
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
