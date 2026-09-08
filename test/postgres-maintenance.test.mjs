import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_POSTGRES_MAINTENANCE_POLL_INTERVAL_MS,
  createChatServer,
  createExpiredIdempotencyKeyMaintenanceJob,
  createExpiredOutboxEventMaintenanceJob,
  createPostgresMaintenance,
} from "@handrail/chat/server";

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("maintenance validates its poll interval", () => {
  for (const pollIntervalMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createPostgresMaintenance({ jobs: [], pollIntervalMs }),
      /pollIntervalMs must be a non-negative safe integer/u,
    );
  }
  assert.doesNotThrow(() =>
    createPostgresMaintenance({ jobs: [], pollIntervalMs: 0 }),
  );
  assert.throws(
    () => createPostgresMaintenance({ jobs: [], onBatch: "invalid" }),
    /onBatch must be a function/u,
  );
});

test("expired idempotency-key maintenance validates bounded inputs", () => {
  const database = { query: async () => ({ rows: [] }) };
  for (const batchSize of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createExpiredIdempotencyKeyMaintenanceJob({ database, batchSize }),
      /batchSize must be a positive safe integer/u,
    );
  }
  assert.throws(
    () =>
      createExpiredIdempotencyKeyMaintenanceJob({
        database,
        schema: "invalid-schema",
      }),
    /schema must be a PostgreSQL identifier/u,
  );
});

test("expired idempotency-key maintenance uses one bounded cleanup statement", async () => {
  const calls = [];
  const expiresAt = new Date("2020-01-01T00:00:00Z");
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            expires_at: expiresAt,
            tenant_id: "tenant-a",
            user_id: "user-a",
            operation_name: "message.send",
            client_key: "key-a",
          },
        ],
      };
    },
  };
  const result = await createExpiredIdempotencyKeyMaintenanceJob({
    database,
    schema: "tenant_chat",
    batchSize: 2,
  })();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [2]);
  assert.match(calls[0].sql, /FROM "tenant_chat"\.chat_idempotency_keys/u);
  assert.match(calls[0].sql, /expires_at <= clock_timestamp\(\)/u);
  assert.match(
    calls[0].sql,
    /ORDER BY expires_at, tenant_id, user_id, operation_name, client_key/u,
  );
  assert.match(calls[0].sql, /LIMIT \$1\s+FOR UPDATE SKIP LOCKED/u);
  assert.match(calls[0].sql, /DELETE FROM "tenant_chat"\.chat_idempotency_keys/u);
  assert.deepEqual(result, {
    deletedCount: 1,
    deleted: [
      {
        expiresAt,
        tenantId: "tenant-a",
        userId: "user-a",
        operationName: "message.send",
        clientKey: "key-a",
      },
    ],
  });
});

test("expired outbox maintenance validates bounded inputs", () => {
  const database = { connect: async () => { throw new Error("unused"); } };
  for (const batchSize of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createExpiredOutboxEventMaintenanceJob({ database, batchSize }),
      /expiredOutboxEvents\.batchSize must be a positive safe integer/u,
    );
  }
  assert.throws(
    () =>
      createExpiredOutboxEventMaintenanceJob({
        database,
        schema: "invalid-schema",
      }),
    /schema must be a PostgreSQL identifier/u,
  );
});

