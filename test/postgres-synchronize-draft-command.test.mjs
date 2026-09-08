import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
} from "@handrail/chat";
import {
  ChatAuthorizationError,
  SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
  SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE,
  SynchronizeDraftCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  synchronizeDraft,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "author-a",
  roles: Object.freeze(["employee"]),
});
const otherActor = Object.freeze({
  tenantId: "tenant-a",
  userId: "author-b",
  roles: Object.freeze(["employee"]),
});
const crossTenantActor = Object.freeze({
  tenantId: "tenant-b",
  userId: "author-a",
  roles: Object.freeze(["employee"]),
});

const replaceInput = (conversationId, suffix, overrides = {}) => ({
  operation: "synchronize_draft",
  intent: "replace",
  conversationId,
  baseRevision: 0,
  deviceMutationId: `device-${suffix}`,
  idempotencyKey: `draft-${suffix}`,
  content: {
    format: "markdown",
    text: `private draft ${suffix}`,
    attachments: [{ attachmentId: `attachment-${suffix}` }],
  },
  ...overrides,
});

const clearInput = (conversationId, suffix, baseRevision) => ({
  operation: "synchronize_draft",
  intent: "clear",
  conversationId,
  baseRevision,
  deviceMutationId: `device-${suffix}`,
  idempotencyKey: `draft-${suffix}`,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

test("synchronize-draft command is private, convergent, idempotent, and atomic", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_synchronize_draft",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    drafts: `${schema}.chat_drafts`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let nextId = 0;
  const command = (input, overrides = {}) =>
    synchronizeDraft({
      database: harness.pool,
      schema: harness.schema,
      actor,
      input,
      createId: () => `draft-command-${++nextId}`,
      ...overrides,
    });

  const storedDraft = async (tenantId, conversationId, userId) =>
    (
      await harness.pool.query(
        `SELECT content, revision::integer AS revision, created_at, updated_at
         FROM ${tables.drafts}
         WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
        [tenantId, conversationId, userId],
      )
    ).rows[0];

  const effectCounts = async (tenantId, conversationId, userId) =>
    (
      await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.drafts}
            WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3)
             AS drafts,
           (SELECT count(*)::integer FROM ${tables.outbox}
            WHERE tenant_id = $1 AND type = $4
              AND payload->'result'->>'conversationId' = $2)
             AS outbox,
           (SELECT count(*)::integer FROM ${tables.idempotency}
            WHERE tenant_id = $1 AND user_id = $3
              AND operation_name = $5)
             AS idempotency,
           (SELECT count(*)::integer FROM ${tables.audit}
            WHERE tenant_id = $1 AND target_id = $2)
             AS audit`,
        [
          tenantId,
          conversationId,
          userId,
          SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE,
          SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
        ],
      )
    ).rows[0];

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'draft-main', 'channel', 'private', 'Main'),
         ('tenant-a', 'draft-race', 'channel', 'private', 'Race'),
         ('tenant-a', 'draft-inactive', 'channel', 'private', 'Inactive'),
         ('tenant-a', 'draft-nonmember', 'channel', 'private', 'Nonmember'),
         ('tenant-a', 'draft-rollback', 'channel', 'private', 'Rollback'),
         ('tenant-b', 'draft-tenant', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'draft-main', 'author-a', 'member', 'active'),
         ('tenant-a', 'draft-main', 'author-b', 'member', 'active'),
         ('tenant-a', 'draft-race', 'author-a', 'member', 'active'),
         ('tenant-a', 'draft-inactive', 'author-a', 'member', 'left'),
         ('tenant-a', 'draft-rollback', 'author-a', 'member', 'active'),
         ('tenant-b', 'draft-tenant', 'author-a', 'member', 'active')`,
    );

    await t.test("replaces and clears with exact replay on only the actor's user stream", async () => {
      const input = replaceInput("draft-main", "main-secret");
      const first = await command(input);
      assert.deepEqual(parseSynchronizeDraftResult(first, input), first);
      assert.equal(first.reconciliationStatus, "applied");
      assert.equal(first.canonicalRevision, 1);
      assert.deepEqual(first.draft, { kind: "replaced", content: input.content });

      const persisted = await storedDraft("tenant-a", "draft-main", "author-a");
      assert.deepEqual(persisted.content, input.content);
      assert.equal(persisted.revision, 1);
      assert.equal(persisted.updated_at.toISOString(), first.canonicalUpdatedAt);

      const event = (
        await harness.pool.query(
          `SELECT event_id, protocol_version::integer AS protocol_version,
                  tenant_id, stream_id, type, occurred_at, payload
           FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND payload->'result'->>'conversationId' = 'draft-main'`,
        )
      ).rows[0];
      assert.equal(event.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(event.stream_id, "user:author-a");
      assert.equal(event.type, SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE);
      assert.equal(event.occurred_at.toISOString(), first.canonicalUpdatedAt);
      assert.equal(event.payload.actorUserId, actor.userId);
      assert.deepEqual(event.payload.input, input);
      assert.deepEqual(
        parseSynchronizeDraftResult(event.payload.result, event.payload.input),
        first,
      );
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${tables.outbox}
             WHERE tenant_id = 'tenant-a'
               AND payload->'result'->>'conversationId' = 'draft-main'
               AND stream_id <> 'user:author-a'`,
          )
        ).rows[0].count,
        0,
      );

      const audit = await harness.pool.query(
        `SELECT count(*)::integer AS count,
                coalesce(string_agg(metadata::text, ''), '') AS content
         FROM ${tables.audit}
         WHERE tenant_id = 'tenant-a' AND target_id = 'draft-main'`,
      );
      assert.equal(audit.rows[0].count, 0);
      assert.equal(audit.rows[0].content.includes(input.content.text), false);
      assert.equal(
        audit.rows[0].content.includes(input.content.attachments[0].attachmentId),
        false,
      );

      const retry = await command(input);
      assert.equal(retry.reconciliationStatus, "replayed");
      assert.equal(retry.canonicalRevision, first.canonicalRevision);
      assert.equal(retry.canonicalUpdatedAt, first.canonicalUpdatedAt);
      assert.deepEqual(retry.draft, first.draft);
      assert.deepEqual(parseSynchronizeDraftResult(retry, input), retry);
      assert.deepEqual(await effectCounts("tenant-a", "draft-main", "author-a"), {
        drafts: 1,
        outbox: 1,
        idempotency: 1,
        audit: 0,
      });

      await assert.rejects(
        command({
          ...input,
          content: { ...input.content, text: "different private content" },
        }),
        (error) =>
          error instanceof SynchronizeDraftCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );

      const clear = clearInput("draft-main", "main-clear", 1);
      const cleared = await command(clear);
      assert.deepEqual(parseSynchronizeDraftResult(cleared, clear), cleared);
      assert.equal(cleared.reconciliationStatus, "applied");
      assert.equal(cleared.canonicalRevision, 2);
      assert.deepEqual(cleared.draft, { kind: "clear_tombstone", content: null });
      assert.deepEqual(
        {
          content: (await storedDraft("tenant-a", "draft-main", "author-a")).content,
          revision: (await storedDraft("tenant-a", "draft-main", "author-a")).revision,
        },
        { content: null, revision: 2 },
      );
    });

    await t.test("settles concurrent devices sharing one base revision with one event", async () => {
      const before = await effectCounts("tenant-a", "draft-race", "author-a");
      const left = replaceInput("draft-race", "race-left");
      const right = replaceInput("draft-race", "race-right");
      const results = await Promise.all([command(left), command(right)]);
      const applied = results.find(
        (result) => result.reconciliationStatus === "applied",
      );
      const stale = results.find(
        (result) => result.reconciliationStatus === "stale_base",
      );

      assert.ok(applied);
      assert.ok(stale);
      assert.equal(applied.canonicalRevision, 1);
      assert.equal(stale.canonicalRevision, 1);
      assert.equal(stale.canonicalUpdatedAt, applied.canonicalUpdatedAt);
      assert.deepEqual(stale.draft, applied.draft);
      assert.deepEqual(
        parseSynchronizeDraftResult(results[0], left),
        results[0],
      );
      assert.deepEqual(
        parseSynchronizeDraftResult(results[1], right),
        results[1],
      );

      const staleInput = stale.deviceMutationId === left.deviceMutationId ? left : right;
      const staleRetry = await command(staleInput);
      assert.equal(staleRetry.reconciliationStatus, "stale_base");
      assert.equal(staleRetry.canonicalRevision, stale.canonicalRevision);
      assert.equal(staleRetry.canonicalUpdatedAt, stale.canonicalUpdatedAt);
      assert.deepEqual(staleRetry.draft, stale.draft);
      assert.deepEqual(await effectCounts("tenant-a", "draft-race", "author-a"), {
        drafts: 1,
        outbox: 1,
        idempotency: before.idempotency + 2,
        audit: 0,
      });
    });

    await t.test("isolates users, membership state, and tenants", async () => {
      const otherInput = replaceInput("draft-main", "other-user");
      const otherResult = await command(otherInput, { actor: otherActor });
      assert.equal(otherResult.reconciliationStatus, "applied");
      assert.equal(otherResult.canonicalRevision, 1);
      assert.deepEqual(
        (await storedDraft("tenant-a", "draft-main", "author-b")).content,
        otherInput.content,
      );
      assert.equal(
        (await storedDraft("tenant-a", "draft-main", "author-a")).revision,
        2,
      );
      const otherStreams = (
        await harness.pool.query(
          `SELECT stream_id
           FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND payload->'result'->>'deviceMutationId' = $1`,
          [otherInput.deviceMutationId],
        )
      ).rows.map(({ stream_id }) => stream_id);
      assert.deepEqual(otherStreams, ["user:author-b"]);

      for (const deniedInput of [
        replaceInput("draft-inactive", "inactive"),
        replaceInput("draft-nonmember", "nonmember"),
        replaceInput("draft-tenant", "cross-tenant-denied"),
      ]) {
        await assert.rejects(command(deniedInput), sanitizedAuthorizationFailure);
      }
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count
             FROM ${tables.idempotency}
             WHERE client_key IN ('draft-inactive', 'draft-nonmember',
                                  'draft-cross-tenant-denied')`,
          )
        ).rows[0].count,
        0,
      );

      const tenantInput = replaceInput("draft-tenant", "tenant-b");
      const tenantResult = await command(tenantInput, { actor: crossTenantActor });
      assert.equal(tenantResult.reconciliationStatus, "applied");
      assert.deepEqual(
        (await storedDraft("tenant-b", "draft-tenant", "author-a")).content,
        tenantInput.content,
      );
      assert.equal(
        await storedDraft("tenant-a", "draft-tenant", "author-a"),
        undefined,
      );
    });

    await t.test("rolls back draft, event, and idempotency after a downstream failure", async () => {
      const before = await effectCounts("tenant-a", "draft-rollback", "author-a");
      const input = replaceInput("draft-rollback", "rollback-sensitive");
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
                throw new Error("injected draft outbox failure");
              }
              return connection.query(text, values);
            },
            release: () => connection.release(),
          };
        },
      };

      await assert.rejects(
        command(input, { database: lateFailureDatabase }),
        /injected draft outbox failure/,
      );
      assert.deepEqual(
        await effectCounts("tenant-a", "draft-rollback", "author-a"),
        before,
      );

      const retry = await command(input);
      assert.equal(retry.reconciliationStatus, "applied");
      assert.deepEqual(
        await effectCounts("tenant-a", "draft-rollback", "author-a"),
        { drafts: 1, outbox: 1, idempotency: before.idempotency + 1, audit: 0 },
      );
    });
    await t.test("completes and replays a draft with a fractional-millisecond claim", async () => {
      const conversationId = "draft-submillisecond-claim";
      await harness.pool.query(
        `INSERT INTO ${tables.conversations}
           (tenant_id, id, type, visibility, name)
         VALUES ($1, $2, 'channel', 'private', $2)`,
        [actor.tenantId, conversationId],
      );
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', 'active')`,
        [actor.tenantId, conversationId, actor.userId],
      );
      const input = replaceInput(conversationId, "submillisecond-claim", {
        content: {
          format: "markdown",
          text: "private fractional-claim draft",
          attachments: [{ attachmentId: "attachment-z" }, { attachmentId: "attachment-a" }],
        },
      });
      // synchronizeDraft hashes the entire parsed input, including both mutation
      // keys. Sort object keys recursively while preserving attachment order.
      const canonicalJson = (value) => {
        if (Array.isArray(value)) {
          return `[${value.map(canonicalJson).join(",")}]`;
        }
        if (value !== null && typeof value === "object") {
          return `{${Object.keys(value).sort().map(
            (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
          ).join(",")}}`;
        }
        return JSON.stringify(value);
      };
      const requestHash = `sha256:${createHash("sha256")
        .update(canonicalJson(parseSynchronizeDraftInput(input)))
        .digest("hex")}`;
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
        [actor.tenantId, actor.userId, SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
          input.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      // Delegate every query (including the clock SELECT) to PostgreSQL; only
      // the returned clock sample loses the claim's submillisecond precision.
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              const result = await connection.query(sql, values);
              if (sql.includes("clock_timestamp() AS observed_at")) {
                result.rows[0].observed_at = claim.created_at;
                clockSamples += 1;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };
      const before = await effectCounts(actor.tenantId, conversationId, actor.userId);
      const result = await command(input, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.deepEqual(parseSynchronizeDraftResult(result, input), result);
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.canonicalRevision, 1);
      assert.equal(result.canonicalUpdatedAt, claim.created_at.toISOString());
      assert.deepEqual(result.draft, { kind: "replaced", content: input.content });
      const persisted = await storedDraft(actor.tenantId, conversationId, actor.userId);
      assert.deepEqual(persisted.content, input.content);
      assert.equal(persisted.revision, 1);
      assert.equal(persisted.updated_at.toISOString(), result.canonicalUpdatedAt);

      const storedOutcome = async () => (await harness.pool.query(
        `SELECT state, response_status, response_body,
                created_at::text, updated_at::text, completed_at::text, expires_at::text,
                completed_at >= created_at AS completion_not_before_claim,
                updated_at >= created_at AS update_not_before_claim,
                created_at - $5::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = $3 AND client_key = $4`,
        [actor.tenantId, actor.userId, SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
          input.idempotencyKey, claim.created_at],
      )).rows;
      const outcome = await storedOutcome();
      assert.equal(outcome.length, 1);
      assert.equal(outcome[0].state, "completed");
      assert.equal(outcome[0].response_status, 200);
      assert.deepEqual(outcome[0].response_body, result);
      // SQL comparisons and text timestamps retain precision that Date loses.
      for (const field of ["completion_not_before_claim", "update_not_before_claim",
        "precision_gap", "ttl_unchanged"]) {
        assert.equal(outcome[0][field], true, field);
      }
      const expectedCounts = { ...before, drafts: 1, outbox: 1 };
      assert.deepEqual(await effectCounts(actor.tenantId, conversationId, actor.userId), expectedCounts);
      const events = (await harness.pool.query(
        `SELECT stream_id, type, payload FROM ${tables.outbox}
         WHERE tenant_id = $1 AND payload->'result'->>'conversationId' = $2`,
        [actor.tenantId, conversationId],
      )).rows;
      assert.deepEqual(events, [{
        stream_id: `user:${actor.userId}`,
        type: SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE,
        payload: { actorUserId: actor.userId, input, result },
      }]);

      assert.deepEqual(await command(input), { ...result, reconciliationStatus: "replayed" });
      assert.deepEqual(await storedDraft(actor.tenantId, conversationId, actor.userId), persisted);
      assert.deepEqual(await storedOutcome(), outcome);
      assert.deepEqual(await effectCounts(actor.tenantId, conversationId, actor.userId), expectedCounts);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
