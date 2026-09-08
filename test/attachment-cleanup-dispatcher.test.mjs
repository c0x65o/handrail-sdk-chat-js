import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatAttachmentCleanupDispatcherError,
  ChatAttachmentCleanupProviderError,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
  createChatAttachmentCleanupDispatcher,
  normalizeChatAttachmentCleanupDispatcherOptions,
} from "@handrail/chat/server";

const cleanupRow = (overrides = {}) => ({
  tenant_id: "tenant-a",
  attachment_id: "attachment-a",
  storage_key: "private/object-key-a",
  uploader_user_id: "uploader-a",
  attempt_count: "1",
  ready_at: "2030-01-01T00:00:00.000Z",
  ...overrides,
});

const fakeDatabase = ({ batches = [], onConnectionQuery, onQuery } = {}) => {
  let batchIndex = 0;
  return {
    async connect() {
      return {
        async query(sql, values) {
          await onConnectionQuery?.(sql, values);
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("claimable AS MATERIALIZED")) {
            const batch = batches[batchIndex++] ?? [];
            if (batch instanceof Error) throw batch;
            return { rows: batch, rowCount: batch.length };
          }
          throw new Error(`unexpected connection query: ${sql}`);
        },
        release() {},
      };
    },
    async query(sql, values) {
      const override = await onQuery?.(sql, values);
      if (override) return override;
      if (sql.includes("SET state = 'delivered'") ||
          sql.includes("SET state = 'failed'")) {
        return { rows: [{ attachment_id: values[1] }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
};

const storageAdapter = (deleteObject = async () => {}) => ({ deleteObject });

const dispatcher = (options = {}) =>
  createChatAttachmentCleanupDispatcher({
    database: fakeDatabase(),
    adapter: storageAdapter(),
    createLeaseOwner: () => "cleanup-lease-a",
    ...options,
  });

const sequenceClock = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

test("attachment cleanup dispatcher validates and freezes bounded options", async () => {
  const defaults = normalizeChatAttachmentCleanupDispatcherOptions();
  assert.equal(defaults.batchSize, DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE);
  assert.equal(Object.isFrozen(defaults), true);
  for (const options of [
    { batchSize: 0 },
    { leaseDurationMs: 0 },
    { maxAttempts: 0 },
    { pollIntervalMs: -1 },
  ]) {
    assert.throws(
      () => normalizeChatAttachmentCleanupDispatcherOptions(options),
      /safe integer/u,
    );
  }
  assert.throws(
    () => normalizeChatAttachmentCleanupDispatcherOptions({
      initialRetryDelayMs: 11,
      maxRetryDelayMs: 10,
    }),
    /greater than or equal/u,
  );
  assert.throws(
    () => normalizeChatAttachmentCleanupDispatcherOptions({ onBatch: "bad" }),
    /onBatch must be a function/u,
  );
  const configurationOutcomes = [];
  await assert.rejects(
    dispatcher({
      createLeaseOwner: () => "secret invalid owner",
      onBatch(outcome) { configurationOutcomes.push(outcome); },
    }).runOnce(),
    (error) => error instanceof ChatAttachmentCleanupDispatcherError &&
      error.failureClass === "configuration" &&
      !error.message.includes("secret"),
  );
  assert.equal(configurationOutcomes.length, 1);
  assert.equal(configurationOutcomes[0].outcome, "failed");
  assert.equal(Object.isFrozen(configurationOutcomes[0]), true);

  const emptyOutcomes = [];
  const empty = dispatcher({
    database: fakeDatabase({ batches: [[]] }),
    onBatch(outcome) { emptyOutcomes.push(outcome); },
  });
  assert.deepEqual(await empty.runOnce(), { claimed: 0, delivered: 0, failed: 0 });
  assert.equal(emptyOutcomes.length, 1);
  assert.equal(emptyOutcomes[0].outcome, "empty");
  assert.equal(Object.isFrozen(emptyOutcomes[0]), true);
  await empty.stop();
});

test("commits a deterministic bounded lease before exact immutable adapter identity", async () => {
  const order = [];
  const calls = [];
  let releaseDelete;
  let deleteStarted;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  const started = new Promise((resolve) => { deleteStarted = resolve; });
  const database = fakeDatabase({
    batches: [[cleanupRow()]],
    onConnectionQuery(sql, values) {
      if (sql === "BEGIN") order.push("begin");
      if (sql.includes("claimable AS MATERIALIZED")) {
        order.push("claim");
        assert.deepEqual(values.slice(0, 4), [25, "cleanup-lease-a", 30_000, 5]);
        assert.match(sql, /ORDER BY ready_at, candidate\.tenant_id, candidate\.attachment_id/u);
        assert.match(sql, /FOR UPDATE OF candidate SKIP LOCKED/u);
        assert.match(sql, /attachment\.uploader_user_id/u);
      }
      if (sql === "COMMIT") order.push("commit");
    },
    onQuery(sql, values) {
      order.push("settle");
      assert.match(sql, /delivery\.lease_owner = \$3/u);
      assert.match(sql, /delivery\.attempt_count = \$4/u);
      assert.deepEqual(values.slice(0, 4), [
        "tenant-a", "attachment-a", "cleanup-lease-a", 1,
      ]);
    },
  });
  const worker = dispatcher({
    database,
    adapter: storageAdapter(async (input) => {
      order.push("delete");
      calls.push(input);
      deleteStarted();
      await deleteGate;
    }),
  });

  const first = worker.runOnce();
  const overlapping = worker.runOnce();
  assert.equal(first, overlapping);
  await started;
  assert.deepEqual(order, ["begin", "claim", "commit", "delete"]);
  releaseDelete();
  assert.deepEqual(await first, { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(order, ["begin", "claim", "commit", "delete", "settle"]);
  assert.deepEqual(calls, [{
    actor: { tenantId: "tenant-a", userId: "uploader-a", roles: [] },
    attachmentId: "attachment-a",
    objectKey: "private/object-key-a",
  }]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[0].actor), true);
  assert.equal(Object.isFrozen(calls[0].actor.roles), true);
  assert.equal(Object.isFrozen(worker), true);
  await worker.stop();
});

test("persists only bounded retry, terminal, exhausted, and invalid codes", async () => {
  const providerSecret = "provider-secret-message";
  const objectKeySecret = "object-key-must-not-reach-diagnostics";
  const settlements = [];
  const outcomes = [];
  const database = fakeDatabase({
    batches: [[
      cleanupRow({ attachment_id: "retry", attempt_count: "1" }),
      cleanupRow({ attachment_id: "unknown", attempt_count: "2" }),
      cleanupRow({ attachment_id: "terminal", attempt_count: "1" }),
      cleanupRow({ attachment_id: "exhausted", attempt_count: "3" }),
      cleanupRow({
        attachment_id: "malformed",
        storage_key: objectKeySecret,
        uploader_user_id: "",
        attempt_count: "1",
      }),
    ]],
    onQuery(sql, values) {
      assert.match(sql, /delivery\.lease_owner = \$3/u);
      assert.match(sql, /delivery\.attempt_count = \$4/u);
      settlements.push({ sql, values });
    },
  });
  const worker = dispatcher({
    database,
    maxAttempts: 3,
    initialRetryDelayMs: 100,
    maxRetryDelayMs: 250,
    now: () => new Date("2030-01-01T00:00:01.000Z"),
    monotonicNow: sequenceClock(10, 25),
    onBatch(outcome) { outcomes.push(outcome); },
    adapter: storageAdapter(async ({ attachmentId }) => {
      if (attachmentId === "retry" || attachmentId === "exhausted") {
        throw new ChatAttachmentCleanupProviderError("retryable");
      }
      if (attachmentId === "terminal") {
        throw new ChatAttachmentCleanupProviderError("terminal");
      }
      throw new Error(providerSecret);
    }),
  });

  assert.deepEqual(await worker.runOnce(), {
    claimed: 5,
    delivered: 0,
    failed: 5,
  });
  assert.deepEqual(
    settlements.map(({ values }) => ({
      attachmentId: values[1],
      attempt: values[3],
      code: values[4],
      delayMs: values[5],
    })),
    [
      { attachmentId: "retry", attempt: 1, code: "storage.retryable", delayMs: 100 },
      { attachmentId: "unknown", attempt: 2, code: "storage.unknown", delayMs: 200 },
      { attachmentId: "terminal", attempt: 1, code: "storage.terminal", delayMs: 0 },
      { attachmentId: "exhausted", attempt: 3, code: "storage.exhausted", delayMs: 0 },
      { attachmentId: "malformed", attempt: 1, code: "dispatcher.invalid_delivery", delayMs: 0 },
    ],
  );
  assert.deepEqual(outcomes, [{
    claimed: 5,
    delivered: 0,
    failed: 5,
    retried: 2,
    terminal: 2,
    exhausted: 1,
    staleSettlements: 0,
    durationMs: 15,
    oldestReadyAgeMs: 1_000,
    outcome: "failed",
  }]);
  assert.equal(Object.isFrozen(outcomes[0]), true);
  const diagnostics = JSON.stringify({ settlements, outcomes });
  assert.equal(diagnostics.includes(providerSecret), false);
  assert.equal(diagnostics.includes(objectKeySecret), false);
  await worker.stop();
});

test("generation fencing reports stale settlement without overwriting a claimant", async () => {
  const outcomes = [];
  const worker = dispatcher({
    database: fakeDatabase({
      batches: [[cleanupRow({ attempt_count: "7" })]],
      onQuery(sql, values) {
        assert.match(sql, /delivery\.lease_owner = \$3/u);
        assert.match(sql, /delivery\.attempt_count = \$4/u);
        assert.equal(values[3], 7);
        return { rows: [], rowCount: 0 };
      },
    }),
    onBatch(outcome) { outcomes.push(outcome); },
  });
  assert.deepEqual(await worker.runOnce(), {
    claimed: 1,
    delivered: 0,
    failed: 1,
  });
  assert.equal(outcomes[0].staleSettlements, 1);
  await worker.stop();
});

test("retries the same immutable identity after ambiguous settlement", async () => {
  const providerCalls = [];
  const outcomes = [];
  let rejectSettlement = true;
  const worker = dispatcher({
    database: fakeDatabase({
      batches: [[cleanupRow()], [cleanupRow({ attempt_count: "2" })]],
      onQuery(sql) {
        if (rejectSettlement && sql.includes("SET state = 'delivered'")) {
          rejectSettlement = false;
          throw new Error("database-secret-after-provider-success");
        }
      },
    }),
    adapter: storageAdapter(async (input) => { providerCalls.push(input); }),
    onBatch(outcome) { outcomes.push(outcome); },
  });
  await assert.rejects(
    worker.runOnce(),
    (error) => error instanceof ChatAttachmentCleanupDispatcherError &&
      error.failureClass === "database" &&
      !error.message.includes("secret"),
  );
  assert.deepEqual(await worker.runOnce(), {
    claimed: 1,
    delivered: 1,
    failed: 0,
  });
  assert.equal(providerCalls.length, 2);
  assert.deepEqual(providerCalls[0], providerCalls[1]);
  assert.equal(outcomes[0].failed, 1);
  assert.equal(JSON.stringify(outcomes).includes("secret"), false);
  await worker.stop();
});

test("stop is idempotent, awaits in-flight deletion, and callback failures are safe", async () => {
  let releaseDelete;
  let deleteStarted;
  const gate = new Promise((resolve) => { releaseDelete = resolve; });
  const started = new Promise((resolve) => { deleteStarted = resolve; });
  const worker = dispatcher({
    database: fakeDatabase({ batches: [[cleanupRow()]] }),
    adapter: storageAdapter(async () => {
      deleteStarted();
      await gate;
    }),
  });
  worker.start();
  await started;
  const firstStop = worker.stop();
  assert.equal(firstStop, worker.stop());
  let stopped = false;
  void firstStop.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  releaseDelete();
  await firstStop;
  assert.equal(worker.running, false);
  assert.equal(worker.stopped, true);

  const errors = [];
  const batches = [];
  const failing = dispatcher({
    database: fakeDatabase({ batches: [new Error("database-secret")] }),
    pollIntervalMs: 60_000,
    async onError(error) {
      errors.push(error);
      throw new Error("async-callback-secret");
    },
    onBatch(outcome) {
      batches.push(outcome);
      return Promise.reject(new Error("batch-callback-secret"));
    },
  });
  failing.start();
  await waitFor(() => errors.length === 1);
  await failing.stop();
  assert.equal(errors[0] instanceof ChatAttachmentCleanupDispatcherError, true);
  assert.equal(errors[0].failureClass, "database");
  assert.equal(errors[0].message.includes("secret"), false);
  assert.equal(batches.length, 1);
  assert.equal(Object.isFrozen(batches[0]), true);
});
