import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAuditDeliveriesMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const migrationId = "0036-chat-audit-deliveries";
const migrationIndex = handrailChatPostgresMigrations.indexOf(
  chatAuditDeliveriesMigration,
);
const migrationsThrough0035 = handrailChatPostgresMigrations.slice(
  0,
  migrationIndex,
);
const migrationsThrough0036 = handrailChatPostgresMigrations.slice(
  0,
  migrationIndex + 1,
);

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const findIndexes = (plan, indexes = []) => {
  if (plan && typeof plan === "object") {
    if (typeof plan["Index Name"] === "string") {
      indexes.push(plan["Index Name"]);
    }
    for (const value of Object.values(plan)) {
      findIndexes(value, indexes);
    }
  }
  return indexes;
};

test("audit delivery migration is frozen, deterministic, expand-only, and ordered", () => {
  assert.equal(Object.isFrozen(handrailChatPostgresMigrations), true);
  assert.equal(Object.isFrozen(chatAuditDeliveriesMigration), true);
  assert.equal(Object.isFrozen(chatAuditDeliveriesMigration.statements), true);
  assert.equal(migrationIndex, handrailChatPostgresMigrations.length - 2);
  assert.deepEqual(
    handrailChatPostgresMigrations[migrationIndex - 1] && {
      id: handrailChatPostgresMigrations[migrationIndex - 1].id,
      order: handrailChatPostgresMigrations[migrationIndex - 1].order,
    },
    { id: "0035-chat-device-push-token-legacy-retirement", order: 35 },
  );
  assert.deepEqual(
    { id: chatAuditDeliveriesMigration.id, order: chatAuditDeliveriesMigration.order },
    { id: migrationId, order: 36 },
  );
  assert.deepEqual(
    handrailChatPostgresMigrations[migrationIndex + 1] && {
      id: handrailChatPostgresMigrations[migrationIndex + 1].id,
      order: handrailChatPostgresMigrations[migrationIndex + 1].order,
    },
    { id: "0037-chat-attachment-cleanup-deliveries", order: 37 },
  );
  assert.equal(
    handrailChatPostgresMigrations.filter(({ id }) => id === migrationId).length,
    1,
  );
  assert.equal(
    chatAuditDeliveriesMigration.statements.some((statement) =>
      /^\s*(?:ALTER|DROP|DELETE|TRUNCATE)\b/i.test(statement),
    ),
    false,
  );

  const descriptor = createPostgresMigrationRunner({
    database: {},
    migrations: handrailChatPostgresMigrations,
  }).migrations.find(({ id }) => id === migrationId);
  const equivalentDescriptor = createPostgresMigrationRunner({
    database: {},
    migrations: [
      {
        ...chatAuditDeliveriesMigration,
        statements: [...chatAuditDeliveriesMigration.statements],
      },
    ],
  }).migrations[0];
  assert.equal(
    descriptor?.checksum,
    "sha256:3aa058fb7f582f7457f92ec33116313e9a3935c673a61ad5f50fb414291a661d",
  );
  assert.equal(descriptor?.checksum, equivalentDescriptor.checksum);
});

