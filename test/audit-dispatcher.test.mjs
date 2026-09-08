import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatAuditDeliveryError,
  ChatAuditDispatcherError,
  DEFAULT_CHAT_AUDIT_BATCH_SIZE,
  createChatAuditDispatcher,
  normalizeChatAuditDispatcherOptions,
} from "@handrail/chat/server";

const row = (overrides = {}) => ({
  tenant_id: "tenant-a",
  audit_event_id: "audit-a",
  actor_user_id: "actor-a",
  action: "message.created",
  target_type: "message",
  target_id: "message-a",
  occurred_at: "2030-01-01T00:00:00.000Z",
  metadata: { revision: 1 },
  request_id: "request-a",
  correlation_id: "correlation-a",
  attempt_count: "1",
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
          if (sql.includes("INSERT INTO") && sql.includes("chat_audit_deliveries")) {
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
      await onQuery?.(sql, values);
      if (sql.includes("SET delivered_at")) {
        return { rows: [{ audit_event_id: values[1] }], rowCount: 1 };
      }
      if (sql.includes("SET next_attempt_at")) {
        return { rows: [{ audit_event_id: values[1] }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
};

const dispatcher = (options = {}) =>
  createChatAuditDispatcher({
    database: fakeDatabase(),
    adapter: { async record() {} },
    createLeaseOwner: () => "lease-a",
    ...options,
  });

const sequenceClock = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

const waitFor = async (condition) => {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
};

test("audit dispatcher normalizes bounded polling and retry options", async () => {
  const defaults = normalizeChatAuditDispatcherOptions();
  assert.equal(defaults.batchSize, DEFAULT_CHAT_AUDIT_BATCH_SIZE);
  assert.throws(
    () => normalizeChatAuditDispatcherOptions({ batchSize: 0 }),
    /batchSize must be a positive safe integer/u,
  );
  assert.throws(
    () => normalizeChatAuditDispatcherOptions({
      initialRetryDelayMs: 20,
      maxRetryDelayMs: 10,
    }),
    /maxRetryDelayMs must be greater than or equal/u,
  );
  assert.throws(
    () => normalizeChatAuditDispatcherOptions({ onBatch: "invalid" }),
    /onBatch must be a function/u,
  );
  assert.throws(
    () => normalizeChatAuditDispatcherOptions({ monotonicNow: "invalid" }),
    /monotonicNow must be a function/u,
  );
  await assert.rejects(
    dispatcher({ createLeaseOwner: () => "secret lease" }).runOnce(),
    (error) => error instanceof ChatAuditDispatcherError &&
      error.failureClass === "configuration",
  );
});

test("claims in one committed transaction and delivers one immutable bounded event", async () => {
  const order = [];
  const calls = [];
  const database = fakeDatabase({
    batches: [[row()]],
    onConnectionQuery(sql, values) {
      if (sql === "BEGIN") order.push("begin");
      if (sql.includes("INSERT INTO")) order.push("materialize");
      if (sql.includes("claimable AS MATERIALIZED")) {
        order.push("claim");
        assert.deepEqual(values.slice(0, 3), [25, "lease-a", 30_000]);
        assert.match(sql, /FOR UPDATE OF candidate SKIP LOCKED/u);
        assert.match(sql, /event\.tenant_id = claimable\.tenant_id/u);
      }
      if (sql === "COMMIT") order.push("commit");
    },
    onQuery(sql, values) {
      order.push("settle");
      assert.match(sql, /delivery\.lease_owner = \$3/u);
      assert.deepEqual(values.slice(0, 3), ["tenant-a", "audit-a", "lease-a"]);
    },
  });
  const worker = dispatcher({
    database,
    adapter: {
      async record(event) {
        order.push("record");
        calls.push(event);
      },
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    materialized: 0,
    claimed: 1,
    delivered: 1,
    failed: 0,
  });
  assert.deepEqual(order, ["begin", "materialize", "claim", "commit", "record", "settle"]);
  assert.deepEqual(calls, [{
    auditEventId: "audit-a",
    tenantId: "tenant-a",
    actorUserId: "actor-a",
    action: "message.created",
    occurredAt: "2030-01-01T00:00:00.000Z",
    metadata: { revision: 1 },
    requestId: "request-a",
    correlationId: "correlation-a",
    target: { type: "message", id: "message-a" },
  }]);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[0].metadata), true);
  assert.equal(Object.isFrozen(calls[0].target), true);
  await worker.close();
});

test("emits one frozen, closed, aggregate outcome for every batch result", async () => {
  const outcomes = [];
  const secret = "secret-provider-and-database-detail";
  const wallNow = () => new Date("2030-01-01T00:00:01.000Z");
  const capture = (outcome) => { outcomes.push(outcome); };

  const idle = dispatcher({
    database: fakeDatabase({ batches: [[]] }),
    now: wallNow,
    monotonicNow: sequenceClock(10, 14),
    onBatch: capture,
  });
  assert.equal((await idle.runOnce()).claimed, 0);
  await idle.close();

  const succeeded = dispatcher({
    database: fakeDatabase({
      batches: [[row({
        tenant_id: "private-tenant",
        audit_event_id: "private-audit-id",
        actor_user_id: "private-user",
        target_id: "private-target",
        metadata: { confidentialRevision: 7 },
        request_id: "private-request",
        correlation_id: "private-correlation",
      })]],
    }),
    now: wallNow,
    monotonicNow: sequenceClock(20, 30),
    onBatch: capture,
  });
  assert.equal((await succeeded.runOnce()).delivered, 1);
  await succeeded.close();

  const partiallyFailed = dispatcher({
    database: fakeDatabase({
      batches: [[
        row({ audit_event_id: "delivered", occurred_at: "2030-01-01T00:00:00.500Z" }),
        row({ audit_event_id: "retry", occurred_at: "2030-01-01T00:00:02.000Z" }),
      ]],
    }),
    adapter: {
      async record(event) {
        if (event.auditEventId === "retry") {
          throw new ChatAuditDeliveryError("transient", secret);
        }
      },
    },
    now: wallNow,
    monotonicNow: sequenceClock(40, 35),
    onBatch: capture,
  });
  assert.deepEqual(await partiallyFailed.runOnce(), {
    materialized: 0,
    claimed: 2,
    delivered: 1,
    failed: 1,
  });
  await partiallyFailed.close();

  const terminal = dispatcher({
    database: fakeDatabase({ batches: [[row({ audit_event_id: "terminal" })]] }),
    adapter: {
      async record() {
        throw new ChatAuditDeliveryError("configuration", secret);
      },
    },
    now: wallNow,
    monotonicNow: sequenceClock(50, Number.POSITIVE_INFINITY),
    onBatch: capture,
  });
  assert.equal((await terminal.runOnce()).failed, 1);
  await terminal.close();

  const databaseFailure = dispatcher({
    database: fakeDatabase({ batches: [new Error(secret)] }),
    now: wallNow,
    monotonicNow: sequenceClock(60, 67),
    onBatch: capture,
  });
  await assert.rejects(
    databaseFailure.runOnce(),
    (error) => error instanceof ChatAuditDispatcherError &&
      error.failureClass === "database",
  );
  await databaseFailure.close();

  const configurationFailure = dispatcher({
    createLeaseOwner() { throw new Error(secret); },
    now: wallNow,
    monotonicNow: sequenceClock(70, 75),
    onBatch: capture,
  });
  await assert.rejects(
    configurationFailure.runOnce(),
    (error) => error instanceof ChatAuditDispatcherError &&
      error.failureClass === "configuration",
  );
  await configurationFailure.close();

  assert.deepEqual(outcomes, [
    {
      claimed: 0,
      delivered: 0,
      retried: 0,
      terminal: 0,
      durationMs: 4,
      oldestEligibleEventLagMs: null,
      outcome: "empty",
    },
    {
      claimed: 1,
      delivered: 1,
      retried: 0,
      terminal: 0,
      durationMs: 10,
      oldestEligibleEventLagMs: 1_000,
      outcome: "succeeded",
    },
    {
      claimed: 2,
      delivered: 1,
      retried: 1,
      terminal: 0,
      durationMs: 0,
      oldestEligibleEventLagMs: 500,
      outcome: "partially_failed",
    },
    {
      claimed: 1,
      delivered: 0,
      retried: 0,
      terminal: 1,
      durationMs: 0,
      oldestEligibleEventLagMs: 1_000,
      outcome: "failed",
    },
    {
      claimed: 0,
      delivered: 0,
      retried: 0,
      terminal: 0,
      durationMs: 7,
      oldestEligibleEventLagMs: null,
      outcome: "failed",
    },
    {
      claimed: 0,
      delivered: 0,
      retried: 0,
      terminal: 0,
      durationMs: 5,
      oldestEligibleEventLagMs: null,
      outcome: "failed",
    },
  ]);
  const expectedKeys = [
    "claimed",
    "delivered",
    "durationMs",
    "oldestEligibleEventLagMs",
    "outcome",
    "retried",
    "terminal",
  ];
  for (const outcome of outcomes) {
    assert.equal(Object.isFrozen(outcome), true);
    assert.deepEqual(Object.keys(outcome).sort(), expectedKeys);
    assert.equal(Number.isFinite(outcome.durationMs), true);
    assert.equal(outcome.durationMs >= 0, true);
    assert.equal(outcome.durationMs <= Number.MAX_SAFE_INTEGER, true);
    assert.equal(
      outcome.oldestEligibleEventLagMs === null ||
        (Number.isFinite(outcome.oldestEligibleEventLagMs) &&
          outcome.oldestEligibleEventLagMs >= 0 &&
          outcome.oldestEligibleEventLagMs <= Number.MAX_SAFE_INTEGER),
      true,
    );
  }
  const serialized = JSON.stringify(outcomes);
  for (const forbidden of [
    "private-tenant",
    "private-audit-id",
    "private-user",
    "message.created",
    "private-target",
    "confidentialRevision",
    "private-request",
    "private-correlation",
    "lease-a",
    secret,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("synchronous and asynchronous batch observers cannot alter manual batches", async () => {
  let observerCalls = 0;
  const worker = dispatcher({
    database: fakeDatabase({ batches: [[row()], [row({ audit_event_id: "second" })]] }),
    onBatch() {
      observerCalls += 1;
      if (observerCalls === 1) throw new Error("synchronous observer secret");
      return Promise.reject(new Error("asynchronous observer secret"));
    },
  });

  assert.equal((await worker.runOnce()).delivered, 1);
  assert.equal((await worker.runOnce()).delivered, 1);
  await Promise.resolve();
  assert.equal(observerCalls, 2);
  await worker.close();
});

test("synchronous and asynchronous batch observers cannot alter automatic polling", async () => {
  for (const observerKind of ["synchronous", "asynchronous"]) {
    let observerCalls = 0;
    let delivered = 0;
    const worker = dispatcher({
      database: fakeDatabase({ batches: [[row({ audit_event_id: observerKind })]] }),
      batchSize: 2,
      pollIntervalMs: 60_000,
      adapter: { async record() { delivered += 1; } },
      onBatch() {
        observerCalls += 1;
        const error = new Error(`${observerKind} observer secret`);
        if (observerKind === "synchronous") throw error;
        return Promise.reject(error);
      },
    });

    worker.start();
    await waitFor(() => observerCalls === 1);
    await worker.close();
    await Promise.resolve();
    assert.equal(delivered, 1);
    assert.equal(observerCalls, 1);
    assert.equal(worker.stopped, true);
  }
});

test("classifies retryable, terminal, and unknown failures without persisting messages", async () => {
  const secret = "provider-secret-diagnostic";
  const failureSettlements = [];
  const rows = [
    row({ audit_event_id: "transient", attempt_count: "1" }),
    row({ audit_event_id: "rate", attempt_count: "3" }),
    row({ audit_event_id: "invalid", attempt_count: "1" }),
    row({ audit_event_id: "config", attempt_count: "1" }),
    row({ audit_event_id: "unknown", attempt_count: "1" }),
  ];
  const worker = dispatcher({
    database: fakeDatabase({
      batches: [rows],
      onQuery(sql, values) {
        if (sql.includes("SET next_attempt_at")) {
          failureSettlements.push({ sql, values });
        }
      },
    }),
    initialRetryDelayMs: 100,
    maxRetryDelayMs: 250,
    adapter: {
      async record(event) {
        if (event.auditEventId === "transient") {
          throw new ChatAuditDeliveryError("transient", secret);
        }
        if (event.auditEventId === "rate") {
          throw new ChatAuditDeliveryError("rate_limited", secret);
        }
        if (event.auditEventId === "invalid") {
          throw new ChatAuditDeliveryError("invalid", secret);
        }
        if (event.auditEventId === "config") {
          throw new ChatAuditDeliveryError("configuration", secret);
        }
        throw new Error(secret);
      },
    },
  });

  assert.equal((await worker.runOnce()).failed, 5);
  assert.deepEqual(
    failureSettlements.map(({ values }) => ({
      failureClass: values[3],
      terminal: values[4],
      delay: values[5],
    })),
    [
      { failureClass: "transient", terminal: false, delay: 100 },
      { failureClass: "rate_limited", terminal: false, delay: 250 },
      { failureClass: "rejected", terminal: true, delay: 0 },
      { failureClass: "configuration", terminal: true, delay: 0 },
      { failureClass: "unknown", terminal: false, delay: 100 },
    ],
  );
  assert.equal(JSON.stringify(failureSettlements).includes(secret), false);
  await worker.close();
});

test("quarantines malformed rows without poisoning valid claims", async () => {
  const calls = [];
  const settlements = [];
  const worker = dispatcher({
    database: fakeDatabase({
      batches: [[
        row({ audit_event_id: "malformed", metadata: { secret: "must-not-escape" } }),
        row({ audit_event_id: "valid", correlation_id: null, target_type: null, target_id: null }),
      ]],
      onQuery(_sql, values) {
        settlements.push(values);
      },
    }),
    adapter: { async record(event) { calls.push(event); } },
  });

  assert.deepEqual(await worker.runOnce(), {
    materialized: 0,
    claimed: 2,
    delivered: 1,
    failed: 1,
  });
  assert.deepEqual(calls.map(({ auditEventId }) => auditEventId), ["valid"]);
  assert.equal(settlements[0][3], "rejected");
  assert.equal(JSON.stringify(settlements).includes("must-not-escape"), false);
  await worker.close();
});

test("replays stable identity after acknowledgment loss and emits only safe errors", async () => {
  const adapterCalls = [];
  const callbackErrors = [];
  let failAcknowledgment = true;
  const database = fakeDatabase({
    batches: [[row()], [row({ attempt_count: "2" })]],
    onQuery(sql) {
      if (sql.includes("SET delivered_at") && failAcknowledgment) {
        failAcknowledgment = false;
        throw new Error("secret-database-detail");
      }
    },
  });
  const worker = dispatcher({
    database,
    adapter: { async record(event) { adapterCalls.push(event); } },
    onError(error) { callbackErrors.push(error); },
  });

  await assert.rejects(
    worker.runOnce(),
    (error) => error instanceof ChatAuditDispatcherError &&
      error.failureClass === "database" &&
      !error.message.includes("secret"),
  );
  assert.equal((await worker.runOnce()).delivered, 1);
  assert.deepEqual(adapterCalls.map(({ auditEventId }) => auditEventId), ["audit-a", "audit-a"]);

  const polling = dispatcher({
    database: fakeDatabase({ batches: [new Error("secret-query-detail")] }),
    pollIntervalMs: 60_000,
    onError(error) { callbackErrors.push(error); },
  });
  polling.start();
  while (callbackErrors.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await polling.close();
  assert.equal(callbackErrors[0] instanceof ChatAuditDispatcherError, true);
  assert.equal(JSON.stringify(callbackErrors).includes("secret"), false);
  await worker.close();
});

test("close is idempotent and waits for this dispatcher's in-flight adapter call", async () => {
  let releaseRecord;
  let recordStarted;
  const recordGate = new Promise((resolve) => { releaseRecord = resolve; });
  const started = new Promise((resolve) => { recordStarted = resolve; });
  const worker = dispatcher({
    database: fakeDatabase({ batches: [[row()]] }),
    adapter: {
      async record() {
        recordStarted();
        await recordGate;
      },
    },
  });

  worker.start();
  await started;
  const first = worker.close();
  const second = worker.close();
  assert.equal(first, second);
  let closed = false;
  void first.then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, false);
  releaseRecord();
  await first;
  assert.equal(worker.running, false);
  assert.equal(worker.stopped, true);
  assert.deepEqual(await worker.runOnce(), {
    materialized: 0,
    claimed: 0,
    delivered: 0,
    failed: 0,
  });
});
