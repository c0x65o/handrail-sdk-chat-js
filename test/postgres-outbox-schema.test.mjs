import assert from "node:assert/strict";
import test from "node:test";

import {
  chatOutboxExpiryCleanupMigration,
  chatOutboxTenantReplayPositionsMigration,
  chatOutboxUnpublishedStreamHeadsMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

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

test("unpublished outbox stream-head migration is immutable and forward-registered", () => {
  assert.deepEqual(
    {
      id: chatOutboxUnpublishedStreamHeadsMigration.id,
      order: chatOutboxUnpublishedStreamHeadsMigration.order,
    },
    { id: "0024-chat-outbox-unpublished-stream-heads", order: 24 },
  );
  assert.equal(Object.isFrozen(chatOutboxUnpublishedStreamHeadsMigration), true);
  assert.equal(
    Object.isFrozen(chatOutboxUnpublishedStreamHeadsMigration.statements),
    true,
  );
  assert.deepEqual(chatOutboxUnpublishedStreamHeadsMigration.statements, [
    `CREATE INDEX chat_outbox_events_unpublished_stream_head_idx
         ON chat_outbox_events (tenant_id, stream_id, replay_position)
         WHERE published_at IS NULL`,
  ]);

  const migrationIndex = handrailChatPostgresMigrations.indexOf(
    chatOutboxUnpublishedStreamHeadsMigration,
  );
  assert.ok(migrationIndex > 0);
  assert.ok(
    handrailChatPostgresMigrations[migrationIndex - 1].order <
      chatOutboxUnpublishedStreamHeadsMigration.order,
  );
});

test("tenant replay-position migration is immutable and forward-registered", () => {
  assert.deepEqual(
    {
      id: chatOutboxTenantReplayPositionsMigration.id,
      order: chatOutboxTenantReplayPositionsMigration.order,
    },
    { id: "0025-chat-outbox-tenant-replay-positions", order: 25 },
  );
  assert.equal(Object.isFrozen(chatOutboxTenantReplayPositionsMigration), true);
  assert.equal(
    Object.isFrozen(chatOutboxTenantReplayPositionsMigration.statements),
    true,
  );
  assert.deepEqual(chatOutboxTenantReplayPositionsMigration.statements, [
    `CREATE INDEX chat_outbox_events_tenant_replay_idx
         ON chat_outbox_events (tenant_id, replay_position DESC)`,
  ]);

  const migrationIndex = handrailChatPostgresMigrations.indexOf(
    chatOutboxTenantReplayPositionsMigration,
  );
  assert.ok(migrationIndex > 0);
  assert.equal(
    handrailChatPostgresMigrations[migrationIndex - 1],
    chatOutboxUnpublishedStreamHeadsMigration,
  );
});

test("outbox expiry cleanup migration is immutable and forward-registered", () => {
  assert.deepEqual(
    {
      id: chatOutboxExpiryCleanupMigration.id,
      order: chatOutboxExpiryCleanupMigration.order,
    },
    { id: "0028-chat-outbox-expiry-cleanup", order: 28 },
  );
  assert.equal(Object.isFrozen(chatOutboxExpiryCleanupMigration), true);
  assert.equal(Object.isFrozen(chatOutboxExpiryCleanupMigration.statements), true);
  assert.deepEqual(chatOutboxExpiryCleanupMigration.statements, [
    `CREATE INDEX chat_outbox_events_expiry_cleanup_idx
         ON chat_outbox_events (expires_at, replay_position)`,
  ]);

  const migrationIndex = handrailChatPostgresMigrations.indexOf(
    chatOutboxExpiryCleanupMigration,
  );
  assert.ok(migrationIndex > 0);
  assert.equal(
    handrailChatPostgresMigrations[migrationIndex - 1].order <
      chatOutboxExpiryCleanupMigration.order,
    true,
  );

  const descriptor = createPostgresMigrationRunner({
    database: {},
    migrations: handrailChatPostgresMigrations,
  }).migrations.find(({ id }) => id === chatOutboxExpiryCleanupMigration.id);
  const equivalentDescriptor = createPostgresMigrationRunner({
    database: {},
    migrations: [
      {
        ...chatOutboxExpiryCleanupMigration,
        statements: [...chatOutboxExpiryCleanupMigration.statements],
      },
    ],
  }).migrations[0];
  assert.equal(
    descriptor.checksum,
    "sha256:9bcf0aa590b10027ef2dc4084e65c4cf3c480d53ac2de2bcb5841d9ad0cb2e75",
  );
  assert.equal(descriptor.checksum, equivalentDescriptor.checksum);
});

test("outbox migration provides transactional delivery and replay storage", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_outbox" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const outbox = `${schema}.chat_outbox_events`;

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
        { id: "0017-chat-conversation-member-list-revision", order: 17 },
        { id: "0018-chat-conversation-preference-revision", order: 18 },
        { id: "0019-chat-saved-message-mutation-state", order: 19 },
        { id: "0020-chat-huddle-participant-leave-reason", order: 20 },
        { id: "0021-chat-huddle-ending-recovery", order: 21 },
        { id: "0022-chat-device-push-tokens", order: 22 },
        { id: "0023-chat-conversation-list-ordering", order: 23 },
        { id: "0024-chat-outbox-unpublished-stream-heads", order: 24 },
        { id: "0025-chat-outbox-tenant-replay-positions", order: 25 },
        { id: "0026-chat-notification-global-claim-indexes", order: 26 },
        { id: "0027-chat-notification-materializer-offsets", order: 27 },
        { id: "0028-chat-outbox-expiry-cleanup", order: 28 },
        { id: "0029-chat-message-search-vector", order: 29 },
      ],
    );

    await t.test("rolls domain and matching outbox writes back together", async () => {
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ${conversations}
             (tenant_id, id, type, visibility, name)
           VALUES ('tenant-a', 'rolled-back', 'channel', 'private', 'Rolled back')`,
        );
        await client.query(
          `INSERT INTO ${outbox}
             (event_id, protocol_version, tenant_id, stream_id, type,
              occurred_at, payload, expires_at)
           VALUES
             ('event-rolled-back', 4, 'tenant-a', 'rolled-back',
              'conversation.created', '2020-01-01T00:00:00Z',
              '{"conversationId":"rolled-back"}', '2099-01-01T00:00:00Z')`,
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT
               (SELECT count(*)::integer FROM ${conversations}
                WHERE id = 'rolled-back') AS conversation_count,
               (SELECT count(*)::integer FROM ${outbox}
                WHERE event_id = 'event-rolled-back') AS event_count`,
          )
        ).rows[0],
        { conversation_count: 0, event_count: 0 },
      );
    });

    let committedReplayPosition;
    await t.test("commits domain and matching outbox writes together", async () => {
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ${conversations}
             (tenant_id, id, type, visibility, name)
           VALUES ('tenant-a', 'stream-main', 'channel', 'private', 'Main')`,
        );
        committedReplayPosition = (
          await client.query(
            `INSERT INTO ${outbox}
               (event_id, protocol_version, tenant_id, stream_id, type,
                occurred_at, payload, expires_at)
             VALUES
               ('event-committed', 4, 'tenant-a', 'stream-main',
                'conversation.created', '2020-01-01T00:00:00Z',
                '{"conversationId":"stream-main"}', '2099-01-01T00:00:00Z')
             RETURNING replay_position`,
          )
        ).rows[0].replay_position;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT conversation.id AS conversation_id,
                    event.event_id,
                    event.protocol_version::integer AS protocol_version,
                    event.payload
             FROM ${conversations} AS conversation
             INNER JOIN ${outbox} AS event
               ON event.tenant_id = conversation.tenant_id
              AND event.stream_id = conversation.id
             WHERE conversation.id = 'stream-main'`,
          )
        ).rows,
        [
          {
            conversation_id: "stream-main",
            event_id: "event-committed",
            protocol_version: 4,
            payload: { conversationId: "stream-main" },
          },
        ],
      );
    });

    await t.test("claims competing publish batches without overlap", async () => {
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, available_at, expires_at)
         SELECT
           'claim-event-' || value,
           4,
           'tenant-a',
           'claim-stream',
           'message.created',
           '2020-01-01T00:00:00Z',
           jsonb_build_object('value', value),
           '2020-01-01T00:00:00Z',
           '2099-01-01T00:00:00Z'
         FROM generate_series(1, 4) AS value`,
      );

      const first = await harness.pool.connect();
      const second = await harness.pool.connect();
      const claim = (client, token) =>
        client.query(
          `WITH claimable AS (
             SELECT event_id
             FROM ${outbox}
             WHERE published_at IS NULL
               AND available_at <= CURRENT_TIMESTAMP
               AND stream_id = 'claim-stream'
             ORDER BY available_at, replay_position
             FOR UPDATE SKIP LOCKED
             LIMIT 2
           )
           UPDATE ${outbox} AS event
           SET publish_attempts = event.publish_attempts + 1,
               claim_token = $1,
               claimed_at = clock_timestamp(),
               available_at = clock_timestamp() + interval '5 minutes'
           FROM claimable
           WHERE event.event_id = claimable.event_id
           RETURNING event.event_id`,
          [token],
        );

      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        const firstClaim = (await claim(first, "worker-a")).rows.map(
          ({ event_id }) => event_id,
        );
        const secondClaim = (await claim(second, "worker-b")).rows.map(
          ({ event_id }) => event_id,
        );

        assert.equal(firstClaim.length, 2);
        assert.equal(secondClaim.length, 2);
        assert.deepEqual(
          firstClaim.filter((eventId) => secondClaim.includes(eventId)),
          [],
        );

        await first.query("COMMIT");
        await second.query("COMMIT");
      } catch (error) {
        await first.query("ROLLBACK").catch(() => undefined);
        await second.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        first.release();
        second.release();
      }

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT claim_token, count(*)::integer AS count,
                    min(publish_attempts)::integer AS minimum_attempts,
                    bool_and(claimed_at IS NOT NULL) AS all_claimed
             FROM ${outbox}
             WHERE stream_id = 'claim-stream'
             GROUP BY claim_token
             ORDER BY claim_token`,
          )
        ).rows,
        [
          {
            claim_token: "worker-a",
            count: 2,
            minimum_attempts: 1,
            all_claimed: true,
          },
          {
            claim_token: "worker-b",
            count: 2,
            minimum_attempts: 1,
            all_claimed: true,
          },
        ],
      );
    });

    await t.test("replays one tenant and stream strictly after a cursor", async () => {
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, expires_at)
         VALUES
           ('replay-a-1', 4, 'tenant-a', 'stream-main', 'message.created',
            '2020-01-02T00:00:00Z', '{"ordinal":1}', '2099-01-01T00:00:00Z'),
           ('replay-b', 4, 'tenant-b', 'stream-main', 'message.created',
            '2020-01-02T00:00:00Z', '{"ordinal":2}', '2099-01-01T00:00:00Z'),
           ('replay-other-stream', 4, 'tenant-a', 'stream-other', 'message.created',
            '2020-01-02T00:00:00Z', '{"ordinal":3}', '2099-01-01T00:00:00Z'),
           ('replay-a-2', 4, 'tenant-a', 'stream-main', 'message.updated',
            '2020-01-03T00:00:00Z', '{"ordinal":4}', '2099-01-01T00:00:00Z')`,
      );

      const replayed = (
        await harness.pool.query(
          `SELECT event_id, replay_position
           FROM ${outbox}
           WHERE tenant_id = 'tenant-a'
             AND stream_id = 'stream-main'
             AND replay_position > $1
           ORDER BY replay_position`,
          [committedReplayPosition],
        )
      ).rows;

      assert.deepEqual(
        replayed.map(({ event_id }) => event_id),
        ["replay-a-1", "replay-a-2"],
      );
      assert.ok(
        replayed.every(
          (event, index) =>
            index === 0 ||
            BigInt(event.replay_position) > BigInt(replayed[index - 1].replay_position),
        ),
      );
    });

    await t.test("rejects invalid envelopes and delivery state", async () => {
      const invalidWrites = [
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-protocol', 0, 'tenant-a', 'stream-a', 'test',
                        '2020-01-01Z', '{}', '2099-01-01Z')`,
          constraint: /chat_outbox_events_protocol_version_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-safe-protocol', 9007199254740992, 'tenant-a',
                        'stream-a', 'test', '2020-01-01Z', '{}', '2099-01-01Z')`,
          constraint: /chat_outbox_events_protocol_version_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-tenant', 4, '   ', 'stream-a', 'test',
                        '2020-01-01Z', '{}', '2099-01-01Z')`,
          constraint: /chat_outbox_events_tenant_id_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-stream', 4, 'tenant-a', '', 'test',
                        '2020-01-01Z', '{}', '2099-01-01Z')`,
          constraint: /chat_outbox_events_stream_id_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-type', 4, 'tenant-a', 'stream-a', E'\n\t',
                        '2020-01-01Z', '{}', '2099-01-01Z')`,
          constraint: /chat_outbox_events_type_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-payload', 4, 'tenant-a', 'stream-a', 'test',
                        '2020-01-01Z', NULL, '2099-01-01Z')`,
          constraint: /payload.*not-null|not-null.*payload/i,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, expires_at)
                VALUES ('invalid-time', 4, 'tenant-a', 'stream-a', 'test',
                        'infinity', '{}', 'infinity')`,
          constraint: /chat_outbox_events_timestamp_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, publish_attempts, expires_at)
                VALUES ('invalid-attempts', 4, 'tenant-a', 'stream-a', 'test',
                        '2020-01-01Z', '{}', -1, '2099-01-01Z')`,
          constraint: /chat_outbox_events_publish_attempts_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, claim_token, expires_at)
                VALUES ('invalid-claim', 4, 'tenant-a', 'stream-a', 'test',
                        '2020-01-01Z', '{}', 'worker', '2099-01-01Z')`,
          constraint: /chat_outbox_events_claim_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (event_id, protocol_version, tenant_id, stream_id, type,
                   occurred_at, payload, claim_token, claimed_at, published_at,
                   expires_at)
                VALUES ('invalid-published-claim', 4, 'tenant-a', 'stream-a',
                        'test', '2020-01-01Z', '{}', 'worker', CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP, '2099-01-01Z')`,
          constraint: /chat_outbox_events_published_claim_check/,
        },
        {
          sql: `INSERT INTO ${outbox}
                  (replay_position, event_id, protocol_version, tenant_id,
                   stream_id, type, occurred_at, payload, expires_at)
                OVERRIDING SYSTEM VALUE
                VALUES (9007199254740992, 'invalid-replay', 4, 'tenant-a',
                        'stream-a', 'test', '2020-01-01Z', '{}', '2099-01-01Z')`,
          constraint: /chat_outbox_events_replay_position_check/,
        },
      ];

      for (const { sql, constraint } of invalidWrites) {
        await assert.rejects(harness.pool.query(sql), constraint);
      }

      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${outbox}
             (event_id, protocol_version, tenant_id, stream_id, type,
              occurred_at, payload, expires_at)
           VALUES ('event-committed', 4, 'tenant-a', 'stream-main', 'test',
                   '2020-01-01Z', '{}', '2099-01-01Z')`,
        ),
        /chat_outbox_events_event_id_key/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${outbox}
           SET payload = '{"changed":true}'
           WHERE event_id = 'event-committed'`,
        ),
        /chat_outbox_events envelopes are immutable/,
      );
    });

    await t.test("uses publisher, replay, and expiry cleanup indexes", async () => {
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, available_at, published_at, expires_at)
         SELECT
           'published-plan-' || value,
           4,
           'plan-tenant-' || (value % 5),
           'plan-stream-' || (value % 11),
           'message.created',
           '2020-01-01T00:00:00Z',
           jsonb_build_object('value', value),
           '2020-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
           '2021-01-01T00:00:00Z',
           '2099-01-01T00:00:00Z'
         FROM generate_series(1, 5000) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, available_at, expires_at)
         SELECT
           'pending-plan-' || value,
           4,
           'plan-tenant-0',
           'plan-stream-' || (value % 11),
           'message.created',
           '2022-01-01T00:00:00Z',
           jsonb_build_object('value', value),
           '2022-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
           '2099-01-01T00:00:00Z'
         FROM generate_series(1, 22) AS value`,
      );
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, available_at, published_at, expires_at)
         SELECT
           'expired-plan-' || value,
           4,
           'expiry-tenant-' || (value % 3),
           'expiry-stream-' || (value % 7),
           'message.created',
           '2019-01-01T00:00:00Z',
           jsonb_build_object('value', value),
           '2019-01-01T00:00:00Z',
           CASE
             WHEN value % 2 = 0 THEN '2020-01-01T00:00:00Z'::timestamptz
             ELSE NULL
           END,
           '2020-01-01T00:00:00Z'::timestamptz + value * interval '1 second'
         FROM generate_series(1, 40) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${outbox}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const pendingPlan = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT event_id
           FROM ${outbox}
           WHERE published_at IS NULL
             AND available_at <= CURRENT_TIMESTAMP
           ORDER BY available_at, replay_position
           LIMIT 25`,
        );
        const streamHeadPlan = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT candidate.replay_position
           FROM ${outbox} AS candidate
           WHERE candidate.published_at IS NULL
             AND candidate.available_at <= clock_timestamp()
             AND (
               candidate.claim_token IS NULL
               OR candidate.claimed_at <= clock_timestamp() - interval '1 minute'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM ${outbox} AS earlier
               WHERE earlier.tenant_id = candidate.tenant_id
                 AND earlier.stream_id = candidate.stream_id
                 AND earlier.published_at IS NULL
                 AND earlier.replay_position < candidate.replay_position
             )
           ORDER BY candidate.replay_position
           LIMIT 25`,
        );
        const streamReplayPlan = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT event_id
           FROM ${outbox}
           WHERE tenant_id = 'tenant-a'
             AND stream_id = 'stream-main'
             AND replay_position > $1
           ORDER BY replay_position`,
          [committedReplayPosition],
        );
        const tenantLatestPlan = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT replay_position
           FROM ${outbox}
           WHERE tenant_id = $1
           ORDER BY replay_position DESC
           LIMIT 1`,
          ["plan-tenant-0"],
        );
        const tenantReplayPlan = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT event_id
           FROM ${outbox}
           WHERE tenant_id = $1
             AND replay_position > $2
           ORDER BY replay_position`,
          ["plan-tenant-0", 0],
        );
        const expiryCleanupPlan = await client.query(
          `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT event_id, published_at
           FROM ${outbox}
           WHERE expires_at < '2030-01-01T00:00:00Z'
           ORDER BY expires_at, replay_position
           LIMIT 25`,
        );
        const expiryCleanupRows = (
          await client.query(
            `SELECT event_id, published_at
             FROM ${outbox}
             WHERE expires_at < '2030-01-01T00:00:00Z'
             ORDER BY expires_at, replay_position
             LIMIT 25`,
          )
        ).rows;

        assert.ok(
          findIndexes(pendingPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_outbox_events_pending_idx",
          ),
        );
        assert.ok(
          findIndexes(streamHeadPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_outbox_events_unpublished_stream_head_idx",
          ),
        );
        assert.ok(
          findIndexes(streamReplayPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_outbox_events_tenant_stream_replay_idx",
          ),
        );
        assert.ok(
          findIndexes(tenantLatestPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_outbox_events_tenant_replay_idx",
          ),
        );
        assert.ok(
          findIndexes(tenantReplayPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_outbox_events_tenant_replay_idx",
          ),
        );
        assert.ok(
          findIndexes(expiryCleanupPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_outbox_events_expiry_cleanup_idx",
          ),
        );
        assert.equal(expiryCleanupRows.length, 25);
        assert.ok(expiryCleanupRows.some(({ published_at }) => published_at === null));
        assert.ok(expiryCleanupRows.some(({ published_at }) => published_at !== null));
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
