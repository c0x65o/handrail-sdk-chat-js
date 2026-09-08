import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

// Bundle canonical sources as documented in postgres-thread-participant.test.mjs.
import { CHAT_PROTOCOL_VERSION } from "../src/contracts/realtime.ts";
import { ThreadCreationParseError } from "../src/contracts/thread-creation.ts";
import {
  CREATE_THREAD_ENTITY_POLICY_ACTION,
  CreateThreadCommandError,
  createThread,
} from "../src/server/create-thread-command.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actorA = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const input = (suffix, overrides = {}) => ({
  operation: "create_thread",
  parentConversationId: "parent-main",
  rootMessageId: "root-main",
  initialFollow: true,
  idempotencyKey: `create-thread-${suffix}`,
  ...overrides,
});

test("createThread uses PostgreSQL-safe tuple advisory-lock keys", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_thread_lock_key",
  });
  const schema = quoteIdentifier(harness.schema);
  const advisoryLockParameters = [];
  const database = {
    async connect() {
      const connection = await harness.pool.connect();
      return {
        query(query, parameters) {
          if (
            query ===
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))"
          ) {
            advisoryLockParameters.push(parameters?.[0]);
          }
          return connection.query(query, parameters);
        },
        release() {
          connection.release();
        },
      };
    },
  };
  let nextId = 0;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_conversations
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES
         ('tenant-a', 'parent-boundary', 'channel', 'public', 'Boundary A', 1),
         ('tenant-a', 'parent-boundary:root', 'channel', 'public', 'Boundary B', 1)`,
    );
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_messages
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'root:boundary', 'parent-boundary', 1, 'author-a',
          'client-boundary-a', '{"format":"plain","text":"boundary a"}'),
         ('tenant-a', 'boundary', 'parent-boundary:root', 1, 'author-a',
          'client-boundary-b', '{"format":"plain","text":"boundary b"}')`,
    );

    const requests = [
      input("boundary-a", {
        parentConversationId: "parent-boundary",
        rootMessageId: "root:boundary",
      }),
      input("boundary-b", {
        parentConversationId: "parent-boundary:root",
        rootMessageId: "boundary",
      }),
    ];
    const expectedKeys = requests.map((request) =>
      JSON.stringify([
        actorA.tenantId,
        request.parentConversationId,
        request.rootMessageId,
      ]),
    );
    const create = async (request) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await createThread({
            database,
            schema: harness.schema,
            actor: actorA,
            input: request,
            permissions: {
              async getCapabilities() {
                return ["thread.create"];
              },
              async authorizeEntity() {
                return true;
              },
            },
            createId: () => `thread-lock-key-${++nextId}`,
          });
        } catch (error) {
          if (
            attempt >= 9 ||
            error?.code !== "23514" ||
            error?.constraint !==
              "chat_idempotency_keys_timestamp_order_check"
          ) {
            throw error;
          }
        }
      }
    };
    const results = await Promise.all(
      requests.map((request) => create(request)),
    );

    assert.deepEqual(
      results.map((result) => result.reconciliationStatus),
      ["created", "created"],
    );
    assert.equal(advisoryLockParameters.length >= 2, true);
    assert.deepEqual(new Set(advisoryLockParameters), new Set(expectedKeys));
    assert.equal(
      advisoryLockParameters.every((key) => !key.includes("\u0000")),
      true,
    );
    assert.notEqual(expectedKeys[0], expectedKeys[1]);
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});

