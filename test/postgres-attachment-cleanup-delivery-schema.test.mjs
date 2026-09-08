import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAttachmentCleanupDeliveriesMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const migrationId = "0037-chat-attachment-cleanup-deliveries";
const migrationIndex = handrailChatPostgresMigrations.indexOf(
  chatAttachmentCleanupDeliveriesMigration,
);
const migrationsThrough0036 = handrailChatPostgresMigrations.slice(
  0,
  migrationIndex,
);

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const expectConstraint = (promise, constraint) =>
  assert.rejects(promise, (error) => error?.constraint === constraint);

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

test("attachment cleanup delivery migration is frozen, deterministic, expand-only, and last", () => {
  assert.equal(Object.isFrozen(handrailChatPostgresMigrations), true);
  assert.equal(Object.isFrozen(chatAttachmentCleanupDeliveriesMigration), true);
  assert.equal(
    Object.isFrozen(chatAttachmentCleanupDeliveriesMigration.statements),
    true,
  );
  assert.equal(migrationIndex, handrailChatPostgresMigrations.length - 1);
  assert.deepEqual(
    handrailChatPostgresMigrations[migrationIndex - 1] && {
      id: handrailChatPostgresMigrations[migrationIndex - 1].id,
      order: handrailChatPostgresMigrations[migrationIndex - 1].order,
    },
    { id: "0036-chat-audit-deliveries", order: 36 },
  );
  assert.deepEqual(
    {
      id: chatAttachmentCleanupDeliveriesMigration.id,
      order: chatAttachmentCleanupDeliveriesMigration.order,
    },
    { id: migrationId, order: 37 },
  );
  assert.equal(
    handrailChatPostgresMigrations.filter(({ id }) => id === migrationId).length,
    1,
  );
  assert.equal(
    chatAttachmentCleanupDeliveriesMigration.statements.some((statement) =>
      /^\s*(?:ALTER|DROP|DELETE|TRUNCATE)\b/i.test(statement),
    ),
    false,
  );

  const descriptor = createPostgresMigrationRunner({
    database: {},
    migrations: handrailChatPostgresMigrations,
  }).migrations.at(-1);
  const equivalentDescriptor = createPostgresMigrationRunner({
    database: {},
    migrations: [
      {
        ...chatAttachmentCleanupDeliveriesMigration,
        statements: [...chatAttachmentCleanupDeliveriesMigration.statements],
      },
    ],
  }).migrations[0];
  assert.equal(
    descriptor?.checksum,
    "sha256:844cbb5161c82286688b1d137d420ff0e95f05a60fb0d9388ca3710f5757db98",
  );
  assert.equal(descriptor?.checksum, equivalentDescriptor.checksum);
});

