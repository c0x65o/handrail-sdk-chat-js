import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("audit migration stores immutable tenant-safe history", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_audit" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const outbox = `${schema}.chat_outbox_events`;
  const auditEvents = `${schema}.chat_audit_events`;

  const insertAuditEvent = async ({
    tenantId = "tenant-a",
    eventId,
    actorUserId = "actor-a",
    action = "message.updated",
    targetType = null,
    targetId = null,
    occurredAt = "2030-01-01T00:00:00Z",
    metadata = {},
    requestId = `request-${eventId}`,
    correlationId = null,
  }) =>
    harness.pool.query(
      `INSERT INTO ${auditEvents}
         (tenant_id, event_id, actor_user_id, action, target_type, target_id,
          occurred_at, metadata, request_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        tenantId,
        eventId,
        actorUserId,
        action,
        targetType,
        targetId,
        occurredAt,
        metadata,
        requestId,
        correlationId,
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
      ],
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'conversation-a', 'channel', 'private', 'Tenant A'),
         ('tenant-b', 'conversation-b', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'message-a', 'conversation-a', 1, 'author-a',
          'client-a', '{"format":"plain","text":"Sensitive body"}'),
         ('tenant-b', 'message-b', 'conversation-b', 1, 'author-b',
          'client-b', '{"format":"plain","text":"Other body"}')`,
    );

    await insertAuditEvent({
      eventId: "event-a-1",
      action: "conversation.created",
      targetType: "conversation",
      targetId: "conversation-a",
      occurredAt: "2030-01-01T00:00:00Z",
      metadata: { visibility: "private" },
      correlationId: "correlation-a",
    });
    await insertAuditEvent({
      eventId: "event-a-2",
      action: "message.updated",
      targetType: "message",
      targetId: "message-a",
      occurredAt: "2030-01-01T00:01:00Z",
      metadata: { revisionNumber: 2, fieldsChanged: ["format"] },
      correlationId: "correlation-a",
    });
    await insertAuditEvent({
      eventId: "event-a-3",
      actorUserId: null,
      action: "message.moderated",
      targetType: "message",
      targetId: "message-a",
      occurredAt: "2030-01-01T00:01:00Z",
      metadata: { reasonCode: "policy" },
    });
    await insertAuditEvent({
      tenantId: "tenant-b",
      eventId: "event-b-1",
      actorUserId: "actor-b",
      action: "erp_record.linked",
      targetType: "erp_order",
      targetId: "order-42",
      occurredAt: "2030-01-01T00:02:00Z",
      metadata: { sourceSystem: "host" },
    });

    await t.test("returns ordered tenant and target history with stable ties", async () => {
      const tenantHistory = await harness.pool.query(
        `SELECT event_id, actor_user_id, action, target_type, target_id,
                metadata, request_id, correlation_id
         FROM ${auditEvents}
         WHERE tenant_id = 'tenant-a'
         ORDER BY occurred_at DESC, event_id DESC`,
      );
      assert.deepEqual(
        tenantHistory.rows.map(({ event_id }) => event_id),
        ["event-a-3", "event-a-2", "event-a-1"],
      );
      assert.deepEqual(tenantHistory.rows[1], {
        event_id: "event-a-2",
        actor_user_id: "actor-a",
        action: "message.updated",
        target_type: "message",
        target_id: "message-a",
        metadata: { revisionNumber: 2, fieldsChanged: ["format"] },
        request_id: "request-event-a-2",
        correlation_id: "correlation-a",
      });

      const targetHistory = await harness.pool.query(
        `SELECT event_id
         FROM ${auditEvents}
         WHERE tenant_id = 'tenant-a'
           AND target_type = 'message'
           AND target_id = 'message-a'
         ORDER BY occurred_at DESC, event_id DESC`,
      );
      assert.deepEqual(
        targetHistory.rows.map(({ event_id }) => event_id),
        ["event-a-3", "event-a-2"],
      );
    });

    await t.test("isolates tenant history and validates known local targets", async () => {
      const tenantB = await harness.pool.query(
        `SELECT event_id, target_type, target_id
         FROM ${auditEvents}
         WHERE tenant_id = 'tenant-b'
         ORDER BY occurred_at DESC, event_id DESC`,
      );
      assert.deepEqual(tenantB.rows, [
        {
          event_id: "event-b-1",
          target_type: "erp_order",
          target_id: "order-42",
        },
      ]);

      await assert.rejects(
        insertAuditEvent({
          tenantId: "tenant-b",
          eventId: "cross-tenant-conversation",
          targetType: "conversation",
          targetId: "conversation-a",
        }),
        /chat_audit_events_conversation_target_fkey/,
      );
      await assert.rejects(
        insertAuditEvent({
          tenantId: "tenant-b",
          eventId: "cross-tenant-message",
          targetType: "chat_message",
          targetId: "message-a",
        }),
        /chat_audit_events_message_target_fkey/,
      );
    });

    await t.test("rejects malformed or sensitive audit facts", async () => {
      await assert.rejects(
        insertAuditEvent({ eventId: "bad-target-pair", targetType: "message" }),
        /chat_audit_events_target_pair_check/,
      );
      await assert.rejects(
        insertAuditEvent({ eventId: "bad-action", action: "   " }),
        /chat_audit_events_action_check/,
      );
      await assert.rejects(
        insertAuditEvent({ eventId: "bad-time", occurredAt: "infinity" }),
        /chat_audit_events_occurred_at_check/,
      );
      await assert.rejects(
        insertAuditEvent({ eventId: "bad-shape", metadata: ["identifier"] }),
        /chat_audit_events_metadata_check/,
      );
      await assert.rejects(
        insertAuditEvent({
          eventId: "oversized-metadata",
          metadata: { safeIdentifier: "x".repeat(65_537) },
        }),
        /chat_audit_events_metadata_check/,
      );

      for (const [eventId, metadata] of [
        ["message-body", { messageBody: "must not persist" }],
        ["access-token", { nested: { access_token: "must not persist" } }],
        ["auth-header", { headers: [{ Authorization: "Bearer secret" }] }],
        ["attachment-bytes", { attachment: { attachment_bytes: "AAEC" } }],
      ]) {
        await assert.rejects(
          insertAuditEvent({ eventId, metadata }),
          /chat_audit_events_metadata_check/,
        );
      }
    });

    await t.test("rejects update, delete, and truncate", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${auditEvents}
           SET action = 'message.deleted'
           WHERE tenant_id = 'tenant-a' AND event_id = 'event-a-2'`,
        ),
        /chat_audit_events are append-only/,
      );
      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${auditEvents}
           WHERE tenant_id = 'tenant-a' AND event_id = 'event-a-2'`,
        ),
        /chat_audit_events are append-only/,
      );
      await assert.rejects(
        harness.pool.query(`TRUNCATE ${auditEvents}`),
        /chat_audit_events are append-only/,
      );

      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count FROM ${auditEvents}`,
          )
        ).rows[0].count,
        4,
      );
    });

    await t.test("survives deletion of expired matching outbox delivery", async () => {
      await harness.pool.query(
        `INSERT INTO ${outbox}
           (event_id, protocol_version, tenant_id, stream_id, type,
            occurred_at, payload, expires_at)
         VALUES
           ('event-a-2', 4, 'tenant-a', 'conversation-a', 'message.updated',
            '2030-01-01T00:01:00Z', '{"messageId":"message-a"}',
            '2030-01-01T00:02:00Z')`,
      );
      await harness.pool.query(
        `DELETE FROM ${outbox}
         WHERE expires_at <= '2030-01-01T00:03:00Z'`,
      );

      const counts = (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${outbox}
              WHERE event_id = 'event-a-2') AS outbox_count,
             (SELECT count(*)::integer FROM ${auditEvents}
              WHERE tenant_id = 'tenant-a'
                AND event_id = 'event-a-2') AS audit_count`,
        )
      ).rows[0];
      assert.deepEqual(counts, { outbox_count: 0, audit_count: 1 });
    });

    await t.test("uses tenant and target history indexes", async () => {
      await harness.pool.query(
        `INSERT INTO ${auditEvents}
           (tenant_id, event_id, actor_user_id, action, target_type, target_id,
            occurred_at, metadata, request_id)
         SELECT
           'lookup-tenant',
           'lookup-event-' || lpad(value::text, 4, '0'),
           'lookup-actor',
           'erp_record.viewed',
           'erp_record',
           CASE WHEN value % 2 = 0 THEN 'record-lookup' ELSE 'record-other' END,
           '2030-01-01T00:00:00Z'::timestamptz
             + value * interval '1 second',
           jsonb_build_object('recordNumber', value),
           'lookup-request-' || value
         FROM generate_series(1, 600) AS value`,
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${auditEvents}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const tenantPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT event_id, actor_user_id, action, target_type, target_id,
                  request_id, correlation_id
           FROM ${auditEvents}
           WHERE tenant_id = 'lookup-tenant'
           ORDER BY occurred_at DESC, event_id DESC
           LIMIT 25`,
        );
        const targetPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT event_id, actor_user_id, action, request_id, correlation_id
           FROM ${auditEvents}
           WHERE tenant_id = 'lookup-tenant'
             AND target_type = 'erp_record'
             AND target_id = 'record-lookup'
           ORDER BY occurred_at DESC, event_id DESC
           LIMIT 25`,
        );

        assert.ok(
          findIndexes(tenantPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_audit_events_tenant_history_idx",
          ),
        );
        assert.ok(
          findIndexes(targetPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_audit_events_target_history_idx",
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
