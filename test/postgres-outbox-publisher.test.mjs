import assert from "node:assert/strict";
import test from "node:test";

import {
  createChatOutboxPublisher,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const waitFor = async (condition, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for outbox state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("transactional outbox publisher leases, orders, and retries real PostgreSQL rows", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "outbox_worker" });
  const outbox = `${quoteIdentifier(harness.schema)}.chat_outbox_events`;
  const publishers = new Set();
  let eventCounter = 0;

  const insertEvent = async (
    {
      tenantId = "tenant-a",
      streamId,
      type = "message.created",
      payload = {},
      expiresInMs = 86_400_000,
    },
    client = harness.pool,
  ) => {
    eventCounter += 1;
    const eventId = `publisher-event-${eventCounter}`;
    await client.query(
      `INSERT INTO ${outbox}
         (event_id, protocol_version, tenant_id, stream_id, type,
          occurred_at, payload, expires_at)
       VALUES ($1, 4, $2, $3, $4, clock_timestamp(), $5::jsonb,
               clock_timestamp()
                 + ($6::double precision * interval '1 millisecond'))`,
      [
        eventId,
        tenantId,
        streamId,
        type,
        JSON.stringify(payload),
        expiresInMs,
      ],
    );
    return eventId;
  };

  const publisher = (options) => {
    const created = createChatOutboxPublisher({
      database: harness.pool,
      schema: harness.schema,
      batchSize: 20,
      pollIntervalMs: 5,
      leaseDurationMs: 100,
      initialRetryDelayMs: 15,
      maxRetryDelayMs: 25,
      ...options,
    });
    publishers.add(created);
    return created;
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("two healthy publishers deliver each claimed event once", async () => {
      const expected = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          insertEvent({ streamId: `concurrent-${index}` }),
        ),
      );
      const delivered = [];
      const adapter = {
        async publish(event) {
          delivered.push(event.eventId);
          await new Promise((resolve) => setTimeout(resolve, 2));
        },
      };
      const first = publisher({ realtime: adapter });
      const second = publisher({ realtime: adapter });

      await Promise.all([first.runOnce(), second.runOnce()]);
      await Promise.all([first.runOnce(), second.runOnce()]);

      assert.deepEqual(new Set(delivered), new Set(expected));
      assert.equal(delivered.length, expected.length);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT event_id, publish_attempts::integer AS publish_attempts
             FROM ${outbox}
             WHERE event_id = ANY($1::text[])
             ORDER BY event_id`,
            [expected],
          )
        ).rows.map((row) => row.publish_attempts),
        Array(expected.length).fill(1),
      );
    });

    await t.test("an uncommitted event remains invisible until commit", async () => {
      const delivered = [];
      const worker = publisher({
        realtime: { async publish(event) { delivered.push(event.eventId); } },
      });
      const transaction = await harness.pool.connect();
      let eventId;
      try {
        await transaction.query("BEGIN");
        eventId = await insertEvent(
          { streamId: "commit-visibility" },
          transaction,
        );
        assert.deepEqual(await worker.runOnce(), {
          claimed: 0,
          published: 0,
          failed: 0,
        });
        assert.deepEqual(delivered, []);
        await transaction.query("COMMIT");
      } catch (error) {
        await transaction.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        transaction.release();
      }

      assert.deepEqual(await worker.runOnce(), {
        claimed: 1,
        published: 1,
        failed: 0,
      });
      assert.deepEqual(delivered, [eventId]);
    });

    await t.test("one stream publishes strictly in replay-position order", async () => {
      const expected = [];
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        expected.push(
          await insertEvent({
            streamId: "ordered-stream",
            payload: { ordinal },
          }),
        );
      }
      const delivered = [];
      const worker = publisher({
        realtime: {
          async publish(event) {
            delivered.push(event.eventId);
          },
        },
      });

      for (const eventId of expected) {
        const result = await worker.runOnce();
        assert.equal(result.claimed, 1);
        assert.equal(delivered.at(-1), eventId);
      }
      assert.deepEqual(delivered, expected);
    });

    await t.test("an expired stream head is skipped without being claimed", async () => {
      const expiredId = await insertEvent({
        streamId: "expired-head",
        expiresInMs: -60_000,
      });
      const validId = await insertEvent({ streamId: "expired-head" });
      const delivered = [];
      const worker = publisher({
        realtime: {
          async publish(event) {
            delivered.push(event.eventId);
          },
        },
      });

      assert.deepEqual(await worker.runOnce(), {
        claimed: 1,
        published: 1,
        failed: 0,
      });
      assert.deepEqual(delivered, [validId]);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT event_id, publish_attempts::integer AS publish_attempts,
                    claim_token, claimed_at,
                    published_at IS NOT NULL AS published
             FROM ${outbox}
             WHERE event_id = ANY($1::text[])
             ORDER BY replay_position`,
            [[expiredId, validId]],
          )
        ).rows,
        [
          {
            event_id: expiredId,
            publish_attempts: 0,
            claim_token: null,
            claimed_at: null,
            published: false,
          },
          {
            event_id: validId,
            publish_attempts: 1,
            claim_token: null,
            claimed_at: null,
            published: true,
          },
        ],
      );
    });

    await t.test("adapter failure backs off, blocks its stream, and preserves replay data", async () => {
      const firstId = await insertEvent({
        streamId: "retry-stream",
        payload: { immutable: "first" },
      });
      const secondId = await insertEvent({
        streamId: "retry-stream",
        payload: { immutable: "second" },
      });
      const unrelatedId = await insertEvent({ streamId: "retry-unrelated" });
      const delivered = [];
      let failFirst = true;
      const worker = publisher({
        batchSize: 10,
        realtime: {
          async publish(event) {
            if (event.eventId === firstId && failFirst) {
              failFirst = false;
              throw new Error("temporary fanout failure");
            }
            delivered.push(event.eventId);
          },
        },
      });

      assert.deepEqual(await worker.runOnce(), {
        claimed: 2,
        published: 1,
        failed: 1,
      });
      assert.deepEqual(delivered, [unrelatedId]);
      assert.deepEqual(await worker.runOnce(), {
        claimed: 0,
        published: 0,
        failed: 0,
      });

      const failedRow = (
        await harness.pool.query(
          `SELECT publish_attempts::integer AS publish_attempts,
                  claim_token, claimed_at, published_at, payload,
                  available_at > clock_timestamp() AS backed_off
           FROM ${outbox}
           WHERE event_id = $1`,
          [firstId],
        )
      ).rows[0];
      assert.deepEqual(failedRow, {
        publish_attempts: 1,
        claim_token: null,
        claimed_at: null,
        published_at: null,
        payload: { immutable: "first" },
        backed_off: true,
      });

      await waitFor(async () => {
        const available = await harness.pool.query(
          `SELECT available_at <= clock_timestamp() AS available
           FROM ${outbox} WHERE event_id = $1`,
          [firstId],
        );
        return available.rows[0]?.available === true;
      });
      await worker.runOnce();
      await worker.runOnce();
      assert.deepEqual(delivered, [unrelatedId, firstId, secondId]);

      const retried = (
        await harness.pool.query(
          `SELECT publish_attempts::integer AS publish_attempts, payload,
                  published_at IS NOT NULL AS published
           FROM ${outbox} WHERE event_id = $1`,
          [firstId],
        )
      ).rows[0];
      assert.deepEqual(retried, {
        publish_attempts: 2,
        payload: { immutable: "first" },
        published: true,
      });
    });

    await t.test("an all-expired batch never calls the realtime provider", async () => {
      const expiredIds = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          insertEvent({
            streamId: `all-expired-${index}`,
            expiresInMs: -60_000,
          }),
        ),
      );
      let providerCalls = 0;
      const worker = publisher({
        realtime: {
          async publish() {
            providerCalls += 1;
          },
        },
      });

      assert.deepEqual(await worker.runOnce(), {
        claimed: 0,
        published: 0,
        failed: 0,
      });
      assert.equal(providerCalls, 0);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT publish_attempts::integer AS publish_attempts,
                    claim_token, claimed_at, published_at
             FROM ${outbox}
             WHERE event_id = ANY($1::text[])
             ORDER BY replay_position`,
            [expiredIds],
          )
        ).rows,
        expiredIds.map(() => ({
          publish_attempts: 0,
          claim_token: null,
          claimed_at: null,
          published_at: null,
        })),
      );
    });

    await t.test("concurrent publishers preserve valid order past an expired head", async () => {
      const expiredId = await insertEvent({
        streamId: "concurrent-expired-head",
        expiresInMs: -60_000,
      });
      const expected = [];
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        expected.push(
          await insertEvent({
            streamId: "concurrent-expired-head",
            payload: { ordinal },
          }),
        );
      }
      const delivered = [];
      const adapter = {
        async publish(event) {
          delivered.push(event.eventId);
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      };
      const first = publisher({ realtime: adapter });
      const second = publisher({ realtime: adapter });

      for (
        let round = 0;
        delivered.length < expected.length && round < expected.length;
        round += 1
      ) {
        const results = await Promise.all([first.runOnce(), second.runOnce()]);
        assert.ok(
          results.some((result) => result.claimed > 0),
          "at least one concurrent publisher should advance the stream",
        );
      }

      assert.deepEqual(delivered, expected);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT publish_attempts::integer AS publish_attempts,
                    claim_token, claimed_at, published_at
             FROM ${outbox}
             WHERE event_id = $1`,
            [expiredId],
          )
        ).rows[0],
        {
          publish_attempts: 0,
          claim_token: null,
          claimed_at: null,
          published_at: null,
        },
      );
    });

    await t.test("an expired lease is reclaimed", async () => {
      const eventId = await insertEvent({ streamId: "expired-lease" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await harness.pool.query(
        `UPDATE ${outbox}
         SET publish_attempts = 1,
             claim_token = 'crashed-worker',
             claimed_at = occurred_at
         WHERE event_id = $1`,
        [eventId],
      );
      const delivered = [];
      const worker = publisher({
        leaseDurationMs: 20,
        realtime: { async publish(event) { delivered.push(event.eventId); } },
      });

      assert.deepEqual(await worker.runOnce(), {
        claimed: 1,
        published: 1,
        failed: 0,
      });
      assert.deepEqual(delivered, [eventId]);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT publish_attempts::integer AS publish_attempts,
                    claim_token, claimed_at, published_at IS NOT NULL AS published
             FROM ${outbox} WHERE event_id = $1`,
            [eventId],
          )
        ).rows[0],
        {
          publish_attempts: 2,
          claim_token: null,
          claimed_at: null,
          published: true,
        },
      );
    });
  } finally {
    await Promise.all([...publishers].map((worker) => worker.stop().catch(() => undefined)));
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
