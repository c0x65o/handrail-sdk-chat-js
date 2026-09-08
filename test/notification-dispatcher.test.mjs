import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatNotificationDeliveryError,
  DEFAULT_CHAT_NOTIFICATION_BATCH_SIZE,
  DEFAULT_CHAT_NOTIFICATION_MAX_ATTEMPTS,
  createChatNotificationDeliveryId,
  createChatNotificationDispatcher,
  createChatServer,
  normalizeChatNotificationDispatcherOptions,
} from "@handrail/chat/server";

const waitFor = async (condition, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for dispatcher");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const delivery = (overrides = {}) => ({
  tenant_id: "secret-tenant-id",
  source_event_id: "secret-event-id",
  recipient_host_user_id: "secret-recipient-id",
  notification_kind: "message.created",
  notification_metadata: { secret: "secret-notification-metadata" },
  attempt_count: "1",
  occurred_at: "2030-01-01T00:00:00.000Z",
  conversation_id: "secret-conversation-id",
  message_id: "secret-message-id",
  actor_user_id: "secret-actor-id",
  sequence: "1",
  recipient_eligible: true,
  due_at: new Date(500),
  ...overrides,
});

const protectedTarget = {
  device_id: "secret-device-id",
  platform: "ios",
  provider: "apns",
  environment: "production",
  opaque_token: "secret-protected-token",
  token_protection_key_id: "secret-protection-key",
};

