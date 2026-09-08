import assert from "node:assert/strict";
import test from "node:test";

import {
  AttachmentTransportError,
  MAX_ATTACHMENT_SIZE_BYTES,
} from "../src/contracts/attachment-transport.ts";
import {
  PREPARE_ATTACHMENT_CAPABILITY,
  PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION,
  PrepareAttachmentCommandError,
  prepareAttachment,
} from "../src/server/prepare-attachment-command.ts";
import { ChatAuthorizationError } from "../src/server/request-context.ts";
import { createPostgresMigrationRunner } from "../src/server/postgres-migrations.ts";
import { handrailChatPostgresMigrations } from "../src/server/postgres-schema-migrations.ts";
import { sendMessage } from "../src/server/send-message-command.ts";
import { createPostgresTestBackend } from "../src/testing/index.ts";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["trusted-host-role"]),
});

const validInput = (suffix, overrides = {}) => ({
  operation: "prepare_attachment",
  metadata: {
    fileName: "Quarterly report.pdf",
    contentType: "application/pdf",
    sizeBytes: 42_000,
    ...overrides,
  },
  idempotencyKey: `prepare-${suffix}`,
});

const decodeUpload = (descriptor) =>
  JSON.parse(Buffer.from(descriptor, "base64url").toString("utf8"));

const unavailableDatabase = {
  async connect() {
    throw new Error("database must not be called");
  },
  async query() {
    throw new Error("database must not be called");
  },
};

const unavailablePermissions = {
  async getCapabilities() {
    throw new Error("permissions must not be called");
  },
  async authorizeEntity() {
    throw new Error("permissions must not be called");
  },
};

test("prepare-attachment rejects invalid metadata before providers and reports disabled storage stably", async () => {
  let storageCalls = 0;
  const storage = {
    async createUploadUrl() {
      storageCalls += 1;
      throw new Error("storage must not be called");
    },
  };
  const base = {
    database: unavailableDatabase,
    permissions: unavailablePermissions,
    storage,
    actor,
    conversationId: "conversation-a",
    attachmentsEnabled: true,
  };

  for (const [metadata, code] of [
    [{ fileName: "../unsafe.pdf" }, "unsafe_filename"],
    [{ contentType: "application/octet-stream" }, "unsupported_content_type"],
    [{ sizeBytes: -1 }, "malformed_input"],
    [{ sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1 }, "oversized_attachment"],
  ]) {
    await assert.rejects(
      prepareAttachment({
        ...base,
        input: validInput(code, metadata),
      }),
      (error) => error instanceof AttachmentTransportError && error.code === code,
    );
  }
  assert.equal(storageCalls, 0);

  for (const options of [
    { attachmentsEnabled: false, storage },
    { attachmentsEnabled: true, storage: undefined },
  ]) {
    await assert.rejects(
      prepareAttachment({
        ...base,
        ...options,
        input: validInput("disabled"),
      }),
      (error) =>
        error instanceof PrepareAttachmentCommandError &&
        error.code === "feature_disabled" &&
        error.statusCode === 503 &&
        error.message === "Attachment storage is not enabled",
    );
  }
  assert.equal(storageCalls, 0);
});

class FakeStorageAdapter {
  constructor(now) {
    this.now = now;
    this.calls = [];
    this.sequence = 0;
    this.failure = null;
  }

  async createUploadUrl(request) {
    this.calls.push(request);
    if (this.failure === "throw") {
      throw new Error("provider-secret-from-thrown-diagnostics");
    }
    const sequence = ++this.sequence;
    const response = {
      objectKey: `attachments/${request.actor.tenantId}/${request.attachmentId}`,
      method: "PUT",
      url: `https://storage.test.invalid/upload/${request.attachmentId}?signature=secret-${sequence}`,
      expiresAt: new Date(this.now.valueOf() + 5 * 60_000).toISOString(),
      headers: {
        authorization: `Bearer secret-header-${sequence}`,
        "content-type": request.contentType,
      },
    };
    if (this.failure === "extra-field") {
      return { ...response, providerSecret: "must-be-rejected" };
    }
    return response;
  }
}

