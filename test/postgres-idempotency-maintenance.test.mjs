import assert from "node:assert/strict";
import test from "node:test";

import {
  createExpiredIdempotencyKeyMaintenanceJob,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const requestHash = `sha256:${"a".repeat(64)}`;

const identity = ({ tenantId, userId, operationName, clientKey }) =>
  `${tenantId}/${userId}/${operationName}/${clientKey}`;

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

const withDeadline = async (promise, milliseconds = 5_000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("concurrent maintenance exceeded deadline")),
          milliseconds,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("expired idempotency-key maintenance is bounded, ordered, and concurrent", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_idempotency_maintenance",
  });
  const schema = quoteIdentifier(harness.schema);
  const keys = `${schema}.chat_idempotency_keys`;

  const expired = [
    ["tenant-a", "user-a", "cleanup.alpha", "key-a", "2020-01-01T00:00:00Z", "pending"],
    ["tenant-a", "user-a", "cleanup.alpha", "key-b", "2020-01-01T00:00:00Z", "completed"],
    ["tenant-a", "user-b", "cleanup.alpha", "key-a", "2020-01-01T00:00:00Z", "pending"],
    ["tenant-b", "user-a", "cleanup.alpha", "key-a", "2020-01-01T00:00:00Z", "completed"],
    ["tenant-a", "user-a", "cleanup.beta", "key-a", "2020-01-02T00:00:00Z", "pending"],
    ["tenant-a", "user-a", "cleanup.beta", "key-b", "2020-01-03T00:00:00Z", "completed"],
    ["tenant-c", "user-a", "cleanup.alpha", "key-a", "2020-01-04T00:00:00Z", "pending"],
    ["tenant-c", "user-b", "cleanup.alpha", "key-a", "2020-01-05T00:00:00Z", "completed"],
  ];
  const unexpired = [
    ["tenant-live", "user-a", "cleanup.pending", "key-a", "2099-01-01T00:00:00Z", "pending"],
    ["tenant-live", "user-b", "cleanup.completed", "key-a", "2099-01-01T00:00:00Z", "completed"],
  ];

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    for (const [tenantId, userId, operationName, clientKey, expiresAt, state] of [
      ...expired,
      ...unexpired,
    ]) {
      await harness.pool.query(
        `INSERT INTO ${keys} (
           tenant_id, user_id, operation_name, client_key, request_hash, state,
           response_status, response_body, created_at, updated_at,
           completed_at, expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           CASE WHEN $6 = 'completed' THEN 200 ELSE NULL END,
           CASE WHEN $6 = 'completed' THEN '{"ok":true}'::jsonb ELSE NULL END,
           '2019-01-01T00:00:00Z', '2019-01-02T00:00:00Z',
           CASE WHEN $6 = 'completed' THEN '2019-01-02T00:00:00Z'::timestamptz ELSE NULL END,
           $7
         )`,
        [tenantId, userId, operationName, clientKey, requestHash, state, expiresAt],
      );
    }

    const batchOfThree = createExpiredIdempotencyKeyMaintenanceJob({
      database: harness.pool,
      schema: harness.schema,
      batchSize: 3,
    });
    const first = await batchOfThree();
    assert.equal(first.deletedCount, 3);
    assert.deepEqual(
      first.deleted.map(identity),
      expired.slice(0, 3).map(([tenantId, userId, operationName, clientKey]) =>
        identity({ tenantId, userId, operationName, clientKey }),
      ),
    );

    const concurrentJob = () =>
      createExpiredIdempotencyKeyMaintenanceJob({
        database: harness.pool,
        schema: harness.schema,
        batchSize: 2,
      })();
    const concurrent = await withDeadline(
      Promise.all([concurrentJob(), concurrentJob()]),
    );
    assert.deepEqual(concurrent.map((result) => result.deletedCount), [2, 2]);
    const concurrentlyDeleted = concurrent.flatMap((result) =>
      result.deleted.map(identity),
    );
    assert.equal(new Set(concurrentlyDeleted).size, concurrentlyDeleted.length);

    const allDeleted = [...first.deleted.map(identity), ...concurrentlyDeleted];
    for (let run = 0; run < 10; run += 1) {
      const result = await batchOfThree();
      assert.ok(result.deletedCount <= 3);
      allDeleted.push(...result.deleted.map(identity));
      if (result.deletedCount === 0) {
        break;
      }
    }
    assert.deepEqual(
      new Set(allDeleted),
      new Set(
        expired.map(([tenantId, userId, operationName, clientKey]) =>
          identity({ tenantId, userId, operationName, clientKey }),
        ),
      ),
    );
    assert.equal(allDeleted.length, expired.length);

    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT tenant_id, state
           FROM ${keys}
           ORDER BY tenant_id, user_id`,
        )
      ).rows,
      [
        { tenant_id: "tenant-live", state: "pending" },
        { tenant_id: "tenant-live", state: "completed" },
      ],
    );

    await harness.pool.query(
      `INSERT INTO ${keys} (
         tenant_id, user_id, operation_name, client_key, request_hash,
         created_at, updated_at, expires_at
       )
       SELECT
         'explain-tenant-' || (value % 7),
         'explain-user-' || (value % 19),
         'explain.cleanup',
         'explain-key-' || value,
         $1,
         '2090-01-01T00:00:00Z',
         '2090-01-01T00:00:00Z',
         '2099-01-01T00:00:00Z'::timestamptz + value * interval '1 second'
       FROM generate_series(1, 5000) AS value`,
      [requestHash],
    );

    const client = await harness.pool.connect();
    try {
      await client.query(`ANALYZE ${keys}`);
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const plan = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT expires_at, tenant_id, user_id, operation_name, client_key
         FROM ${keys}
         WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at, tenant_id, user_id, operation_name, client_key
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [100],
      );
      assert.ok(
        findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
          "chat_idempotency_keys_expiry_cleanup_idx",
        ),
      );
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
