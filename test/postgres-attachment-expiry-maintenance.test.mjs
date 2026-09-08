import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXPIRED_IDEMPOTENCY_KEY_BATCH_SIZE,
  DEFAULT_EXPIRED_OUTBOX_EVENT_BATCH_SIZE,
  DEFAULT_EXPIRED_PENDING_ATTACHMENT_BATCH_SIZE,
  DEFAULT_POSTGRES_MAINTENANCE_POLL_INTERVAL_MS,
  ChatServerConfigurationError,
  createChatServer,
  createExpiredPendingAttachmentMaintenanceJob,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  normalizeChatPostgresMaintenanceOptions,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const adapters = {
  auth: { async resolveActor() { throw new Error("unused"); } },
  directory: {
    async getUser() { throw new Error("unused"); },
    async searchUsers() { throw new Error("unused"); },
  },
  permissions: {
    async getCapabilities() { throw new Error("unused"); },
    async authorizeEntity() { throw new Error("unused"); },
  },
};

test("pending-attachment maintenance validates and normalizes bounded configuration", async () => {
  const unusedDatabase = {
    async connect() { throw new Error("unused"); },
  };
  for (const batchSize of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createExpiredPendingAttachmentMaintenanceJob({
        database: unusedDatabase,
        batchSize,
      }),
      /expiredPendingAttachments\.batchSize must be a positive safe integer/u,
    );
  }
  assert.throws(
    () => createExpiredPendingAttachmentMaintenanceJob({
      database: unusedDatabase,
      schema: "invalid-schema",
    }),
    /schema must be a PostgreSQL identifier/u,
  );

  const defaults = normalizeChatPostgresMaintenanceOptions();
  assert.deepEqual(defaults, {
    pollIntervalMs: DEFAULT_POSTGRES_MAINTENANCE_POLL_INTERVAL_MS,
    expiredIdempotencyKeys: {
      batchSize: DEFAULT_EXPIRED_IDEMPOTENCY_KEY_BATCH_SIZE,
    },
    expiredOutboxEvents: {
      batchSize: DEFAULT_EXPIRED_OUTBOX_EVENT_BATCH_SIZE,
    },
    expiredPendingAttachments: {
      batchSize: DEFAULT_EXPIRED_PENDING_ATTACHMENT_BATCH_SIZE,
    },
    onError: undefined,
    onBatch: undefined,
  });
  assert.equal(Object.isFrozen(defaults), true);
  assert.equal(Object.isFrozen(defaults.expiredIdempotencyKeys), true);
  assert.equal(Object.isFrozen(defaults.expiredOutboxEvents), true);
  assert.equal(Object.isFrozen(defaults.expiredPendingAttachments), true);

  for (const invalid of [
    null,
    [],
    { unknown: true },
    { expiredPendingAttachments: [] },
    { expiredPendingAttachments: { unknown: true } },
  ]) {
    assert.throws(
      () => normalizeChatPostgresMaintenanceOptions(invalid),
      /must be an object|is not supported/u,
    );
  }

  let poolCreations = 0;
  assert.throws(
    () => createChatServer({
      database: {
        connectionString: "postgres://unused",
        createPool() {
          poolCreations += 1;
          throw new Error("must not allocate");
        },
      },
      ...adapters,
      postgresMaintenance: {
        expiredPendingAttachments: { batchSize: 0 },
      },
    }),
    (error) =>
      error instanceof ChatServerConfigurationError &&
      /expiredPendingAttachments\.batchSize/u.test(error.message),
  );
  assert.equal(poolCreations, 0);
});