test("trusted prepare-attachment reserves and replays without persisting upload credentials", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({
    schemaPrefix: "chat_prepare_attachment",
  });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    attachments: `${schema}.chat_attachments`,
    idempotency: `${schema}.chat_idempotency_keys`,
  };
  const now = new Date();
  const storage = new FakeStorageAdapter(now);
  let capabilities = [PREPARE_ATTACHMENT_CAPABILITY];
  let entityAllowed = true;
  const entityCalls = [];
  const permissions = {
    async getCapabilities(request) {
      assert.deepEqual(request, { actor });
      return capabilities;
    },
    async authorizeEntity(request) {
      entityCalls.push(request);
      return entityAllowed;
    },
  };
  let idSequence = 0;
  const command = (conversationId, input, overrides = {}) =>
    prepareAttachment({
      database: harness.pool,
      schema: harness.schema,
      permissions,
      storage,
      actor,
      conversationId,
      input,
      attachmentsEnabled: true,
      createId: () => `attachment-${++idSequence}`,
      now: () => new Date(now),
      ...overrides,
    });

  const seedConversation = async ({
    tenantId = "tenant-a",
    conversationId,
    userId = "actor-a",
    memberState = "active",
    archived = false,
    entity = null,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${tables.conversations} (
         tenant_id, id, type, visibility, name, entity_type, entity_id,
         archived_at, archived_by_user_id
       ) VALUES ($1, $2, 'channel', 'private', $2, $3, $4, $5, $6)`,
      [
        tenantId,
        conversationId,
        entity?.type ?? null,
        entity?.id ?? null,
        archived ? new Date() : null,
        archived ? "archiver" : null,
      ],
    );
    if (userId !== null) {
      await harness.pool.query(
        `INSERT INTO ${tables.members}
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, $3, 'member', $4)`,
        [tenantId, conversationId, userId, memberState],
      );
    }
  };

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    await seedConversation({
      conversationId: "entity-active",
      entity: { type: "invoice", id: "invoice-42" },
    });
    await seedConversation({ conversationId: "other-active" });
    await seedConversation({ conversationId: "archived", archived: true });
    await seedConversation({
      conversationId: "inactive-member",
      memberState: "removed",
    });
    await seedConversation({
      conversationId: "entity-denied",
      entity: { type: "invoice", id: "invoice-denied" },
    });
    await seedConversation({
      tenantId: "tenant-b",
      conversationId: "tenant-b-active",
      userId: "actor-b",
    });

    const request = validInput("success");
    const applied = await command("entity-active", request);
    assert.equal(applied.reconciliationStatus, "applied");
    assert.equal(applied.attachment.status, "pending");
    assert.equal(applied.attachment.attachmentId, "attachment-1");
    assert.deepEqual(applied.attachment.metadata, request.metadata);
    assert.ok(
      Date.parse(applied.attachment.expiresAt) >
        Date.parse(applied.attachment.createdAt),
    );
    assert.deepEqual(entityCalls, [
      {
        actor,
        entity: { type: "invoice", id: "invoice-42" },
        action: PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION,
      },
    ]);
    assert.deepEqual(storage.calls[0], {
      actor,
      attachmentId: "attachment-1",
      fileName: request.metadata.fileName,
      contentType: request.metadata.contentType,
      contentLengthBytes: request.metadata.sizeBytes,
    });
    assert.deepEqual(decodeUpload(applied.upload.descriptor), {
      url: "https://storage.test.invalid/upload/attachment-1?signature=secret-1",
      method: "PUT",
      headers: {
        authorization: "Bearer secret-header-1",
        "content-type": "application/pdf",
      },
    });

    const stored = (
      await harness.pool.query(
        `SELECT attachment.*, idempotency.response_body,
                idempotency.response_reference,
                idempotency.request_hash,
                idempotency.state AS idempotency_state
           FROM ${tables.attachments} AS attachment
           INNER JOIN ${tables.idempotency} AS idempotency
             ON idempotency.tenant_id = attachment.tenant_id
            AND idempotency.response_reference = attachment.id
          WHERE attachment.tenant_id = 'tenant-a'
            AND attachment.id = 'attachment-1'`,
      )
    ).rows[0];
    assert.equal(stored.uploader_user_id, "actor-a");
    assert.equal(stored.storage_key, "attachments/tenant-a/attachment-1");
    assert.equal(stored.file_name, request.metadata.fileName);
    assert.equal(stored.content_type, request.metadata.contentType);
    assert.equal(Number(stored.size_bytes), request.metadata.sizeBytes);
    assert.equal(stored.state, "pending");
    assert.equal(stored.response_body, null);
    assert.equal(stored.response_reference, "attachment-1");
    assert.equal(stored.idempotency_state, "completed");
    assert.match(stored.request_hash, /^sha256:[0-9a-f]{64}$/);
    const persisted = JSON.stringify(stored);
    for (const secret of [
      "secret-1",
      "secret-header-1",
      "signature",
      "authorization",
      "storage.test.invalid",
    ]) {
      assert.equal(persisted.includes(secret), false);
    }

    const replayed = await command("entity-active", request);
    assert.equal(replayed.reconciliationStatus, "replayed");
    assert.deepEqual(replayed.attachment, applied.attachment);
    assert.equal(storage.calls.length, 2);
    assert.equal(
      decodeUpload(replayed.upload.descriptor).url,
      "https://storage.test.invalid/upload/attachment-1?signature=secret-2",
    );
    assert.deepEqual(storage.calls[1], storage.calls[0]);

    await assert.rejects(
      command("entity-active", validInput("success", { sizeBytes: 42_001 })),
      (error) =>
        error instanceof PrepareAttachmentCommandError &&
        error.code === "idempotency_conflict",
    );
    await assert.rejects(
      command("other-active", request),
      (error) =>
        error instanceof PrepareAttachmentCommandError &&
        error.code === "idempotency_conflict",
    );
    assert.equal(storage.calls.length, 2);

    const tenantBActor = Object.freeze({
      tenantId: "tenant-b",
      userId: "actor-b",
      roles: Object.freeze(["trusted-host-role"]),
    });
    const tenantBStorage = new FakeStorageAdapter(now);
    const tenantBResult = await command("tenant-b-active", request, {
      actor: tenantBActor,
      storage: tenantBStorage,
      permissions: {
        async getCapabilities({ actor: trustedActor }) {
          assert.equal(trustedActor, tenantBActor);
          return [PREPARE_ATTACHMENT_CAPABILITY];
        },
        async authorizeEntity() {
          throw new Error("unscoped conversation must not authorize an entity");
        },
      },
    });
    assert.equal(tenantBResult.attachment.attachmentId, "attachment-2");
    const tenantBStored = (
      await harness.pool.query(
        `SELECT tenant_id, uploader_user_id
           FROM ${tables.attachments}
          WHERE tenant_id = 'tenant-b' AND id = 'attachment-2'`,
      )
    ).rows[0];
    assert.deepEqual(tenantBStored, {
      tenant_id: "tenant-b",
      uploader_user_id: "actor-b",
    });

    const storageCallsBeforeDenials = storage.calls.length;
    for (const conversationId of ["archived", "inactive-member"]) {
      await assert.rejects(
        command(conversationId, validInput(conversationId)),
        (error) => error instanceof ChatAuthorizationError,
      );
    }
    entityAllowed = false;
    await assert.rejects(
      command("entity-denied", validInput("entity-denied")),
      (error) => error instanceof ChatAuthorizationError,
    );
    entityAllowed = true;
    capabilities = [];
    await assert.rejects(
      command("other-active", validInput("missing-capability")),
      (error) => error instanceof ChatAuthorizationError,
    );
    capabilities = [PREPARE_ATTACHMENT_CAPABILITY];
    assert.equal(storage.calls.length, storageCallsBeforeDenials);

    for (const failure of ["throw", "extra-field"]) {
      storage.failure = failure;
      const failureInput = validInput(`adapter-${failure}`);
      const expectedAttachmentId = `attachment-${idSequence + 1}`;
      await assert.rejects(
        command("other-active", failureInput),
        (error) =>
          error instanceof PrepareAttachmentCommandError &&
          error.code === "storage_unavailable" &&
          !error.message.includes("secret"),
      );
      const leftovers = (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${tables.attachments}
               WHERE tenant_id = 'tenant-a' AND id = $1) AS attachments,
             (SELECT count(*)::integer FROM ${tables.idempotency}
               WHERE tenant_id = 'tenant-a' AND user_id = 'actor-a'
                 AND operation_name = 'attachment.prepare'
                 AND client_key = $2) AS idempotency`,
          [expectedAttachmentId, failureInput.idempotencyKey],
        )
      ).rows[0];
      assert.deepEqual(leftovers, { attachments: 0, idempotency: 0 });
    }
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});