test("audit delivery migration upgrades order 35 with durable tenant-safe claims", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "audit_delivery" });
  const schema = quoteIdentifier(harness.schema);
  const auditEvents = `${schema}.chat_audit_events`;
  const deliveries = `${schema}.chat_audit_deliveries`;
  const metadata = `${schema}._handrail_migrations`;

  const insertAuditEvent = ({
    tenantId = "tenant-a",
    eventId,
    occurredAt = "2030-01-01T00:00:00Z",
  }) =>
    harness.pool.query(
      `INSERT INTO ${auditEvents}
         (tenant_id, event_id, actor_user_id, action, occurred_at, metadata,
          request_id)
       VALUES ($1, $2, 'actor-a', 'audit.tested', $3, '{}', $4)`,
      [tenantId, eventId, occurredAt, `request-${tenantId}-${eventId}`],
    );

  const claim = ({
    eventId,
    owner = "worker-a",
    expiresAt = "2030-01-01T00:10:00Z",
    attempts = 1,
  }) =>
    harness.pool.query(
      `UPDATE ${deliveries}
       SET attempt_count = $1, lease_owner = $2, lease_expires_at = $3,
           failure_class = NULL
       WHERE tenant_id = 'tenant-a' AND audit_event_id = $4`,
      [attempts, owner, expiresAt, eventId],
    );

  try {
    const oldRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: migrationsThrough0035,
    });
    const oldApply = await oldRunner.apply();
    assert.deepEqual(
      oldApply.applied.at(-1) && {
        id: oldApply.applied.at(-1).id,
        order: oldApply.applied.at(-1).order,
      },
      { id: "0035-chat-device-push-token-legacy-retirement", order: 35 },
    );
    assert.deepEqual(oldApply.status.pending, []);
    assert.deepEqual(oldApply.status.incompatible, []);
    assert.equal(
      (
        await harness.pool.query("SELECT to_regclass($1) AS relation", [
          `${harness.schema}.chat_audit_deliveries`,
        ])
      ).rows[0].relation,
      null,
    );

    for (const eventId of [
      "historical-a",
      "historical-concurrent-1",
      "historical-concurrent-2",
      "historical-concurrent-3",
      "historical-concurrent-4",
      "historical-concurrent-5",
      "historical-concurrent-6",
    ]) {
      await insertAuditEvent({ eventId });
    }

    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: migrationsThrough0036,
    });
    const pending = await runner.status();
    assert.equal(pending.applied.length, 35);
    assert.deepEqual(
      pending.pending.map(({ id, order }) => ({ id, order })),
      [{ id: migrationId, order: 36 }],
    );
    assert.deepEqual(pending.incompatible, []);

    const upgrade = await runner.apply();
    assert.deepEqual(
      upgrade.applied.map(({ id, order }) => ({ id, order })),
      [{ id: migrationId, order: 36 }],
    );
    assert.equal(upgrade.status.applied.length, 36);
    assert.deepEqual(upgrade.status.pending, []);
    assert.deepEqual(upgrade.status.incompatible, []);
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${metadata}
           WHERE id = $1 AND migration_order = 36 AND checksum = $2`,
          [migrationId, runner.migrations.at(-1).checksum],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (await harness.pool.query(`SELECT count(*)::integer AS count FROM ${deliveries}`))
        .rows[0].count,
      0,
      "the expansion must not enqueue historical audit events",
    );
    assert.deepEqual((await runner.apply()).applied, []);

    await t.test("stores only mechanics and creates new intent transactionally", async () => {
      const columns = (
        await harness.pool.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'chat_audit_deliveries'
           ORDER BY ordinal_position`,
          [harness.schema],
        )
      ).rows.map(({ column_name }) => column_name);
      assert.deepEqual(columns, [
        "tenant_id",
        "audit_event_id",
        "attempt_count",
        "next_attempt_at",
        "lease_owner",
        "lease_expires_at",
        "delivered_at",
        "terminal_at",
        "failure_class",
      ]);

      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ${auditEvents}
             (tenant_id, event_id, actor_user_id, action, occurred_at,
              metadata, request_id)
           VALUES ('tenant-a', 'transactional-event', 'actor-a',
                   'audit.tested', '2030-01-01T00:00:00Z', '{}',
                   'request-transactional-event')`,
        );
        const insideTransaction = await client.query(
          `SELECT attempt_count, lease_owner, delivered_at, terminal_at,
                  failure_class
           FROM ${deliveries}
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'transactional-event'`,
        );
        assert.deepEqual(insideTransaction.rows, [
          {
            attempt_count: "0",
            lease_owner: null,
            delivered_at: null,
            terminal_at: null,
            failure_class: null,
          },
        ]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${auditEvents}
             WHERE tenant_id = 'tenant-a'
               AND event_id = 'transactional-event'`,
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${deliveries}
             WHERE tenant_id = 'tenant-a'
               AND audit_event_id = 'transactional-event'`,
          )
        ).rows[0].count,
        0,
      );
    });

    await t.test("enforces composite foreign keys and bounded initial state", async () => {
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${deliveries} (tenant_id, audit_event_id)
           VALUES ('tenant-b', 'historical-a')`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_audit_event_fkey",
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${deliveries}
             (tenant_id, audit_event_id, attempt_count, next_attempt_at)
           VALUES ('tenant-a', 'historical-a', -1,
                   '2030-01-01T00:00:00Z')`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_initial_state_check",
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${deliveries}
             (tenant_id, audit_event_id, next_attempt_at)
           VALUES ('tenant-a', 'historical-a', 'infinity')`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_timestamp_check",
      );
      await harness.pool.query(
        `INSERT INTO ${deliveries}
           (tenant_id, audit_event_id, next_attempt_at)
         VALUES ('tenant-a', 'historical-a', '2030-01-01T00:00:00Z')`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET audit_event_id = 'historical-concurrent-1'
           WHERE tenant_id = 'tenant-a' AND audit_event_id = 'historical-a'`,
        ),
        /chat_audit_deliveries identity is immutable/,
      );
    });

    await t.test("rejects invalid attempt, lease, timestamp, and terminal shapes", async () => {
      await insertAuditEvent({ eventId: "invalid-shapes" });
      await assert.rejects(
        claim({ eventId: "invalid-shapes", attempts: 2 }),
        (error) =>
          error?.constraint === "chat_audit_deliveries_attempt_transition_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET attempt_count = 1, lease_owner = 'worker-a'
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'invalid-shapes'`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_lease_pair_check",
      );
      await assert.rejects(
        claim({ eventId: "invalid-shapes", owner: "worker secret" }),
        (error) => error?.constraint === "chat_audit_deliveries_lease_owner_check",
      );
      await assert.rejects(
        claim({ eventId: "invalid-shapes", expiresAt: "infinity" }),
        (error) => error?.constraint === "chat_audit_deliveries_timestamp_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET delivered_at = '2030-01-01T00:01:00Z'
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'invalid-shapes'`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_transition_check",
      );

      await claim({ eventId: "invalid-shapes" });
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET lease_owner = NULL, lease_expires_at = NULL,
               terminal_at = '2030-01-01T00:11:00Z',
               failure_class = 'provider_secret'
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'invalid-shapes'`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_failure_class_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET lease_owner = NULL, lease_expires_at = NULL,
               delivered_at = '2030-01-01T00:11:00Z',
               terminal_at = '2030-01-01T00:11:00Z'
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'invalid-shapes'`,
        ),
        (error) =>
          error?.constraint === "chat_audit_deliveries_lifecycle_shape_check" ||
          error?.constraint === "chat_audit_deliveries_terminal_pair_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET lease_owner = NULL, lease_expires_at = NULL,
               delivered_at = '2020-01-01T00:00:00Z'
           WHERE tenant_id = 'tenant-a'
             AND audit_event_id = 'invalid-shapes'`,
        ),
        (error) => error?.constraint === "chat_audit_deliveries_timestamp_check",
      );
    });

    await t.test("supports retry, expired reclaim, delivery, and terminal failure", async () => {
      await insertAuditEvent({ eventId: "retry-success" });
      await claim({ eventId: "retry-success", expiresAt: "2020-01-01T00:00:00Z" });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET lease_owner = NULL, lease_expires_at = NULL,
             failure_class = 'transient',
             next_attempt_at = '2030-01-01T00:20:00Z'
         WHERE tenant_id = 'tenant-a' AND audit_event_id = 'retry-success'`,
      );
      await claim({
        eventId: "retry-success",
        owner: "worker-retry",
        expiresAt: "2030-01-01T00:30:00Z",
        attempts: 2,
      });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET lease_owner = NULL, lease_expires_at = NULL,
             delivered_at = '2030-01-01T00:21:00Z'
         WHERE tenant_id = 'tenant-a' AND audit_event_id = 'retry-success'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries} SET next_attempt_at = '2030-01-01T00:22:00Z'
           WHERE tenant_id = 'tenant-a' AND audit_event_id = 'retry-success'`,
        ),
        /terminal chat_audit_deliveries are immutable/,
      );

      await insertAuditEvent({ eventId: "expired-reclaim" });
      await claim({
        eventId: "expired-reclaim",
        owner: "worker-expired",
        expiresAt: "2020-01-01T00:00:00Z",
      });
      await claim({
        eventId: "expired-reclaim",
        owner: "worker-reclaimer",
        expiresAt: "2099-01-01T00:00:00Z",
        attempts: 2,
      });
      await assert.rejects(
        claim({
          eventId: "expired-reclaim",
          owner: "worker-thief",
          expiresAt: "2099-01-02T00:00:00Z",
          attempts: 3,
        }),
        (error) => error?.constraint === "chat_audit_deliveries_reclaim_check",
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET lease_owner = NULL, lease_expires_at = NULL,
             terminal_at = '2099-01-01T00:01:00Z',
             failure_class = 'configuration'
         WHERE tenant_id = 'tenant-a' AND audit_event_id = 'expired-reclaim'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries} SET failure_class = 'unknown'
           WHERE tenant_id = 'tenant-a' AND audit_event_id = 'expired-reclaim'`,
        ),
        /terminal chat_audit_deliveries are immutable/,
      );
    });

    await t.test("concurrent skip-locked ready claims select disjoint rows", async () => {
      for (let index = 1; index <= 6; index += 1) {
        await harness.pool.query(
          `INSERT INTO ${deliveries}
             (tenant_id, audit_event_id, next_attempt_at)
           VALUES ('tenant-a', $1, '2030-01-01T00:00:00Z')`,
          [`historical-concurrent-${index}`],
        );
      }
      const first = await harness.pool.connect();
      const second = await harness.pool.connect();
      const selectBatch = (client) =>
        client.query(
          `SELECT tenant_id, audit_event_id
           FROM ${deliveries}
           WHERE lease_owner IS NULL
             AND delivered_at IS NULL
             AND terminal_at IS NULL
             AND audit_event_id LIKE 'historical-concurrent-%'
             AND next_attempt_at <= '2030-01-01T00:00:00Z'
           ORDER BY next_attempt_at, tenant_id, audit_event_id
           LIMIT 3
           FOR UPDATE SKIP LOCKED`,
        );
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        const firstIds = (await selectBatch(first)).rows.map(
          ({ audit_event_id }) => audit_event_id,
        );
        const secondIds = (await selectBatch(second)).rows.map(
          ({ audit_event_id }) => audit_event_id,
        );
        assert.equal(firstIds.length, 3);
        assert.equal(secondIds.length, 3);
        assert.deepEqual(firstIds, [...firstIds].sort());
        assert.deepEqual(secondIds, [...secondIds].sort());
        assert.deepEqual(
          firstIds.filter((eventId) => secondIds.includes(eventId)),
          [],
        );
        assert.deepEqual(
          [...firstIds, ...secondIds].sort(),
          Array.from(
            { length: 6 },
            (_, index) => `historical-concurrent-${index + 1}`,
          ),
        );
      } finally {
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        first.release();
        second.release();
      }
    });

    await t.test("global ready and expired queries use their intended indexes", async () => {
      await harness.pool.query(
        `INSERT INTO ${auditEvents}
           (tenant_id, event_id, actor_user_id, action, occurred_at, metadata,
            request_id)
         SELECT 'tenant-plan', 'terminal-' || value, 'actor-plan',
                'audit.tested', '2030-01-01T00:00:00Z', '{}',
                'request-terminal-' || value
         FROM generate_series(1, 3000) AS series(value)`,
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET attempt_count = 1, lease_owner = 'worker-plan',
             lease_expires_at = '2099-01-01T00:00:00Z'
         WHERE tenant_id = 'tenant-plan'`,
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET lease_owner = NULL, lease_expires_at = NULL,
             delivered_at = '2099-01-01T00:00:01Z'
         WHERE tenant_id = 'tenant-plan'`,
      );
      await harness.pool.query(
        `INSERT INTO ${auditEvents}
           (tenant_id, event_id, actor_user_id, action, occurred_at, metadata,
            request_id)
         SELECT 'tenant-ready', 'ready-' || value, 'actor-ready',
                'audit.tested', '2030-01-01T00:00:00Z', '{}',
                'request-ready-' || value
         FROM generate_series(1, 20) AS series(value)`,
      );
      await harness.pool.query(
        `INSERT INTO ${auditEvents}
           (tenant_id, event_id, actor_user_id, action, occurred_at, metadata,
            request_id)
         SELECT 'tenant-expired', 'expired-' || value, 'actor-expired',
                'audit.tested', '2030-01-01T00:00:00Z', '{}',
                'request-expired-' || value
         FROM generate_series(1, 20) AS series(value)`,
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET attempt_count = 1, lease_owner = 'worker-expired-plan',
             lease_expires_at = '2020-01-01T00:00:00Z'
         WHERE tenant_id = 'tenant-expired'`,
      );
      await harness.pool.query(`ANALYZE ${deliveries}`);

      const readyPlan = await harness.pool.query(
        `EXPLAIN (FORMAT JSON)
         SELECT tenant_id, audit_event_id
         FROM ${deliveries}
         WHERE lease_owner IS NULL
           AND delivered_at IS NULL
           AND terminal_at IS NULL
           AND next_attempt_at <= '2099-01-01T00:00:00Z'
         ORDER BY next_attempt_at, tenant_id, audit_event_id
         LIMIT 10
         FOR UPDATE SKIP LOCKED`,
      );
      const expiredPlan = await harness.pool.query(
        `EXPLAIN (FORMAT JSON)
         SELECT tenant_id, audit_event_id
         FROM ${deliveries}
         WHERE lease_owner IS NOT NULL
           AND delivered_at IS NULL
           AND terminal_at IS NULL
           AND lease_expires_at <= '2030-01-01T00:00:00Z'
         ORDER BY lease_expires_at, tenant_id, audit_event_id
         LIMIT 10
         FOR UPDATE SKIP LOCKED`,
      );
      assert.ok(
        findIndexes(readyPlan.rows[0]["QUERY PLAN"]).includes(
          "chat_audit_deliveries_global_ready_idx",
        ),
      );
      assert.ok(
        findIndexes(expiredPlan.rows[0]["QUERY PLAN"]).includes(
          "chat_audit_deliveries_global_expired_lease_idx",
        ),
      );
    });

    await t.test("audit events remain append-only after migration 0036", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${auditEvents} SET action = 'audit.changed'
           WHERE tenant_id = 'tenant-a' AND event_id = 'historical-a'`,
        ),
        /chat_audit_events are append-only/,
      );
      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${auditEvents}
           WHERE tenant_id = 'tenant-a' AND event_id = 'historical-a'`,
        ),
        /chat_audit_events are append-only/,
      );
      await assert.rejects(
        harness.pool.query(`TRUNCATE ${auditEvents}, ${deliveries}`),
        /chat_audit_events are append-only/,
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
