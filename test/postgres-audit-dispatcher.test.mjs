import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatAuditDeliveryError,
  ChatAuditDispatcherError,
  createChatAuditDispatcher,
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

test("audit dispatcher durably materializes, leases, retries, and quarantines PostgreSQL rows", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "audit_dispatcher" });
  const prefix = quoteIdentifier(harness.schema);
  const events = `${prefix}.chat_audit_events`;
  const deliveries = `${prefix}.chat_audit_deliveries`;
  const workers = new Set();
  let leaseOrdinal = 0;

  const seed = async ({
    tenantId = "tenant-a",
    eventId,
    actorUserId = "actor-a",
    action = "audit.tested",
    targetType = null,
    targetId = null,
    metadata = { revision: 1 },
    requestId = `request-${eventId}`,
    correlationId = null,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${events} (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), $7, $8, $9)`,
      [
        tenantId,
        eventId,
        actorUserId,
        action,
        targetType,
        targetId,
        metadata,
        requestId,
        correlationId,
      ],
    );
  };

  const worker = (adapter, options = {}) => {
    const dispatcher = createChatAuditDispatcher({
      database: harness.pool,
      schema: harness.schema,
      adapter,
      batchSize: 50,
      pollIntervalMs: 60_000,
      leaseDurationMs: 100,
      createLeaseOwner: () => `audit-lease-${++leaseOrdinal}`,
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

    await t.test("materializes missing rows and sends tenant-scoped immutable identities once", async () => {
      await seed({
        tenantId: "materialize-a",
        eventId: "shared-event",
        actorUserId: "actor-materialize-a",
        targetType: "host-record",
        targetId: "target-a",
        metadata: { revision: 7, reasonCode: "approved" },
        requestId: "request-materialize-a",
        correlationId: "correlation-materialize-a",
      });
      await seed({
        tenantId: "materialize-b",
        eventId: "shared-event",
        actorUserId: null,
        metadata: { revision: 8 },
        requestId: "request-materialize-b",
      });
      await harness.pool.query(
        `DELETE FROM ${deliveries}
         WHERE tenant_id IN ('materialize-a', 'materialize-b')
           AND audit_event_id = 'shared-event'`,
      );

      const calls = [];
      const dispatcher = worker({ async record(event) { calls.push(event); } });
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 2,
        claimed: 2,
        delivered: 2,
        failed: 0,
      });
      assert.deepEqual(
        calls.map(({ tenantId, auditEventId }) => [tenantId, auditEventId]).sort(),
        [["materialize-a", "shared-event"], ["materialize-b", "shared-event"]],
      );
      assert.deepEqual(
        calls.find(({ tenantId }) => tenantId === "materialize-a"),
        {
          auditEventId: "shared-event",
          tenantId: "materialize-a",
          actorUserId: "actor-materialize-a",
          action: "audit.tested",
          occurredAt: calls.find(({ tenantId }) => tenantId === "materialize-a").occurredAt,
          metadata: { revision: 7, reasonCode: "approved" },
          requestId: "request-materialize-a",
          correlationId: "correlation-materialize-a",
          target: { type: "host-record", id: "target-a" },
        },
      );
      assert.equal(calls.every(Object.isFrozen), true);
      assert.equal(calls.every(({ metadata }) => Object.isFrozen(metadata)), true);
      assert.equal((await dispatcher.runOnce()).claimed, 0);

      const stored = await harness.pool.query(
        `SELECT tenant_id, audit_event_id, attempt_count, delivered_at,
                lease_owner, failure_class
         FROM ${deliveries}
         WHERE tenant_id IN ('materialize-a', 'materialize-b')
         ORDER BY tenant_id`,
      );
      assert.equal(stored.rows.length, 2);
      assert.equal(stored.rows.every(({ attempt_count }) => attempt_count === "1"), true);
      assert.equal(stored.rows.every(({ delivered_at }) => delivered_at instanceof Date), true);
      assert.equal(stored.rows.every(({ lease_owner }) => lease_owner === null), true);
      assert.equal(stored.rows.every(({ failure_class }) => failure_class === null), true);
    });

    await t.test("excludes a concurrent worker while the first owns an unexpired lease", async () => {
      await seed({ eventId: "concurrent-event" });
      let release;
      let started = false;
      const gate = new Promise((resolve) => { release = resolve; });
      const first = worker({
        async record() {
          started = true;
          await gate;
        },
      }, { leaseDurationMs: 5_000 });
      const firstRun = first.runOnce();
      await waitFor(() => started);

      const secondCalls = [];
      const second = worker({ async record(event) { secondCalls.push(event); } });
      assert.deepEqual(await second.runOnce(), {
        materialized: 0,
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
      assert.deepEqual(secondCalls, []);
      release();
      assert.equal((await firstRun).delivered, 1);
    });

    await t.test("recovers an expired lease and guards settlement from its stale owner", async () => {
      await seed({ eventId: "stale-settlement-event" });
      let releaseFirst;
      let firstStarted = false;
      const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
      const identities = [];
      const first = worker({
        async record(event) {
          identities.push(event.auditEventId);
          firstStarted = true;
          await firstGate;
        },
      }, { leaseDurationMs: 25 });
      const firstRun = first.runOnce();
      await waitFor(() => firstStarted);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const second = worker({
        async record(event) { identities.push(event.auditEventId); },
      }, { leaseDurationMs: 1_000 });
      assert.equal((await second.runOnce()).delivered, 1);
      releaseFirst();
      assert.deepEqual(await firstRun, {
        materialized: 0,
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      assert.deepEqual(identities, ["stale-settlement-event", "stale-settlement-event"]);

      const state = (
        await harness.pool.query(
          `SELECT attempt_count, delivered_at, terminal_at, lease_owner
           FROM ${deliveries}
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'stale-settlement-event'`,
        )
      ).rows[0];
      assert.equal(state.attempt_count, "2");
      assert.equal(state.delivered_at instanceof Date, true);
      assert.equal(state.terminal_at, null);
      assert.equal(state.lease_owner, null);
    });

    await t.test("replays the same audit identity after adapter success and acknowledgment loss", async () => {
      await seed({ eventId: "ack-loss-event", requestId: "stable-request" });
      let rejectAcknowledgment = true;
      const database = {
        connect: () => harness.pool.connect(),
        query: async (sql, values) => {
          if (rejectAcknowledgment && sql.includes("SET delivered_at")) {
            rejectAcknowledgment = false;
            throw new Error("secret-database-ack-detail");
          }
          return harness.pool.query(sql, values);
        },
      };
      const calls = [];
      const first = createChatAuditDispatcher({
        database,
        schema: harness.schema,
        adapter: { async record(event) { calls.push(event); } },
        leaseDurationMs: 25,
        createLeaseOwner: () => "ack-loss-first",
      });
      workers.add(first);
      await assert.rejects(
        first.runOnce(),
        (error) => error instanceof ChatAuditDispatcherError &&
          error.failureClass === "database" &&
          !error.message.includes("secret-database-ack-detail"),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));

      const second = worker({ async record(event) { calls.push(event); } });
      assert.equal((await second.runOnce()).delivered, 1);
      assert.deepEqual(
        calls.map(({ auditEventId, requestId }) => ({ auditEventId, requestId })),
        [
          { auditEventId: "ack-loss-event", requestId: "stable-request" },
          { auditEventId: "ack-loss-event", requestId: "stable-request" },
        ],
      );
      assert.equal(JSON.stringify(calls).includes("secret-database-ack-detail"), false);
    });

    await t.test("persists capped transient/rate-limited backoff and terminal classes only", async () => {
      await seed({ eventId: "retry-event" });
      await seed({ eventId: "invalid-event" });
      await seed({ eventId: "configuration-event" });
      const base = new Date("2099-01-01T00:00:00.000Z");
      let now = base;
      let retryCalls = 0;
      const dispatcher = worker({
        async record(event) {
          if (event.auditEventId === "invalid-event") {
            throw new ChatAuditDeliveryError("invalid", "secret-invalid-detail");
          }
          if (event.auditEventId === "configuration-event") {
            throw new ChatAuditDeliveryError("configuration", "secret-config-detail");
          }
          retryCalls += 1;
          throw new ChatAuditDeliveryError(
            retryCalls === 2 ? "rate_limited" : "transient",
            "secret-retry-detail",
          );
        },
      }, {
        now: () => now,
        initialRetryDelayMs: 100,
        maxRetryDelayMs: 150,
      });

      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 3,
        delivered: 0,
        failed: 3,
      });
      let states = await harness.pool.query(
        `SELECT audit_event_id, attempt_count, next_attempt_at, terminal_at,
                failure_class, lease_owner
         FROM ${deliveries}
         WHERE audit_event_id IN (
           'retry-event', 'invalid-event', 'configuration-event'
         )
         ORDER BY audit_event_id`,
      );
      const retry = states.rows.find(({ audit_event_id }) => audit_event_id === "retry-event");
      assert.equal(retry.attempt_count, "1");
      assert.equal(retry.next_attempt_at.toISOString(), "2099-01-01T00:00:00.100Z");
      assert.equal(retry.failure_class, "transient");
      assert.equal(retry.terminal_at, null);
      for (const terminal of states.rows.filter(({ audit_event_id }) => audit_event_id !== "retry-event")) {
        assert.equal(terminal.terminal_at.toISOString(), base.toISOString());
        assert.equal(terminal.lease_owner, null);
      }
      assert.equal(
        states.rows.find(({ audit_event_id }) => audit_event_id === "invalid-event").failure_class,
        "rejected",
      );
      assert.equal(
        states.rows.find(({ audit_event_id }) => audit_event_id === "configuration-event").failure_class,
        "configuration",
      );

      now = new Date("2099-01-01T00:00:00.100Z");
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 1,
        delivered: 0,
        failed: 1,
      });
      states = await harness.pool.query(
        `SELECT attempt_count, next_attempt_at, failure_class
         FROM ${deliveries}
         WHERE tenant_id = 'tenant-a' AND audit_event_id = 'retry-event'`,
      );
      assert.deepEqual(states.rows[0], {
        attempt_count: "2",
        next_attempt_at: new Date("2099-01-01T00:00:00.250Z"),
        failure_class: "rate_limited",
      });
      assert.doesNotMatch(JSON.stringify(states.rows), /secret-|database-/u);
    });

    await t.test("quarantines a malformed row without poisoning its valid batch peer", async () => {
      await seed({ eventId: "malformed-event" });
      await seed({ eventId: "valid-peer-event", metadata: { safeCode: "ok" } });
      await harness.pool.query(
        `ALTER TABLE ${events}
         DISABLE TRIGGER chat_audit_events_reject_update_delete`,
      );
      await harness.pool.query(
        `ALTER TABLE ${events}
         DROP CONSTRAINT chat_audit_events_action_check`,
      );
      await harness.pool.query(
        `UPDATE ${events}
         SET action = ' malformed '
         WHERE tenant_id = 'tenant-a' AND event_id = 'malformed-event'`,
      );
      await harness.pool.query(
        `ALTER TABLE ${events}
         ENABLE TRIGGER chat_audit_events_reject_update_delete`,
      );

      const calls = [];
      const dispatcher = worker({ async record(event) { calls.push(event); } });
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 2,
        delivered: 1,
        failed: 1,
      });
      assert.deepEqual(calls.map(({ auditEventId }) => auditEventId), ["valid-peer-event"]);
      const states = await harness.pool.query(
        `SELECT audit_event_id, delivered_at, terminal_at, failure_class,
                lease_owner
         FROM ${deliveries}
         WHERE audit_event_id IN ('malformed-event', 'valid-peer-event')
         ORDER BY audit_event_id`,
      );
      assert.deepEqual(
        states.rows.map((state) => ({
          id: state.audit_event_id,
          delivered: state.delivered_at instanceof Date,
          terminal: state.terminal_at instanceof Date,
          failureClass: state.failure_class,
          leaseOwner: state.lease_owner,
        })),
        [
          {
            id: "malformed-event",
            delivered: false,
            terminal: true,
            failureClass: "rejected",
            leaseOwner: null,
          },
          {
            id: "valid-peer-event",
            delivered: true,
            terminal: false,
            failureClass: null,
            leaseOwner: null,
          },
        ],
      );
    });
  } finally {
    await Promise.all([...workers].map((dispatcher) => dispatcher.close()));
    await harness.teardown();
    await backend.teardown();
  }
});
