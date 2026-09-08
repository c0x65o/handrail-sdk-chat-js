import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  ARCHIVE_CONVERSATION_ADMIN_CAPABILITY,
  ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
  ARCHIVE_CONVERSATION_IDEMPOTENCY_OPERATION,
  ArchiveConversationCommandError,
  ChatAuthorizationError,
  archiveConversation,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (suffix, overrides = {}) => ({
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId: "owner-target",
  expectedLifecycleRevision: 1,
  idempotencyKey: `archive-conversation-${suffix}`,
  ...overrides,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

test("transactional archive-conversation command applies, reconciles, authorizes, and rolls back PostgreSQL state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_archive_command",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    cursors: `${schema}.chat_read_cursors`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let capabilities = [];
  let entityMode = "allow";
  const entityCalls = [];
  const permissions = {
    async getCapabilities() {
      return capabilities;
    },
    async authorizeEntity(request) {
      entityCalls.push(request);
      if (entityMode === "error") throw new Error("sensitive host failure");
      return entityMode === "allow";
    },
  };
  let nextId = 0;
  const command = (request, overrides = {}) =>
    archiveConversation({
      database: harness.pool,
      schema: harness.schema,
      actor,
      input: request,
      permissions,
      createId: () => `archive-command-${++nextId}`,
      ...overrides,
    });

  const transitionCounts = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a' AND stream_id = $1) AS outbox`,
      [conversationId],
    );
    return result.rows[0];
  };

  const storedConversation = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT lifecycle_revision::integer AS lifecycle_revision,
              archived_at, archived_by_user_id
         FROM ${tables.conversations}
        WHERE tenant_id = 'tenant-a' AND id = $1`,
      [conversationId],
    );
    return result.rows[0];
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          current_message_sequence, lifecycle_revision, archived_at,
          archived_by_user_id)
       VALUES
         ('tenant-a', 'owner-target', 'channel', 'private', 'Owner target',
          'work_order', 'work-order-42', 1, 1, NULL, NULL),
         ('tenant-a', 'admin-target', 'direct', 'private', NULL,
          NULL, NULL, 0, 1, NULL, NULL),
         ('tenant-a', 'member-target', 'channel', 'private', 'Member target',
          NULL, NULL, 0, 1, NULL, NULL),
         ('tenant-a', 'left-owner-target', 'channel', 'private', 'Left owner',
          NULL, NULL, 0, 1, NULL, NULL),
         ('tenant-a', 'entity-denied-target', 'channel', 'private', 'Entity denied',
          'invoice', 'invoice-secret', 0, 1, NULL, NULL),
         ('tenant-a', 'rollback-audit-target', 'channel', 'private', 'Audit rollback',
          NULL, NULL, 0, 1, NULL, NULL),
         ('tenant-a', 'rollback-outbox-target', 'channel', 'private', 'Outbox rollback',
          NULL, NULL, 0, 1, NULL, NULL),
         ('tenant-a', 'entity-parent', 'channel', 'private', 'Entity parent',
          'case', 'case-9', 1, 1, NULL, NULL),
         ('tenant-b', 'cross-tenant-target', 'channel', 'private', 'Cross tenant',
          NULL, NULL, 0, 1, NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'retained-message', 'owner-target', 1, 'actor-a',
          'retained-client-message',
          '{"format":"plain","text":"sensitive retained body"}'),
         ('tenant-a', 'entity-root', 'entity-parent', 1, 'actor-a',
          'entity-root-client', '{"format":"plain","text":"entity root"}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, parent_conversation_id,
          root_message_id, lifecycle_revision)
       VALUES ('tenant-a', 'entity-thread-target', 'thread', 'private',
               'entity-parent', 'entity-root', 1)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'owner-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'owner-target', 'retained-member', 'member', 'active'),
         ('tenant-a', 'member-target', 'actor-a', 'member', 'active'),
         ('tenant-a', 'left-owner-target', 'actor-a', 'owner', 'left'),
         ('tenant-a', 'entity-denied-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'rollback-audit-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'rollback-outbox-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'entity-thread-target', 'actor-a', 'owner', 'active'),
         ('tenant-b', 'cross-tenant-target', 'actor-a', 'owner', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.cursors}
         (tenant_id, conversation_id, user_id, last_read_sequence,
          manual_unread_from_sequence)
       VALUES ('tenant-a', 'owner-target', 'actor-a', 1, 1)`,
    );

    await t.test("archives and restores exactly once while retaining conversation data", async () => {
      const archiveRequest = input("owner-archive");
      const archived = await command(archiveRequest);
      assert.equal(archived.reconciliationStatus, "applied");
      assert.equal(archived.lifecycleRevision, 2);
      assert.equal(archived.archiveState.status, "archived");
      assert.equal(archived.archiveState.archivedByUserId, actor.userId);
      assert.deepEqual(await storedConversation("owner-target"), {
        lifecycle_revision: 2,
        archived_at: new Date(archived.archiveState.archivedAt),
        archived_by_user_id: actor.userId,
      });
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "work_order", id: "work-order-42" },
        action: ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
      });

      const replay = await command(archiveRequest);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.equal(replay.lifecycleRevision, 2);
      assert.deepEqual(replay.archiveState, archived.archiveState);
      assert.deepEqual(await transitionCounts("owner-target"), {
        audit: 1,
        outbox: 1,
      });
      await assert.rejects(
        command({ ...archiveRequest, expectedLifecycleRevision: 2 }),
        (error) =>
          error instanceof ArchiveConversationCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );

      const retained = await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.messages}
             WHERE tenant_id = 'tenant-a' AND conversation_id = 'owner-target') AS messages,
           (SELECT count(*)::integer FROM ${tables.members}
             WHERE tenant_id = 'tenant-a' AND conversation_id = 'owner-target') AS members,
           (SELECT last_read_sequence::integer FROM ${tables.cursors}
             WHERE tenant_id = 'tenant-a' AND conversation_id = 'owner-target'
               AND user_id = 'actor-a') AS last_read_sequence,
           (SELECT manual_unread_from_sequence::integer FROM ${tables.cursors}
             WHERE tenant_id = 'tenant-a' AND conversation_id = 'owner-target'
               AND user_id = 'actor-a') AS manual_unread_from_sequence`,
      );
      assert.deepEqual(retained.rows[0], {
        messages: 1,
        members: 2,
        last_read_sequence: 1,
        manual_unread_from_sequence: 1,
      });

      const restoreRequest = input("owner-restore", {
        intent: "restore",
        expectedLifecycleRevision: 2,
      });
      const restored = await command(restoreRequest);
      assert.deepEqual(restored.archiveState, { status: "active" });
      assert.equal(restored.reconciliationStatus, "applied");
      assert.equal(restored.lifecycleRevision, 3);
      assert.deepEqual(await storedConversation("owner-target"), {
        lifecycle_revision: 3,
        archived_at: null,
        archived_by_user_id: null,
      });
      assert.deepEqual(await transitionCounts("owner-target"), {
        audit: 2,
        outbox: 2,
      });

      const restoreReplay = await command(restoreRequest);
      assert.equal(restoreReplay.reconciliationStatus, "replayed");
      assert.equal(restoreReplay.lifecycleRevision, 3);
      assert.deepEqual(restoreReplay.archiveState, { status: "active" });
      assert.deepEqual(await storedConversation("owner-target"), {
        lifecycle_revision: 3,
        archived_at: null,
        archived_by_user_id: null,
      });
      assert.deepEqual(await transitionCounts("owner-target"), {
        audit: 2,
        outbox: 2,
      });
    });

    await t.test("completes and replays an archive with a fractional-millisecond claim", async () => {
      const conversationId = "archive-submillisecond-claim";
      await harness.pool.query(
        `INSERT INTO ${tables.conversations}
           (tenant_id, id, type, visibility, name, lifecycle_revision,
            created_at, updated_at)
         VALUES ($1, $2, 'channel', 'private', $2, 1,
                 '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
        [actor.tenantId, conversationId],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'owner', 'active')`,
        [actor.tenantId, conversationId, actor.userId],
      );
      const request = input("submillisecond-claim", { conversationId });
      // Match hashRequest's canonical key order; idempotencyKey is excluded.
      const requestHash = `sha256:${createHash("sha256")
        .update(JSON.stringify({
          conversationId: request.conversationId,
          expectedLifecycleRevision: request.expectedLifecycleRevision,
          intent: request.intent,
          operation: request.operation,
        }))
        .digest("hex")}`;
      const claim = (await harness.pool.query(
        `INSERT INTO ${tables.idempotency}
           (tenant_id, user_id, operation_name, client_key, request_hash,
            created_at, updated_at, expires_at)
         SELECT $1, $2, $3, $4, $5, claimed_at, claimed_at,
                claimed_at + interval '2 minutes'
         FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                      + interval '456 microseconds' AS claimed_at) AS clock
         RETURNING created_at, expires_at::text`,
        [actor.tenantId, actor.userId, ARCHIVE_CONVERSATION_IDEMPOTENCY_OPERATION,
          request.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      // Every statement executes in PostgreSQL. Only the returned conversation
      // clock sample is replaced with the claim's millisecond Date.
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              const result = await connection.query(sql, values);
              if (sql.includes("clock_timestamp() AS occurred_at") &&
                  sql.includes(`FROM ${tables.conversations} AS conversation`)) {
                assert.deepEqual(values, [actor.tenantId, conversationId, actor.userId]);
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
      assert.deepEqual(await transitionCounts(conversationId), { audit: 0, outbox: 0 });
      const result = await command(request, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.lifecycleRevision, 2);
      assert.deepEqual(result.archiveState, {
        status: "archived",
        archivedAt: claim.created_at.toISOString(),
        archivedByUserId: actor.userId,
      });
      const persisted = await storedConversation(conversationId);
      assert.deepEqual(persisted, {
        lifecycle_revision: 2,
        archived_at: claim.created_at,
        archived_by_user_id: actor.userId,
      });
      const storedOutcome = async () => (await harness.pool.query(
        `SELECT state, request_hash, response_status, response_body,
                created_at::text, updated_at::text, completed_at::text, expires_at::text,
                completed_at >= created_at AS completion_not_before_claim,
                updated_at >= created_at AS update_not_before_claim,
                created_at - $5::timestamptz = interval '456 microseconds' AS precision_gap,
                completed_at - $5::timestamptz = interval '456 microseconds' AS completion_precision,
                updated_at - $5::timestamptz = interval '456 microseconds' AS update_precision,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = $3 AND client_key = $4`,
        [actor.tenantId, actor.userId, ARCHIVE_CONVERSATION_IDEMPOTENCY_OPERATION,
          request.idempotencyKey, claim.created_at],
      )).rows;
      const outcome = await storedOutcome();
      assert.equal(outcome.length, 1);
      assert.equal(outcome[0].state, "completed");
      assert.equal(outcome[0].request_hash, requestHash);
      assert.equal(outcome[0].response_status, 200);
      assert.deepEqual(outcome[0].response_body, result);
      assert.equal(outcome[0].expires_at, claim.expires_at);
      // SQL intervals and text retain the fractional precision that Date loses.
      for (const field of ["completion_not_before_claim", "update_not_before_claim",
        "precision_gap", "completion_precision", "update_precision", "ttl_unchanged"]) {
        assert.equal(outcome[0][field], true, field);
      }
      assert.deepEqual(await transitionCounts(conversationId), { audit: 1, outbox: 1 });

      assert.deepEqual(await command(request), { ...result, reconciliationStatus: "replayed" });
      assert.deepEqual(await storedConversation(conversationId), persisted);
      assert.deepEqual(await transitionCounts(conversationId), { audit: 1, outbox: 1 });
      assert.deepEqual(await storedOutcome(), outcome);
    });

    await t.test("persists convergent and stale-revision outcomes without effects", async () => {
      const convergentRequest = input("already-active", {
        intent: "restore",
        expectedLifecycleRevision: 1,
      });
      const convergent = await command(convergentRequest);
      assert.equal(convergent.reconciliationStatus, "already_requested_state");
      assert.equal(convergent.lifecycleRevision, 3);
      assert.deepEqual(convergent.archiveState, { status: "active" });
      const convergentReplay = await command(convergentRequest);
      assert.equal(convergentReplay.reconciliationStatus, "replayed");
      assert.equal(convergentReplay.lifecycleRevision, 3);

      const conflictRequest = input("stale", {
        expectedLifecycleRevision: 1,
      });
      const conflict = await command(conflictRequest);
      assert.equal(conflict.reconciliationStatus, "lifecycle_conflict");
      assert.equal(conflict.lifecycleRevision, 3);
      assert.deepEqual(conflict.archiveState, { status: "active" });
      assert.deepEqual(await command(conflictRequest), conflict);
      assert.deepEqual(await transitionCounts("owner-target"), {
        audit: 2,
        outbox: 2,
      });
    });

    await t.test("allows the admin capability and rejects all other target access safely", async () => {
      capabilities = [ARCHIVE_CONVERSATION_ADMIN_CAPABILITY];
      const adminResult = await command(
        input("admin", { conversationId: "admin-target" }),
      );
      assert.equal(adminResult.reconciliationStatus, "applied");
      capabilities = [];

      for (const request of [
        input("member", { conversationId: "member-target" }),
        input("left-owner", { conversationId: "left-owner-target" }),
        input("missing", { conversationId: "missing-target" }),
        input("cross-tenant", { conversationId: "cross-tenant-target" }),
      ]) {
        await assert.rejects(command(request), sanitizedAuthorizationFailure);
      }
    });

    await t.test("enforces host entity access for channels and inherited thread entities", async () => {
      entityMode = "deny";
      await assert.rejects(
        command(input("entity-denied", { conversationId: "entity-denied-target" })),
        sanitizedAuthorizationFailure,
      );
      entityMode = "error";
      await assert.rejects(
        command(input("entity-error", { conversationId: "entity-denied-target" })),
        sanitizedAuthorizationFailure,
      );
      entityMode = "allow";
      const threadResult = await command(
        input("entity-thread", { conversationId: "entity-thread-target" }),
      );
      assert.equal(threadResult.reconciliationStatus, "applied");
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "case", id: "case-9" },
        action: ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
      });
    });

    await t.test("emits protocol-versioned outbox and sanitized audit content", async () => {
      const persisted = await harness.pool.query(
        `SELECT audit.action, audit.metadata, audit.metadata::text AS audit_text,
                event.type, event.protocol_version::integer AS protocol_version,
                event.payload, event.payload::text AS payload_text,
                event.expires_at > event.occurred_at AS bounded_retention
           FROM ${tables.audit} AS audit
           JOIN ${tables.outbox} AS event
             ON event.tenant_id = audit.tenant_id
            AND event.stream_id = audit.target_id
            AND event.type = audit.action
            AND event.occurred_at = audit.occurred_at
          WHERE audit.tenant_id = 'tenant-a'
            AND audit.target_id = 'owner-target'
          ORDER BY audit.occurred_at`,
      );
      assert.deepEqual(
        persisted.rows.map(({ action, type }) => ({ action, type })),
        [
          { action: "conversation.archived", type: "conversation.archived" },
          { action: "conversation.restored", type: "conversation.restored" },
        ],
      );
      assert.deepEqual(persisted.rows[0].metadata, {
        conversationId: "owner-target",
        intent: "archive",
        previousState: "active",
        currentState: "archived",
        previousLifecycleRevision: 1,
        currentLifecycleRevision: 2,
      });
      for (const row of persisted.rows) {
        assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
        assert.equal(row.bounded_retention, true);
        assert.deepEqual(row.payload, row.metadata);
        for (const secret of [
          "sensitive retained body",
          "sensitive-host-role",
          "archive-conversation-owner-archive",
        ]) {
          assert.equal(row.audit_text.includes(secret), false);
          assert.equal(row.payload_text.includes(secret), false);
        }
      }
    });

    await t.test("rolls back transition and idempotency on audit or outbox failure", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_archive_audit()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.target_id = 'rollback-audit-target' THEN
               RAISE EXCEPTION 'injected archive audit failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_archive_outbox()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.stream_id = 'rollback-outbox-target' THEN
               RAISE EXCEPTION 'injected archive outbox failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_archive_audit
           BEFORE INSERT ON ${tables.audit}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_archive_audit()`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_archive_outbox
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_archive_outbox()`,
      );

      for (const [conversationId, suffix, message] of [
        ["rollback-audit-target", "rollback-audit", /injected archive audit failure/],
        ["rollback-outbox-target", "rollback-outbox", /injected archive outbox failure/],
      ]) {
        const request = input(suffix, { conversationId });
        await assert.rejects(command(request), message);
        assert.deepEqual(await storedConversation(conversationId), {
          lifecycle_revision: 1,
          archived_at: null,
          archived_by_user_id: null,
        });
        assert.deepEqual(await transitionCounts(conversationId), {
          audit: 0,
          outbox: 0,
        });
        const idempotency = await harness.pool.query(
          `SELECT count(*)::integer AS count FROM ${tables.idempotency}
            WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
              AND client_key = $1`,
          [request.idempotencyKey],
        );
        assert.equal(idempotency.rows[0].count, 0);
      }
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
