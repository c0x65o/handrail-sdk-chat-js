import assert from "node:assert/strict";
import test from "node:test";

import { createChatOutboxPublisher } from "@handrail/chat/server";

const waitFor = async (condition, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for publisher");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const event = (overrides = {}) => ({
  event_id: "secret-event-id",
  protocol_version: 4,
  tenant_id: "secret-tenant-id",
  stream_id: "secret-stream-id",
  type: "message.created",
  occurred_at: new Date(0),
  payload: { secret: "secret-payload" },
  publish_attempts: 1,
  ...overrides,
});

const fakeDatabase = ({ batches = [], onQuery } = {}) => {
  let claimIndex = 0;
  return {
    async query(sql, values) {
      onQuery?.(sql, values);
      if (sql.includes("WITH claim_clock")) {
        const batch = batches[claimIndex++] ?? [];
        if (batch instanceof Error) throw batch;
        return { rows: batch, rowCount: batch.length };
      }
      return { rows: [{ event_id: values?.[0] }], rowCount: 1 };
    },
  };
};

test("onBatch reports exact empty and successful batch timing and lag", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const outcomes = [];
  const database = fakeDatabase({
    batches: [[], [event({ occurred_at: new Date(500) })]],
    onQuery(sql) {
      if (sql.includes("WITH claim_clock")) now += 10;
      if (sql.includes("SET published_at")) now += 10;
    },
  });
  const publisher = createChatOutboxPublisher({
    database,
    createClaimToken: () => "claim-secret",
    realtime: {
      async publish() {
        now += 10;
      },
    },
    onBatch(outcome) {
      outcomes.push(outcome);
    },
  });

  assert.deepEqual(await publisher.runOnce(), {
    claimed: 0,
    published: 0,
    failed: 0,
  });
  assert.deepEqual(await publisher.runOnce(), {
    claimed: 1,
    published: 1,
    failed: 0,
  });
  assert.deepEqual(outcomes, [
    {
      claimed: 0,
      published: 0,
      failed: 0,
      durationMs: 10,
      oldestClaimedEventAgeMs: null,
      outcome: "empty",
      failureClass: "none",
    },
    {
      claimed: 1,
      published: 1,
      failed: 0,
      durationMs: 30,
      oldestClaimedEventAgeMs: 540,
      outcome: "succeeded",
      failureClass: "none",
    },
  ]);
  assert.equal(Object.isFrozen(outcomes[0]), true);
  assert.equal(Object.isFrozen(outcomes[1]), true);
  await publisher.stop();
});

