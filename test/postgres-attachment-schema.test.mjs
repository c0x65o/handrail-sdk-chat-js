import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const findIndexes = (plan, indexes = []) => {
  if (plan && typeof plan === "object") {
    if (typeof plan["Index Name"] === "string") {
      indexes.push(plan["Index Name"]);
    }
    for (const value of Object.values(plan)) {
      findIndexes(value, indexes);
    }
  }
  return indexes;
};

const checksum = `sha256:${"a".repeat(64)}`;

test("attachment migration enforces tenant-safe one-way upload metadata", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_attachments" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const attachments = `${schema}.chat_attachments`;

  const createPending = async ({
    tenantId = "tenant-a",
    id,
    storageKey = `tenant-a/${id}`,
    fileName = `${id}.txt`,
    contentType = "text/plain",
    sizeBytes = 12,
    createdAt = "2030-01-01T00:00:00Z",
    expiresAt = "2030-01-01T01:00:00Z",
  }) =>
    harness.pool.query(
      `INSERT INTO ${attachments}
         (tenant_id, id, uploader_user_id, storage_key, file_name,
          content_type, size_bytes, created_at, updated_at, expires_at)
       VALUES ($1, $2, 'uploader-a', $3, $4, $5, $6, $7, $7, $8)
       RETURNING *`,
      [
        tenantId,
        id,
        storageKey,
        fileName,
        contentType,
        sizeBytes,
        createdAt,
        expiresAt,
      ],
    );

  try {
    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const applied = await runner.apply();

    assert.deepEqual(
      applied.applied.map(({ id, order }) => ({ id, order })),
      [
        { id: "0001-chat-conversations-membership", order: 1 },
        { id: "0002-chat-messages-revisions", order: 2 },
        { id: "0003-chat-reactions", order: 3 },
        { id: "0004-chat-read-cursors", order: 4 },
        { id: "0005-chat-outbox-events", order: 5 },
        { id: "0006-chat-idempotency-keys", order: 6 },
        { id: "0007-chat-drafts", order: 7 },
        { id: "0008-chat-conversation-preferences", order: 8 },
        { id: "0009-chat-thread-follows", order: 9 },
        { id: "0010-chat-attachments", order: 10 },
        { id: "0011-chat-audit-events", order: 11 },
        { id: "0012-chat-saved-messages", order: 12 },
        { id: "0013-chat-huddle-sessions", order: 13 },
        { id: "0014-chat-notification-deliveries", order: 14 },
        { id: "0015-chat-conversation-lifecycle-revision", order: 15 },
        { id: "0016-chat-thread-follow-revision", order: 16 },
      ],
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'conversation-a', 'channel', 'private', 'Tenant A'),
         ('tenant-b', 'conversation-b', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'message-a1', 'conversation-a', 1, 'author-a',
          'client-a1', '{"format":"plain","text":"First"}'),
         ('tenant-a', 'message-a2', 'conversation-a', 2, 'author-a',
          'client-a2', '{"format":"plain","text":"Second"}'),
         ('tenant-b', 'message-b1', 'conversation-b', 1, 'author-b',
          'client-b1', '{"format":"plain","text":"Other tenant"}')`,
    );

    await t.test("creates pending metadata without storing object bytes", async () => {
      const stored = (await createPending({ id: "attachment-a" })).rows[0];

      assert.deepEqual(
        {
          state: stored.state,
          messageId: stored.attached_message_id,
          checksum: stored.checksum,
          attachedAt: stored.attached_at,
          abandonedAt: stored.abandoned_at,
          sizeBytes: Number(stored.size_bytes),
        },
        {
          state: "pending",
          messageId: null,
          checksum: null,
          attachedAt: null,
          abandonedAt: null,
          sizeBytes: 12,
        },
      );

      const columns = (
        await harness.pool.query(
          `SELECT column_name
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'chat_attachments'`,
          [harness.schema],
        )
      ).rows.map(({ column_name }) => column_name);
      assert.equal(columns.includes("content"), false);
      assert.equal(columns.includes("data"), false);
      assert.equal(columns.includes("bytes"), false);
    });

    await t.test("finalizes once against a same-tenant message", async () => {
      const attached = (
        await harness.pool.query(
          `UPDATE ${attachments}
           SET state = 'attached',
               attached_message_id = 'message-a1',
               checksum = $1,
               attached_at = '2030-01-01T00:10:00Z',
               updated_at = '2030-01-01T00:10:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-a'
           RETURNING state, attached_message_id, checksum, attached_at`,
          [checksum],
        )
      ).rows[0];

      assert.deepEqual(
        {
          state: attached.state,
          messageId: attached.attached_message_id,
          checksum: attached.checksum,
          attachedAt: attached.attached_at.toISOString(),
        },
        {
          state: "attached",
          messageId: "message-a1",
          checksum,
          attachedAt: "2030-01-01T00:10:00.000Z",
        },
      );
    });

    await t.test("rejects cross-tenant association and storage-key reuse", async () => {
      await createPending({
        tenantId: "tenant-b",
        id: "attachment-b",
        storageKey: "tenant-b/attachment-b",
      });
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${attachments}
           SET state = 'attached',
               attached_message_id = 'message-a1',
               checksum = $1,
               attached_at = '2030-01-01T00:10:00Z',
               updated_at = '2030-01-01T00:10:00Z'
           WHERE tenant_id = 'tenant-b' AND id = 'attachment-b'`,
          [checksum],
        ),
        /chat_attachments_message_fkey/,
      );
      await assert.rejects(
        createPending({ id: "duplicate-storage", storageKey: "tenant-a/attachment-a" }),
        /chat_attachments_storage_key_key/,
      );
    });

    await t.test("keeps attached and abandoned terminal states immutable", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${attachments}
           SET attached_message_id = 'message-a2',
               updated_at = '2030-01-01T00:11:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-a'`,
        ),
        /terminal chat_attachments are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${attachments}
           SET attached_at = '2030-01-01T00:12:00Z',
               updated_at = '2030-01-01T00:12:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-a'`,
        ),
        /terminal chat_attachments are immutable/,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${attachments}
           SET state = 'pending',
               attached_message_id = NULL,
               attached_at = NULL,
               updated_at = '2030-01-01T00:13:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-a'`,
        ),
        /terminal chat_attachments are immutable/,
      );

      await createPending({ id: "attachment-abandoned" });
      await harness.pool.query(
        `UPDATE ${attachments}
         SET state = 'abandoned',
             abandoned_at = '2030-01-01T00:20:00Z',
             updated_at = '2030-01-01T00:20:00Z'
         WHERE tenant_id = 'tenant-a' AND id = 'attachment-abandoned'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${attachments}
           SET state = 'pending', abandoned_at = NULL,
               updated_at = '2030-01-01T00:21:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-abandoned'`,
        ),
        /terminal chat_attachments are immutable/,
      );
    });

    await t.test("validates creation metadata and lifecycle timestamps", async () => {
      await createPending({ id: "attachment-immutable" });
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${attachments}
           SET file_name = 'renamed.txt'
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-immutable'`,
        ),
        /identities and creation metadata are immutable/,
      );
      await assert.rejects(
        createPending({ id: "attachment-negative", sizeBytes: -1 }),
        /chat_attachments_size_bytes_check/,
      );
      await assert.rejects(
        createPending({
          id: "attachment-bad-expiry",
          expiresAt: "2029-12-31T23:59:59Z",
        }),
        /chat_attachments_timestamp_order_check/,
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${attachments}
             (tenant_id, id, uploader_user_id, storage_key, file_name,
              content_type, size_bytes, checksum, state,
              attached_message_id, created_at, updated_at, attached_at,
              expires_at)
           VALUES
             ('tenant-a', 'attachment-direct', 'uploader-a',
              'tenant-a/attachment-direct', 'direct.txt', 'text/plain', 1,
              $1, 'attached', 'message-a1', '2030-01-01T00:00:00Z',
              '2030-01-01T00:01:00Z', '2030-01-01T00:01:00Z',
              '2030-01-01T01:00:00Z')`,
          [checksum],
        ),
        /chat_attachments_initial_state_check/,
      );
    });

    await t.test("retains metadata after its message is soft-deleted", async () => {
      await harness.pool.query(
        `UPDATE ${messages}
         SET deleted_at = '2030-01-01T00:30:00Z',
             deleted_by_user_id = 'moderator-a',
             updated_at = '2030-01-01T00:30:00Z'
         WHERE tenant_id = 'tenant-a' AND id = 'message-a1'`,
      );
      const stored = (
        await harness.pool.query(
          `SELECT state, attached_message_id, storage_key, file_name
           FROM ${attachments}
           WHERE tenant_id = 'tenant-a' AND id = 'attachment-a'`,
        )
      ).rows[0];
      assert.deepEqual(stored, {
        state: "attached",
        attached_message_id: "message-a1",
        storage_key: "tenant-a/attachment-a",
        file_name: "attachment-a.txt",
      });
    });

    await t.test("uses pending-expiry and per-message attachment indexes", async () => {
      await harness.pool.query(
        `INSERT INTO ${conversations}
           (tenant_id, id, type, visibility, name)
         VALUES ('lookup-tenant', 'lookup-conversation', 'channel', 'private', 'Lookup')`,
      );
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, id, conversation_id, sequence, author_user_id,
            client_message_id, content)
         VALUES
           ('lookup-tenant', 'lookup-message', 'lookup-conversation', 1,
            'lookup-author', 'lookup-client',
            '{"format":"plain","text":"Lookup"}')`,
      );
      await harness.pool.query(
        `INSERT INTO ${attachments}
           (tenant_id, id, uploader_user_id, storage_key, file_name,
            content_type, size_bytes, created_at, updated_at, expires_at)
         SELECT
           'lookup-tenant',
           'attachment-' || value,
           'lookup-uploader',
           'lookup/' || value,
           'file-' || value || '.txt',
           'text/plain',
           value,
           '2030-01-01T00:00:00Z'::timestamptz,
           '2030-01-01T00:00:00Z'::timestamptz,
           '2030-01-01T02:00:00Z'::timestamptz + value * interval '1 minute'
         FROM generate_series(1, 600) AS value`,
      );
      await harness.pool.query(
        `UPDATE ${attachments}
         SET state = 'attached',
             attached_message_id = 'lookup-message',
             checksum = $1,
             attached_at = '2030-01-01T01:00:00Z',
             updated_at = '2030-01-01T01:00:00Z'
         WHERE tenant_id = 'lookup-tenant' AND id LIKE 'attachment-%'
           AND (substring(id from '[0-9]+$'))::integer % 2 = 0`,
        [checksum],
      );

      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${attachments}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const pendingPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id, uploader_user_id, storage_key, updated_at
           FROM ${attachments}
           WHERE tenant_id = 'lookup-tenant'
             AND state = 'pending'
             AND expires_at <= '2030-01-01T08:00:00Z'
           ORDER BY expires_at, id`,
        );
        const messagePlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id, file_name, content_type, size_bytes, storage_key,
                  checksum, created_at, attached_at
           FROM ${attachments}
           WHERE tenant_id = 'lookup-tenant'
             AND attached_message_id = 'lookup-message'
             AND state = 'attached'
           ORDER BY id`,
        );

        assert.ok(
          findIndexes(pendingPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_attachments_pending_expiry_idx",
          ),
        );
        assert.ok(
          findIndexes(messagePlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_attachments_message_idx",
          ),
        );
      } finally {
        await client.query("RESET enable_bitmapscan").catch(() => undefined);
        await client.query("RESET enable_seqscan").catch(() => undefined);
        client.release();
      }
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
