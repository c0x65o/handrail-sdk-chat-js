import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const requestHash = `sha256:${"a".repeat(64)}`;
const differentRequestHash = `sha256:${"b".repeat(64)}`;

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

test("idempotency migration stores one actor-scoped mutation outcome", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_idempotency" });
  const schema = quoteIdentifier(harness.schema);
  const keys = `${schema}.chat_idempotency_keys`;
  const claim = `${schema}.claim_chat_idempotency_key`;

  const claimKey = (
    database,
    {
      tenantId = "tenant-a",
      userId = "user-a",
      operationName = "message.send",
      clientKey = "request-a",
      hash = requestHash,
      expiresAt = "2099-01-01T00:00:00Z",
    } = {},
  ) =>
    database.query(
      `SELECT * FROM ${claim}($1, $2, $3, $4, $5, $6)`,
      [tenantId, userId, operationName, clientKey, hash, expiresAt],
    );

  try {
    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const applied = await runner.apply();

    assert.deepEqual(
      applied.applied.map(({ id, order }) => ({ id, order })),
      [
        { id: "0001-chat-conversations-membership", order: 1 },
        { id: "0002-chat-messages-revisions", order: 2 },
        { id: "0003-chat-reactions", order: 3 },
        { id: "0004-chat-read-cursors", order: 4 },
        { id: "0005-chat-outbox-events", order: 5 },
        { id: "0006-chat-idempotency-keys", order: 6 },
        { id: "0007-chat-drafts", order: 7 },
        { id: "0008-chat-conversation-preferences", order: 8 },
        { id: "0009-chat-thread-follows", order: 9 },
        { id: "0010-chat-attachments", order: 10 },
        { id: "0011-chat-audit-events", order: 11 },
        { id: "0012-chat-saved-messages", order: 12 },
        { id: "0013-chat-huddle-sessions", order: 13 },
        { id: "0014-chat-notification-deliveries", order: 14 },
        { id: "0015-chat-conversation-lifecycle-revision", order: 15 },
        { id: "0016-chat-thread-follow-revision", order: 16 },
      ],
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_class AS relation
             INNER JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $1
               AND relation.relname = 'chat_idempotency_keys'
               AND relation.relkind IN ('r', 'p')
           ) AS exists`,
          [harness.schema],
        )
      ).rows[0]?.exists,
      true,
    );

    await t.test("replays the one completed outcome for the same request hash", async () => {
      const initial = (await claimKey(harness.pool)).rows;
      assert.equal(initial.length, 1);
      assert.equal(initial[0].idempotency_state, "pending");

      const completed = (
        await harness.pool.query(
          `WITH completion AS (SELECT clock_timestamp() AS completed_at)
           UPDATE ${keys}
           SET state = 'completed',
               response_status = 201,
               response_body = '{"messageId":"message-a"}',
               completed_at = completion.completed_at,
               updated_at = completion.completed_at
           FROM completion
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND operation_name = 'message.send'
             AND client_key = 'request-a'
             AND request_hash = $1
             AND state = 'pending'
           RETURNING response_status, response_body`,
          [requestHash],
        )
      ).rows;
      assert.deepEqual(completed, [
        { response_status: 201, response_body: { messageId: "message-a" } },
      ]);

      const replay = (await claimKey(harness.pool)).rows;
      assert.equal(replay.length, 1);
      assert.deepEqual(
        {
          state: replay[0].idempotency_state,
          status: replay[0].stored_response_status,
          body: replay[0].stored_response_body,
          reference: replay[0].stored_response_reference,
        },
        {
          state: "completed",
          status: 201,
          body: { messageId: "message-a" },
          reference: null,
        },
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${keys}
             WHERE tenant_id = 'tenant-a'
               AND user_id = 'user-a'
               AND operation_name = 'message.send'
               AND client_key = 'request-a'`,
          )
        ).rows[0]?.count,
        1,
      );
    });

    await t.test("rejects a reused tuple with a different request hash", async () => {
      const conflict = await claimKey(harness.pool, {
        hash: differentRequestHash,
      });
      assert.deepEqual(conflict.rows, []);

      const stored = (
        await harness.pool.query(
          `SELECT request_hash, state, response_status, response_body
           FROM ${keys}
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND operation_name = 'message.send'
             AND client_key = 'request-a'`,
        )
      ).rows;
      assert.deepEqual(stored, [
        {
          request_hash: requestHash,
          state: "completed",
          response_status: 201,
          response_body: { messageId: "message-a" },
        },
      ]);

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${keys}
           SET request_hash = $1
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND operation_name = 'message.send'
             AND client_key = 'request-a'`,
          [differentRequestHash],
        ),
        /request identities are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${keys}
           SET response_body = '{"messageId":"changed"}'
           WHERE tenant_id = 'tenant-a'
             AND user_id = 'user-a'
             AND operation_name = 'message.send'
             AND client_key = 'request-a'`,
        ),
        /completed chat_idempotency_keys outcomes are immutable/,
      );
    });

    await t.test("isolates identical operation keys by tenant and user", async () => {
      const tenantClaim = await claimKey(harness.pool, {
        tenantId: "tenant-b",
      });
      const userClaim = await claimKey(harness.pool, { userId: "user-b" });

      assert.equal(tenantClaim.rows[0]?.idempotency_state, "pending");
      assert.equal(userClaim.rows[0]?.idempotency_state, "pending");
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT tenant_id, user_id
             FROM ${keys}
             WHERE operation_name = 'message.send'
               AND client_key = 'request-a'
             ORDER BY tenant_id, user_id`,
          )
        ).rows,
        [
          { tenant_id: "tenant-a", user_id: "user-a" },
          { tenant_id: "tenant-a", user_id: "user-b" },
          { tenant_id: "tenant-b", user_id: "user-a" },
        ],
      );
    });

    await t.test("admits one concurrent durable winner and replays it", async () => {
      const first = await harness.pool.connect();
      const second = await harness.pool.connect();
      const storeCompletedOutcome = (database, contender) =>
        database.query(
          `INSERT INTO ${keys} AS stored (
             tenant_id, user_id, operation_name, client_key, request_hash,
             state, response_status, response_body,
             created_at, updated_at, completed_at, expires_at
           )
           VALUES (
             'tenant-a', 'user-a', 'conversation.create', 'concurrent-key', $1,
             'completed', 201, jsonb_build_object('winner', $2::text),
             '2030-01-01T00:00:00Z', '2030-01-01T00:00:01Z',
             '2030-01-01T00:00:01Z', '2099-01-01T00:00:00Z'
           )
           ON CONFLICT ON CONSTRAINT chat_idempotency_keys_pkey
           DO UPDATE SET request_hash = stored.request_hash
           WHERE stored.request_hash = EXCLUDED.request_hash
           RETURNING response_status, response_body`,
          [requestHash, contender],
        );

      try {
        const [firstResult, secondResult] = await Promise.all([
          storeCompletedOutcome(first, "first"),
          storeCompletedOutcome(second, "second"),
        ]);

        assert.equal(firstResult.rows.length, 1);
        assert.equal(secondResult.rows.length, 1);
        assert.deepEqual(firstResult.rows[0], secondResult.rows[0]);
        assert.ok(["first", "second"].includes(firstResult.rows[0].response_body.winner));

        const replay = await storeCompletedOutcome(first, "late-retry");
        assert.deepEqual(replay.rows, [firstResult.rows[0]]);
        assert.equal(
          (
            await harness.pool.query(
              `SELECT count(*)::integer AS count
               FROM ${keys}
               WHERE tenant_id = 'tenant-a'
                 AND user_id = 'user-a'
                 AND operation_name = 'conversation.create'
                 AND client_key = 'concurrent-key'`,
            )
          ).rows[0]?.count,
          1,
        );
      } finally {
        first.release();
        second.release();
      }
    });

    await t.test("enforces identifiers, hashes, response lifecycle, and finite expiry", async () => {
      const invalidClaims = [
        {
          values: ["   ", "user", "operation", "key", requestHash, "2099-01-01Z"],
          constraint: /chat_idempotency_keys_tenant_id_check/,
        },
        {
          values: ["tenant", "u".repeat(256), "operation", "key", requestHash, "2099-01-01Z"],
          constraint: /chat_idempotency_keys_user_id_check/,
        },
        {
          values: ["tenant", "user", "", "key", requestHash, "2099-01-01Z"],
          constraint: /chat_idempotency_keys_operation_name_check/,
        },
        {
          values: ["tenant", "user", "operation", "k".repeat(256), requestHash, "2099-01-01Z"],
          constraint: /chat_idempotency_keys_client_key_check/,
        },
        {
          values: ["tenant", "user", "operation", "key", `sha256:${"A".repeat(64)}`, "2099-01-01Z"],
          constraint: /chat_idempotency_keys_request_hash_check/,
        },
        {
          values: ["tenant", "user", "operation", "key", requestHash, "infinity"],
          constraint: /chat_idempotency_keys_timestamp_order_check/,
        },
      ];

      for (const { values, constraint } of invalidClaims) {
        await assert.rejects(
          harness.pool.query(
            `SELECT * FROM ${claim}($1, $2, $3, $4, $5, $6)`,
            values,
          ),
          constraint,
        );
      }

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${keys} (
             tenant_id, user_id, operation_name, client_key, request_hash,
             state, response_status, expires_at
           )
           VALUES (
             'tenant-a', 'user-a', 'invalid.complete', 'invalid-lifecycle', $1,
             'completed', 201, '2099-01-01Z'
           )`,
          [requestHash],
        ),
        /chat_idempotency_keys_lifecycle_check/,
      );
    });

    await t.test("uses the expiry index for a bounded cleanup selection", async () => {
      await harness.pool.query(
        `INSERT INTO ${keys} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           created_at, updated_at, expires_at
         )
         SELECT
           'cleanup-tenant-' || (value % 5),
           'cleanup-user-' || (value % 17),
           'cleanup.operation',
           'cleanup-key-' || value,
           $1,
           '2029-01-01T00:00:00Z',
           '2029-01-01T00:00:00Z',
           '2030-01-01T00:00:00Z'::timestamptz + value * interval '1 second'
         FROM generate_series(1, 5000) AS value`,
        [requestHash],
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${keys}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const cleanupPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT tenant_id, user_id, operation_name, client_key
           FROM ${keys}
           WHERE expires_at <= '2030-01-02T00:00:00Z'
           ORDER BY expires_at
           LIMIT 100`,
        );

        assert.ok(
          findIndexes(cleanupPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_idempotency_keys_expiry_cleanup_idx",
          ),
        );
      } finally {
        await client.query("RESET enable_bitmapscan").catch(() => undefined);
        await client.query("RESET enable_seqscan").catch(() => undefined);
        client.release();
      }
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
