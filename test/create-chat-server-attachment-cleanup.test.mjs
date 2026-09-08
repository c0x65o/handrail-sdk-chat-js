import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatAttachmentCleanupDispatcherError,
  ChatAttachmentCleanupProviderError,
  ChatServerConfigurationError,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_INITIAL_RETRY_DELAY_MS,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_LEASE_DURATION_MS,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_RETRY_DELAY_MS,
  DEFAULT_CHAT_ATTACHMENT_CLEANUP_POLL_INTERVAL_MS,
  createChatServer,
} from "@handrail/chat/server";

const requiredAdapters = () => ({
  auth: { async resolveActor() { throw new Error("auth must stay inert"); } },
  directory: {
    async getUser() { throw new Error("directory must stay inert"); },
    async searchUsers() { throw new Error("directory must stay inert"); },
  },
  permissions: {
    async getCapabilities() { throw new Error("permissions must stay inert"); },
    async authorizeEntity() { throw new Error("permissions must stay inert"); },
  },
});

const storageAdapter = (deleteObject = async () => {}) => ({
  async createUploadUrl() { throw new Error("upload must stay inert"); },
  async verifyObject() { throw new Error("verification must stay inert"); },
  async createDownloadUrl() { throw new Error("download must stay inert"); },
  deleteObject,
});

const cleanupRow = (attachmentId, overrides = {}) => ({
  tenant_id: "tenant-cleanup",
  attachment_id: attachmentId,
  storage_key: `private/${attachmentId}`,
  uploader_user_id: "uploader-cleanup",
  attempt_count: "1",
  ready_at: "2020-01-01T00:00:00.000Z",
  ...overrides,
});

