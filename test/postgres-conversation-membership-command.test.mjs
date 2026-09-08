import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  ConversationMembershipParseError,
} from "@handrail/chat";
import {
  CONVERSATION_MEMBERSHIP_ASSIGN_OWNER_CAPABILITY,
  CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION,
  CONVERSATION_MEMBERSHIP_MANAGE_CAPABILITY,
  CONVERSATION_MEMBERSHIP_UPDATED_EVENT,
  ChatAuthorizationError,
  ConversationMembershipCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  mutateConversationMembership,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const ownerActor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["sensitive-host-owner-role"]),
});

const actor = (userId) =>
  Object.freeze({
    tenantId: "tenant-a",
    userId,
    roles: Object.freeze(["sensitive-host-role"]),
  });

const membershipInput = (suffix, intent, conversationId, overrides = {}) => ({
  operation: "mutate_conversation_membership",
  intent,
  conversationId,
  expectedMemberListRevision: 1,
  idempotencyKey: `membership-${suffix}`,
  ...overrides,
});

const targetedInput = (
  suffix,
  intent,
  conversationId,
  targetUserId,
  overrides = {},
) => ({
  ...membershipInput(suffix, intent, conversationId),
  targetUserId,
  ...(intent === "add_member" || intent === "change_member_role"
    ? { requestedRole: "member" }
    : {}),
  ...overrides,
});

const authorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

