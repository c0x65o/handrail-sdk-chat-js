import assert from "node:assert/strict";
import test from "node:test";

import {
  MessageReminderParseError,
  parseMessageReminderListSnapshot,
} from "@handrail/chat";
import {
  MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION,
  SET_MESSAGE_REMINDER_AUDIT_ACTION,
  SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION,
  SET_MESSAGE_REMINDER_IDEMPOTENCY_OPERATION,
  SET_MESSAGE_REMINDER_OUTBOX_EVENT_TYPE,
  SetMessageReminderCommandError,
  createExpiredIdempotencyKeyMaintenanceJob,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  queryMessageReminderList,
  setMessageReminder,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["host-role"]),
});

const reminderInput = (suffix, overrides = {}) => ({
  operation: "message_reminder.v1",
  intent: "set",
  conversationId: "conversation-public",
  messageId: "message-public",
  expectedReminderRevision: 0,
  idempotencyKey: `message-reminder-${suffix}`,
  dueAt: "2099-01-02T12:00:00.000Z",
  ...overrides,
});

test("message reminders are transactional, actor-private, recoverable, and idempotent", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_reminder_cmd" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    reminders: `${schema}.chat_message_reminders`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let allowEntity = true;
  const permissionCalls = [];
  const permissions = {
    async authorizeEntity(request) {
      permissionCalls.push(request);
      return allowEntity;
    },
  };
  let nextId = 0;
  const command = (input, overrides = {}) =>
    setMessageReminder({
      database: harness.pool,
      schema: harness.schema,
      actor,
      permissions,
      input,
      createId: () => `message-reminder-event-${++nextId}`,
      ...overrides,
    });

  const seedMessage = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId,
    visibility = "public",
    memberState,
    entity,
    archived = false,
    deleted = false,
  }) => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id,
         current_message_sequence, archived_at, archived_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'channel', $3, $2, $4, $5, 1, $6, $7, $8, $8)`,
      [
        tenantId,
        conversationId,
        visibility,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? "2026-01-02T00:00:00.000Z" : null,
        archived ? "archiver" : null,
        createdAt,
      ],
    );
    if (memberState !== undefined) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
         VALUES ($1, $2, $3, 'member', $4, $5, $5)`,
        [tenantId, conversationId, actor.userId, memberState, createdAt],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, created_at, updated_at,
         deleted_at, deleted_by_user_id
       ) VALUES ($1, $2, $3, 1, 'author', $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        messageId,
        conversationId,
        `client-${tenantId}-${messageId}`,
        deleted ? null : { format: "plain", text: `secret-${messageId}` },
        createdAt,
        deleted ? "2026-01-02T00:00:00.000Z" : createdAt,
        deleted ? "2026-01-02T00:00:00.000Z" : null,
        deleted ? "deleter" : null,
      ],
    );
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await seedMessage({
      conversationId: "conversation-public",
      messageId: "message-public",
    });

    await t.test("sets, exactly replays, reschedules, deduplicates, and cancels", async () => {
      const initial = reminderInput("initial");
      const applied = await command(initial);
      const { dueAt: _dueAt, ...initialCorrelation } = initial;
      assert.deepEqual(applied, {
        ...initialCorrelation,
        reconciliationStatus: "applied",
        reminderRevision: 1,
        reminder: {
          privacy: "affected_authenticated_actor",
          state: "scheduled",
          dueAt: initial.dueAt,
        },
      });
      const replay = await command(initial);
      assert.deepEqual(replay, { ...applied, reconciliationStatus: "replayed" });

      await assert.rejects(
        command({ ...initial, dueAt: "2099-01-03T12:00:00.000Z" }),
        (error) =>
          error instanceof SetMessageReminderCommandError &&
          error.code === "idempotency_conflict",
      );

      const reschedule = reminderInput("reschedule", {
        expectedReminderRevision: 1,
        dueAt: "2099-02-01T12:00:00.000Z",
      });
      assert.equal((await command(reschedule)).reminderRevision, 2);
      const already = await command(reminderInput("already", {
        expectedReminderRevision: 2,
        dueAt: reschedule.dueAt,
      }));
      assert.equal(already.reconciliationStatus, "already-requested");
      assert.equal(already.reminderRevision, 2);

      const stale = await command(reminderInput("stale", {
        expectedReminderRevision: 1,
        dueAt: "2099-03-01T12:00:00.000Z",
      }));
      assert.equal(stale.reconciliationStatus, "revision-conflict");
      assert.equal(stale.reminderRevision, 2);
      assert.equal(stale.reminder.dueAt, reschedule.dueAt);

      const cancel = reminderInput("cancel", {
        intent: "cancel",
        expectedReminderRevision: 2,
        dueAt: undefined,
      });
      delete cancel.dueAt;
      const cancelled = await command(cancel);
      assert.equal(cancelled.reconciliationStatus, "applied");
      assert.equal(cancelled.reminderRevision, 3);
      assert.deepEqual(cancelled.reminder, {
        privacy: "affected_authenticated_actor",
        state: "cancelled",
      });
      const repeatedCancel = { ...cancel, expectedReminderRevision: 3, idempotencyKey: "message-reminder-cancel-again" };
      assert.equal((await command(repeatedCancel)).reconciliationStatus, "already-requested");

      const effects = (await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.audit}
             WHERE action = $1 AND target_id = 'message-public') AS audit_count,
           (SELECT count(*)::integer FROM ${tables.outbox}
             WHERE type = $2 AND payload->>'messageId' = 'message-public') AS outbox_count,
           (SELECT array_agg(DISTINCT stream_id ORDER BY stream_id) FROM ${tables.outbox}
             WHERE type = $2 AND payload->>'messageId' = 'message-public') AS streams`,
        [SET_MESSAGE_REMINDER_AUDIT_ACTION, SET_MESSAGE_REMINDER_OUTBOX_EVENT_TYPE],
      )).rows[0];
      assert.deepEqual(effects, {
        audit_count: 3,
        outbox_count: 3,
        streams: ["user:actor-a"],
      });
      const cancelAudit = (await harness.pool.query(
        `SELECT metadata FROM ${tables.audit}
          WHERE action = $1 AND target_id = 'message-public'
          ORDER BY occurred_at DESC, event_id DESC
          LIMIT 1`,
        [SET_MESSAGE_REMINDER_AUDIT_ACTION],
      )).rows[0].metadata;
      assert.deepEqual(cancelAudit, {
        conversationId: "conversation-public",
        messageId: "message-public",
        intent: "cancel",
        previousStatus: "active",
        currentStatus: "cancelled",
        previousReminderRevision: 2,
        currentReminderRevision: 3,
        previousDueAt: reschedule.dueAt,
        currentDueAt: null,
      });
      assert.equal(permissionCalls.every((call) =>
        call.action === SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION ||
        call.action === MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION), true);
    });

    await t.test("returns redacted unavailable-source for deleted, archived, inaccessible, cross-tenant, and host-denied sources", async () => {
      await seedMessage({ conversationId: "conversation-deleted", messageId: "message-deleted", deleted: true });
      await seedMessage({ conversationId: "conversation-archived", messageId: "message-archived", archived: true });
      await seedMessage({
        conversationId: "conversation-private",
        messageId: "message-private",
        visibility: "private",
        memberState: "left",
      });
      await seedMessage({
        conversationId: "conversation-entity",
        messageId: "message-entity",
        entity: { type: "case", id: "case-secret" },
      });
      await seedMessage({
        tenantId: "tenant-b",
        conversationId: "conversation-tenant-b",
        messageId: "message-tenant-b",
      });
      allowEntity = false;
      const cases = [
        ["deleted", "conversation-deleted", "message-deleted"],
        ["archived", "conversation-archived", "message-archived"],
        ["private", "conversation-private", "message-private"],
        ["entity", "conversation-entity", "message-entity"],
        ["tenant", "conversation-tenant-b", "message-tenant-b"],
      ];
      for (const [suffix, conversationId, messageId] of cases) {
        const result = await command(reminderInput(`unavailable-${suffix}`, { conversationId, messageId }));
        assert.equal(result.reconciliationStatus, "unavailable-source");
        assert.equal(result.reminderRevision, null);
        assert.equal(result.reminder, null);
      }
      allowEntity = true;
      const leakedEffects = (await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.reminders}
             WHERE message_id LIKE 'message-%' AND message_id <> 'message-public') AS reminders,
           (SELECT count(*)::integer FROM ${tables.outbox}
             WHERE type = $1 AND payload->>'messageId' <> 'message-public') AS outbox`,
        [SET_MESSAGE_REMINDER_OUTBOX_EVENT_TYPE],
      )).rows[0];
      assert.deepEqual(leakedEffects, { reminders: 0, outbox: 0 });
    });

    await t.test("isolates actor rows and recovers only active currently visible reminders", async () => {
      const activeInput = reminderInput("snapshot", {
        messageId: "message-public",
        expectedReminderRevision: 3,
        dueAt: "2099-04-01T12:00:00.000Z",
      });
      await command(activeInput);
      const actorB = { ...actor, userId: "actor-b" };
      await setMessageReminder({
        database: harness.pool,
        schema: harness.schema,
        actor: actorB,
        permissions,
        input: reminderInput("actor-b", { dueAt: "2099-05-01T12:00:00.000Z" }),
      });
      await seedMessage({
        conversationId: "conversation-access-loss",
        messageId: "message-access-loss",
        visibility: "private",
        memberState: "active",
      });
      await command(reminderInput("access-loss", {
        conversationId: "conversation-access-loss",
        messageId: "message-access-loss",
        dueAt: "2099-06-01T12:00:00.000Z",
      }));
      await harness.pool.query(
        `UPDATE ${tables.members}
            SET state = 'left', updated_at = clock_timestamp()
          WHERE tenant_id = 'tenant-a'
            AND conversation_id = 'conversation-access-loss'
            AND user_id = 'actor-a'`,
      );
      const input = { limit: 10 };
      const snapshot = await queryMessageReminderList({
        database: harness.pool,
        schema: harness.schema,
        actor,
        permissions,
        input,
      });
      assert.deepEqual(parseMessageReminderListSnapshot(snapshot, input), {
        kind: "message_reminder_list",
        privacy: "actor_private",
        items: [{
          conversationId: "conversation-public",
          messageId: "message-public",
          reminderRevision: 4,
          reminder: {
            privacy: "affected_authenticated_actor",
            state: "scheduled",
            dueAt: "2099-04-01T12:00:00.000000Z",
          },
        }],
        page: { nextCursor: null },
      });
      assert.equal(JSON.stringify(snapshot).includes("actor-b"), false);
    });

    await t.test("rejects past due input and revalidates against database time", async () => {
      await assert.rejects(
        command(reminderInput("past", { dueAt: "2020-01-01T00:00:00.000Z" })),
        (error) => error instanceof MessageReminderParseError && error.code === "due_time_not_future",
      );
      const dueAt = new Date(Date.now() + 250).toISOString();
      const delayedDatabase = {
        ...harness.pool,
        async connect() {
          const connection = await harness.pool.connect();
          return new Proxy(connection, {
            get(target, property, receiver) {
              if (property !== "query") return Reflect.get(target, property, receiver);
              return async (sql, values) => {
                if (sql === "SELECT clock_timestamp() AS occurred_at") {
                  await new Promise((resolve) => setTimeout(resolve, 350));
                }
                return target.query(sql, values);
              };
            },
          });
        },
      };
      await assert.rejects(
        command(reminderInput("transaction-past", {
          messageId: "message-public",
          expectedReminderRevision: 4,
          dueAt,
        }), { database: delayedDatabase }),
        (error) => error instanceof MessageReminderParseError && error.code === "due_time_not_future",
      );
    });

    await t.test("rolls back state, audit, outbox, and idempotency together", async () => {
      await seedMessage({ conversationId: "conversation-rollback", messageId: "message-rollback" });
      await harness.pool.query(
        `INSERT INTO ${tables.audit}
           (tenant_id, event_id, actor_user_id, action, target_type, target_id,
            occurred_at, metadata, request_id)
         VALUES ('tenant-a', 'duplicate-event', 'actor-a', 'seed', 'message',
                 'message-rollback', clock_timestamp(), '{}', 'duplicate-event')`,
      );
      await assert.rejects(command(reminderInput("rollback", {
        conversationId: "conversation-rollback",
        messageId: "message-rollback",
      }), { createId: () => "duplicate-event" }));
      const counts = (await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.reminders} WHERE message_id = 'message-rollback') AS reminders,
           (SELECT count(*)::integer FROM ${tables.outbox} WHERE payload->>'messageId' = 'message-rollback') AS outbox,
           (SELECT count(*)::integer FROM ${tables.audit} WHERE target_id = 'message-rollback') AS audit,
           (SELECT count(*)::integer FROM ${tables.idempotency}
             WHERE operation_name = $1 AND client_key = 'message-reminder-rollback') AS idempotency`,
        [SET_MESSAGE_REMINDER_IDEMPOTENCY_OPERATION],
      )).rows[0];
      assert.deepEqual(counts, { reminders: 0, outbox: 0, audit: 1, idempotency: 0 });
    });

    await t.test("uses the shared expiring idempotency-key cleanup contract", async () => {
      await seedMessage({ conversationId: "conversation-expiry", messageId: "message-expiry" });
      await command(reminderInput("expiry", {
        conversationId: "conversation-expiry",
        messageId: "message-expiry",
      }), { idempotencyTtlMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cleanup = createExpiredIdempotencyKeyMaintenanceJob({
        database: harness.pool,
        schema: harness.schema,
        batchSize: 100,
      });
      const result = await cleanup();
      assert.equal(result.deleted.some((entry) =>
        entry.operationName === SET_MESSAGE_REMINDER_IDEMPOTENCY_OPERATION &&
        entry.clientKey === "message-reminder-expiry"), true);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