test("onBatch reports aggregate-only partial delivery failures", async (t) => {
  let now = 2_000;
  t.mock.method(Date, "now", () => now);
  const outcomes = [];
  const providerSecret = "provider-secret-error-text";
  const database = fakeDatabase({
    batches: [[
      event({ event_id: "secret-first", occurred_at: new Date(1_000) }),
      event({ event_id: "secret-second", occurred_at: new Date(1_500) }),
    ]],
    onQuery(sql) {
      if (sql.includes("WITH claim_clock")) now += 5;
      if (sql.includes("SET published_at") || sql.includes("SET available_at")) {
        now += 5;
      }
    },
  });
  const publisher = createChatOutboxPublisher({
    database,
    createClaimToken: () => "secret-claim-token",
    realtime: {
      async publish(message) {
        now += 5;
        if (message.eventId === "secret-second") {
          throw new Error(providerSecret);
        }
      },
    },
    onBatch(outcome) {
      outcomes.push(outcome);
    },
  });

  assert.deepEqual(await publisher.runOnce(), {
    claimed: 2,
    published: 1,
    failed: 1,
  });
  assert.deepEqual(outcomes, [{
    claimed: 2,
    published: 1,
    failed: 1,
    durationMs: 25,
    oldestClaimedEventAgeMs: 1_025,
    outcome: "partially_failed",
    failureClass: "delivery",
  }]);
  assert.deepEqual(Object.keys(outcomes[0]).sort(), [
    "claimed",
    "durationMs",
    "failed",
    "failureClass",
    "oldestClaimedEventAgeMs",
    "outcome",
    "published",
  ]);
  const serialized = JSON.stringify(outcomes[0]);
  for (const secret of [
    "secret-first",
    "secret-second",
    "secret-tenant-id",
    "secret-stream-id",
    "secret-payload",
    "secret-claim-token",
    providerSecret,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  await publisher.stop();
});

test("database failures emit sanitized telemetry before polling error handling", async (t) => {
  let now = 3_000;
  t.mock.method(Date, "now", () => now);
  const databaseError = new Error("database-password-and-provider-details");
  const calls = [];
  const publisher = createChatOutboxPublisher({
    database: fakeDatabase({
      batches: [databaseError],
      onQuery(sql) {
        if (sql.includes("WITH claim_clock")) now += 7;
      },
    }),
    pollIntervalMs: 60_000,
    onBatch(outcome) {
      calls.push(["batch", outcome]);
    },
    onError(error) {
      calls.push(["error", error]);
    },
  });

  publisher.start();
  await waitFor(() => calls.length === 2);
  await publisher.stop();

  assert.deepEqual(calls, [
    ["batch", {
      claimed: 0,
      published: 0,
      failed: 0,
      durationMs: 7,
      oldestClaimedEventAgeMs: null,
      outcome: "failed",
      failureClass: "database",
    }],
    ["error", databaseError],
  ]);
  assert.equal(JSON.stringify(calls[0][1]).includes(databaseError.message), false);
});

test("direct database failures still reject runOnce after one telemetry event", async () => {
  const databaseError = new Error("private database failure");
  const outcomes = [];
  const publisher = createChatOutboxPublisher({
    database: fakeDatabase({ batches: [databaseError] }),
    onBatch(outcome) {
      outcomes.push(outcome);
    },
  });

  await assert.rejects(publisher.runOnce(), (error) => error === databaseError);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "failed");
  assert.equal(outcomes[0].failureClass, "database");
  await publisher.stop();
});

test("concurrent runOnce calls coalesce to one batch telemetry event", async () => {
  let releaseClaim;
  const claimGate = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  let claimCalls = 0;
  const outcomes = [];
  const publisher = createChatOutboxPublisher({
    database: {
      async query(sql) {
        if (sql.includes("WITH claim_clock")) {
          claimCalls += 1;
          await claimGate;
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
    onBatch(outcome) {
      outcomes.push(outcome);
    },
  });

  const first = publisher.runOnce();
  const second = publisher.runOnce();
  assert.equal(first, second);
  releaseClaim();
  await Promise.all([first, second]);
  assert.equal(claimCalls, 1);
  assert.equal(outcomes.length, 1);
  await publisher.stop();
});

test("throwing and rejecting telemetry callbacks do not alter retry or stop", async () => {
  const retryDelays = [];
  let telemetryCalls = 0;
  const publisher = createChatOutboxPublisher({
    database: fakeDatabase({
      batches: [[event()], []],
      onQuery(sql, values) {
        if (sql.includes("SET available_at")) retryDelays.push(values[2]);
      },
    }),
    initialRetryDelayMs: 17,
    maxRetryDelayMs: 17,
    realtime: {
      async publish() {
        throw new Error("secret adapter failure");
      },
    },
    onBatch() {
      telemetryCalls += 1;
      if (telemetryCalls === 1) throw new Error("sync telemetry failure");
      return Promise.reject(new Error("async telemetry failure"));
    },
  });

  assert.deepEqual(await publisher.runOnce(), {
    claimed: 1,
    published: 0,
    failed: 1,
  });
  assert.deepEqual(await publisher.runOnce(), {
    claimed: 0,
    published: 0,
    failed: 0,
  });
  await publisher.stop();
  assert.deepEqual(retryDelays, [17]);
  assert.equal(telemetryCalls, 2);
  assert.equal(publisher.stopped, true);
});