test("attachment cleanup delivery migration upgrades order 36 with guarded durable work", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "attachment_cleanup",
  });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const attachments = `${schema}.chat_attachments`;
  const deliveries = `${schema}.chat_attachment_cleanup_deliveries`;
  const metadata = `${schema}._handrail_migrations`;

  const createPendingAttachment = ({
    id,
    tenantId = "tenant-a",
    storageKey = `${tenantId}/${id}`,
  }) =>
    harness.pool.query(
      `INSERT INTO ${attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, created_at, updated_at, expires_at
       )
       VALUES ($1, $2, 'uploader-a', $3, $4, 'text/plain', 12,
               '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
               '2099-01-01T00:00:00Z')`,
      [tenantId, id, storageKey, `${id}.txt`],
    );

  const abandonAttachment = async (id) => {
    await createPendingAttachment({ id });
    await harness.pool.query(
      `UPDATE ${attachments}
       SET state = 'abandoned',
           abandoned_at = '2020-01-02T00:00:00Z',
           updated_at = '2020-01-02T00:00:00Z'
       WHERE tenant_id = 'tenant-a' AND id = $1`,
      [id],
    );
  };

  const claim = ({
    id,
    attemptCount,
    owner = "worker-a",
    expiresAt = "2099-01-01T00:00:00Z",
    updatedAt = null,
  }) =>
    harness.pool.query(
      `UPDATE ${deliveries}
       SET state = 'leased',
           attempt_count = $1,
           lease_owner = $2,
           lease_expires_at = $3,
           last_error_code = NULL,
           updated_at = coalesce($4::timestamptz, statement_timestamp())
       WHERE tenant_id = 'tenant-a' AND attachment_id = $5`,
      [attemptCount, owner, expiresAt, updatedAt, id],
    );

  try {
    const oldRunner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: migrationsThrough0036,
    });
    const oldApply = await oldRunner.apply();
    assert.deepEqual(
      oldApply.applied.map(({ id, order }) => ({ id, order })),
      migrationsThrough0036.map(({ id, order }) => ({ id, order })),
    );
    assert.deepEqual(
      oldApply.applied.at(-1) && {
        id: oldApply.applied.at(-1).id,
        order: oldApply.applied.at(-1).order,
      },
      { id: "0036-chat-audit-deliveries", order: 36 },
    );
    assert.deepEqual(oldApply.status.pending, []);
    assert.deepEqual(oldApply.status.incompatible, []);
    assert.equal(
      (
        await harness.pool.query("SELECT to_regclass($1) AS relation", [
          `${harness.schema}.chat_attachment_cleanup_deliveries`,
        ])
      ).rows[0].relation,
      null,
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES ('tenant-a', 'conversation-a', 'channel', 'private', 'Tenant A')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES ('tenant-a', 'message-a', 'conversation-a', 1, 'author-a',
               'client-a', '{"format":"plain","text":"Attachment"}')`,
    );

    for (const id of [
      "abandoned-retry",
      "abandoned-delivery",
      "abandoned-invalid",
      "abandoned-terminal",
    ]) {
      await abandonAttachment(id);
    }
    await createPendingAttachment({ id: "active-pending" });
    await createPendingAttachment({ id: "active-attached" });
    await harness.pool.query(
      `UPDATE ${attachments}
       SET state = 'attached',
           attached_message_id = 'message-a',
           checksum = $1,
           attached_at = '2020-01-02T00:00:00Z',
           updated_at = '2020-01-02T00:00:00Z'
       WHERE tenant_id = 'tenant-a' AND id = 'active-attached'`,
      [`sha256:${"a".repeat(64)}`],
    );

    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const pending = await runner.status();
    assert.equal(pending.applied.length, 36);
    assert.deepEqual(
      pending.pending.map(({ id, order }) => ({ id, order })),
      [{ id: migrationId, order: 37 }],
    );
    assert.deepEqual(pending.incompatible, []);

    const upgrade = await runner.apply();
    assert.deepEqual(
      upgrade.applied.map(({ id, order }) => ({ id, order })),
      [{ id: migrationId, order: 37 }],
    );
    assert.equal(upgrade.status.applied.length, 37);
    assert.deepEqual(upgrade.status.pending, []);
    assert.deepEqual(upgrade.status.incompatible, []);
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${metadata}
           WHERE id = $1 AND migration_order = 37 AND checksum = $2`,
          [migrationId, runner.migrations.at(-1).checksum],
        )
      ).rows[0].count,
      1,
    );
    assert.deepEqual((await runner.apply()).applied, []);

    await t.test("stores only immutable object identity and bounded mechanics", async () => {
      const columns = (
        await harness.pool.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'chat_attachment_cleanup_deliveries'
           ORDER BY ordinal_position`,
          [harness.schema],
        )
      ).rows.map(({ column_name }) => column_name);
      assert.deepEqual(columns, [
        "tenant_id",
        "attachment_id",
        "storage_key",
        "state",
        "attempt_count",
        "next_attempt_at",
        "lease_owner",
        "lease_expires_at",
        "last_error_code",
        "created_at",
        "updated_at",
        "delivered_at",
      ]);

      const constraints = (
        await harness.pool.query(
          `SELECT conname
           FROM pg_constraint
           WHERE conrelid = $1::regclass
           ORDER BY conname`,
          [`${harness.schema}.chat_attachment_cleanup_deliveries`],
        )
      ).rows.map(({ conname }) => conname);
      assert.deepEqual(constraints, [
        "chat_attachment_cleanup_deliveries_attachment_fkey",
        "chat_attachment_cleanup_deliveries_attachment_id_check",
        "chat_attachment_cleanup_deliveries_attempt_count_check",
        "chat_attachment_cleanup_deliveries_error_code_check",
        "chat_attachment_cleanup_deliveries_lease_owner_check",
        "chat_attachment_cleanup_deliveries_lifecycle_shape_check",
        "chat_attachment_cleanup_deliveries_pkey",
        "chat_attachment_cleanup_deliveries_state_check",
        "chat_attachment_cleanup_deliveries_storage_key_check",
        "chat_attachment_cleanup_deliveries_tenant_id_check",
        "chat_attachment_cleanup_deliveries_timestamp_check",
      ]);
    });

    await t.test("backfills one pending row per abandoned attachment only", async () => {
      const seeded = (
        await harness.pool.query(
          `SELECT attachment_id, storage_key, state, attempt_count,
                  lease_owner, lease_expires_at, last_error_code, delivered_at
           FROM ${deliveries}
           ORDER BY attachment_id`,
        )
      ).rows;
      assert.deepEqual(
        seeded.map((row) => ({
          attachmentId: row.attachment_id,
          storageKey: row.storage_key,
          state: row.state,
          attemptCount: Number(row.attempt_count),
          leaseOwner: row.lease_owner,
          leaseExpiresAt: row.lease_expires_at,
          lastErrorCode: row.last_error_code,
          deliveredAt: row.delivered_at,
        })),
        [
          "abandoned-delivery",
          "abandoned-invalid",
          "abandoned-retry",
          "abandoned-terminal",
        ].map((attachmentId) => ({
          attachmentId,
          storageKey: `tenant-a/${attachmentId}`,
          state: "pending",
          attemptCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          deliveredAt: null,
        })),
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${deliveries}
             WHERE attachment_id IN ('active-pending', 'active-attached')`,
          )
        ).rows[0].count,
        0,
      );

      const seedStatement = chatAttachmentCleanupDeliveriesMigration.statements.find(
        (statement) => statement.startsWith("WITH seed_time AS"),
      );
      assert.ok(seedStatement);
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
        await client.query(seedStatement);
        await client.query(seedStatement);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assert.equal(
        (await harness.pool.query(`SELECT count(*)::integer AS count FROM ${deliveries}`))
          .rows[0].count,
        4,
      );
    });

    await t.test("supports claim, failure, retry, and delivery transitions", async () => {
      await claim({ id: "abandoned-retry", attemptCount: 1 });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET state = 'failed',
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error_code = 'storage.unavailable',
             next_attempt_at = statement_timestamp(),
             updated_at = statement_timestamp()
         WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-retry'`,
      );
      await claim({
        id: "abandoned-retry",
        attemptCount: 2,
        owner: "worker-retry",
      });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET state = 'delivered',
             lease_owner = NULL,
             lease_expires_at = NULL,
             delivered_at = statement_timestamp(),
             updated_at = statement_timestamp()
         WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-retry'`,
      );

      await claim({ id: "abandoned-delivery", attemptCount: 1 });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET state = 'delivered',
             lease_owner = NULL,
             lease_expires_at = NULL,
             delivered_at = statement_timestamp(),
             updated_at = statement_timestamp()
         WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-delivery'`,
      );

      const states = (
        await harness.pool.query(
          `SELECT attachment_id, state, attempt_count, last_error_code,
                  delivered_at IS NOT NULL AS delivered
           FROM ${deliveries}
           WHERE attachment_id IN ('abandoned-retry', 'abandoned-delivery')
           ORDER BY attachment_id`,
        )
      ).rows;
      assert.deepEqual(
        states.map((row) => ({ ...row, attempt_count: Number(row.attempt_count) })),
        [
          {
            attachment_id: "abandoned-delivery",
            state: "delivered",
            attempt_count: 1,
            last_error_code: null,
            delivered: true,
          },
          {
            attachment_id: "abandoned-retry",
            state: "delivered",
            attempt_count: 2,
            last_error_code: null,
            delivered: true,
          },
        ],
      );
    });

    await t.test("rejects malformed shapes, invalid claims, and backward movement", async () => {
      await expectConstraint(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET state = 'failed', attempt_count = 1,
               last_error_code = 'storage.unavailable',
               updated_at = statement_timestamp()
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
        ),
        "chat_attachment_cleanup_deliveries_transition_check",
      );
      await expectConstraint(
        claim({
          id: "abandoned-invalid",
          attemptCount: 1,
          owner: "worker secret",
        }),
        "chat_attachment_cleanup_deliveries_lease_owner_check",
      );
      await expectConstraint(
        claim({ id: "abandoned-invalid", attemptCount: 2 }),
        "chat_attachment_cleanup_deliveries_claim_check",
      );
      await claim({ id: "abandoned-invalid", attemptCount: 1 });
      await expectConstraint(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET state = 'failed',
               lease_owner = NULL, lease_expires_at = NULL,
               updated_at = statement_timestamp(),
               next_attempt_at = statement_timestamp()
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
        ),
        "chat_attachment_cleanup_deliveries_lifecycle_shape_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET state = 'failed', attempt_count = 0,
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'storage.unavailable',
               next_attempt_at = statement_timestamp(),
               updated_at = statement_timestamp()
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
        ),
        /attempt_count must not move backwards/,
      );
      await expectConstraint(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET state = 'failed',
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = ' ',
               next_attempt_at = statement_timestamp(),
               updated_at = statement_timestamp()
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
        ),
        "chat_attachment_cleanup_deliveries_error_code_check",
      );
      await expectConstraint(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET state = 'failed',
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = $1,
               next_attempt_at = statement_timestamp(),
               updated_at = statement_timestamp()
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
          ["x".repeat(256)],
        ),
        "chat_attachment_cleanup_deliveries_error_code_check",
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET state = 'failed',
             lease_owner = NULL, lease_expires_at = NULL,
             last_error_code = 'storage.unavailable',
             next_attempt_at = statement_timestamp(),
             updated_at = statement_timestamp()
         WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET next_attempt_at = created_at - interval '1 second'
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
        ),
        /timestamps must not move backwards/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET updated_at = created_at - interval '1 second'
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-invalid'`,
        ),
        /timestamps must not move backwards/,
      );

      await abandonAttachment("future-ready");
      await harness.pool.query(
        `INSERT INTO ${deliveries} (
           tenant_id, attachment_id, storage_key, next_attempt_at,
           created_at, updated_at
         )
         VALUES ('tenant-a', 'future-ready', 'tenant-a/future-ready',
                 '2099-01-01T00:00:00Z', statement_timestamp(),
                 statement_timestamp())`,
      );
      await expectConstraint(
        claim({ id: "future-ready", attemptCount: 1 }),
        "chat_attachment_cleanup_deliveries_claim_check",
      );
      await expectConstraint(
        harness.pool.query(
          `INSERT INTO ${deliveries}
             (tenant_id, attachment_id, storage_key)
           VALUES ('tenant-a', 'active-pending', 'tenant-a/active-pending')`,
        ),
        "chat_attachment_cleanup_deliveries_attachment_match_check",
      );
      await abandonAttachment("mismatched-key");
      await expectConstraint(
        harness.pool.query(
          `INSERT INTO ${deliveries}
             (tenant_id, attachment_id, storage_key)
           VALUES ('tenant-a', 'mismatched-key', 'tenant-a/wrong-key')`,
        ),
        "chat_attachment_cleanup_deliveries_attachment_match_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET storage_key = 'tenant-a/changed-key'
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'future-ready'`,
        ),
        /identity, object key, and creation timestamp are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET attachment_id = 'abandoned-invalid'
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'future-ready'`,
        ),
        /identity, object key, and creation timestamp are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET tenant_id = 'tenant-b'
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'future-ready'`,
        ),
        /identity, object key, and creation timestamp are immutable/,
      );

      await abandonAttachment("infinite-timestamp");
      await expectConstraint(
        harness.pool.query(
          `INSERT INTO ${deliveries} (
             tenant_id, attachment_id, storage_key, next_attempt_at,
             created_at, updated_at
           )
           VALUES ('tenant-a', 'infinite-timestamp',
                   'tenant-a/infinite-timestamp', 'infinity',
                   statement_timestamp(), statement_timestamp())`,
        ),
        "chat_attachment_cleanup_deliveries_timestamp_check",
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET created_at = created_at + interval '1 second'
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'future-ready'`,
        ),
        /identity, object key, and creation timestamp are immutable/,
      );
    });

    await t.test("permits only expired leases to be reclaimed", async () => {
      await abandonAttachment("expired-reclaim");
      await harness.pool.query(
        `INSERT INTO ${deliveries} (
           tenant_id, attachment_id, storage_key, next_attempt_at,
           created_at, updated_at
         )
         VALUES ('tenant-a', 'expired-reclaim', 'tenant-a/expired-reclaim',
                 '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z',
                 '2020-01-01T00:00:00Z')`,
      );
      await claim({
        id: "expired-reclaim",
        attemptCount: 1,
        owner: "worker-expired",
        expiresAt: "2020-01-02T00:00:00Z",
        updatedAt: "2020-01-01T12:00:00Z",
      });
      await expectConstraint(
        claim({
          id: "expired-reclaim",
          attemptCount: 2,
          owner: "worker-expired",
        }),
        "chat_attachment_cleanup_deliveries_reclaim_check",
      );
      await claim({
        id: "expired-reclaim",
        attemptCount: 2,
        owner: "worker-reclaimer",
      });
      await expectConstraint(
        claim({
          id: "expired-reclaim",
          attemptCount: 3,
          owner: "worker-thief",
        }),
        "chat_attachment_cleanup_deliveries_reclaim_check",
      );
    });

    await t.test("keeps delivered rows terminal and immutable", async () => {
      await claim({ id: "abandoned-terminal", attemptCount: 1 });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET state = 'delivered',
             lease_owner = NULL, lease_expires_at = NULL,
             delivered_at = statement_timestamp(),
             updated_at = statement_timestamp()
         WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-terminal'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET state = 'failed', delivered_at = NULL,
               last_error_code = 'storage.unavailable',
               next_attempt_at = statement_timestamp(),
               updated_at = statement_timestamp()
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-terminal'`,
        ),
        /delivered chat_attachment_cleanup_deliveries are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${deliveries}
           WHERE tenant_id = 'tenant-a' AND attachment_id = 'abandoned-terminal'`,
        ),
        /delivered chat_attachment_cleanup_deliveries are immutable/,
      );
    });

    await t.test("ready and expired-lease scans use their partial indexes", async () => {
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        const readyPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT tenant_id, attachment_id, storage_key
           FROM ${deliveries}
           WHERE state IN ('pending', 'failed')
             AND next_attempt_at <= statement_timestamp()
           ORDER BY next_attempt_at, tenant_id, attachment_id
           LIMIT 10
           FOR UPDATE SKIP LOCKED`,
        );
        const expiredPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT tenant_id, attachment_id, storage_key
           FROM ${deliveries}
           WHERE state = 'leased'
             AND lease_expires_at <= statement_timestamp()
           ORDER BY lease_expires_at, tenant_id, attachment_id
           LIMIT 10
           FOR UPDATE SKIP LOCKED`,
        );
        assert.ok(
          findIndexes(readyPlan.rows[0]["QUERY PLAN"]).includes(
            "chat_attachment_cleanup_deliveries_global_ready_idx",
          ),
        );
        assert.ok(
          findIndexes(expiredPlan.rows[0]["QUERY PLAN"]).includes(
            "chat_attachment_cleanup_deliveries_global_expired_lease_idx",
          ),
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
