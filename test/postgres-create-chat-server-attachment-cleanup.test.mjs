import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("server-owned cleanup worker delivers an abandoned PostgreSQL attachment", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "server_cleanup",
  });
  const prefix = quoteIdentifier(harness.schema);
  const attachments = `${prefix}.chat_attachments`;
  const deliveries = `${prefix}.chat_attachment_cleanup_deliveries`;
  let runtime;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, created_at, updated_at, expires_at
       ) VALUES (
         'tenant-server-cleanup', 'attachment-server-cleanup',
         'uploader-server-cleanup', 'private/server-cleanup-object',
         'server-cleanup.txt', 'text/plain', 12,
         '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
         '2099-01-01T00:00:00Z'
       )`,
    );
    await harness.pool.query(
      `UPDATE ${attachments}
       SET state = 'abandoned',
           abandoned_at = '2020-01-02T00:00:00Z',
           updated_at = '2020-01-02T00:00:00Z'
       WHERE tenant_id = 'tenant-server-cleanup'
         AND id = 'attachment-server-cleanup'`,
    );
    await harness.pool.query(
      `INSERT INTO ${deliveries} (
         tenant_id, attachment_id, storage_key, next_attempt_at,
         created_at, updated_at
       ) VALUES (
         'tenant-server-cleanup', 'attachment-server-cleanup',
         'private/server-cleanup-object', '2020-01-03T00:00:00Z',
         '2020-01-03T00:00:00Z', '2020-01-03T00:00:00Z'
       )`,
    );

    const deleted = [];
    runtime = createChatServer({
      database: { pool: harness.pool, schema: harness.schema },
      auth: { async resolveActor() { throw new Error("not used"); } },
      directory: {
        async getUser() { throw new Error("not used"); },
        async searchUsers() { throw new Error("not used"); },
      },
      permissions: {
        async getCapabilities() { throw new Error("not used"); },
        async authorizeEntity() { throw new Error("not used"); },
      },
      storage: {
        async createUploadUrl() { throw new Error("not used"); },
        async verifyObject() { throw new Error("not used"); },
        async createDownloadUrl() { throw new Error("not used"); },
        async deleteObject(input) { deleted.push(input); },
      },
      features: { attachments: true },
      outbox: { pollIntervalMs: 60_000 },
      postgresMaintenance: { pollIntervalMs: 60_000 },
      attachmentCleanup: { batchSize: 10, pollIntervalMs: 60_000 },
    });

    assert.ok(runtime.attachmentCleanupDispatcher);
    assert.equal(runtime.attachmentCleanupDispatcher.running, true);
    await waitFor(async () => {
      const result = await harness.pool.query(
        `SELECT state FROM ${deliveries}
         WHERE tenant_id = 'tenant-server-cleanup'
           AND attachment_id = 'attachment-server-cleanup'`,
      );
      return result.rows[0]?.state === "delivered";
    });
    assert.deepEqual(deleted, [{
      actor: {
        tenantId: "tenant-server-cleanup",
        userId: "uploader-server-cleanup",
        roles: [],
      },
      attachmentId: "attachment-server-cleanup",
      objectKey: "private/server-cleanup-object",
    }]);
    assert.deepEqual(await runtime.dispatchAttachmentCleanupOnce(), {
      claimed: 0,
      delivered: 0,
      failed: 0,
    });
  } finally {
    await runtime?.close();
    await harness.teardown();
    await backend.teardown();
  }
});