test("thread attachment preparation checks current authority and retains participation", { timeout: 60_000 }, async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await backend.createHarness({ schemaPrefix: "chat_prepare_thread" });
    const prefix = quoteIdentifier(harness.schema);
    const sql = (query, values) => harness.pool.query(query, values);
    await createPostgresMigrationRunner({ database: harness.pool, schema: harness.schema,
      migrations: handrailChatPostgresMigrations }).apply();
    t.diagnostic(`Real PostgreSQL ${backend.kind}; canonical migrations and source bundle`);
    const storage = new FakeStorageAdapter(new Date());
    const permissions = {
      async getCapabilities() { return ["attachment.prepare", "message.send"]; },
      async authorizeEntity() { return true; },
    };
    const command = (id, request = validInput(id), overrides = {}) => prepareAttachment({
      database: harness.pool, schema: harness.schema, actor, permissions, storage,
      conversationId: id, input: request, attachmentsEnabled: true, ...overrides,
    });
    const seed = async (id, { closed = false, locked = false, publicParent = false } = {}) => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, name, entity_type, entity_id)
        VALUES ('tenant-a', $1, 'channel', $2, $1, 'case', 'case-id')`,
      [`${id}-parent`, publicParent ? "public" : "private"]);
      if (!publicParent) await sql(`INSERT INTO ${prefix}.chat_conversation_members
        (tenant_id, conversation_id, user_id, role, state)
        VALUES ('tenant-a', $1, 'actor-a', 'member', 'active')`, [`${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant-a', $1, $2, 1, 'author', $1, '{"format":"plain","text":"Root"}')`,
      [`${id}-root`, `${id}-parent`]);
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id,
         closed_at, closed_by_user_id, locked)
        VALUES ('tenant-a', $1, 'thread', $2, $3, $4, $5, $6, $7)`,
      [id, publicParent ? "public" : "private", `${id}-parent`, `${id}-root`,
        closed ? "2025-01-01T00:00:00Z" : null, closed ? "closer" : null, locked]);
    };
    const rows = async (table, id) => (await sql(`SELECT * FROM ${prefix}.${table}
      WHERE conversation_id = $1 ORDER BY user_id`, [id])).rows;
    const privateState = async (id) => {
      const state = {};
      for (const table of ["chat_read_cursors", "chat_conversation_preferences", "chat_drafts", "chat_thread_follows"]) {
        state[table] = await rows(table, id);
      }
      return state;
    };
    const effects = async () => {
      const state = {};
      for (const table of ["chat_conversations", "chat_conversation_members", "chat_messages", "chat_attachments",
        "chat_read_cursors", "chat_conversation_preferences", "chat_drafts", "chat_thread_follows",
        "chat_idempotency_keys", "chat_outbox_events", "chat_audit_events"]) {
        state[table] = (await sql(`SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text), '[]') AS rows
          FROM ${prefix}.${table} row`)).rows[0].rows;
      }
      return state;
    };
    const denied = (error) => error instanceof ChatAuthorizationError;
    const assertDenied = async (id, request = validInput(id), overrides = {}) => {
      const before = await effects();
      const calls = storage.calls.length;
      await assert.rejects(command(id, request, overrides), denied);
      assert.equal(storage.calls.length, calls, "denial precedes storage");
      assert.deepEqual(await effects(), before, "denial leaves no durable setup");
    };

    await t.test("first private/public parent reader can prepare without child membership", async () => {
      for (const publicParent of [false, true]) {
        const id = publicParent ? "first-public" : "first-private";
        await seed(id, { publicParent });
        assert.deepEqual(await rows("chat_conversation_members", id), []);
        const result = await command(id);
        assert.equal(result.reconciliationStatus, "applied");
        const member = (await rows("chat_conversation_members", id))[0];
        assert.equal(member.state, "active");
        assert.equal(member.role, "member");
        const retained = await privateState(id);
        assert.equal(retained.chat_read_cursors[0].last_read_sequence, "0");
        assert.equal(retained.chat_conversation_preferences[0].notification_level, "all");
        assert.deepEqual(retained.chat_drafts, []);
        assert.deepEqual(retained.chat_thread_follows, []);
      }
    });

    await t.test("closed/unlocked preparation and concurrent replay leave lifecycle and activity unchanged", async () => {
      const id = "closed";
      await seed(id, { closed: true });
      // Preparation does not need a remaining reopen revision; only send does.
      await sql(`UPDATE ${prefix}.chat_conversations SET lifecycle_revision = 9007199254740991 WHERE id = $1`, [id]);
      const before = await effects();
      const results = await Promise.all([command(id), command(id), command(id)]);
      assert.equal(results.filter((result) => result.reconciliationStatus === "applied").length, 1);
      assert.equal(results.filter((result) => result.reconciliationStatus === "replayed").length, 2);
      for (const result of results) assert.deepEqual(result.attachment, results[0].attachment);
      const after = await effects();
      for (const table of ["chat_conversations", "chat_messages", "chat_outbox_events", "chat_audit_events"]) {
        assert.deepEqual(after[table], before[table]);
      }
      assert.equal(after.chat_attachments.length, before.chat_attachments.length + 1);
      assert.equal(after.chat_idempotency_keys.length, before.chat_idempotency_keys.length + 1);
      await command(id);
      assert.deepEqual(await effects(), after);
    });

    await t.test("reactivation, repeat and replay preserve roles, join times, cursors, preferences, drafts and unfollow", async () => {
      const id = "retained";
      await seed(id);
      await sql(`INSERT INTO ${prefix}.chat_conversation_members
        (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
        VALUES ('tenant-a', $1, 'actor-a', 'moderator', 'removed', '2025-01-01Z', '2025-01-02Z')`, [id]);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
        VALUES ('tenant-a', $1, 'actor-a', 7, 3)`, [id]);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id, conversation_id, user_id, notification_level, muted)
        VALUES ('tenant-a', $1, 'actor-a', 'mentions', true)`, [id]);
      await sql(`INSERT INTO ${prefix}.chat_drafts (tenant_id, conversation_id, user_id, content, revision)
        VALUES ('tenant-a', $1, 'actor-a', '{"format":"plain","text":"Keep draft"}', 9)`, [id]);
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
        VALUES ('tenant-a', $1, 'actor-a', false, 'manual', 7)`, [id]);
      const before = await privateState(id);
      const original = (await rows("chat_conversation_members", id))[0];
      const accepted = await command(id);
      const active = (await rows("chat_conversation_members", id))[0];
      assert.deepEqual(active, { ...original, state: "active", updated_at: active.updated_at });
      assert.notDeepEqual(active.updated_at, original.updated_at);
      assert.deepEqual(await privateState(id), before);
      await command(id, validInput("retained-repeat"));
      const replay = await command(id);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.attachment, accepted.attachment);
      assert.deepEqual(await rows("chat_conversation_members", id), [active]);
      assert.deepEqual(await privateState(id), before);
      await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed' WHERE conversation_id = $1`, [id]);
      assert.equal((await command(id)).reconciliationStatus, "replayed");
      const reactivated = (await rows("chat_conversation_members", id))[0];
      assert.deepEqual(reactivated, { ...active, updated_at: reactivated.updated_at });
      assert.deepEqual(await privateState(id), before);
    });

    for (const replay of [false, true]) {
      await t.test(`${replay ? "replayed" : "new"} preparation denies lifecycle and revoked parent/host authority before storage or setup`, async () => {
        for (const reason of ["locked", "archived", "parent-archived", "parent-member", "send-entity", "prepare-entity",
          "send-capability", "prepare-capability", "host-denied", "host-throws"]) {
          const id = `${replay ? "replay" : "new"}-${reason}`;
          await seed(id);
          if (replay) await command(id); // Retained active child membership must not grant authority.
          let restricted = permissions;
          if (reason === "locked") await sql(`UPDATE ${prefix}.chat_conversations SET locked = true, closed_at = COALESCE(closed_at, clock_timestamp()),
            closed_by_user_id = COALESCE(closed_by_user_id, 'locker') WHERE id = $1`, [id]);
          if (reason === "archived" || reason === "parent-archived") await sql(`UPDATE ${prefix}.chat_conversations
            SET archived_at = clock_timestamp(), archived_by_user_id = 'archiver' WHERE id = $1`,
          [reason === "archived" ? id : `${id}-parent`]);
          if (reason === "parent-member") await sql(`UPDATE ${prefix}.chat_conversation_members
            SET state = 'removed' WHERE conversation_id = $1`, [`${id}-parent`]);
          if (reason.endsWith("entity")) restricted = { ...permissions,
            async authorizeEntity(request) {
              return request.action !== (reason === "send-entity" ? "message.send" : "attachment.prepare");
            } };
          if (reason.endsWith("capability")) restricted = { ...permissions,
            async getCapabilities() { return [reason === "send-capability" ? "attachment.prepare" : "message.send"]; } };
          if (reason.startsWith("host")) restricted = { ...permissions,
            async authorizeThreadSend(request) {
              assert.deepEqual(request, { actor, threadId: id, parentConversationId: `${id}-parent`,
                capabilities: ["attachment.prepare", "message.send"] });
              if (reason === "host-throws") throw new Error("private host diagnostics");
              return false;
            } };
          await assertDenied(id, validInput(id), { permissions: restricted });
        }
      });
    }

    await t.test("explicit host policy receives trusted destination and fresh capabilities", async () => {
      const id = "host-allowed";
      await seed(id);
      const calls = [];
      const narrowed = { ...permissions,
        async getCapabilities() { return ["attachment.prepare", "message.send", "thread.send"]; },
        async authorizeThreadSend(request) { calls.push(request); return request.capabilities.includes("thread.send"); } };
      await command(id, validInput(id), { permissions: narrowed });
      await command(id, validInput(id), { permissions: narrowed });
      assert.deepEqual(calls, [0, 1, 2].map(() => ({ actor, threadId: id, parentConversationId: `${id}-parent`,
        capabilities: ["attachment.prepare", "message.send", "thread.send"] })));
    });

    await t.test("storage and late reservation failures roll back participation and idempotency, including replay reactivation", async () => {
      for (const failure of ["throw", "extra-field", "reservation", "replay"]) {
        const id = `rollback-${failure}`;
        await seed(id, { closed: true });
        if (failure === "replay") {
          await command(id);
          await sql(`UPDATE ${prefix}.chat_conversation_members SET state = 'removed' WHERE conversation_id = $1`, [id]);
        }
        if (failure === "reservation") {
          await sql(`CREATE FUNCTION ${prefix}.reject_prepared_attachment() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN RAISE EXCEPTION 'test reservation failure'; END $body$`);
          await sql(`CREATE TRIGGER reject_prepared_attachment BEFORE INSERT ON ${prefix}.chat_attachments
            FOR EACH ROW EXECUTE FUNCTION ${prefix}.reject_prepared_attachment()`);
        }
        storage.failure = failure === "replay" ? "throw" : failure;
        const before = await effects();
        const calls = storage.calls.length;
        try {
          await assert.rejects(command(id), (error) => failure === "reservation"
            ? /test reservation failure/.test(error.message)
            : error instanceof PrepareAttachmentCommandError && error.code === "storage_unavailable");
          assert.equal(storage.calls.length, calls + 1);
          assert.deepEqual(await effects(), before);
        } finally {
          storage.failure = null;
          if (failure === "reservation") await sql(`DROP TRIGGER reject_prepared_attachment ON ${prefix}.chat_attachments`);
        }
      }
    });

    const waitBlocked = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await sql(`SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE $1`, [`%${harness.schema}%`]);
        if (waiting.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail("preparation did not wait on the held PostgreSQL lock");
    };
    await t.test("authority is refreshed after parent, child, membership and idempotency lock waits", async () => {
      for (const reason of ["parent", "child", "membership", "prepare-capability", "send-capability", "idempotency"]) {
        const id = `wait-${reason}`;
        await seed(id);
        if (reason === "idempotency") await command(id);
        const connection = await harness.pool.connect();
        let pending;
        let capabilities = ["attachment.prepare", "message.send"];
        try {
          await connection.query("BEGIN");
          if (reason === "membership") await connection.query(`UPDATE ${prefix}.chat_conversation_members
            SET state = 'removed' WHERE conversation_id = $1`, [`${id}-parent`]);
          else if (reason === "child") await connection.query(`UPDATE ${prefix}.chat_conversations SET locked = true, closed_at = COALESCE(closed_at, clock_timestamp()),
            closed_by_user_id = COALESCE(closed_by_user_id, 'locker') WHERE id = $1`, [id]);
          else if (reason === "idempotency") await connection.query(`SELECT * FROM ${prefix}.chat_idempotency_keys
            WHERE client_key = $1 FOR UPDATE`, [validInput(id).idempotencyKey]);
          else await connection.query(`SELECT id FROM ${prefix}.chat_conversations WHERE id = $1 FOR UPDATE`, [`${id}-parent`]);
          const calls = storage.calls.length;
          pending = assert.rejects(command(id, validInput(id), { permissions: { ...permissions,
            async getCapabilities() { return capabilities; } } }), denied);
          await waitBlocked();
          if (reason === "parent" || reason === "idempotency") await connection.query(`UPDATE ${prefix}.chat_conversations
            SET archived_at = clock_timestamp(), archived_by_user_id = 'archiver' WHERE id = $1`, [`${id}-parent`]);
          if (reason === "prepare-capability") capabilities = ["message.send"];
          if (reason === "send-capability") capabilities = ["attachment.prepare"];
          await connection.query("COMMIT");
          const before = await effects();
          await pending;
          assert.equal(storage.calls.length, calls);
          assert.deepEqual(await effects(), before);
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
          if (pending) await pending;
        }
      }
    });

    await t.test("replay refreshes host, entity and capability authority after an attachment lock wait", async () => {
      for (const reason of ["host", "entity", "capability"]) {
        const id = `attachment-wait-${reason}`;
        await seed(id);
        const prepared = await command(id);
        const connection = await harness.pool.connect();
        let allowed = true;
        let pending;
        try {
          await connection.query("BEGIN");
          await connection.query(`SELECT id FROM ${prefix}.chat_attachments WHERE id = $1 FOR UPDATE`,
            [prepared.attachment.attachmentId]);
          const before = await effects();
          const calls = storage.calls.length;
          pending = assert.rejects(command(id, validInput(id), { permissions: {
            async getCapabilities() { return reason === "capability" && !allowed ? ["attachment.prepare"] : permissions.getCapabilities(); },
            async authorizeEntity() { return reason !== "entity" || allowed; },
            async authorizeThreadSend() { return reason !== "host" || allowed; },
          } }), denied);
          await waitBlocked();
          allowed = false;
          await connection.query("COMMIT");
          await pending;
          assert.equal(storage.calls.length, calls);
          assert.deepEqual(await effects(), before);
        } finally {
          await connection.query("ROLLBACK");
          connection.release();
          if (pending) await pending;
        }
      }
    });

    await t.test("preparation preserves destination hashing and actual send independently denies or reopens the original thread", async () => {
      const id = "final-send";
      await seed(id, { closed: true });
      await seed("other-destination");
      const prepared = await command(id);
      const calls = storage.calls.length;
      const beforeConflict = await effects();
      await assert.rejects(command("other-destination", validInput(id)),
        (error) => error instanceof PrepareAttachmentCommandError && error.code === "idempotency_conflict");
      assert.equal(storage.calls.length, calls);
      assert.deepEqual(await effects(), beforeConflict);
      // Upload completion is an external storage boundary; only its checksum is
      // needed by the real send command to claim the prepared pending attachment.
      await sql(`UPDATE ${prefix}.chat_attachments SET checksum = $2 WHERE id = $1`,
        [prepared.attachment.attachmentId, `sha256:${"a".repeat(64)}`]);
      const request = { operation: "send", conversationId: id, idempotencyKey: "final-send", clientMessageId: "final-send",
        content: { format: "plain", text: "Upload in original thread", attachments: [{ attachmentId: prepared.attachment.attachmentId }] } };
      const send = (overrides = {}) => sendMessage({ database: harness.pool, schema: harness.schema,
        actor, permissions, directory: { async getUser() { return null; } }, input: request, ...overrides });
      for (const reason of ["locked", "parent-member", "send-capability", "host"]) {
        if (reason === "locked") await sql(`UPDATE ${prefix}.chat_conversations SET locked = true, closed_at = COALESCE(closed_at, clock_timestamp()),
            closed_by_user_id = COALESCE(closed_by_user_id, 'locker') WHERE id = $1`, [id]);
        if (reason === "parent-member") await sql(`UPDATE ${prefix}.chat_conversation_members
          SET state = 'removed' WHERE conversation_id = $1`, [`${id}-parent`]);
        const before = await effects();
        const restricted = reason === "send-capability" ? { ...permissions, async getCapabilities() { return ["attachment.prepare"]; } }
          : reason === "host" ? { ...permissions, async authorizeThreadSend() { return false; } } : permissions;
        await assert.rejects(send({ permissions: restricted }), denied);
        assert.deepEqual(await effects(), before);
        if (reason === "locked") await sql(`UPDATE ${prefix}.chat_conversations SET locked = false WHERE id = $1`, [id]);
        if (reason === "parent-member") await sql(`UPDATE ${prefix}.chat_conversation_members
          SET state = 'active' WHERE conversation_id = $1`, [`${id}-parent`]);
      }
      const accepted = await send();
      assert.equal(accepted.message.conversationId, id);
      assert.equal(accepted.message.content.attachments[0].attachmentId, prepared.attachment.attachmentId);
      const destination = (await sql(`SELECT closed_at, lifecycle_revision::text FROM ${prefix}.chat_conversations WHERE id = $1`, [id])).rows[0];
      assert.equal(destination.closed_at, null);
      assert.equal(destination.lifecycle_revision, "2");
      const events = (await sql(`SELECT type FROM ${prefix}.chat_outbox_events
        WHERE stream_id IN ($1, $2) AND type LIKE 'thread.lifecycle.%'`, [id, `${id}-parent`])).rows;
      assert.deepEqual(events.map((row) => row.type).sort(), ["thread.lifecycle.changed", "thread.lifecycle.updated"]);
      const after = await effects();
      assert.deepEqual((await send()).message, accepted.message);
      assert.deepEqual(await effects(), after);
    });
  } finally {
    if (harness) await harness.teardown();
    await backend.teardown();
  }
});
