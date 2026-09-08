import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  createChatNotificationDispatcher,
  createChatServer,
  createExpiredOutboxEventMaintenanceJob,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";
import { WebSocket } from "ws";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

test("expired reminder retention settles current revisions atomically on PostgreSQL", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "reminder_retention" });
    const prefix = quoteIdentifier(harness.schema);
    const reminders = `${prefix}.chat_message_reminders`;
    const outbox = `${prefix}.chat_outbox_events`;
    const deliveries = `${prefix}.chat_notification_deliveries`;
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${prefix}.chat_conversations
         (tenant_id, id, type, visibility, name)
       VALUES ('tenant-a', 'reminder-stream', 'channel', 'public', 'Reminders')`,
    );
    await harness.pool.query(
      `INSERT INTO ${prefix}.chat_messages
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES ('tenant-a', 'reminder-message', 'reminder-stream', 1, 'author-a',
               'reminder-client', '{"format":"plain","text":"Remember"}')`,
    );

    // One message can have independent reminders for different recipients.
    const insertReminder = async (id, revision = 1, liveLease = false) => {
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, published_at, expires_at)
         VALUES ($1, $2, 'tenant-a', 'reminder-stream', 'message.reminder',
                 '2019-01-02T00:00:00Z', $3::jsonb,
                 '2019-01-02T00:00:00Z', '2020-01-01T00:00:00Z')`,
        [id, CHAT_PROTOCOL_VERSION, {
          message: { id: "reminder-message", author: { userId: id }, sequence: 1 },
          reminder: { userId: id, revision: 1, dueAt: "2019-01-02T00:00:00Z" },
        }],
      );
      await harness.pool.query(
        `INSERT INTO ${reminders}
           (tenant_id, user_id, message_id, conversation_id, remind_at,
            reminder_revision, created_at, updated_at, materialized_revision,
            materialized_at, materialized_source_event_id)
         VALUES ('tenant-a', $1, 'reminder-message', 'reminder-stream',
                 '2019-01-02T00:00:00Z', $2, '2019-01-01T00:00:00Z',
                 '2019-01-02T00:00:00Z', 1, '2019-01-02T00:00:00Z', $1)`,
        [id, revision],
      );
      await harness.pool.query(
        `INSERT INTO ${deliveries}
           (tenant_id, source_event_id, recipient_host_user_id,
            notification_kind, created_at, updated_at, next_attempt_at)
         VALUES ('tenant-a', $1, $1, 'message.reminder',
                 '2019-01-02T00:00:00Z', '2019-01-02T00:00:00Z',
                 '2019-01-02T00:00:00Z')`,
        [id],
      );
      if (liveLease) {
        await harness.pool.query(
          `UPDATE ${deliveries}
           SET status = 'leased', attempt_count = 1, lease_token = $1,
               lease_acquired_at = '2019-01-02T00:00:00Z',
               lease_expires_at = '2099-01-01T00:00:00Z'
           WHERE source_event_id = $1`,
          [id],
        );
      }
    };
    const snapshot = async (id) => ({
      reminder: (await harness.pool.query(
        `SELECT * FROM ${reminders} WHERE user_id = $1`, [id],
      )).rows[0],
      events: (await harness.pool.query(
        `SELECT * FROM ${outbox} WHERE event_id = $1`, [id],
      )).rows,
      deliveries: (await harness.pool.query(
        `SELECT * FROM ${deliveries} WHERE source_event_id = $1`, [id],
      )).rows,
    });
    const cleanup = createExpiredOutboxEventMaintenanceJob({
      database: harness.pool, schema: harness.schema, batchSize: 100,
    });
    const assertSettled = (before, after) => {
      assert.deepEqual(after.events, []);
      assert.deepEqual(after.deliveries, []);
      assert.ok(after.reminder.cancelled_at instanceof Date);
      assert.ok(after.reminder.updated_at >= before.reminder.updated_at);
      assert.deepEqual(after.reminder, {
        ...before.reminder,
        status: "cancelled",
        reminder_revision: String(Number(before.reminder.reminder_revision) + 1),
        cancelled_at: after.reminder.updated_at,
        updated_at: after.reminder.updated_at,
      });
    };

    await t.test("settles once and preserves newer revisions and live leases", async () => {
      await insertReminder("matching");
      await insertReminder("rescheduled", 2);
      await insertReminder("live-lease", 1, true);
      const matchingBefore = await snapshot("matching");
      const newerBefore = await snapshot("rescheduled");
      const leasedBefore = await snapshot("live-lease");
      const result = await cleanup();
      assert.equal(result.deletedCount, 2);
      assert.equal(result.deletedDeliveryCount, 2);
      assert.deepEqual(result.deleted.map(({ eventId }) => eventId).sort(),
        ["matching", "rescheduled"]);
      const matchingAfter = await snapshot("matching");
      assertSettled(matchingBefore, matchingAfter);
      const newerAfter = await snapshot("rescheduled");
      assert.deepEqual(newerAfter, {
        reminder: newerBefore.reminder, events: [], deliveries: [],
      });
      assert.deepEqual(await snapshot("live-lease"), leasedBefore);

      assert.deepEqual(await cleanup(), {
        deletedCount: 0, deletedDeliveryCount: 0, deleted: [],
      });
      assert.deepEqual(await snapshot("matching"), matchingAfter);
      assert.deepEqual(await snapshot("rescheduled"), newerAfter);
      assert.deepEqual(await snapshot("live-lease"), leasedBefore);
    });

    await t.test("settlement SQL failure rolls back and cleanup can recover", async () => {
      await insertReminder("rollback");
      const before = await snapshot("rollback");
      // A deferred trigger fails at COMMIT, after settlement and both deletes.
      await harness.pool.query(
        `CREATE FUNCTION ${prefix}.fail_retention_settlement() RETURNS trigger
         LANGUAGE plpgsql AS $function$
         BEGIN
           RAISE EXCEPTION 'injected reminder retention settlement failure';
         END;
         $function$`,
      );
      await harness.pool.query(
        `CREATE CONSTRAINT TRIGGER fail_retention_settlement
         AFTER UPDATE ON ${reminders} DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW WHEN (NEW.user_id = 'rollback' AND NEW.status = 'cancelled')
         EXECUTE FUNCTION ${prefix}.fail_retention_settlement()`,
      );
      try {
        await assert.rejects(cleanup(), {
          code: "P0001", message: "injected reminder retention settlement failure",
        });
        assert.deepEqual(await snapshot("rollback"), before);
      } finally {
        await harness.pool.query(`DROP TRIGGER fail_retention_settlement ON ${reminders}`);
        await harness.pool.query(`DROP FUNCTION ${prefix}.fail_retention_settlement()`);
      }
      const result = await cleanup();
      assert.equal(result.deletedCount, 1);
      assert.equal(result.deletedDeliveryCount, 1);
      assert.equal(result.deleted[0].eventId, "rollback");
      assertSettled(before, await snapshot("rollback"));
    });
  } finally {
    try {
      await harness?.teardown();
    } finally {
      await backend.teardown();
    }
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

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
          () => reject(new Error("retention operation exceeded deadline")),
          milliseconds,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const waitUntil = async (predicate, milliseconds = 5_000) => {
  const deadline = Date.now() + milliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("retention condition exceeded deadline");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const connectForReplay = async (url, eventId) => {
  const socket = new WebSocket(url, {
    headers: { authorization: "Bearer retention-actor" },
  });
  const message = new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())));
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => {
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      clientPackageVersion: "0.1.21",
      protocolVersion: CHAT_PROTOCOL_VERSION,
      resumeFrom: { eventId },
    }),
  );
  return { socket, message, closed };
};