const fakeNotificationDatabase = ({ batches = [], onQuery, targets = [protectedTarget] } = {}) => {
  let claimIndex = 0;
  const database = {
    async query(sql, values) {
      await onQuery?.(sql, values);
      if (sql.includes("claimable AS MATERIALIZED")) {
        const batch = batches[claimIndex++] ?? [];
        if (batch instanceof Error) throw batch;
        return { rows: batch, rowCount: batch.length };
      }
      if (sql.includes("chat_device_push_tokens")) {
        const resolved = typeof targets === "function" ? targets(values) : targets;
        return { rows: resolved, rowCount: resolved.length };
      }
      if (sql.includes("SET status = 'delivered'")) {
        return { rows: [{ source_event_id: values?.[1] }], rowCount: 1 };
      }
      if (sql.includes("SET status = 'failed'")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("SELECT last_replay_position")) {
            return { rows: [{ last_replay_position: "0" }], rowCount: 1 };
          }
          if (sql.includes("SELECT event.replay_position")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("WITH due AS MATERIALIZED")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("chat_notification_materializer_offsets")) {
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected connection query: ${sql}`);
        },
        release() {},
      };
    },
  };
  return database;
};

const createFakeDispatcher = (options = {}) =>
  createChatNotificationDispatcher({
    database: fakeNotificationDatabase(),
    adapter: { async send() {} },
    pushTokenProtector: {
      async protect() { throw new Error("unused test protection path"); },
      async unprotect() { return "secret-raw-device-token"; },
    },
    createLeaseToken: () => "secret-lease-token",
    ...options,
  });

test("notification delivery ids are stable and recipient scoped", () => {
  const identity = {
    tenantId: "tenant-a",
    sourceEventId: "event-a",
    recipientUserId: "user-a",
    type: "message.created",
  };
  const first = createChatNotificationDeliveryId(identity);
  assert.equal(first, createChatNotificationDeliveryId({ ...identity }));
  assert.match(first, /^notification:[0-9a-f]{64}$/u);
  assert.notEqual(
    first,
    createChatNotificationDeliveryId({
      ...identity,
      recipientUserId: "user-b",
    }),
  );
  assert.notEqual(
    first,
    createChatNotificationDeliveryId({ ...identity, tenantId: "tenant-b" }),
  );
});

test("notification worker options normalize bounded retry and active suppression", () => {
  const defaults = normalizeChatNotificationDispatcherOptions();
  assert.equal(defaults.batchSize, DEFAULT_CHAT_NOTIFICATION_BATCH_SIZE);
  assert.equal(defaults.maxAttempts, DEFAULT_CHAT_NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(defaults.isRecipientActive, undefined);

  const isRecipientActive = () => true;
  assert.deepEqual(
    normalizeChatNotificationDispatcherOptions({
      batchSize: 3,
      pollIntervalMs: 0,
      leaseDurationMs: 50,
      maxAttempts: 2,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      isRecipientActive,
    }),
    {
      batchSize: 3,
      pollIntervalMs: 0,
      leaseDurationMs: 50,
      maxAttempts: 2,
      initialRetryDelayMs: 5,
      maxRetryDelayMs: 10,
      isRecipientActive,
      onError: undefined,
      onBatch: undefined,
    },
  );
  assert.throws(
    () => normalizeChatNotificationDispatcherOptions({ maxAttempts: 0 }),
    /maxAttempts must be a positive safe integer/u,
  );
  assert.throws(
    () => normalizeChatNotificationDispatcherOptions({
      initialRetryDelayMs: 20,
      maxRetryDelayMs: 10,
    }),
    /maxRetryDelayMs must be greater than or equal/u,
  );
  assert.throws(
    () => normalizeChatNotificationDispatcherOptions({ onBatch: "invalid" }),
    /onBatch must be a function/u,
  );
});

test("onBatch reports exact empty, delivered, and suppressed timing and lag", async () => {
  let now = 1_000;
  const outcomes = [];
  const database = fakeNotificationDatabase({
    batches: [
      [],
      [delivery()],
      [delivery({
        recipient_host_user_id: "suppressed-recipient",
        due_at: new Date(2_000),
      })],
    ],
    targets: (values) => values?.[1] === "suppressed-recipient" ? [] : [protectedTarget],
    onQuery(sql) {
      if (sql.includes("claimable AS MATERIALIZED")) now += 10;
      if (sql.includes("SET status = 'delivered'")) now += 10;
    },
  });
  const dispatcher = createFakeDispatcher({
    database,
    now: () => new Date(now),
    adapter: { async send() { now += 10; } },
    onBatch(outcome) { outcomes.push(outcome); },
  });

  assert.deepEqual(await dispatcher.runOnce(), {
    materialized: 0,
    claimed: 0,
    delivered: 0,
    suppressed: 0,
    failed: 0,
  });
  assert.deepEqual(await dispatcher.runOnce(), {
    materialized: 0,
    claimed: 1,
    delivered: 1,
    suppressed: 0,
    failed: 0,
  });
  assert.deepEqual(await dispatcher.runOnce(), {
    materialized: 0,
    claimed: 1,
    delivered: 0,
    suppressed: 1,
    failed: 0,
  });

  const noFailures = {
    none: 1,
    transient: 0,
    rate_limited: 0,
    permanent: 0,
    rejected: 0,
    configuration: 0,
    unknown: 0,
    database: 0,
  };
  assert.deepEqual(outcomes, [
    {
      materialized: 0,
      claimed: 0,
      delivered: 0,
      suppressed: 0,
      failed: 0,
      durationMs: 10,
      oldestDueDeliveryAgeMs: null,
      outcome: "empty",
      failureClassCounts: { ...noFailures, none: 0 },
    },
    {
      materialized: 0,
      claimed: 1,
      delivered: 1,
      suppressed: 0,
      failed: 0,
      durationMs: 30,
      oldestDueDeliveryAgeMs: 540,
      outcome: "succeeded",
      failureClassCounts: noFailures,
    },
    {
      materialized: 0,
      claimed: 1,
      delivered: 0,
      suppressed: 1,
      failed: 0,
      durationMs: 20,
      oldestDueDeliveryAgeMs: 0,
      outcome: "succeeded",
      failureClassCounts: noFailures,
    },
  ]);
  assert.equal(outcomes.every(Object.isFrozen), true);
  assert.equal(outcomes.every(({ failureClassCounts }) =>
    Object.isFrozen(failureClassCounts)), true);
  await dispatcher.stop();
});

test("onBatch aggregates retryable and terminal failures without sensitive fields", async () => {
  let now = 3_000;
  const outcomes = [];
  const adapterErrorText = "secret-adapter-error-text";
  const rows = [
    delivery({ recipient_host_user_id: "delivered-recipient", due_at: new Date(1_000) }),
    delivery({ recipient_host_user_id: "retryable-recipient", due_at: "invalid-due-secret" }),
    delivery({ recipient_host_user_id: "terminal-recipient", due_at: new Date(1_500) }),
  ];
  const dispatcher = createFakeDispatcher({
    database: fakeNotificationDatabase({
      batches: [rows],
      onQuery(sql) {
        if (sql.includes("claimable AS MATERIALIZED")) now += 5;
        if (sql.includes("SET status = 'delivered'") ||
            sql.includes("SET status = 'failed'")) now += 5;
      },
    }),
    now: () => new Date(now),
    adapter: {
      async send(input) {
        now += 5;
        if (input.recipientUserId === "retryable-recipient") {
          throw new ChatNotificationDeliveryError("transient", adapterErrorText);
        }
        if (input.recipientUserId === "terminal-recipient") {
          throw new ChatNotificationDeliveryError("rejected", adapterErrorText);
        }
      },
    },
    onBatch(outcome) { outcomes.push(outcome); },
  });

  assert.deepEqual(await dispatcher.runOnce(), {
    materialized: 0,
    claimed: 3,
    delivered: 1,
    suppressed: 0,
    failed: 2,
  });
  assert.deepEqual(outcomes, [{
    materialized: 0,
    claimed: 3,
    delivered: 1,
    suppressed: 0,
    failed: 2,
    durationMs: 35,
    oldestDueDeliveryAgeMs: 2_035,
    outcome: "partially_failed",
    failureClassCounts: {
      none: 1,
      transient: 1,
      rate_limited: 0,
      permanent: 0,
      rejected: 1,
      configuration: 0,
      unknown: 0,
      database: 0,
    },
  }]);
  assert.deepEqual(Object.keys(outcomes[0]).sort(), [
    "claimed",
    "delivered",
    "durationMs",
    "failed",
    "failureClassCounts",
    "materialized",
    "oldestDueDeliveryAgeMs",
    "outcome",
    "suppressed",
  ]);
  assert.deepEqual(Object.keys(outcomes[0].failureClassCounts).sort(), [
    "configuration",
    "database",
    "none",
    "permanent",
    "rate_limited",
    "rejected",
    "transient",
    "unknown",
  ]);
  const serialized = JSON.stringify(outcomes[0]);
  for (const sentinel of [
    "secret-tenant-id",
    "secret-event-id",
    "secret-recipient-id",
    "delivered-recipient",
    "retryable-recipient",
    "terminal-recipient",
    "secret-device-id",
    "secret-protected-token",
    "secret-raw-device-token",
    "secret-protection-key",
    "secret-conversation-id",
    "secret-message-id",
    "secret-actor-id",
    "secret-notification-metadata",
    "secret-lease-token",
    "invalid-due-secret",
    adapterErrorText,
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
  await dispatcher.stop();
});

test("database failures emit once, reject directly, and retain polling onError", async () => {
  let now = 4_000;
  const databaseError = new Error("secret-database-error-text");
  const directOutcomes = [];
  const direct = createFakeDispatcher({
    database: fakeNotificationDatabase({
      batches: [databaseError],
      onQuery(sql) {
        if (sql.includes("claimable AS MATERIALIZED")) now += 7;
      },
    }),
    now: () => new Date(now),
    onBatch(outcome) { directOutcomes.push(outcome); },
  });

  await assert.rejects(direct.runOnce(), (error) => error === databaseError);
  assert.deepEqual(directOutcomes, [{
    materialized: 0,
    claimed: 0,
    delivered: 0,
    suppressed: 0,
    failed: 0,
    durationMs: 7,
    oldestDueDeliveryAgeMs: null,
    outcome: "failed",
    failureClassCounts: {
      none: 0,
      transient: 0,
      rate_limited: 0,
      permanent: 0,
      rejected: 0,
      configuration: 0,
      unknown: 0,
      database: 1,
    },
  }]);
  assert.equal(JSON.stringify(directOutcomes[0]).includes(databaseError.message), false);

  const calls = [];
  const pollingError = new Error("another-secret-database-error");
  const polling = createFakeDispatcher({
    database: fakeNotificationDatabase({ batches: [pollingError] }),
    pollIntervalMs: 60_000,
    onBatch(outcome) { calls.push(["batch", outcome.outcome]); },
    onError(error) { calls.push(["error", error]); },
  });
  polling.start();
  await waitFor(() => calls.length === 2);
  await polling.stop();
  assert.deepEqual(calls, [["batch", "failed"], ["error", pollingError]]);
  await direct.stop();
});

test("coalescing and throwing telemetry observers do not alter settlement or stop", async () => {
  let releaseClaim;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  let claimCalls = 0;
  let telemetryCalls = 0;
  const retryDelays = [];
  const dispatcher = createFakeDispatcher({
    database: fakeNotificationDatabase({
      batches: [[delivery()], []],
      async onQuery(sql, values) {
        if (sql.includes("claimable AS MATERIALIZED")) {
          claimCalls += 1;
          if (claimCalls === 1) await claimGate;
        }
        if (sql.includes("SET status = 'failed'")) retryDelays.push(values[5]);
      },
    }),
    initialRetryDelayMs: 17,
    maxRetryDelayMs: 17,
    adapter: {
      async send() {
        throw new ChatNotificationDeliveryError("transient", "secret retry text");
      },
    },
    onBatch(outcome) {
      telemetryCalls += 1;
      assert.throws(() => { outcome.failed = 99; }, TypeError);
      assert.throws(() => { outcome.failureClassCounts.transient = 99; }, TypeError);
      if (telemetryCalls === 1) throw new Error("sync observer failure");
      return Promise.reject(new Error("async observer failure"));
    },
  });

  const first = dispatcher.runOnce();
  const second = dispatcher.runOnce();
  assert.equal(first, second);
  releaseClaim();
  assert.deepEqual(await first, {
    materialized: 0,
    claimed: 1,
    delivered: 0,
    suppressed: 0,
    failed: 1,
  });
  assert.deepEqual(await dispatcher.runOnce(), {
    materialized: 0,
    claimed: 0,
    delivered: 0,
    suppressed: 0,
    failed: 0,
  });
  await dispatcher.stop();
  assert.equal(claimCalls, 2);
  assert.equal(telemetryCalls, 2);
  assert.deepEqual(retryDelays, [17]);
  assert.equal(dispatcher.stopped, true);
});

test("server close drains an in-flight notification batch and remains idempotent", async () => {
  let materialized = false;
  let claimed = false;
  const notificationBatches = [];
  let releaseSend;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const database = {
    async query(sql) {
      if (sql.includes("INSERT INTO") && sql.includes("chat_notification_deliveries")) {
        materialized = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("chat_notification_deliveries") && sql.includes("claimable AS MATERIALIZED")) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return {
          rowCount: 1,
          rows: [{
            tenant_id: "tenant-a",
            source_event_id: "event-a",
            recipient_host_user_id: "recipient-a",
            notification_kind: "message.created",
            notification_metadata: { protocolVersion: 4 },
            attempt_count: "1",
            occurred_at: "2030-01-01T00:00:00.000Z",
            conversation_id: "conversation-a",
            message_id: "message-a",
            actor_user_id: "actor-a",
            sequence: "1",
            recipient_eligible: true,
            due_at: new Date(0),
          }],
        };
      }
      if (sql.includes("chat_device_push_tokens")) {
        return { rows: [protectedTarget], rowCount: 1 };
      }
      if (sql.includes("SET status = 'delivered'")) {
        return { rows: [{ source_event_id: "event-a" }], rowCount: 1 };
      }
      if (sql.includes("chat_outbox_events") && sql.includes("claimable AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SET lease_expires_at")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql) {
          if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("chat_notification_materializer_offsets")) {
            if (sql.includes("SELECT last_replay_position")) {
              return { rows: [{ last_replay_position: "0" }], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SELECT event.replay_position")) {
            return { rows: [{ replay_position: "1" }], rowCount: 1 };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_notification_deliveries")
          ) {
            materialized = true;
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected connection query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const runtime = createChatServer({
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
    notifications: {
      async send() {
        markStarted();
        await sendGate;
      },
    },
    pushTokenProtector: {
      async protect() { throw new Error("unused test protection path"); },
      async unprotect() { return "runtime-device-token"; },
    },
    features: { notifications: true },
    outbox: { pollIntervalMs: 60_000 },
    notificationDelivery: {
      pollIntervalMs: 60_000,
      leaseDurationMs: 1_000,
      onBatch(outcome) { notificationBatches.push(outcome); },
    },
  });

  await started;
  assert.equal(materialized, true);
  const firstClose = runtime.close();
  assert.equal(firstClose, runtime.close());
  assert.equal(await Promise.race([
    firstClose.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 10)),
  ]), "waiting");
  releaseSend();
  await firstClose;
  assert.equal(runtime.closed, true);
  assert.equal(runtime.notificationDispatcher?.stopped, true);
  assert.equal(notificationBatches.length, 1);
  assert.equal(notificationBatches[0].delivered, 1);
});