const makeRuntimeDatabase = ({
  cleanupBatches = [],
  cleanupClaimError,
  onEnd,
  onCleanupSettlement,
} = {}) => {
  let batchIndex = 0;
  let endCount = 0;
  const cleanupClaims = [];
  const cleanupQueries = [];
  const allQueries = [];

  const record = (sql) => {
    allQueries.push(sql);
    if (sql.includes("chat_attachment_cleanup_deliveries")) {
      cleanupQueries.push(sql);
    }
  };

  const resource = {
    async query(sql, values = []) {
      record(sql);
      if (sql.includes("WITH claim_clock AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH expired_keys AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("chat_attachment_cleanup_deliveries") &&
        (sql.includes("SET state = 'delivered'") ||
          sql.includes("SET state = 'failed'"))
      ) {
        await onCleanupSettlement?.(sql, values);
        return { rows: [{ attachment_id: values[1] }], rowCount: 1 };
      }
      throw new Error(`unexpected runtime query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, values = []) {
          record(sql);
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rows: [], rowCount: 0 };
          }
          if (
            sql.includes("chat_attachment_cleanup_deliveries") &&
            sql.includes("claimable AS MATERIALIZED")
          ) {
            cleanupClaims.push(values);
            if (cleanupClaimError !== undefined) throw cleanupClaimError;
            const rows = cleanupBatches[batchIndex++] ?? [];
            return { rows, rowCount: rows.length };
          }
          if (
            sql.includes("chat_outbox_events") &&
            sql.includes("FOR UPDATE OF event SKIP LOCKED")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (
            sql.includes("chat_attachments") &&
            sql.includes("attachment.state = 'pending'")
          ) {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`unexpected runtime connection query: ${sql}`);
        },
        release() {},
      };
    },
    async end() {
      endCount += 1;
      await onEnd?.();
    },
  };

  return {
    resource,
    cleanupClaims,
    cleanupQueries,
    allQueries,
    get endCount() { return endCount; },
  };
};

const minimalConfig = (database) => ({
  database: { pool: database },
  ...requiredAdapters(),
  outbox: { pollIntervalMs: 60_000 },
  postgresMaintenance: { pollIntervalMs: 60_000 },
});

const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const sequenceClock = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

test("normalizes attachment cleanup options before owned pool allocation", async () => {
  const defaultsDatabase = makeRuntimeDatabase();
  const defaults = createChatServer(minimalConfig(defaultsDatabase.resource));
  assert.deepEqual(
    {
      batchSize: defaults.config.attachmentCleanup.batchSize,
      pollIntervalMs: defaults.config.attachmentCleanup.pollIntervalMs,
      leaseDurationMs: defaults.config.attachmentCleanup.leaseDurationMs,
      maxAttempts: defaults.config.attachmentCleanup.maxAttempts,
      initialRetryDelayMs:
        defaults.config.attachmentCleanup.initialRetryDelayMs,
      maxRetryDelayMs: defaults.config.attachmentCleanup.maxRetryDelayMs,
    },
    {
      batchSize: DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
      pollIntervalMs: DEFAULT_CHAT_ATTACHMENT_CLEANUP_POLL_INTERVAL_MS,
      leaseDurationMs: DEFAULT_CHAT_ATTACHMENT_CLEANUP_LEASE_DURATION_MS,
      maxAttempts: DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
      initialRetryDelayMs:
        DEFAULT_CHAT_ATTACHMENT_CLEANUP_INITIAL_RETRY_DELAY_MS,
      maxRetryDelayMs: DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_RETRY_DELAY_MS,
    },
  );
  assert.equal(Object.isFrozen(defaults.config.attachmentCleanup), true);
  await defaults.close();

  const invalidOptions = [
    null,
    [],
    "enabled",
    { unsupported: true },
    { batchSize: 0 },
    { pollIntervalMs: -1 },
    { leaseDurationMs: 0 },
    { maxAttempts: 0 },
    { initialRetryDelayMs: -1 },
    { maxRetryDelayMs: -1 },
    { initialRetryDelayMs: 2, maxRetryDelayMs: 1 },
    { onError: true },
    { onBatch: true },
    { monotonicNow: true },
  ];
  let createPoolCount = 0;
  for (const attachmentCleanup of invalidOptions) {
    assert.throws(
      () => createChatServer({
        database: {
          connectionString: "postgresql://chat.example/handrail",
          createPool() {
            createPoolCount += 1;
            return makeRuntimeDatabase().resource;
          },
        },
        ...requiredAdapters(),
        attachmentCleanup,
      }),
      (error) => error instanceof ChatServerConfigurationError,
    );
  }
  assert.equal(createPoolCount, 0);
});

test("enabled runtime starts one cleanup loop and supports its manual drain", async () => {
  const outcomes = [];
  const adapterCalls = [];
  let runtime;
  const database = makeRuntimeDatabase({
    cleanupBatches: [[cleanupRow("automatic")], [cleanupRow("manual")]],
    onEnd() {
      assert.equal(runtime.attachmentCleanupDispatcher.stopped, true);
      assert.deepEqual(adapterCalls.map(({ attachmentId }) => attachmentId), [
        "automatic",
        "manual",
      ]);
    },
  });
  runtime = createChatServer({
    database: {
      connectionString: "postgresql://chat.example/handrail",
      createPool: () => database.resource,
    },
    ...requiredAdapters(),
    storage: storageAdapter(async (input) => { adapterCalls.push(input); }),
    features: { attachments: true },
    outbox: { pollIntervalMs: 60_000 },
    postgresMaintenance: { pollIntervalMs: 60_000 },
    attachmentCleanup: {
      batchSize: 2,
      pollIntervalMs: 60_000,
      leaseDurationMs: 1_234,
      maxAttempts: 3,
      initialRetryDelayMs: 17,
      maxRetryDelayMs: 31,
      monotonicNow: sequenceClock(10, 15, 20, 29),
      onBatch(outcome) { outcomes.push(outcome); },
    },
  });

  assert.ok(runtime.attachmentCleanupDispatcher);
  assert.equal(runtime.attachmentCleanupDispatcher.running, true);
  assert.deepEqual(adapterCalls, []);
  assert.deepEqual(database.allQueries, []);
  runtime.attachmentCleanupDispatcher.start();
  runtime.attachmentCleanupDispatcher.start();

  await waitFor(() => adapterCalls.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(database.cleanupClaims.length, 1, "repeat start must not add a poll loop");
  assert.deepEqual(database.cleanupClaims[0].slice(0, 4), [2, database.cleanupClaims[0][1], 1_234, 3]);
  assert.deepEqual(await runtime.dispatchAttachmentCleanupOnce(), {
    claimed: 1,
    delivered: 1,
    failed: 0,
  });
  assert.equal(database.cleanupClaims.length, 2);
  assert.deepEqual(adapterCalls.map(({ attachmentId }) => attachmentId), [
    "automatic",
    "manual",
  ]);
  assert.deepEqual(outcomes.map(({ durationMs, outcome }) => ({ durationMs, outcome })), [
    { durationMs: 5, outcome: "succeeded" },
    { durationMs: 9, outcome: "succeeded" },
  ]);
  assert.equal(outcomes.every(Object.isFrozen), true);

  const firstClose = runtime.close();
  assert.equal(firstClose, runtime.close());
  await Promise.all([firstClose, runtime.close()]);
  assert.equal(database.endCount, 1);
});

test("disabled attachments allocate no cleanup worker and never query cleanup tables", async () => {
  let deleteCalls = 0;
  const database = makeRuntimeDatabase({
    cleanupBatches: [[cleanupRow("must-not-run")]],
  });
  const runtime = createChatServer({
    ...minimalConfig(database.resource),
    storage: storageAdapter(async () => { deleteCalls += 1; }),
    features: { attachments: false },
    attachmentCleanup: { pollIntervalMs: 0 },
  });

  assert.equal(runtime.attachmentCleanupDispatcher, undefined);
  assert.deepEqual(await runtime.dispatchAttachmentCleanupOnce(), {
    claimed: 0,
    delivered: 0,
    failed: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 0);
  assert.deepEqual(database.cleanupQueries, []);
  await runtime.close();
});

test("enabled attachments require a complete storage adapter before allocation", () => {
  const database = makeRuntimeDatabase();
  let createPoolCount = 0;
  const ownedDatabase = {
    connectionString: "postgresql://chat.example/handrail",
    createPool() {
      createPoolCount += 1;
      return database.resource;
    },
  };
  const cases = [
    [{}, /features\.attachments requires the storage adapter/u],
    [{ storage: {} }, /storage\.createUploadUrl must be a function/u],
    [{ storage: { createUploadUrl() {} } }, /storage\.verifyObject must be a function/u],
    [{
      storage: { createUploadUrl() {}, verifyObject() {} },
    }, /storage\.createDownloadUrl must be a function/u],
    [{
      storage: {
        createUploadUrl() {},
        verifyObject() {},
        createDownloadUrl() {},
      },
    }, /storage\.deleteObject must be a function/u],
  ];

  for (const [partial, expected] of cases) {
    assert.throws(
      () => createChatServer({
        database: ownedDatabase,
        ...requiredAdapters(),
        ...partial,
        features: { attachments: true },
      }),
      (error) =>
        error instanceof ChatServerConfigurationError &&
        expected.test(error.message),
    );
  }
  assert.equal(createPoolCount, 0);
});

test("close is idempotent and awaits an in-flight cleanup batch before pool end", async () => {
  let releaseDelete;
  let deleteStarted;
  let deleteFinished = false;
  const started = new Promise((resolve) => { deleteStarted = resolve; });
  const gate = new Promise((resolve) => { releaseDelete = resolve; });
  let runtime;
  const database = makeRuntimeDatabase({
    cleanupBatches: [[cleanupRow("closing")]],
    onEnd() {
      assert.equal(deleteFinished, true);
      assert.equal(runtime.attachmentCleanupDispatcher.stopped, true);
    },
  });
  runtime = createChatServer({
    database: {
      connectionString: "postgresql://chat.example/handrail",
      createPool: () => database.resource,
    },
    ...requiredAdapters(),
    storage: storageAdapter(async () => {
      deleteStarted();
      await gate;
      deleteFinished = true;
    }),
    features: { attachments: true },
    outbox: { pollIntervalMs: 60_000 },
    postgresMaintenance: { pollIntervalMs: 60_000 },
    attachmentCleanup: { batchSize: 2, pollIntervalMs: 60_000 },
  });

  await started;
  const firstClose = runtime.close();
  assert.equal(firstClose, runtime.close());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(database.endCount, 0);
  releaseDelete();
  await Promise.all([firstClose, runtime.close()]);
  assert.equal(database.endCount, 1);
});

test("server forwards bounded retry telemetry and sanitized worker errors", async () => {
  const settlements = [];
  const retryOutcomes = [];
  const retryDatabase = makeRuntimeDatabase({
    cleanupBatches: [[cleanupRow("retry", { attempt_count: "2" })]],
    onCleanupSettlement(_sql, values) { settlements.push(values); },
  });
  const retryRuntime = createChatServer({
    ...minimalConfig(retryDatabase.resource),
    storage: storageAdapter(async () => {
      throw new ChatAttachmentCleanupProviderError("retryable");
    }),
    features: { attachments: true },
    attachmentCleanup: {
      batchSize: 3,
      pollIntervalMs: 60_000,
      leaseDurationMs: 900,
      maxAttempts: 4,
      initialRetryDelayMs: 20,
      maxRetryDelayMs: 30,
      monotonicNow: sequenceClock(50, 57),
      onBatch(outcome) { retryOutcomes.push(outcome); },
    },
  });
  await waitFor(() => settlements.length === 1);
  assert.deepEqual(retryDatabase.cleanupClaims[0].slice(0, 4), [
    3,
    retryDatabase.cleanupClaims[0][1],
    900,
    4,
  ]);
  assert.equal(settlements[0][4], "storage.retryable");
  assert.equal(settlements[0][5], 30);
  assert.deepEqual(
    retryOutcomes.map(({ claimed, delivered, failed, retried, durationMs, outcome }) => ({
      claimed, delivered, failed, retried, durationMs, outcome,
    })),
    [{
      claimed: 1,
      delivered: 0,
      failed: 1,
      retried: 1,
      durationMs: 7,
      outcome: "failed",
    }],
  );
  await retryRuntime.close();

  const secret = "database-credential-and-storage-key-secret";
  const errors = [];
  const failedOutcomes = [];
  const failingDatabase = makeRuntimeDatabase({
    cleanupClaimError: new Error(secret),
  });
  const failingRuntime = createChatServer({
    ...minimalConfig(failingDatabase.resource),
    storage: storageAdapter(),
    features: { attachments: true },
    attachmentCleanup: {
      pollIntervalMs: 60_000,
      onError(error) { errors.push(error); },
      onBatch(outcome) { failedOutcomes.push(outcome); },
    },
  });
  await waitFor(() => errors.length === 1);
  assert.equal(errors[0] instanceof ChatAttachmentCleanupDispatcherError, true);
  assert.equal(errors[0].failureClass, "database");
  assert.equal(errors[0].message.includes(secret), false);
  assert.deepEqual(failedOutcomes.map(({ claimed, outcome }) => ({ claimed, outcome })), [
    { claimed: 0, outcome: "failed" },
  ]);
  assert.equal(JSON.stringify({ errors, failedOutcomes }).includes(secret), false);
  await failingRuntime.close();
});
