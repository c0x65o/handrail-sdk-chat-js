import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { CHAT_PROTOCOL_VERSION, MessageMutationParseError } from "@handrail/chat";
import {
  ChatAuthorizationError,
  EditMessageCommandError,
  createPostgresMigrationRunner,
  editMessage,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const authorActor = Object.freeze({
  tenantId: "tenant-a",
  userId: "author-a",
  roles: Object.freeze(["employee"]),
});
const moderatorActor = Object.freeze({
  tenantId: "tenant-a",
  userId: "moderator-a",
  roles: Object.freeze(["moderator"]),
});
const unauthorizedActor = Object.freeze({
  tenantId: "tenant-a",
  userId: "other-a",
  roles: Object.freeze(["employee"]),
});
const crossTenantActor = Object.freeze({
  tenantId: "tenant-b",
  userId: "author-a",
  roles: Object.freeze(["employee"]),
});

const editInput = (messageId, suffix, overrides = {}) => ({
  operation: "edit",
  messageId,
  expectedRevision: 1,
  idempotencyKey: `edit-idempotency-${suffix}`,
  content: { format: "plain", text: `Edited ${suffix}` },
  ...overrides,
});

test("edit-message command is tenant-safe, revisioned, idempotent, and atomic", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_edit" });
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
  const createId = () => `edit-command-${++nextId}`;
  const permissions = {
    async getCapabilities({ actor }) {
      return actor.userId === "moderator-a" ? ["message.edit"] : [];
    },
  };
  const command = (input, overrides = {}) =>
    editMessage({
      database: harness.pool,
      schema: harness.schema,
      actor: authorActor,
      permissions,
      input,
      createId,
      ...overrides,
    });

  const seedMessage = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId,
    authorUserId = "author-a",
    currentRevision = 1,
    content = { format: "plain", text: `Original ${messageId}` },
    replyTo,
  }) => {
    const readerUserId = `reader-${conversationId}`;
    const createdAt = "2026-01-01T00:00:00.000Z";
    const editedAt = "2026-01-02T00:00:00.000Z";
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name,
         current_message_sequence, created_at, updated_at
       )
       VALUES ($1, $2, 'channel', 'private', $2, 7, $3, $3)`,
      [tenantId, conversationId, createdAt],
    );
    for (const userId of new Set([
      authorUserId,
      readerUserId,
      "moderator-a",
      "other-a",
    ])) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
         VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
        [tenantId, conversationId, userId, createdAt],
      );
    }
    if (replyTo !== undefined) {
      await harness.pool.query(
        `INSERT INTO ${tables.messages} (
           tenant_id, id, conversation_id, sequence, author_user_id,
           client_message_id, content, current_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, 6, $4, $5, $6, 1, $7, $7)`,
        [tenantId, replyTo.messageId, conversationId, readerUserId,
          `client-${replyTo.messageId}`,
          { format: "plain", text: "Which launch date?" }, createdAt],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.revisions} (
           tenant_id, message_id, revision_number, content,
           created_at, created_by_user_id
         ) VALUES ($1, $2, 1, $3, $4, $5)`,
        [tenantId, replyTo.messageId,
          { format: "plain", text: "Which launch date?" }, createdAt, readerUserId],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, current_revision, created_at, updated_at,
         edited_at, edited_by_user_id, reply_to_message_id, reply_notify_author
       )
       VALUES ($1, $2, $3, 7, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tenantId,
        messageId,
        conversationId,
        authorUserId,
        `client-${messageId}`,
        content,
        currentRevision,
        createdAt,
        currentRevision === 1 ? createdAt : editedAt,
        currentRevision === 1 ? null : editedAt,
        currentRevision === 1 ? null : authorUserId,
        replyTo?.messageId ?? null,
        replyTo?.notifyAuthor ?? false,
      ],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.revisions} (
         tenant_id, message_id, revision_number, content,
         created_at, created_by_user_id
       )
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        tenantId,
        messageId,
        currentRevision === 1
          ? content
          : { format: "plain", text: `Original ${messageId}` },
        createdAt,
        authorUserId,
      ],
    );
    if (currentRevision === 2) {
      await harness.pool.query(
        `INSERT INTO ${tables.revisions} (
           tenant_id, message_id, revision_number, content,
           created_at, created_by_user_id
         )
         VALUES ($1, $2, 2, $3, $4, $5)`,
        [tenantId, messageId, content, editedAt, authorUserId],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.cursors} (
         tenant_id, conversation_id, user_id, last_read_sequence,
         manual_unread_from_sequence, updated_at
       )
       VALUES ($1, $2, $3, 7, 5, $4)`,
      [tenantId, conversationId, readerUserId, createdAt],
    );
    return { readerUserId, createdAt };
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    for (const notifyAuthor of [true, false, undefined]) {
      const suffix = notifyAuthor === undefined ? "legacy" : `reply-${notifyAuthor}`;
      await t.test(`edits preserve ${suffix} metadata across results, events, and retries`, async () => {
        const messageId = `message-${suffix}`;
        const conversationId = `conversation-${suffix}`;
        const replyTo = notifyAuthor === undefined
          ? undefined
          : { messageId: `source-${suffix}`, notifyAuthor };
        await seedMessage({ messageId, conversationId, replyTo });
        const assertMessage = (message) => {
          assert.equal(message.id, messageId);
          assert.equal(message.conversationId, conversationId);
          assert.equal(message.sequence, 7);
          assert.equal(Object.hasOwn(message, "replyTo"), replyTo !== undefined);
          assert.deepEqual(message.replyTo, replyTo);
        };
        const input = editInput(messageId, suffix);
        const applied = await command(input);
        assert.equal(applied.reconciliationStatus, "applied");
        assert.equal(applied.canonicalRevision, 2);
        assertMessage(applied.message);

        const staleInput = editInput(messageId, `${suffix}-stale`);
        const conflict = await command(staleInput);
        assert.equal(conflict.reconciliationStatus, "revision_conflict");
        assert.equal(conflict.canonicalRevision, 2);
        assertMessage(conflict.message);
        assert.deepEqual(conflict.message, applied.message);

        const readState = async () => {
          const message = (await harness.pool.query(
            `SELECT conversation_id, sequence::integer, current_revision::integer,
                    reply_to_message_id, reply_notify_author, content
             FROM ${tables.messages} WHERE tenant_id = $1 AND id = $2`,
            [authorActor.tenantId, messageId],
          )).rows[0];
          const events = (await harness.pool.query(
            `SELECT type, payload FROM ${tables.outbox}
             WHERE tenant_id = $1 AND stream_id = $2 ORDER BY event_id`,
            [authorActor.tenantId, conversationId],
          )).rows;
          const counts = (await harness.pool.query(
            `SELECT
               (SELECT count(*)::integer FROM ${tables.revisions}
                WHERE tenant_id = $1 AND message_id = $2) AS revisions,
               (SELECT count(*)::integer FROM ${tables.audit}
                WHERE tenant_id = $1 AND target_id = $2) AS audits,
               (SELECT count(*)::integer FROM ${tables.idempotency}
                WHERE tenant_id = $1 AND client_key IN ($3, $4)) AS outcomes,
               (SELECT count(*)::integer FROM ${schema}.chat_notification_deliveries)
                 AS deliveries`,
            [authorActor.tenantId, messageId, input.idempotencyKey, staleInput.idempotencyKey],
          )).rows[0];
          return { message, events, counts };
        };
        const state = await readState();
        assert.deepEqual(state.message, {
          conversation_id: conversationId,
          sequence: 7,
          current_revision: 2,
          reply_to_message_id: replyTo?.messageId ?? null,
          reply_notify_author: notifyAuthor ?? false,
          content: input.content,
        });
        // Exactly one update, with no message.created notification source.
        assert.deepEqual(state.events, [
          { type: "message.updated", payload: { message: applied.message } },
        ]);
        assertMessage(state.events[0].payload.message);
        assert.deepEqual(state.counts, { revisions: 2, audits: 1, outcomes: 2, deliveries: 0 });

        const replayed = await command(input);
        assertMessage(replayed.message);
        assert.deepEqual(replayed, { ...applied, reconciliationStatus: "replayed" });
        const conflictRetry = await command(staleInput);
        assertMessage(conflictRetry.message);
        assert.deepEqual(conflictRetry, conflict);
        assert.deepEqual(await readState(), state);
      });
    }

    await t.test("author edit appends one immutable revision and preserves read position", async () => {
      const messageId = "message-author-success";
      const conversationId = "conversation-author-success";
      const { readerUserId, createdAt } = await seedMessage({
        conversationId,
        messageId,
      });
      const sensitiveText = "Private revised message body";
      const input = editInput(messageId, "author-success", {
        content: {
          format: "markdown",
          text: sensitiveText,
          blocks: [{ type: "host", data: { z: 1, a: 2 } }],
        },
      });

      const result = await command(input);

      assert.equal(result.operation, "edit");
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.expectedRevision, 1);
      assert.equal(result.canonicalRevision, 2);
      assert.equal(result.message.id, messageId);
      assert.equal(result.message.conversationId, conversationId);
      assert.deepEqual(result.message.author, {
        type: "user",
        userId: authorActor.userId,
      });
      assert.equal(result.message.sequence, 7);
      assert.equal(result.message.createdAt, createdAt);
      assert.equal(result.message.content.text, sensitiveText);
      assert.equal(result.message.revision.revision, 2);
      assert.equal(result.message.revision.editedByUserId, authorActor.userId);
      assert.equal(result.message.revision.editedAt, result.message.updatedAt);

      const state = (
        await harness.pool.query(
          `SELECT
             conversation.current_message_sequence::integer AS conversation_sequence,
             message.sequence::integer AS message_sequence,
             message.client_message_id,
             message.author_user_id,
             message.created_at,
             message.content,
             message.current_revision::integer AS current_revision,
             cursor.last_read_sequence::integer AS last_read_sequence,
             cursor.manual_unread_from_sequence::integer AS manual_unread_from_sequence,
             cursor.updated_at AS cursor_updated_at,
             (SELECT count(*)::integer FROM ${tables.revisions} AS revision
              WHERE revision.tenant_id = message.tenant_id
                AND revision.message_id = message.id) AS revision_count,
             (SELECT jsonb_agg(jsonb_build_object(
                'revision', revision.revision_number,
                'content', revision.content,
                'editor', revision.created_by_user_id
              ) ORDER BY revision.revision_number)
              FROM ${tables.revisions} AS revision
              WHERE revision.tenant_id = message.tenant_id
                AND revision.message_id = message.id) AS revision_history,
             audit.action AS audit_action,
             audit.metadata AS audit_metadata,
             audit.metadata::text AS audit_text,
             event.protocol_version::integer AS protocol_version,
             event.type AS event_type,
             event.stream_id,
             event.payload AS event_payload,
             outcome.state AS outcome_state,
             outcome.response_status,
             outcome.response_body
           FROM ${tables.messages} AS message
           JOIN ${tables.conversations} AS conversation
             ON conversation.tenant_id = message.tenant_id
            AND conversation.id = message.conversation_id
           JOIN ${tables.cursors} AS cursor
             ON cursor.tenant_id = message.tenant_id
            AND cursor.conversation_id = message.conversation_id
            AND cursor.user_id = $3
           JOIN ${tables.audit} AS audit
             ON audit.tenant_id = message.tenant_id
            AND audit.target_type = 'message'
            AND audit.target_id = message.id
           JOIN ${tables.outbox} AS event
             ON event.tenant_id = message.tenant_id
            AND event.stream_id = message.conversation_id
            AND event.type = 'message.updated'
           JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = message.tenant_id
            AND outcome.user_id = $4
            AND outcome.operation_name = 'message.edit'
            AND outcome.client_key = $5
           WHERE message.tenant_id = $1 AND message.id = $2`,
          [
            authorActor.tenantId,
            messageId,
            readerUserId,
            authorActor.userId,
            input.idempotencyKey,
          ],
        )
      ).rows[0];

      assert.equal(state.conversation_sequence, 7);
      assert.equal(state.message_sequence, 7);
      assert.equal(state.client_message_id, `client-${messageId}`);
      assert.equal(state.author_user_id, authorActor.userId);
      assert.equal(state.created_at.toISOString(), createdAt);
      assert.deepEqual(state.content, input.content);
      assert.equal(state.current_revision, 2);
      assert.equal(state.last_read_sequence, 7);
      assert.equal(state.manual_unread_from_sequence, 5);
      assert.equal(state.cursor_updated_at.toISOString(), createdAt);
      assert.equal(state.revision_count, 2);
      assert.deepEqual(state.revision_history, [
        {
          revision: 1,
          content: { format: "plain", text: `Original ${messageId}` },
          editor: authorActor.userId,
        },
        { revision: 2, content: input.content, editor: authorActor.userId },
      ]);
      assert.equal(state.audit_action, "message.updated");
      assert.deepEqual(state.audit_metadata, {
        conversationId,
        previousRevision: 1,
        currentRevision: 2,
      });
      assert.equal(state.audit_text.includes(sensitiveText), false);
      assert.equal(state.audit_text.includes(input.idempotencyKey), false);
      assert.equal(state.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(state.event_type, "message.updated");
      assert.equal(state.stream_id, conversationId);
      assert.deepEqual(state.event_payload, { message: result.message });
      assert.equal(state.outcome_state, "completed");
      assert.equal(state.response_status, 200);
      assert.deepEqual(state.response_body, result);

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${tables.revisions}
           SET content = '{"format":"plain","text":"tampered"}'
           WHERE tenant_id = $1 AND message_id = $2 AND revision_number = 1`,
          [authorActor.tenantId, messageId],
        ),
        /append-only/,
      );
    });

    await t.test("configured capability permits a non-author edit", async () => {
      const messageId = "message-moderator";
      await seedMessage({
        conversationId: "conversation-moderator",
        messageId,
      });

      const result = await command(editInput(messageId, "moderator"), {
        actor: moderatorActor,
      });

      assert.equal(result.reconciliationStatus, "applied");
      assert.deepEqual(result.message.author, {
        type: "user",
        userId: authorActor.userId,
      });
      assert.equal(result.message.revision.editedByUserId, moderatorActor.userId);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT revision_number::integer AS revision_number,
                    created_by_user_id
             FROM ${tables.revisions}
             WHERE tenant_id = 'tenant-a' AND message_id = $1
             ORDER BY revision_number`,
            [messageId],
          )
        ).rows,
        [
          { revision_number: 1, created_by_user_id: authorActor.userId },
          { revision_number: 2, created_by_user_id: moderatorActor.userId },
        ],
      );
    });

    await t.test("stale revision returns and stores the current canonical state", async () => {
      const messageId = "message-stale";
      const currentContent = { format: "plain", text: "Already revised" };
      await seedMessage({
        conversationId: "conversation-stale",
        messageId,
        currentRevision: 2,
        content: currentContent,
      });
      const input = editInput(messageId, "stale", {
        content: { format: "plain", text: "Stale replacement" },
      });

      const conflict = await command(input);
      const replayedConflict = await command(input);

      assert.equal(conflict.reconciliationStatus, "revision_conflict");
      assert.equal(conflict.expectedRevision, 1);
      assert.equal(conflict.canonicalRevision, 2);
      assert.deepEqual(conflict.message.content, currentContent);
      assert.deepEqual(replayedConflict, conflict);
      const state = (
        await harness.pool.query(
          `SELECT
             message.current_revision::integer AS revision,
             message.content,
             (SELECT count(*)::integer FROM ${tables.revisions}
              WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE tenant_id = message.tenant_id AND target_id = message.id) AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE tenant_id = message.tenant_id
                AND stream_id = message.conversation_id) AS outbox,
             outcome.state AS outcome_state,
             outcome.response_status,
             outcome.response_body
           FROM ${tables.messages} AS message
           JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = message.tenant_id
            AND outcome.user_id = $2
            AND outcome.operation_name = 'message.edit'
            AND outcome.client_key = $3
           WHERE message.tenant_id = 'tenant-a' AND message.id = $1`,
          [messageId, authorActor.userId, input.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(state, {
        revision: 2,
        content: currentContent,
        revisions: 2,
        audits: 0,
        outbox: 0,
        outcome_state: "completed",
        response_status: 409,
        response_body: conflict,
      });
    });

    await t.test("a fractional-millisecond claim completes and replays a revision conflict", async () => {
      const messageId = "message-edit-fractional-claim";
      const conversationId = "conversation-edit-fractional-claim";
      const content = { format: "plain", text: "Already edited" };
      await seedMessage({ conversationId, messageId, currentRevision: 2, content });
      const input = editInput(messageId, "fractional-claim");
      // Match editMessage's recursively sorted keys for this plain-content fixture.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        content: { format: input.content.format, text: input.content.text },
        expectedRevision: input.expectedRevision,
        messageId: input.messageId,
        operation: input.operation,
      })).digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           state, created_at, updated_at, expires_at
         )
         SELECT $1, $2, 'message.edit', $3, $4, 'pending',
                claimed_at, claimed_at, claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at`,
        [authorActor.tenantId, authorActor.userId, input.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              // PostgreSQL executes every query and transaction. Substitute only
              // the message observation clock with the truncated claim Date.
              const result = await connection.query(sql, values);
              if (sql.includes("clock_timestamp() AS observed_at") &&
                  sql.includes(`FROM ${tables.messages}`)) {
                assert.equal(result.rows.length, 1);
                result.rows[0].observed_at = claim.created_at;
                clockSamples += 1;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const messageState = async () => (await harness.pool.query(
        `SELECT to_jsonb(message) AS message,
           (SELECT jsonb_agg(revision ORDER BY revision_number)
            FROM ${tables.revisions} AS revision
            WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
           (SELECT coalesce(jsonb_agg(audit ORDER BY id), '[]'::jsonb)
            FROM ${tables.audit} AS audit
            WHERE tenant_id = message.tenant_id AND target_id = message.id) AS audits,
           (SELECT coalesce(jsonb_agg(event ORDER BY id), '[]'::jsonb)
            FROM ${tables.outbox} AS event
            WHERE tenant_id = message.tenant_id
              AND stream_id = message.conversation_id) AS outbox
         FROM ${tables.messages} AS message
         WHERE tenant_id = $1 AND id = $2`,
        [authorActor.tenantId, messageId],
      )).rows;
      const before = await messageState();
      assert.equal(before.length, 1);
      assert.equal(before[0].revisions.length, 2);
      assert.deepEqual(before[0].audits, []);
      assert.deepEqual(before[0].outbox, []);

      const conflict = await command(input, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.equal(conflict.reconciliationStatus, "revision_conflict");
      assert.equal(conflict.expectedRevision, 1);
      assert.equal(conflict.canonicalRevision, 2);
      assert.deepEqual(conflict.message.content, content);
      const storedOutcome = async () => (await harness.pool.query(
        `SELECT state, response_status, response_body,
                created_at::text, updated_at::text, completed_at::text, expires_at::text,
                completed_at = created_at AS completion_equals_claim,
                updated_at = created_at AS update_equals_claim,
                created_at - $4::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = 'message.edit' AND client_key = $3`,
        [authorActor.tenantId, authorActor.userId, input.idempotencyKey, claim.created_at],
      )).rows;
      const outcome = await storedOutcome();
      assert.equal(outcome.length, 1);
      assert.equal(outcome[0].state, "completed");
      assert.equal(outcome[0].response_status, 409);
      assert.deepEqual(outcome[0].response_body, conflict);
      for (const field of ["completion_equals_claim", "update_equals_claim",
        "precision_gap", "ttl_unchanged"]) {
        assert.equal(outcome[0][field], true, field);
      }
      // Text retains PostgreSQL microseconds that JavaScript Date discards.
      assert.equal(outcome[0].completed_at, outcome[0].created_at);
      assert.equal(outcome[0].updated_at, outcome[0].created_at);
      assert.deepEqual(await messageState(), before);

      assert.deepEqual(await command(input), conflict);
      assert.equal(clockSamples, 1);
      assert.deepEqual(await storedOutcome(), outcome);
      assert.deepEqual(await messageState(), before);
    });

    await t.test("unauthorized and cross-tenant actors receive sanitized rejection", async () => {
      const messageId = "message-authorization";
      await seedMessage({
        conversationId: "conversation-authorization",
        messageId,
      });

      for (const [actor, suffix] of [
        [unauthorizedActor, "unauthorized"],
        [crossTenantActor, "cross-tenant"],
      ]) {
        await assert.rejects(
          command(editInput(messageId, suffix), { actor }),
          (error) =>
            error instanceof ChatAuthorizationError &&
            error.statusCode === 403 &&
            error.message === "Chat authorization failed",
        );
      }
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT
               current_revision::integer AS revision,
               (SELECT count(*)::integer FROM ${tables.idempotency}
                WHERE client_key IN ($2, $3)) AS idempotency_count
             FROM ${tables.messages}
             WHERE tenant_id = 'tenant-a' AND id = $1`,
            [
              messageId,
              "edit-idempotency-unauthorized",
              "edit-idempotency-cross-tenant",
            ],
          )
        ).rows[0],
        { revision: 1, idempotency_count: 0 },
      );
    });

    await t.test("completed retry is exact except replay status and has no duplicate side effects", async () => {
      const messageId = "message-idempotent";
      await seedMessage({
        conversationId: "conversation-idempotent",
        messageId,
      });
      const input = editInput(messageId, "canonical", {
        content: {
          format: "markdown",
          text: "Canonical edit",
          blocks: [{ type: "host", data: { z: 1, a: 2 } }],
        },
      });

      const applied = await command(input);
      const replayed = await command({
        ...input,
        content: {
          format: "markdown",
          text: "Canonical edit",
          blocks: [{ type: "host", data: { a: 2, z: 1 } }],
        },
      });

      assert.deepEqual(replayed, {
        ...applied,
        reconciliationStatus: "replayed",
      });
      const counts = (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${tables.revisions}
              WHERE tenant_id = 'tenant-a' AND message_id = $1) AS revisions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE tenant_id = 'tenant-a' AND stream_id = $2) AS outbox`,
          [messageId, "conversation-idempotent"],
        )
      ).rows[0];
      assert.deepEqual(counts, { revisions: 2, audits: 1, outbox: 1 });

      await assert.rejects(
        command({
          ...input,
          content: { format: "plain", text: "Conflicting reuse" },
        }),
        (error) =>
          error instanceof EditMessageCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
    });

    await t.test("injected late failure rolls back every edit side effect", async () => {
      const messageId = "message-rollback";
      const conversationId = "conversation-rollback";
      const { readerUserId, createdAt } = await seedMessage({
        conversationId,
        messageId,
      });
      const lateFailureDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(text, values) {
              if (
                typeof text === "string" &&
                text.includes("chat_outbox_events") &&
                text.includes("INSERT INTO")
              ) {
                throw new Error("injected late outbox failure");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };
      const input = editInput(messageId, "rollback");

      await assert.rejects(
        command(input, { database: lateFailureDatabase }),
        /injected late outbox failure/,
      );

      const state = (
        await harness.pool.query(
          `SELECT
             conversation.current_message_sequence::integer AS conversation_sequence,
             message.sequence::integer AS message_sequence,
             message.current_revision::integer AS revision,
             message.content,
             message.edited_at,
             cursor.last_read_sequence::integer AS last_read_sequence,
             cursor.manual_unread_from_sequence::integer AS manual_unread_from_sequence,
             cursor.updated_at,
             (SELECT count(*)::integer FROM ${tables.revisions}
              WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE tenant_id = message.tenant_id AND target_id = message.id) AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE tenant_id = message.tenant_id
                AND stream_id = message.conversation_id) AS outbox,
             (SELECT count(*)::integer FROM ${tables.idempotency}
              WHERE tenant_id = message.tenant_id AND client_key = $4) AS idempotency
           FROM ${tables.messages} AS message
           JOIN ${tables.conversations} AS conversation
             ON conversation.tenant_id = message.tenant_id
            AND conversation.id = message.conversation_id
           JOIN ${tables.cursors} AS cursor
             ON cursor.tenant_id = message.tenant_id
            AND cursor.conversation_id = message.conversation_id
            AND cursor.user_id = $3
           WHERE message.tenant_id = $1 AND message.id = $2`,
          [authorActor.tenantId, messageId, readerUserId, input.idempotencyKey],
        )
      ).rows[0];
      assert.equal(state.conversation_sequence, 7);
      assert.equal(state.message_sequence, 7);
      assert.equal(state.revision, 1);
      assert.deepEqual(state.content, {
        format: "plain",
        text: `Original ${messageId}`,
      });
      assert.equal(state.edited_at, null);
      assert.equal(state.last_read_sequence, 7);
      assert.equal(state.manual_unread_from_sequence, 5);
      assert.equal(state.updated_at.toISOString(), createdAt);
      assert.equal(state.revisions, 1);
      assert.equal(state.audits, 0);
      assert.equal(state.outbox, 0);
      assert.equal(state.idempotency, 0);
    });

    await t.test("caller-supplied trusted identity is rejected before access", async () => {
      await assert.rejects(
        command({
          ...editInput("message-author-success", "spoofed"),
          tenantId: "tenant-b",
        }),
        (error) =>
          error instanceof MessageMutationParseError &&
          error.code === "trusted_identity_field",
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
