import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  ChatAuthorizationError,
  UPDATE_CONVERSATION_PREFERENCE_AUDIT_ACTION,
  UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
  UPDATE_CONVERSATION_PREFERENCE_OUTBOX_EVENT_TYPE,
  UpdateConversationPreferenceCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  updateConversationPreference,
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
  operation: "update_conversation_preference",
  conversationId: "preference-primary",
  expectedPreferenceRevision: 0,
  idempotencyKey: `preference-${suffix}`,
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  ...overrides,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

test("transactional update-conversation-preference covers revisions, private effects, idempotency, and rollback in PostgreSQL", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_update_preference",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    preferences: `${schema}.chat_conversation_preferences`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const notificationCalls = [];
  let nextId = 0;
  const command = (request, database = harness.pool) =>
    updateConversationPreference({
      database,
      schema: harness.schema,
      actor,
      input: request,
      createId: () => `preference-command-${++nextId}`,
      notifications: {
        async send(value) {
          notificationCalls.push(value);
        },
      },
    });

  const storedPreference = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT notification_level, is_starred, muted, muted_until,
              preference_revision::integer AS preference_revision
         FROM ${tables.preferences}
        WHERE tenant_id = 'tenant-a' AND conversation_id = $1
          AND user_id = 'actor-a'`,
      [conversationId],
    );
    return result.rows[0];
  };

  const effectCounts = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND payload->'input'->>'conversationId' = $1) AS outbox`,
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

    const conversationIds = [
      ...Array.from({ length: 9 }, (_, index) => `preference-combo-${index}`),
      "preference-primary",
      "preference-inactive",
      "preference-non-member",
      "preference-empty-conflict",
      "preference-rollback",
    ];
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name)
       SELECT 'tenant-a', value, 'channel', 'private', value
         FROM unnest($1::text[]) AS value`,
      [conversationIds],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name)
       VALUES ('tenant-b', 'preference-cross-tenant', 'channel', 'private', 'Cross tenant')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       SELECT 'tenant-a', value, 'actor-a', 'member', 'active'
         FROM unnest($1::text[]) AS value`,
      [
        conversationIds.filter(
          (conversationId) =>
            conversationId !== "preference-inactive" &&
            conversationId !== "preference-non-member",
        ),
      ],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'preference-inactive', 'actor-a', 'member', 'left'),
         ('tenant-a', 'preference-primary', 'other-user', 'member', 'active'),
         ('tenant-b', 'preference-cross-tenant', 'actor-a', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.preferences}
         (tenant_id, conversation_id, user_id, notification_level,
          is_starred, muted, preference_revision)
       VALUES
         ('tenant-a', 'preference-primary', 'other-user', 'none', true, false, 5)`,
    );

    await t.test("creates notification, starred, and mute combinations at revision one", async () => {
      const notificationPreferences = ["all", "mentions", "none"];
      const muteStates = [
        { muted: false },
        { muted: true },
        { muted: true, mutedUntil: "2030-02-03T04:05:06.000Z" },
      ];
      let index = 0;
      for (const notificationPreference of notificationPreferences) {
        for (const mute of muteStates) {
          const conversationId = `preference-combo-${index}`;
          const isStarred = index % 2 === 1;
          const request = input(`combo-${index}`, {
            conversationId,
            notificationPreference,
            isStarred,
            mute,
          });
          const result = await command(request);
          assert.equal(result.reconciliationStatus, "applied");
          assert.equal(result.preferenceRevision, 1);
          assert.deepEqual(result.preference, {
            notificationPreference,
            isStarred,
            mute,
            updatedAt: result.preference.updatedAt,
          });
          const stored = await storedPreference(conversationId);
          assert.equal(stored.notification_level, notificationPreference);
          assert.equal(stored.is_starred, isStarred);
          assert.equal(stored.muted, mute.muted);
          assert.equal(stored.preference_revision, 1);
          assert.equal(
            stored.muted_until?.toISOString(),
            mute.mutedUntil,
          );
          index += 1;
        }
      }
      assert.equal(notificationCalls.length, 0);
    });

    await t.test("updates, returns already-requested state, and reports authoritative stale revisions", async () => {
      const createdRequest = input("primary-create");
      const created = await command(createdRequest);
      assert.equal(created.reconciliationStatus, "applied");
      assert.equal(created.preferenceRevision, 1);
      assert.equal(created.preference.isStarred, false);

      const updatedRequest = input("primary-update", {
        expectedPreferenceRevision: 1,
        notificationPreference: "mentions",
        isStarred: true,
        mute: {
          muted: true,
          mutedUntil: "2031-04-05T06:07:08.000Z",
        },
      });
      const updated = await command(updatedRequest);
      assert.equal(updated.reconciliationStatus, "applied");
      assert.equal(updated.preferenceRevision, 2);
      assert.equal(updated.preference.isStarred, true);

      const already = await command(
        input("primary-already", {
          expectedPreferenceRevision: 2,
          notificationPreference: updatedRequest.notificationPreference,
          isStarred: updatedRequest.isStarred,
          mute: updatedRequest.mute,
        }),
      );
      assert.equal(already.reconciliationStatus, "already_requested_state");
      assert.equal(already.preferenceRevision, 2);

      const stale = await command(
        input("primary-stale", {
          expectedPreferenceRevision: 1,
          notificationPreference: "none",
          isStarred: false,
          mute: { muted: true },
        }),
      );
      assert.equal(stale.reconciliationStatus, "preference_revision_conflict");
      assert.equal(stale.preferenceRevision, 2);
      assert.deepEqual(stale.preference, updated.preference);

      const unstarred = await command(
        input("primary-unstar", {
          expectedPreferenceRevision: 2,
          notificationPreference: updatedRequest.notificationPreference,
          isStarred: false,
          mute: updatedRequest.mute,
        }),
      );
      assert.equal(unstarred.reconciliationStatus, "applied");
      assert.equal(unstarred.preferenceRevision, 3);
      assert.equal(unstarred.preference.isStarred, false);
      assert.equal(
        (await storedPreference("preference-primary")).is_starred,
        false,
      );
      assert.deepEqual(await effectCounts("preference-primary"), {
        audit: 3,
        outbox: 3,
      });

      const otherUser = (
        await harness.pool.query(
          `SELECT notification_level, is_starred,
                  preference_revision::integer AS preference_revision
             FROM ${tables.preferences}
            WHERE tenant_id = 'tenant-a' AND conversation_id = 'preference-primary'
              AND user_id = 'other-user'`,
        )
      ).rows[0];
      assert.deepEqual(otherUser, {
        notification_level: "none",
        is_starred: true,
        preference_revision: 5,
      });

      const emptyConflict = await command(
        input("empty-conflict", {
          conversationId: "preference-empty-conflict",
          expectedPreferenceRevision: 3,
        }),
      );
      assert.equal(
        emptyConflict.reconciliationStatus,
        "preference_revision_conflict",
      );
      assert.equal(emptyConflict.preferenceRevision, 0);
      assert.deepEqual(
        {
          notificationPreference: emptyConflict.preference.notificationPreference,
          isStarred: emptyConflict.preference.isStarred,
          mute: emptyConflict.preference.mute,
        },
        {
          notificationPreference: "all",
          isStarred: false,
          mute: { muted: false },
        },
      );
    });

    await t.test("completes preference mutation when the serialized clock precedes the claim by microseconds", async () => {
      const conversationId = "preference-submillisecond-claim";
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
      const request = input("submillisecond-claim", {
        conversationId,
        notificationPreference: "mentions",
        isStarred: true,
        mute: { muted: true, mutedUntil: "2031-04-05T06:07:08.000Z" },
      });
      // Keys are in canonical sorted order, including the nested mute object;
      // the idempotency key is deliberately excluded from the request hash.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        conversationId,
        expectedPreferenceRevision: request.expectedPreferenceRevision,
        isStarred: request.isStarred,
        mute: { muted: request.mute.muted, mutedUntil: request.mute.mutedUntil },
        notificationPreference: request.notificationPreference,
        operation: request.operation,
      })).digest("hex")}`;
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
        [actor.tenantId, actor.userId, UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
          request.idempotencyKey, requestHash],
      )).rows[0];
      assert.ok(claim.created_at instanceof Date);
      // Only the returned clock sample is controlled. Every query, including
      // the clock SELECT, is delegated to the real PostgreSQL connection.
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

      const result = await command(request, clockDatabase);
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.preferenceRevision, 1);
      assert.deepEqual(result.preference, {
        notificationPreference: request.notificationPreference,
        isStarred: request.isStarred,
        mute: request.mute,
        updatedAt: claim.created_at.toISOString(),
      });
      const persisted = await storedPreference(conversationId);
      assert.deepEqual(persisted, {
        notification_level: "mentions",
        is_starred: true,
        muted: true,
        muted_until: new Date(request.mute.mutedUntil),
        preference_revision: 1,
      });
      const storedOutcome = async () => (await harness.pool.query(
        `SELECT completed_at = created_at AS completion_preserves_precision,
                updated_at = completed_at AS update_matches_completion,
                created_at - $5::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = created_at + interval '2 minutes' AS ttl_unchanged,
                response_body
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = $3 AND client_key = $4`,
        [actor.tenantId, actor.userId, UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
          request.idempotencyKey, claim.created_at],
      )).rows;
      const expectedOutcome = [{
        completion_preserves_precision: true,
        update_matches_completion: true,
        precision_gap: true,
        ttl_unchanged: true,
        response_body: result,
      }];
      // SQL comparisons retain the microseconds that JavaScript Date loses.
      assert.deepEqual(await storedOutcome(), expectedOutcome);
      assert.deepEqual(await effectCounts(conversationId), { audit: 1, outbox: 1 });
      assert.deepEqual(await command(request), {
        ...result,
        reconciliationStatus: "replayed",
      });
      assert.deepEqual(await storedPreference(conversationId), persisted);
      assert.deepEqual(await effectCounts(conversationId), { audit: 1, outbox: 1 });
      assert.deepEqual(await storedOutcome(), expectedOutcome);
    });

    await t.test("replays exact requests and rejects different-request key reuse", async () => {
      const original = input("combo-1", {
        conversationId: "preference-combo-1",
        notificationPreference: "all",
        isStarred: true,
        mute: { muted: true },
      });
      const replay = await command(original);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.equal(replay.preferenceRevision, 1);
      assert.deepEqual(await effectCounts("preference-combo-1"), {
        audit: 1,
        outbox: 1,
      });

      await assert.rejects(
        command({ ...original, isStarred: false }),
        (error) =>
          error instanceof UpdateConversationPreferenceCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
    });

    await t.test("rejects inactive, non-member, missing, and cross-tenant targets without leaking existence", async () => {
      for (const [suffix, conversationId] of [
        ["inactive", "preference-inactive"],
        ["non-member", "preference-non-member"],
        ["missing", "preference-missing"],
        ["cross-tenant", "preference-cross-tenant"],
      ]) {
        await assert.rejects(
          command(input(suffix, { conversationId })),
          sanitizedAuthorizationFailure,
        );
      }
    });

    await t.test("writes reducer-compatible private payload and sanitized audit metadata without notifications", async () => {
      const request = input("event-shape", {
        conversationId: "preference-combo-8",
        expectedPreferenceRevision: 1,
        notificationPreference: "mentions",
        isStarred: true,
        mute: { muted: false },
      });
      const result = await command(request);
      const persisted = await harness.pool.query(
        `SELECT audit.action, audit.metadata, audit.metadata::text AS audit_text,
                event.type, event.stream_id,
                event.protocol_version::integer AS protocol_version,
                event.payload, event.expires_at > event.occurred_at AS bounded_retention
           FROM ${tables.outbox} AS event
           INNER JOIN ${tables.audit} AS audit
             ON audit.tenant_id = event.tenant_id
            AND audit.target_id = event.payload->'input'->>'conversationId'
            AND audit.occurred_at = event.occurred_at
          WHERE event.tenant_id = 'tenant-a'
            AND event.payload->'input'->>'idempotencyKey' = $1`,
        [request.idempotencyKey],
      );
      assert.equal(persisted.rowCount, 1);
      const row = persisted.rows[0];
      assert.equal(row.action, UPDATE_CONVERSATION_PREFERENCE_AUDIT_ACTION);
      assert.equal(row.type, UPDATE_CONVERSATION_PREFERENCE_OUTBOX_EVENT_TYPE);
      assert.equal(row.stream_id, `user:${actor.userId}`);
      assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(row.bounded_retention, true);
      assert.deepEqual(row.payload, {
        actorUserId: actor.userId,
        input: request,
        result,
      });
      assert.deepEqual(row.metadata, {
        notificationPreference: "mentions",
        isStarred: true,
        muted: false,
        finiteMute: false,
        previousPreferenceRevision: 1,
        currentPreferenceRevision: 2,
      });
      for (const sensitive of [
        "sensitive-host-role",
        request.idempotencyKey,
        "idempotencyKey",
        "credentials",
        "content",
      ]) {
        assert.equal(row.audit_text.includes(sensitive), false);
      }
      const publicCopies = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.outbox}
          WHERE payload->'input'->>'idempotencyKey' = $1
            AND stream_id <> $2`,
        [request.idempotencyKey, `user:${actor.userId}`],
      );
      assert.equal(publicCopies.rows[0].count, 0);
      const stored = await storedPreference(request.conversationId);
      assert.equal(stored.is_starred, result.preference.isStarred);
      assert.equal(row.payload.result.preference.isStarred, stored.is_starred);
      assert.equal(notificationCalls.length, 0);
    });

    await t.test("rolls back preference, audit, outbox, and idempotency after an injected failure", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_preference_outbox()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.payload->'input'->>'conversationId' = 'preference-rollback' THEN
               RAISE EXCEPTION 'injected conversation-preference outbox failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_preference_outbox
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_preference_outbox()`,
      );
      const request = input("rollback", {
        conversationId: "preference-rollback",
        notificationPreference: "none",
        isStarred: true,
        mute: { muted: true },
      });
      await assert.rejects(
        command(request),
        /injected conversation-preference outbox failure/,
      );
      assert.equal(await storedPreference("preference-rollback"), undefined);
      assert.deepEqual(await effectCounts("preference-rollback"), {
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
    });

    await t.test("enforces a bounded positive durable revision", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${tables.preferences} SET preference_revision = 0
            WHERE tenant_id = 'tenant-a'
              AND conversation_id = 'preference-primary'
              AND user_id = 'actor-a'`,
        ),
        /chat_conversation_preferences_revision_check/,
      );
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
