import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatNotificationDeliveryError,
  createChatNotificationDispatcher,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

test("due message reminders use the durable notification pipeline", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "notification_reminders",
  });
  const prefix = quoteIdentifier(harness.schema);
  const conversations = `${prefix}.chat_conversations`;
  const members = `${prefix}.chat_conversation_members`;
  const messages = `${prefix}.chat_messages`;
  const reminders = `${prefix}.chat_message_reminders`;
  const outbox = `${prefix}.chat_outbox_events`;
  const deliveries = `${prefix}.chat_notification_deliveries`;
  const pushTokens = `${prefix}.chat_device_push_tokens`;
  const workers = new Set();
  // Reclaim guards also check database wall time; keep the injected clock in the past.
  let now = new Date("2020-01-01T00:00:00.000Z");
  let leaseOrdinal = 0;

  const worker = (adapter, options = {}) => {
    const dispatcher = createChatNotificationDispatcher({
      database: harness.pool,
      schema: harness.schema,
      adapter,
      pushTokenProtector: {
        async protect() { throw new Error("unused test protection path"); },
        async unprotect({ protectedToken }) {
          return protectedToken.ciphertext.slice("protected:".length);
        },
      },
      batchSize: 25,
      pollIntervalMs: 60_000,
      leaseDurationMs: 1_000,
      initialRetryDelayMs: 0,
      maxRetryDelayMs: 0,
      now: () => new Date(now),
      createLeaseToken: () => `reminder-lease-${++leaseOrdinal}`,
      ...options,
    });
    workers.add(dispatcher);
    return dispatcher;
  };

  const seed = async ({
    suffix,
    tenantId = "tenant-a",
    ownerUserId = `owner-${suffix}`,
    dueAt = "2020-01-01T00:00:00.000Z",
  }) => {
    const conversationId = `conversation-${suffix}`;
    const messageId = `message-${suffix}`;
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES ($1, $2, 'channel', 'private', $2, 1)`,
      [tenantId, conversationId],
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ($1, $2, $3, 'member', 'active'),
              ($1, $2, $4, 'member', 'active')`,
      [tenantId, conversationId, ownerUserId, `author-${suffix}`],
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5,
               jsonb_build_object(
                 'format', 'plain',
                 'text', 'secret body that must never reach the adapter'
               ),
               '2019-01-01T00:00:00Z', '2019-01-01T00:00:00Z')`,
      [
        tenantId,
        messageId,
        conversationId,
        `author-${suffix}`,
        `client-${suffix}`,
      ],
    );
    await harness.pool.query(
      `INSERT INTO ${reminders}
         (tenant_id, user_id, message_id, conversation_id, remind_at,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5,
               '2019-01-01T00:00:00Z', '2019-01-01T00:00:00Z')`,
      [tenantId, ownerUserId, messageId, conversationId, dueAt],
    );
    await harness.pool.query(
      `INSERT INTO ${pushTokens} (
         tenant_id, user_id, device_id, platform, provider, environment,
         opaque_token, token_protection_scheme, token_protection_key_id,
         token_revision
       ) VALUES (
         $1, $2, $3, 'ios', 'apns', 'production', $4,
         'host_encrypted', 'reminder-key', 1
       )`,
      [tenantId, ownerUserId, `device-${suffix}`, `protected:token-${suffix}`],
    );
    return { tenantId, ownerUserId, conversationId, messageId };
  };

  const gatedProvider = (failureClass) => {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    return {
      entered: entered.promise,
      release: released.resolve,
      adapter: {
        async send(input) {
          entered.resolve(input);
          await released.promise;
          if (failureClass) {
            throw new ChatNotificationDeliveryError(failureClass);
          }
        },
      },
    };
  };
  const snapshot = async (fixture) => {
    const reminder = await harness.pool.query(
      `SELECT to_jsonb(reminder) AS row FROM ${reminders} AS reminder
       WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3`,
      [fixture.tenantId, fixture.ownerUserId, fixture.messageId],
    );
    assert.equal(reminder.rows.length, 1);
    const delivery = await harness.pool.query(
      `SELECT to_jsonb(delivery) AS row FROM ${deliveries} AS delivery
       WHERE tenant_id = $1 AND recipient_host_user_id = $2
         AND source_event_id = $3 AND notification_kind = 'message.reminder'`,
      [fixture.tenantId, fixture.ownerUserId, reminder.rows[0].row.materialized_source_event_id],
    );
    assert.equal(delivery.rows.length, 1);
    return { reminder: reminder.rows[0].row, delivery: delivery.rows[0].row };
  };

  // If a worker exits before entering send, fail instead of waiting on its gate.
  const enteredOrExited = (provider, run) => Promise.race([
    provider.entered,
    run.then(() => { throw new Error("Worker exited before entering send"); }),
  ]);

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("does not materialize before remind_at", async () => {
      const fixture = await seed({
        suffix: "future",
        dueAt: "2020-01-02T00:00:00.000Z",
      });
      const calls = [];
      const dispatcher = worker({ async send(input) { calls.push(input); } });

      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 0,
        claimed: 0,
        delivered: 0,
        suppressed: 0,
        failed: 0,
      });
      assert.equal(calls.length, 0);

      now = new Date("2020-01-02T00:00:00.000Z");
      assert.deepEqual(await dispatcher.runOnce(), {
        materialized: 1,
        claimed: 1,
        delivered: 1,
        suppressed: 0,
        failed: 0,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].recipientUserId, fixture.ownerUserId);
      assert.equal(calls[0].type, "message.reminder");
      assert.deepEqual(calls[0].metadata, {
        conversationId: fixture.conversationId,
        messageId: fixture.messageId,
        sequence: 1,
        reminderDueAt: "2020-01-02T00:00:00+00:00",
        reminderRevision: 1,
      });
      assert.doesNotMatch(JSON.stringify(calls[0]), /secret body/u);
    });

    await t.test("concurrent workers materialize and deliver once", async () => {
      const fixture = await seed({ suffix: "concurrent" });
      const calls = [];
      const adapter = { async send(input) { calls.push(input); } };
      const first = worker(adapter);
      const second = worker(adapter);

      const results = await Promise.all([first.runOnce(), second.runOnce()]);
      assert.equal(
        results.reduce((total, result) => total + result.materialized, 0),
        1,
      );
      assert.equal(
        results.reduce((total, result) => total + result.delivered, 0),
        1,
      );
      assert.deepEqual(
        calls.map(({ tenantId, recipientUserId }) => [tenantId, recipientUserId]),
        [[fixture.tenantId, fixture.ownerUserId]],
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${deliveries}
             WHERE notification_kind = 'message.reminder'
               AND notification_metadata ->> 'messageId' = $1`,
            [fixture.messageId],
          )
        ).rows[0].count,
        1,
      );
    });

    await t.test("cancellation after materialization suppresses retry delivery", async () => {
      const fixture = await seed({ suffix: "cancelled" });
      const calls = [];
      const first = worker({
        async send(input) {
          calls.push(input);
          throw new ChatNotificationDeliveryError("transient");
        },
      });
      assert.equal((await first.runOnce()).failed, 1);
      await harness.pool.query(
        `UPDATE ${reminders}
         SET status = 'cancelled', cancelled_at = $1,
             reminder_revision = reminder_revision + 1, updated_at = $1
         WHERE tenant_id = $2 AND user_id = $3 AND message_id = $4`,
        [now, fixture.tenantId, fixture.ownerUserId, fixture.messageId],
      );
      const result = await worker({ async send(input) { calls.push(input); } }).runOnce();
      assert.equal(result.materialized, 0);
      assert.equal(result.suppressed, 1);
      assert.equal(calls.length, 1);
    });

    await t.test("access loss is suppressed and never changes recipients", async () => {
      const fixture = await seed({
        suffix: "access-loss",
        tenantId: "tenant-isolated",
        ownerUserId: "isolated-owner",
      });
      await harness.pool.query(
        `UPDATE ${members}
         SET state = 'removed', updated_at = $1
         WHERE tenant_id = $2 AND conversation_id = $3 AND user_id = $4`,
        [now, fixture.tenantId, fixture.conversationId, fixture.ownerUserId],
      );
      const calls = [];
      const result = await worker({ async send(input) { calls.push(input); } }).runOnce();
      assert.equal(result.materialized, 1);
      assert.equal(result.suppressed, 1);
      assert.equal(calls.length, 0);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT status FROM ${reminders}
             WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3`,
            [fixture.tenantId, fixture.ownerUserId, fixture.messageId],
          )
        ).rows[0].status,
        "cancelled",
      );
    });

    await t.test("transient retry preserves delivery identity", async () => {
      const fixture = await seed({ suffix: "retry" });
      const calls = [];
      const firstDispatcher = worker({
        async send(input) {
          calls.push(input);
          throw new ChatNotificationDeliveryError("transient");
        },
      });
      assert.equal((await firstDispatcher.runOnce()).failed, 1);
      await harness.pool.query(
        `UPDATE ${deliveries}
         SET status = 'leased', attempt_count = attempt_count + 1,
             lease_token = 'crashed-worker-lease',
             lease_acquired_at = $1,
             lease_expires_at = $1::timestamptz + interval '1 second',
             last_error_class = NULL, last_error_at = NULL,
             updated_at = $1
         WHERE notification_kind = 'message.reminder'
           AND notification_metadata ->> 'messageId' = $2`,
        [now, fixture.messageId],
      );
      await firstDispatcher.stop();
      now = new Date(now.valueOf() + 2_000);
      const restartedDispatcher = worker({
        async send(input) { calls.push(input); },
      });
      assert.equal((await restartedDispatcher.runOnce()).delivered, 1);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].deliveryId, calls[1].deliveryId);
      assert.equal(calls[0].recipientUserId, fixture.ownerUserId);
    });

    for (const completion of ["success", "terminal failure"]) {
      await t.test(`stale ${completion} leaves the reclaimed lease and reminder unchanged`, async () => {
        const fixture = await seed({ suffix: `stale-${completion.replaceAll(" ", "-")}` });
        const first = gatedProvider(completion === "terminal failure" ? "permanent" : null);
        const second = gatedProvider(null);
        const runs = [];
        try {
          const firstRun = worker(first.adapter).runOnce();
          runs.push(firstRun);
          const firstInput = await enteredOrExited(first, firstRun);
          const original = await snapshot(fixture);

          now = new Date(now.valueOf() + 2_000);
          const secondRun = worker(second.adapter).runOnce();
          runs.push(secondRun);
          const secondInput = await enteredOrExited(second, secondRun);
          assert.equal(secondInput.deliveryId, firstInput.deliveryId);
          const reclaimed = await snapshot(fixture);
          assert.deepEqual(reclaimed.reminder, original.reminder);
          assert.equal(reclaimed.reminder.status, "active");
          assert.equal(reclaimed.reminder.materialized_revision, reclaimed.reminder.reminder_revision);
          assert.equal(reclaimed.delivery.status, "leased");
          assert.notEqual(reclaimed.delivery.lease_token, original.delivery.lease_token);
          assert.equal(reclaimed.delivery.attempt_count, original.delivery.attempt_count + 1);
          assert.equal(new Date(reclaimed.delivery.lease_acquired_at).valueOf(), now.valueOf());
          assert.equal(new Date(reclaimed.delivery.lease_expires_at).valueOf(), now.valueOf() + 1_000);
          assert.equal(reclaimed.delivery.last_error_class, null);
          assert.equal(reclaimed.delivery.last_error_at, null);

          first.release();
          assert.equal((await firstRun).delivered, 0);
          // JSONB preserves every field, including full timestamp precision.
          assert.deepEqual(await snapshot(fixture), reclaimed);

          second.release();
          assert.equal((await secondRun).delivered, 1);
          const finalized = await snapshot(fixture);
          assert.equal(finalized.reminder.status, "delivered");
          assert.equal(finalized.reminder.reminder_revision, reclaimed.reminder.reminder_revision + 1);
          assert.equal(finalized.reminder.materialized_revision, reclaimed.reminder.materialized_revision);
          assert.equal(finalized.reminder.materialized_at, reclaimed.reminder.materialized_at);
          assert.equal(new Date(finalized.reminder.delivered_at).valueOf(), now.valueOf());
          assert.equal(finalized.reminder.cancelled_at, null);
          assert.equal(finalized.delivery.status, "delivered");
          assert.equal(finalized.delivery.attempt_count, reclaimed.delivery.attempt_count);
          assert.equal(finalized.delivery.lease_token, null);
          assert.equal(finalized.delivery.lease_acquired_at, null);
          assert.equal(finalized.delivery.lease_expires_at, null);
          assert.equal(new Date(finalized.delivery.delivered_at).valueOf(), now.valueOf());
          assert.equal(finalized.delivery.last_error_class, null);
          assert.equal(finalized.delivery.last_error_at, null);
        } finally {
          first.release();
          second.release();
          await Promise.allSettled(runs);
        }
      });
    }

    await t.test("terminal failure is isolated from other owners", async () => {
      const rejected = await seed({ suffix: "terminal-rejected" });
      const delivered = await seed({
        suffix: "terminal-delivered",
        tenantId: "tenant-terminal-b",
      });
      const calls = [];
      const result = await worker({
        async send(input) {
          calls.push(input);
          if (input.messageId === rejected.messageId) {
            throw new ChatNotificationDeliveryError("permanent");
          }
        },
      }).runOnce();
      assert.equal(result.materialized, 2);
      assert.equal(result.claimed, 2);
      assert.equal(result.delivered, 1);
      assert.equal(result.failed, 1);
      assert.deepEqual(
        calls.map(({ tenantId, recipientUserId }) => [tenantId, recipientUserId]).sort(),
        [
          [delivered.tenantId, delivered.ownerUserId],
          [rejected.tenantId, rejected.ownerUserId],
        ].sort(),
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${outbox}
             WHERE type = 'message.reminder' AND published_at IS NULL`,
          )
        ).rows[0].count,
        0,
      );
    });
    const emptyBatch = {
      materialized: 0, claimed: 0, delivered: 0, suppressed: 0, failed: 0,
    };
    const assertRecovered = (original, recovered) => {
      assert.equal(original.delivery.status, "leased");
      assert.equal(original.delivery.attempt_count, 1);
      assert.ok(original.delivery.lease_token);
      assert.equal(recovered.delivery.status, "failed");
      assert.equal(recovered.delivery.attempt_count, 1);
      assert.equal(recovered.delivery.lease_token, null);
      assert.equal(recovered.delivery.lease_acquired_at, null);
      assert.equal(recovered.delivery.lease_expires_at, null);
      assert.equal(recovered.delivery.last_error_class, "unknown");
      assert.equal(new Date(recovered.delivery.last_error_at).valueOf(), now.valueOf());
      assert.equal(original.reminder.status, "active");
      assert.equal(original.reminder.materialized_revision, original.reminder.reminder_revision);
      assert.equal(recovered.reminder.status, "cancelled");
      assert.equal(recovered.reminder.reminder_revision, original.reminder.reminder_revision + 1);
      assert.equal(recovered.reminder.materialized_revision, original.reminder.materialized_revision);
      assert.equal(new Date(recovered.reminder.cancelled_at).valueOf(), now.valueOf());
    };
    // Remove only these fixtures, including future revisions, even on assertion
    // failure so the next recovery subtest cannot consume their rows.
    const removeFixtures = async (fixtures) => {
      for (const fixture of fixtures) {
        await harness.pool.query(
          `DELETE FROM ${deliveries}
           WHERE tenant_id = $1 AND recipient_host_user_id = $2`,
          [fixture.tenantId, fixture.ownerUserId],
        );
        await harness.pool.query(
          `DELETE FROM ${reminders}
           WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3`,
          [fixture.tenantId, fixture.ownerUserId, fixture.messageId],
        );
      }
    };

    for (const control of ["matching revision", "unexpired lease", "newer revision"]) {
      await t.test(`final-attempt recovery: ${control}`, async () => {
        const fixture = await seed({ suffix: `exhausted-${control.replaceAll(" ", "-")}` });
        const first = gatedProvider(null);
        const runs = [];
        const secondCalls = [];
        const second = worker({
          async send(input) { secondCalls.push(input); },
        }, { maxAttempts: 1 });
        try {
          const firstRun = worker(first.adapter, { maxAttempts: 1 }).runOnce();
          runs.push(firstRun);
          await enteredOrExited(first, firstRun);
          const original = await snapshot(fixture);
          assert.equal(original.delivery.status, "leased");
          assert.equal(original.delivery.attempt_count, 1);

          if (control === "newer revision") {
            await harness.pool.query(
              `UPDATE ${reminders}
               SET reminder_revision = reminder_revision + 1,
                   remind_at = $1::timestamptz + interval '1 day', updated_at = $1
               WHERE tenant_id = $2 AND user_id = $3 AND message_id = $4`,
              [now, fixture.tenantId, fixture.ownerUserId, fixture.messageId],
            );
          }
          const before = await snapshot(fixture);
          now = new Date(now.valueOf() + (control === "unexpired lease" ? 500 : 2_000));
          assert.equal(
            new Date(before.delivery.lease_expires_at).valueOf() > now.valueOf(),
            control === "unexpired lease",
          );
          // Recovery persists a failure without making a provider attempt or
          // contributing to any runOnce batch counter, including failed.
          assert.deepEqual(await second.runOnce(), emptyBatch);
          assert.equal(secondCalls.length, 0);
          const recovered = await snapshot(fixture);
          if (control === "unexpired lease") {
            assert.deepEqual(recovered, before);
          } else if (control === "newer revision") {
            assert.equal(before.reminder.reminder_revision, original.reminder.reminder_revision + 1);
            assert.ok(new Date(before.reminder.remind_at).valueOf() > now.valueOf());
            assert.deepEqual(recovered.reminder, before.reminder);
            assert.equal(recovered.delivery.status, "failed");
            assert.equal(recovered.delivery.attempt_count, 1);
            assert.equal(recovered.delivery.lease_token, null);
            assert.equal(recovered.delivery.lease_acquired_at, null);
            assert.equal(recovered.delivery.lease_expires_at, null);
          } else {
            assertRecovered(original, recovered);
          }

          first.release();
          const firstResult = await firstRun;
          assert.equal(firstResult.claimed, 1);
          // A made a provider attempt, but its fenced completion reports failure.
          assert.equal(firstResult.failed, control === "unexpired lease" ? 0 : 1);
          assert.equal(firstResult.delivered, control === "unexpired lease" ? 1 : 0);
          if (control === "unexpired lease") {
            const completed = await snapshot(fixture);
            assert.equal(completed.delivery.status, "delivered");
            assert.equal(completed.reminder.status, "delivered");
          } else {
            // Full JSONB rows retain timestamp precision for late-write fencing.
            assert.deepEqual(await snapshot(fixture), recovered);
            assert.deepEqual(await second.runOnce(), emptyBatch);
            assert.deepEqual(await snapshot(fixture), recovered);
          }
          assert.equal(secondCalls.length, 0);
        } finally {
          first.release();
          await Promise.allSettled(runs);
          await removeFixtures([fixture]);
        }
      });
    }

    await t.test("final-attempt recovery is bounded and drains without cancelling twice", async () => {
      const fixtures = [];
      const providers = [];
      const runs = [];
      const originals = [];
      const secondCalls = [];
      const second = worker({
        async send(input) { secondCalls.push(input); },
      }, { maxAttempts: 1, batchSize: 2 });
      try {
        // Three independently held final attempts exceed B's two-row limit.
        for (let index = 0; index < 3; index += 1) {
          const fixture = await seed({ suffix: `exhausted-batch-${index}` });
          fixtures.push(fixture);
          const provider = gatedProvider(null);
          providers.push(provider);
          const run = worker(provider.adapter, { maxAttempts: 1, batchSize: 1 }).runOnce();
          runs.push(run);
          await enteredOrExited(provider, run);
          originals.push(await snapshot(fixture));
        }
        now = new Date(now.valueOf() + 2_000);
        let previous = originals;
        for (const expectedFailed of [2, 3, 3]) {
          assert.deepEqual(await second.runOnce(), emptyBatch);
          const current = await Promise.all(fixtures.map(snapshot));
          assert.equal(current.filter(({ delivery }) => delivery.status === "failed").length, expectedFailed);
          for (let index = 0; index < current.length; index += 1) {
            if (previous[index].delivery.status === "failed") {
              assert.deepEqual(current[index], previous[index]);
            } else if (current[index].delivery.status === "failed") {
              assertRecovered(originals[index], current[index]);
            } else {
              assert.deepEqual(current[index], originals[index]);
            }
          }
          previous = current;
        }
        assert.equal(secondCalls.length, 0);
        providers.forEach((provider) => provider.release());
        for (const result of await Promise.all(runs)) {
          assert.equal(result.claimed, 1);
          assert.equal(result.delivered, 0);
          assert.equal(result.failed, 1);
        }
        assert.deepEqual(await Promise.all(fixtures.map(snapshot)), previous);
      } finally {
        providers.forEach((provider) => provider.release());
        await Promise.allSettled(runs);
        await removeFixtures(fixtures);
      }
    });
  } finally {
    await Promise.allSettled([...workers].map((dispatcher) => dispatcher.stop()));
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