test("expired outbox maintenance locks, rechecks, and deletes one bounded transaction", async () => {
  const expiresAt = new Date("2020-01-01T00:00:00Z");
  const event = {
    expires_at: expiresAt,
    replay_position: "7",
    tenant_id: "tenant-a",
    event_id: "event-a",
  };
  const delivery = {
    tenant_id: "tenant-a",
    source_event_id: "event-a",
    recipient_host_user_id: "user-a",
    notification_kind: "message.created",
  };
  const calls = [];
  const releases = [];
  const connection = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: null };
      if (sql.includes("SELECT event.expires_at, event.replay_position")) {
        return { rows: [event], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE OF delivery SKIP LOCKED")) {
        return { rows: [delivery], rowCount: 1 };
      }
      if (sql.includes("AS active_lease")) {
        return { rows: [{ ...delivery, active_lease: false }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM \"tenant_chat\".chat_notification_deliveries")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("deleted_events AS")) {
        return { rows: [event], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release(error) {
      releases.push(error);
    },
  };

  const result = await createExpiredOutboxEventMaintenanceJob({
    database: { async connect() { return connection; } },
    schema: "tenant_chat",
    batchSize: 2,
  })();

  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
  const candidate = calls.find(({ sql }) => sql.includes("AS active_delivery"));
  assert.deepEqual(candidate.values, [2]);
  assert.match(candidate.sql, /expires_at <= clock_timestamp\(\)/u);
  assert.match(candidate.sql, /status = 'leased'/u);
  assert.match(candidate.sql, /lease_expires_at > clock_timestamp\(\)/u);
  assert.match(candidate.sql, /ORDER BY event\.expires_at, event\.replay_position/u);
  assert.match(candidate.sql, /LIMIT \$1\s+FOR UPDATE OF event SKIP LOCKED/u);
  const childDeleteIndex = calls.findIndex(({ sql }) =>
    sql.startsWith("DELETE FROM \"tenant_chat\".chat_notification_deliveries"),
  );
  const parentDeleteIndex = calls.findIndex(({ sql }) =>
    sql.includes("DELETE FROM \"tenant_chat\".chat_outbox_events AS event"),
  );
  assert.ok(childDeleteIndex > 0);
  assert.ok(parentDeleteIndex > childDeleteIndex);
  assert.deepEqual(releases, [undefined]);
  assert.deepEqual(result, {
    deletedCount: 1,
    deletedDeliveryCount: 1,
    deleted: [
      {
        expiresAt: "2020-01-01T00:00:00.000Z",
        replayPosition: 7,
        tenantId: "tenant-a",
        eventId: "event-a",
      },
    ],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.deleted), true);
  assert.equal(Object.isFrozen(result.deleted[0]), true);
});

test("expired outbox maintenance rolls back and releases its reserved connection", async () => {
  const failure = new Error("candidate selection failed");
  const calls = [];
  const releases = [];
  const connection = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      throw failure;
    },
    release(error) {
      releases.push(error);
    },
  };
  const job = createExpiredOutboxEventMaintenanceJob({
    database: { async connect() { return connection; } },
  });

  await assert.rejects(job(), (error) => error === failure);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[1], /chat_outbox_events AS event/u);
  assert.equal(calls[2], "ROLLBACK");
  assert.deepEqual(releases, [undefined]);
});

