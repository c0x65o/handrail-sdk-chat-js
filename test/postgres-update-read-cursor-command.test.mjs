import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  ReadCursorMutationError,
  parseReadCursorUpdatedEvent,
} from "@handrail/chat";
import {
  ChatAuthorizationError,
  UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
  UpdateReadCursorCommandError,
  createPostgresMigrationRunner,
  editMessage,
  handrailChatPostgresMigrations,
  updateReadCursor,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "reader-a",
  roles: Object.freeze(["employee"]),
});
const crossTenantActor = Object.freeze({
  tenantId: "tenant-b",
  userId: "reader-a",
  roles: Object.freeze(["employee"]),
});

const markReadInput = (conversationId, throughSequence, suffix) => ({
  operation: "mark_read",
  conversationId,
  throughSequence,
  idempotencyKey: `read-cursor-${suffix}`,
});

const markUnreadInput = (conversationId, fromSequence, suffix) => ({
  operation: "mark_unread",
  conversationId,
  fromSequence,
  idempotencyKey: `read-cursor-${suffix}`,
});

test("update-read-cursor command is tenant-safe, monotonic, idempotent, and atomic", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_cursor_cmd" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    revisions: `${schema}.chat_message_revisions`,
    cursors: `${schema}.chat_read_cursors`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let nextId = 0;
  const createId = () => `read-cursor-command-${++nextId}`;
  const command = (input, overrides = {}) =>
    updateReadCursor({
      database: harness.pool,
      schema: harness.schema,
      actor,
      input,
      createId,
      ...overrides,
    });

  const seedConversation = async ({
    tenantId = "tenant-a",
    conversationId,
    currentSequence,
    memberUserId = "reader-a",
    memberState = "active",
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, current_message_sequence
       )
       VALUES ($1, $2, 'channel', 'private', $2, $3)`,
      [tenantId, conversationId, currentSequence],
    );
    if (memberUserId !== null) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', $4)`,
        [tenantId, conversationId, memberUserId, memberState],
      );
    }
  };

  const readCursor = async (tenantId, conversationId, userId = "reader-a") =>
    (
      await harness.pool.query(
        `SELECT
           last_read_sequence::integer AS last_read_sequence,
           manual_unread_from_sequence::integer AS manual_unread_from_sequence,
           updated_at
         FROM ${tables.cursors}
         WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
        [tenantId, conversationId, userId],
      )
    ).rows[0];

  const sideEffectCounts = async (tenantId, conversationId, idempotencyKey) =>
    (
      await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.cursors}
            WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3)
             AS cursor_count,
           (SELECT count(*)::integer FROM ${tables.audit}
            WHERE tenant_id = $1 AND target_type = 'conversation'
              AND target_id = $2 AND action = 'conversation.read_cursor_updated')
             AS audit_count,
           (SELECT count(*)::integer FROM ${tables.outbox}
            WHERE tenant_id = $1 AND stream_id = $4
              AND type = 'conversation.read_cursor_updated'
              AND payload->>'conversationId' = $2)
             AS outbox_count,
           (SELECT count(*)::integer FROM ${tables.idempotency}
            WHERE tenant_id = $1 AND user_id = $3
              AND operation_name = $5 AND client_key = $6)
             AS idempotency_count`,
        [
          tenantId,
          conversationId,
          actor.userId,
          `user:${actor.userId}`,
          UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
          idempotencyKey,
        ],
      )
    ).rows[0];

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("creates the first cursor and replays one private cross-device outcome exactly", async () => {
      const conversationId = "cursor-first-use";
      await seedConversation({ conversationId, currentSequence: 5 });
      const input = markReadInput(conversationId, 3, "first-use");

      const first = await command(input);

      assert.deepEqual(first, {
        operation: "mark_read",
        conversationId,
        readState: {
          conversationId,
          userId: actor.userId,
          lastReadSequence: 3,
          updatedAt: first.readState.updatedAt,
        },
        latestSequence: 5,
        unreadCount: 2,
      });
      const persistedCursor = await readCursor(actor.tenantId, conversationId);
      assert.equal(persistedCursor.last_read_sequence, 3);
      assert.equal(persistedCursor.manual_unread_from_sequence, null);
      assert.equal(persistedCursor.updated_at.toISOString(), first.readState.updatedAt);

      const sideEffects = (
        await harness.pool.query(
          `SELECT
             audit.action,
             audit.metadata,
             audit.metadata::text AS audit_text,
             event.event_id,
             event.protocol_version::integer AS protocol_version,
             event.tenant_id,
             event.stream_id,
             event.type,
             event.occurred_at,
             event.payload AS event_payload,
             outcome.state,
             outcome.response_status,
             outcome.response_body
           FROM ${tables.audit} AS audit
           INNER JOIN ${tables.outbox} AS event
            ON event.tenant_id = audit.tenant_id
            AND event.type = 'conversation.read_cursor_updated'
            AND event.stream_id = $4
            AND event.payload->>'conversationId' = $2
           INNER JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = audit.tenant_id
            AND outcome.user_id = $3
            AND outcome.operation_name = $5
            AND outcome.client_key = $6
           WHERE audit.tenant_id = $1
             AND audit.target_type = 'conversation'
             AND audit.target_id = $2
             AND audit.action = 'conversation.read_cursor_updated'`,
          [
            actor.tenantId,
            conversationId,
            actor.userId,
            `user:${actor.userId}`,
            UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
            input.idempotencyKey,
          ],
        )
      ).rows[0];

      assert.equal(sideEffects.action, "conversation.read_cursor_updated");
      assert.deepEqual(sideEffects.metadata, {
        operation: "mark_read",
        previousLastReadSequence: 0,
        lastReadSequence: 3,
        manualUnreadFromSequence: null,
        latestSequence: 5,
        unreadCount: 2,
      });
      assert.equal(sideEffects.audit_text.includes(input.idempotencyKey), false);
      assert.equal(sideEffects.audit_text.includes("credential"), false);
      assert.equal(sideEffects.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(sideEffects.stream_id, `user:${actor.userId}`);
      assert.equal(sideEffects.type, "conversation.read_cursor_updated");
      assert.deepEqual(sideEffects.event_payload, {
        kind: "conversation_read_cursor",
        actorUserId: actor.userId,
        ...first,
      });
      assert.deepEqual(
        parseReadCursorUpdatedEvent(
          {
            eventId: sideEffects.event_id,
            protocolVersion: sideEffects.protocol_version,
            tenantId: sideEffects.tenant_id,
            streamId: sideEffects.stream_id,
            type: sideEffects.type,
            occurredAt: sideEffects.occurred_at.toISOString(),
            payload: sideEffects.event_payload,
          },
          actor.tenantId,
        ).payload,
        sideEffects.event_payload,
      );
      assert.equal(sideEffects.state, "completed");
      assert.equal(sideEffects.response_status, 200);
      assert.deepEqual(sideEffects.response_body, first);

      const retry = await command(input);
      assert.deepEqual(retry, first);
      assert.deepEqual(
        await sideEffectCounts(actor.tenantId, conversationId, input.idempotencyKey),
        { cursor_count: 1, audit_count: 1, outbox_count: 1, idempotency_count: 1 },
      );
    });

    await t.test("advances monotonically and equal-sequence mark-read clears a manual marker", async () => {
      const conversationId = "cursor-monotonic";
      await seedConversation({ conversationId, currentSequence: 8 });
      const initialRead = await command(
        markReadInput(conversationId, 2, "monotonic-initial"),
      );
      const advancedRead = await command(
        markReadInput(conversationId, 6, "monotonic-advance"),
      );
      assert.equal(initialRead.readState.lastReadSequence, 2);
      assert.equal(advancedRead.readState.lastReadSequence, 6);
      const markedUnread = await command(
        markUnreadInput(conversationId, 4, "monotonic-unread"),
      );
      assert.equal(markedUnread.readState.lastReadSequence, 6);
      assert.equal(markedUnread.readState.manualUnreadFromSequence, 4);
      assert.equal(markedUnread.unreadCount, 5);

      const cleared = await command(
        markReadInput(conversationId, 6, "monotonic-clear"),
      );
      assert.equal(cleared.readState.lastReadSequence, 6);
      assert.equal(cleared.readState.manualUnreadFromSequence, undefined);
      assert.ok(
        Date.parse(cleared.readState.updatedAt) >
          Date.parse(markedUnread.readState.updatedAt),
      );

      for (const [invalidInput, code] of [
        [markReadInput(conversationId, 5, "monotonic-backward"), "cursor_regression"],
        [markReadInput(conversationId, 9, "monotonic-future"), "sequence_out_of_range"],
      ]) {
        await assert.rejects(
          command(invalidInput),
          (error) => error instanceof ReadCursorMutationError && error.code === code,
        );
      }
      const persisted = await readCursor(actor.tenantId, conversationId);
      assert.equal(persisted.last_read_sequence, 6);
      assert.equal(persisted.manual_unread_from_sequence, null);
      assert.equal(persisted.updated_at.toISOString(), cleared.readState.updatedAt);
    });

    await t.test("completes advancement when the serialized clock precedes the claim by microseconds", async () => {
      const conversationId = "cursor-submillisecond-claim";
      await seedConversation({ conversationId, currentSequence: 8 });
      await command(markReadInput(conversationId, 2, "precision-initial"));
      const input = markReadInput(conversationId, 6, "precision-advance");
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        conversationId, operation: "mark_read", throughSequence: 6,
      })).digest("hex")}`;
      // Seed a pending claim with guaranteed submillisecond precision. Only the
      // clock sample below is controlled; every command query runs on PostgreSQL.
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           created_at, updated_at, expires_at
         )
         SELECT $1, $2, $3, $4, $5, claimed_at, claimed_at,
                claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at`,
        [actor.tenantId, actor.userId, UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
          input.idempotencyKey, requestHash],
      )).rows[0];
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              const result = await connection.query(sql, values);
              if (sql.includes("clock_timestamp() AS occurred_at")) {
                result.rows[0].occurred_at = claim.created_at;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };

      const result = await command(input, { database: clockDatabase });
      assert.equal(result.readState.lastReadSequence, 6);
      assert.equal((await readCursor(actor.tenantId, conversationId)).last_read_sequence, 6);
      // Compare inside PostgreSQL so JavaScript Date cannot hide lost precision.
      const outcome = (await harness.pool.query(
        `SELECT completed_at = created_at AS completion_preserves_precision,
                updated_at = completed_at AS update_matches_completion,
                created_at - $5::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged,
                response_body
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = $3 AND client_key = $4`,
        [actor.tenantId, actor.userId, UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
          input.idempotencyKey, claim.created_at],
      )).rows[0];
      assert.deepEqual(outcome, {
        completion_preserves_precision: true,
        update_matches_completion: true,
        precision_gap: true,
        ttl_unchanged: true,
        response_body: result,
      });
      assert.deepEqual(await command(input), result);
      assert.deepEqual(await sideEffectCounts(actor.tenantId, conversationId, input.idempotencyKey),
        { cursor_count: 1, audit_count: 2, outbox_count: 2, idempotency_count: 1 });
    });

    await t.test("orders equal-sequence changes beyond a future cursor and replays the earlier outcome", async () => {
      const conversationId = "cursor-future-timestamp";
      await seedConversation({ conversationId, currentSequence: 8 });
      await harness.pool.query(
        `INSERT INTO ${tables.cursors} (
           tenant_id, conversation_id, user_id, last_read_sequence, updated_at
         )
         VALUES ($1, $2, $3, 6, clock_timestamp() + interval '1 day')`,
        [actor.tenantId, conversationId, actor.userId],
      );
      const seeded = await readCursor(actor.tenantId, conversationId);
      const unreadInput = markUnreadInput(conversationId, 4, "future-unread");
      const clearInput = markReadInput(conversationId, 6, "future-clear");
      const results = [];
      let previousTimestamp = seeded.updated_at.valueOf();
      const outboxRetentionMs = 60_000;
      const idempotencyTtlMs = 120_000;

      for (const input of [unreadInput, clearInput]) {
        const result = await command(input, { outboxRetentionMs, idempotencyTtlMs });
        results.push(result);
        const timestamp = Date.parse(result.readState.updatedAt);
        assert.ok(timestamp - previousTimestamp >= 1,
          "each cursor change must advance at least one serialized millisecond");
        previousTimestamp = timestamp;
        assert.equal(result.readState.lastReadSequence, 6);
        assert.equal(result.readState.manualUnreadFromSequence,
          input.operation === "mark_unread" ? 4 : undefined);
        assert.deepEqual(await readCursor(actor.tenantId, conversationId), {
          last_read_sequence: 6,
          manual_unread_from_sequence: result.readState.manualUnreadFromSequence ?? null,
          updated_at: new Date(result.readState.updatedAt),
        });

        const outcomes = await harness.pool.query(
          `SELECT response_body, completed_at, updated_at, expires_at
           FROM ${tables.idempotency}
           WHERE tenant_id = $1 AND user_id = $2
             AND operation_name = $3 AND client_key = $4`,
          [actor.tenantId, actor.userId, UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
            input.idempotencyKey],
        );
        assert.equal(outcomes.rows.length, 1);
        const outcome = outcomes.rows[0];
        assert.deepEqual(outcome.response_body, result);

        const events = await harness.pool.query(
          `SELECT stream_id, payload, occurred_at, expires_at
           FROM ${tables.outbox}
           WHERE tenant_id = $1 AND type = 'conversation.read_cursor_updated'
             AND payload->>'conversationId' = $2
             AND payload->'readState'->>'updatedAt' = $3`,
          [actor.tenantId, conversationId, result.readState.updatedAt],
        );
        assert.equal(events.rows.length, 1);
        const event = events.rows[0];
        assert.equal(event.stream_id, `user:${actor.userId}`);
        assert.deepEqual(event.payload, {
          kind: "conversation_read_cursor",
          actorUserId: actor.userId,
          ...result,
        });
        // Logical cursor ordering must not move wall-clock accounting or TTLs.
        assert.ok(event.occurred_at < seeded.updated_at);
        assert.equal(event.expires_at - event.occurred_at, outboxRetentionMs);
        assert.deepEqual(outcome.completed_at, event.occurred_at);
        assert.deepEqual(outcome.updated_at, event.occurred_at);
        assert.ok(outcome.expires_at < seeded.updated_at);
      }

      const latestCursor = await readCursor(actor.tenantId, conversationId);
      const counts = await sideEffectCounts(
        actor.tenantId, conversationId, unreadInput.idempotencyKey,
      );
      assert.deepEqual(counts,
        { cursor_count: 1, audit_count: 2, outbox_count: 2, idempotency_count: 1 });
      assert.deepEqual(await command(unreadInput), results[0]);
      assert.deepEqual(await readCursor(actor.tenantId, conversationId), latestCursor);
      assert.deepEqual(await sideEffectCounts(
        actor.tenantId, conversationId, unreadInput.idempotencyKey,
      ), counts);
    });

    await t.test("mark-unread preserves the durable cursor and rejects zero, future, and unread ranges", async () => {
      const conversationId = "cursor-unread-bounds";
      await seedConversation({ conversationId, currentSequence: 8 });
      await command(markReadInput(conversationId, 6, "bounds-read"));
      const valid = await command(markUnreadInput(conversationId, 3, "bounds-valid"));
      assert.equal(valid.readState.lastReadSequence, 6);
      assert.equal(valid.readState.manualUnreadFromSequence, 3);

      for (const [invalidInput, code] of [
        [markUnreadInput(conversationId, 0, "bounds-zero"), "invalid_sequence"],
        [markUnreadInput(conversationId, 9, "bounds-future"), "sequence_out_of_range"],
        [markUnreadInput(conversationId, 7, "bounds-unread-range"), "sequence_out_of_range"],
      ]) {
        await assert.rejects(
          command(invalidInput),
          (error) => error instanceof ReadCursorMutationError && error.code === code,
        );
      }
      const persisted = await readCursor(actor.tenantId, conversationId);
      assert.equal(persisted.last_read_sequence, 6);
      assert.equal(persisted.manual_unread_from_sequence, 3);
      assert.equal(persisted.updated_at.toISOString(), valid.readState.updatedAt);
    });

    await t.test("rejects inactive, non-member, and cross-tenant targets without leaking existence", async () => {
      await seedConversation({
        conversationId: "cursor-inactive",
        currentSequence: 2,
        memberState: "left",
      });
      await seedConversation({
        conversationId: "cursor-non-member",
        currentSequence: 2,
        memberUserId: null,
      });
      await seedConversation({
        conversationId: "cursor-cross-tenant",
        currentSequence: 2,
      });

      const cases = [
        [actor, markReadInput("cursor-inactive", 1, "auth-inactive")],
        [actor, markReadInput("cursor-non-member", 1, "auth-non-member")],
        [crossTenantActor, markReadInput("cursor-cross-tenant", 1, "auth-cross")],
      ];
      for (const [commandActor, input] of cases) {
        await assert.rejects(
          command(input, { actor: commandActor }),
          (error) =>
            error instanceof ChatAuthorizationError &&
            error.message === "Chat authorization failed",
        );
      }
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${tables.idempotency}
             WHERE client_key LIKE 'read-cursor-auth-%'`,
          )
        ).rows[0].count,
        0,
      );
    });

    await t.test("rejects conflicting reuse of an idempotency key", async () => {
      const conversationId = "cursor-idempotency-conflict";
      await seedConversation({ conversationId, currentSequence: 4 });
      const firstInput = markReadInput(conversationId, 2, "conflict");
      await command(firstInput);

      await assert.rejects(
        command({ ...firstInput, throughSequence: 3 }),
        (error) =>
          error instanceof UpdateReadCursorCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
      assert.equal(
        (await readCursor(actor.tenantId, conversationId)).last_read_sequence,
        2,
      );
      assert.deepEqual(
        await sideEffectCounts(
          actor.tenantId,
          conversationId,
          firstInput.idempotencyKey,
        ),
        { cursor_count: 1, audit_count: 1, outbox_count: 1, idempotency_count: 1 },
      );
    });

    await t.test("rolls back cursor, audit, outbox, and idempotency after a late failure", async () => {
      const conversationId = "cursor-rollback";
      await seedConversation({ conversationId, currentSequence: 4 });
      const input = markReadInput(conversationId, 3, "rollback");
      const lateFailureDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (
                typeof text === "string" &&
                text.includes("INSERT INTO") &&
                text.includes("chat_outbox_events")
              ) {
                throw new Error("injected late outbox failure");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };

      await assert.rejects(
        command(input, { database: lateFailureDatabase }),
        /injected late outbox failure/,
      );
      assert.deepEqual(
        await sideEffectCounts(actor.tenantId, conversationId, input.idempotencyKey),
        { cursor_count: 0, audit_count: 0, outbox_count: 0, idempotency_count: 0 },
      );
    });

    await t.test("editing an existing message leaves cursor values and updatedAt unchanged", async () => {
      const conversationId = "cursor-message-edit";
      const messageId = "cursor-message-edit-message";
      const createdAt = "2026-01-01T00:00:00.000Z";
      await seedConversation({ conversationId, currentSequence: 3 });
      await harness.pool.query(
        `INSERT INTO ${tables.messages} (
           tenant_id, id, conversation_id, sequence, author_user_id,
           client_message_id, content, created_at, updated_at
         )
         VALUES ($1, $2, $3, 3, $4, $5, $6, $7, $7)`,
        [
          actor.tenantId,
          messageId,
          conversationId,
          actor.userId,
          "cursor-edit-client-message",
          { format: "plain", text: "Original cursor-safe body" },
          createdAt,
        ],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.revisions} (
           tenant_id, message_id, revision_number, content,
           created_at, created_by_user_id
         )
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [
          actor.tenantId,
          messageId,
          { format: "plain", text: "Original cursor-safe body" },
          createdAt,
          actor.userId,
        ],
      );
      await command(markReadInput(conversationId, 3, "edit-preservation-read"));
      await command(markUnreadInput(conversationId, 2, "edit-preservation-unread"));
      const before = await readCursor(actor.tenantId, conversationId);

      await editMessage({
        database: harness.pool,
        schema: harness.schema,
        actor,
        permissions: {
          async getCapabilities() {
            return [];
          },
        },
        input: {
          operation: "edit",
          messageId,
          expectedRevision: 1,
          idempotencyKey: "cursor-message-edit-idempotency",
          content: { format: "plain", text: "Edited without unread regression" },
        },
        createId,
      });
      const after = await readCursor(actor.tenantId, conversationId);

      assert.deepEqual(after, before);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
