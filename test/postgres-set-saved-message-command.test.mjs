import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_PROTOCOL_VERSION,
  MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES,
  SavedMessageMutationParseError,
} from "@handrail/chat";
import {
  ChatAuthorizationError,
  SET_SAVED_MESSAGE_AUDIT_ACTION,
  SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION,
  SET_SAVED_MESSAGE_IDEMPOTENCY_OPERATION,
  SET_SAVED_MESSAGE_OUTBOX_EVENT_TYPE,
  SetSavedMessageCommandError,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  setSavedMessage,
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
  operation: "set_saved_message",
  intent: "save",
  messageId: "message-public",
  expectedSavedMessageRevision: 0,
  idempotencyKey: `saved-message-${suffix}`,
  ...overrides,
});

const sanitizedAuthorizationFailure = (error) =>
  error instanceof ChatAuthorizationError &&
  error.code === "CHAT_AUTHORIZATION_FAILED" &&
  error.statusCode === 403 &&
  error.message === "Chat authorization failed";

test("set-saved-message is trusted, visibility-gated, actor-private, idempotent, and atomic", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_set_saved_message",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    saved: `${schema}.chat_saved_messages`,
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
    setSavedMessage({
      database: harness.pool,
      schema: harness.schema,
      actor,
      input: request,
      permissions,
      createId: () => `saved-message-command-${++nextId}`,
      ...overrides,
    });

  const seedMessage = async ({
    tenantId = "tenant-a",
    conversationId,
    messageId,
    visibility = "public",
    memberState,
    entity,
    archived = false,
    deleted = false,
    contentText = `Secret content for ${messageId}`,
  }) => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id,
         current_message_sequence, archived_at, archived_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, 'channel', $3, $2, $4, $5, 1, $6, $7, $8, $8)`,
      [
        tenantId,
        conversationId,
        visibility,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? "2026-01-02T00:00:00.000Z" : null,
        archived ? "archiver-a" : null,
        createdAt,
      ],
    );
    if (memberState !== undefined) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
         VALUES ($1, $2, $3, 'member', $4, $5, $5)`,
        [tenantId, conversationId, actor.userId, memberState, createdAt],
      );
    }
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, created_at, updated_at,
         deleted_at, deleted_by_user_id
       ) VALUES ($1, $2, $3, 1, 'author-a', $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        messageId,
        conversationId,
        `client-${tenantId}-${messageId}`,
        deleted ? null : { format: "plain", text: contentText },
        createdAt,
        deleted ? "2026-01-02T00:00:00.000Z" : createdAt,
        deleted ? "2026-01-02T00:00:00.000Z" : null,
        deleted ? "deleter-a" : null,
      ],
    );
  };

  const effectCounts = async (messageId) =>
    (
      await harness.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM ${tables.saved}
             WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
               AND message_id = $1) AS saved,
           (SELECT count(*)::integer FROM ${tables.audit}
             WHERE tenant_id = 'tenant-a' AND target_id = $1
               AND action = $2) AS audit,
           (SELECT count(*)::integer FROM ${tables.outbox}
             WHERE tenant_id = 'tenant-a'
               AND payload->>'messageId' = $1
               AND type = $3) AS outbox,
           (SELECT count(*)::integer FROM ${tables.idempotency}
             WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
               AND operation_name = $4
               AND response_body->>'messageId' = $1) AS idempotency`,
        [
          messageId,
          SET_SAVED_MESSAGE_AUDIT_ACTION,
          SET_SAVED_MESSAGE_OUTBOX_EVENT_TYPE,
          SET_SAVED_MESSAGE_IDEMPOTENCY_OPERATION,
        ],
      )
    ).rows[0];

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await seedMessage({
      conversationId: "conversation-public",
      messageId: "message-public",
      contentText: "TOP SECRET MESSAGE BODY",
    });

    await t.test("saves with a private note, replays exactly, and emits only actor-private metadata", async () => {
      const request = input("save", {
        privateNote: "Call the customer tomorrow",
      });
      const saved = await command(request);
      assert.deepEqual(saved, {
        operation: "set_saved_message",
        intent: "save",
        reconciliationStatus: "applied",
        messageId: "message-public",
        expectedSavedMessageRevision: 0,
        idempotencyKey: "saved-message-save",
        savedMessageRevision: 1,
        savedMessage: {
          messageId: "message-public",
          isSaved: true,
          privateNote: "Call the customer tomorrow",
        },
      });

      const replay = await command(request);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.savedMessage, saved.savedMessage);
      assert.deepEqual(await effectCounts("message-public"), {
        saved: 1,
        audit: 1,
        outbox: 1,
        idempotency: 1,
      });

      const { privateNote: _privateNote, ...requestWithoutNote } = request;
      for (const mismatch of [
        { ...requestWithoutNote, intent: "unsave" },
        { ...request, expectedSavedMessageRevision: 1 },
        { ...request, privateNote: "Different private note" },
      ]) {
        await assert.rejects(
          command(mismatch),
          (error) =>
            error instanceof SetSavedMessageCommandError &&
            error.code === "idempotency_conflict" &&
            error.statusCode === 409,
        );
      }

      const row = (
        await harness.pool.query(
          `SELECT message_id, conversation_id, is_saved, private_note,
                  saved_message_revision::integer AS saved_message_revision,
                  to_jsonb(saved) AS durable
             FROM ${tables.saved} AS saved
            WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
              AND message_id = 'message-public'`,
        )
      ).rows[0];
      assert.deepEqual(
        {
          message_id: row.message_id,
          conversation_id: row.conversation_id,
          is_saved: row.is_saved,
          private_note: row.private_note,
          saved_message_revision: row.saved_message_revision,
        },
        {
          message_id: "message-public",
          conversation_id: "conversation-public",
          is_saved: true,
          private_note: "Call the customer tomorrow",
          saved_message_revision: 1,
        },
      );
      assert.doesNotMatch(JSON.stringify(row.durable), /TOP SECRET MESSAGE BODY/);

      const audit = (
        await harness.pool.query(
          `SELECT metadata FROM ${tables.audit}
            WHERE tenant_id = 'tenant-a' AND target_id = 'message-public'`,
        )
      ).rows[0].metadata;
      assert.deepEqual(audit, {
        messageId: "message-public",
        conversationId: "conversation-public",
        intent: "save",
        previousSaved: null,
        currentSaved: true,
        privateNoteChanged: true,
        previousSavedMessageRevision: 0,
        currentSavedMessageRevision: 1,
      });
      assert.doesNotMatch(
        JSON.stringify(audit),
        /Call the customer tomorrow|TOP SECRET MESSAGE BODY|privateNote\s*:/,
      );

      const outbox = (
        await harness.pool.query(
          `SELECT protocol_version::integer AS protocol_version, stream_id, type, payload
             FROM ${tables.outbox}
            WHERE tenant_id = 'tenant-a'
              AND payload->>'messageId' = 'message-public'`,
        )
      ).rows[0];
      assert.equal(outbox.protocol_version, CHAT_PROTOCOL_VERSION);
      assert.equal(outbox.stream_id, "user:actor-a");
      assert.equal(outbox.type, SET_SAVED_MESSAGE_OUTBOX_EVENT_TYPE);
      assert.equal(
        outbox.payload.savedMessage.privateNote,
        "Call the customer tomorrow",
      );
      assert.equal("conversationId" in outbox.payload, false);
      assert.doesNotMatch(JSON.stringify(outbox.payload), /TOP SECRET MESSAGE BODY/);
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count FROM ${tables.outbox}
              WHERE tenant_id = 'tenant-a'
                AND stream_id = 'conversation-public'`,
          )
        ).rows[0].count,
        0,
      );
    });

    await t.test("reconciles repeated desired state, revision conflicts, and explicit unsave without duplicate effects", async () => {
      const already = await command(
        input("already", {
          expectedSavedMessageRevision: 1,
          privateNote: "Call the customer tomorrow",
        }),
      );
      assert.equal(already.reconciliationStatus, "already_requested_state");
      assert.equal(already.savedMessageRevision, 1);

      const conflict = await command(
        input("conflict", {
          intent: "unsave",
          expectedSavedMessageRevision: 0,
        }),
      );
      assert.equal(conflict.reconciliationStatus, "saved_message_revision_conflict");
      assert.equal(conflict.savedMessageRevision, 1);
      assert.deepEqual(conflict.savedMessage, {
        messageId: "message-public",
        isSaved: true,
        privateNote: "Call the customer tomorrow",
      });
      assert.deepEqual(await effectCounts("message-public"), {
        saved: 1,
        audit: 1,
        outbox: 1,
        idempotency: 3,
      });

      const unsaved = await command(
        input("unsave", {
          intent: "unsave",
          expectedSavedMessageRevision: 1,
        }),
      );
      assert.equal(unsaved.reconciliationStatus, "applied");
      assert.equal(unsaved.savedMessageRevision, 2);
      assert.deepEqual(unsaved.savedMessage, {
        messageId: "message-public",
        isSaved: false,
      });
      const repeatedUnsave = await command(
        input("unsave-already", {
          intent: "unsave",
          expectedSavedMessageRevision: 2,
        }),
      );
      assert.equal(
        repeatedUnsave.reconciliationStatus,
        "already_requested_state",
      );
      assert.deepEqual(
        (
          await harness.pool.query(
            `SELECT is_saved, private_note,
                    saved_message_revision::integer AS saved_message_revision
               FROM ${tables.saved}
              WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
                AND message_id = 'message-public'`,
          )
        ).rows[0],
        { is_saved: false, private_note: null, saved_message_revision: 2 },
      );
      assert.deepEqual(await effectCounts("message-public"), {
        saved: 1,
        audit: 2,
        outbox: 2,
        idempotency: 5,
      });
    });

    await t.test("uses public/private membership, deletion, archive, host-entity, and tenant boundaries without existence leaks", async () => {
      await seedMessage({
        conversationId: "conversation-private-member",
        messageId: "message-private-member",
        visibility: "private",
        memberState: "active",
      });
      const privateMemberRequest = input("private-member", {
        messageId: "message-private-member",
      });
      assert.equal(
        (await command(privateMemberRequest)).reconciliationStatus,
        "applied",
      );
      await harness.pool.query(
        `UPDATE ${tables.members}
            SET state = 'left', updated_at = clock_timestamp()
          WHERE tenant_id = 'tenant-a'
            AND conversation_id = 'conversation-private-member'
            AND user_id = 'actor-a'`,
      );
      await assert.rejects(
        command(privateMemberRequest),
        sanitizedAuthorizationFailure,
      );
      assert.deepEqual(await effectCounts("message-private-member"), {
        saved: 1,
        audit: 1,
        outbox: 1,
        idempotency: 1,
      });

      const deniedFixtures = [
        {
          conversationId: "conversation-private-missing",
          messageId: "message-private-missing",
          visibility: "private",
        },
        {
          conversationId: "conversation-private-left",
          messageId: "message-private-left",
          visibility: "private",
          memberState: "left",
        },
        {
          conversationId: "conversation-deleted",
          messageId: "message-deleted",
          deleted: true,
        },
        {
          conversationId: "conversation-archived",
          messageId: "message-archived",
          archived: true,
        },
        {
          tenantId: "tenant-b",
          conversationId: "conversation-cross-tenant",
          messageId: "message-cross-tenant",
        },
      ];
      for (const fixture of deniedFixtures) await seedMessage(fixture);

      for (const messageId of [
        "message-private-missing",
        "message-private-left",
        "message-deleted",
        "message-archived",
        "message-cross-tenant",
        "message-missing",
      ]) {
        await assert.rejects(
          command(input(`denied-${messageId}`, { messageId })),
          sanitizedAuthorizationFailure,
        );
      }

      await seedMessage({
        conversationId: "conversation-entity",
        messageId: "message-entity",
        entity: { type: "case", id: "case-7" },
      });
      entityMode = "deny";
      await assert.rejects(
        command(input("entity-denied", { messageId: "message-entity" })),
        sanitizedAuthorizationFailure,
      );
      entityMode = "error";
      await assert.rejects(
        command(input("entity-error", { messageId: "message-entity" })),
        sanitizedAuthorizationFailure,
      );
      entityMode = "allow";
      assert.equal(
        (
          await command(
            input("entity-allowed", { messageId: "message-entity" }),
          )
        ).reconciliationStatus,
        "applied",
      );
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "case", id: "case-7" },
        action: SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION,
      });

      for (const messageId of [
        "message-private-missing",
        "message-private-left",
        "message-deleted",
        "message-archived",
        "message-cross-tenant",
        "message-missing",
      ]) {
        assert.deepEqual(await effectCounts(messageId), {
          saved: 0,
          audit: 0,
          outbox: 0,
          idempotency: 0,
        });
      }
    });

    await t.test("validates private notes before persistence", async () => {
      for (const privateNote of [
        "",
        "   ",
        "unsafe\u0000note",
        "x".repeat(MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES + 1),
      ]) {
        await assert.rejects(
          command(input(`invalid-note-${privateNote.length}`, { privateNote })),
          (error) =>
            error instanceof SavedMessageMutationParseError &&
            error.code === "malformed_private_note",
        );
      }
      await assert.rejects(
        command(
          input("note-on-unsave", {
            intent: "unsave",
            privateNote: "not allowed",
          }),
        ),
        (error) =>
          error instanceof SavedMessageMutationParseError &&
          error.code === "malformed_private_note",
      );
    });

    await t.test("rolls back saved state, idempotency, audit, and outbox after a late transactional failure", async () => {
      await seedMessage({
        conversationId: "conversation-rollback",
        messageId: "message-rollback",
      });
      await harness.pool.query(
        `INSERT INTO ${tables.outbox} (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           'existing-outbox', $1, 'tenant-a', 'user:actor-a', 'fixture',
           '2026-01-01T00:00:00.000Z', '{}', '2026-01-02T00:00:00.000Z'
         )`,
        [CHAT_PROTOCOL_VERSION],
      );
      const ids = ["rollback-audit", "existing-outbox"];
      await assert.rejects(
        command(input("rollback", { messageId: "message-rollback" }), {
          createId: () => ids.shift(),
        }),
        /chat_outbox_events_event_id_key/,
      );
      assert.deepEqual(await effectCounts("message-rollback"), {
        saved: 0,
        audit: 0,
        outbox: 0,
        idempotency: 0,
      });
      assert.equal(
        (
          await harness.pool.query(
            `SELECT count(*)::integer AS count FROM ${tables.audit}
              WHERE event_id = 'rollback-audit'`,
          )
        ).rows[0].count,
        0,
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
