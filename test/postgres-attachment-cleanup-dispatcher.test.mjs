import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatAttachmentCleanupDispatcherError,
  ChatAttachmentCleanupProviderError,
  createChatAttachmentCleanupDispatcher,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const storageAdapter = (deleteObject) => ({ deleteObject });

test("attachment cleanup dispatcher leases and settles durable PostgreSQL work", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "cleanup_dispatcher" });
  const prefix = quoteIdentifier(harness.schema);
  const attachments = `${prefix}.chat_attachments`;
  const deliveries = `${prefix}.chat_attachment_cleanup_deliveries`;
  const workers = new Set();
  let leaseOrdinal = 0;

  const seed = async ({
    tenantId = "tenant-a",
    attachmentId,
    uploaderUserId = `uploader-${attachmentId}`,
    objectKey = `${tenantId}/private/${attachmentId}`,
    createdAt = "2020-01-03T00:00:00.000Z",
  }) => {
    await harness.pool.query(
      `INSERT INTO ${attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, created_at, updated_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'text/plain', 12,
                 '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
                 '2099-01-01T00:00:00Z')`,
      [tenantId, attachmentId, uploaderUserId, objectKey, `${attachmentId}.txt`],
    );
    await harness.pool.query(
      `UPDATE ${attachments}
       SET state = 'abandoned',
           abandoned_at = '2020-01-02T00:00:00Z',
           updated_at = '2020-01-02T00:00:00Z'
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, attachmentId],
    );
    await harness.pool.query(
      `INSERT INTO ${deliveries} (
         tenant_id, attachment_id, storage_key, next_attempt_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4, $4)`,
      [tenantId, attachmentId, objectKey, createdAt],
    );
  };

  const worker = (deleteObject, options = {}) => {
    const dispatcher = createChatAttachmentCleanupDispatcher({
      database: harness.pool,
      schema: harness.schema,
      adapter: storageAdapter(deleteObject),
      batchSize: 50,
      pollIntervalMs: 60_000,
      leaseDurationMs: 100,
      createLeaseOwner: () => `cleanup-worker-${++leaseOrdinal}`,
      ...options,
    });
    workers.add(dispatcher);
    return dispatcher;
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("claims a deterministic bounded batch after committing its lease", async () => {
      await seed({
        tenantId: "ordered",
        attachmentId: "later",
        createdAt: "2020-01-03T00:00:02.000Z",
      });
      await seed({
        tenantId: "ordered",
        attachmentId: "first-b",
        createdAt: "2020-01-03T00:00:00.000Z",
      });
      await seed({
        tenantId: "ordered",
        attachmentId: "first-a",
        createdAt: "2020-01-03T00:00:00.000Z",
      });
      const calls = [];
      const dispatcher = worker(async (input) => {
        const stored = (
          await harness.pool.query(
            `SELECT state, attempt_count, lease_owner
             FROM ${deliveries}
             WHERE tenant_id = $1 AND attachment_id = $2`,
            [input.actor.tenantId, input.attachmentId],
          )
        ).rows[0];
        assert.equal(stored.state, "leased");
        assert.equal(stored.attempt_count, "1");
        assert.match(stored.lease_owner, /^cleanup-worker-/u);
        calls.push(input);
      }, { batchSize: 2 });

      assert.deepEqual(await dispatcher.runOnce(), {
        claimed: 2,
        delivered: 2,
        failed: 0,
      });
      assert.deepEqual(calls.map(({ attachmentId }) => attachmentId), [
        "first-a", "first-b",
      ]);
      assert.deepEqual(await dispatcher.runOnce(), {
        claimed: 1,
        delivered: 1,
        failed: 0,
      });
      assert.deepEqual(calls.map(({ attachmentId }) => attachmentId), [
        "first-a", "first-b", "later",
      ]);
      assert.deepEqual(calls[0], {
        actor: {
          tenantId: "ordered",
          userId: "uploader-first-a",
          roles: [],
        },
        attachmentId: "first-a",
        objectKey: "ordered/private/first-a",
      });
      assert.equal(calls.every(Object.isFrozen), true);
      assert.equal(calls.every(({ actor }) => Object.isFrozen(actor)), true);
      assert.equal(calls.every(({ actor }) => Object.isFrozen(actor.roles)), true);
    });

    await t.test("allows exactly one concurrent claimant for an unexpired lease", async () => {
      await seed({ tenantId: "concurrent", attachmentId: "one-claimant" });
      let release;
      let started = false;
      const gate = new Promise((resolve) => { release = resolve; });
      const first = worker(async () => {
        started = true;
        await gate;
      }, { leaseDurationMs: 5_000 });
      const firstRun = first.runOnce();
      await waitFor(() => started);

      const secondCalls = [];
      const second = worker(async (input) => { secondCalls.push(input); });
      assert.deepEqual(await second.runOnce(), {
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      assert.deepEqual(secondCalls, []);
      release();
      assert.equal((await firstRun).delivered, 1);
    });

    await t.test("recovers an expired lease and fences its stale attempt generation", async () => {
      await seed({ tenantId: "expired", attachmentId: "recoverable" });
      let releaseFirst;
      let firstStarted = false;
      const gate = new Promise((resolve) => { releaseFirst = resolve; });
      const calls = [];
      const first = worker(async (input) => {
        calls.push(input);
        firstStarted = true;
        await gate;
      }, { leaseDurationMs: 25 });
      const firstRun = first.runOnce();
      await waitFor(() => firstStarted);
      await new Promise((resolve) => setTimeout(resolve, 45));

      const second = worker(async (input) => { calls.push(input); }, {
        leaseDurationMs: 1_000,
      });
      assert.equal((await second.runOnce()).delivered, 1);
      releaseFirst();
      assert.deepEqual(await firstRun, {
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);

      const stored = (
        await harness.pool.query(
          `SELECT state, attempt_count, delivered_at, lease_owner
           FROM ${deliveries}
           WHERE tenant_id = 'expired' AND attachment_id = 'recoverable'`,
        )
      ).rows[0];
      assert.deepEqual({
        state: stored.state,
        attemptCount: stored.attempt_count,
        delivered: stored.delivered_at instanceof Date,
        leaseOwner: stored.lease_owner,
      }, {
        state: "delivered",
        attemptCount: "2",
        delivered: true,
        leaseOwner: null,
      });
    });

    await t.test("retries idempotently after provider success and ambiguous settlement", async () => {
      await seed({ tenantId: "ambiguous", attachmentId: "ack-loss" });
      let rejectSettlement = true;
      const database = {
        connect: () => harness.pool.connect(),
        query: async (sql, values) => {
          if (rejectSettlement && sql.includes("SET state = 'delivered'")) {
            rejectSettlement = false;
            throw new Error("database-secret-after-delete");
          }
          return harness.pool.query(sql, values);
        },
      };
      const calls = [];
      const first = createChatAttachmentCleanupDispatcher({
        database,
        schema: harness.schema,
        adapter: storageAdapter(async (input) => { calls.push(input); }),
        leaseDurationMs: 25,
        createLeaseOwner: () => "ambiguous-first",
      });
      workers.add(first);
      await assert.rejects(
        first.runOnce(),
        (error) => error instanceof ChatAttachmentCleanupDispatcherError &&
          error.failureClass === "database" &&
          !error.message.includes("secret"),
      );
      await new Promise((resolve) => setTimeout(resolve, 45));
      const second = worker(async (input) => { calls.push(input); });
      assert.equal((await second.runOnce()).delivered, 1);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.equal(JSON.stringify(calls).includes("database-secret"), false);
    });

    await t.test("schedules bounded retries and leaves terminal or exhausted rows ineligible", async () => {
      await seed({ tenantId: "failures", attachmentId: "retry" });
      await seed({ tenantId: "failures", attachmentId: "terminal" });
      await seed({ tenantId: "failures", attachmentId: "exhausted" });
      const moment = new Date(Date.now() + 1_000);
      const dispatcher = worker(async ({ attachmentId }) => {
        if (attachmentId === "terminal") {
          throw new ChatAttachmentCleanupProviderError("terminal");
        }
        throw new ChatAttachmentCleanupProviderError("retryable");
      }, {
        now: () => moment,
        maxAttempts: 1,
        initialRetryDelayMs: 100,
        maxRetryDelayMs: 150,
      });
      assert.deepEqual(await dispatcher.runOnce(), {
        claimed: 3,
        delivered: 0,
        failed: 3,
      });
      let states = await harness.pool.query(
        `SELECT attachment_id, state, attempt_count, next_attempt_at,
                updated_at, last_error_code, lease_owner
         FROM ${deliveries}
         WHERE tenant_id = 'failures'
         ORDER BY attachment_id`,
      );
      assert.deepEqual(
        states.rows.map((row) => ({
          id: row.attachment_id,
          state: row.state,
          attemptCount: row.attempt_count,
          delay: row.next_attempt_at.valueOf() - row.updated_at.valueOf(),
          errorCode: row.last_error_code,
          leaseOwner: row.lease_owner,
        })),
        [
          {
            id: "exhausted", state: "failed", attemptCount: "1", delay: 0,
            errorCode: "storage.exhausted", leaseOwner: null,
          },
          {
            id: "retry", state: "failed", attemptCount: "1", delay: 0,
            errorCode: "storage.exhausted", leaseOwner: null,
          },
          {
            id: "terminal", state: "failed", attemptCount: "1", delay: 0,
            errorCode: "storage.terminal", leaseOwner: null,
          },
        ],
      );
      assert.equal((await dispatcher.runOnce()).claimed, 0);

      await seed({ tenantId: "bounded", attachmentId: "retry-delay" });
      const retry = worker(async () => {
        throw new ChatAttachmentCleanupProviderError("retryable");
      }, {
        now: () => moment,
        maxAttempts: 5,
        initialRetryDelayMs: 100,
        maxRetryDelayMs: 150,
      });
      assert.equal((await retry.runOnce()).failed, 1);
      states = await harness.pool.query(
        `SELECT next_attempt_at, updated_at, last_error_code
         FROM ${deliveries}
         WHERE tenant_id = 'bounded' AND attachment_id = 'retry-delay'`,
      );
      assert.equal(
        states.rows[0].next_attempt_at.valueOf() - states.rows[0].updated_at.valueOf(),
        100,
      );
      assert.equal(states.rows[0].last_error_code, "storage.retryable");
    });
  } finally {
    await Promise.all([...workers].map((dispatcher) => dispatcher.stop()));
    await harness.teardown();
    await backend.teardown();
  }
});