test("conversation-membership command applies every intent atomically in PostgreSQL", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_membership" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    cursors: `${schema}.chat_read_cursors`,
    preferences: `${schema}.chat_conversation_preferences`,
    follows: `${schema}.chat_thread_follows`,
    messages: `${schema}.chat_messages`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const users = new Map(
    ["actor-a", "actor-member", "actor-moderator", "owner-b", "user-b", "user-c", "user-d", "user-e"]
      .map((userId) => [
        userId,
        { tenantId: "tenant-a", userId, displayName: `Display ${userId}` },
      ]),
  );
  let capabilities = [];
  let entityMode = "allow";
  let directoryOverride;
  const entityCalls = [];
  const adapters = {
    directory: {
      async getUser(request) {
        if (directoryOverride !== undefined) return directoryOverride(request);
        return users.get(request.userId) ?? null;
      },
    },
    permissions: {
      async getCapabilities() {
        return capabilities;
      },
      async authorizeEntity(request) {
        entityCalls.push(request);
        if (entityMode === "error") throw new Error("sensitive provider failure");
        return entityMode === "allow";
      },
    },
  };
  let nextId = 0;
  const createId = () => `membership-command-${++nextId}`;
  const command = (input, options = {}) =>
    mutateConversationMembership({
      database: harness.pool,
      schema: harness.schema,
      actor: ownerActor,
      input,
      directory: adapters.directory,
      permissions: adapters.permissions,
      createId,
      ...options,
    });

  const stateCounts = async (conversationId, userId) =>
    (
      await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.members}
             WHERE tenant_id = 'tenant-a' AND conversation_id = $1
               AND user_id = $2) AS members,
           (SELECT count(*)::integer FROM ${tables.cursors}
             WHERE tenant_id = 'tenant-a' AND conversation_id = $1
               AND user_id = $2) AS cursors,
           (SELECT count(*)::integer FROM ${tables.preferences}
             WHERE tenant_id = 'tenant-a' AND conversation_id = $1
               AND user_id = $2) AS preferences,
           (SELECT count(*)::integer FROM ${tables.audit}
             WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audit,
           (SELECT count(*)::integer FROM ${tables.outbox}
             WHERE tenant_id = 'tenant-a'
               AND (stream_id = $1 OR stream_id = 'user:' || $2)) AS outbox`,
        [conversationId, userId],
      )
    ).rows[0];

  try {
    const applied = await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    assert.deepEqual(
      applied.applied.map(({ id, order }) => ({ id, order })).at(-1),
      {
      id: "0017-chat-conversation-member-list-revision",
      order: 17,
      },
    );

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id)
       VALUES
         ('tenant-a', 'public-join', 'channel', 'public', 'Public join', NULL, NULL),
         ('tenant-a', 'private-join', 'channel', 'private', 'Private join', NULL, NULL),
         ('tenant-a', 'entity-join', 'channel', 'public', 'Entity join', 'case', 'secret-case'),
         ('tenant-a', 'leave-target', 'channel', 'private', 'Leave', NULL, NULL),
         ('tenant-a', 'add-target', 'channel', 'private', 'Add', NULL, NULL),
         ('tenant-a', 'remove-target', 'channel', 'private', 'Remove', NULL, NULL),
         ('tenant-a', 'role-target', 'channel', 'private', 'Role', NULL, NULL),
         ('tenant-a', 'unauthorized-target', 'channel', 'private', 'Unauthorized', NULL, NULL),
         ('tenant-a', 'escalation-target', 'channel', 'private', 'Escalation', NULL, NULL),
         ('tenant-a', 'last-owner-target', 'channel', 'private', 'Last owner', NULL, NULL),
         ('tenant-a', 'last-active-target', 'channel', 'private', 'Last active', NULL, NULL),
         ('tenant-a', 'direct-target', 'direct', 'private', NULL, NULL, NULL),
         ('tenant-a', 'group-min-target', 'group_direct', 'private', NULL, NULL, NULL),
         ('tenant-a', 'conflict-target', 'channel', 'private', 'Conflict', NULL, NULL),
         ('tenant-a', 'replay-target', 'channel', 'private', 'Replay', NULL, NULL),
         ('tenant-a', 'concurrent-target', 'channel', 'private', 'Concurrent', NULL, NULL),
         ('tenant-a', 'rollback-target', 'channel', 'private', 'Rollback', NULL, NULL),
         ('tenant-a', 'thread-parent', 'channel', 'public', 'Thread parent', NULL, NULL),
         ('tenant-b', 'cross-tenant-target', 'channel', 'public', 'Cross tenant', NULL, NULL)`,
    );
    await harness.pool.query(
      `UPDATE ${tables.conversations}
          SET current_message_sequence = 1
        WHERE tenant_id = 'tenant-a' AND id IN ('leave-target', 'thread-parent')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'leave-root', 'leave-target', 1, 'owner-b',
          'leave-root-client', '{"format":"plain","text":"retained body"}'),
         ('tenant-a', 'join-root', 'thread-parent', 1, 'owner-b',
          'join-root-client', '{"format":"plain","text":"retained body"}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
       VALUES
         ('tenant-a', 'leave-child', 'thread', 'private', 'leave-target', 'leave-root'),
         ('tenant-a', 'thread-join', 'thread', 'public', 'thread-parent', 'join-root')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'public-join', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'private-join', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'entity-join', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'thread-parent', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'thread-join', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'leave-target', 'actor-member', 'member', 'active'),
         ('tenant-a', 'leave-target', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'leave-child', 'actor-member', 'member', 'active'),
         ('tenant-a', 'leave-child', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'add-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'remove-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'remove-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'role-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'role-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'unauthorized-target', 'actor-member', 'member', 'active'),
         ('tenant-a', 'unauthorized-target', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'escalation-target', 'actor-moderator', 'moderator', 'active'),
         ('tenant-a', 'escalation-target', 'owner-b', 'owner', 'active'),
         ('tenant-a', 'last-owner-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'last-owner-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'last-active-target', 'actor-member', 'member', 'active'),
         ('tenant-a', 'direct-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'direct-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'group-min-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'group-min-target', 'user-b', 'member', 'active'),
         ('tenant-a', 'group-min-target', 'user-c', 'member', 'active'),
         ('tenant-a', 'conflict-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'replay-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'concurrent-target', 'actor-a', 'owner', 'active'),
         ('tenant-a', 'rollback-target', 'actor-a', 'owner', 'active'),
         ('tenant-b', 'cross-tenant-target', 'actor-a', 'owner', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.cursors}
         (tenant_id, conversation_id, user_id, last_read_sequence)
       VALUES ('tenant-a', 'leave-target', 'actor-member', 0),
              ('tenant-a', 'remove-target', 'user-b', 0)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.preferences}
         (tenant_id, conversation_id, user_id, notification_level, muted)
       VALUES ('tenant-a', 'leave-target', 'actor-member', 'mentions', false),
              ('tenant-a', 'remove-target', 'user-b', 'none', false)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.follows}
         (tenant_id, conversation_id, user_id, is_following, follow_source)
       VALUES ('tenant-a', 'leave-child', 'actor-member', true, 'manual')`,
    );

    await t.test("applies join, leave, add, remove, and role-change intents", async () => {
      const joined = await command(
        membershipInput("join", "join", "public-join"),
      );
      assert.equal(joined.reconciliationStatus, "applied");
      assert.equal(joined.memberUserId, "actor-a");
      assert.equal(joined.memberListRevision, 2);
      assert.deepEqual(
        joined.members.find(({ userId }) => userId === "actor-a"),
        {
          userId: "actor-a",
          role: "member",
          state: "active",
          joinedAt: joined.members[0].joinedAt,
          updatedAt: joined.members[0].updatedAt,
        },
      );
      assert.deepEqual(await stateCounts("public-join", "actor-a"), {
        members: 1,
        cursors: 1,
        preferences: 1,
        audit: 1,
        outbox: 2,
      });
      const joinedThread = await command(
        membershipInput("thread-join", "join", "thread-join"),
      );
      assert.equal(joinedThread.reconciliationStatus, "applied");
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT is_following, follow_source
               FROM ${tables.follows}
              WHERE tenant_id = 'tenant-a' AND conversation_id = 'thread-join'
                AND user_id = 'actor-a'`,
          )
        ).rows[0],
        { is_following: false, follow_source: "manual" },
      );

      const left = await command(
        membershipInput("leave", "leave", "leave-target"),
        { actor: actor("actor-member") },
      );
      assert.equal(left.reconciliationStatus, "applied");
      assert.equal(left.members.find(({ userId }) => userId === "actor-member").state, "left");
      assert.deepEqual(await stateCounts("leave-target", "actor-member"), {
        members: 1,
        cursors: 0,
        preferences: 0,
        audit: 1,
        outbox: 2,
      });
      assert.equal(
        (
          await harness.pool.query(
            `SELECT is_following FROM ${tables.follows}
              WHERE tenant_id = 'tenant-a' AND conversation_id = 'leave-child'
                AND user_id = 'actor-member'`,
          )
        ).rows[0].is_following,
        false,
      );

      const added = await command(
        targetedInput("add", "add_member", "add-target", "user-b", {
          requestedRole: "moderator",
        }),
      );
      assert.equal(added.reconciliationStatus, "applied");
      assert.equal(added.members.find(({ userId }) => userId === "user-b").role, "moderator");
      assert.deepEqual(await stateCounts("add-target", "user-b"), {
        members: 1,
        cursors: 1,
        preferences: 1,
        audit: 1,
        outbox: 2,
      });

      const removed = await command(
        targetedInput("remove", "remove_member", "remove-target", "user-b"),
      );
      assert.equal(removed.reconciliationStatus, "applied");
      assert.equal(removed.members.find(({ userId }) => userId === "user-b").state, "removed");
      assert.deepEqual(await stateCounts("remove-target", "user-b"), {
        members: 1,
        cursors: 0,
        preferences: 0,
        audit: 1,
        outbox: 2,
      });

      const changed = await command(
        targetedInput("role", "change_member_role", "role-target", "user-b", {
          requestedRole: "moderator",
        }),
      );
      assert.equal(changed.reconciliationStatus, "applied");
      assert.equal(changed.members.find(({ userId }) => userId === "user-b").role, "moderator");
    });

    await t.test("enforces public self-join, entity access, and management policy", async () => {
      await assert.rejects(
        command(membershipInput("private", "join", "private-join")),
        authorizationFailure,
      );
      entityMode = "deny";
      await assert.rejects(
        command(membershipInput("entity-denied", "join", "entity-join")),
        authorizationFailure,
      );
      entityMode = "error";
      await assert.rejects(
        command(membershipInput("entity-error", "join", "entity-join")),
        authorizationFailure,
      );
      entityMode = "allow";
      assert.deepEqual(entityCalls.at(-1), {
        actor: ownerActor,
        entity: { type: "case", id: "secret-case" },
        action: CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION,
      });

      await assert.rejects(
        command(
          targetedInput("unauthorized", "add_member", "unauthorized-target", "user-b"),
          { actor: actor("actor-member") },
        ),
        authorizationFailure,
      );
      await assert.rejects(
        command(
          targetedInput("escalated", "change_member_role", "escalation-target", "user-b", {
            requestedRole: "owner",
          }),
          { actor: actor("actor-moderator") },
        ),
        authorizationFailure,
      );
      capabilities = [
        CONVERSATION_MEMBERSHIP_MANAGE_CAPABILITY,
        CONVERSATION_MEMBERSHIP_ASSIGN_OWNER_CAPABILITY,
      ];
      const elevated = await command(
        targetedInput("capability-owner", "add_member", "unauthorized-target", "user-b", {
          requestedRole: "owner",
        }),
        { actor: actor("actor-member") },
      );
      assert.equal(elevated.reconciliationStatus, "applied");
      capabilities = [];
    });

    await t.test("rejects malformed roles, unsafe owner/member loss, and direct/group identity changes", async () => {
      await assert.rejects(
        command(
          targetedInput("invalid-role", "add_member", "add-target", "user-c", {
            requestedRole: "administrator",
          }),
        ),
        (error) =>
          error instanceof ConversationMembershipParseError &&
          error.code === "malformed_input",
      );

      const lastOwner = await command(
        targetedInput("last-owner", "change_member_role", "last-owner-target", "actor-a", {
          requestedRole: "member",
        }),
      );
      assert.equal(lastOwner.reconciliationStatus, "safety_rejected");
      assert.equal(lastOwner.safetyError.code, "last_owner");
      const lastActive = await command(
        membershipInput("last-active", "leave", "last-active-target"),
        { actor: actor("actor-member") },
      );
      assert.equal(lastActive.reconciliationStatus, "safety_rejected");
      assert.equal(lastActive.safetyError.code, "last_active_member");

      for (const request of [
        targetedInput("direct-add", "add_member", "direct-target", "user-c"),
        membershipInput("direct-leave", "leave", "direct-target"),
        targetedInput("group-remove", "remove_member", "group-min-target", "user-b"),
      ]) {
        await assert.rejects(
          command(request),
          (error) =>
            error instanceof ConversationMembershipCommandError &&
            error.code === "membership_invariant" &&
            error.statusCode === 422,
        );
      }
    });

    await t.test("fails directory and tenant identity mismatches without leaking membership", async () => {
      for (const unavailable of [
        null,
        { tenantId: "tenant-a", userId: "user-b", kind: "redacted" },
        { tenantId: "tenant-a", userId: "user-b", kind: "unavailable", reason: "missing" },
        { tenantId: "tenant-b", userId: "user-b", displayName: "Cross tenant" },
        { tenantId: "tenant-a", userId: "user-e", displayName: "Mismatched" },
      ]) {
        directoryOverride = async () => unavailable;
        await assert.rejects(
          command(
            targetedInput(
              `directory-${String(unavailable?.kind ?? unavailable?.tenantId ?? "null")}`,
              "add_member",
              "add-target",
              "user-b",
              { expectedMemberListRevision: 2 },
            ),
          ),
          (error) =>
            error instanceof ConversationMembershipCommandError &&
            error.code === "directory_user_unavailable" &&
            error.message === "The requested conversation member is unavailable",
        );
      }
      directoryOverride = undefined;
      await assert.rejects(
        command(
          targetedInput("cross-conversation", "add_member", "cross-tenant-target", "user-b"),
        ),
        authorizationFailure,
      );
    });

    await t.test("returns revision conflicts and exact idempotent replays", async () => {
      await harness.pool.query(
        `UPDATE ${tables.conversations}
            SET member_list_revision = 4
          WHERE tenant_id = 'tenant-a' AND id = 'conflict-target'`,
      );
      const conflictRequest = targetedInput(
        "conflict",
        "add_member",
        "conflict-target",
        "user-b",
      );
      const conflict = await command(conflictRequest);
      assert.equal(conflict.reconciliationStatus, "member_list_conflict");
      assert.equal(conflict.memberListRevision, 4);
      assert.deepEqual(await command(conflictRequest), conflict);

      const replayRequest = targetedInput(
        "replay",
        "add_member",
        "replay-target",
        "user-b",
      );
      const appliedResult = await command(replayRequest);
      const replay = await command(replayRequest);
      assert.equal(appliedResult.reconciliationStatus, "applied");
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(
        { ...replay, reconciliationStatus: "applied" },
        appliedResult,
      );
      assert.deepEqual(await stateCounts("replay-target", "user-b"), {
        members: 1,
        cursors: 1,
        preferences: 1,
        audit: 1,
        outbox: 2,
      });
      await assert.rejects(
        command({ ...replayRequest, requestedRole: "moderator" }),
        (error) =>
          error instanceof ConversationMembershipCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
    });

    await t.test("concurrent duplicate additions converge to one mutation", async () => {
      const request = targetedInput(
        "concurrent",
        "add_member",
        "concurrent-target",
        "user-c",
      );
      const [left, right] = await Promise.all([command(request), command(request)]);
      assert.deepEqual(
        [left.reconciliationStatus, right.reconciliationStatus].sort(),
        ["applied", "replayed"],
      );
      assert.equal(left.memberListRevision, 2);
      assert.equal(right.memberListRevision, 2);
      assert.deepEqual(await stateCounts("concurrent-target", "user-c"), {
        members: 1,
        cursors: 1,
        preferences: 1,
        audit: 1,
        outbox: 2,
      });
    });

    await t.test("persists sanitized audit and versioned conversation/user events", async () => {
      const rows = (
        await harness.pool.query(
          `SELECT audit.metadata, audit.metadata::text AS audit_text,
                  event.stream_id, event.type,
                  event.protocol_version::integer AS protocol_version,
                  event.payload, event.payload::text AS payload_text,
                  event.expires_at > event.occurred_at AS bounded_retention
             FROM ${tables.audit} AS audit
             JOIN ${tables.outbox} AS event
               ON event.tenant_id = audit.tenant_id
              AND event.occurred_at = audit.occurred_at
              AND event.type = audit.action
            WHERE audit.tenant_id = 'tenant-a'
              AND audit.target_id = 'add-target'
            ORDER BY event.replay_position`,
        )
      ).rows;
      assert.deepEqual(
        rows.map(({ stream_id, type }) => ({ stream_id, type })),
        [
          { stream_id: "add-target", type: CONVERSATION_MEMBERSHIP_UPDATED_EVENT },
          { stream_id: "user:user-b", type: CONVERSATION_MEMBERSHIP_UPDATED_EVENT },
        ],
      );
      assert.deepEqual(rows[0].metadata, {
        conversationId: "add-target",
        intent: "add_member",
        memberUserId: "user-b",
        previousRole: null,
        currentRole: "moderator",
        previousState: null,
        currentState: "active",
        previousMemberListRevision: 1,
        currentMemberListRevision: 2,
        activeMemberCount: 2,
      });
      for (const row of rows) {
        assert.equal(row.protocol_version, CHAT_PROTOCOL_VERSION);
        assert.equal(row.bounded_retention, true);
        assert.equal(row.payload.input.intent, "add_member");
        assert.equal(row.payload.input.idempotencyKey, "membership-add");
        assert.equal(row.payload.result.memberListRevision, 2);
        for (const secret of [
          "sensitive-host-owner-role",
          "Display user-b",
          "secret-case",
        ]) {
          assert.equal(row.audit_text.includes(secret), false);
          assert.equal(row.payload_text.includes(secret), false);
        }
        assert.equal(row.audit_text.includes("membership-add"), false);
      }
    });

    await t.test("rolls back membership, related state, events, and idempotency", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_membership_audit()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.target_id = 'rollback-target' THEN
               RAISE EXCEPTION 'injected membership audit failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_membership_audit
           BEFORE INSERT ON ${tables.audit}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_membership_audit()`,
      );
      const request = targetedInput(
        "rollback",
        "add_member",
        "rollback-target",
        "user-d",
      );
      await assert.rejects(command(request), /injected membership audit failure/);
      assert.deepEqual(await stateCounts("rollback-target", "user-d"), {
        members: 0,
        cursors: 0,
        preferences: 0,
        audit: 0,
        outbox: 0,
      });
      const outcome = await harness.pool.query(
        `SELECT state FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
            AND client_key = $1`,
        [request.idempotencyKey],
      );
      assert.equal(outcome.rowCount, 0);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT member_list_revision::integer AS revision
               FROM ${tables.conversations}
              WHERE tenant_id = 'tenant-a' AND id = 'rollback-target'`,
          )
        ).rows[0].revision,
        1,
      );
    });
  } finally {
    await harness.dispose();
    await backend.dispose();
  }
});


test("a fractional-millisecond membership claim completes and replays a member-list conflict", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_membership_fraction" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const command = (input, options = {}) => mutateConversationMembership({
    database: harness.pool,
    schema: harness.schema,
    actor: ownerActor,
    input,
    directory: { async getUser() { return null; } },
    permissions: {
      async getCapabilities() { return []; },
      async authorizeEntity() { return true; },
    },
    ...options,
  });
  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    const conversationId = "fractional-claim";
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, member_list_revision)
       VALUES ('tenant-a', $1, 'channel', 'private', 'Fractional claim', 2)`,
      [conversationId],
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ('tenant-a', $1, 'actor-a', 'owner', 'active')`,
      [conversationId],
    );
    const input = membershipInput("fractional-claim", "leave", conversationId);
    // Match the command's canonical sorted keys; leave has no target or role.
    const requestHash = `sha256:${createHash("sha256").update(JSON.stringify({
      conversationId: input.conversationId,
      expectedMemberListRevision: input.expectedMemberListRevision,
      intent: input.intent,
      operation: input.operation,
    })).digest("hex")}`;
    const claim = (await harness.pool.query(
      `INSERT INTO ${tables.idempotency}
         (tenant_id, user_id, operation_name, client_key, request_hash,
          state, created_at, updated_at, expires_at)
       SELECT 'tenant-a', 'actor-a', 'conversation.membership.mutate', $1, $2,
              'pending', claimed_at, claimed_at, claimed_at + interval '2 minutes'
       FROM (SELECT date_trunc('milliseconds', clock_timestamp())
                    + interval '456 microseconds' AS claimed_at) AS clock
       RETURNING created_at, expires_at::text`,
      [input.idempotencyKey, requestHash],
    )).rows[0];
    assert.ok(claim.created_at instanceof Date);
    let clockSamples = 0;
    const clockDatabase = {
      query: harness.pool.query.bind(harness.pool),
      async connect() {
        const connection = await harness.pool.connect();
        return {
          async query(sql, values) {
            // Execute every query and transaction on PostgreSQL, substituting
            // only the locked conversation clock with the truncated claim Date.
            const result = await connection.query(sql, values);
            if (sql.includes("clock_timestamp() AS occurred_at") &&
                sql.includes(`FROM ${tables.conversations} AS conversation`)) {
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
    const storedState = async () => (await harness.pool.query(
      `SELECT
         (SELECT jsonb_agg(conversation ORDER BY id)
          FROM ${tables.conversations} AS conversation) AS conversations,
         (SELECT jsonb_agg(member ORDER BY tenant_id, conversation_id, user_id)
          FROM ${tables.members} AS member) AS members,
         (SELECT coalesce(jsonb_agg(audit ORDER BY event_id), '[]'::jsonb)
          FROM ${tables.audit} AS audit) AS audits,
         (SELECT coalesce(jsonb_agg(event ORDER BY event_id), '[]'::jsonb)
          FROM ${tables.outbox} AS event) AS outbox`,
    )).rows;
    const before = await storedState();
    const member = before[0].members.find((row) => row.conversation_id === conversationId);
    const conflict = await command(input, { database: clockDatabase });
    assert.equal(clockSamples, 1);
    assert.deepEqual(conflict, {
      operation: input.operation,
      intent: input.intent,
      reconciliationStatus: "member_list_conflict",
      conversationId,
      expectedMemberListRevision: 1,
      memberListRevision: 2,
      memberUserId: ownerActor.userId,
      members: [{
        userId: member.user_id,
        role: member.role,
        state: member.state,
        joinedAt: new Date(member.joined_at).toISOString(),
        updatedAt: new Date(member.updated_at).toISOString(),
      }],
    });
    const storedOutcome = async () => (await harness.pool.query(
      `SELECT to_jsonb(claim) AS claim,
              created_at::text, updated_at::text, completed_at::text, expires_at::text,
              completed_at = created_at AS completion_equals_claim,
              updated_at = created_at AS update_equals_claim,
              created_at - $2::timestamptz = interval '456 microseconds' AS precision_gap
       FROM ${tables.idempotency} AS claim
       WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
         AND operation_name = 'conversation.membership.mutate' AND client_key = $1`,
      [input.idempotencyKey, claim.created_at],
    )).rows;
    const outcome = await storedOutcome();
    assert.equal(outcome.length, 1);
    assert.equal(outcome[0].claim.state, "completed");
    assert.equal(outcome[0].claim.response_status, 200);
    assert.deepEqual(outcome[0].claim.response_body, conflict);
    assert.equal(outcome[0].claim.request_hash, requestHash);
    for (const field of ["completion_equals_claim", "update_equals_claim", "precision_gap"]) {
      assert.equal(outcome[0][field], true, field);
    }
    // Text and JSON retain the microseconds discarded by JavaScript Date.
    assert.equal(outcome[0].completed_at, outcome[0].created_at);
    assert.equal(outcome[0].updated_at, outcome[0].created_at);
    assert.equal(outcome[0].expires_at, claim.expires_at);
    assert.deepEqual(await storedState(), before);

    assert.deepEqual(await command(input), conflict);
    assert.equal(clockSamples, 1);
    assert.deepEqual(await storedOutcome(), outcome);
    assert.deepEqual(await storedState(), before);
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
