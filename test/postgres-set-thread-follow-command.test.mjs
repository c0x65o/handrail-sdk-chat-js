import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

// Bundle fresh canonical sources before running; never use shared dist output:
// node_modules/.bin/esbuild test/postgres-set-thread-follow-command.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/thread-follow/postgres-set-thread-follow-command.test.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/thread-follow/postgres-set-thread-follow-command.test.mjs"
import { CHAT_PROTOCOL_VERSION } from "../src/contracts/realtime.ts";
import {
  SET_THREAD_FOLLOW_AUDIT_ACTION,
  SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION,
  SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
  SET_THREAD_FOLLOW_OUTBOX_EVENT_TYPE,
  SetThreadFollowCommandError,
  setThreadFollow,
} from "../src/server/set-thread-follow-command.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { ThreadFollowMutationParseError } from "../src/contracts/thread-follow-mutation.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["sensitive-host-role"]),
});

const input = (suffix, overrides = {}) => ({
  operation: "set_thread_follow",
  intent: "follow",
  target: { type: "thread", id: "public-thread" },
  expectedFollowRevision: 0,
  idempotencyKey: `thread-follow-${suffix}`,
  ...overrides,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

test("transactional set-thread-follow applies explicit intent, authorizes, reconciles, and rolls back PostgreSQL state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_set_thread_follow",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    follows: `${schema}.chat_thread_follows`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let entityMode = "allow";
  const entityCalls = [];
  const permissions = {
    async authorizeEntity(request) {
      entityCalls.push(request);
      if (entityMode === "error") throw new Error("sensitive host failure");
      return entityMode === "allow";
    },
  };
  let nextId = 0;
  const command = (request, overrides = {}) =>
    setThreadFollow({
      database: harness.pool,
      schema: harness.schema,
      actor,
      input: request,
      permissions,
      createId: () => `thread-follow-command-${++nextId}`,
      ...overrides,
    });

  const effectCounts = async (threadId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND payload->'target'->>'id' = $1) AS outbox`,
      [threadId],
    );
    return result.rows[0];
  };

  const privateState = async (threadId) => {
    const result = {};
    for (const table of ["chat_conversation_members", "chat_read_cursors", "chat_conversation_preferences", "chat_drafts"]) {
      result[table] = (await harness.pool.query(
        `SELECT * FROM ${schema}.${table}
          WHERE tenant_id = 'tenant-a' AND conversation_id = $1 AND user_id = 'actor-a'`,
        [threadId],
      )).rows;
    }
    return result;
  };
  const assertNoPrivateState = async (threadId) => {
    for (const rows of Object.values(await privateState(threadId))) assert.deepEqual(rows, []);
  };
  const seedThread = (id, parent = "public-parent", visibility = "public", root = "public-root") =>
    harness.pool.query(`INSERT INTO ${tables.conversations}
      (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
      VALUES ('tenant-a', $1, 'thread', $2, $3, $4)`, [id, visibility, parent, root]);

  const storedFollow = async (threadId) => {
    const result = await harness.pool.query(
      `SELECT is_following, follow_source,
              follow_revision::integer AS follow_revision
         FROM ${tables.follows}
        WHERE tenant_id = 'tenant-a' AND conversation_id = $1
          AND user_id = 'actor-a'`,
      [threadId],
    );
    return result.rows[0];
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id)
       VALUES
         ('tenant-a', 'public-parent', 'channel', 'public', 'Public', NULL, NULL),
         ('tenant-a', 'private-parent', 'channel', 'private', 'Private', NULL, NULL),
         ('tenant-a', 'private-denied-parent', 'channel', 'private', 'Denied', NULL, NULL),
         ('tenant-a', 'inactive-parent', 'channel', 'private', 'Inactive', NULL, NULL),
         ('tenant-a', 'archived-parent', 'channel', 'public', 'Archived', NULL, NULL),
         ('tenant-a', 'entity-parent', 'channel', 'public', 'Entity', 'case', 'case-7'),
         ('tenant-b', 'cross-parent', 'channel', 'public', 'Cross tenant', NULL, NULL)`,
    );
    await harness.pool.query(
      `UPDATE ${tables.conversations}
          SET archived_at = clock_timestamp(), archived_by_user_id = 'archiver'
        WHERE tenant_id = 'tenant-a' AND id = 'archived-parent'`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'public-root', 'public-parent', 1, 'author', 'public-root-client', '{"format":"plain","text":"Public root"}'),
         ('tenant-a', 'private-root', 'private-parent', 1, 'author', 'private-root-client', '{"format":"plain","text":"Private root"}'),
         ('tenant-a', 'denied-root', 'private-denied-parent', 1, 'author', 'denied-root-client', '{"format":"plain","text":"Denied root"}'),
         ('tenant-a', 'inactive-root', 'inactive-parent', 1, 'author', 'inactive-root-client', '{"format":"plain","text":"Inactive root"}'),
         ('tenant-a', 'archived-root', 'archived-parent', 1, 'author', 'archived-root-client', '{"format":"plain","text":"Archived root"}'),
         ('tenant-a', 'entity-root', 'entity-parent', 1, 'author', 'entity-root-client', '{"format":"plain","text":"Entity root"}'),
         ('tenant-b', 'cross-root', 'cross-parent', 1, 'author', 'cross-root-client', '{"format":"plain","text":"Cross tenant root"}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
       VALUES
         ('tenant-a', 'public-thread', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-a', 'public-unfollow-thread', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-a', 'private-thread', 'thread', 'private', 'private-parent', 'private-root'),
         ('tenant-a', 'private-denied-thread', 'thread', 'private', 'private-denied-parent', 'denied-root'),
         ('tenant-a', 'inactive-thread', 'thread', 'private', 'inactive-parent', 'inactive-root'),
         ('tenant-a', 'archived-parent-thread', 'thread', 'public', 'archived-parent', 'archived-root'),
         ('tenant-a', 'archived-thread', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-a', 'entity-thread', 'thread', 'public', 'entity-parent', 'entity-root'),
         ('tenant-a', 'rollback-thread', 'thread', 'public', 'public-parent', 'public-root'),
         ('tenant-b', 'cross-thread', 'thread', 'public', 'cross-parent', 'cross-root')`,
    );
    await harness.pool.query(
      `UPDATE ${tables.conversations}
          SET archived_at = clock_timestamp(), archived_by_user_id = 'archiver'
        WHERE tenant_id = 'tenant-a' AND id = 'archived-thread'`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'private-parent', 'actor-a', 'member', 'active'),
         ('tenant-a', 'inactive-parent', 'actor-a', 'member', 'left'),
         ('tenant-b', 'cross-parent', 'actor-a', 'member', 'active')`,
    );

    await t.test("completes a follow when the serialized clock precedes the claim by microseconds", async () => {
      const threadId = "submillisecond-claim-thread";
      await harness.pool.query(
        `INSERT INTO ${tables.conversations}
           (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
         VALUES ('tenant-a', $1, 'thread', 'public', 'public-parent', 'public-root')`,
        [threadId],
      );
      const request = input("submillisecond-claim", {
        target: { type: "thread", id: threadId },
      });
      // Match hashRequest's sorted canonical keys, including nested target keys.
      const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
        expectedFollowRevision: request.expectedFollowRevision,
        intent: request.intent,
        operation: request.operation,
        target: { id: request.target.id, type: request.target.type },
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
         RETURNING created_at, expires_at::text AS seeded_expiry`,
        [actor.tenantId, actor.userId, SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
          request.idempotencyKey, requestHash],
      )).rows[0];
      let clockSamples = 0;
      const clockDatabase = {
        query: harness.pool.query.bind(harness.pool),
        async connect() {
          const connection = await harness.pool.connect();
          return {
            async query(sql, values) {
              // Execute every query in PostgreSQL; override only the clock result.
              const result = await connection.query(sql, values);
              if (sql.includes("clock_timestamp() AS occurred_at")) {
                result.rows[0].occurred_at = claim.created_at;
                clockSamples += 1;
              }
              return result;
            },
            release: () => connection.release(),
          };
        },
      };

      const result = await command(request, { database: clockDatabase });
      assert.equal(clockSamples, 1);
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.followRevision, 1);
      assert.deepEqual(result.follow, {
        target: request.target, isFollowing: true, source: "manual",
        updatedAt: claim.created_at.toISOString(),
      });
      const follow = await storedFollow(threadId);
      assert.deepEqual(follow, {
        is_following: true, follow_source: "manual", follow_revision: 1,
      });
      // SQL comparisons retain the microseconds that JavaScript Date truncates.
      const readOutcome = async () => (await harness.pool.query(
        `SELECT state, response_status, response_body,
                completed_at = created_at AS completion_preserves_precision,
                updated_at = completed_at AS update_matches_completion,
                completed_at >= created_at AND updated_at >= created_at AS timestamps_ordered,
                created_at - $5::timestamptz = interval '456 microseconds' AS precision_gap,
                expires_at = $6::timestamptz AS expiry_unchanged
         FROM ${tables.idempotency}
         WHERE tenant_id = $1 AND user_id = $2
           AND operation_name = $3 AND client_key = $4`,
        [actor.tenantId, actor.userId, SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
          request.idempotencyKey, claim.created_at, claim.seeded_expiry],
      )).rows[0];
      const outcome = await readOutcome();
      assert.deepEqual(outcome, {
        state: "completed", response_status: 200, response_body: result,
        completion_preserves_precision: true, update_matches_completion: true,
        timestamps_ordered: true, precision_gap: true, expiry_unchanged: true,
      });
      const effects = await effectCounts(threadId);
      assert.deepEqual(effects, { audit: 1, outbox: 1 });
      assert.deepEqual(await command(request), {
        ...result, reconciliationStatus: "replayed",
      });
      assert.deepEqual(await storedFollow(threadId), follow);
      assert.deepEqual(await effectCounts(threadId), effects);
      assert.deepEqual(await readOutcome(), outcome);
    });

    await t.test("follows, replays exactly, rejects mismatched key reuse, and reconciles without duplicate effects", async () => {
      const request = input("public-follow");
      await assertNoPrivateState("public-thread");
      const followed = await command(request);
      const participation = await privateState("public-thread");
      assert.equal(participation.chat_conversation_members[0]?.role, "member");
      assert.equal(participation.chat_conversation_members[0]?.state, "active");
      assert.equal(participation.chat_read_cursors[0]?.last_read_sequence, "0");
      assert.equal(participation.chat_conversation_preferences[0]?.notification_level, "all");
      assert.equal(participation.chat_conversation_preferences[0]?.muted, false);
      assert.deepEqual(participation.chat_drafts, []);
      assert.equal(followed.reconciliationStatus, "applied");
      assert.equal(followed.followRevision, 1);
      assert.deepEqual(
        {
          isFollowing: followed.follow.isFollowing,
          source: followed.follow.source,
        },
        { isFollowing: true, source: "manual" },
      );

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.follow, followed.follow);
      assert.deepEqual(await privateState("public-thread"), participation);
      for (const mismatch of [
        { intent: "unfollow" },
        { target: { type: "thread", id: "public-unfollow-thread" } },
        { expectedFollowRevision: 1 },
      ]) {
        await assert.rejects(
          command({ ...request, ...mismatch }),
          (error) =>
            error instanceof SetThreadFollowCommandError &&
            error.code === "idempotency_conflict" &&
            error.statusCode === 409,
        );
      }

      const already = await command(
        input("public-already", { expectedFollowRevision: 1 }),
      );
      assert.equal(already.reconciliationStatus, "already_requested_state");
      assert.equal(already.followRevision, 1);
      const conflict = await command(
        input("public-conflict", {
          intent: "unfollow",
          expectedFollowRevision: 0,
        }),
      );
      assert.equal(conflict.reconciliationStatus, "follow_revision_conflict");
      assert.equal(conflict.followRevision, 1);
      assert.equal(conflict.follow.isFollowing, true);
      assert.deepEqual(await effectCounts("public-thread"), {
        audit: 1,
        outbox: 1,
      });

      const unfollowed = await command(
        input("public-unfollow", {
          intent: "unfollow",
          expectedFollowRevision: 1,
        }),
      );
      assert.equal(unfollowed.reconciliationStatus, "applied");
      assert.equal(unfollowed.followRevision, 2);
      assert.deepEqual(await storedFollow("public-thread"), {
        is_following: false,
        follow_source: "manual",
        follow_revision: 2,
      });
    });

    await t.test("unfollow and re-follow preserve retained membership, unread, notification, mute and draft state", async () => {
      const id = "retained-thread";
      await seedThread(id);
      const request = input("retained-first", { target: { type: "thread", id } });
      await command(request);
      await harness.pool.query(`UPDATE ${tables.members}
        SET role = 'moderator', state = 'left'
        WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
      await harness.pool.query(`UPDATE ${schema}.chat_read_cursors
        SET last_read_sequence = 9, manual_unread_from_sequence = 4
        WHERE conversation_id = $1`, [id]);
      await harness.pool.query(`UPDATE ${schema}.chat_conversation_preferences
        SET notification_level = 'mentions', muted = true, muted_until = '2099-01-01',
            is_starred = true, preference_revision = 7
        WHERE conversation_id = $1`, [id]);
      await harness.pool.query(`INSERT INTO ${schema}.chat_drafts
        (tenant_id, conversation_id, user_id, content, revision)
        VALUES ('tenant-a', $1, 'actor-a', $2, 6)`, [id, {
        format: "markdown", text: "retained reply draft",
        replyTo: { messageId: "retained-message", notifyAuthor: false },
      }]);
      const before = await privateState(id);
      const unfollow = input("retained-unfollow", {
        target: request.target, intent: "unfollow", expectedFollowRevision: 1,
      });
      assert.equal((await command(unfollow)).followRevision, 2);
      assert.deepEqual(await privateState(id), before);
      assert.equal((await command(unfollow)).reconciliationStatus, "replayed");
      assert.equal((await command(input("retained-already-unfollow", {
        target: request.target, intent: "unfollow", expectedFollowRevision: 2,
      }))).reconciliationStatus, "already_requested_state");
      // A previously successful follow replay cannot reactivate the left row.
      assert.equal((await command(request)).reconciliationStatus, "replayed");
      assert.deepEqual(await privateState(id), before);
      assert.equal((await storedFollow(id)).is_following, false);

      assert.equal((await command(input("retained-refollow", {
        target: request.target, expectedFollowRevision: 2,
      }))).followRevision, 3);
      const after = await privateState(id);
      assert.equal(after.chat_conversation_members[0].state, "active");
      // Only activation and its timestamp may change in retained membership.
      const retained = (state) => ({ ...state,
        chat_conversation_members: state.chat_conversation_members.map(({ state, updated_at, ...row }) => row),
      });
      assert.deepEqual(retained(after), retained(before));
      assert.deepEqual(await effectCounts(id), { audit: 3, outbox: 3 });
    });

    await t.test("matching same-state follow repairs missing participation; conflicts and their replays cannot grant it", async () => {
      const id = "reconcile-thread";
      await seedThread(id);
      await harness.pool.query(`INSERT INTO ${tables.follows}
        (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
        VALUES ('tenant-a', $1, 'actor-a', true, 'manual', 5)`, [id]);
      const conflict = input("reconcile-conflict", { target: { type: "thread", id } });
      assert.equal((await command(conflict)).reconciliationStatus, "follow_revision_conflict");
      assert.equal((await command(conflict)).reconciliationStatus, "follow_revision_conflict");
      await assert.rejects(command({ ...conflict, expectedFollowRevision: 5 }),
        (error) => error instanceof SetThreadFollowCommandError && error.code === "idempotency_conflict");
      await assertNoPrivateState(id);
      const followBefore = await storedFollow(id);
      const matching = input("reconcile-matching", { target: conflict.target, expectedFollowRevision: 5 });
      assert.equal((await command(matching)).reconciliationStatus, "already_requested_state");
      const state = await privateState(id);
      assert.equal(state.chat_conversation_members[0]?.role, "member");
      assert.equal(state.chat_read_cursors[0]?.last_read_sequence, "0");
      assert.equal(state.chat_conversation_preferences[0]?.notification_level, "all");
      assert.equal((await command(matching)).reconciliationStatus, "already_requested_state");
      assert.deepEqual(await privateState(id), state);
      assert.deepEqual(await storedFollow(id), followBefore);
      assert.deepEqual(await effectCounts(id), { audit: 0, outbox: 0 });
    });

    await t.test("parent revocation denies fresh retry and completed replay without grants or retained resets", async () => {
      for (const retained of [false, true]) {
        const id = `denied-retry-${retained}`;
        await seedThread(id, "private-parent", "private", "private-root");
        const request = input(id, { target: { type: "thread", id } });
        if (retained) {
          await command(request);
          await harness.pool.query(`UPDATE ${tables.members} SET role = 'owner', state = 'left'
            WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
          await harness.pool.query(`UPDATE ${schema}.chat_read_cursors
            SET last_read_sequence = 8, manual_unread_from_sequence = 3 WHERE conversation_id = $1`, [id]);
          await harness.pool.query(`UPDATE ${schema}.chat_conversation_preferences
            SET notification_level = 'none', muted = true, preference_revision = 4 WHERE conversation_id = $1`, [id]);
          await harness.pool.query(`INSERT INTO ${schema}.chat_drafts
            (tenant_id, conversation_id, user_id, content, revision)
            VALUES ('tenant-a', $1, 'actor-a', '{"format":"plain","text":"keep on denial"}', 3)`, [id]);
        }
        const before = await privateState(id);
        const followBefore = await storedFollow(id);
        const effectsBefore = await effectCounts(id);
        await harness.pool.query(`UPDATE ${tables.members} SET state = 'left'
          WHERE conversation_id = 'private-parent' AND user_id = 'actor-a'`);
        try {
          for (let retry = 0; retry < 2; retry += 1) {
            await assert.rejects(command(request), sanitizedAuthorizationFailure);
            await assert.rejects(command(input(`${id}-fresh`, {
              target: request.target, expectedFollowRevision: retained ? 1 : 0,
            })), sanitizedAuthorizationFailure);
          }
          assert.deepEqual(await privateState(id), before);
          assert.deepEqual(await storedFollow(id), followBefore);
          assert.deepEqual(await effectCounts(id), effectsBefore);
          const keys = await harness.pool.query(`SELECT client_key FROM ${tables.idempotency}
            WHERE client_key = ANY($1::text[]) ORDER BY client_key`,
          [[request.idempotencyKey, `thread-follow-${id}-fresh`]]);
          assert.deepEqual(keys.rows, retained ? [{ client_key: request.idempotencyKey }] : []);
        } finally {
          await harness.pool.query(`UPDATE ${tables.members} SET state = 'active'
            WHERE conversation_id = 'private-parent' AND user_id = 'actor-a'`);
        }
        // The previously denied key remains usable when current authority returns.
        assert.equal((await command(input(`${id}-fresh`, {
          target: request.target, expectedFollowRevision: retained ? 1 : 0,
        }))).reconciliationStatus, retained ? "already_requested_state" : "applied");
      }
    });

    await t.test("retains an initial explicit unfollow and protects it from automatic sources", async () => {
      const explicit = await command(
        input("initial-unfollow", {
          intent: "unfollow",
          target: { type: "thread", id: "public-unfollow-thread" },
        }),
      );
      assert.equal(explicit.reconciliationStatus, "applied");
      assert.deepEqual(await storedFollow("public-unfollow-thread"), {
        is_following: false,
        follow_source: "manual",
        follow_revision: 1,
      });
      await assertNoPrivateState("public-unfollow-thread");
      for (const source of ["reply", "mention"]) await assert.rejects(
        harness.pool.query(
          `UPDATE ${tables.follows}
              SET is_following = true, follow_source = $1,
                  follow_revision = follow_revision + 1,
                  updated_at = clock_timestamp()
            WHERE tenant_id = 'tenant-a'
              AND conversation_id = 'public-unfollow-thread'
              AND user_id = 'actor-a'`,
          [source],
        ),
        /automatic thread follow cannot overwrite an explicit manual unfollow/,
      );

      await harness.pool.query(
        `INSERT INTO ${tables.follows} (
           tenant_id, conversation_id, user_id, is_following, follow_source,
           follow_revision
         ) VALUES ('tenant-a', 'private-thread', 'actor-a', true, 'mention', 5)`,
      );
      const manual = await command(
        input("manual-over-auto", {
          intent: "unfollow",
          target: { type: "thread", id: "private-thread" },
          expectedFollowRevision: 5,
        }),
      );
      assert.equal(manual.reconciliationStatus, "applied");
      assert.deepEqual(await storedFollow("private-thread"), {
        is_following: false,
        follow_source: "manual",
        follow_revision: 6,
      });
    });

    await t.test("rejects parent targets and inaccessible, inactive, archived, and cross-tenant threads without leaking existence", async () => {
      await assert.rejects(
        command(
          input("parent-target", {
            target: { type: "channel", id: "public-parent" },
          }),
        ),
        (error) =>
          error instanceof ThreadFollowMutationParseError &&
          error.code === "malformed_target",
      );

      for (const [suffix, threadId] of [
        ["private-denied", "private-denied-thread"],
        ["inactive", "inactive-thread"],
        ["archived-parent", "archived-parent-thread"],
        ["archived-thread", "archived-thread"],
        ["missing", "missing-thread"],
        ["cross-tenant", "cross-thread"],
      ]) {
        await assert.rejects(
          command(
            input(suffix, { target: { type: "thread", id: threadId } }),
          ),
          sanitizedAuthorizationFailure,
        );
      }
    });

    await t.test("enforces inherited entity authorization and emits only sanitized private-user effects", async () => {
      entityMode = "deny";
      await assert.rejects(
        command(
          input("entity-denied", {
            target: { type: "thread", id: "entity-thread" },
          }),
        ),
        sanitizedAuthorizationFailure,
      );
      entityMode = "error";
      await assert.rejects(
        command(
          input("entity-error", {
            target: { type: "thread", id: "entity-thread" },
          }),
        ),
        sanitizedAuthorizationFailure,
      );
      entityMode = "allow";
      const entityResult = await command(
        input("entity-allowed", {
          target: { type: "thread", id: "entity-thread" },
        }),
      );
      assert.equal(entityResult.reconciliationStatus, "applied");
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "case", id: "case-7" },
        action: SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION,
      });

      const retained = await privateState("entity-thread");
      entityMode = "deny";
      for (const request of [
        input("entity-allowed", { target: { type: "thread", id: "entity-thread" } }),
        input("entity-denied-reconcile", {
          target: { type: "thread", id: "entity-thread" }, expectedFollowRevision: 1,
        }),
      ]) await assert.rejects(command(request), sanitizedAuthorizationFailure);
      assert.deepEqual(await privateState("entity-thread"), retained);
      entityMode = "allow";

      const persisted = await harness.pool.query(
        `SELECT audit.action, audit.metadata, audit.metadata::text AS audit_text,
                event.type, event.stream_id, event.protocol_version::integer AS protocol_version,
                event.payload, event.payload::text AS payload_text,
                event.expires_at > event.occurred_at AS bounded_retention
           FROM ${tables.audit} AS audit
           INNER JOIN ${tables.outbox} AS event
             ON event.tenant_id = audit.tenant_id
            AND event.occurred_at = audit.occurred_at
          WHERE audit.tenant_id = 'tenant-a'
            AND audit.target_id = 'entity-thread'`,
      );
      assert.equal(persisted.rowCount, 1);
      const row = persisted.rows[0];
      assert.equal(row.action, SET_THREAD_FOLLOW_AUDIT_ACTION);
      assert.equal(row.type, SET_THREAD_FOLLOW_OUTBOX_EVENT_TYPE);
      assert.equal(row.stream_id, `user:${actor.userId}`);
      assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(row.bounded_retention, true);
      assert.equal(row.payload.follow.isFollowing, true);
      assert.deepEqual(row.metadata, {
        threadId: "entity-thread",
        intent: "follow",
        previousFollowing: null,
        currentFollowing: true,
        previousFollowRevision: 0,
        currentFollowRevision: 1,
      });
      for (const secret of [
        "sensitive-host-role",
        "thread-follow-entity-allowed",
        "case-7",
      ]) {
        assert.equal(row.audit_text.includes(secret), false);
        assert.equal(row.payload_text.includes(secret), false);
      }

      const exposedStreams = await harness.pool.query(
        `SELECT count(*)::integer AS count
           FROM ${tables.outbox}
          WHERE payload ? 'follow'
            AND stream_id IN ('entity-thread', 'entity-parent')`,
      );
      assert.equal(exposedStreams.rows[0].count, 0);
    });

    await t.test("rolls back participant setup, follow, idempotency, audit, and outbox after a downstream failure", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_thread_follow_outbox()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.payload->'target'->>'id' = 'rollback-thread' THEN
               RAISE EXCEPTION 'injected thread-follow outbox failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_thread_follow_outbox
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_thread_follow_outbox()`,
      );
      const request = input("rollback", {
        target: { type: "thread", id: "rollback-thread" },
      });
      await assert.rejects(command(request), /injected thread-follow outbox failure/);
      assert.equal(await storedFollow("rollback-thread"), undefined);
      await assertNoPrivateState("rollback-thread");
      assert.deepEqual(await effectCounts("rollback-thread"), {
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
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
