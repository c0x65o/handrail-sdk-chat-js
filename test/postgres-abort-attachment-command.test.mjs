import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  AbortAttachmentCommandError,
  SendMessageCommandError,
  abortAttachment,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  sendMessage,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const input = (attachmentId, key = `abort-${attachmentId}`) => ({
  operation: "abort_attachment",
  attachmentId,
  idempotencyKey: key,
});

class FakeDeletionStorage {
  constructor() {
    this.calls = [];
    this.delays = new Map();
    this.failuresRemaining = new Map();
    this.deleted = new Set();
  }

  failNext(attachmentId) {
    this.failuresRemaining.set(attachmentId, 1);
  }

  async deleteObject(request) {
    this.calls.push(request);
    const delay = this.delays.get(request.attachmentId);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const remaining = this.failuresRemaining.get(request.attachmentId) ?? 0;
    if (remaining > 0) {
      this.failuresRemaining.set(request.attachmentId, remaining - 1);
      throw new Error(
        `provider-secret cleanup failed for ${request.objectKey}`,
      );
    }
    // The adapter boundary is deliberately idempotent.
    this.deleted.add(
      `${request.actor.tenantId}:${request.attachmentId}:${request.objectKey}`,
    );
  }
}

test("trusted abort-attachment is terminal, recoverable, and tenant isolated", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_abort_attachment",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    attachments: `${schema}.chat_attachments`,
    audit: `${schema}.chat_audit_events`,
    cleanup: `${schema}.chat_attachment_cleanup_deliveries`,
    conversations: `${schema}.chat_conversations`,
    idempotency: `${schema}.chat_idempotency_keys`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    outbox: `${schema}.chat_outbox_events`,
  };
  const storage = new FakeDeletionStorage();
  let idSequence = 0;
  const command = (commandInput, overrides = {}) =>
    abortAttachment({
      database: harness.pool,
      schema: harness.schema,
      storage,
      actor,
      input: commandInput,
      createId: () => `abort-event-${++idSequence}`,
      ...overrides,
    });
  const seedAttachment = async ({
    attachmentId,
    tenantId = "tenant-a",
    uploaderUserId = "actor-a",
    expired = false,
    checksum = null,
    storageKey = `private/${tenantId}/${attachmentId}?credential=hidden`,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, checksum, created_at, updated_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'application/pdf', 42, $6,
         clock_timestamp() - $7::interval,
         clock_timestamp() - $7::interval,
         clock_timestamp() + $8::interval
       )`,
      [
        tenantId,
        attachmentId,
        uploaderUserId,
        storageKey,
        `${attachmentId}.pdf`,
        checksum,
        expired ? "2 hours" : "1 minute",
        expired ? "-1 hour" : "1 hour",
      ],
    );
  };
  const durableCounts = async (attachmentId) =>
    (
      await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.audit}
             WHERE target_type = 'attachment' AND target_id = $1
               AND action = 'attachment.abandoned') AS audits,
           (SELECT count(*)::integer FROM ${tables.outbox}
             WHERE type = 'attachment.abandoned'
               AND payload -> 'attachment' ->> 'attachmentId' = $1) AS outbox,
           (SELECT count(*)::integer FROM ${tables.idempotency}
             WHERE operation_name = 'attachment.abort'
               AND response_body ->> 'attachmentId' = $1) AS outcomes`,
        [attachmentId],
      )
    ).rows[0];
  const cleanupDelivery = async (attachmentId) =>
    (
      await harness.pool.query(
        `SELECT tenant_id, attachment_id, storage_key, state, attempt_count,
                next_attempt_at, lease_owner, lease_expires_at,
                last_error_code, created_at, updated_at, delivered_at
           FROM ${tables.cleanup}
          WHERE tenant_id = 'tenant-a' AND attachment_id = $1`,
        [attachmentId],
      )
    ).rows[0];
  const cleanupCount = async (attachmentId) =>
    (
      await harness.pool.query(
        `SELECT count(*)::integer AS count
           FROM ${tables.cleanup}
          WHERE tenant_id = 'tenant-a' AND attachment_id = $1`,
        [attachmentId],
      )
    ).rows[0].count;
  const advanceCleanupToDelivered = async (attachmentId) => {
    await harness.pool.query(
      `WITH timestamp AS (SELECT clock_timestamp() AS value)
       UPDATE ${tables.cleanup}
          SET state = 'leased', attempt_count = attempt_count + 1,
              lease_owner = 'test-cleanup-worker',
              lease_expires_at = timestamp.value + interval '5 minutes',
              updated_at = timestamp.value
         FROM timestamp
        WHERE tenant_id = 'tenant-a' AND attachment_id = $1`,
      [attachmentId],
    );
    await harness.pool.query(
      `WITH timestamp AS (SELECT clock_timestamp() AS value)
       UPDATE ${tables.cleanup}
          SET state = 'delivered', lease_owner = NULL, lease_expires_at = NULL,
              updated_at = timestamp.value, delivered_at = timestamp.value
         FROM timestamp
        WHERE tenant_id = 'tenant-a' AND attachment_id = $1`,
      [attachmentId],
    );
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name)
       VALUES ('tenant-a', 'attachment-conversation', 'channel', 'private',
               'Attachment conversation')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ('tenant-a', 'attachment-conversation', 'actor-a',
               'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content
       ) VALUES (
         'tenant-a', 'existing-message', 'attachment-conversation', 1,
         'actor-a', 'existing-client-message',
         '{"format":"plain","text":"Existing"}'
       )`,
    );

    await t.test("persists one canonical private outcome and replays exactly", async () => {
      await seedAttachment({ attachmentId: "success" });
      const request = input("success");
      const result = await command(request);

      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.attachment.status, "abandoned");
      assert.equal(result.attachmentId, "success");
      assert.equal("messageId" in result.attachment, false);
      assert.equal("checksum" in result.attachment, false);
      assert.deepEqual(storage.calls.at(-1), {
        actor,
        attachmentId: "success",
        objectKey: "private/tenant-a/success?credential=hidden",
      });

      const persisted = (
        await harness.pool.query(
          `SELECT attachment.state, attachment.checksum,
                  attachment.attached_message_id, attachment.attached_at,
                  attachment.abandoned_at, attachment.updated_at,
                  idempotency.state AS idempotency_state,
                  idempotency.response_body,
                  audit.action AS audit_action,
                  audit.metadata AS audit_metadata,
                  audit.request_id AS audit_request_id,
                  outbox.protocol_version::integer AS protocol_version,
                  outbox.stream_id, outbox.type AS outbox_type, outbox.payload
             FROM ${tables.attachments} AS attachment
             INNER JOIN ${tables.idempotency} AS idempotency
               ON idempotency.tenant_id = attachment.tenant_id
              AND idempotency.user_id = attachment.uploader_user_id
              AND idempotency.operation_name = 'attachment.abort'
              AND idempotency.client_key = $2
             INNER JOIN ${tables.audit} AS audit
               ON audit.tenant_id = attachment.tenant_id
              AND audit.target_type = 'attachment'
              AND audit.target_id = attachment.id
              AND audit.action = 'attachment.abandoned'
             INNER JOIN ${tables.outbox} AS outbox
               ON outbox.tenant_id = attachment.tenant_id
              AND outbox.type = 'attachment.abandoned'
              AND outbox.payload -> 'attachment' ->> 'attachmentId' = attachment.id
            WHERE attachment.tenant_id = 'tenant-a' AND attachment.id = $1`,
          ["success", request.idempotencyKey],
        )
      ).rows[0];
      assert.equal(persisted.state, "abandoned");
      assert.equal(persisted.checksum, null);
      assert.equal(persisted.attached_message_id, null);
      assert.equal(persisted.attached_at, null);
      assert.equal(
        persisted.abandoned_at.toISOString(),
        persisted.updated_at.toISOString(),
      );
      assert.equal(persisted.idempotency_state, "completed");
      assert.deepEqual(persisted.response_body, result);
      assert.equal(persisted.audit_action, "attachment.abandoned");
      assert.deepEqual(persisted.audit_metadata, {
        outcome: "abandoned",
        cleanupMarker: persisted.audit_request_id,
      });
      assert.match(persisted.audit_request_id, /^attachment-abort:[0-9a-f]{64}$/);
      assert.equal(persisted.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(persisted.stream_id, "user:actor-a");
      assert.equal(persisted.outbox_type, "attachment.abandoned");
      assert.deepEqual(persisted.payload, {
        attachment: result.attachment,
      });

      const delivered = await cleanupDelivery("success");
      assert.equal(await cleanupCount("success"), 1);
      assert.deepEqual(
        {
          tenantId: delivered.tenant_id,
          attachmentId: delivered.attachment_id,
          storageKey: delivered.storage_key,
          state: delivered.state,
          attemptCount: delivered.attempt_count,
          leaseOwner: delivered.lease_owner,
          leaseExpiresAt: delivered.lease_expires_at,
          lastErrorCode: delivered.last_error_code,
        },
        {
          tenantId: "tenant-a",
          attachmentId: "success",
          storageKey: "private/tenant-a/success?credential=hidden",
          state: "delivered",
          attemptCount: "1",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
        },
      );
      assert.ok(delivered.delivered_at instanceof Date);
      assert.equal(
        delivered.delivered_at.toISOString(),
        delivered.updated_at.toISOString(),
      );

      const durableJson = JSON.stringify({ result, persisted });
      for (const unsafe of [
        "credential=hidden",
        "private/tenant-a",
        "objectKey",
        "storage_key",
        "provider-secret",
      ]) {
        assert.equal(durableJson.includes(unsafe), false, unsafe);
      }

      const replay = await command(request);
      assert.deepEqual(replay, { ...result, reconciliationStatus: "replayed" });
      assert.deepEqual(await cleanupDelivery("success"), delivered);
      assert.equal(
        storage.calls.filter(({ attachmentId }) => attachmentId === "success").length,
        1,
      );
      assert.deepEqual(await durableCounts("success"), {
        audits: 1,
        outbox: 1,
        outcomes: 1,
      });

      await assert.rejects(
        command(input("success", "abort-success-again")),
        (error) =>
          error instanceof AbortAttachmentCommandError &&
          error.code === "attachment_unavailable" &&
          error.message === "Attachment is unavailable",
      );

      await seedAttachment({ attachmentId: "key-conflict" });
      await assert.rejects(
        command(input("key-conflict", request.idempotencyKey)),
        (error) =>
          error instanceof AbortAttachmentCommandError &&
          error.code === "idempotency_conflict" &&
          !error.message.includes("success") &&
          !error.message.includes("key-conflict"),
      );
    });

    await t.test("rejects every ineligible or isolated row through one boundary", async () => {
      const checksum = `sha256:${"a".repeat(64)}`;
      await seedAttachment({ attachmentId: "checksummed", checksum });
      await seedAttachment({ attachmentId: "expired", expired: true });
      await seedAttachment({
        attachmentId: "foreign-uploader",
        uploaderUserId: "actor-b",
      });
      await seedAttachment({
        attachmentId: "cross-tenant",
        tenantId: "tenant-b",
      });
      await seedAttachment({ attachmentId: "already-abandoned" });
      await harness.pool.query(
        `UPDATE ${tables.attachments}
            SET state = 'abandoned', abandoned_at = statement_timestamp(),
                updated_at = statement_timestamp()
          WHERE tenant_id = 'tenant-a' AND id = 'already-abandoned'`,
      );
      await seedAttachment({ attachmentId: "already-attached" });
      await harness.pool.query(
        `UPDATE ${tables.attachments}
            SET state = 'attached', checksum = $1,
                attached_message_id = 'existing-message',
                attached_at = statement_timestamp(),
                updated_at = statement_timestamp()
          WHERE tenant_id = 'tenant-a' AND id = 'already-attached'`,
        [checksum],
      );

      const beforeCalls = storage.calls.length;
      for (const attachmentId of [
        "checksummed",
        "expired",
        "foreign-uploader",
        "cross-tenant",
        "already-abandoned",
        "already-attached",
        "absent",
      ]) {
        await assert.rejects(
          command(input(attachmentId)),
          (error) =>
            error instanceof AbortAttachmentCommandError &&
            error.code === "attachment_unavailable" &&
            error.statusCode === 404 &&
            error.message === "Attachment is unavailable",
        );
      }
      assert.equal(storage.calls.length, beforeCalls);
    });

    await t.test("cleanup failure leaves terminal state and exact retry resumes safely", async () => {
      await seedAttachment({ attachmentId: "cleanup-retry" });
      storage.failNext("cleanup-retry");
      const request = input("cleanup-retry");
      await assert.rejects(
        command(request, { requestId: "initial-cleanup-request" }),
        (error) =>
          error instanceof AbortAttachmentCommandError &&
          error.code === "storage_unavailable" &&
          error.message === "Attachment storage cleanup is temporarily unavailable" &&
          !error.message.includes("provider-secret") &&
          !error.message.includes("private/"),
      );

      const checkpoint = (
        await harness.pool.query(
          `SELECT attachment.state, attachment.checksum,
                  attachment.attached_message_id,
                  idempotency.state AS idempotency_state,
                  idempotency.response_body,
                  audit.request_id AS audit_request_id,
                  audit.metadata AS audit_metadata
             FROM ${tables.attachments} AS attachment
             INNER JOIN ${tables.idempotency} AS idempotency
               ON idempotency.tenant_id = attachment.tenant_id
              AND idempotency.operation_name = 'attachment.abort'
              AND idempotency.client_key = $2
             INNER JOIN ${tables.audit} AS audit
               ON audit.tenant_id = attachment.tenant_id
              AND audit.target_type = 'attachment'
              AND audit.target_id = attachment.id
              AND audit.action = 'attachment.abandoned'
            WHERE attachment.id = $1`,
          ["cleanup-retry", request.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(checkpoint, {
        state: "abandoned",
        checksum: null,
        attached_message_id: null,
        idempotency_state: "pending",
        response_body: null,
        audit_request_id: "initial-cleanup-request",
        audit_metadata: {
          outcome: "abandoned",
          cleanupMarker: checkpoint.audit_metadata.cleanupMarker,
        },
      });
      assert.match(
        checkpoint.audit_metadata.cleanupMarker,
        /^attachment-abort:[0-9a-f]{64}$/,
      );
      const readyDelivery = await cleanupDelivery("cleanup-retry");
      assert.equal(await cleanupCount("cleanup-retry"), 1);
      assert.deepEqual(
        {
          state: readyDelivery.state,
          attemptCount: readyDelivery.attempt_count,
          leaseOwner: readyDelivery.lease_owner,
          leaseExpiresAt: readyDelivery.lease_expires_at,
          lastErrorCode: readyDelivery.last_error_code,
          deliveredAt: readyDelivery.delivered_at,
        },
        {
          state: "pending",
          attemptCount: "0",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          deliveredAt: null,
        },
      );
      assert.ok(readyDelivery.next_attempt_at <= new Date());
      assert.deepEqual(await durableCounts("cleanup-retry"), {
        audits: 1,
        outbox: 1,
        outcomes: 0,
      });

      const recovered = await command(request, {
        requestId: "retry-cleanup-request",
      });
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.equal(recovered.attachment.status, "abandoned");
      assert.equal(
        storage.calls.filter(({ attachmentId }) => attachmentId === "cleanup-retry").length,
        2,
      );
      assert.deepEqual(await durableCounts("cleanup-retry"), {
        audits: 1,
        outbox: 1,
        outcomes: 1,
      });
      assert.equal((await cleanupDelivery("cleanup-retry")).state, "delivered");
    });

    await t.test("recovery clamps completion to a fractional-millisecond claim without changing payload or expiry", async () => {
      const attachmentId = "fractional-claim-recovery";
      await seedAttachment({ attachmentId });
      const request = input(attachmentId);
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        operation: request.operation,
        attachmentId,
      })).digest("hex")}`;
      const claim = (
        await harness.pool.query(
          `WITH timestamp AS (
             SELECT date_trunc('milliseconds', clock_timestamp())
               - interval '1 second' + interval '789 microseconds' AS value
           )
           INSERT INTO ${tables.idempotency} (
             tenant_id, user_id, operation_name, client_key, request_hash,
             created_at, updated_at, expires_at
           )
           SELECT 'tenant-a', 'actor-a', 'attachment.abort', $1, $2,
                  value, value, value + interval '1 day' FROM timestamp
          RETURNING created_at, expires_at::text AS expiry`,
          [request.idempotencyKey, requestHash],
        )
      ).rows[0];
      storage.failNext(attachmentId);
      // Establish the real audit recovery marker and cleanup checkpoint.
      await assert.rejects(command(request), (error) =>
        error instanceof AbortAttachmentCommandError &&
        error.code === "storage_unavailable",
      );
      const truncated = claim.created_at;
      assert.ok(truncated instanceof Date);
      let returnedAbandonments = 0;
      const recoveryDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              const result = await connection.query(text, values);
              if (text.includes("FOR UPDATE OF attachment")) {
                assert.equal(result.rows.length, 1);
                assert.equal(result.rows[0].id, attachmentId);
                returnedAbandonments += 1;
                // Only control the returned timestamp; every statement uses PostgreSQL.
                result.rows[0].abandoned_at = truncated;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const recovered = await command(request, { database: recoveryDatabase });
      assert.equal(returnedAbandonments, 1);
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.equal(recovered.attachment.status, "abandoned");
      assert.equal(recovered.attachment.abandonedAt, truncated.toISOString());
      const completed = (
        await harness.pool.query(
          `SELECT state, response_body, expires_at::text AS expiry,
                  created_at > $2::timestamptz AS fractional_claim,
                  completed_at = created_at AS completion_clamped,
                  updated_at = created_at AS update_clamped,
                  completed_at >= created_at AND updated_at >= created_at
                    AND expires_at > completed_at AND expires_at > updated_at
                    AS timestamps_ordered
             FROM ${tables.idempotency}
            WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
              AND operation_name = 'attachment.abort' AND client_key = $1`,
          [request.idempotencyKey, truncated],
        )
      ).rows[0];
      assert.deepEqual(completed, {
        state: "completed",
        response_body: { ...recovered, reconciliationStatus: "applied" },
        expiry: claim.expiry,
        fractional_claim: true,
        completion_clamped: true,
        update_clamped: true,
        timestamps_ordered: true,
      });
      const delivered = await cleanupDelivery(attachmentId);
      assert.equal(delivered.state, "delivered");
      assert.equal(delivered.attempt_count, "1");
      assert.equal(delivered.lease_owner, null);
      assert.equal(delivered.lease_expires_at, null);
      assert.ok(delivered.delivered_at instanceof Date);
      assert.equal(await cleanupCount(attachmentId), 1);
      const deletionCalls = () => storage.calls.filter(
        (call) => call.attachmentId === attachmentId,
      ).length;
      assert.equal(deletionCalls(), 2);
      const effects = { audits: 1, outbox: 1, outcomes: 1 };
      assert.deepEqual(await durableCounts(attachmentId), effects);

      assert.deepEqual(await command(request), recovered);
      assert.equal(deletionCalls(), 2);
      assert.deepEqual(await cleanupDelivery(attachmentId), delivered);
      assert.deepEqual(await durableCounts(attachmentId), effects);
    });

    await t.test("recovery preserves an already-delivered cleanup attempt exactly", async () => {
      const attachmentId = "delivered-recovery";
      await seedAttachment({ attachmentId });
      storage.failNext(attachmentId);
      const request = input(attachmentId);
      await assert.rejects(command(request), AbortAttachmentCommandError);

      await advanceCleanupToDelivered(attachmentId);
      const beforeRecovery = await cleanupDelivery(attachmentId);
      assert.equal(beforeRecovery.state, "delivered");
      assert.equal(beforeRecovery.attempt_count, "1");

      const recovered = await command(request);
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.deepEqual(await cleanupDelivery(attachmentId), beforeRecovery);
      assert.equal(await cleanupCount(attachmentId), 1);
      assert.deepEqual(await durableCounts(attachmentId), {
        audits: 1,
        outbox: 1,
        outcomes: 1,
      });
    });

    await t.test("recovery rematerializes missing cleanup for an abandoned row", async () => {
      const attachmentId = "missing-delivery-recovery";
      await seedAttachment({ attachmentId });
      storage.failNext(attachmentId);
      const request = input(attachmentId);
      await assert.rejects(command(request), AbortAttachmentCommandError);

      await harness.pool.query(
        `DELETE FROM ${tables.cleanup}
          WHERE tenant_id = 'tenant-a' AND attachment_id = $1`,
        [attachmentId],
      );
      assert.equal(await cleanupCount(attachmentId), 0);

      const recovered = await command(request);
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.equal(await cleanupCount(attachmentId), 1);
      const delivery = await cleanupDelivery(attachmentId);
      assert.equal(delivery.state, "delivered");
      assert.equal(delivery.attempt_count, "1");
      assert.deepEqual(await durableCounts(attachmentId), {
        audits: 1,
        outbox: 1,
        outcomes: 1,
      });
    });

    await t.test("concurrent same-key aborts create and settle one delivery", async () => {
      const attachmentId = "concurrent";
      await seedAttachment({ attachmentId });
      storage.delays.set(attachmentId, 30);
      const request = input(attachmentId);
      const results = await Promise.all([command(request), command(request)]);

      assert.deepEqual(
        results.map(({ reconciliationStatus }) => reconciliationStatus).sort(),
        ["applied", "replayed"],
      );
      assert.equal(await cleanupCount(attachmentId), 1);
      const delivery = await cleanupDelivery(attachmentId);
      assert.equal(delivery.state, "delivered");
      assert.equal(delivery.attempt_count, "1");
      assert.deepEqual(await durableCounts(attachmentId), {
        audits: 1,
        outbox: 1,
        outcomes: 1,
      });
    });

    await t.test("a rolled-back abandonment creates no cleanup delivery", async () => {
      const attachmentId = "rollback";
      await seedAttachment({ attachmentId });
      const rollbackDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (
                typeof text === "string" &&
                text.includes("INSERT INTO") &&
                text.includes("chat_audit_events")
              ) {
                throw new Error("injected abort audit failure");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };

      await assert.rejects(
        command(input(attachmentId), { database: rollbackDatabase }),
        /injected abort audit failure/,
      );
      const attachment = (
        await harness.pool.query(
          `SELECT state, checksum, attached_message_id, abandoned_at
             FROM ${tables.attachments}
            WHERE tenant_id = 'tenant-a' AND id = $1`,
          [attachmentId],
        )
      ).rows[0];
      assert.deepEqual(attachment, {
        state: "pending",
        checksum: null,
        attached_message_id: null,
        abandoned_at: null,
      });
      assert.equal(await cleanupCount(attachmentId), 0);
      assert.deepEqual(await durableCounts(attachmentId), {
        audits: 0,
        outbox: 0,
        outcomes: 0,
      });
      assert.equal(
        storage.calls.filter((call) => call.attachmentId === attachmentId).length,
        0,
      );
    });

    await t.test("interruption after deletion retries only idempotent cleanup completion", async () => {
      await seedAttachment({ attachmentId: "completion-crash" });
      let injected = false;
      const interruptedDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (
                !injected &&
                typeof text === "string" &&
                text.includes("UPDATE") &&
                text.includes("chat_idempotency_keys") &&
                text.includes("response_body")
              ) {
                injected = true;
                throw new Error("injected post-cleanup interruption");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };
      const request = input("completion-crash");
      await assert.rejects(
        command(request, { database: interruptedDatabase }),
        /injected post-cleanup interruption/,
      );
      assert.equal(storage.deleted.size > 0, true);
      assert.deepEqual(await durableCounts("completion-crash"), {
        audits: 1,
        outbox: 1,
        outcomes: 0,
      });

      const recovered = await command(request);
      assert.equal(recovered.reconciliationStatus, "replayed");
      assert.equal(
        storage.calls.filter(({ attachmentId }) => attachmentId === "completion-crash").length,
        2,
      );
      assert.deepEqual(await durableCounts("completion-crash"), {
        audits: 1,
        outbox: 1,
        outcomes: 1,
      });
    });

    await t.test("an abandoned attachment cannot be claimed by sendMessage", async () => {
      await seedAttachment({ attachmentId: "never-claimable" });
      await command(input("never-claimable"));

      await assert.rejects(
        sendMessage({
          database: harness.pool,
          schema: harness.schema,
          actor,
          input: {
            operation: "send",
            conversationId: "attachment-conversation",
            clientMessageId: "client-never-claimable",
            idempotencyKey: "send-never-claimable",
            content: {
              format: "plain",
              text: "Must not claim an abandoned attachment",
              attachments: [{ attachmentId: "never-claimable" }],
            },
          },
          directory: {
            async getUser() {
              throw new Error("directory must not be called");
            },
          },
          permissions: {
            async getCapabilities() {
              return ["message.send"];
            },
            async authorizeEntity() {
              return true;
            },
          },
        }),
        (error) =>
          error instanceof SendMessageCommandError &&
          error.code === "attachment_unavailable",
      );
      const created = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.messages}
          WHERE client_message_id = 'client-never-claimable'`,
      );
      assert.equal(created.rows[0].count, 0);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
