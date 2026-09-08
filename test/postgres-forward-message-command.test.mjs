import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ForwardMessageParseError, parseKnownDurableEvent } from "@handrail/chat";
import {
  ChatAuthorizationError,
  FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION,
  FORWARD_MESSAGE_IDEMPOTENCY_OPERATION,
  FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION,
  ForwardMessageCommandError,
  createPostgresMigrationRunner,
  forwardMessage,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "forwarder-a",
  roles: Object.freeze(["employee"]),
});

const input = (sourceMessageId, destinationConversationId, suffix, overrides = {}) => ({
  operation: "forward_message.v1",
  sourceMessageId,
  destinationConversationId,
  clientCorrelationId: `correlation-${suffix}`,
  idempotencyKey: `forward-${suffix}`,
  ...overrides,
});

const hasCommandCode = (code) => (error) =>
  error instanceof ForwardMessageCommandError && error.code === code;

test("forward-message command atomically snapshots authorized PostgreSQL messages", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_forward" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    readCursors: `${schema}.chat_read_cursors`,
    messages: `${schema}.chat_messages`,
    revisions: `${schema}.chat_message_revisions`,
    attachments: `${schema}.chat_attachments`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const directoryUsers = new Map();
  let capabilities = ["message.send"];
  const deniedEntityIds = new Set();
  const entityCalls = [];
  let nextId = 0;
  const createId = () => `forward-command-${++nextId}`;
  const adapters = {
    directory: {
      async getUser({ actor: requestActor, userId }) {
        return directoryUsers.get(`${requestActor.tenantId}:${userId}`) ?? null;
      },
    },
    permissions: {
      async getCapabilities() {
        return capabilities;
      },
      async authorizeEntity(request) {
        entityCalls.push(request);
        return !deniedEntityIds.has(request.entity.id);
      },
    },
  };
  const command = (commandInput, overrides = {}) =>
    forwardMessage({
      database: harness.pool,
      schema: harness.schema,
      actor,
      input: commandInput,
      directory: adapters.directory,
      permissions: adapters.permissions,
      createId,
      ...overrides,
    });

  const seedConversation = async ({
    tenantId = "tenant-a",
    conversationId,
    type = "channel",
    parentConversationId = null,
    rootMessageId = null,
    memberUserId = "forwarder-a",
    memberState = "active",
    visibility = "private",
    archived = false,
    entity,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name,
         entity_type, entity_id, archived_at, archived_by_user_id,
         parent_conversation_id, root_message_id
       ) VALUES ($1, $2, $8, $3, $11, $4, $5, $6, $7, $9, $10)`,
      [
        tenantId,
        conversationId,
        visibility,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? "2026-01-01T00:00:00Z" : null,
        archived ? "archiver-a" : null,
        type,
        parentConversationId,
        rootMessageId,
        type === "channel" ? conversationId : null,
      ],
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

  const seedSource = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId,
    authorUserId = `author-${messageId}`,
    content = { format: "plain", text: `Source ${messageId}` },
    deleted = false,
    createdAt = "2026-08-20T12:30:00Z",
    directory = true,
  }) => {
    const sequence = (
      await harness.pool.query(
      `UPDATE ${tables.conversations}
       SET current_message_sequence = current_message_sequence + 1
       WHERE tenant_id = $1 AND id = $2
       RETURNING current_message_sequence::integer AS sequence`,
      [tenantId, conversationId],
      )
    ).rows[0].sequence;
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, current_revision, created_at, updated_at,
         deleted_at, deleted_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8, $9, $10)`,
      [
        tenantId,
        messageId,
        conversationId,
        sequence,
        authorUserId,
        `seed-${messageId}`,
        deleted ? null : content,
        createdAt,
        deleted ? createdAt : null,
        deleted ? authorUserId : null,
      ],
    );
    if (directory) {
      directoryUsers.set(`${tenantId}:${authorUserId}`, {
        tenantId,
        userId: authorUserId,
        displayName: `Display ${authorUserId}`,
      });
    }
    return authorUserId;
  };

  const seedAttachedReference = async (messageId, attachmentId) => {
    await harness.pool.query(
      `INSERT INTO ${tables.attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, checksum, created_at, updated_at, expires_at
       ) VALUES (
         'tenant-a', $1, 'forwarder-a', $2, $3,
         'text/plain', 12, $4, '2026-08-20T12:30:00Z',
         '2026-08-20T12:30:00Z', '2099-01-01T00:00:00Z'
       )`,
      [attachmentId, `tenant-a/${attachmentId}`, `${attachmentId}.txt`, `sha256:${"a".repeat(64)}`],
    );
    await harness.pool.query(
      `UPDATE ${tables.attachments}
       SET state = 'attached', attached_message_id = $1,
           attached_at = '2026-08-20T12:31:00Z',
           updated_at = '2026-08-20T12:31:00Z'
       WHERE tenant_id = 'tenant-a' AND id = $2`,
      [messageId, attachmentId],
    );
  };

  const seedThread = async (suffix) => {
    const parentConversationId = `parent-${suffix}`;
    const rootMessageId = `root-${suffix}`;
    const threadId = `thread-${suffix}`;
    await seedConversation({ conversationId: parentConversationId });
    await seedSource({ conversationId: parentConversationId, messageId: rootMessageId });
    await seedConversation({
      conversationId: threadId, type: "thread", parentConversationId, rootMessageId,
    });
    for (const conversationId of [parentConversationId, threadId]) {
      await harness.pool.query(
        `INSERT INTO ${tables.readCursors}
           (tenant_id, conversation_id, user_id, last_read_sequence)
         VALUES ($1, $2, $3, 0)`,
        [actor.tenantId, conversationId, actor.userId],
      );
    }
    return { parentConversationId, rootMessageId, threadId };
  };

  // Subtests run sequentially in this isolated schema, so whole-table counts
  // also catch side effects accidentally written to a different conversation.
  const forwardState = async (conversationId, idempotencyKey) => (
    await harness.pool.query(
      `SELECT current_message_sequence::integer AS sequence,
         (SELECT count(*)::integer FROM ${tables.messages}) AS messages,
         (SELECT count(*)::integer FROM ${tables.revisions}) AS revisions,
         (SELECT count(*)::integer FROM ${tables.audit}) AS audits,
         (SELECT count(*)::integer FROM ${tables.outbox}) AS events,
         (SELECT count(*)::integer FROM ${tables.idempotency}
          WHERE tenant_id = $1 AND user_id = $3
            AND operation_name = $4 AND client_key = $5) AS idempotency
       FROM ${tables.conversations} WHERE tenant_id = $1 AND id = $2`,
      [actor.tenantId, conversationId, actor.userId,
        FORWARD_MESSAGE_IDEMPOTENCY_OPERATION, idempotencyKey],
    )
  ).rows[0];

  const assertThreadEvents = async (thread, applied, request) => {
    const rows = (await harness.pool.query(
      `SELECT * FROM ${tables.outbox}
       WHERE tenant_id = $1 AND stream_id IN ($2, $3)
       ORDER BY replay_position`,
      [actor.tenantId, thread.parentConversationId, thread.threadId],
    )).rows;
    const summaries = rows.filter((row) => row.type === "message.thread_summary.updated");
    assert.equal(summaries.length, 1, "forward must persist one parent thread summary");
    const created = rows.filter((row) => row.type === "message.created");
    assert.equal(created.length, 1);
    assert.equal(rows.length, 2);
    assert.equal(created[0].stream_id, thread.threadId);
    assert.deepEqual(created[0].payload, {
      message: applied.message, clientMessageId: request.clientCorrelationId,
    });
    const stored = summaries[0];
    const envelope = {
      eventId: stored.event_id,
      protocolVersion: Number(stored.protocol_version),
      tenantId: stored.tenant_id,
      streamId: stored.stream_id,
      type: stored.type,
      occurredAt: stored.occurred_at.toISOString(),
      payload: stored.payload,
    };
    // Adapt only the SQL envelope; validate the actual stored payload unchanged.
    const parsed = parseKnownDurableEvent(envelope, actor);
    assert.deepEqual(parsed, envelope);
    assert.equal(parsed.tenantId, actor.tenantId);
    assert.equal(parsed.streamId, thread.parentConversationId);
    assert.equal(parsed.type, "message.thread_summary.updated");
    assert.equal(parsed.occurredAt, applied.message.createdAt);
    assert.deepEqual(parsed.payload, {
      parentConversationId: thread.parentConversationId,
      rootMessageId: thread.rootMessageId,
      rootThreadSummary: {
        threadId: thread.threadId,
        replyCount: 1,
        participantIds: [actor.userId],
        unreadCount: 1,
        lastReplyAt: applied.message.createdAt,
      },
    });
    assert.ok(BigInt(stored.replay_position) > BigInt(created[0].replay_position));
    assert.ok(stored.expires_at > stored.occurred_at);
    return rows;
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await t.test("applies once, replays exactly, and freezes content and author attribution", async () => {
      await seedConversation({
        conversationId: "source-success",
        entity: { type: "order", id: "source-order" },
      });
      await seedConversation({
        conversationId: "destination-success",
        entity: { type: "project", id: "destination-project" },
      });
      const authorUserId = await seedSource({
        conversationId: "source-success",
        messageId: "message-success",
        content: {
          format: "markdown",
          text: "Frozen **source**",
          mentions: [{ type: "user", userId: "mentioned-a" }],
          forwarded: {
            sourceMessageId: "older-source",
            originalAuthor: { userId: "older-author", displayName: "Older Author" },
            originalCreatedAt: "2026-08-01T00:00:00Z",
          },
        },
      });
      const request = input("message-success", "destination-success", "success");

      const applied = await command(request);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.message.sequence, 1);
      assert.deepEqual(applied.message.author, { type: "user", userId: actor.userId });
      assert.deepEqual(applied.message.content, {
        format: "markdown",
        text: "Frozen **source**",
        mentions: [{ type: "user", userId: "mentioned-a" }],
        forwarded: {
          sourceMessageId: "message-success",
          originalAuthor: {
            userId: authorUserId,
            displayName: `Display ${authorUserId}`,
          },
          originalCreatedAt: "2026-08-20T12:30:00.000Z",
        },
      });
      assert.deepEqual(entityCalls.slice(-2), [
        {
          actor,
          entity: { type: "order", id: "source-order" },
          action: FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION,
        },
        {
          actor,
          entity: { type: "project", id: "destination-project" },
          action: FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION,
        },
      ]);

      await harness.pool.query(
        `UPDATE ${tables.messages}
         SET content = '{"format":"plain","text":"Later edit"}'::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = 'tenant-a' AND id = 'message-success'`,
      );
      directoryUsers.set(`tenant-a:${authorUserId}`, {
        tenantId: "tenant-a",
        userId: authorUserId,
        displayName: "Renamed Author",
      });

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.message, applied.message);

      const persisted = (
        await harness.pool.query(
          `SELECT
             message.client_message_id,
             message.content,
             revision.revision_number::integer AS revision_number,
             revision.content AS revision_content,
             audit.action AS audit_action,
             audit.metadata AS audit_metadata,
             event.type AS event_type,
             event.protocol_version::integer AS protocol_version,
             event.payload AS event_payload,
             outcome.operation_name,
             outcome.state AS outcome_state,
             destination.current_message_sequence::integer AS destination_sequence
           FROM ${tables.messages} AS message
           JOIN ${tables.revisions} AS revision
             ON revision.tenant_id = message.tenant_id
            AND revision.message_id = message.id
           JOIN ${tables.audit} AS audit
             ON audit.tenant_id = message.tenant_id
            AND audit.target_id = message.id
           JOIN ${tables.outbox} AS event
             ON event.tenant_id = message.tenant_id
            AND event.stream_id = message.conversation_id
            AND event.type = 'message.created'
           JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = message.tenant_id
            AND outcome.user_id = message.author_user_id
            AND outcome.client_key = $1
           JOIN ${tables.conversations} AS destination
             ON destination.tenant_id = message.tenant_id
            AND destination.id = message.conversation_id
           WHERE message.tenant_id = 'tenant-a'
             AND message.id = $2`,
          [request.idempotencyKey, applied.message.id],
        )
      ).rows[0];
      assert.equal(persisted.client_message_id, request.clientCorrelationId);
      assert.deepEqual(persisted.content, applied.message.content);
      assert.equal(persisted.revision_number, 1);
      assert.deepEqual(persisted.revision_content, applied.message.content);
      assert.equal(persisted.audit_action, "message.created");
      assert.equal(persisted.audit_metadata.forwarded, true);
      assert.equal(persisted.audit_metadata.sourceMessageId, request.sourceMessageId);
      assert.equal(persisted.event_type, "message.created");
      assert.deepEqual(persisted.event_payload, {
        message: applied.message,
        clientMessageId: request.clientCorrelationId,
      });
      assert.equal(persisted.operation_name, FORWARD_MESSAGE_IDEMPOTENCY_OPERATION);
      assert.equal(persisted.outcome_state, "completed");
      assert.equal(persisted.destination_sequence, 1);
      assert.equal((await harness.pool.query(
        `SELECT event_id FROM ${tables.outbox}
         WHERE tenant_id = $1 AND type = 'message.thread_summary.updated'`,
        [actor.tenantId],
      )).rowCount, 0, "a channel forward must not create a thread summary");
    });

    await t.test("thread forward persists a parent summary after the reply and replays exactly", async () => {
      const thread = await seedThread("forward-summary");
      const request = input(thread.rootMessageId, thread.threadId, "thread-summary");
      const before = await forwardState(thread.threadId, request.idempotencyKey);
      const applied = await command(request);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.message.conversationId, thread.threadId);
      assert.equal(applied.message.sequence, 1);
      const events = await assertThreadEvents(thread, applied, request);
      const after = await forwardState(thread.threadId, request.idempotencyKey);
      assert.deepEqual(after, {
        sequence: 1, messages: before.messages + 1, revisions: before.revisions + 1,
        audits: before.audits + 1, events: before.events + 2, idempotency: 1,
      });
      assert.deepEqual(await command(request), { ...applied, reconciliationStatus: "replayed" });
      assert.deepEqual(await forwardState(thread.threadId, request.idempotencyKey), after);
      assert.deepEqual(await assertThreadEvents(thread, applied, request), events);
    });

    await t.test("summary INSERT failure rolls back the entire forward and permits retry", async () => {
      const thread = await seedThread("summary-rollback");
      const request = input(thread.rootMessageId, thread.threadId, "summary-rollback");
      const before = await forwardState(thread.threadId, request.idempotencyKey);
      assert.equal(before.sequence, 0);
      assert.equal(before.idempotency, 0);
      let summaryInsertAttempts = 0;
      const database = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            query(sql, parameters) {
              // Fault only this outbox INSERT; all other SQL and transaction
              // operations execute against the real PostgreSQL connection.
              if (sql.includes(`INSERT INTO ${tables.outbox}`) &&
                  sql.includes("'message.thread_summary.updated'")) {
                summaryInsertAttempts += 1;
                throw new Error("forward summary persistence failure");
              }
              return connection.query(sql, parameters);
            },
            release: () => connection.release(),
          };
        },
      };
      await assert.rejects(command(request, { database }), /forward summary persistence failure/);
      assert.equal(summaryInsertAttempts, 1);
      assert.deepEqual(await forwardState(thread.threadId, request.idempotencyKey), before);

      const applied = await command(request);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.message.sequence, 1);
      await assertThreadEvents(thread, applied, request);
      assert.deepEqual(await forwardState(thread.threadId, request.idempotencyKey), {
        sequence: 1, messages: before.messages + 1, revisions: before.revisions + 1,
        audits: before.audits + 1, events: before.events + 2, idempotency: 1,
      });
    });

    await t.test("a fractional-millisecond claim completes and replays without duplicate effects", async () => {
      const sourceMessageId = "message-fractional-claim";
      const destinationConversationId = "destination-fractional-claim";
      await seedConversation({ conversationId: "source-fractional-claim" });
      await seedConversation({ conversationId: destinationConversationId });
      await seedSource({ conversationId: "source-fractional-claim", messageId: sourceMessageId });
      const request = input(sourceMessageId, destinationConversationId, "fractional-claim");
      // Match forwardMessage's canonical, sorted request keys.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        clientCorrelationId: request.clientCorrelationId,
        destinationConversationId: request.destinationConversationId,
        operation: request.operation,
        sourceMessageId: request.sourceMessageId,
      })).digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           state, created_at, updated_at, expires_at
         )
         SELECT $1, $2, 'message.forward', $3, $4, 'pending',
                claimed_at, claimed_at, claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at, expires_at::text`,
        [actor.tenantId, actor.userId, request.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              // Execute every SQL statement and transaction normally. Only the
              // returned allocation clock uses the millisecond-truncated claim.
              const result = await connection.query(sql, values);
              if (sql.includes(`UPDATE ${tables.conversations} AS conversation`) &&
                  sql.includes("conversation.updated_at AS occurred_at")) {
                assert.equal(result.rows.length, 1);
                result.rows[0].occurred_at = claim.created_at;
                clockSamples += 1;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const applied = await command(request, { database: clockDatabase });
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(clockSamples, 1);
      assert.equal(applied.message.createdAt, claim.created_at.toISOString());
      assert.equal(applied.message.updatedAt, claim.created_at.toISOString());
      assert.equal(applied.message.content.forwarded.sourceMessageId, sourceMessageId);
      const storedOutcome = async () => (await harness.pool.query(
        `SELECT state, response_status, response_body,
                created_at::text, updated_at::text, completed_at::text, expires_at::text,
                completed_at = created_at AS completion_equals_claim,
                updated_at = created_at AS update_equals_claim,
                created_at - $4::timestamptz = interval '456 microseconds' AS precision_gap
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = 'message.forward' AND client_key = $3`,
        [actor.tenantId, actor.userId, request.idempotencyKey, claim.created_at],
      )).rows;
      const outcome = await storedOutcome();
      assert.equal(outcome.length, 1);
      assert.equal(outcome[0].state, "completed");
      assert.equal(outcome[0].response_status, 201);
      assert.deepEqual(outcome[0].response_body, applied);
      for (const field of ["completion_equals_claim", "update_equals_claim", "precision_gap"]) {
        assert.equal(outcome[0][field], true, field);
      }
      assert.equal(outcome[0].completed_at, outcome[0].created_at);
      assert.equal(outcome[0].updated_at, outcome[0].created_at);
      assert.equal(outcome[0].expires_at, claim.expires_at);

      const storedEffects = async () => (await harness.pool.query(
        `SELECT current_message_sequence::integer AS sequence,
           (SELECT jsonb_agg(message ORDER BY id) FROM ${tables.messages} AS message
            WHERE tenant_id = $1 AND conversation_id = $2) AS messages,
           (SELECT jsonb_agg(revision ORDER BY revision_number) FROM ${tables.revisions} AS revision
            WHERE tenant_id = $1 AND message_id = $3) AS revisions,
           (SELECT jsonb_agg(audit ORDER BY id) FROM ${tables.audit} AS audit
            WHERE tenant_id = $1 AND target_id = $3) AS audits,
           (SELECT jsonb_agg(event ORDER BY id) FROM ${tables.outbox} AS event
            WHERE tenant_id = $1 AND stream_id = $2) AS outbox
         FROM ${tables.conversations} WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, destinationConversationId, applied.message.id],
      )).rows[0];
      const effects = await storedEffects();
      assert.equal(effects.sequence, 1);
      for (const field of ["messages", "revisions", "audits", "outbox"]) {
        assert.equal(effects[field].length, 1, field);
      }
      assert.equal(effects.messages[0].id, applied.message.id);
      assert.deepEqual(effects.messages[0].content, applied.message.content);
      assert.equal(effects.audits[0].action, "message.created");
      assert.equal(effects.audits[0].metadata.forwarded, true);
      assert.equal(effects.audits[0].metadata.sourceMessageId, sourceMessageId);
      assert.equal(effects.outbox[0].type, "message.created");
      assert.deepEqual(effects.outbox[0].payload, {
        message: applied.message, clientMessageId: request.clientCorrelationId,
      });
      for (const timestamp of [effects.messages[0].created_at, effects.messages[0].updated_at,
        effects.revisions[0].created_at, effects.audits[0].occurred_at, effects.outbox[0].occurred_at]) {
        assert.equal(new Date(timestamp).toISOString(), claim.created_at.toISOString());
      }

      assert.deepEqual(await command(request, { database: clockDatabase }), {
        ...applied, reconciliationStatus: "replayed",
      });
      assert.equal(clockSamples, 1);
      assert.deepEqual(await storedOutcome(), outcome);
      assert.deepEqual(await storedEffects(), effects);
    });

    await t.test("allocates monotonically and rejects idempotency and correlation reuse", async () => {
      await seedConversation({ conversationId: "source-conflicts" });
      await seedConversation({ conversationId: "destination-conflicts" });
      await seedSource({ conversationId: "source-conflicts", messageId: "message-conflict-a" });
      await seedSource({
        conversationId: "source-conflicts",
        messageId: "message-conflict-b",
        createdAt: "2026-08-20T12:31:00Z",
      });
      const firstInput = input("message-conflict-a", "destination-conflicts", "conflict-a");
      const first = await command(firstInput);
      const second = await command(input("message-conflict-b", "destination-conflicts", "conflict-b"));
      assert.deepEqual([first.message.sequence, second.message.sequence], [1, 2]);

      await assert.rejects(
        command({ ...firstInput, sourceMessageId: "message-conflict-b" }),
        hasCommandCode("idempotency_conflict"),
      );
      await assert.rejects(
        command(input("message-conflict-b", "destination-conflicts", "duplicate-correlation", {
          clientCorrelationId: firstInput.clientCorrelationId,
        })),
        hasCommandCode("destination_message_conflict"),
      );
      const state = (
        await harness.pool.query(
          `SELECT current_message_sequence::integer AS sequence,
             (SELECT count(*)::integer FROM ${tables.messages}
              WHERE tenant_id = 'tenant-a' AND conversation_id = 'destination-conflicts') AS messages
           FROM ${tables.conversations}
           WHERE tenant_id = 'tenant-a' AND id = 'destination-conflicts'`,
        )
      ).rows[0];
      assert.deepEqual(state, { sequence: 2, messages: 2 });
    });

    await t.test("enforces source read, destination send/membership, and both entity policies", async () => {
      await seedConversation({ conversationId: "source-private-denied", memberState: "left" });
      await seedConversation({ conversationId: "source-entity-denied", entity: { type: "order", id: "deny-source" } });
      await seedConversation({ conversationId: "destination-active" });
      await seedConversation({ conversationId: "destination-left", memberState: "left" });
      await seedConversation({ conversationId: "destination-archived", archived: true });
      await seedConversation({ conversationId: "destination-entity-denied", entity: { type: "order", id: "deny-destination" } });
      await seedSource({ conversationId: "source-private-denied", messageId: "message-private-denied" });
      await seedSource({ conversationId: "source-entity-denied", messageId: "message-entity-denied" });

      await assert.rejects(
        command(input("message-private-denied", "destination-active", "private-denied")),
        hasCommandCode("source_message_forbidden"),
      );
      deniedEntityIds.add("deny-source");
      await assert.rejects(
        command(input("message-entity-denied", "destination-active", "source-entity-denied")),
        hasCommandCode("source_message_forbidden"),
      );
      deniedEntityIds.delete("deny-source");
      await assert.rejects(
        command(input("message-entity-denied", "destination-left", "destination-left")),
        hasCommandCode("destination_conversation_forbidden"),
      );
      await assert.rejects(
        command(input("message-entity-denied", "destination-archived", "destination-archived")),
        hasCommandCode("destination_conversation_forbidden"),
      );
      deniedEntityIds.add("deny-destination");
      await assert.rejects(
        command(input("message-entity-denied", "destination-entity-denied", "destination-entity-denied")),
        hasCommandCode("destination_conversation_forbidden"),
      );
      deniedEntityIds.delete("deny-destination");

      capabilities = [];
      await assert.rejects(
        command(input("message-entity-denied", "destination-active", "capability-denied")),
        (error) => error instanceof ChatAuthorizationError,
      );
      capabilities = ["message.send"];
    });

    await t.test("hides cross-tenant existence and rejects deleted, attached, and unsupported sources", async () => {
      await seedConversation({ tenantId: "tenant-b", conversationId: "cross-source", memberUserId: "forwarder-a" });
      await seedConversation({ conversationId: "source-invalid" });
      await seedConversation({ conversationId: "destination-invalid" });
      await seedConversation({ tenantId: "tenant-b", conversationId: "cross-destination", memberUserId: "forwarder-a" });
      await seedSource({ tenantId: "tenant-b", conversationId: "cross-source", messageId: "cross-message" });
      await seedSource({ conversationId: "source-invalid", messageId: "valid-message" });
      await seedSource({ conversationId: "source-invalid", messageId: "deleted-message", deleted: true });
      await seedSource({ conversationId: "source-invalid", messageId: "attached-message" });
      await seedAttachedReference("attached-message", "attachment-forward");
      await seedSource({
        conversationId: "source-invalid",
        messageId: "content-attachment-message",
        content: { format: "plain", text: "Attached", attachments: [{ attachmentId: "not-copied" }] },
      });
      await seedSource({
        conversationId: "source-invalid",
        messageId: "blocks-message",
        content: { format: "plain", text: "Blocks", blocks: [{ type: "unsafe", data: {} }] },
      });
      await seedSource({
        conversationId: "source-invalid",
        messageId: "raw-html-message",
        content: { format: "markdown", text: "Rendered", rawHtml: "<script>secret()</script>" },
      });
      const unavailableAuthor = await seedSource({
        conversationId: "source-invalid",
        messageId: "directory-unavailable-message",
      });
      directoryUsers.set(`tenant-a:${unavailableAuthor}`, {
        tenantId: "tenant-a",
        userId: unavailableAuthor,
        kind: "redacted",
      });

      for (const sourceMessageId of ["missing-message", "cross-message", "deleted-message"]) {
        await assert.rejects(
          command(input(sourceMessageId, "destination-invalid", `hidden-${sourceMessageId}`)),
          hasCommandCode("source_message_not_found"),
        );
      }
      for (const destinationConversationId of ["missing-destination", "cross-destination"]) {
        await assert.rejects(
          command(input("valid-message", destinationConversationId, `hidden-${destinationConversationId}`)),
          hasCommandCode("destination_conversation_not_found"),
        );
      }
      for (const sourceMessageId of ["attached-message", "content-attachment-message"]) {
        await assert.rejects(
          command(input(sourceMessageId, "destination-invalid", `attachment-${sourceMessageId}`)),
          hasCommandCode("source_attachments_unsupported"),
        );
      }
      for (const sourceMessageId of ["blocks-message", "raw-html-message"]) {
        await assert.rejects(
          command(input(sourceMessageId, "destination-invalid", `unsupported-${sourceMessageId}`)),
          hasCommandCode("source_content_unsupported"),
        );
      }
      await assert.rejects(
        command(input("directory-unavailable-message", "destination-invalid", "directory-unavailable")),
        hasCommandCode("source_message_forbidden"),
      );
      await assert.rejects(
        command({ ...input("blocks-message", "destination-invalid", "spoof"), tenantId: "tenant-b" }),
        (error) => error instanceof ForwardMessageParseError && error.code === "trusted_identity_field",
      );
    });

    await t.test("rolls back sequence, message, and idempotency when persistence fails", async () => {
      await seedConversation({ conversationId: "source-rollback" });
      await seedConversation({ conversationId: "destination-rollback" });
      await seedSource({ conversationId: "source-rollback", messageId: "message-rollback" });
      const rollbackInput = input("message-rollback", "destination-rollback", "rollback");
      await assert.rejects(
        command(rollbackInput, { createId: () => "message-rollback" }),
      );
      const state = (
        await harness.pool.query(
          `SELECT
             conversation.current_message_sequence::integer AS sequence,
             (SELECT count(*)::integer FROM ${tables.messages}
              WHERE tenant_id = 'tenant-a' AND conversation_id = 'destination-rollback') AS messages,
             (SELECT count(*)::integer FROM ${tables.idempotency}
              WHERE tenant_id = 'tenant-a' AND client_key = $1) AS idempotency
           FROM ${tables.conversations} AS conversation
           WHERE conversation.tenant_id = 'tenant-a'
             AND conversation.id = 'destination-rollback'`,
          [rollbackInput.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(state, { sequence: 0, messages: 0, idempotency: 0 });
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