test("expired outbox retention is bounded and lease-safe on PostgreSQL", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "outbox_retention",
  });
  const prefix = quoteIdentifier(harness.schema);
  const outbox = `${prefix}.chat_outbox_events`;
  const deliveries = `${prefix}.chat_notification_deliveries`;
  const pushTokens = `${prefix}.chat_device_push_tokens`;
  const dispatchers = new Set();
  const servers = new Set();
  let eventOrdinal = 0;

  const insertEvent = async ({
    eventId = `retention-event-${++eventOrdinal}`,
    expiresAt = "2020-01-01T00:00:00Z",
    occurredAt = "2019-01-01T00:00:00Z",
    streamId = "retention-stream",
    payload,
  } = {}) => {
    const storedPayload = payload ?? {
      message: {
        id: `message-${eventId}`,
        author: { userId: "actor-a" },
        sequence: 1,
      },
    };
    const result = await harness.pool.query(
      `INSERT INTO ${outbox} (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, published_at, expires_at
       ) VALUES (
         $1, $2, 'tenant-a', $6, 'message.created',
         $3, $4::jsonb, clock_timestamp(), $5
       )
       RETURNING replay_position`,
      [eventId, CHAT_PROTOCOL_VERSION, occurredAt, storedPayload, expiresAt, streamId],
    );
    return {
      eventId,
      replayPosition: Number(result.rows[0].replay_position),
    };
  };

  const insertDelivery = async (eventId, recipient = `recipient-${eventId}`) => {
    await harness.pool.query(
      `INSERT INTO ${deliveries} (
         tenant_id, source_event_id, recipient_host_user_id,
         notification_kind, created_at, updated_at, next_attempt_at
       ) VALUES (
         'tenant-a', $1, $2, 'message.created',
         '2019-01-01T00:00:00Z', '2019-01-01T00:00:00Z',
         '2019-01-01T00:00:00Z'
       )`,
      [eventId, recipient],
    );
  };

  const leaseDelivery = async (
    eventId,
    acquiredAt,
    expiresAt,
    leaseToken = `lease-${eventId}`,
  ) => {
    await harness.pool.query(
      `UPDATE ${deliveries}
       SET status = 'leased', attempt_count = attempt_count + 1,
           lease_token = $2, lease_acquired_at = $3,
           lease_expires_at = $4, updated_at = $3
       WHERE tenant_id = 'tenant-a' AND source_event_id = $1`,
      [eventId, leaseToken, acquiredAt, expiresAt],
    );
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    const delivered = await insertEvent({ eventId: "expired-delivered" });
    const pending = await insertEvent({ eventId: "expired-pending" });
    const failed = await insertEvent({ eventId: "expired-failed" });
    const expiredLease = await insertEvent({ eventId: "expired-lease" });
    const cursor = await insertEvent({ eventId: "deleted-replay-cursor" });
    const live = await insertEvent({
      eventId: "unexpired-event",
      expiresAt: "2099-01-01T00:00:00Z",
      occurredAt: "2026-01-01T00:00:00Z",
    });

    for (const event of [delivered, pending, failed, expiredLease]) {
      await insertDelivery(event.eventId);
    }
    await leaseDelivery(
      delivered.eventId,
      "2019-01-02T00:00:00Z",
      "2019-01-03T00:00:00Z",
    );
    await harness.pool.query(
      `UPDATE ${deliveries}
       SET status = 'delivered', lease_token = NULL,
           lease_acquired_at = NULL, lease_expires_at = NULL,
           delivered_at = '2019-01-04T00:00:00Z',
           updated_at = '2019-01-04T00:00:00Z'
       WHERE tenant_id = 'tenant-a' AND source_event_id = $1`,
      [delivered.eventId],
    );
    await leaseDelivery(
      failed.eventId,
      "2019-01-02T00:00:00Z",
      "2019-01-03T00:00:00Z",
    );
    await harness.pool.query(
      `UPDATE ${deliveries}
       SET status = 'failed', lease_token = NULL,
           lease_acquired_at = NULL, lease_expires_at = NULL,
           last_error_class = 'transient',
           last_error_at = '2019-01-04T00:00:00Z',
           next_attempt_at = '2019-01-04T00:00:00Z',
           updated_at = '2019-01-04T00:00:00Z'
       WHERE tenant_id = 'tenant-a' AND source_event_id = $1`,
      [failed.eventId],
    );
    await leaseDelivery(
      expiredLease.eventId,
      "2019-01-02T00:00:00Z",
      "2019-01-03T00:00:00Z",
    );

    const cleanup = createExpiredOutboxEventMaintenanceJob({
      database: harness.pool,
      schema: harness.schema,
      batchSize: 20,
    });
    const terminalCleanup = await cleanup();
    assert.equal(terminalCleanup.deletedCount, 5);
    assert.equal(terminalCleanup.deletedDeliveryCount, 4);
    assert.deepEqual(
      new Set(terminalCleanup.deleted.map(({ eventId }) => eventId)),
      new Set([
        delivered.eventId,
        pending.eventId,
        failed.eventId,
        expiredLease.eventId,
        cursor.eventId,
      ]),
    );
    assert.deepEqual(
      (
        await harness.pool.query(
          `SELECT event_id FROM ${outbox} ORDER BY replay_position`,
        )
      ).rows,
      [{ event_id: live.eventId }],
    );
    assert.equal((await harness.pool.query(`SELECT 1 FROM ${deliveries}`)).rowCount, 0);

    const raced = await insertEvent({ eventId: "claim-race-event" });
    await insertDelivery(raced.eventId);
    const claimConnection = await harness.pool.connect();
    try {
      await claimConnection.query("BEGIN");
      await claimConnection.query(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         UPDATE ${deliveries} AS delivery
         SET status = 'leased', attempt_count = delivery.attempt_count + 1,
             lease_token = 'raced-lease', lease_acquired_at = moment.at,
             lease_expires_at = moment.at + interval '500 milliseconds',
             updated_at = moment.at
         FROM moment
         WHERE delivery.tenant_id = 'tenant-a'
           AND delivery.source_event_id = $1`,
        [raced.eventId],
      );
      const deferredCleanup = await withDeadline(cleanup());
      assert.equal(deferredCleanup.deletedCount, 0);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${outbox} WHERE event_id = $1`,
            [raced.eventId],
          )
        ).rows[0].count,
        1,
      );
      await claimConnection.query("COMMIT");
    } finally {
      await claimConnection.query("ROLLBACK").catch(() => undefined);
      claimConnection.release();
    }
    await waitUntil(async () =>
      (
        await harness.pool.query(
          `SELECT lease_expires_at <= clock_timestamp() AS expired
           FROM ${deliveries} WHERE source_event_id = $1`,
          [raced.eventId],
        )
      ).rows[0]?.expired === true,
    );
    const laterCleanup = await cleanup();
    assert.equal(laterCleanup.deletedCount, 1);
    assert.equal(laterCleanup.deleted[0].eventId, raced.eventId);
    assert.equal(laterCleanup.deletedDeliveryCount, 1);

    const batchEvents = [];
    for (let index = 0; index < 8; index += 1) {
      batchEvents.push(
        await insertEvent({ eventId: `batch-expired-${index}` }),
      );
    }
    const batchWorker = () =>
      createExpiredOutboxEventMaintenanceJob({
        database: harness.pool,
        schema: harness.schema,
        batchSize: 2,
      })();
    const concurrent = await withDeadline(
      Promise.all([batchWorker(), batchWorker()]),
    );
    assert.deepEqual(concurrent.map(({ deletedCount }) => deletedCount), [2, 2]);
    const concurrentlyDeleted = concurrent.flatMap(({ deleted }) =>
      deleted.map(({ eventId }) => eventId),
    );
    assert.equal(new Set(concurrentlyDeleted).size, 4);
    const allBatchDeleted = [...concurrentlyDeleted];
    for (let run = 0; run < 10; run += 1) {
      const result = await batchWorker();
      assert.ok(result.deletedCount <= 2);
      allBatchDeleted.push(...result.deleted.map(({ eventId }) => eventId));
      if (result.deletedCount === 0) break;
    }
    assert.deepEqual(
      new Set(allBatchDeleted),
      new Set(batchEvents.map(({ eventId }) => eventId)),
    );
    assert.equal(allBatchDeleted.length, batchEvents.length);

    // Keep this recipient eligible and isolate it from earlier outbox fixtures
    // so dispatch reaches the delayed provider with exactly one delivery.
    await harness.pool.query(
      `INSERT INTO ${prefix}.chat_conversations
         (tenant_id, id, type, visibility, name)
       VALUES ('tenant-a', 'stale-retention-stream', 'channel', 'public', 'Retention')`,
    );
    await harness.pool.query(
      `INSERT INTO ${prefix}.chat_conversation_members
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ('tenant-a', 'stale-retention-stream', 'stale-recipient', 'member', 'active')`,
    );
    const stale = await insertEvent({
      eventId: "stale-completion-event",
      streamId: "stale-retention-stream",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await insertDelivery(stale.eventId, "stale-recipient");
    await harness.pool.query(
      `INSERT INTO ${pushTokens} (
         tenant_id, user_id, device_id, platform, provider, environment,
         opaque_token, token_protection_scheme, token_protection_key_id,
         token_revision
       ) VALUES (
         'tenant-a', 'stale-recipient', 'stale-device',
         'ios', 'apns', 'production', 'protected:stale-token',
         'host_encrypted', 'retention-key', 1
       )`,
    );
    const providerStarted = deferred();
    const providerRelease = deferred();
    const dispatcher = createChatNotificationDispatcher({
      database: harness.pool,
      schema: harness.schema,
      adapter: {
        async send() {
          providerStarted.resolve();
          await providerRelease.promise;
        },
      },
      pushTokenProtector: {
        async protect() { throw new Error("unused test protection path"); },
        async unprotect({ protectedToken }) {
          return protectedToken.ciphertext.slice("protected:".length);
        },
      },
      batchSize: 10,
      pollIntervalMs: 60_000,
      leaseDurationMs: 150,
      createLeaseToken: () => "stale-provider-lease",
    });
    dispatchers.add(dispatcher);
    const dispatch = dispatcher.runOnce();
    await withDeadline(providerStarted.promise);
    await harness.pool.query(
      `UPDATE ${outbox}
       SET expires_at = '2020-01-01T00:00:00Z'
       WHERE event_id = $1`,
      [stale.eventId],
    );
    assert.equal((await cleanup()).deletedCount, 0);
    await waitUntil(async () =>
      (
        await harness.pool.query(
          `SELECT lease_expires_at <= clock_timestamp() AS expired
           FROM ${deliveries} WHERE source_event_id = $1`,
          [stale.eventId],
        )
      ).rows[0]?.expired === true,
    );
    const staleCleanup = await cleanup();
    assert.equal(staleCleanup.deletedCount, 1);
    assert.equal(staleCleanup.deletedDeliveryCount, 1);
    providerRelease.resolve();
    const dispatchResult = await withDeadline(dispatch);
    assert.equal(dispatchResult.claimed, 1);
    assert.equal(dispatchResult.failed, 1);
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${deliveries} WHERE source_event_id = $1`,
          [stale.eventId],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await harness.pool.query(
          `SELECT count(*)::integer AS count
           FROM ${outbox} WHERE event_id = $1`,
          [stale.eventId],
        )
      ).rows[0].count,
      0,
    );

    const runtime = createChatServer({
      database: { pool: harness.pool, schema: harness.schema },
      auth: {
        async resolveActor(request) {
          assert.equal(request.headers.authorization, "Bearer retention-actor");
          return { tenantId: "tenant-a", userId: "actor-a", roles: [] };
        },
      },
      directory: {
        async getUser() { return null; },
        async searchUsers() { return []; },
      },
      permissions: {
        async getCapabilities() { return []; },
        async authorizeEntity() { return true; },
      },
      outbox: { pollIntervalMs: 60_000 },
    });
    const server = createServer(runtime.router);
    runtime.attachWebSocket(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.add({ runtime, server });
    const address = server.address();
    assert.equal(typeof address, "object");
    const replay = await connectForReplay(
      `ws://127.0.0.1:${address.port}${DEFAULT_CHAT_WEBSOCKET_PATH}`,
      cursor.eventId,
    );
    const replayMessage = await replay.message;
    assert.equal(replayMessage.type, "chat.session.snapshot_required");
    assert.equal(replayMessage.state, "snapshot_required");
    assert.equal(replayMessage.reason, "replay_unavailable");
    assert.deepEqual(replayMessage.resumeFrom, { eventId: cursor.eventId });
    assert.deepEqual(
      await replay.closed,
      CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired,
    );

    await harness.pool.query(
      `INSERT INTO ${outbox} (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, published_at, expires_at
       )
       SELECT 'expiry-plan-' || value, $1,
              'plan-tenant-' || (value % 11), 'plan-stream',
              'message.created', '2026-01-01T00:00:00Z', '{}'::jsonb,
              clock_timestamp(),
              '2099-01-01T00:00:00Z'::timestamptz
                + value * interval '1 second'
       FROM generate_series(1, 5000) AS value`,
      [CHAT_PROTOCOL_VERSION],
    );
    let candidateSql;
    const captureDatabase = {
      async connect() {
        const client = await harness.pool.connect();
        return {
          query(sql, values) {
            if (sql.includes("AS active_delivery")) candidateSql = sql;
            return client.query(sql, values);
          },
          release(error) {
            client.release(error);
          },
        };
      },
    };
    await createExpiredOutboxEventMaintenanceJob({
      database: captureDatabase,
      schema: harness.schema,
      batchSize: 100,
    })();
    assert.equal(typeof candidateSql, "string");
    const planClient = await harness.pool.connect();
    try {
      await planClient.query(`ANALYZE ${outbox}`);
      await planClient.query(`ANALYZE ${deliveries}`);
      await planClient.query("BEGIN");
      await planClient.query("SET LOCAL enable_seqscan = off");
      await planClient.query("SET LOCAL enable_bitmapscan = off");
      const plan = await planClient.query(
        `EXPLAIN (FORMAT JSON) ${candidateSql}`,
        [100],
      );
      assert.ok(
        findIndexes(plan.rows[0]?.["QUERY PLAN"]).includes(
          "chat_outbox_events_expiry_cleanup_idx",
        ),
      );
      await planClient.query("ROLLBACK");
    } finally {
      await planClient.query("ROLLBACK").catch(() => undefined);
      planClient.release();
    }
  } finally {
    for (const dispatcher of dispatchers) {
      await dispatcher.stop().catch(() => undefined);
    }
    await Promise.allSettled(
      [...servers].map(async ({ runtime, server }) => {
        await runtime.close();
        await new Promise((resolve) => server.close(() => resolve()));
      }),
    );
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
