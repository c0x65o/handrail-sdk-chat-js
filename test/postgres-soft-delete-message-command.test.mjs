import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  parseKnownDurableEvent,
  parseSoftDeleteMessageResult,
} from "@handrail/chat";
import {
  SOFT_DELETE_MESSAGE_MODERATION_CAPABILITY,
  ChatAuthorizationError,
  SoftDeleteMessageCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  queryMessageTimeline,
  softDeleteMessage,
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

const deletionInput = (messageId, suffix, overrides = {}) => ({
  operation: "soft_delete",
  messageId,
  expectedRevision: 1,
  idempotencyKey: `delete-idempotency-${suffix}`,
  ...overrides,
});

test("soft-delete-message is tenant-safe, revision-aware, idempotent, and atomic", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_delete" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    revisions: `${schema}.chat_message_revisions`,
    reactions: `${schema}.chat_reactions`,
    cursors: `${schema}.chat_read_cursors`,
    follows: `${schema}.chat_thread_follows`,
    attachments: `${schema}.chat_attachments`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const permissions = {
    async getCapabilities({ actor }) {
      return actor.userId === moderatorActor.userId
        ? [SOFT_DELETE_MESSAGE_MODERATION_CAPABILITY]
        : [];
    },
    async authorizeEntity() {
      return true;
    },
  };
  const storage = {
    async createDownloadUrl() {
      throw new Error("deleted attachment metadata must not be projected");
    },
  };
  let nextId = 0;
  const createId = () => `delete-command-${++nextId}`;
  const command = (input, overrides = {}) =>
    softDeleteMessage({
      database: harness.pool,
      schema: harness.schema,
      actor: authorActor,
      permissions,
      input,
      createId,
      ...overrides,
    });
  const timeline = (conversationId, actor = authorActor) =>
    queryMessageTimeline({
      database: harness.pool,
      schema: harness.schema,
      actor,
      permissions,
      storage,
      input: { conversationId, direction: "forward", limit: 100 },
    });

  const seedMessage = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId,
    authorUserId = authorActor.userId,
    sequence = 7,
    currentRevision = 1,
    content = { format: "plain", text: `Original ${messageId}` },
    replyTo,
  }) => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const editedAt = "2026-01-02T00:00:00.000Z";
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name,
         current_message_sequence, created_at, updated_at
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4, $4)`,
      [tenantId, conversationId, sequence, createdAt],
    );
    for (const userId of new Set([
      authorUserId,
      authorActor.userId,
      moderatorActor.userId,
      unauthorizedActor.userId,
    ])) {
      await harness.pool.query(
        `INSERT INTO ${tables.members} (
           tenant_id, conversation_id, user_id, role, state,
           joined_at, updated_at
         ) VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
        [tenantId, conversationId, userId, createdAt],
      );
    }
    if (replyTo !== undefined) {
      await harness.pool.query(
        `INSERT INTO ${tables.messages} (
           tenant_id, id, conversation_id, sequence, author_user_id,
           client_message_id, content, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [tenantId, replyTo.messageId, conversationId, sequence - 1,
          authorUserId, `client-${replyTo.messageId}`,
          { format: "plain", text: "Reply source" }, createdAt],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.revisions} (
           tenant_id, message_id, revision_number, content,
           created_at, created_by_user_id
         ) VALUES ($1, $2, 1, $3, $4, $5)`,
        [tenantId, replyTo.messageId, { format: "plain", text: "Reply source" },
          createdAt, authorUserId],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, current_revision, created_at, updated_at,
         edited_at, edited_by_user_id, reply_to_message_id, reply_notify_author
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        tenantId,
        messageId,
        conversationId,
        sequence,
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
       ) VALUES ($1, $2, 1, $3, $4, $5)`,
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
         ) VALUES ($1, $2, 2, $3, $4, $5)`,
        [tenantId, messageId, content, editedAt, authorUserId],
      );
    }
    return { createdAt, editedAt };
  };

  const persistedState = async (messageId, conversationId, input) => (
    await harness.pool.query(
      `SELECT to_jsonb(message) AS message,
         (SELECT jsonb_agg(revision ORDER BY revision_number)
          FROM ${tables.revisions} AS revision
          WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
         (SELECT coalesce(jsonb_agg(audit ORDER BY id), '[]'::jsonb)
          FROM ${tables.audit} AS audit
          WHERE tenant_id = message.tenant_id AND target_id = message.id) AS audits,
         (SELECT coalesce(jsonb_agg(event ORDER BY id), '[]'::jsonb)
          FROM ${tables.outbox} AS event
          WHERE tenant_id = message.tenant_id AND stream_id = $2) AS events,
         (SELECT response_body FROM ${tables.idempotency}
          WHERE tenant_id = message.tenant_id AND user_id = $3
            AND operation_name = 'message.soft_delete' AND client_key = $4) AS outcome
       FROM ${tables.messages} AS message
       WHERE tenant_id = 'tenant-a' AND id = $1`,
      [messageId, conversationId, authorActor.userId, input.idempotencyKey],
    )
  ).rows[0];

  const injectInsertFailure = (tableName, message) => ({
    query: harness.pool.query.bind(harness.pool),
    async connect() {
      const connection = await harness.pool.connect();
      return {
        async query(text, values) {
          if (
            typeof text === "string" &&
            text.includes(`INSERT INTO ${tableName}`)
          ) {
            throw new Error(message);
          }
          return connection.query(text, values);
        },
        release: () => connection.release(),
      };
    },
  });

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    for (const notifyAuthor of [true, false, undefined]) {
      const label = notifyAuthor === undefined ? "legacy" : `ping-${notifyAuthor}`;
      await t.test(`deletion and replay retain reply metadata (${label})`, async () => {
        const messageId = `message-delete-reply-${label}`;
        const conversationId = `conversation-delete-reply-${label}`;
        const replyTo = notifyAuthor === undefined ? undefined : {
          messageId: `source-delete-reply-${label}`, notifyAuthor,
        };
        const { createdAt } = await seedMessage({ conversationId, messageId, replyTo });
        const input = deletionInput(messageId, `reply-${label}`);
        const applied = await command(input);
        const assertShell = (message) => {
          assert.equal(message.id, messageId);
          assert.equal(message.tenantId, authorActor.tenantId);
          assert.equal(message.conversationId, conversationId);
          assert.deepEqual(message.author, { type: "user", userId: authorActor.userId });
          assert.equal(message.sequence, 7);
          assert.equal(message.createdAt, createdAt);
          assert.equal(message.content, null);
          assert.equal(message.revision.revision, 2);
          assert.equal(message.deletedByUserId, authorActor.userId);
          assert.equal(message.deletedAt, message.updatedAt);
          assert.deepEqual(message.replyTo, replyTo);
          assert.equal(Object.hasOwn(message, "replyTo"), replyTo !== undefined);
        };
        assert.equal(applied.reconciliationStatus, "applied");
        assertShell(applied.message);
        assert.deepEqual(parseSoftDeleteMessageResult(applied), applied);
        assertShell((await timeline(conversationId)).messages.find(({ id }) => id === messageId));

        const stored = await persistedState(messageId, conversationId, input);
        assert.equal(stored.message.content, null);
        assert.equal(stored.message.reply_to_message_id, replyTo?.messageId ?? null);
        assert.equal(stored.message.reply_notify_author, notifyAuthor ?? false);
        assert.equal(stored.revisions.length, 1);
        assert.equal(stored.audits.length, 1);
        assert.equal(stored.events.length, 1);
        assert.deepEqual(stored.outcome, applied);
        assertShell(parseSoftDeleteMessageResult(stored.outcome).message);
        const event = stored.events[0];
        assert.equal(event.type, "message.deleted");
        assert.deepEqual(event.payload, { message: applied.message });
        const parsedEvent = parseKnownDurableEvent({
          eventId: event.event_id,
          protocolVersion: event.protocol_version,
          tenantId: event.tenant_id,
          streamId: event.stream_id,
          type: event.type,
          occurredAt: new Date(event.occurred_at).toISOString(),
          payload: event.payload,
        }, authorActor);
        assertShell(parsedEvent.payload.message);
        assert.deepEqual(parsedEvent.payload, event.payload);

        const allocatedIds = nextId;
        const replayed = await command(input);
        assert.deepEqual(replayed, { ...applied, reconciliationStatus: "replayed" });
        assertShell(parseSoftDeleteMessageResult(replayed).message);
        assert.equal(nextId, allocatedIds);
        assert.deepEqual(await persistedState(messageId, conversationId, input), stored);
      });
    }

    for (const notifyAuthor of [true, false]) {
      await t.test(`reply revision conflict and replay have no deletion effects (ping-${notifyAuthor})`, async () => {
        const messageId = `message-reply-conflict-${notifyAuthor}`;
        const conversationId = `conversation-reply-conflict-${notifyAuthor}`;
        const replyTo = { messageId: `source-reply-conflict-${notifyAuthor}`, notifyAuthor };
        await seedMessage({ conversationId, messageId, replyTo, currentRevision: 2 });
        const input = deletionInput(messageId, `reply-conflict-${notifyAuthor}`);
        const before = await persistedState(messageId, conversationId, input);
        const allocatedIds = nextId;
        const conflict = await command(input);
        assert.equal(conflict.reconciliationStatus, "revision_conflict");
        assert.equal(conflict.canonicalRevision, 2);
        assert.equal(conflict.message.id, messageId);
        assert.equal(conflict.message.sequence, 7);
        assert.deepEqual(conflict.message.replyTo, replyTo);
        assert.deepEqual(conflict.message.content, before.message.content);
        assert.deepEqual(parseSoftDeleteMessageResult(conflict), conflict);
        const stored = await persistedState(messageId, conversationId, input);
        assert.deepEqual(stored, { ...before, outcome: conflict });
        assert.deepEqual(parseSoftDeleteMessageResult(stored.outcome), conflict);
        assert.deepEqual(await command(input), conflict);
        assert.equal(nextId, allocatedIds);
        assert.deepEqual(await persistedState(messageId, conversationId, input), stored);
      });
    }

    await t.test("deleting a source retains its inline child and revision history", async () => {
      const messageId = "message-source-delete-child";
      const conversationId = "conversation-source-delete-child";
      const replyTo = { messageId: "message-source-delete", notifyAuthor: false };
      const content = { format: "plain", text: "Edited child reply" };
      await seedMessage({ conversationId, messageId, replyTo, content, currentRevision: 2 });
      const input = deletionInput(replyTo.messageId, "source-delete");
      const before = await persistedState(messageId, conversationId, input);
      const timelineBefore = await timeline(conversationId);
      assert.equal(before.revisions.length, 2);
      assert.deepEqual(before.revisions.map(({ content }) => content.text), [
        `Original ${messageId}`, content.text,
      ]);

      const deleted = await command(input);
      assert.equal(deleted.message.id, replyTo.messageId);
      assert.equal(deleted.message.content, null);
      const after = await persistedState(messageId, conversationId, input);
      assert.deepEqual(after.message, before.message);
      assert.deepEqual(after.revisions, before.revisions);
      assert.deepEqual(after.audits, []);
      const reloaded = await timeline(conversationId);
      assert.equal(reloaded.messages.length, 2);
      const child = reloaded.messages.find(({ id }) => id === messageId);
      assert.deepEqual(child, timelineBefore.messages.find(({ id }) => id === messageId));
      assert.deepEqual(child.replyTo, replyTo);
      assert.deepEqual(child.content, content);
      assert.equal(reloaded.messages.find(({ id }) => id === replyTo.messageId).content, null);
    });

    await t.test("author deletion keeps identity, sequence, history, attachments, and reactions", async () => {
      const conversationId = "conversation-author-delete";
      const messageId = "message-author-delete";
      const sensitiveText = "Sensitive current message content";
      const { createdAt, editedAt } = await seedMessage({
        conversationId,
        messageId,
        currentRevision: 2,
        content: { format: "markdown", text: sensitiveText },
      });
      await harness.pool.query(
        `INSERT INTO ${tables.reactions} (
           tenant_id, message_id, user_id, reaction_key, created_at, updated_at
         ) VALUES ('tenant-a', $1, 'other-a', 'eyes', $2, $2)`,
        [messageId, editedAt],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.attachments} (
           tenant_id, id, uploader_user_id, storage_key, file_name,
           content_type, size_bytes, created_at, updated_at, expires_at
         ) VALUES ('tenant-a', $1, 'author-a', $2, 'secret.txt',
           'text/plain', 10, $3, $3, '2099-01-01T00:00:00Z')`,
        [`attachment-${messageId}`, `tenant-a/${messageId}`, createdAt],
      );
      await harness.pool.query(
        `UPDATE ${tables.attachments}
         SET state = 'attached', attached_message_id = $1, checksum = $2,
             attached_at = $3, updated_at = $3
         WHERE tenant_id = 'tenant-a' AND id = $4`,
        [
          messageId,
          `sha256:${"a".repeat(64)}`,
          editedAt,
          `attachment-${messageId}`,
        ],
      );
      const input = deletionInput(messageId, "author-delete", {
        expectedRevision: 2,
      });

      const result = await command(input);

      assert.equal(result.operation, "soft_delete");
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.canonicalRevision, 3);
      assert.equal(result.message.id, messageId);
      assert.equal(result.message.conversationId, conversationId);
      assert.deepEqual(result.message.author, {
        type: "user",
        userId: authorActor.userId,
      });
      assert.equal(result.message.sequence, 7);
      assert.equal(result.message.createdAt, createdAt);
      assert.equal(result.message.content, null);
      assert.equal(result.message.deletedByUserId, authorActor.userId);
      assert.equal(result.message.deletedAt, result.message.updatedAt);
      assert.deepEqual(result.message.revision, {
        revision: 3,
        editedAt,
        editedByUserId: authorActor.userId,
      });
      assert.equal(result.message.threadSummary, undefined);

      const state = (
        await harness.pool.query(
          `SELECT
             conversation.current_message_sequence::integer AS conversation_sequence,
             message.sequence::integer AS message_sequence,
             message.author_user_id, message.client_message_id,
             message.created_at, message.edited_at, message.edited_by_user_id,
             message.content, message.current_revision::integer AS revision,
             message.deleted_at, message.deleted_by_user_id,
             (SELECT count(*)::integer FROM ${tables.revisions}
              WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
             (SELECT count(*)::integer FROM ${tables.reactions}
              WHERE tenant_id = message.tenant_id AND message_id = message.id) AS reactions,
             (SELECT count(*)::integer FROM ${tables.attachments}
              WHERE tenant_id = message.tenant_id AND attached_message_id = message.id) AS attachments,
             audit.action AS audit_action, audit.metadata AS audit_metadata,
             audit.metadata::text AS audit_text,
             event.protocol_version::integer AS protocol_version,
             event.type AS event_type, event.payload AS event_payload,
             outcome.state AS outcome_state, outcome.response_status,
             outcome.response_body
           FROM ${tables.messages} AS message
           JOIN ${tables.conversations} AS conversation
             ON conversation.tenant_id = message.tenant_id
            AND conversation.id = message.conversation_id
           JOIN ${tables.audit} AS audit
             ON audit.tenant_id = message.tenant_id AND audit.target_id = message.id
           JOIN ${tables.outbox} AS event
             ON event.tenant_id = message.tenant_id
            AND event.stream_id = message.conversation_id
            AND event.type = 'message.deleted'
           JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = message.tenant_id
            AND outcome.user_id = $3
            AND outcome.operation_name = 'message.soft_delete'
            AND outcome.client_key = $4
           WHERE message.tenant_id = $1 AND message.id = $2`,
          ["tenant-a", messageId, authorActor.userId, input.idempotencyKey],
        )
      ).rows[0];
      assert.equal(state.conversation_sequence, 7);
      assert.equal(state.message_sequence, 7);
      assert.equal(state.author_user_id, authorActor.userId);
      assert.equal(state.client_message_id, `client-${messageId}`);
      assert.equal(state.created_at.toISOString(), createdAt);
      assert.equal(state.edited_at.toISOString(), editedAt);
      assert.equal(state.edited_by_user_id, authorActor.userId);
      assert.equal(state.content, null);
      assert.equal(state.revision, 3);
      assert.equal(state.deleted_by_user_id, authorActor.userId);
      assert.equal(state.revisions, 2);
      assert.equal(state.reactions, 1);
      assert.equal(state.attachments, 1);
      assert.equal(state.audit_action, "message.deleted");
      assert.deepEqual(state.audit_metadata, {
        conversationId,
        previousRevision: 2,
        currentRevision: 3,
      });
      assert.equal(state.audit_text.includes(sensitiveText), false);
      assert.equal(state.audit_text.includes(input.idempotencyKey), false);
      assert.equal(state.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(state.event_type, "message.deleted");
      assert.deepEqual(state.event_payload, { message: result.message });
      assert.equal(state.outcome_state, "completed");
      assert.equal(state.response_status, 200);
      assert.deepEqual(state.response_body, result);

      const projected = (await timeline(conversationId)).messages[0];
      assert.equal(projected.content, null);
      assert.equal(projected.isThreadRoot, false);
      assert.deepEqual(projected.attachmentMetadata, []);
      assert.deepEqual(projected.reactions, [
        { reactionKey: "eyes", count: 1, reactedByCurrentUser: false },
      ]);
    });

    await t.test("the exported moderation capability permits non-author deletion", async () => {
      const messageId = "message-moderator-delete";
      await seedMessage({
        conversationId: "conversation-moderator-delete",
        messageId,
      });

      const result = await command(deletionInput(messageId, "moderator"), {
        actor: moderatorActor,
      });

      assert.equal(result.reconciliationStatus, "applied");
      assert.deepEqual(result.message.author, {
        type: "user",
        userId: authorActor.userId,
      });
      assert.equal(result.message.deletedByUserId, moderatorActor.userId);
    });

    await t.test("unauthorized and cross-tenant actors receive the same sanitized rejection", async () => {
      const messageId = "message-delete-authorization";
      await seedMessage({
        conversationId: "conversation-delete-authorization",
        messageId,
      });

      for (const [actor, suffix] of [
        [unauthorizedActor, "unauthorized"],
        [crossTenantActor, "cross-tenant"],
      ]) {
        await assert.rejects(
          command(deletionInput(messageId, suffix), { actor }),
          (error) =>
            error instanceof ChatAuthorizationError &&
            error.statusCode === 403 &&
            error.message === "Chat authorization failed",
        );
      }
      const state = (
        await harness.pool.query(
          `SELECT content, current_revision::integer AS revision,
             (SELECT count(*)::integer FROM ${tables.idempotency}
              WHERE client_key IN ($2, $3)) AS outcomes
           FROM ${tables.messages}
           WHERE tenant_id = 'tenant-a' AND id = $1`,
          [
            messageId,
            "delete-idempotency-unauthorized",
            "delete-idempotency-cross-tenant",
          ],
        )
      ).rows[0];
      assert.deepEqual(state, {
        content: { format: "plain", text: `Original ${messageId}` },
        revision: 1,
        outcomes: 0,
      });
    });

    await t.test("deleting a root retains its canonical summary and leaves replies untouched", async () => {
      const conversationId = "conversation-root-delete";
      const messageId = "message-root-delete";
      const threadId = "thread-root-delete";
      await seedMessage({ conversationId, messageId, sequence: 1 });
      await harness.pool.query(
        `INSERT INTO ${tables.conversations} (
           tenant_id, id, type, visibility, parent_conversation_id,
           root_message_id, current_message_sequence, created_at, updated_at
         ) VALUES ('tenant-a', $1, 'thread', 'private', $2, $3, 2,
           '2026-01-01T00:01:00Z', '2026-01-01T00:03:00Z')`,
        [threadId, conversationId, messageId],
      );
      for (const userId of [authorActor.userId, "replier-a"]) {
        await harness.pool.query(
          `INSERT INTO ${tables.members} (
             tenant_id, conversation_id, user_id, role, state,
             joined_at, updated_at
           ) VALUES ('tenant-a', $1, $2, 'member', 'active',
             '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z')`,
          [threadId, userId],
        );
      }
      await harness.pool.query(
        `INSERT INTO ${tables.messages} (
           tenant_id, id, conversation_id, sequence, author_user_id,
           client_message_id, content, created_at, updated_at
         ) VALUES
           ('tenant-a', 'root-reply-1', $1, 1, 'replier-a', 'root-reply-client-1',
            '{"format":"plain","text":"reply one"}',
            '2026-01-01T00:02:00Z', '2026-01-01T00:02:00Z'),
           ('tenant-a', 'root-reply-2', $1, 2, 'author-a', 'root-reply-client-2',
            '{"format":"plain","text":"reply two"}',
            '2026-01-01T00:03:00Z', '2026-01-01T00:03:00Z')`,
        [threadId],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.revisions} (
           tenant_id, message_id, revision_number, content,
           created_at, created_by_user_id
         ) VALUES
           ('tenant-a', 'root-reply-1', 1,
            '{"format":"plain","text":"reply one"}',
            '2026-01-01T00:02:00Z', 'replier-a'),
           ('tenant-a', 'root-reply-2', 1,
            '{"format":"plain","text":"reply two"}',
            '2026-01-01T00:03:00Z', 'author-a')`,
      );
      await harness.pool.query(
        `INSERT INTO ${tables.cursors} (
           tenant_id, conversation_id, user_id, last_read_sequence, updated_at
         ) VALUES ('tenant-a', $1, 'author-a', 1, '2026-01-01T00:02:30Z')`,
        [threadId],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.follows} (
           tenant_id, conversation_id, user_id, is_following, follow_source,
           created_at, updated_at
         ) VALUES ('tenant-a', $1, 'author-a', true, 'reply',
           '2026-01-01T00:02:00Z', '2026-01-01T00:02:00Z')`,
        [threadId],
      );

      const result = await command(deletionInput(messageId, "root"));

      assert.deepEqual(result.message.threadSummary, {
        threadId,
        replyCount: 2,
        participantIds: ["author-a", "replier-a"],
        unreadCount: 1,
        lastReplyAt: "2026-01-01T00:03:00.000Z",
      });
      const parent = await timeline(conversationId);
      assert.equal(parent.messages[0].content, null);
      assert.equal(parent.messages[0].isThreadRoot, true);
      assert.deepEqual(parent.messages[0].threadSummary, result.message.threadSummary);
      const replies = await timeline(threadId);
      assert.deepEqual(
        replies.messages.map(({ id, content, sequence }) => ({
          id,
          text: content.text,
          sequence,
        })),
        [
          { id: "root-reply-1", text: "reply one", sequence: 1 },
          { id: "root-reply-2", text: "reply two", sequence: 2 },
        ],
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT current_message_sequence::integer AS sequence
             FROM ${tables.conversations}
             WHERE tenant_id = 'tenant-a' AND id = $1`,
            [threadId],
          )
        ).rows[0].sequence,
        2,
      );
    });

    await t.test("a stale revision stores a deterministic conflict without deletion effects", async () => {
      const messageId = "message-delete-stale";
      const content = { format: "plain", text: "Already edited" };
      await seedMessage({
        conversationId: "conversation-delete-stale",
        messageId,
        currentRevision: 2,
        content,
      });
      const input = deletionInput(messageId, "stale");

      const conflict = await command(input);
      const repeated = await command(input);

      assert.equal(conflict.reconciliationStatus, "revision_conflict");
      assert.equal(conflict.expectedRevision, 1);
      assert.equal(conflict.canonicalRevision, 2);
      assert.deepEqual(conflict.message.content, content);
      assert.deepEqual(repeated, conflict);
      const state = (
        await harness.pool.query(
          `SELECT message.content, message.current_revision::integer AS revision,
             message.deleted_at,
             (SELECT count(*)::integer FROM ${tables.revisions}
              WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE tenant_id = message.tenant_id AND target_id = message.id) AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE tenant_id = message.tenant_id
                AND stream_id = message.conversation_id) AS outbox,
             outcome.response_status, outcome.response_body
           FROM ${tables.messages} AS message
           JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = message.tenant_id
            AND outcome.user_id = $2
            AND outcome.operation_name = 'message.soft_delete'
            AND outcome.client_key = $3
           WHERE message.tenant_id = 'tenant-a' AND message.id = $1`,
          [messageId, authorActor.userId, input.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(state, {
        content,
        revision: 2,
        deleted_at: null,
        revisions: 2,
        audits: 0,
        outbox: 0,
        response_status: 409,
        response_body: conflict,
      });
    });

    await t.test("a fractional-millisecond claim completes and replays a revision conflict", async () => {
      const messageId = "message-delete-fractional-claim";
      const conversationId = "conversation-delete-fractional-claim";
      const content = { format: "plain", text: "Already edited" };
      await seedMessage({ conversationId, messageId, currentRevision: 2, content });
      const input = deletionInput(messageId, "fractional-claim");
      // Match softDeleteMessage's property order, without draft canonicalization.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        operation: input.operation,
        messageId: input.messageId,
        expectedRevision: input.expectedRevision,
      })).digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           state, created_at, updated_at, expires_at
         )
         SELECT $1, $2, 'message.soft_delete', $3, $4, 'pending',
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
                completed_at >= created_at AS completion_not_before_claim,
                updated_at >= created_at AS update_not_before_claim,
                created_at - $4::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = 'message.soft_delete' AND client_key = $3`,
        [authorActor.tenantId, authorActor.userId, input.idempotencyKey, claim.created_at],
      )).rows;
      const outcome = await storedOutcome();
      assert.equal(outcome.length, 1);
      assert.equal(outcome[0].state, "completed");
      assert.equal(outcome[0].response_status, 409);
      assert.deepEqual(outcome[0].response_body, conflict);
      for (const field of ["completion_not_before_claim", "update_not_before_claim",
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

    await t.test("successful retry replays the canonical outcome and changed payload conflicts", async () => {
      const messageId = "message-delete-idempotent";
      const conversationId = "conversation-delete-idempotent";
      await seedMessage({ conversationId, messageId });
      const input = deletionInput(messageId, "canonical");

      const applied = await command(input);
      const replayed = await command(input);

      assert.deepEqual(replayed, {
        ...applied,
        reconciliationStatus: "replayed",
      });
      await assert.rejects(
        command({ ...input, expectedRevision: 2 }),
        (error) =>
          error instanceof SoftDeleteMessageCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
      const counts = (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${tables.revisions}
              WHERE tenant_id = 'tenant-a' AND message_id = $1) AS revisions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE tenant_id = 'tenant-a' AND stream_id = $2
                AND type = 'message.deleted') AS outbox`,
          [messageId, conversationId],
        )
      ).rows[0];
      assert.deepEqual(counts, { revisions: 1, audits: 1, outbox: 1 });
    });

    for (const failure of [
      {
        name: "audit insertion",
        table: tables.audit,
        error: "injected audit insertion failure",
      },
      {
        name: "outbox insertion",
        table: tables.outbox,
        error: "injected outbox insertion failure",
      },
    ]) {
      await t.test(`${failure.name} failure rolls back the tombstone and pending key`, async () => {
        const suffix = failure.name.startsWith("audit") ? "audit" : "outbox";
        const messageId = `message-delete-rollback-${suffix}`;
        const conversationId = `conversation-delete-rollback-${suffix}`;
        const original = { format: "plain", text: `Rollback ${suffix}` };
        const { createdAt } = await seedMessage({
          conversationId,
          messageId,
          content: original,
        });
        const input = deletionInput(messageId, `rollback-${suffix}`);

        await assert.rejects(
          command(input, {
            database: injectInsertFailure(failure.table, failure.error),
          }),
          new RegExp(failure.error),
        );

        const state = (
          await harness.pool.query(
            `SELECT
               conversation.current_message_sequence::integer AS conversation_sequence,
               message.sequence::integer AS message_sequence,
               message.content, message.current_revision::integer AS revision,
               message.updated_at, message.deleted_at, message.deleted_by_user_id,
               (SELECT count(*)::integer FROM ${tables.revisions}
                WHERE tenant_id = message.tenant_id AND message_id = message.id) AS revisions,
               (SELECT count(*)::integer FROM ${tables.audit}
                WHERE tenant_id = message.tenant_id AND target_id = message.id) AS audits,
               (SELECT count(*)::integer FROM ${tables.outbox}
                WHERE tenant_id = message.tenant_id
                  AND stream_id = message.conversation_id) AS outbox,
               (SELECT count(*)::integer FROM ${tables.idempotency}
                WHERE tenant_id = message.tenant_id
                  AND user_id = $3
                  AND operation_name = 'message.soft_delete'
                  AND client_key = $4) AS idempotency
             FROM ${tables.messages} AS message
             JOIN ${tables.conversations} AS conversation
               ON conversation.tenant_id = message.tenant_id
              AND conversation.id = message.conversation_id
             WHERE message.tenant_id = $1 AND message.id = $2`,
            ["tenant-a", messageId, authorActor.userId, input.idempotencyKey],
          )
        ).rows[0];
        assert.equal(state.conversation_sequence, 7);
        assert.equal(state.message_sequence, 7);
        assert.deepEqual(state.content, original);
        assert.equal(state.revision, 1);
        assert.equal(state.updated_at.toISOString(), createdAt);
        assert.equal(state.deleted_at, null);
        assert.equal(state.deleted_by_user_id, null);
        assert.equal(state.revisions, 1);
        assert.equal(state.audits, 0);
        assert.equal(state.outbox, 0);
        assert.equal(state.idempotency, 0);
      });
    }
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
