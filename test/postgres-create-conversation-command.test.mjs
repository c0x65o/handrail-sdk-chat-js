import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  ConversationCreationParseError,
} from "@handrail/chat";
import {
  ChatAuthorizationError,
  CreateConversationCommandError,
  createConversation,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actorA = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const channelInput = (suffix, overrides = {}) => ({
  operation: "create_conversation",
  type: "channel",
  name: `Channel ${suffix}`,
  visibility: "public",
  idempotencyKey: `create-${suffix}`,
  clientRequestId: `client-${suffix}`,
  ...overrides,
});

const directInput = (suffix, userId = "user-b", overrides = {}) => ({
  operation: "create_conversation",
  type: "direct",
  visibility: "private",
  intendedMemberUserIds: [userId],
  idempotencyKey: `create-${suffix}`,
  clientRequestId: `client-${suffix}`,
  ...overrides,
});

const groupInput = (suffix, users, overrides = {}) => ({
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: users,
  idempotencyKey: `create-${suffix}`,
  clientRequestId: `client-${suffix}`,
  ...overrides,
});

test("atomic create-conversation command authorizes, reconciles, and rolls back PostgreSQL state", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_create" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    cursors: `${schema}.chat_read_cursors`,
    preferences: `${schema}.chat_conversation_preferences`,
    audit: `${schema}.chat_audit_events`,
    outbox: `${schema}.chat_outbox_events`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const users = new Map([
    ["tenant-a:user-b", { tenantId: "tenant-a", userId: "user-b", displayName: "User B" }],
    ["tenant-a:user-c", { tenantId: "tenant-a", userId: "user-c", displayName: "User C" }],
    ["tenant-a:user-d", { tenantId: "tenant-a", userId: "user-d", displayName: "User D" }],
    ["tenant-b:user-b", { tenantId: "tenant-b", userId: "user-b", displayName: "Tenant B User" }],
  ]);
  let capabilities = ["conversation.create"];
  let entityAllowed = true;
  let directoryOverride;
  const entityCalls = [];
  const adapters = {
    directory: {
      async getUser(request) {
        if (directoryOverride !== undefined) return directoryOverride(request);
        return users.get(`${request.actor.tenantId}:${request.userId}`) ?? null;
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
  const createId = () => `create-command-${++nextId}`;
  const command = (input, overrides = {}) =>
    createConversation({
      database: harness.pool,
      schema: harness.schema,
      actor: actorA,
      input,
      directory: adapters.directory,
      permissions: adapters.permissions,
      createId,
      ...overrides,
    });

  const countsForConversation = async (conversationId) => {
    const result = await harness.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM ${tables.conversations} WHERE tenant_id = 'tenant-a' AND id = $1) AS conversations,
         (SELECT count(*)::integer FROM ${tables.members} WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS members,
         (SELECT count(*)::integer FROM ${tables.cursors} WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS cursors,
         (SELECT count(*)::integer FROM ${tables.preferences} WHERE tenant_id = 'tenant-a' AND conversation_id = $1) AS preferences,
         (SELECT count(*)::integer FROM ${tables.audit} WHERE tenant_id = 'tenant-a' AND target_id = $1) AS audit,
         (SELECT count(*)::integer FROM ${tables.outbox} WHERE tenant_id = 'tenant-a' AND stream_id = $1) AS outbox`,
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

    await t.test("creates public and private channels with actor-owned defaults", async () => {
      const publicRequest = channelInput("public", {
        entity: { type: "order", id: "order-42" },
      });
      const publicResult = await command(publicRequest);
      assert.equal(publicResult.reconciliationStatus, "created");
      assert.equal(publicResult.conversation.conversation.tenantId, "tenant-a");
      assert.equal(publicResult.conversation.conversation.visibility, "public");
      assert.equal(publicResult.conversation.conversation.currentMember.role, "owner");
      assert.equal(publicResult.conversation.conversation.currentReadState.lastReadSequence, 0);
      assert.deepEqual(publicResult.conversation.conversation.currentPreference.mute, { muted: false });
      assert.deepEqual(publicResult.conversation.conversation.memberUserIds, ["actor-a"]);
      assert.deepEqual(entityCalls.at(-1), {
        actor: actorA,
        entity: { type: "order", id: "order-42" },
        action: "conversation.create",
      });

      const privateResult = await command(
        channelInput("private", { visibility: "private" }),
      );
      assert.equal(privateResult.conversation.conversation.visibility, "private");
      assert.deepEqual(await countsForConversation(privateResult.conversation.conversation.id), {
        conversations: 1,
        members: 1,
        cursors: 1,
        preferences: 1,
        audit: 1,
        outbox: 1,
      });

      const persisted = (
        await harness.pool.query(
          `SELECT audit.metadata, audit.metadata::text AS audit_text,
                  event.protocol_version::integer AS protocol_version,
                  event.type, event.payload, outcome.state
             FROM ${tables.audit} AS audit
             JOIN ${tables.outbox} AS event
               ON event.tenant_id = audit.tenant_id AND event.stream_id = audit.target_id
             JOIN ${tables.idempotency} AS outcome
               ON outcome.tenant_id = audit.tenant_id
              AND outcome.client_key = $1
            WHERE audit.target_id = $2`,
          [publicRequest.idempotencyKey, publicResult.conversation.conversation.id],
        )
      ).rows[0];
      assert.deepEqual(persisted.metadata, {
        conversationType: "channel",
        visibility: "public",
        participantCount: 1,
        entityScoped: true,
      });
      assert.equal(persisted.audit_text.includes(publicRequest.name), false);
      assert.equal(persisted.audit_text.includes(publicRequest.idempotencyKey), false);
      assert.equal(persisted.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(persisted.type, "conversation.created");
      assert.equal(persisted.payload.conversation.id, publicResult.conversation.conversation.id);
      assert.equal(persisted.payload.clientRequestId, publicRequest.clientRequestId);
      assert.equal(persisted.state, "completed");
    });

    await t.test("creates direct and group-direct rows in canonical member order", async () => {
      const direct = await command(directInput("direct"));
      assert.equal(direct.type, "direct");
      assert.equal(direct.conversation.conversation.visibility, "private");
      assert.deepEqual(direct.participantIdentity.participantUserIds, ["actor-a", "user-b"]);
      assert.deepEqual(direct.conversation.conversation.memberUserIds, ["actor-a", "user-b"]);

      const groupRequest = groupInput("group", ["user-d", "user-b", "user-c"]);
      const group = await command(groupRequest);
      assert.equal(group.type, "group_direct");
      assert.deepEqual(group.participantIdentity.participantUserIds, [
        "actor-a",
        "user-b",
        "user-c",
        "user-d",
      ]);
      const defaults = await harness.pool.query(
        `SELECT member.user_id, member.role, member.state,
                cursor.last_read_sequence::integer AS last_read_sequence,
                preference.notification_level, preference.muted
           FROM ${tables.members} AS member
           JOIN ${tables.cursors} AS cursor USING (tenant_id, conversation_id, user_id)
           JOIN ${tables.preferences} AS preference USING (tenant_id, conversation_id, user_id)
          WHERE member.tenant_id = 'tenant-a' AND member.conversation_id = $1
          ORDER BY member.user_id`,
        [group.conversation.conversation.id],
      );
      assert.deepEqual(defaults.rows, [
        { user_id: "actor-a", role: "owner", state: "active", last_read_sequence: 0, notification_level: "all", muted: false },
        { user_id: "user-b", role: "member", state: "active", last_read_sequence: 0, notification_level: "all", muted: false },
        { user_id: "user-c", role: "member", state: "active", last_read_sequence: 0, notification_level: "all", muted: false },
        { user_id: "user-d", role: "member", state: "active", last_read_sequence: 0, notification_level: "all", muted: false },
      ]);

      const reordered = await command(
        groupInput("group-reordered", ["user-c", "user-d", "user-b"]),
      );
      assert.equal(reordered.reconciliationStatus, "existing_equivalent");
      assert.equal(reordered.conversation.conversation.id, group.conversation.conversation.id);
      assert.deepEqual(await countsForConversation(group.conversation.conversation.id), {
        conversations: 1,
        members: 4,
        cursors: 4,
        preferences: 4,
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("concurrent equivalent directs converge without duplicate events", async () => {
      const [left, right] = await Promise.all([
        command(directInput("concurrent-left", "user-c")),
        command(directInput("concurrent-right", "user-c")),
      ]);
      assert.equal(left.conversation.conversation.id, right.conversation.conversation.id);
      assert.deepEqual(
        [left.reconciliationStatus, right.reconciliationStatus].sort(),
        ["created", "existing_equivalent"],
      );
      assert.deepEqual(await countsForConversation(left.conversation.conversation.id), {
        conversations: 1,
        members: 2,
        cursors: 2,
        preferences: 2,
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("enforces capabilities, entity access, trusted identity, and directory coherence", async () => {
      capabilities = [];
      await assert.rejects(command(channelInput("capability-denied")), ChatAuthorizationError);
      capabilities = ["conversation.create"];

      entityAllowed = false;
      await assert.rejects(
        command(channelInput("entity-denied", { entity: { type: "order", id: "denied" } })),
        ChatAuthorizationError,
      );
      entityAllowed = true;

      await assert.rejects(
        command({ ...channelInput("spoof"), tenantId: "tenant-b" }),
        (error) => error instanceof ConversationCreationParseError && error.code === "trusted_identity_field",
      );
      await assert.rejects(
        command(directInput("missing", "missing-user")),
        (error) => error instanceof CreateConversationCommandError && error.code === "directory_user_unavailable",
      );

      directoryOverride = (request) => ({
        tenantId: "tenant-b",
        userId: request.userId,
        displayName: "Cross tenant",
      });
      await assert.rejects(
        command(directInput("cross-tenant", "user-b")),
        (error) => error instanceof CreateConversationCommandError && error.statusCode === 422,
      );
      directoryOverride = (request) => ({
        tenantId: request.actor.tenantId,
        userId: "different-user",
        displayName: "Incoherent",
      });
      await assert.rejects(command(directInput("incoherent", "user-b")), CreateConversationCommandError);
      directoryOverride = () => ({
        tenantId: "tenant-a",
        userId: "user-b",
        kind: "redacted",
      });
      await assert.rejects(command(directInput("redacted", "user-b")), CreateConversationCommandError);
      directoryOverride = () => ({
        tenantId: "tenant-a",
        userId: "user-b",
        kind: "unavailable",
        reason: "temporarily_unavailable",
      });
      await assert.rejects(command(directInput("unavailable", "user-b")), CreateConversationCommandError);
      directoryOverride = () => Promise.reject(new Error("directory adapter failed"));
      await assert.rejects(command(directInput("directory-failure", "user-b")), CreateConversationCommandError);
      directoryOverride = undefined;

      const tenantBActor = { tenantId: "tenant-b", userId: "actor-b", roles: ["employee"] };
      const tenantB = await command(directInput("tenant-isolation", "user-b"), {
        actor: tenantBActor,
      });
      assert.equal(tenantB.conversation.conversation.tenantId, "tenant-b");
      const tenantACount = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.conversations}
          WHERE tenant_id = 'tenant-a' AND id = $1`,
        [tenantB.conversation.conversation.id],
      );
      assert.equal(tenantACount.rows[0].count, 0);
    });

    await t.test("replays exact outcomes and rejects conflicting key reuse", async () => {
      const request = channelInput("idempotent");
      const first = await command(request);
      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.equal(replay.conversation.conversation.id, first.conversation.conversation.id);
      assert.deepEqual(await countsForConversation(first.conversation.conversation.id), {
        conversations: 1,
        members: 1,
        cursors: 1,
        preferences: 1,
        audit: 1,
        outbox: 1,
      });
      await assert.rejects(
        command({ ...request, name: "Different canonical request" }),
        (error) =>
          error instanceof CreateConversationCommandError &&
          error.code === "idempotency_conflict" &&
          error.statusCode === 409,
      );
    });

    await t.test("audit and outbox failures each roll back the complete boundary", async () => {
      await harness.pool.query(
        `CREATE FUNCTION ${schema}.reject_selected_creation_event()
           RETURNS trigger LANGUAGE plpgsql AS $function$
           BEGIN
             IF NEW.event_id IN ('fail-audit', 'fail-outbox') THEN
               RAISE EXCEPTION 'injected late-write failure';
             END IF;
             RETURN NEW;
           END;
           $function$`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_selected_creation_audit
           BEFORE INSERT ON ${tables.audit}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_selected_creation_event()`,
      );
      await harness.pool.query(
        `CREATE TRIGGER reject_selected_creation_outbox
           BEFORE INSERT ON ${tables.outbox}
           FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_selected_creation_event()`,
      );

      const auditIds = ["rollback-audit-conversation", "fail-audit"];
      const auditRequest = channelInput("rollback-audit");
      await assert.rejects(
        command(auditRequest, { createId: () => auditIds.shift() }),
        /injected late-write failure/,
      );
      assert.deepEqual(await countsForConversation("rollback-audit-conversation"), {
        conversations: 0,
        members: 0,
        cursors: 0,
        preferences: 0,
        audit: 0,
        outbox: 0,
      });

      const outboxIds = ["rollback-outbox-conversation", "audit-before-outbox", "fail-outbox"];
      const outboxRequest = channelInput("rollback-outbox");
      await assert.rejects(
        command(outboxRequest, { createId: () => outboxIds.shift() }),
        /injected late-write failure/,
      );
      assert.deepEqual(await countsForConversation("rollback-outbox-conversation"), {
        conversations: 0,
        members: 0,
        cursors: 0,
        preferences: 0,
        audit: 0,
        outbox: 0,
      });
      const outcomes = await harness.pool.query(
        `SELECT count(*)::integer AS count FROM ${tables.idempotency}
          WHERE tenant_id = 'tenant-a' AND client_key = ANY($1::text[])`,
        [[auditRequest.idempotencyKey, outboxRequest.idempotencyKey]],
      );
      assert.equal(outcomes.rows[0].count, 0);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