test("atomic create-thread command authorizes, converges, emits summaries, and rolls back PostgreSQL state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_create_thread" });
  t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    cursors: `${schema}.chat_read_cursors`,
    preferences: `${schema}.chat_conversation_preferences`,
    follows: `${schema}.chat_thread_follows`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  let capabilities = ["thread.create"];
  let entityAllowed = true;
  const entityCalls = [];
  const permissions = {
    async getCapabilities() {
      return capabilities;
    },
    async authorizeEntity(request) {
      entityCalls.push(request);
      return entityAllowed;
    },
  };
  let nextId = 0;
  const createId = () => `thread-command-${++nextId}`;
  const command = (request, overrides = {}) =>
    createThread({
      database: harness.pool,
      schema: harness.schema,
      actor: actorA,
      input: request,
      permissions,
      createId,
      ...overrides,
    });

  const countsForThread = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.conversations}
           WHERE tenant_id = 'tenant-a' AND id = $1) AS conversations,
         (SELECT count(*)::integer FROM ${tables.members}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS members,
         (SELECT count(*)::integer FROM ${tables.cursors}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS cursors,
         (SELECT count(*)::integer FROM ${tables.preferences}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS preferences,
         (SELECT count(*)::integer FROM ${tables.follows}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS follows,
         (SELECT count(*)::integer FROM ${tables.messages}
           WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS messages,
         (SELECT count(*)::integer FROM ${tables.audit}
           WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox}
           WHERE tenant_id = 'tenant-a'
             AND (stream_id = $1 OR payload ->> 'rootMessageId' = 'rollback-root')) AS outbox`,
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
          current_message_sequence, archived_at, archived_by_user_id)
       VALUES
         ('tenant-a', 'parent-main', 'channel', 'public', 'Main', 'order', '42', 3, NULL, NULL),
         ('tenant-a', 'parent-other', 'channel', 'public', 'Other', NULL, NULL, 1, NULL, NULL),
         ('tenant-a', 'parent-private', 'channel', 'private', 'Private', NULL, NULL, 1, NULL, NULL),
         ('tenant-a', 'parent-unauthorized', 'channel', 'private', 'Denied', NULL, NULL, 1, NULL, NULL),
         ('tenant-a', 'parent-archived', 'channel', 'public', 'Archived', NULL, NULL, 1, clock_timestamp(), 'archiver'),
         ('tenant-a', 'parent-deleted-root', 'channel', 'public', 'Deleted root', NULL, NULL, 1, NULL, NULL),
         ('tenant-a', 'nested-base', 'channel', 'public', 'Nested base', NULL, NULL, 1, NULL, NULL),
         ('tenant-a', 'rollback-parent', 'channel', 'public', 'Rollback', NULL, NULL, 1, NULL, NULL),
         ('tenant-b', 'parent-cross-tenant', 'channel', 'public', 'Cross tenant', NULL, NULL, 1, NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'parent-private', 'actor-a', 'member', 'active'),
         ('tenant-a', 'parent-unauthorized', 'someone-else', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'root-main', 'parent-main', 1, 'author-a', 'client-root-main',
          '{"format":"plain","text":"sensitive root body"}'),
         ('tenant-a', 'root-other', 'parent-other', 1, 'author-a', 'client-root-other',
          '{"format":"plain","text":"other"}'),
         ('tenant-a', 'root-private', 'parent-private', 1, 'actor-a', 'client-root-private',
          '{"format":"plain","text":"private"}'),
         ('tenant-a', 'root-unauthorized', 'parent-unauthorized', 1, 'someone-else', 'client-root-denied',
          '{"format":"plain","text":"denied"}'),
         ('tenant-a', 'root-archived', 'parent-archived', 1, 'author-a', 'client-root-archived',
          '{"format":"plain","text":"archived"}'),
         ('tenant-a', 'root-deleted', 'parent-deleted-root', 1, 'author-a', 'client-root-deleted',
          '{"format":"plain","text":"deleted"}'),
         ('tenant-a', 'nested-root', 'nested-base', 1, 'author-a', 'client-nested-root',
          '{"format":"plain","text":"nested root"}'),
         ('tenant-a', 'rollback-root', 'rollback-parent', 1, 'author-a', 'client-rollback-root',
          '{"format":"plain","text":"rollback secret"}'),
         ('tenant-b', 'root-cross-tenant', 'parent-cross-tenant', 1, 'author-b', 'client-cross-root',
          '{"format":"plain","text":"cross"}')`,
    );
    await harness.pool.query(
      `UPDATE ${tables.messages}
          SET content = NULL, deleted_at = updated_at,
              deleted_by_user_id = 'author-a'
        WHERE tenant_id = 'tenant-a' AND id = 'root-deleted'`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, parent_conversation_id,
          root_message_id, current_message_sequence)
       VALUES ('tenant-a', 'nested-thread', 'thread', 'public',
               'nested-base', 'nested-root', 1)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES ('tenant-a', 'nested-reply', 'nested-thread', 1, 'author-a',
               'client-nested-reply', '{"format":"plain","text":"reply"}')`,
    );

    await t.test("creates linked state with inherited visibility and no reply", async () => {
      const request = input("main");
      const result = await command(request);
      const thread = result.conversation.conversation;
      assert.equal(result.reconciliationStatus, "created");
      assert.equal(thread.type, "thread");
      assert.equal(Object.hasOwn(thread, "name"), false);
      assert.equal(thread.tenantId, actorA.tenantId);
      assert.equal(thread.parentConversationId, request.parentConversationId);
      assert.equal(thread.rootMessageId, request.rootMessageId);
      assert.equal(thread.visibility, "public");
      assert.equal(thread.latestSequence, 0);
      assert.equal(thread.currentMember.role, "owner");
      assert.equal(thread.currentMember.state, "active");
      assert.equal(thread.currentReadState.lastReadSequence, 0);
      assert.deepEqual(thread.currentPreference.mute, { muted: false });
      assert.deepEqual(thread.memberUserIds, [actorA.userId]);
      assert.deepEqual(result.rootThreadSummary, {
        threadId: thread.id,
        replyCount: 0,
        participantIds: [],
        unreadCount: 0,
      });
      assert.deepEqual(entityCalls.at(-1), {
        actor: actorA,
        entity: { type: "order", id: "42" },
        action: CREATE_THREAD_ENTITY_POLICY_ACTION,
      });

      const initialized = await harness.pool.query(
        `SELECT member.role, member.state,
                cursor.last_read_sequence::integer AS last_read_sequence,
                preference.notification_level, preference.muted,
                follow.is_following, follow.follow_source
           FROM ${tables.members} AS member
           JOIN ${tables.cursors} AS cursor USING (tenant_id, conversation_id, user_id)
           JOIN ${tables.preferences} AS preference USING (tenant_id, conversation_id, user_id)
           JOIN ${tables.follows} AS follow USING (tenant_id, conversation_id, user_id)
          WHERE member.tenant_id = 'tenant-a'
            AND member.conversation_id = $1
            AND member.user_id = 'actor-a'`,
        [thread.id],
      );
      assert.deepEqual(initialized.rows[0], {
        role: "owner",
        state: "active",
        last_read_sequence: 0,
        notification_level: "all",
        muted: false,
        is_following: true,
        follow_source: "manual",
      });
      assert.deepEqual(await countsForThread(thread.id), {
        conversations: 1,
        members: 1,
        cursors: 1,
        preferences: 1,
        follows: 1,
        messages: 0,
        audit: 1,
        outbox: 1,
      });

      const persisted = await harness.pool.query(
        `SELECT audit.metadata, audit.metadata::text AS audit_text,
                event.stream_id, event.type, event.payload,
                event.payload::text AS payload_text,
                event.protocol_version::integer AS protocol_version
           FROM ${tables.audit} AS audit
           JOIN ${tables.outbox} AS event ON event.tenant_id = audit.tenant_id
          WHERE audit.target_id = $1
          ORDER BY event.replay_position`,
        [thread.id],
      );
      assert.equal(persisted.rows.length, 2);
      assert.equal(Object.hasOwn(persisted.rows[0].payload.conversation, "name"), false);
      assert.deepEqual(persisted.rows[0].metadata, {
        parentConversationId: "parent-main",
        rootMessageId: "root-main",
        visibility: "public",
        initialFollowing: true,
      });
      assert.deepEqual(
        persisted.rows.map(({ stream_id, type }) => ({ stream_id, type })),
        [
          { stream_id: thread.id, type: "thread.created" },
          { stream_id: "parent-main", type: "message.thread_summary.updated" },
        ],
      );
      for (const row of persisted.rows) {
        assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
        assert.equal(row.audit_text.includes("sensitive root body"), false);
        assert.equal(row.audit_text.includes(request.idempotencyKey), false);
        assert.equal(row.payload_text.includes("sensitive root body"), false);
        assert.equal(row.payload_text.includes(request.idempotencyKey), false);
        assert.equal(row.payload_text.includes("employee"), false);
      }
    });

    await t.test("distinct concurrent keys proposing different names converge on one persisted thread and event", async () => {
      const [left, right] = await Promise.all([
        command(input("race-left", {
          parentConversationId: "parent-private",
          rootMessageId: "root-private",
          name: "Launch planning",
        })),
        command(input("race-right", {
          parentConversationId: "parent-private",
          rootMessageId: "root-private",
          name: "Release discussion",
        })),
      ]);
      assert.equal(left.conversation.conversation.id, right.conversation.conversation.id);
      assert.equal(left.parentConversationId, right.parentConversationId);
      assert.equal(left.rootMessageId, right.rootMessageId);
      assert.deepEqual(
        [left.reconciliationStatus, right.reconciliationStatus].sort(),
        ["created", "existing_for_root"],
      );
      const duplicateCount = await harness.pool.query(
        `SELECT count(*)::integer AS count
           FROM ${tables.conversations}
          WHERE tenant_id = 'tenant-a' AND type = 'thread'
            AND parent_conversation_id = 'parent-private'
            AND root_message_id = 'root-private'`,
      );
      assert.equal(duplicateCount.rows[0].count, 1);
      const created = left.reconciliationStatus === "created" ? left : right;
      const canonical = created.conversation.conversation;
      assert.equal(canonical.name, created === left ? "Launch planning" : "Release discussion");
      assert.equal(left.conversation.conversation.name, right.conversation.conversation.name);
      const persisted = await harness.pool.query(`SELECT conversation.id, conversation.name, event.payload
        FROM ${tables.conversations} AS conversation
        JOIN ${tables.outbox} AS event ON event.tenant_id = conversation.tenant_id
          AND event.stream_id = conversation.id AND event.type = 'thread.created'
        WHERE conversation.tenant_id = 'tenant-a' AND conversation.id = $1`, [canonical.id]);
      assert.equal(persisted.rows.length, 1);
      assert.equal(persisted.rows[0].name, canonical.name);
      assert.equal(persisted.rows[0].payload.conversation.id, canonical.id);
      assert.equal(persisted.rows[0].payload.conversation.name, canonical.name);
      for (const [suffix, name, original] of [
        ["race-left", "Launch planning", left],
        ["race-right", "Release discussion", right],
      ]) {
        const replay = await command(input(suffix, {
          parentConversationId: "parent-private", rootMessageId: "root-private", name,
        }));
        assert.deepEqual(replay, { ...original, reconciliationStatus: "replayed" });
      }
    });

    await t.test("persists named responses and events, reloads and replays, and rejects conflicting key reuse", async () => {
      const request = input("retry", {
        parentConversationId: "parent-other",
        rootMessageId: "root-other",
        initialFollow: false,
        name: "Launch date 🚀",
      });
      const first = await command(request);
      const thread = first.conversation.conversation;
      assert.equal(first.reconciliationStatus, "created");
      assert.equal(thread.name, request.name);
      const persisted = await harness.pool.query(`SELECT conversation.name, event.payload, key.response_body
        FROM ${tables.conversations} AS conversation
        JOIN ${tables.outbox} AS event ON event.tenant_id = conversation.tenant_id
          AND event.stream_id = conversation.id AND event.type = 'thread.created'
        JOIN ${tables.idempotency} AS key ON key.tenant_id = conversation.tenant_id
          AND key.user_id = 'actor-a' AND key.operation_name = 'thread.create' AND key.client_key = $2
        WHERE conversation.tenant_id = 'tenant-a' AND conversation.id = $1`, [thread.id, request.idempotencyKey]);
      assert.equal(persisted.rows.length, 1);
      assert.equal(persisted.rows[0].name, request.name);
      assert.equal(persisted.rows[0].payload.conversation.name, request.name);
      assert.deepEqual(persisted.rows[0].response_body, first);
      const reloaded = await command({ ...request, idempotencyKey: "named-reload", name: "Competing name" });
      assert.equal(reloaded.reconciliationStatus, "existing_for_root");
      assert.equal(reloaded.conversation.conversation.id, thread.id);
      assert.equal(reloaded.conversation.conversation.name, thread.name);
      assert.deepEqual(await command({ ...request, idempotencyKey: "named-reload", name: "Competing name" }),
        { ...reloaded, reconciliationStatus: "replayed" });
      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.equal(replay.conversation.conversation.id, first.conversation.conversation.id);
      assert.deepEqual(replay, { ...first, reconciliationStatus: "replayed" });
      const follow = await harness.pool.query(
        `SELECT is_following FROM ${tables.follows}
          WHERE tenant_id = 'tenant-a' AND conversation_id = $1 AND user_id = 'actor-a'`,
        [first.conversation.conversation.id],
      );
      assert.equal(follow.rows[0].is_following, false);
      await assert.rejects(
        command({ ...request, initialFollow: true }),
        (error) =>
          error instanceof CreateThreadCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
      for (const name of ["Changed name", undefined]) {
        await assert.rejects(command({ ...request, name }), (error) =>
          error instanceof CreateThreadCommandError && error.code === "idempotency_conflict");
      }
      assert.equal((await countsForThread(thread.id)).outbox, 1);
    });

    await t.test("legacy unnamed hashes replay stored outcomes with default and explicit follow semantics", async () => {
      for (const initialFollow of [undefined, true, false]) {
        const request = input(`legacy-${initialFollow}`, { initialFollow });
        if (initialFollow === undefined) delete request.initialFollow;
        const first = await command(request);
        // Independent pre-name hash: fixed alphabetical property order, no production helper.
        const legacyHash = `sha256:${createHash("sha256").update(JSON.stringify({
          initialFollow: initialFollow ?? true,
          operation: "create_thread",
          parentConversationId: "parent-main",
          rootMessageId: "root-main",
        })).digest("hex")}`;
        const stored = await harness.pool.query(`SELECT request_hash, response_body FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
            AND operation_name = 'thread.create' AND client_key = $1`, [request.idempotencyKey]);
        assert.equal(stored.rows[0].request_hash, legacyHash);
        assert.deepEqual(stored.rows[0].response_body, first);
        assert.equal(Object.hasOwn(first.conversation.conversation, "name"), false);
        // Seed a completed pre-change retry using the independently computed hash.
        const legacyKey = `${request.idempotencyKey}-stored`;
        await harness.pool.query(`INSERT INTO ${tables.idempotency}
          (tenant_id, user_id, operation_name, client_key, request_hash, state,
           response_status, response_body, created_at, updated_at, completed_at, expires_at)
          VALUES ('tenant-a', 'actor-a', 'thread.create', $1, $2, 'completed', 200, $3,
            statement_timestamp(), statement_timestamp(), statement_timestamp(),
            statement_timestamp() + interval '1 day')`, [legacyKey, legacyHash, first]);
        const before = await countsForThread(first.conversation.conversation.id);
        for (const follow of initialFollow === false ? [false] : [undefined, true]) {
          const replay = await command({ ...request, idempotencyKey: legacyKey, initialFollow: follow });
          assert.deepEqual(replay, { ...first, reconciliationStatus: "replayed" });
        }
        await assert.rejects(command({ ...request, idempotencyKey: legacyKey, name: "New name" }),
          (error) => error instanceof CreateThreadCommandError && error.code === "idempotency_conflict");
        assert.deepEqual(await countsForThread(first.conversation.conversation.id), before);
      }
    });

    await t.test("a named request against an unnamed thread retains its canonical ID and absent name", async () => {
      const original = await command(input("main"));
      const thread = original.conversation.conversation;
      const before = await countsForThread(thread.id);
      const request = input("named-existing-unnamed", { name: "Do not rename" });
      const existing = await command(request);
      assert.equal(existing.reconciliationStatus, "existing_for_root");
      assert.equal(existing.conversation.conversation.id, thread.id);
      assert.equal(Object.hasOwn(existing.conversation.conversation, "name"), false);
      assert.deepEqual(await command(request), { ...existing, reconciliationStatus: "replayed" });
      const stored = await harness.pool.query(`SELECT name FROM ${tables.conversations}
        WHERE tenant_id = 'tenant-a' AND id = $1`, [thread.id]);
      assert.equal(stored.rows[0].name, null);
      assert.deepEqual(await countsForThread(thread.id), before);
    });

    await t.test("reconciliation retains role, private state and follow revision despite initialFollow", async () => {
      const request = input("retained-create", { initialFollow: false });
      const first = await command(request);
      const id = first.conversation.conversation.id;
      await harness.pool.query(`UPDATE ${tables.members} SET role = 'moderator', state = 'left'
        WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
      await harness.pool.query(`UPDATE ${tables.cursors} SET last_read_sequence = 7, manual_unread_from_sequence = 3
        WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
      await harness.pool.query(`UPDATE ${tables.preferences}
        SET notification_level = 'none', muted = true, muted_until = '2099-01-01',
            is_starred = true, preference_revision = 5
        WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
      await harness.pool.query(`UPDATE ${tables.follows}
        SET is_following = false, follow_revision = 9
        WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
      await harness.pool.query(`INSERT INTO ${schema}.chat_drafts
        (tenant_id, conversation_id, user_id, content, revision)
        VALUES ('tenant-a', $1, 'actor-a', '{"format":"markdown","text":"keep draft"}', 4)`, [id]);
      const state = async () => (await harness.pool.query(`SELECT
        member.role, member.joined_at, row_to_json(cursor) AS cursor,
        row_to_json(preference) AS preference, row_to_json(follow) AS follow,
        row_to_json(draft) AS draft
        FROM ${tables.members} AS member
        JOIN ${tables.cursors} AS cursor USING (tenant_id, conversation_id, user_id)
        JOIN ${tables.preferences} AS preference USING (tenant_id, conversation_id, user_id)
        JOIN ${tables.follows} AS follow USING (tenant_id, conversation_id, user_id)
        JOIN ${schema}.chat_drafts AS draft USING (tenant_id, conversation_id, user_id)
        WHERE member.conversation_id = $1 AND member.user_id = 'actor-a'`, [id])).rows;
      const before = await state();
      const reconciled = await command(input("retained-reconcile", { initialFollow: true }));
      assert.equal(reconciled.reconciliationStatus, "existing_for_root");
      assert.equal(reconciled.conversation.conversation.id, id);
      assert.equal(reconciled.conversation.conversation.currentMember.state, "active");
      assert.deepEqual(await state(), before);
      const replay = await command(input("retained-reconcile", { initialFollow: true }));
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(await state(), before);
    });

    await t.test("creation retains its missing-follow default and explicit false behavior", async () => {
      for (const initialFollow of [undefined, false]) {
        const existing = await command(input(`follow-find-${initialFollow}`));
        const id = existing.conversation.conversation.id;
        await harness.pool.query(`DELETE FROM ${tables.follows} WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
        const request = input(`follow-missing-${initialFollow}`, { initialFollow });
        if (initialFollow === undefined) delete request.initialFollow;
        await command(request);
        const follow = await harness.pool.query(`SELECT is_following FROM ${tables.follows}
          WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
        assert.equal(follow.rows[0].is_following, initialFollow ?? true);
      }
    });

    await t.test("private-parent revocation rejects reconciliation and replay without setup", async () => {
      const request = input("revoke-private", { parentConversationId: "parent-private", rootMessageId: "root-private" });
      const first = await command(request);
      const id = first.conversation.conversation.id;
      await harness.pool.query(`UPDATE ${tables.members} SET state = 'left'
        WHERE conversation_id = 'parent-private' AND user_id = 'actor-a'`);
      await harness.pool.query(`DELETE FROM ${tables.cursors} WHERE conversation_id = $1 AND user_id = 'actor-a'`, [id]);
      const before = await countsForThread(id);
      await assert.rejects(command(request), ChatAuthorizationError);
      await assert.rejects(command({ ...request, idempotencyKey: 'revoked-fresh-key' }), ChatAuthorizationError);
      assert.deepEqual(await countsForThread(id), before);
      await harness.pool.query(`UPDATE ${tables.members} SET state = 'active'
        WHERE conversation_id = 'parent-private' AND user_id = 'actor-a'`);
    });

    await t.test("sanitizes wrong-parent, nested, cross-tenant, archived, deleted, and unauthorized targets", async () => {
      const denied = [
        input("wrong-parent", { rootMessageId: "root-other" }),
        input("nested", {
          parentConversationId: "nested-thread",
          rootMessageId: "nested-reply",
        }),
        input("cross-tenant", {
          parentConversationId: "parent-cross-tenant",
          rootMessageId: "root-cross-tenant",
        }),
        input("archived", {
          parentConversationId: "parent-archived",
          rootMessageId: "root-archived",
        }),
        input("deleted", {
          parentConversationId: "parent-deleted-root",
          rootMessageId: "root-deleted",
        }),
        input("membership-denied", {
          parentConversationId: "parent-unauthorized",
          rootMessageId: "root-unauthorized",
        }),
      ];
      for (const request of denied) {
        await assert.rejects(command(request), ChatAuthorizationError);
      }

      entityAllowed = false;
      await assert.rejects(command(input("entity-denied")), ChatAuthorizationError);
      entityAllowed = true;
      capabilities = [];
      await assert.rejects(command(input("capability-denied")), ChatAuthorizationError);
      capabilities = ["thread.create"];
      await assert.rejects(
        command({ ...input("spoofed"), tenantId: "tenant-b" }),
        (error) =>
          error instanceof ThreadCreationParseError &&
          error.code === "trusted_identity_field",
      );
    });

    await t.test("supplied names retain canonical validation without normalization", async () => {
      for (const name of ["", " untrimmed ", "x".repeat(101), null]) {
        const request = input("invalid-name", { name });
        await assert.rejects(command(request), ThreadCreationParseError);
      }
      const stored = await harness.pool.query(`SELECT count(*)::integer AS count FROM ${tables.idempotency}
        WHERE tenant_id = 'tenant-a' AND client_key = 'create-thread-invalid-name'`);
      assert.equal(stored.rows[0].count, 0);
    });

    await t.test("a named request cannot reconcile to an archived existing thread", async () => {
      await harness.pool.query(`UPDATE ${tables.conversations}
        SET archived_at = clock_timestamp(), archived_by_user_id = 'actor-a'
        WHERE tenant_id = 'tenant-a' AND id = 'nested-thread'`);
      const before = await countsForThread("nested-thread");
      await assert.rejects(command(input("archived-existing", {
        parentConversationId: "nested-base", rootMessageId: "nested-root", name: "Cannot reopen",
      })), ChatAuthorizationError);
      assert.deepEqual(await countsForThread("nested-thread"), before);
    });

    await t.test("an injected late event failure rolls back every mutation", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_thread_parent_event()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.event_id = 'rollback-parent-event' THEN
               RAISE EXCEPTION 'injected late thread failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_thread_parent_event
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_thread_parent_event()`,
      );
      const ids = [
        "rollback-thread",
        "rollback-audit-event",
        "rollback-thread-event",
        "rollback-parent-event",
      ];
      const request = input("rollback", {
        parentConversationId: "rollback-parent",
        rootMessageId: "rollback-root",
        name: "Rolled back name",
      });
      await assert.rejects(
        command(request, { createId: () => ids.shift() }),
        /injected late thread failure/,
      );
      assert.deepEqual(await countsForThread("rollback-thread"), {
        conversations: 0,
        members: 0,
        cursors: 0,
        preferences: 0,
        follows: 0,
        messages: 0,
        audit: 0,
        outbox: 0,
      });
      const idempotency = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND client_key = $1`,
        [request.idempotencyKey],
      );
      assert.equal(idempotency.rows[0].count, 0);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
