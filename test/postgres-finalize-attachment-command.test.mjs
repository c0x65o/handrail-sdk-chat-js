import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "../dist/contracts/realtime.js";
import {
  FinalizeAttachmentCommandError,
  finalizeAttachment,
} from "../dist/server/finalize-attachment-command.js";
import { createPostgresMigrationRunner } from "../dist/server/postgres-migrations.js";
import { handrailChatPostgresMigrations } from "../dist/server/postgres-schema-migrations.js";
import { createPostgresTestBackend } from "../dist/testing/index.js";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const checksum = (character = "a") => `sha256:${character.repeat(64)}`;
const input = (attachmentId, key = `finalize-${attachmentId}`) => ({
  operation: "finalize_attachment",
  attachmentId,
  idempotencyKey: key,
});

class FakeVerificationStorage {
  constructor() {
    this.calls = [];
    this.responses = new Map();
    this.failures = new Map();
    this.delays = new Map();
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
    this.calls.push(request);
    const delay = this.delays.get(request.attachmentId);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const failure = this.failures.get(request.attachmentId);
    if (failure) throw failure;
    return this.responses.get(request.attachmentId) ?? this.verified();
  }
}

test("trusted finalize-attachment converges storage verification atomically", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_finalize" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    attachments: `${schema}.chat_attachments`,
    cleanup: `${schema}.chat_attachment_cleanup_deliveries`,
    idempotency: `${schema}.chat_idempotency_keys`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
  };
  const storage = new FakeVerificationStorage();
  let idSequence = 0;
  const command = (commandInput, overrides = {}) =>
    finalizeAttachment({
      database: harness.pool,
      schema: harness.schema,
      storage,
      actor,
      input: commandInput,
      createId: () => `finalize-event-${++idSequence}`,
      ...overrides,
    });
  const seedAttachment = async ({
    attachmentId,
    tenantId = "tenant-a",
    uploaderUserId = "actor-a",
    expired = false,
    fileName = `${attachmentId}.pdf`,
    contentType = "application/pdf",
    sizeBytes = 42,
    storageKey = `private/${tenantId}/${attachmentId}?provider-secret=hidden`,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, created_at, updated_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         clock_timestamp() - $8::interval,
         clock_timestamp() - $8::interval,
         clock_timestamp() + $9::interval
       )`,
      [
        tenantId,
        attachmentId,
        uploaderUserId,
        storageKey,
        fileName,
        contentType,
        sizeBytes,
        expired ? "2 hours" : "1 minute",
        expired ? "-1 hour" : "1 hour",
      ],
    );
  };
  const counts = async (attachmentId) =>
    (
      await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.audit}
             WHERE target_type = 'attachment' AND target_id = $1) AS audits,
           (SELECT count(*)::integer FROM ${tables.outbox}
             WHERE payload -> 'attachment' ->> 'attachmentId' = $1) AS outbox,
           (SELECT count(*)::integer FROM ${tables.idempotency}
             WHERE operation_name = 'attachment.finalize'
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
  const assertPublicDataIsProviderNeutral = (value) => {
    const serialized = JSON.stringify(value);
    for (const unsafe of [
      "provider-secret",
      "private/tenant-a",
      "objectKey",
      "storage_key",
      "rawProviderResponse",
      "upload contents",
    ]) {
      assert.equal(serialized.includes(unsafe), false, unsafe);
    }
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("uses authoritative metadata, stores safe output, and never claims a message", async () => {
      await seedAttachment({ attachmentId: "success" });
      storage.responses.set(
        "success",
        storage.verified({ checksum: checksum("b") }),
      );
      const request = input("success");
      const result = await command(request);

      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.outcome, "finalized");
      assert.equal(result.attachment.status, "finalized");
      assert.equal(result.attachment.checksum, checksum("b"));
      assert.equal("messageId" in result, false);
      assert.equal("messageId" in result.attachment, false);
      assert.deepEqual(storage.calls.at(-1), {
        actor,
        attachmentId: "success",
        objectKey: "private/tenant-a/success?provider-secret=hidden",
      });

      const persisted = (
        await harness.pool.query(
          `SELECT attachment.state, attachment.checksum,
                  attachment.attached_message_id, attachment.attached_at,
                  idempotency.response_body, audit.metadata AS audit_metadata,
                  audit.action AS audit_action, outbox.stream_id,
                  outbox.protocol_version, outbox.type AS outbox_type,
                  outbox.payload
             FROM ${tables.attachments} AS attachment
             INNER JOIN ${tables.idempotency} AS idempotency
               ON idempotency.tenant_id = attachment.tenant_id
              AND idempotency.operation_name = 'attachment.finalize'
              AND idempotency.client_key = $2
             INNER JOIN ${tables.audit} AS audit
               ON audit.tenant_id = attachment.tenant_id
              AND audit.target_type = 'attachment'
              AND audit.target_id = attachment.id
             INNER JOIN ${tables.outbox} AS outbox
               ON outbox.tenant_id = attachment.tenant_id
              AND outbox.payload -> 'attachment' ->> 'attachmentId' = attachment.id
            WHERE attachment.tenant_id = 'tenant-a' AND attachment.id = $1`,
          ["success", request.idempotencyKey],
        )
      ).rows[0];
      assert.equal(persisted.state, "pending");
      assert.equal(persisted.checksum, checksum("b"));
      assert.equal(persisted.attached_message_id, null);
      assert.equal(persisted.attached_at, null);
      assert.deepEqual(persisted.response_body, result);
      assert.equal(persisted.audit_action, "attachment.finalized");
      assert.deepEqual(persisted.audit_metadata, { outcome: "finalized" });
      assert.equal(persisted.stream_id, "user:actor-a");
      assert.equal(Number(persisted.protocol_version), CHAT_PROTOCOL_VERSION);
      assert.equal(persisted.outbox_type, "attachment.finalized");
      assert.deepEqual(persisted.payload, {
        outcome: "finalized",
        attachment: result.attachment,
      });
      assertPublicDataIsProviderNeutral({ result, persisted });
      assert.equal(await cleanupCount("success"), 0);

      const replay = await command(request);
      assert.deepEqual(replay, { ...result, reconciliationStatus: "replayed" });
      assert.equal(storage.calls.filter(({ attachmentId }) => attachmentId === "success").length, 1);
      assert.deepEqual(await counts("success"), { audits: 1, outbox: 1, outcomes: 1 });

      await seedAttachment({ attachmentId: "conflict" });
      await assert.rejects(
        command(input("conflict", request.idempotencyKey)),
        (error) =>
          error instanceof FinalizeAttachmentCommandError &&
          error.code === "idempotency_conflict" &&
          !error.message.includes("success") &&
          !error.message.includes("conflict"),
      );
    });

    await t.test("a fractional-millisecond claim completes and replays without duplicate effects", async () => {
      const attachmentId = "fractional-claim";
      await seedAttachment({ attachmentId });
      const request = input(attachmentId);
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        operation: request.operation,
        attachmentId: request.attachmentId,
      })).digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           state, created_at, updated_at, expires_at
         )
         SELECT $1, $2, 'attachment.finalize', $3, $4, 'pending',
                claimed_at, claimed_at, claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at, expires_at::text`,
        [actor.tenantId, actor.userId, request.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              // Execute all SQL and transactions in PostgreSQL; control only
              // the returned attachment clock to reproduce Date truncation.
              const result = await connection.query(sql, values);
              if (sql.includes(`UPDATE ${tables.attachments}`) &&
                  sql.includes("RETURNING id")) {
                assert.equal(result.rows.length, 1);
                result.rows[0].updated_at = claim.created_at;
                clockSamples += 1;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const result = await command(request, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.outcome, "finalized");
      assert.equal(result.attachment.status, "finalized");
      assert.equal(result.attachment.finalizedAt, claim.created_at.toISOString());

      const storedOutcome = async () => (await harness.pool.query(
        `SELECT state, response_status, response_body,
                created_at::text, updated_at::text, completed_at::text, expires_at::text,
                completed_at = created_at AS completion_equals_claim,
                updated_at = created_at AS update_equals_claim,
                created_at - $4::timestamptz = interval '456 microseconds' AS precision_gap
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = 'attachment.finalize' AND client_key = $3`,
        [actor.tenantId, actor.userId, request.idempotencyKey, claim.created_at],
      )).rows;
      const outcome = await storedOutcome();
      assert.equal(outcome.length, 1);
      assert.equal(outcome[0].state, "completed");
      assert.equal(outcome[0].response_status, 200);
      assert.deepEqual(outcome[0].response_body, result);
      for (const field of ["completion_equals_claim", "update_equals_claim", "precision_gap"]) {
        assert.equal(outcome[0][field], true, field);
      }
      assert.equal(outcome[0].completed_at, outcome[0].created_at);
      assert.equal(outcome[0].updated_at, outcome[0].created_at);
      assert.equal(outcome[0].expires_at, claim.expires_at);

      const effects = async () => (await harness.pool.query(
        `SELECT audit.occurred_at AS audit_clock, outbox.occurred_at AS outbox_clock,
                to_jsonb(audit) AS audit, to_jsonb(outbox) AS outbox
         FROM ${tables.audit} AS audit
         JOIN ${tables.outbox} AS outbox
           ON outbox.tenant_id = audit.tenant_id
          AND outbox.payload -> 'attachment' ->> 'attachmentId' = audit.target_id
         WHERE audit.tenant_id = $1 AND audit.target_type = 'attachment'
           AND audit.target_id = $2`,
        [actor.tenantId, attachmentId],
      )).rows;
      const persistedEffects = await effects();
      assert.equal(persistedEffects.length, 1);
      assert.equal(persistedEffects[0].audit_clock.toISOString(), result.attachment.finalizedAt);
      assert.equal(persistedEffects[0].outbox_clock.toISOString(), result.attachment.finalizedAt);
      assert.deepEqual(persistedEffects[0].outbox.payload, {
        outcome: result.outcome,
        attachment: result.attachment,
      });
      const verificationCalls = storage.calls.filter((call) => call.attachmentId === attachmentId);
      assert.equal(verificationCalls.length, 1);
      assert.deepEqual(await counts(attachmentId), { audits: 1, outbox: 1, outcomes: 1 });

      assert.deepEqual(await command(request, { database: clockDatabase }), {
        ...result, reconciliationStatus: "replayed",
      });
      assert.equal(clockSamples, 1);
      assert.deepEqual(storage.calls.filter((call) => call.attachmentId === attachmentId), verificationCalls);
      assert.deepEqual(await storedOutcome(), outcome);
      assert.deepEqual(await effects(), persistedEffects);
      assert.deepEqual(await counts(attachmentId), { audits: 1, outbox: 1, outcomes: 1 });
    });

    await t.test("every rejected verification path atomically enqueues the authoritative object", async () => {
      const cases = [
        ["size", storage.verified({ sizeBytes: 43 }), "size_mismatch"],
        ["checksum", { status: "rejected", reason: "checksum_mismatch" }, "checksum_mismatch"],
        ["type", storage.verified({ contentType: "image/png" }), "content_type_mismatch"],
        ["unsafe", { status: "rejected", reason: "unsafe" }, "unsafe"],
        ["scan", { status: "rejected", reason: "scan_failed" }, "scan_failed"],
        ["missing", { status: "rejected", reason: "missing_object" }, "missing_object"],
        ["metadata", { status: "rejected", reason: "invalid_metadata" }, "invalid_metadata"],
      ];
      for (const [attachmentId, response, reason] of cases) {
        const storageKey = `private/tenant-a/${attachmentId}?provider-secret=hidden`;
        await seedAttachment({ attachmentId });
        storage.responses.set(attachmentId, response);
        const request = input(attachmentId);
        const result = await command(request);
        assert.equal(result.outcome, "rejected");
        assert.equal(result.attachment.status, "rejected");
        assert.equal(result.attachment.rejectionReason, reason);
        const row = (
          await harness.pool.query(
            `SELECT state, checksum, attached_message_id, abandoned_at
               FROM ${tables.attachments} WHERE id = $1`,
            [attachmentId],
          )
        ).rows[0];
        assert.equal(row.state, "abandoned");
        assert.equal(row.checksum, null);
        assert.equal(row.attached_message_id, null);
        assert.ok(row.abandoned_at instanceof Date);
        const delivery = await cleanupDelivery(attachmentId);
        assert.equal(await cleanupCount(attachmentId), 1);
        assert.ok(delivery.next_attempt_at instanceof Date);
        assert.ok(delivery.created_at instanceof Date);
        assert.ok(delivery.updated_at instanceof Date);
        assert.deepEqual(
          {
            tenantId: delivery.tenant_id,
            attachmentId: delivery.attachment_id,
            storageKey: delivery.storage_key,
            state: delivery.state,
            attemptCount: Number(delivery.attempt_count),
            leaseOwner: delivery.lease_owner,
            leaseExpiresAt: delivery.lease_expires_at,
            lastErrorCode: delivery.last_error_code,
            deliveredAt: delivery.delivered_at,
          },
          {
            tenantId: "tenant-a",
            attachmentId,
            storageKey,
            state: "pending",
            attemptCount: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
            deliveredAt: null,
          },
        );
        assert.deepEqual(await counts(attachmentId), { audits: 1, outbox: 1, outcomes: 1 });

        const publicArtifacts = (
          await harness.pool.query(
            `SELECT idempotency.response_body, audit.metadata AS audit_metadata,
                    outbox.payload
               FROM ${tables.idempotency} AS idempotency
               INNER JOIN ${tables.audit} AS audit
                 ON audit.tenant_id = idempotency.tenant_id
                AND audit.target_type = 'attachment'
                AND audit.target_id = $1
               INNER JOIN ${tables.outbox} AS outbox
                 ON outbox.tenant_id = idempotency.tenant_id
                AND outbox.payload -> 'attachment' ->> 'attachmentId' = $1
              WHERE idempotency.operation_name = 'attachment.finalize'
                AND idempotency.client_key = $2`,
            [attachmentId, request.idempotencyKey],
          )
        ).rows[0];
        assertPublicDataIsProviderNeutral({ result, publicArtifacts });
      }
    });

    await t.test("exact-key rejected replay preserves an advanced cleanup delivery", async () => {
      const attachmentId = "rejected-replay";
      await seedAttachment({ attachmentId });
      storage.responses.set(attachmentId, { status: "rejected", reason: "unsafe" });
      const request = input(attachmentId);
      const applied = await command(request);
      await advanceCleanupToDelivered(attachmentId);
      const beforeReplay = await cleanupDelivery(attachmentId);
      assert.equal(beforeReplay.state, "delivered");
      assert.equal(beforeReplay.attempt_count, "1");

      const replay = await command(request);
      assert.deepEqual(replay, { ...applied, reconciliationStatus: "replayed" });
      assert.deepEqual(await cleanupDelivery(attachmentId), beforeReplay);
      assert.equal(await cleanupCount(attachmentId), 1);
      assert.equal(storage.calls.filter((call) => call.attachmentId === attachmentId).length, 1);
      assert.deepEqual(await counts(attachmentId), { audits: 1, outbox: 1, outcomes: 1 });
      assertPublicDataIsProviderNeutral({ applied, replay });
    });

    await t.test("denies expired, cross-tenant, and different-uploader rows identically", async () => {
      await seedAttachment({ attachmentId: "expired", expired: true });
      await seedAttachment({ attachmentId: "cross-tenant", tenantId: "tenant-b" });
      await seedAttachment({ attachmentId: "other-uploader", uploaderUserId: "actor-b" });
      const beforeCalls = storage.calls.length;
      for (const attachmentId of ["expired", "cross-tenant", "other-uploader", "absent"]) {
        await assert.rejects(
          command(input(attachmentId)),
          (error) =>
            error instanceof FinalizeAttachmentCommandError &&
            error.code === "attachment_unavailable" &&
            error.message === "Attachment is unavailable",
        );
      }
      assert.equal(storage.calls.length, beforeCalls);
    });

    await t.test("same-key concurrent rejection cannot duplicate or reset cleanup delivery", async () => {
      await seedAttachment({ attachmentId: "concurrent" });
      storage.responses.set("concurrent", { status: "rejected", reason: "scan_failed" });
      storage.delays.set("concurrent", 30);
      const request = input("concurrent");
      const results = await Promise.all([command(request), command(request)]);
      assert.deepEqual(
        results.map(({ reconciliationStatus }) => reconciliationStatus).sort(),
        ["applied", "replayed"],
      );
      assert.deepEqual(results.map(({ outcome }) => outcome), ["rejected", "rejected"]);
      assert.equal(storage.calls.filter(({ attachmentId }) => attachmentId === "concurrent").length, 1);
      assert.deepEqual(await counts("concurrent"), { audits: 1, outbox: 1, outcomes: 1 });
      assert.equal(await cleanupCount("concurrent"), 1);
      assert.equal((await cleanupDelivery("concurrent")).state, "pending");

      await advanceCleanupToDelivered("concurrent");
      const beforeConcurrentReplay = await cleanupDelivery("concurrent");
      const concurrentReplays = await Promise.all([command(request), command(request)]);
      assert.deepEqual(
        concurrentReplays.map(({ reconciliationStatus }) => reconciliationStatus),
        ["replayed", "replayed"],
      );
      assert.deepEqual(await cleanupDelivery("concurrent"), beforeConcurrentReplay);
      assert.equal(await cleanupCount("concurrent"), 1);
      assert.deepEqual(await counts("concurrent"), { audits: 1, outbox: 1, outcomes: 1 });
    });

    await t.test("transient and malformed adapter failures preserve retryability without leaking details", async () => {
      for (const [attachmentId, failure] of [
        ["transient", new Error("secret provider object private/transient")],
        ["malformed", null],
      ]) {
        await seedAttachment({ attachmentId });
        if (failure) storage.failures.set(attachmentId, failure);
        else {
          storage.responses.set(attachmentId, {
            ...storage.verified(),
            rawProviderResponse: { secret: "must-not-cross" },
          });
        }
        await assert.rejects(
          command(input(attachmentId)),
          (error) =>
            error instanceof FinalizeAttachmentCommandError &&
            error.code === "storage_unavailable" &&
            error.message === "Attachment storage verification is temporarily unavailable" &&
            !error.message.includes("secret") &&
            !error.message.includes("private"),
        );
        const row = (
          await harness.pool.query(
            `SELECT state, checksum FROM ${tables.attachments} WHERE id = $1`,
            [attachmentId],
          )
        ).rows[0];
        assert.deepEqual(row, { state: "pending", checksum: null });
        assert.deepEqual(await counts(attachmentId), { audits: 0, outbox: 0, outcomes: 0 });

        storage.failures.delete(attachmentId);
        storage.responses.set(attachmentId, storage.verified());
        assert.equal((await command(input(attachmentId))).outcome, "finalized");
      }
    });

    await t.test("a failure after cleanup enqueue rolls abandonment and every side effect back", async () => {
      await seedAttachment({ attachmentId: "rollback" });
      storage.responses.set("rollback", { status: "rejected", reason: "unsafe" });
      const lateFailureDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (
                typeof text === "string" &&
                text.includes("INSERT INTO") &&
                text.includes("chat_outbox_events")
              ) {
                throw new Error("injected finalize outbox failure");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };
      const request = input("rollback");
      await assert.rejects(
        command(request, { database: lateFailureDatabase }),
        /injected finalize outbox failure/,
      );
      const row = (
        await harness.pool.query(
          `SELECT state, checksum, attached_message_id
             FROM ${tables.attachments} WHERE id = 'rollback'`,
        )
      ).rows[0];
      assert.deepEqual(row, {
        state: "pending",
        checksum: null,
        attached_message_id: null,
      });
      assert.equal(await cleanupCount("rollback"), 0);
      assert.deepEqual(await counts("rollback"), { audits: 0, outbox: 0, outcomes: 0 });
      assert.equal((await command(request)).outcome, "rejected");
      assert.equal(await cleanupCount("rollback"), 1);
      assert.equal((await cleanupDelivery("rollback")).state, "pending");
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