test("createChatServer wires normalized maintenance batch sizes and aggregate telemetry", async () => {
  const selectedBatchSizes = [];
  const outcomes = [];
  const database = {
    async query(sql, values) {
      if (sql.includes("WITH expired_keys AS MATERIALIZED")) {
        selectedBatchSizes.push(["idempotency", values[0]]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("WITH claimable AS MATERIALIZED")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, values) {
          if (sql === "BEGIN" || sql === "COMMIT") {
            return { rows: [], rowCount: null };
          }
          if (sql.includes("chat_outbox_events AS event")) {
            selectedBatchSizes.push(["outbox", values[0]]);
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("chat_attachments AS attachment")) {
            selectedBatchSizes.push(["attachments", values[0]]);
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`unexpected reserved query: ${sql}`);
        },
        release() {},
      };
    },
  };
  const runtime = createChatServer({
    database: { pool: database },
    ...adapters,
    outbox: { pollIntervalMs: 61_000 },
    postgresMaintenance: {
      pollIntervalMs: 62_000,
      expiredIdempotencyKeys: { batchSize: 11 },
      expiredOutboxEvents: { batchSize: 12 },
      expiredPendingAttachments: { batchSize: 13 },
      onBatch(outcome) { outcomes.push(outcome); },
    },
  });

  try {
    await nextTurn();
    assert.deepEqual(runtime.config.postgresMaintenance, {
      pollIntervalMs: 62_000,
      expiredIdempotencyKeys: { batchSize: 11 },
      expiredOutboxEvents: { batchSize: 12 },
      expiredPendingAttachments: { batchSize: 13 },
      onError: undefined,
      onBatch: runtime.config.postgresMaintenance.onBatch,
    });
    assert.equal(Object.isFrozen(runtime.config.postgresMaintenance), true);
    assert.equal(
      Object.isFrozen(
        runtime.config.postgresMaintenance.expiredPendingAttachments,
      ),
      true,
    );
    assert.deepEqual(selectedBatchSizes, [
      ["idempotency", 11],
      ["outbox", 12],
      ["attachments", 13],
    ]);
    assert.deepEqual(outcomes, [{
      configuredJobs: 3,
      succeeded: 3,
      failed: 0,
      durationMs: outcomes[0].durationMs,
      status: "success",
    }]);
    assert.deepEqual(Object.keys(outcomes[0]).sort(), [
      "configuredJobs",
      "durationMs",
      "failed",
      "status",
      "succeeded",
    ]);
  } finally {
    await runtime.close();
  }
});

test("pending-attachment maintenance keeps object keys internal and releases its transaction", async () => {
  const storageKey = "private-object-key/unit-sentinel";
  const row = {
    expires_at: new Date("2020-01-01T00:00:00Z"),
    tenant_id: "tenant-a",
    attachment_id: "attachment-a",
    storage_key: storageKey,
  };
  const calls = [];
  const releases = [];
  const connection = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") {
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith("SELECT attachment.expires_at")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("UPDATE \"tenant_chat\".chat_attachments")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO \"tenant_chat\".chat_attachment_cleanup_deliveries")) {
        assert.deepEqual(values, [
          ["tenant-a"],
          ["attachment-a"],
          [storageKey],
        ]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release(error) { releases.push(error); },
  };
  const result = await createExpiredPendingAttachmentMaintenanceJob({
    database: { async connect() { return connection; } },
    schema: "tenant_chat",
    batchSize: 7,
  })();

  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
  assert.match(calls[1].sql, /state = 'pending'/u);
  assert.match(calls[1].sql, /expires_at <= clock_timestamp\(\)/u);
  assert.match(
    calls[1].sql,
    /ORDER BY attachment\.expires_at, attachment\.tenant_id, attachment\.id/u,
  );
  assert.match(calls[1].sql, /LIMIT \$1\s+FOR UPDATE OF attachment SKIP LOCKED/u);
  assert.deepEqual(calls[1].values, [7]);
  assert.match(calls[2].sql, /SET state = 'abandoned'/u);
  assert.match(calls[2].sql, /attachment\.state = 'pending'/u);
  assert.match(calls[2].sql, /attachment\.expires_at <= clock_timestamp\(\)/u);
  assert.match(calls[3].sql, /ON CONFLICT \(tenant_id, attachment_id\) DO NOTHING/u);
  assert.deepEqual(releases, [undefined]);
  assert.deepEqual(result, {
    abandonedCount: 1,
    cleanupDeliveryCount: 1,
    abandoned: [{
      expiresAt: "2020-01-01T00:00:00.000Z",
      tenantId: "tenant-a",
      attachmentId: "attachment-a",
    }],
  });
  assert.equal(JSON.stringify(result).includes(storageKey), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.abandoned), true);
  assert.equal(Object.isFrozen(result.abandoned[0]), true);
});