test("expired outbox maintenance defers active and concurrently locked deliveries", async () => {
  const candidates = [
    {
      expires_at: "2020-01-01T00:00:00Z",
      replay_position: "8",
      tenant_id: "tenant-a",
      event_id: "active-event",
    },
    {
      expires_at: "2020-01-01T00:00:00Z",
      replay_position: "9",
      tenant_id: "tenant-a",
      event_id: "raced-event",
    },
  ];
  const active = {
    tenant_id: "tenant-a",
    source_event_id: "active-event",
    recipient_host_user_id: "active-recipient",
    notification_kind: "message.created",
  };
  const raced = {
    tenant_id: "tenant-a",
    source_event_id: "raced-event",
    recipient_host_user_id: "raced-recipient",
    notification_kind: "message.created",
  };
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("AS active_delivery")) return { rows: candidates };
      if (sql.includes("FOR UPDATE OF delivery SKIP LOCKED")) {
        return { rows: [active] };
      }
      if (sql.includes("AS active_lease")) {
        return {
          rows: [
            { ...active, active_lease: true },
            { ...raced, active_lease: false },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const result = await createExpiredOutboxEventMaintenanceJob({
    database: { async connect() { return connection; } },
  })();

  assert.deepEqual(result, {
    deletedCount: 0,
    deletedDeliveryCount: 0,
    deleted: [],
  });
  assert.equal(calls.some((sql) => sql.startsWith("DELETE FROM")), false);
  assert.equal(calls.at(-1), "COMMIT");
});

test("expired outbox maintenance discards a connection when rollback fails", async () => {
  const rollbackFailure = new Error("rollback failed");
  const releases = [];
  const connection = {
    async query(sql) {
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") throw rollbackFailure;
      throw new Error("cleanup failed");
    },
    release(error) {
      releases.push(error);
    },
  };
  const job = createExpiredOutboxEventMaintenanceJob({
    database: { async connect() { return connection; } },
  });

  await assert.rejects(job(), AggregateError);
  assert.deepEqual(releases, [rollbackFailure]);
});

test("onBatch reports frozen empty and successful aggregate outcomes", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const emptyOutcomes = [];
  const emptyMaintenance = createPostgresMaintenance({
    jobs: [],
    onBatch(outcome) {
      emptyOutcomes.push(outcome);
    },
  });

  assert.deepEqual(await emptyMaintenance.runOnce(), { succeeded: 0, failed: 0 });
  assert.deepEqual(emptyOutcomes, [{
    configuredJobs: 0,
    succeeded: 0,
    failed: 0,
    durationMs: 0,
    status: "empty",
  }]);
  assert.equal(Object.isFrozen(emptyOutcomes[0]), true);

  const successOutcomes = [];
  const successMaintenance = createPostgresMaintenance({
    jobs: [
      () => { now += 4; },
      async () => { now += 6; },
    ],
    onBatch(outcome) {
      successOutcomes.push(outcome);
    },
  });

  assert.deepEqual(await successMaintenance.runOnce(), {
    succeeded: 2,
    failed: 0,
  });
  assert.deepEqual(successOutcomes, [{
    configuredJobs: 2,
    succeeded: 2,
    failed: 0,
    durationMs: 10,
    status: "success",
  }]);
  assert.equal(Object.isFrozen(successOutcomes[0]), true);
});

test("onBatch sanitizes partial and all-failure aggregate outcomes", async (t) => {
  let now = 2_000;
  t.mock.method(Date, "now", () => now);
  const secretSentinel = "secret-tenant-sql-credential-error";
  const partialOutcomes = [];
  const partialMaintenance = createPostgresMaintenance({
    jobs: [
      () => { now += 3; },
      () => {
        now += 5;
        throw new Error(secretSentinel);
      },
    ],
    onBatch(outcome) {
      partialOutcomes.push(outcome);
    },
  });

  assert.deepEqual(await partialMaintenance.runOnce(), {
    succeeded: 1,
    failed: 1,
  });
  assert.deepEqual(partialOutcomes, [{
    configuredJobs: 2,
    succeeded: 1,
    failed: 1,
    durationMs: 8,
    status: "partial_failure",
  }]);
  assert.deepEqual(Object.keys(partialOutcomes[0]).sort(), [
    "configuredJobs",
    "durationMs",
    "failed",
    "status",
    "succeeded",
  ]);
  assert.equal(JSON.stringify(partialOutcomes[0]).includes(secretSentinel), false);

  const failedOutcomes = [];
  const failedMaintenance = createPostgresMaintenance({
    jobs: [
      () => {
        now += 2;
        throw secretSentinel;
      },
      async () => {
        now += 4;
        throw new Error(secretSentinel);
      },
    ],
    onBatch(outcome) {
      failedOutcomes.push(outcome);
    },
  });

  assert.deepEqual(await failedMaintenance.runOnce(), {
    succeeded: 0,
    failed: 2,
  });
  assert.deepEqual(failedOutcomes, [{
    configuredJobs: 2,
    succeeded: 0,
    failed: 2,
    durationMs: 6,
    status: "failed",
  }]);
  assert.equal(JSON.stringify(failedOutcomes[0]).includes(secretSentinel), false);
});

test("concurrent runOnce calls share one sequential, failure-isolated batch", async (t) => {
  let now = 3_000;
  t.mock.method(Date, "now", () => now);
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order = [];
  const failures = [];
  const outcomes = [];
  let firstCalls = 0;
  const failedJob = async () => {
    order.push("second");
    throw new Error("second failed");
  };
  const maintenance = createPostgresMaintenance({
    jobs: [
      async () => {
        firstCalls += 1;
        order.push("first:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push("first:end");
      },
      failedJob,
      async () => {
        now += 7;
        order.push("third");
      },
    ],
    onError(error, job) {
      failures.push({ error, job });
    },
    onBatch(outcome) {
      outcomes.push(outcome);
    },
  });

  const firstRun = maintenance.runOnce();
  await firstStarted.promise;
  const concurrentRun = maintenance.runOnce();
  assert.equal(firstRun, concurrentRun);
  assert.equal(firstCalls, 1);

  releaseFirst.resolve();
  assert.deepEqual(await firstRun, { succeeded: 2, failed: 1 });
  assert.deepEqual(order, ["first:start", "first:end", "second", "third"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error.message, /second failed/u);
  assert.equal(failures[0].job, failedJob);
  assert.deepEqual(outcomes, [{
    configuredJobs: 3,
    succeeded: 2,
    failed: 1,
    durationMs: 7,
    status: "partial_failure",
  }]);
});

test("polling emits one outcome per batch and continues after a failed job", async (t) => {
  let now = 4_000;
  t.mock.method(Date, "now", () => now);
  const secondRun = deferred();
  const failures = [];
  const outcomes = [];
  const testDeadline = setTimeout(() => {}, 1_000);
  let calls = 0;
  const maintenance = createPostgresMaintenance({
    jobs: [async () => {
      calls += 1;
      now += 5;
      if (calls === 1) {
        throw new Error("transient maintenance failure");
      }
    }],
    pollIntervalMs: 0,
    onError(error) {
      failures.push(error);
    },
    onBatch(outcome) {
      outcomes.push(outcome);
      if (outcomes.length === 2) secondRun.resolve();
    },
  });

  try {
    maintenance.start();
    await secondRun.promise;
    await maintenance.stop();
  } finally {
    clearTimeout(testDeadline);
    await maintenance.stop();
  }

  assert.equal(calls, 2);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /transient maintenance failure/u);
  assert.deepEqual(outcomes, [
    {
      configuredJobs: 1,
      succeeded: 0,
      failed: 1,
      durationMs: 5,
      status: "failed",
    },
    {
      configuredJobs: 1,
      succeeded: 1,
      failed: 0,
      durationMs: 5,
      status: "success",
    },
  ]);
  assert.equal(maintenance.running, false);
  assert.equal(maintenance.stopped, true);
});

test("throwing and rejecting onBatch observers cannot alter maintenance", async (t) => {
  let now = 5_000;
  t.mock.method(Date, "now", () => now);
  let observerCalls = 0;
  const maintenance = createPostgresMaintenance({
    jobs: [() => { now += 3; }],
    onBatch() {
      observerCalls += 1;
      if (observerCalls === 1) throw new Error("sync observer failure");
      return Promise.reject(new Error("async observer failure"));
    },
  });

  assert.deepEqual(await maintenance.runOnce(), { succeeded: 1, failed: 0 });
  assert.deepEqual(await maintenance.runOnce(), { succeeded: 1, failed: 0 });
  await maintenance.stop();
  assert.equal(observerCalls, 2);
  assert.equal(maintenance.stopped, true);
});

test("stop wakes a pending poll and returns one stable promise", async () => {
  const firstRun = deferred();
  const maintenance = createPostgresMaintenance({
    jobs: [async () => {
      firstRun.resolve();
    }],
    pollIntervalMs: 60_000,
  });

  maintenance.start();
  await firstRun.promise;
  await nextTurn();

  const firstStop = maintenance.stop();
  assert.equal(firstStop, maintenance.stop());
  await firstStop;
  assert.equal(firstStop, maintenance.stop());
  assert.equal(maintenance.running, false);
  assert.equal(maintenance.stopped, true);
});

test("stop waits for current maintenance work", async () => {
  const started = deferred();
  const release = deferred();
  const maintenance = createPostgresMaintenance({
    jobs: [async () => {
      started.resolve();
      await release.promise;
    }],
    pollIntervalMs: 60_000,
  });

  maintenance.start();
  await started.promise;
  const stopping = maintenance.stop();
  let stopped = false;
  void stopping.then(() => {
    stopped = true;
  });
  await nextTurn();
  assert.equal(stopped, false);

  release.resolve();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(maintenance.running, false);
});

test("createChatServer owns and clears one unref'd maintenance poll timer", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const maintenanceTimers = new Set();

  globalThis.setTimeout = (callback, delay, ...args) => {
    let timer;
    timer = originalSetTimeout((...callbackArgs) => {
      maintenanceTimers.delete(timer);
      callback(...callbackArgs);
    }, delay, ...args);
    if (delay === DEFAULT_POSTGRES_MAINTENANCE_POLL_INTERVAL_MS) {
      maintenanceTimers.add(timer);
    }
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    maintenanceTimers.delete(timer);
    return originalClearTimeout(timer);
  };

  let runtime;
  try {
    let idempotencyCleanupQueries = 0;
    let reservedCleanupTransactions = 0;
    let reservedCleanupReleases = 0;
    const database = {
      async query(sql) {
        if (sql.includes("WITH expired_keys AS MATERIALIZED")) {
          idempotencyCleanupQueries += 1;
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("WITH claimable AS MATERIALIZED")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      async connect() {
        return {
          async query(sql) {
            if (sql === "BEGIN") {
              reservedCleanupTransactions += 1;
              return { rows: [], rowCount: null };
            }
            if (sql.includes("chat_outbox_events AS event")) {
              return { rows: [], rowCount: 0 };
            }
            if (sql.includes("chat_attachments AS attachment")) {
              return { rows: [], rowCount: 0 };
            }
            if (sql === "COMMIT") return { rows: [], rowCount: null };
            throw new Error(`unexpected reserved query: ${sql}`);
          },
          release() {
            reservedCleanupReleases += 1;
          },
        };
      },
    };
    runtime = createChatServer({
      database: { pool: database },
      auth: { async resolveActor() { throw new Error("unused"); } },
      directory: {
        async getUser() { throw new Error("unused"); },
        async searchUsers() { throw new Error("unused"); },
      },
      permissions: {
        async getCapabilities() { throw new Error("unused"); },
        async authorizeEntity() { throw new Error("unused"); },
      },
      outbox: { pollIntervalMs: 61_000 },
    });

    await nextTurn();
    assert.equal(runtime.postgresMaintenance.running, true);
    assert.equal(runtime.postgresMaintenance.stopped, false);
    assert.equal(idempotencyCleanupQueries, 1);
    assert.equal(reservedCleanupTransactions, 2);
    assert.equal(reservedCleanupReleases, 2);
    assert.equal(maintenanceTimers.size, 1);
    const [timer] = maintenanceTimers;
    assert.equal(timer.hasRef?.(), false);

    await runtime.close();
    assert.equal(runtime.postgresMaintenance.running, false);
    assert.equal(runtime.postgresMaintenance.stopped, true);
    assert.equal(maintenanceTimers.size, 0);
  } finally {
    await runtime?.close();
    for (const timer of maintenanceTimers) {
      originalClearTimeout(timer);
    }
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
