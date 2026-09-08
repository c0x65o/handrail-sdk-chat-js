import assert from "node:assert/strict";
import test from "node:test";

import {
  chatNotificationGlobalClaimIndexesMigration,
  chatNotificationMaterializerOffsetsMigration,
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

test("global notification claim indexes migration is immutable and forward-registered", () => {
  assert.deepEqual(
    {
      id: chatNotificationGlobalClaimIndexesMigration.id,
      order: chatNotificationGlobalClaimIndexesMigration.order,
    },
    { id: "0026-chat-notification-global-claim-indexes", order: 26 },
  );
  assert.equal(Object.isFrozen(chatNotificationGlobalClaimIndexesMigration), true);
  assert.equal(
    Object.isFrozen(chatNotificationGlobalClaimIndexesMigration.statements),
    true,
  );
  assert.deepEqual(chatNotificationGlobalClaimIndexesMigration.statements, [
    `CREATE INDEX chat_notification_deliveries_global_ready_idx
         ON chat_notification_deliveries (
           next_attempt_at,
           tenant_id,
           source_event_id,
           recipient_host_user_id,
           notification_kind
         )
         INCLUDE (status, attempt_count, last_error_class)
         WHERE status IN ('pending', 'failed')`,
    `CREATE INDEX chat_notification_deliveries_global_expired_lease_idx
         ON chat_notification_deliveries (
           lease_expires_at,
           tenant_id,
           source_event_id,
           recipient_host_user_id,
           notification_kind
         )
         INCLUDE (attempt_count)
         WHERE status = 'leased'`,
  ]);

  const migrationIndex = handrailChatPostgresMigrations.indexOf(
    chatNotificationGlobalClaimIndexesMigration,
  );
  assert.ok(migrationIndex > 0);
  assert.equal(
    handrailChatPostgresMigrations[migrationIndex - 1].order <
      chatNotificationGlobalClaimIndexesMigration.order,
    true,
  );
});

test("notification materializer offsets migration is immutable and forward-registered", () => {
  assert.deepEqual(
    {
      id: chatNotificationMaterializerOffsetsMigration.id,
      order: chatNotificationMaterializerOffsetsMigration.order,
    },
    { id: "0027-chat-notification-materializer-offsets", order: 27 },
  );
  assert.equal(Object.isFrozen(chatNotificationMaterializerOffsetsMigration), true);
  assert.equal(
    Object.isFrozen(chatNotificationMaterializerOffsetsMigration.statements),
    true,
  );
  assert.deepEqual(chatNotificationMaterializerOffsetsMigration.statements, [
    `CREATE TABLE chat_notification_materializer_offsets (
         materializer_name varchar(128) PRIMARY KEY,
         last_replay_position bigint NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_notification_materializer_offsets_name_check CHECK (
           materializer_name ~
             '^[a-z][a-z0-9]*([._-][a-z0-9]+)*:v[1-9][0-9]*$'
         ),
         CONSTRAINT chat_notification_materializer_offsets_position_check CHECK (
           last_replay_position BETWEEN 0 AND 9007199254740991
         ),
         CONSTRAINT chat_notification_materializer_offsets_updated_at_check CHECK (
           isfinite(updated_at)
         )
       )`,
  ]);

  const migrationIndex = handrailChatPostgresMigrations.indexOf(
    chatNotificationMaterializerOffsetsMigration,
  );
  assert.ok(migrationIndex > 0);
  assert.equal(
    handrailChatPostgresMigrations[migrationIndex - 1],
    chatNotificationGlobalClaimIndexesMigration,
  );

  const descriptor = createPostgresMigrationRunner({
    database: {},
    migrations: handrailChatPostgresMigrations,
  }).migrations.find(
    ({ id }) => id === chatNotificationMaterializerOffsetsMigration.id,
  );
  const equivalentDescriptor = createPostgresMigrationRunner({
    database: {},
    migrations: [
      {
        ...chatNotificationMaterializerOffsetsMigration,
        statements: [...chatNotificationMaterializerOffsetsMigration.statements],
      },
    ],
  }).migrations[0];
  assert.equal(
    descriptor.checksum,
    "sha256:1e7d0c6a542f6028d82e477d2d536fc2eb76afaace07003a652d540b90a00986",
  );
  assert.equal(descriptor.checksum, equivalentDescriptor.checksum);
});

test("notification delivery migration enforces content-minimized retry state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "notification_delivery",
  });
  const schema = quoteIdentifier(harness.schema);
  const outbox = `${schema}.chat_outbox_events`;
  const deliveries = `${schema}.chat_notification_deliveries`;
  const materializerOffsets =
    `${schema}.chat_notification_materializer_offsets`;

  const createOutboxEvent = ({
    tenantId = "tenant-a",
    eventId,
    streamId = "conversation-a",
  }) =>
    harness.pool.query(
      `INSERT INTO ${outbox}
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, expires_at)
       VALUES ($1, 1, $2, $3, 'message.created',
               '2030-01-01T00:00:00Z', '{}', '2099-01-01T00:00:00Z')`,
      [eventId, tenantId, streamId],
    );

  const createPending = ({
    tenantId = "tenant-a",
    eventId,
    recipientId = "user-a",
    kind = "message.created",
    adapterReference = null,
    metadata = {},
    createdAt = "2030-01-01T00:00:00Z",
    nextAttemptAt = "2030-01-01T00:00:00Z",
  }) =>
    harness.pool.query(
      `INSERT INTO ${deliveries}
         (tenant_id, source_event_id, recipient_host_user_id,
          notification_kind, adapter_reference, notification_metadata,
          created_at, updated_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       RETURNING *`,
      [
        tenantId,
        eventId,
        recipientId,
        kind,
        adapterReference,
        metadata,
        createdAt,
        nextAttemptAt,
      ],
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

    await t.test("stores one bounded offset per canonical materializer", async () => {
      const columns = (
        await harness.pool.query(
          `SELECT column_name, data_type, udt_name, is_nullable,
                  character_maximum_length, column_default
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'chat_notification_materializer_offsets'
           ORDER BY ordinal_position`,
          [harness.schema],
        )
      ).rows;
      assert.deepEqual(columns, [
        {
          column_name: "materializer_name",
          data_type: "character varying",
          udt_name: "varchar",
          is_nullable: "NO",
          character_maximum_length: 128,
          column_default: null,
        },
        {
          column_name: "last_replay_position",
          data_type: "bigint",
          udt_name: "int8",
          is_nullable: "NO",
          character_maximum_length: null,
          column_default: null,
        },
        {
          column_name: "updated_at",
          data_type: "timestamp with time zone",
          udt_name: "timestamptz",
          is_nullable: "NO",
          character_maximum_length: null,
          column_default: "clock_timestamp()",
        },
      ]);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count FROM ${materializerOffsets}`,
          )
        ).rows[0]?.count,
        0,
      );

      await harness.pool.query(
        `INSERT INTO ${materializerOffsets}
           (materializer_name, last_replay_position, updated_at)
         VALUES
           ('message-created-deliveries:v1', 0, '2030-01-01T00:00:00Z'),
           ('message-created-deliveries:v2', 9007199254740991,
            '2030-01-01T00:00:01Z')`,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${materializerOffsets}
             (materializer_name, last_replay_position)
           VALUES ('message-created-deliveries:v1', 1)`,
        ),
        (error) =>
          error?.constraint === "chat_notification_materializer_offsets_pkey",
      );

      for (const [name, position] of [
        ["message-created-negative:v1", "-1"],
        ["message-created-unsafe:v1", "9007199254740992"],
      ]) {
        await assert.rejects(
          harness.pool.query(
            `INSERT INTO ${materializerOffsets}
               (materializer_name, last_replay_position)
             VALUES ($1, $2)`,
            [name, position],
          ),
          (error) =>
            error?.constraint ===
            "chat_notification_materializer_offsets_position_check",
        );
      }

      for (const name of [
        "",
        "Message-created-deliveries:v1",
        "message created deliveries:v1",
        "message-created-deliveries",
        "message-created-deliveries:v0",
        "message-created-deliveries:v01",
      ]) {
        await assert.rejects(
          harness.pool.query(
            `INSERT INTO ${materializerOffsets}
               (materializer_name, last_replay_position)
             VALUES ($1, 1)`,
            [name],
          ),
          (error) =>
            error?.constraint ===
            "chat_notification_materializer_offsets_name_check",
        );
      }
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${materializerOffsets}
             (materializer_name, last_replay_position)
           VALUES ($1, 1)`,
          [`materializer-${"x".repeat(120)}:v1`],
        ),
        (error) => error?.code === "22001",
      );

      for (const timestamp of ["infinity", "-infinity"]) {
        await assert.rejects(
          harness.pool.query(
            `INSERT INTO ${materializerOffsets}
               (materializer_name, last_replay_position, updated_at)
             VALUES ('message-created-nonfinite:v1', 1, $1)`,
            [timestamp],
          ),
          (error) =>
            error?.constraint ===
            "chat_notification_materializer_offsets_updated_at_check",
        );
      }

      await Promise.all(
        [1, 2, 3, 4].map((position) =>
          harness.pool.query(
            `INSERT INTO ${materializerOffsets} AS offset
               (materializer_name, last_replay_position, updated_at)
             VALUES ('message-created-deliveries:v3', $1, $2)
             ON CONFLICT (materializer_name) DO UPDATE
             SET last_replay_position = GREATEST(
                   offset.last_replay_position,
                   EXCLUDED.last_replay_position
                 ),
                 updated_at = GREATEST(
                   offset.updated_at,
                   EXCLUDED.updated_at
                 )`,
            [position, `2030-01-01T00:00:0${position}Z`],
          ),
        ),
      );
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT materializer_name, last_replay_position,
                    updated_at, count(*) OVER ()::integer AS row_count
             FROM ${materializerOffsets}
             WHERE materializer_name = 'message-created-deliveries:v3'`,
          )
        ).rows.map((row) => ({
          ...row,
          updated_at: row.updated_at.toISOString(),
        })),
        [
          {
            materializer_name: "message-created-deliveries:v3",
            last_replay_position: "4",
            updated_at: "2030-01-01T00:00:04.000Z",
            row_count: 1,
          },
        ],
      );
    });

    await Promise.all([
      createOutboxEvent({ eventId: "event-identity" }),
      createOutboxEvent({ eventId: "event-lifecycle" }),
      createOutboxEvent({ eventId: "event-expired" }),
      createOutboxEvent({ eventId: "event-active" }),
      createOutboxEvent({
        tenantId: "tenant-b",
        eventId: "event-tenant-b",
        streamId: "conversation-b",
      }),
    ]);

    await t.test("keys each recipient intent once and links the tenant-safe source", async () => {
      const stored = (
        await createPending({
          eventId: "event-identity",
          adapterReference: "opaque-host-reference-1",
          metadata: {
            conversationId: "conversation-a",
            urgency: "normal",
            silent: false,
          },
        })
      ).rows[0];
      assert.deepEqual(
        {
          status: stored.status,
          attempts: Number(stored.attempt_count),
          adapterReference: stored.adapter_reference,
          metadata: stored.notification_metadata,
        },
        {
          status: "pending",
          attempts: 0,
          adapterReference: "opaque-host-reference-1",
          metadata: {
            conversationId: "conversation-a",
            urgency: "normal",
            silent: false,
          },
        },
      );

      await assert.rejects(
        createPending({ eventId: "event-identity" }),
        /chat_notification_deliveries_pkey/,
      );
      await createPending({
        eventId: "event-identity",
        recipientId: "user-b",
      });
      await createPending({
        eventId: "event-identity",
        recipientId: "user-a",
        kind: "message.mention",
      });
      await assert.rejects(
        createPending({
          tenantId: "tenant-b",
          eventId: "event-identity",
          recipientId: "user-b",
        }),
        /chat_notification_deliveries_source_event_fkey/,
      );
    });

    await t.test("rejects unsafe or unbounded notification metadata", async () => {
      for (const [index, [eventId, metadata]] of [
        ["event-lifecycle", { content: "full message" }],
        ["event-lifecycle", { providerPayload: "opaque-ish" }],
        ["event-lifecycle", { access_token: "secret" }],
        ["event-lifecycle", { safe: { nested: "object" } }],
        ["event-lifecycle", { safe: "x".repeat(513) }],
      ].entries()) {
        await assert.rejects(
          createPending({ eventId, recipientId: `unsafe-${index}`, metadata }),
          /chat_notification_deliveries_metadata_check/,
        );
      }
    });

    await t.test("supports failed-attempt retry and a terminal delivery", async () => {
      await createPending({
        eventId: "event-lifecycle",
        recipientId: "retry-user",
      });

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'delivered', delivered_at = '2030-01-01T00:00:01Z',
               updated_at = '2030-01-01T00:00:01Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'retry-user'`,
        ),
        (error) =>
          error?.constraint ===
          "chat_notification_deliveries_transition_check",
      );

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'leased', attempt_count = 2,
               lease_token = 'worker-invalid',
               lease_acquired_at = '2030-01-01T00:00:01Z',
               lease_expires_at = '2030-01-01T00:05:01Z',
               updated_at = '2030-01-01T00:00:01Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'retry-user'`,
        ),
        (error) =>
          error?.constraint ===
          "chat_notification_deliveries_attempt_transition_check",
      );

      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'leased', attempt_count = 1,
             lease_token = 'worker-first',
             lease_acquired_at = '2030-01-01T00:00:01Z',
             lease_expires_at = '2030-01-01T00:05:01Z',
             updated_at = '2030-01-01T00:00:01Z'
         WHERE tenant_id = 'tenant-a'
           AND source_event_id = 'event-lifecycle'
           AND recipient_host_user_id = 'retry-user'`,
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'failed', lease_token = NULL,
             lease_acquired_at = NULL, lease_expires_at = NULL,
             last_error_class = 'transient',
             last_error_at = '2030-01-01T00:01:00Z',
             next_attempt_at = '2030-01-01T00:10:00Z',
             updated_at = '2030-01-01T00:01:00Z'
         WHERE tenant_id = 'tenant-a'
           AND source_event_id = 'event-lifecycle'
           AND recipient_host_user_id = 'retry-user'`,
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'leased', attempt_count = 2,
             lease_token = 'worker-retry',
             lease_acquired_at = '2030-01-01T00:10:00Z',
             lease_expires_at = '2030-01-01T00:15:00Z',
             last_error_class = NULL, last_error_at = NULL,
             updated_at = '2030-01-01T00:10:00Z'
         WHERE tenant_id = 'tenant-a'
           AND source_event_id = 'event-lifecycle'
           AND recipient_host_user_id = 'retry-user'`,
      );
      const delivered = (
        await harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'delivered', lease_token = NULL,
               lease_acquired_at = NULL, lease_expires_at = NULL,
               delivered_at = '2030-01-01T00:11:00Z',
               updated_at = '2030-01-01T00:11:00Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'retry-user'
           RETURNING status, attempt_count, delivered_at`,
        )
      ).rows[0];
      assert.deepEqual(
        {
          status: delivered.status,
          attempts: Number(delivered.attempt_count),
          deliveredAt: delivered.delivered_at.toISOString(),
        },
        {
          status: "delivered",
          attempts: 2,
          deliveredAt: "2030-01-01T00:11:00.000Z",
        },
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET next_attempt_at = '2030-01-01T00:12:00Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'retry-user'`,
        ),
        /delivered chat_notification_deliveries are immutable/,
      );
    });

    await t.test("reclaims expired leases but rejects active lease theft", async () => {
      await createPending({
        eventId: "event-expired",
        createdAt: "2020-01-01T00:00:00Z",
        nextAttemptAt: "2020-01-01T00:00:00Z",
      });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'leased', attempt_count = 1,
             lease_token = 'worker-expired',
             lease_acquired_at = '2020-01-01T00:00:01Z',
             lease_expires_at = '2020-01-01T00:05:01Z',
             updated_at = '2020-01-01T00:00:01Z'
         WHERE tenant_id = 'tenant-a'
           AND source_event_id = 'event-expired'
           AND recipient_host_user_id = 'user-a'`,
      );
      const reclaimed = (
        await harness.pool.query(
          `UPDATE ${deliveries}
           SET attempt_count = 2, lease_token = 'worker-reclaimer',
               lease_acquired_at = '2020-01-01T00:05:01Z',
               lease_expires_at = '2099-01-01T00:00:00Z',
               updated_at = '2020-01-01T00:05:01Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-expired'
             AND recipient_host_user_id = 'user-a'
           RETURNING status, attempt_count, lease_token`,
        )
      ).rows[0];
      assert.deepEqual(reclaimed, {
        status: "leased",
        attempt_count: "2",
        lease_token: "worker-reclaimer",
      });

      await createPending({ eventId: "event-active" });
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'leased', attempt_count = 1,
             lease_token = 'worker-active',
             lease_acquired_at = '2030-01-01T00:00:01Z',
             lease_expires_at = '2099-01-01T00:00:00Z',
             updated_at = '2030-01-01T00:00:01Z'
         WHERE tenant_id = 'tenant-a'
           AND source_event_id = 'event-active'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET attempt_count = 2, lease_token = 'worker-thief',
               lease_acquired_at = '2030-01-01T00:01:00Z',
               lease_expires_at = '2099-01-01T00:01:00Z',
               updated_at = '2030-01-01T00:01:00Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-active'`,
        ),
        (error) =>
          error?.constraint === "chat_notification_deliveries_reclaim_check",
      );
    });

    await t.test("enforces timestamp, lease, error, and immutable source shapes", async () => {
      await assert.rejects(
        createPending({
          eventId: "event-lifecycle",
          recipientId: "bad-time",
          createdAt: "2030-01-02T00:00:00Z",
          nextAttemptAt: "2030-01-01T00:00:00Z",
        }),
        /chat_notification_deliveries_timestamp_order_check/,
      );
      await createPending({
        eventId: "event-lifecycle",
        recipientId: "bad-shape",
      });
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'leased', attempt_count = 1,
               lease_token = 'worker',
               lease_acquired_at = '2030-01-01T00:01:00Z',
               lease_expires_at = '2030-01-01T00:00:59Z',
               updated_at = '2030-01-01T00:01:00Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'bad-shape'`,
        ),
        /chat_notification_deliveries_timestamp_order_check/,
      );
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'leased', attempt_count = 1,
             lease_token = 'worker-shape',
             lease_acquired_at = '2030-01-01T00:01:00Z',
             lease_expires_at = '2030-01-01T00:05:00Z',
             updated_at = '2030-01-01T00:01:00Z'
         WHERE tenant_id = 'tenant-a'
           AND source_event_id = 'event-lifecycle'
           AND recipient_host_user_id = 'bad-shape'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'failed', lease_token = NULL,
               lease_acquired_at = NULL, lease_expires_at = NULL,
               last_error_class = 'provider_secret',
               last_error_at = '2030-01-01T00:02:00Z',
               next_attempt_at = '2030-01-01T00:03:00Z',
               updated_at = '2030-01-01T00:02:00Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'bad-shape'`,
        ),
        /chat_notification_deliveries_error_class_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'failed', lease_token = NULL,
               lease_acquired_at = NULL, lease_expires_at = NULL,
               last_error_class = 'transient',
               last_error_at = '2030-01-01T00:04:00Z',
               next_attempt_at = '2030-01-01T00:05:00Z',
               updated_at = '2030-01-01T00:03:00Z'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'bad-shape'`,
        ),
        /chat_notification_deliveries_timestamp_order_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${deliveries}
           SET notification_kind = 'message.mention'
           WHERE tenant_id = 'tenant-a'
             AND source_event_id = 'event-lifecycle'
             AND recipient_host_user_id = 'bad-shape'`,
        ),
        /identity and source metadata are immutable/,
      );
    });

    await t.test("uses ready and expired-lease worker indexes", async () => {
      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${deliveries}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");
        const readyPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT source_event_id, recipient_host_user_id, notification_kind
           FROM ${deliveries}
           WHERE tenant_id = 'tenant-a'
             AND status IN ('pending', 'failed')
             AND next_attempt_at <= '2099-01-01T00:00:00Z'
           ORDER BY next_attempt_at, source_event_id,
                    recipient_host_user_id, notification_kind`,
        );
        const expiredPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT source_event_id, recipient_host_user_id, notification_kind
           FROM ${deliveries}
           WHERE tenant_id = 'tenant-a'
             AND status = 'leased'
             AND lease_expires_at <= '2099-01-01T00:00:00Z'
           ORDER BY lease_expires_at, source_event_id,
                    recipient_host_user_id, notification_kind`,
        );

        assert.ok(
          findIndexes(readyPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_notification_deliveries_ready_idx",
          ),
        );
        assert.ok(
          findIndexes(expiredPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_notification_deliveries_expired_lease_idx",
          ),
        );
      } finally {
        await client.query("RESET enable_bitmapscan").catch(() => undefined);
        await client.query("RESET enable_seqscan").catch(() => undefined);
        client.release();
      }
    });

    await t.test("uses global claim indexes and preserves deterministic candidates", async () => {
      const client = await harness.pool.connect();
      try {
        await client.query(
          `INSERT INTO ${outbox}
             (event_id, protocol_version, tenant_id, stream_id, type,
              occurred_at, payload, expires_at)
           SELECT
             'global-claim-' || candidate.ordinal,
             1,
             CASE
               WHEN candidate.ordinal IN (10001, 10002) THEN 'tenant-a'
               WHEN candidate.ordinal = 10003 THEN 'tenant-b'
               ELSE 'tenant-' || lpad((candidate.ordinal % 32)::text, 2, '0')
             END,
             'global-conversation-' || (candidate.ordinal % 32),
             'message.created',
             TIMESTAMPTZ '2020-01-01T00:00:00Z',
             '{}'::jsonb,
             TIMESTAMPTZ '2099-12-31T00:00:00Z'
           FROM generate_series(1, 10003) AS candidate(ordinal)`,
        );
        await client.query(
          `INSERT INTO ${deliveries}
             (tenant_id, source_event_id, recipient_host_user_id,
              notification_kind, next_attempt_at, created_at, updated_at)
           SELECT
             event.tenant_id,
             event.event_id,
             'global-recipient',
             'message.created',
             CASE
               WHEN candidate.ordinal IN (10001, 10002)
                 THEN TIMESTAMPTZ '2023-01-01T00:00:00Z'
               WHEN candidate.ordinal BETWEEN 8501 AND 8700
                 THEN TIMESTAMPTZ '2025-01-01T00:00:00Z'
                   + (candidate.ordinal - 8501) * interval '1 second'
               WHEN candidate.ordinal BETWEEN 6001 AND 7500
                 THEN TIMESTAMPTZ '2099-01-01T00:00:00Z'
               ELSE TIMESTAMPTZ '2020-01-01T00:00:00Z'
             END,
             TIMESTAMPTZ '2020-01-01T00:00:00Z',
             TIMESTAMPTZ '2020-01-01T00:00:00Z'
           FROM generate_series(1, 10003) AS candidate(ordinal)
           JOIN ${outbox} AS event
             ON event.event_id = 'global-claim-' || candidate.ordinal
            AND event.tenant_id = CASE
              WHEN candidate.ordinal IN (10001, 10002) THEN 'tenant-a'
              WHEN candidate.ordinal = 10003 THEN 'tenant-b'
              ELSE 'tenant-' || lpad((candidate.ordinal % 32)::text, 2, '0')
            END`,
        );
        await client.query(
          `UPDATE ${deliveries} AS delivery
           SET status = 'leased',
               attempt_count = 1,
               lease_token = 'global-seed-lease',
               lease_acquired_at = CASE
                 WHEN ordinal.value BETWEEN 9101 AND 9800
                   THEN TIMESTAMPTZ '2026-01-01T00:00:00Z'
                 WHEN ordinal.value BETWEEN 9801 AND 10000
                   OR ordinal.value = 10003
                   THEN TIMESTAMPTZ '2022-01-01T00:00:00Z'
                 ELSE TIMESTAMPTZ '2020-01-02T00:00:00Z'
               END,
               lease_expires_at = CASE
                 WHEN ordinal.value BETWEEN 9101 AND 9800
                   THEN TIMESTAMPTZ '2099-01-01T00:00:00Z'
                 WHEN ordinal.value = 10003
                   THEN TIMESTAMPTZ '2023-01-01T00:00:00Z'
                 WHEN ordinal.value BETWEEN 9801 AND 10000
                   THEN TIMESTAMPTZ '2024-01-01T00:00:00Z'
                     + (ordinal.value - 9801) * interval '1 second'
                 ELSE TIMESTAMPTZ '2020-01-03T00:00:00Z'
               END,
               updated_at = CASE
                 WHEN ordinal.value BETWEEN 9101 AND 9800
                   THEN TIMESTAMPTZ '2026-01-01T00:00:00Z'
                 WHEN ordinal.value BETWEEN 9801 AND 10000
                   OR ordinal.value = 10003
                   THEN TIMESTAMPTZ '2022-01-01T00:00:00Z'
                 ELSE TIMESTAMPTZ '2020-01-02T00:00:00Z'
               END
           FROM generate_series(1, 10003) AS ordinal(value)
           WHERE delivery.source_event_id = 'global-claim-' || ordinal.value
             AND (
               ordinal.value <= 6000
               OR ordinal.value BETWEEN 7501 AND 8500
               OR ordinal.value BETWEEN 8701 AND 10001
               OR ordinal.value = 10003
             )`,
        );
        await client.query(
          `UPDATE ${deliveries}
           SET status = 'delivered',
               lease_token = NULL,
               lease_acquired_at = NULL,
               lease_expires_at = NULL,
               delivered_at = TIMESTAMPTZ '2020-01-04T00:00:00Z',
               updated_at = TIMESTAMPTZ '2020-01-04T00:00:00Z'
           WHERE source_event_id LIKE 'global-claim-%'
             AND substring(source_event_id FROM '[0-9]+$')::integer <= 6000`,
        );
        await client.query(
          `UPDATE ${deliveries}
           SET status = 'failed',
               lease_token = NULL,
               lease_acquired_at = NULL,
               lease_expires_at = NULL,
               last_error_class = CASE
                 WHEN substring(source_event_id FROM '[0-9]+$')::integer
                        BETWEEN 8901 AND 9100
                   THEN 'rejected'
                 ELSE 'transient'
               END,
               last_error_at = TIMESTAMPTZ '2020-01-03T00:00:00Z',
               next_attempt_at = CASE
                 WHEN substring(source_event_id FROM '[0-9]+$')::integer = 10001
                   THEN TIMESTAMPTZ '2023-01-01T00:00:00Z'
                 WHEN substring(source_event_id FROM '[0-9]+$')::integer
                        BETWEEN 7501 AND 8500
                   THEN TIMESTAMPTZ '2099-01-01T00:00:00Z'
                 WHEN substring(source_event_id FROM '[0-9]+$')::integer
                        BETWEEN 8701 AND 8900
                   THEN TIMESTAMPTZ '2025-02-01T00:00:00Z'
                     + (substring(source_event_id FROM '[0-9]+$')::integer - 8701)
                       * interval '1 second'
                 ELSE TIMESTAMPTZ '2025-03-01T00:00:00Z'
               END,
               updated_at = TIMESTAMPTZ '2020-01-03T00:00:00Z'
           WHERE source_event_id LIKE 'global-claim-%'
             AND (
               substring(source_event_id FROM '[0-9]+$')::integer
                 BETWEEN 7501 AND 8500
               OR substring(source_event_id FROM '[0-9]+$')::integer
                 BETWEEN 8701 AND 9100
               OR substring(source_event_id FROM '[0-9]+$')::integer = 10001
             )`,
        );

        await client.query(`ANALYZE ${deliveries}`);
        assert.equal((await client.query("SHOW enable_seqscan")).rows[0].enable_seqscan, "on");

        const readyPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           WITH moment AS (SELECT clock_timestamp() AS at)
           SELECT candidate.source_event_id
           FROM ${deliveries} AS candidate
           CROSS JOIN moment
           WHERE candidate.attempt_count < 5
             AND candidate.status IN ('pending', 'failed')
             AND candidate.next_attempt_at <= moment.at
             AND (
               candidate.status = 'pending'
               OR candidate.last_error_class IN (
                 'transient', 'rate_limited', 'unknown'
               )
             )
           ORDER BY candidate.next_attempt_at, candidate.tenant_id,
                    candidate.source_event_id,
                    candidate.recipient_host_user_id,
                    candidate.notification_kind
           FOR UPDATE OF candidate SKIP LOCKED
           LIMIT 50`,
        );
        const expiredPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           WITH moment AS (SELECT clock_timestamp() AS at)
           SELECT candidate.source_event_id
           FROM ${deliveries} AS candidate
           CROSS JOIN moment
           WHERE candidate.attempt_count < 5
             AND candidate.status = 'leased'
             AND candidate.lease_expires_at <= moment.at
           ORDER BY candidate.lease_expires_at, candidate.tenant_id,
                    candidate.source_event_id,
                    candidate.recipient_host_user_id,
                    candidate.notification_kind
           FOR UPDATE OF candidate SKIP LOCKED
           LIMIT 50`,
        );
        const combinedPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           WITH moment AS (SELECT clock_timestamp() AS at)
           SELECT candidate.source_event_id
           FROM ${deliveries} AS candidate
           CROSS JOIN moment
           WHERE candidate.attempt_count < 5
             AND (
               (
                 candidate.status IN ('pending', 'failed')
                 AND candidate.next_attempt_at <= moment.at
                 AND (
                   candidate.status = 'pending'
                   OR candidate.last_error_class IN (
                     'transient', 'rate_limited', 'unknown'
                   )
                 )
               )
               OR (
                 candidate.status = 'leased'
                 AND candidate.lease_expires_at <= moment.at
               )
             )
           ORDER BY COALESCE(candidate.lease_expires_at, candidate.next_attempt_at),
                    candidate.tenant_id, candidate.source_event_id,
                    candidate.recipient_host_user_id,
                    candidate.notification_kind
           FOR UPDATE OF candidate SKIP LOCKED
           LIMIT 50`,
        );

        assert.ok(
          findIndexes(readyPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_notification_deliveries_global_ready_idx",
          ),
        );
        assert.ok(
          findIndexes(expiredPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_notification_deliveries_global_expired_lease_idx",
          ),
        );
        assert.deepEqual(
          new Set(findIndexes(combinedPlan.rows[0]?.["QUERY PLAN"])),
          new Set([
            "chat_notification_deliveries_global_ready_idx",
            "chat_notification_deliveries_global_expired_lease_idx",
          ]),
        );

        const candidates = await client.query(
          `WITH moment AS (SELECT clock_timestamp() AS at)
           SELECT candidate.tenant_id, candidate.source_event_id
           FROM ${deliveries} AS candidate
           CROSS JOIN moment
           WHERE candidate.attempt_count < 5
             AND (
               (
                 candidate.status IN ('pending', 'failed')
                 AND candidate.next_attempt_at <= moment.at
                 AND (
                   candidate.status = 'pending'
                   OR candidate.last_error_class IN (
                     'transient', 'rate_limited', 'unknown'
                   )
                 )
               )
               OR (
                 candidate.status = 'leased'
                 AND candidate.lease_expires_at <= moment.at
               )
             )
           ORDER BY COALESCE(candidate.lease_expires_at, candidate.next_attempt_at),
                    candidate.tenant_id, candidate.source_event_id,
                    candidate.recipient_host_user_id,
                    candidate.notification_kind
           LIMIT 3`,
        );
        assert.deepEqual(candidates.rows, [
          { tenant_id: "tenant-a", source_event_id: "global-claim-10001" },
          { tenant_id: "tenant-a", source_event_id: "global-claim-10002" },
          { tenant_id: "tenant-b", source_event_id: "global-claim-10003" },
        ]);
      } finally {
        client.release();
      }
    });

    await t.test("catalog exposes no secret, content, or provider-payload columns", async () => {
      const columns = (
        await harness.pool.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1
             AND table_name = 'chat_notification_deliveries'
           ORDER BY ordinal_position`,
          [harness.schema],
        )
      ).rows.map(({ column_name }) => column_name);
      assert.deepEqual(
        columns.filter(
          (column) =>
            column !== "lease_token" &&
            /(credential|token|secret|authorization|body|content|payload|provider)/i.test(
              column,
            ),
        ),
        [],
      );
      assert.equal(columns.includes("lease_token"), true);
      assert.equal(columns.includes("notification_metadata"), true);
      assert.equal(columns.includes("adapter_reference"), true);
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