test("pending-attachment maintenance sanitizes failures and discards on rollback failure", async () => {
  const storageKey = "private-object-key/error-sentinel";
  const releases = [];
  const connection = {
    async query(sql) {
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") throw new Error(`rollback ${storageKey}`);
      throw new Error(`selection ${storageKey}`);
    },
    release(error) { releases.push(error); },
  };
  const job = createExpiredPendingAttachmentMaintenanceJob({
    database: { async connect() { return connection; } },
  });

  let failure;
  try {
    await job();
  } catch (error) {
    failure = error;
  }
  assert.equal(failure instanceof AggregateError, true);
  assert.equal(
    failure.errors.some((error) =>
      String(error instanceof Error ? error.message : error).includes(storageKey)),
    false,
  );
  assert.equal(failure.message.includes(storageKey), false);
  assert.equal(releases.length, 1);
  assert.equal(releases[0] instanceof Error, true);
  assert.equal(releases[0].message.includes(storageKey), false);
});

test("expired pending attachment maintenance is atomic, ordered, idempotent, and concurrent", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "attachment_expiry",
  });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const attachments = `${schema}.chat_attachments`;
  const deliveries = `${schema}.chat_attachment_cleanup_deliveries`;
  const checksum = `sha256:${"a".repeat(64)}`;

  const reset = async () => {
    await harness.pool.query(
      `TRUNCATE ${deliveries}, ${attachments}`,
    );
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES ('tenant-a', 'conversation-a', 'channel', 'private', 'A')
       ON CONFLICT DO NOTHING`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES ('tenant-a', 'message-a', 'conversation-a', 1, 'author-a',
               'client-a', '{"format":"plain","text":"Attachment"}')
       ON CONFLICT DO NOTHING`,
    );
  };

  const seedPending = ({
    id,
    tenantId = "tenant-a",
    expiresAt = "2020-01-03T00:00:00Z",
    storageKey = `private-object-key/${tenantId}/${id}`,
  }) => harness.pool.query(
    `INSERT INTO ${attachments} (
       tenant_id, id, uploader_user_id, storage_key, file_name,
       content_type, size_bytes, created_at, updated_at, expires_at
     )
     VALUES ($1, $2, 'uploader-a', $3, $4, 'text/plain', 12,
             '2019-01-01T00:00:00Z', '2019-01-01T00:00:00Z', $5)`,
    [tenantId, id, storageKey, `${id}.txt`, expiresAt],
  );

  const transition = (id, state) => harness.pool.query(
    state === "attached"
      ? `UPDATE ${attachments}
         SET state = 'attached', attached_message_id = 'message-a',
             checksum = $2, attached_at = '2020-01-02T00:00:00Z',
             updated_at = '2020-01-02T00:00:00Z'
         WHERE tenant_id = 'tenant-a' AND id = $1`
      : `UPDATE ${attachments}
         SET state = 'abandoned', abandoned_at = '2020-01-02T00:00:00Z',
             updated_at = '2020-01-02T00:00:00Z'
         WHERE tenant_id = 'tenant-a' AND id = $1`,
    state === "attached" ? [id, checksum] : [id],
  );

  const job = (batchSize = 100) =>
    createExpiredPendingAttachmentMaintenanceJob({
      database: harness.pool,
      schema: harness.schema,
      batchSize,
    });

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("transitions only expired pending rows and enqueues each once", async () => {
      await reset();
      await seedPending({ id: "expired-b", expiresAt: "2020-01-02T00:00:00Z" });
      await seedPending({ id: "expired-a", expiresAt: "2020-01-01T00:00:00Z" });
      await seedPending({ id: "live", expiresAt: "2099-01-01T00:00:00Z" });
      await seedPending({ id: "attached" });
      await transition("attached", "attached");
      await seedPending({ id: "abandoned" });
      await transition("abandoned", "abandoned");

      const result = await job()();
      assert.deepEqual(result, {
        abandonedCount: 2,
        cleanupDeliveryCount: 2,
        abandoned: [
          {
            expiresAt: "2020-01-01T00:00:00.000Z",
            tenantId: "tenant-a",
            attachmentId: "expired-a",
          },
          {
            expiresAt: "2020-01-02T00:00:00.000Z",
            tenantId: "tenant-a",
            attachmentId: "expired-b",
          },
        ],
      });
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.abandoned), true);
      assert.equal(Object.isFrozen(result.abandoned[0]), true);
      assert.equal(JSON.stringify(result).includes("private-object-key"), false);

      assert.deepEqual((await harness.pool.query(
        `SELECT id, state, updated_at IS NOT DISTINCT FROM abandoned_at AS coherent
         FROM ${attachments}
         ORDER BY id`,
      )).rows, [
        { id: "abandoned", state: "abandoned", coherent: true },
        { id: "attached", state: "attached", coherent: false },
        { id: "expired-a", state: "abandoned", coherent: true },
        { id: "expired-b", state: "abandoned", coherent: true },
        { id: "live", state: "pending", coherent: false },
      ]);
      assert.deepEqual((await harness.pool.query(
        `SELECT attachment_id, state, attempt_count::integer AS attempt_count
         FROM ${deliveries}
         ORDER BY attachment_id`,
      )).rows, [
        { attachment_id: "expired-a", state: "pending", attempt_count: 0 },
        { attachment_id: "expired-b", state: "pending", attempt_count: 0 },
      ]);

      assert.deepEqual(await job()(), {
        abandonedCount: 0,
        cleanupDeliveryCount: 0,
        abandoned: [],
      });
    });

    await t.test("honors deterministic order and the batch limit", async () => {
      await reset();
      await seedPending({ id: "same-b", tenantId: "tenant-b", expiresAt: "2020-01-01T00:00:00Z" });
      await seedPending({ id: "later", expiresAt: "2020-01-02T00:00:00Z" });
      await seedPending({ id: "same-a", expiresAt: "2020-01-01T00:00:00Z" });

      const first = await job(2)();
      assert.deepEqual(
        first.abandoned.map(({ tenantId, attachmentId }) =>
          `${tenantId}/${attachmentId}`),
        ["tenant-a/same-a", "tenant-b/same-b"],
      );
      assert.equal(first.abandonedCount, 2);
      assert.deepEqual((await job(2)()).abandoned.map(
        ({ tenantId, attachmentId }) => `${tenantId}/${attachmentId}`,
      ), ["tenant-a/later"]);
    });

    await t.test("two workers process each candidate at most once", async () => {
      await reset();
      for (const id of ["worker-a", "worker-b", "worker-c", "worker-d"]) {
        await seedPending({ id });
      }
      const results = await Promise.all([job(2)(), job(2)()]);
      const identities = results.flatMap(({ abandoned }) =>
        abandoned.map(({ tenantId, attachmentId }) =>
          `${tenantId}/${attachmentId}`),
      );
      assert.equal(identities.length, 4);
      assert.equal(new Set(identities).size, 4);
      assert.equal((await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${deliveries}`,
      )).rows[0].count, 4);
    });

    await t.test("a locked competing terminal transition is never overwritten", async () => {
      await reset();
      await seedPending({ id: "terminal-wins" });
      const competitor = await harness.pool.connect();
      try {
        await competitor.query("BEGIN");
        await competitor.query(
          `UPDATE ${attachments}
           SET state = 'attached', attached_message_id = 'message-a',
               checksum = $1, attached_at = '2020-01-02T00:00:00Z',
               updated_at = '2020-01-02T00:00:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'terminal-wins'`,
          [checksum],
        );
        const result = await job()();
        assert.equal(result.abandonedCount, 0);
        await competitor.query("COMMIT");
      } catch (error) {
        await competitor.query("ROLLBACK");
        throw error;
      } finally {
        competitor.release();
      }
      assert.equal((await harness.pool.query(
        `SELECT state FROM ${attachments}
         WHERE tenant_id = 'tenant-a' AND id = 'terminal-wins'`,
      )).rows[0].state, "attached");
      assert.equal((await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${deliveries}`,
      )).rows[0].count, 0);
    });

    await t.test("an enqueue failure rolls back attachment and delivery changes", async () => {
      await reset();
      const storageKey = "private-object-key/rollback-sentinel";
      await seedPending({ id: "rollback", storageKey });
      await harness.pool.query(
        `CREATE FUNCTION fail_attachment_cleanup_enqueue()
         RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'induced delivery failure';
         END;
         $$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER fail_attachment_cleanup_enqueue
         BEFORE INSERT ON ${deliveries}
         FOR EACH ROW EXECUTE FUNCTION fail_attachment_cleanup_enqueue()`,
      );
      let failure;
      try {
        await job()();
      } catch (error) {
        failure = error;
      }
      assert.match(failure?.message ?? "", /maintenance failed/u);
      assert.equal(JSON.stringify(failure).includes(storageKey), false);
      assert.equal((await harness.pool.query(
        `SELECT state FROM ${attachments}
         WHERE tenant_id = 'tenant-a' AND id = 'rollback'`,
      )).rows[0].state, "pending");
      assert.equal((await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${deliveries}`,
      )).rows[0].count, 0);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
