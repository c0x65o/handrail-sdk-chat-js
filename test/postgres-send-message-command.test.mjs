import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

// Bundle canonical sources with esbuild before running; never use shared dist.
import { CHAT_PROTOCOL_VERSION } from "../src/contracts/realtime.ts";
import { MessageMutationParseError } from "../src/contracts/message-mutations.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { SendMessageCommandError, sendMessage } from "../src/server/send-message-command.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const input = (conversationId, suffix, overrides = {}) => ({
  operation: "send",
  conversationId,
  clientMessageId: `client-${suffix}`,
  idempotencyKey: `idempotency-${suffix}`,
  content: { format: "plain", text: `Message ${suffix}` },
  ...overrides,
});

test("atomic send-message command persists and reconciles one authorized message", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_send" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    revisions: `${schema}.chat_message_revisions`,
    attachments: `${schema}.chat_attachments`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const directoryUsers = new Map([
    [
      "tenant-a:mentioned-a",
      {
        tenantId: "tenant-a",
        userId: "mentioned-a",
        displayName: "Mentioned User",
      },
    ],
  ]);
  let capabilities = ["message.send"];
  let entityAllowed = true;
  const entityCalls = [];
  const directoryCalls = [];
  const adapters = {
    directory: {
      async getUser(request) {
        directoryCalls.push(request);
        return (
          directoryUsers.get(`${request.actor.tenantId}:${request.userId}`) ??
          null
        );
      },
    },
    permissions: {
      async getCapabilities() {
        return capabilities;
      },
      async authorizeEntity(request) {
        entityCalls.push(request);
        return entityAllowed;
      },
    },
  };
  let nextId = 0;
  const createId = () => `send-command-${++nextId}`;
  const command = (commandInput, overrides = {}) =>
    sendMessage({
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
    memberUserId = "actor-a",
    memberState = "active",
    archived = false,
    entity,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name,
         entity_type, entity_id, archived_at, archived_by_user_id
       )
       VALUES ($1, $2, 'channel', 'private', $2, $3, $4, $5, $6)`,
      [
        tenantId,
        conversationId,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? "2026-01-01T00:00:00Z" : null,
        archived ? "archiver-a" : null,
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

  const seedAttachment = async ({
    tenantId = "tenant-a",
    attachmentId,
    uploaderUserId = "actor-a",
    checksum = `sha256:${"a".repeat(64)}`,
    createdAt = "2026-01-01T00:00:00Z",
    expiresAt = "2099-01-01T00:00:00Z",
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, checksum, created_at, updated_at, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, 'text/plain', 12, $6, $7, $7, $8)`,
      [
        tenantId,
        attachmentId,
        uploaderUserId,
        `${tenantId}/${attachmentId}`,
        `${attachmentId}.txt`,
        checksum,
        createdAt,
        expiresAt,
      ],
    );
  };

  const invalidReply = (error) => error instanceof SendMessageCommandError &&
    error.code === "invalid_reply_source" && error.statusCode === 422 &&
    error.message === "The reply source is unavailable";
  const effects = async () => (await harness.pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY tenant_id, id) FROM ${tables.conversations} c) AS conversations,
    (SELECT count(*)::int FROM ${tables.messages}) AS messages,
    (SELECT count(*)::int FROM ${tables.revisions}) AS revisions,
    (SELECT count(*)::int FROM ${tables.audit}) AS audits,
    (SELECT count(*)::int FROM ${tables.outbox}) AS events,
    (SELECT jsonb_agg(to_jsonb(k) ORDER BY tenant_id, user_id, client_key) FROM ${tables.idempotency} k) AS outcomes,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY tenant_id, conversation_id, user_id)
       FROM ${schema}.chat_read_cursors r) AS cursors
  `)).rows[0];
  const deleteSource = (id) => harness.pool.query(
    `WITH stamp AS (SELECT clock_timestamp() AS value)
     UPDATE ${tables.messages} SET content = NULL, deleted_at = stamp.value,
       deleted_by_user_id = 'actor-a', updated_at = stamp.value
     FROM stamp WHERE tenant_id = 'tenant-a' AND id = $1`, [id],
  );
  const seedThread = async (id, entity) => {
    await seedConversation({ conversationId: `${id}-parent`, entity });
    const root = await command(input(`${id}-parent`, `${id}-root`));
    await harness.pool.query(`INSERT INTO ${tables.conversations}
      (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
      VALUES ('tenant-a', $1, 'thread', 'private', $2, $3)`,
    [id, `${id}-parent`, root.message.id]);
    await harness.pool.query(`INSERT INTO ${tables.members}
      (tenant_id, conversation_id, user_id, role, state)
      VALUES ('tenant-a', $1, 'actor-a', 'member', 'active')`, [id]);
    return command(input(id, `${id}-source`, {
      content: { format: "plain", text: `Sensitive source ${id}` },
    }));
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);

    await t.test("Alice's channel message and Bob's inline reply persist without creating a thread", async () => {
      await seedConversation({ conversationId: "inline-channel", memberUserId: "alice" });
      await harness.pool.query(`INSERT INTO ${tables.members}
        (tenant_id, conversation_id, user_id, role, state)
        VALUES ('tenant-a', 'inline-channel', 'bob', 'member', 'active')`);
      const alice = { ...actor, userId: "alice" };
      const bob = { ...actor, userId: "bob" };
      const source = await command(input("inline-channel", "alice", {
        content: { format: "plain", text: "Which launch date?" },
      }), { actor: alice });
      await harness.pool.query(`INSERT INTO ${schema}.chat_read_cursors
        (tenant_id, conversation_id, user_id, last_read_sequence)
        VALUES ('tenant-a', 'inline-channel', 'bob', 1)`);
      const cursorsBefore = (await effects()).cursors;
      const replyTo = { messageId: source.message.id, notifyAuthor: true };
      const request = input("inline-channel", "bob", {
        content: { format: "plain", text: "Friday" }, replyTo,
      });
      const accepted = await command(request, { actor: bob });
      assert.equal(accepted.message.conversationId, "inline-channel");
      assert.equal(accepted.message.sequence, 2);
      assert.deepEqual(accepted.message.replyTo, replyTo);
      assert.deepEqual((await effects()).cursors, cursorsBefore);
      assert.equal("replyTo" in source.message, false);
      const beforeReplay = await effects();
      // Concurrent retries and canonical key ordering must converge on one result.
      const retries = await Promise.all(Array.from({ length: 3 }, () => command({
        ...request, replyTo: { notifyAuthor: true, messageId: source.message.id },
      }, { actor: bob })));
      for (const retry of retries) assert.deepEqual(retry, { ...accepted, reconciliationStatus: "replayed" });
      for (const changed of [
        { messageId: "different-source", notifyAuthor: true },
        { ...replyTo, notifyAuthor: false },
        undefined,
      ]) {
        const { replyTo: omitted, ...plain } = request;
        await assert.rejects(command(changed === undefined ? plain : { ...plain, replyTo: changed }, { actor: bob }),
          (error) => error instanceof SendMessageCommandError && error.code === "idempotency_conflict");
      }
      assert.deepEqual(await effects(), beforeReplay);
      const stored = (await harness.pool.query(`SELECT
        m.reply_to_message_id, m.reply_notify_author,
        k.response_body, e.payload,
        (SELECT count(*)::int FROM ${tables.conversations} WHERE type = 'thread') AS threads,
        (SELECT count(*)::int FROM ${tables.messages} WHERE conversation_id = 'inline-channel') AS messages,
        (SELECT count(*)::int FROM ${tables.outbox} WHERE stream_id = 'inline-channel' AND type = 'message.created') AS events,
        (SELECT current_message_sequence::int FROM ${tables.conversations} WHERE id = 'inline-channel') AS sequence
        FROM ${tables.messages} m
        JOIN ${tables.idempotency} k ON k.tenant_id = m.tenant_id AND k.client_key = $2
        JOIN ${tables.outbox} e ON e.tenant_id = m.tenant_id AND e.payload->'message'->>'id' = m.id
        WHERE m.id = $1`, [accepted.message.id, request.idempotencyKey])).rows[0];
      assert.deepEqual([stored.threads, stored.messages, stored.events, stored.sequence], [0, 2, 2, 2]);
      assert.equal(stored.reply_to_message_id, replyTo.messageId);
      assert.equal(stored.reply_notify_author, true);
      assert.deepEqual(stored.response_body, accepted);
      assert.deepEqual(stored.payload.message, accepted.message);
      assert.equal(JSON.stringify(stored).includes("Which launch date?"), false);

      await deleteSource(source.message.id);
      await harness.pool.query(`UPDATE ${tables.members} SET state = 'removed'
        WHERE conversation_id = 'inline-channel' AND user_id = 'bob'`);
      const afterRevocation = await effects();
      const replay = await command(request, { actor: bob });
      assert.deepEqual(replay, { ...accepted, reconciliationStatus: "replayed" });
      assert.equal(JSON.stringify(replay).includes("Which launch date?"), false);
      assert.deepEqual(await effects(), afterRevocation);
      await assert.rejects(command({ ...request, idempotencyKey: "new-revoked", clientMessageId: "new-revoked" }, { actor: bob }), invalidReply);
      assert.deepEqual(await effects(), afterRevocation);
    });

    await t.test("missing, deleted, cross-conversation and cross-tenant reply sources roll back every effect", async () => {
      await seedConversation({ conversationId: "reply-isolation" });
      const deleted = await command(input("reply-isolation", "deleted-source"));
      await deleteSource(deleted.message.id);
      await seedConversation({ conversationId: "other-source" });
      const other = await command(input("other-source", "other-source"));
      await seedConversation({ tenantId: "tenant-b", conversationId: "reply-isolation" });
      const foreign = await command(input("reply-isolation", "foreign-source"), {
        actor: { ...actor, tenantId: "tenant-b" },
      });
      const before = await effects();
      for (const messageId of ["missing-source", deleted.message.id, other.message.id, foreign.message.id]) {
        await assert.rejects(command(input("reply-isolation", `invalid-${messageId}`, {
          replyTo: { messageId, notifyAuthor: false },
        })), invalidReply);
        assert.deepEqual(await effects(), before);
      }
    });

    await t.test("inline thread replies retain their destination and parent summary; retries check current access", async () => {
      const source = await seedThread("inline-thread", { type: "case", id: "secret-case" });
      const request = input("inline-thread", "thread-reply", {
        replyTo: { messageId: source.message.id, notifyAuthor: false },
      });
      const accepted = await command(request);
      assert.equal(accepted.message.conversationId, "inline-thread");
      assert.equal(accepted.message.sequence, 2);
      assert.deepEqual(accepted.message.replyTo, request.replyTo);
      const before = await effects();
      assert.deepEqual(await command(request), { ...accepted, reconciliationStatus: "replayed" });
      assert.deepEqual(await effects(), before);
      const rows = (await harness.pool.query(`SELECT stream_id, type, payload FROM ${tables.outbox}
        WHERE stream_id IN ('inline-thread', 'inline-thread-parent') ORDER BY replay_position`)).rows;
      const created = rows.filter((row) => row.type === "message.created" && row.stream_id === "inline-thread");
      assert.equal(created.length, 2);
      assert.deepEqual(created.at(-1).payload.message, accepted.message);
      const summaries = rows.filter((row) => row.type === "message.thread_summary.updated");
      assert.equal(summaries.length, 2);
      assert.equal(summaries.at(-1).stream_id, "inline-thread-parent");
      assert.equal(summaries.at(-1).payload.rootThreadSummary.replyCount, 2);
      const streams = (await harness.pool.query(`SELECT id, current_message_sequence::int AS sequence
        FROM ${tables.conversations} WHERE type = 'thread' OR id = 'inline-thread-parent'
        ORDER BY id`)).rows;
      assert.deepEqual(streams, [
        { id: "inline-thread", sequence: 2 },
        { id: "inline-thread-parent", sequence: 1 },
      ]);

      await deleteSource(source.message.id);
      await harness.pool.query(`UPDATE ${tables.conversations} SET archived_at = clock_timestamp(),
        archived_by_user_id = 'actor-a' WHERE id = 'inline-thread'`);
      const archived = await effects();
      assert.deepEqual(await command(request), { ...accepted, reconciliationStatus: "replayed" });
      assert.deepEqual(await effects(), archived, "reconciliation does not reopen the child");
      entityAllowed = false;
      await assert.rejects(command(request), (error) => error instanceof ChatAuthorizationError);
      entityAllowed = true;
      await harness.pool.query(`UPDATE ${tables.members} SET state = 'removed'
        WHERE conversation_id = 'inline-thread-parent'`);
      const revoked = await effects();
      await assert.rejects(command(request), (error) => error instanceof ChatAuthorizationError);
      assert.deepEqual(await effects(), revoked);
      const metadata = (await harness.pool.query(`SELECT response_body FROM ${tables.idempotency}
        WHERE client_key = $1`, [request.idempotencyKey])).rows[0];
      assert.equal(JSON.stringify(metadata).includes(source.message.content.text), false);
    });

    await t.test("thread parent membership, entity denial and send capability cannot be bypassed by a reply", async () => {
      const source = await seedThread("denied-thread", { type: "case", id: "denied-case" });
      const request = input("denied-thread", "denied-reply", {
        replyTo: { messageId: source.message.id, notifyAuthor: false },
      });
      const before = await effects();
      entityAllowed = false;
      await assert.rejects(command(request), invalidReply);
      await assert.rejects(command(input("denied-thread", "plain-entity-denied")), (error) => error instanceof ChatAuthorizationError);
      entityAllowed = true;
      capabilities = ["thread.create", "thread.manage"];
      await assert.rejects(command(request), (error) => error instanceof ChatAuthorizationError);
      capabilities = ["message.send"];
      assert.deepEqual(await effects(), before);
      await harness.pool.query(`UPDATE ${tables.conversations} SET archived_at = clock_timestamp(),
        archived_by_user_id = 'actor-a' WHERE id = 'denied-thread-parent'`);
      const archived = await effects();
      await assert.rejects(command(request), invalidReply);
      assert.deepEqual(await effects(), archived);
      await harness.pool.query(`UPDATE ${tables.conversations} SET archived_at = NULL,
        archived_by_user_id = NULL WHERE id = 'denied-thread-parent'`);
      await harness.pool.query(`UPDATE ${tables.members} SET state = 'removed'
        WHERE conversation_id = 'denied-thread-parent'`);
      const revoked = await effects();
      await assert.rejects(command(request), invalidReply);
      await assert.rejects(command(input("denied-thread", "plain-parent-denied")), (error) => error instanceof ChatAuthorizationError);
      assert.deepEqual(await effects(), revoked);
    });

    await t.test("reply source and inherited access locks prevent deletion and revocation during persistence", async () => {
      const source = await seedThread("locked-thread");
      let checked = false;
      const lockingDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              const result = await connection.query(sql, values);
              if (sql.includes("deleted_at IS NULL") && sql.includes("FOR SHARE")) {
                const contender = await harness.pool.connect();
                try {
                  await contender.query("SET lock_timeout = '100ms'");
                  for (const statement of [
                    `WITH stamp AS (SELECT clock_timestamp() AS value)
                     UPDATE ${tables.messages} SET deleted_at = stamp.value, deleted_by_user_id = 'actor-a', updated_at = stamp.value FROM stamp WHERE id = $1`,
                    `UPDATE ${tables.members} SET state = 'removed' WHERE conversation_id = 'locked-thread-parent'`,
                    `UPDATE ${tables.members} SET state = 'removed' WHERE conversation_id = 'locked-thread'`,
                    `UPDATE ${tables.conversations} SET archived_at = clock_timestamp(), archived_by_user_id = 'actor-a' WHERE id = 'locked-thread-parent'`,
                  ]) {
                    await assert.rejects(contender.query(statement, statement.includes("$1") ? [source.message.id] : []),
                      (error) => error.code === "55P03");
                  }
                  checked = true;
                } finally {
                  await contender.query("RESET lock_timeout");
                  contender.release();
                }
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const accepted = await command(input("locked-thread", "locked-reply", {
        replyTo: { messageId: source.message.id, notifyAuthor: true },
      }), { database: lockingDatabase });
      assert.equal(checked, true);
      assert.equal(accepted.message.sequence, 2);
      await deleteSource(source.message.id);
    });

    await t.test("persists message, revision, attachment, sanitized audit, outbox, and outcome", async () => {
      await seedConversation({
        conversationId: "success",
        entity: { type: "order", id: "order-42" },
      });
      await seedAttachment({ attachmentId: "attachment-success" });
      const sensitiveText = "Order **42** includes private details";
      const commandInput = input("success", "success", {
        clientMessageId: " optimistic/client:alpha ",
        content: {
          format: "markdown",
          text: sensitiveText,
          mentions: [{ type: "user", userId: "mentioned-a" }],
          attachments: [{ attachmentId: "attachment-success" }],
        },
      });

      const result = await command(commandInput);

      assert.equal(result.operation, "send");
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.clientMessageId, " optimistic/client:alpha ");
      assert.equal(result.canonicalRevision, 1);
      assert.equal(result.message.sequence, 1);
      assert.equal(result.message.content.text, sensitiveText);
      assert.deepEqual(result.message.author, { type: "user", userId: "actor-a" });
      assert.equal(directoryCalls.at(-1)?.userId, "mentioned-a");
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "order", id: "order-42" },
        action: "message.send",
      });

      const persisted = (
        await harness.pool.query(
          `SELECT
             conversation.current_message_sequence::integer AS current_sequence,
             message.id AS message_id,
             message.sequence::integer AS message_sequence,
             message.client_message_id,
             message.content AS message_content,
             revision.revision_number::integer AS revision_number,
             attachment.state AS attachment_state,
             attachment.attached_message_id,
             audit.action AS audit_action,
             audit.metadata AS audit_metadata,
             audit.metadata::text AS audit_text,
             event.protocol_version::integer AS protocol_version,
             event.type AS event_type,
             event.payload AS event_payload,
             outcome.state AS outcome_state,
             outcome.response_body AS response_body
           FROM ${tables.conversations} AS conversation
           INNER JOIN ${tables.messages} AS message
             ON message.tenant_id = conversation.tenant_id
            AND message.conversation_id = conversation.id
           INNER JOIN ${tables.revisions} AS revision
             ON revision.tenant_id = message.tenant_id
            AND revision.message_id = message.id
           INNER JOIN ${tables.attachments} AS attachment
             ON attachment.tenant_id = message.tenant_id
            AND attachment.attached_message_id = message.id
           INNER JOIN ${tables.audit} AS audit
             ON audit.tenant_id = message.tenant_id
            AND audit.target_type = 'message'
            AND audit.target_id = message.id
           INNER JOIN ${tables.outbox} AS event
             ON event.tenant_id = message.tenant_id
            AND event.stream_id = message.conversation_id
            AND event.type = 'message.created'
           INNER JOIN ${tables.idempotency} AS outcome
             ON outcome.tenant_id = message.tenant_id
            AND outcome.user_id = message.author_user_id
            AND outcome.client_key = $1
           WHERE conversation.tenant_id = 'tenant-a'
             AND conversation.id = 'success'`,
          [commandInput.idempotencyKey],
        )
      ).rows[0];

      assert.equal(persisted.current_sequence, 1);
      assert.equal(persisted.message_id, result.message.id);
      assert.equal(persisted.message_sequence, 1);
      assert.equal(persisted.client_message_id, commandInput.clientMessageId);
      assert.deepEqual(persisted.message_content, commandInput.content);
      assert.equal(persisted.revision_number, 1);
      assert.equal(persisted.attachment_state, "attached");
      assert.equal(persisted.attached_message_id, result.message.id);
      assert.equal(persisted.audit_action, "message.created");
      assert.deepEqual(persisted.audit_metadata, {
        conversationId: "success",
        sequence: 1,
        attachmentCount: 1,
        userMentionCount: 1,
      });
      assert.equal(persisted.audit_text.includes(sensitiveText), false);
      assert.equal(persisted.audit_text.includes(commandInput.idempotencyKey), false);
      assert.equal(persisted.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(persisted.event_type, "message.created");
      assert.deepEqual(persisted.event_payload, {
        message: result.message,
        clientMessageId: commandInput.clientMessageId,
      });
      assert.equal(persisted.outcome_state, "completed");
      assert.deepEqual(persisted.response_body, result);
    });

    await t.test("a fractional-millisecond claim completes and replays one send", async () => {
      const conversationId = "send-fractional-claim";
      await seedConversation({ conversationId });
      const commandInput = input(conversationId, "fractional-claim");
      // Match sendMessage's recursively sorted keys for this plain-content fixture.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        clientMessageId: commandInput.clientMessageId,
        content: { format: commandInput.content.format, text: commandInput.content.text },
        conversationId,
        operation: commandInput.operation,
      })).digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency} (
           tenant_id, user_id, operation_name, client_key, request_hash,
           state, created_at, updated_at, expires_at
         )
         SELECT $1, $2, 'message.send', $3, $4, 'pending',
                claimed_at, claimed_at, claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at, expires_at::text`,
        [actor.tenantId, actor.userId, commandInput.idempotencyKey, requestHash],
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
              // the returned allocation clock with the truncated claim Date.
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

      const applied = await command(commandInput, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.message.createdAt, claim.created_at.toISOString());
      assert.equal(applied.message.updatedAt, claim.created_at.toISOString());
      const storedOutcome = async () => (await harness.pool.query(
        `SELECT state, response_status, response_body,
                created_at::text, updated_at::text, completed_at::text, expires_at::text,
                completed_at = created_at AS completion_equals_claim,
                updated_at = created_at AS update_equals_claim,
                created_at - $4::timestamptz = interval '456 microseconds' AS precision_gap
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = 'message.send' AND client_key = $3`,
        [actor.tenantId, actor.userId, commandInput.idempotencyKey, claim.created_at],
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

      assert.deepEqual(await command(commandInput, { database: clockDatabase }), {
        ...applied,
        reconciliationStatus: "replayed",
      });
      assert.equal(clockSamples, 1);
      assert.deepEqual(await storedOutcome(), outcome);
      const effects = (await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.messages}
            WHERE tenant_id = $1 AND conversation_id = $2) AS messages,
           (SELECT count(*)::integer FROM ${tables.revisions}
            WHERE tenant_id = $1 AND message_id = $3) AS revisions,
           (SELECT count(*)::integer FROM ${tables.audit}
            WHERE tenant_id = $1 AND target_id = $3) AS audits,
           (SELECT count(*)::integer FROM ${tables.outbox}
            WHERE tenant_id = $1 AND stream_id = $2) AS outbox`,
        [actor.tenantId, conversationId, applied.message.id],
      )).rows[0];
      assert.deepEqual(effects, { messages: 1, revisions: 1, audits: 1, outbox: 1 });
      const event = (await harness.pool.query(
        `SELECT occurred_at, payload FROM ${tables.outbox}
         WHERE tenant_id = $1 AND stream_id = $2`,
        [actor.tenantId, conversationId],
      )).rows[0];
      assert.equal(event.occurred_at.toISOString(), claim.created_at.toISOString());
      assert.deepEqual(event.payload, {
        message: applied.message,
        clientMessageId: commandInput.clientMessageId,
      });
    });

    await t.test("rolls every write back after an injected late outbox failure", async () => {
      await seedConversation({ conversationId: "rollback" });
      await seedAttachment({ attachmentId: "attachment-rollback" });
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
      const commandInput = input("rollback", "rollback", {
        content: {
          format: "plain",
          text: "This must roll back",
          attachments: [{ attachmentId: "attachment-rollback" }],
        },
      });

      await assert.rejects(
        command(commandInput, { database: lateFailureDatabase }),
        /injected late outbox failure/,
      );

      const state = (
        await harness.pool.query(
          `SELECT
             (SELECT current_message_sequence::integer
              FROM ${tables.conversations} WHERE id = 'rollback') AS sequence,
             (SELECT count(*)::integer FROM ${tables.messages}
              WHERE conversation_id = 'rollback') AS messages,
             (SELECT count(*)::integer FROM ${tables.revisions} AS revision
              INNER JOIN ${tables.messages} AS message
                ON message.tenant_id = revision.tenant_id
               AND message.id = revision.message_id
              WHERE message.conversation_id = 'rollback') AS revisions,
             (SELECT count(*)::integer FROM ${tables.audit}
              WHERE metadata ->> 'conversationId' = 'rollback') AS audits,
             (SELECT count(*)::integer FROM ${tables.outbox}
              WHERE stream_id = 'rollback') AS outbox,
             (SELECT count(*)::integer FROM ${tables.idempotency}
              WHERE client_key = $1) AS outcomes,
             (SELECT state FROM ${tables.attachments}
              WHERE id = 'attachment-rollback') AS attachment_state`,
          [commandInput.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(state, {
        sequence: 0,
        messages: 0,
        revisions: 0,
        audits: 0,
        outbox: 0,
        outcomes: 0,
        attachment_state: "pending",
      });
    });

    await t.test("allocates contiguous unique sequences for concurrent sends", async () => {
      await seedConversation({ conversationId: "concurrent" });
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          command(input("concurrent", `concurrent-${index}`)),
        ),
      );

      assert.deepEqual(
        results.map(({ message }) => message.sequence).sort((a, b) => a - b),
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      assert.equal(new Set(results.map(({ message }) => message.id)).size, 12);
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT sequence::integer AS sequence
             FROM ${tables.messages}
             WHERE tenant_id = 'tenant-a' AND conversation_id = 'concurrent'
             ORDER BY sequence`,
          )
        ).rows.map(({ sequence }) => sequence),
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
    });

    await t.test("replays the canonical result and rejects a conflicting key", async () => {
      await seedConversation({ conversationId: "idempotent" });
      const firstInput = input("idempotent", "canonical", {
        content: {
          format: "markdown",
          text: "Canonical",
          blocks: [{ type: "host", data: { z: 1, a: 2 } }],
        },
      });
      const applied = await command(firstInput);
      const replayed = await command({
        ...firstInput,
        content: {
          format: "markdown",
          text: "Canonical",
          blocks: [{ type: "host", data: { a: 2, z: 1 } }],
        },
      });

      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(replayed.reconciliationStatus, "replayed");
      assert.equal(replayed.clientMessageId, firstInput.clientMessageId);
      assert.deepEqual(replayed.message, applied.message);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${tables.messages}
             WHERE conversation_id = 'idempotent'`,
          )
        ).rows[0].count,
        1,
      );

      await assert.rejects(
        command({
          ...firstInput,
          content: { ...firstInput.content, text: "Conflicting content" },
        }),
        (error) =>
          error instanceof SendMessageCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT current_message_sequence::integer AS sequence
             FROM ${tables.conversations}
             WHERE id = 'idempotent'`,
          )
        ).rows[0].sequence,
        1,
      );
    });

    await t.test("requires capability, active membership, tenant scope, archive state, and entity access", async () => {
      await seedConversation({ conversationId: "no-capability" });
      await seedConversation({
        conversationId: "inactive-member",
        memberState: "left",
      });
      await seedConversation({ conversationId: "archived", archived: true });
      await seedConversation({
        tenantId: "tenant-b",
        conversationId: "tenant-b-only",
        memberUserId: "actor-a",
      });
      await seedConversation({
        conversationId: "entity-denied",
        entity: { type: "invoice", id: "invoice-denied" },
      });

      capabilities = [];
      await assert.rejects(
        command(input("no-capability", "no-capability")),
        (error) => error instanceof ChatAuthorizationError,
      );
      capabilities = ["message.send"];

      for (const [conversationId, suffix] of [
        ["inactive-member", "inactive-member"],
        ["archived", "archived"],
        ["tenant-b-only", "cross-tenant"],
      ]) {
        await assert.rejects(
          command(input(conversationId, suffix)),
          (error) => error instanceof ChatAuthorizationError,
        );
      }

      entityAllowed = false;
      await assert.rejects(
        command(input("entity-denied", "entity-denied")),
        (error) => error instanceof ChatAuthorizationError,
      );
      entityAllowed = true;

      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT id, current_message_sequence::integer AS sequence
             FROM ${tables.conversations}
             WHERE id IN (
               'no-capability', 'inactive-member', 'archived',
               'tenant-b-only', 'entity-denied'
             )
             ORDER BY id`,
          )
        ).rows,
        [
          { id: "archived", sequence: 0 },
          { id: "entity-denied", sequence: 0 },
          { id: "inactive-member", sequence: 0 },
          { id: "no-capability", sequence: 0 },
          { id: "tenant-b-only", sequence: 0 },
        ],
      );
    });

    await t.test("rejects cross-tenant, unowned, unfinished, expired, and attached references", async () => {
      await seedConversation({ conversationId: "attachment-isolation" });
      await seedAttachment({
        tenantId: "tenant-b",
        attachmentId: "attachment-cross-tenant",
      });
      await seedAttachment({
        attachmentId: "attachment-unowned",
        uploaderUserId: "other-user",
      });
      await seedAttachment({
        attachmentId: "attachment-unfinished",
        checksum: null,
      });
      await seedAttachment({
        attachmentId: "attachment-expired",
        createdAt: "2020-01-01T00:00:00Z",
        expiresAt: "2021-01-01T00:00:00Z",
      });

      for (const attachmentId of [
        "attachment-cross-tenant",
        "attachment-unowned",
        "attachment-unfinished",
        "attachment-expired",
        "attachment-success",
      ]) {
        await assert.rejects(
          command(
            input("attachment-isolation", attachmentId, {
              content: {
                format: "plain",
                text: "Attachment isolation",
                attachments: [{ attachmentId }],
              },
            }),
          ),
          (error) =>
            error instanceof SendMessageCommandError &&
            error.code === "attachment_unavailable",
        );
      }
      assert.equal(
        (
          await harness.pool.query(
            `SELECT current_message_sequence::integer AS sequence
             FROM ${tables.conversations}
             WHERE id = 'attachment-isolation'`,
          )
        ).rows[0].sequence,
        0,
      );
    });

    await t.test("validates mentioned users and rejects caller-supplied identity", async () => {
      await seedConversation({ conversationId: "mention-validation" });
      await assert.rejects(
        command(
          input("mention-validation", "missing-mention", {
            content: {
              format: "plain",
              text: "Hello",
              mentions: [{ type: "user", userId: "missing-user" }],
            },
          }),
        ),
        (error) =>
          error instanceof SendMessageCommandError &&
          error.code === "invalid_mention",
      );
      await assert.rejects(
        command({
          ...input("mention-validation", "spoofed"),
          tenantId: "tenant-b",
        }),
        (error) =>
          error instanceof MessageMutationParseError &&
          error.code === "trusted_identity_field",
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT current_message_sequence::integer AS sequence
             FROM ${tables.conversations}
             WHERE id = 'mention-validation'`,
          )
        ).rows[0].sequence,
        0,
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
