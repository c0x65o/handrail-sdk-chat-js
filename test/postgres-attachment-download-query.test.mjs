import assert from "node:assert/strict";
import test from "node:test";

// Bundle canonical sources without reading or writing shared dist:
// node_modules/.bin/esbuild test/postgres-attachment-download-query.test.mjs --bundle --platform=node --format=esm --packages=external --outfile=node_modules/.cache/attachment-download-postgres-tests.mjs
// node --test --test-concurrency=1 "$PWD/node_modules/.cache/attachment-download-postgres-tests.mjs"
import {
  AttachmentTransportError,
  MAX_ATTACHMENT_DOWNLOAD_DESCRIPTOR_TTL_MS,
} from "../src/contracts/attachment-transport.ts";
import {
  ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
  AttachmentDownloadQueryError,
  queryAttachmentDownload,
} from "../src/server/attachment-download-query.ts";
import { CHAT_AUTHORIZATION_ERROR_CODE, ChatAuthorizationError } from "../src/server/request-context.ts";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "../src/testing/index.ts";

const actorInput = Object.freeze({
  credential: "attachment-download-actor",
  actor: Object.freeze({
    tenantId: "tenant-a",
    userId: "user-a",
    roles: Object.freeze(["employee"]),
  }),
});

const checksum = `sha256:${"a".repeat(64)}`;
const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;
const downloadInput = (attachmentId, messageId, overrides = {}) => ({
  operation: "get_attachment_download",
  attachmentId,
  messageId,
  ...overrides,
});
const decodeDescriptor = (descriptor) =>
  JSON.parse(Buffer.from(descriptor, "base64url").toString("utf8"));
const authorizationShape = (error) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  statusCode: error.statusCode,
});

class FakeDownloadStorage {
  constructor(now) {
    this.now = now;
    this.calls = [];
    this.response = null;
    this.failure = null;
  }

  reset() {
    this.calls.length = 0;
    this.response = null;
    this.failure = null;
  }

  async createDownloadUrl(input) {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return this.response ?? {
      url: `https://downloads.test.invalid/${input.attachmentId}?signature=provider-secret`,
      expiresAt: new Date(this.now.valueOf() + 60_000).toISOString(),
      headers: { authorization: "Bearer provider-credential" },
    };
  }
}

async function seedDownloadWorld(harness) {
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;
  const attachments = `${schema}.chat_attachments`;

  await harness.pool.query(
    `INSERT INTO ${conversations}
       (tenant_id, id, type, visibility, name, entity_type, entity_id,
        current_message_sequence)
     VALUES
       ('tenant-a', 'public', 'channel', 'public', 'Public', NULL, NULL, 4),
       ('tenant-a', 'private-member', 'channel', 'private', 'Private', NULL, NULL, 1),
       ('tenant-a', 'private-denied', 'channel', 'private', 'Denied', NULL, NULL, 1),
       ('tenant-a', 'entity-public', 'channel', 'public', 'Order', 'order', '42', 1),
       ('tenant-b', 'cross-public', 'channel', 'public', 'Other tenant', NULL, NULL, 1)`,
  );
  await harness.pool.query(
    `INSERT INTO ${members}
       (tenant_id, conversation_id, user_id, role, state)
     VALUES
       ('tenant-a', 'private-member', 'user-a', 'member', 'active'),
       ('tenant-a', 'private-denied', 'user-a', 'member', 'left')`,
  );
  await harness.pool.query(
    `INSERT INTO ${messages}
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, created_at, updated_at, deleted_at,
        deleted_by_user_id)
     VALUES
       ('tenant-a', 'public-message', 'public', 1, 'user-a', 'public-client',
        '{"format":"plain","text":"public"}', statement_timestamp(), statement_timestamp(), NULL, NULL),
       ('tenant-a', 'other-public-message', 'public', 2, 'user-a', 'other-client',
        '{"format":"plain","text":"other"}', statement_timestamp(), statement_timestamp(), NULL, NULL),
       ('tenant-a', 'deleted-message', 'public', 3, 'user-a', 'deleted-client',
        '{"format":"plain","text":"deleted"}', statement_timestamp(), statement_timestamp(),
        statement_timestamp(), 'user-a'),
       ('tenant-a', 'unsafe-message', 'public', 4, 'user-a', 'unsafe-client',
        '{"format":"plain","text":"unsafe"}', statement_timestamp(), statement_timestamp(), NULL, NULL),
       ('tenant-a', 'private-message', 'private-member', 1, 'user-a', 'private-client',
        '{"format":"plain","text":"private"}', statement_timestamp(), statement_timestamp(), NULL, NULL),
       ('tenant-a', 'denied-message', 'private-denied', 1, 'user-a', 'denied-client',
        '{"format":"plain","text":"denied"}', statement_timestamp(), statement_timestamp(), NULL, NULL),
       ('tenant-a', 'entity-message', 'entity-public', 1, 'user-a', 'entity-client',
        '{"format":"plain","text":"entity"}', statement_timestamp(), statement_timestamp(), NULL, NULL),
       ('tenant-b', 'cross-message', 'cross-public', 1, 'user-b', 'cross-client',
        '{"format":"plain","text":"cross"}', statement_timestamp(), statement_timestamp(), NULL, NULL)`,
  );

  const seedAttachment = async ({
    tenantId = "tenant-a",
    attachmentId,
    messageId = null,
    state = "attached",
    fileName = `${attachmentId}.txt`,
  }) => {
    await harness.pool.query(
      `INSERT INTO ${attachments}
         (tenant_id, id, uploader_user_id, storage_key, file_name,
          content_type, size_bytes, created_at, updated_at, expires_at)
       VALUES ($1, $2, 'uploader', $3, $4, 'text/plain', 42,
               statement_timestamp() - interval '10 minutes',
               statement_timestamp() - interval '10 minutes',
               statement_timestamp() + interval '1 hour')`,
      [tenantId, attachmentId, `private/${tenantId}/${attachmentId}`, fileName],
    );
    if (state === "finalized") {
      await harness.pool.query(
        `UPDATE ${attachments} SET checksum = $1, updated_at = statement_timestamp()
          WHERE tenant_id = $2 AND id = $3`,
        [checksum, tenantId, attachmentId],
      );
    } else if (state === "abandoned") {
      await harness.pool.query(
        `UPDATE ${attachments}
            SET state = 'abandoned', abandoned_at = statement_timestamp(),
                updated_at = statement_timestamp()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, attachmentId],
      );
    } else if (state === "attached") {
      await harness.pool.query(
        `UPDATE ${attachments}
            SET state = 'attached', checksum = $1,
                attached_message_id = $2, attached_at = statement_timestamp(),
                updated_at = statement_timestamp()
          WHERE tenant_id = $3 AND id = $4`,
        [checksum, messageId, tenantId, attachmentId],
      );
    }
  };

  for (const fixture of [
    { attachmentId: "public-report", messageId: "public-message", fileName: "Quarterly report.txt" },
    { attachmentId: "unicode-report", messageId: "public-message", fileName: "Résumé 東京.txt" },
    { attachmentId: "private-report", messageId: "private-message" },
    { attachmentId: "entity-report", messageId: "entity-message" },
    { attachmentId: "mismatch-report", messageId: "public-message" },
    { attachmentId: "deleted-report", messageId: "deleted-message" },
    { attachmentId: "denied-report", messageId: "denied-message" },
    { tenantId: "tenant-b", attachmentId: "cross-report", messageId: "cross-message" },
    { attachmentId: "unsafe-quote", messageId: "unsafe-message", fileName: "bad\"name.txt" },
    { attachmentId: "unsafe-slash", messageId: "unsafe-message", fileName: "bad/name.txt" },
    { attachmentId: "unsafe-backslash", messageId: "unsafe-message", fileName: "bad\\name.txt" },
    { attachmentId: "unsafe-crlf", messageId: "unsafe-message", fileName: "bad\r\nname.txt" },
  ]) {
    await seedAttachment(fixture);
  }
  await seedAttachment({ attachmentId: "pending-report", state: "pending" });
  await seedAttachment({ attachmentId: "finalized-report", state: "finalized" });
  await seedAttachment({ attachmentId: "rejected-report", state: "abandoned" });
  await seedAttachment({ attachmentId: "abandoned-report", state: "abandoned" });
  return seedAttachment;
}

test("secure attachment download query authorizes, sanitizes, and never persists provider material", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  const now = new Date();
  const storage = new FakeDownloadStorage(now);
  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorInput],
      schemaPrefix: "chat_attachment_download",
    });
    const seedAttachment = await seedDownloadWorld(harness);
    t.diagnostic(`Real PostgreSQL ${backend.kind}; isolated schema with canonical migrations`);
    const run = (input, overrides = {}) =>
      queryAttachmentDownload({
        database: harness.pool,
        schema: harness.schema,
        permissions: harness.adapters.permissions,
        storage,
        actor: actorInput.actor,
        input,
        now: () => new Date(now),
        ...overrides,
      });

    await t.test("allows public and active-member access with one trusted storage call", async () => {
      for (const [attachmentId, messageId] of [
        ["public-report", "public-message"],
        ["private-report", "private-message"],
      ]) {
        storage.reset();
        const result = await run(downloadInput(attachmentId, messageId));
        assert.equal(result.attachment.status, "attached");
        assert.equal(result.attachment.messageId, messageId);
        assert.equal(result.download.kind, "opaque_attachment_download");
        assert.ok(Date.parse(result.download.expiresAt) > now.valueOf());
        assert.ok(
          Date.parse(result.download.expiresAt) - now.valueOf() <=
            MAX_ATTACHMENT_DOWNLOAD_DESCRIPTOR_TTL_MS,
        );
        assert.equal(storage.calls.length, 1);
        assert.deepEqual(storage.calls[0], {
          actor: actorInput.actor,
          attachmentId,
          objectKey: `private/tenant-a/${attachmentId}`,
          fileName: result.attachment.metadata.fileName,
          contentDisposition: "attachment",
        });
        assert.equal("tenantId" in storage.calls[0], false);
        assert.equal("userId" in storage.calls[0], false);
      }
    });

    const prefix = quoteIdentifier(harness.schema);
    const sql = (statement, values) => harness.pool.query(statement, values);
    const seedThread = async (id, parent = "public", tenant = "tenant-a") => {
      await sql(`INSERT INTO ${prefix}.chat_conversations
        (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
        SELECT tenant_id, $1, 'thread', visibility, id,
          (SELECT id FROM ${prefix}.chat_messages
            WHERE tenant_id = $3 AND conversation_id = $2 ORDER BY sequence LIMIT 1)
        FROM ${prefix}.chat_conversations WHERE tenant_id = $3 AND id = $2`,
      [id, parent, tenant]);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ($1, $2, $3, 1, 'author', $2, '{"format":"plain","text":"attachment"}')`,
      [tenant, `${id}-message`, id]);
      await seedAttachment({ tenantId: tenant, attachmentId: `${id}-report`, messageId: `${id}-message` });
    };
    const member = (id, state = "active") => sql(`INSERT INTO ${prefix}.chat_conversation_members
      (tenant_id, conversation_id, user_id, role, state)
      VALUES ('tenant-a', $1, 'user-a', 'owner', $2)
      ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET state = EXCLUDED.state`,
    [id, state]);
    const readThread = (id, overrides = {}) =>
      run(downloadInput(`${id}-report`, `${id}-message`), overrides);
    const deny = async (input, overrides = {}) => {
      storage.reset();
      await assert.rejects(run(input, overrides), (error) => {
        assert.ok(error instanceof ChatAuthorizationError);
        assert.deepEqual(authorizationShape(error), authorizationShape(new ChatAuthorizationError()));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(storage.calls.length, 0, "denial must precede storage URL creation");
    };
    const denyThread = (id, overrides = {}) =>
      deny(downloadInput(`${id}-report`, `${id}-message`), overrides);

    await t.test("thread readers need current parent access without participant or private-state writes", async () => {
      await seedThread("no-participant");
      await seedThread("unfollowed", "private-member");
      await member("unfollowed");
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
        VALUES ('tenant-a', 'unfollowed', 'user-a', false, 'manual', 7)`);
      await sql(`INSERT INTO ${prefix}.chat_read_cursors
        (tenant_id, conversation_id, user_id, last_read_sequence, manual_unread_from_sequence)
        VALUES ('tenant-a', 'unfollowed', 'user-a', 1, 1)`);
      await sql(`INSERT INTO ${prefix}.chat_conversation_preferences
        (tenant_id, conversation_id, user_id, notification_level, muted)
        VALUES ('tenant-a', 'unfollowed', 'user-a', 'mentions', true)`);
      await member("unfollowed", "left");
      const snapshot = async () => {
        const tables = await sql("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename", [harness.schema]);
        const rows = {};
        for (const { tablename } of tables.rows) {
          rows[tablename] = (await sql(`SELECT COALESCE(jsonb_agg(row ORDER BY row::text), '[]') AS rows
            FROM (SELECT to_jsonb(t) AS row FROM ${prefix}.${quoteIdentifier(tablename)} AS t) AS data`)).rows[0].rows;
        }
        return rows;
      };
      const before = await snapshot();
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN READ ONLY");
        for (const id of ["no-participant", "unfollowed"]) {
          storage.reset();
          const result = await readThread(id, { database: connection });
          assert.equal(result.messageId, `${id}-message`);
          assert.equal(result.download.kind, "opaque_attachment_download");
          assert.equal(storage.calls.length, 1);
        }
        assert.equal((await connection.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("stale active child owners cannot bypass absent or revoked private-parent membership", async () => {
      await seedThread("stale-child", "private-denied");
      await member("stale-child");
      for (const state of ["left", "removed"]) {
        await member("private-denied", state);
        await denyThread("stale-child");
      }
      await sql(`DELETE FROM ${prefix}.chat_conversation_members
        WHERE tenant_id = 'tenant-a' AND conversation_id = 'private-denied' AND user_id = 'user-a'`);
      await denyThread("stale-child");
      await member("private-denied");
      storage.reset();
      assert.equal((await readThread("stale-child")).attachmentId, "stale-child-report");
      assert.equal(storage.calls.length, 1);
      await member("private-denied", "left");
      await denyThread("stale-child");
    });

    await t.test("thread parent entity policy uses attachment.download and sanitizes denials", async () => {
      await seedThread("entity-thread", "entity-public");
      await member("entity-thread");
      for (const throws of [false, true]) {
        await denyThread("entity-thread", { permissions: {
          async authorizeEntity() {
            if (throws) throw new Error("private host diagnostic");
            return false;
          },
        } });
      }
      harness.calls.reset();
      storage.reset();
      await readThread("entity-thread");
      assert.deepEqual(harness.calls.all("permissions.authorizeEntity").map(({ input }) => input), [{
        actor: actorInput.actor,
        entity: { type: "order", id: "42" },
        action: ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
      }]);
      assert.equal(storage.calls.length, 1);
    });

    await t.test("administrative parent and child archive deny downloads while closed and locked history remains readable", async () => {
      await seedThread("archived-child");
      await member("archived-child");
      await sql(`UPDATE ${prefix}.chat_conversations
        SET archived_at = statement_timestamp(), archived_by_user_id = 'admin'
        WHERE tenant_id = 'tenant-a' AND id = 'archived-child'`);
      await denyThread("archived-child");
      await seedThread("archived-parent", "private-member");
      await member("archived-parent");
      await sql(`UPDATE ${prefix}.chat_conversations
        SET archived_at = statement_timestamp(), archived_by_user_id = 'admin'
        WHERE tenant_id = 'tenant-a' AND id = 'private-member'`);
      await denyThread("archived-parent");
      await seedThread("closed-thread");
      for (const locked of [false, true]) {
        await sql(`UPDATE ${prefix}.chat_conversations
          SET closed_at = statement_timestamp(), closed_by_user_id = 'moderator', locked = $1
          WHERE tenant_id = 'tenant-a' AND id = 'closed-thread'`, [locked]);
        storage.reset();
        assert.equal((await readThread("closed-thread")).messageId, "closed-thread-message");
        assert.equal(storage.calls.length, 1);
      }
    });

    await t.test("thread downloads retain exact message binding, tenant isolation and deleted-message denial", async () => {
      await seedThread("bound-thread");
      await member("bound-thread");
      await deny(downloadInput("bound-thread-report", "public-message"));
      await deny(downloadInput("public-report", "bound-thread-message"));
      await denyThread("bound-thread", { actor: { ...actorInput.actor, tenantId: "tenant-b" } });
      await seedThread("other-tenant-thread", "cross-public", "tenant-b");
      await denyThread("other-tenant-thread");
      // Identical parent/thread/message/attachment IDs in another tenant cannot lend access.
      await sql(`INSERT INTO ${prefix}.chat_conversations (tenant_id, id, type, visibility, name)
        VALUES ('tenant-b', 'private-denied', 'channel', 'public', 'Collision')`);
      await sql(`INSERT INTO ${prefix}.chat_messages
        (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
        VALUES ('tenant-b', 'denied-message', 'private-denied', 1, 'author', 'collision', '{"format":"plain","text":"root"}')`);
      await seedThread("stale-child", "private-denied", "tenant-b");
      await denyThread("stale-child");
      await sql(`UPDATE ${prefix}.chat_messages
        SET deleted_at = statement_timestamp(), deleted_by_user_id = 'author',
            updated_at = statement_timestamp()
        WHERE tenant_id = 'tenant-a' AND id = 'bound-thread-message'`);
      await denyThread("bound-thread");
    });

    await t.test("requires the dedicated host entity authorization action", async () => {
      harness.calls.reset();
      storage.reset();
      const result = await run(downloadInput("entity-report", "entity-message"));
      assert.equal(result.attachmentId, "entity-report");
      assert.deepEqual(
        harness.calls.all("permissions.authorizeEntity")[0].input,
        {
          actor: actorInput.actor,
          entity: { type: "order", id: "42" },
          action: ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
        },
      );
      assert.equal(storage.calls.length, 1);

      harness.setEntityAuthorization(false);
      storage.reset();
      await assert.rejects(
        run(downloadInput("entity-report", "entity-message")),
            );
      assert.equal(storage.calls.length, 0);
      harness.setEntityAuthorization(true);
    });

    await t.test("builds safe Content-Disposition for spaces and Unicode", async () => {
      for (const [attachmentId, expected] of [
        [
          "public-report",
          "attachment; filename=\"Quarterly report.txt\"; filename*=UTF-8''Quarterly%20report.txt",
        ],
        [
          "unicode-report",
          "attachment; filename=\"R_sum_ __.txt\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E6%9D%B1%E4%BA%AC.txt",
        ],
      ]) {
        storage.reset();
        const result = await run(downloadInput(attachmentId, "public-message"));
        const opaque = decodeDescriptor(result.download.descriptor);
        assert.equal(opaque.headers["content-disposition"], expected);
        assert.equal(opaque.headers.authorization, "Bearer provider-credential");
        assert.match(opaque.url, /^https:\/\/downloads\.test\.invalid\//);
        assert.equal(storage.calls.length, 1);
      }
    });

    await t.test("makes every unavailable row indistinguishable and avoids storage", async () => {
      const failures = [];
      for (const [attachmentId, messageId] of [
        ["pending-report", "public-message"],
        ["finalized-report", "public-message"],
        ["rejected-report", "public-message"],
        ["abandoned-report", "public-message"],
        ["mismatch-report", "other-public-message"],
        ["deleted-report", "deleted-message"],
        ["denied-report", "denied-message"],
        ["cross-report", "cross-message"],
        ["absent-report", "public-message"],
      ]) {
        storage.reset();
        await assert.rejects(
          run(downloadInput(attachmentId, messageId)),
          (error) => {
            assert.ok(error instanceof ChatAuthorizationError);
            assert.equal(error.code, CHAT_AUTHORIZATION_ERROR_CODE);
            failures.push(authorizationShape(error));
            return true;
          },
        );
        assert.equal(storage.calls.length, 0, attachmentId);
      }
      assert.ok(failures.every((failure) =>
        JSON.stringify(failure) === JSON.stringify(failures[0])));
    });

    await t.test("rejects unsafe persisted filenames before storage", async () => {
      for (const attachmentId of [
        "unsafe-quote",
        "unsafe-slash",
        "unsafe-backslash",
        "unsafe-crlf",
      ]) {
        storage.reset();
        await assert.rejects(
          run(downloadInput(attachmentId, "unsafe-message")),
                );
        assert.equal(storage.calls.length, 0, attachmentId);
      }
    });

    await t.test("validates caller input before database, permissions, or storage", async () => {
      let databaseCalls = 0;
      storage.reset();
      const database = {
        async query() {
          databaseCalls += 1;
          throw new Error("database must not be called");
        },
        async connect() {
          throw new Error("database must not be called");
        },
      };
      await assert.rejects(
        run(downloadInput("public-report", "public-message", {
          tenantId: "spoofed-tenant",
        }), { database }),
        (error) =>
          error instanceof AttachmentTransportError &&
          error.code === "trusted_context_field",
      );
      assert.equal(databaseCalls, 0);
      assert.equal(storage.calls.length, 0);
    });

    await t.test("normalizes expired, overlong, malformed, and credential-bearing provider responses", async () => {
      const invalidResponses = [
        {
          url: "https://downloads.test.invalid/expired",
          expiresAt: new Date(now.valueOf() - 1).toISOString(),
        },
        {
          url: "https://downloads.test.invalid/too-long",
          expiresAt: new Date(
            now.valueOf() + MAX_ATTACHMENT_DOWNLOAD_DESCRIPTOR_TTL_MS + 1,
          ).toISOString(),
        },
        {
          url: `https://downloads.test.invalid/${"a".repeat(2_100)}`,
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
        },
        {
          url: "http://downloads.test.invalid/insecure",
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
        },
        {
          url: "https://user:password@downloads.test.invalid/credential",
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
        },
        {
          url: "not a URL",
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
        },
        {
          url: "https://downloads.test.invalid/header",
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
          headers: { "x-provider": "safe\r\nset-cookie: stolen" },
        },
        {
          url: "https://downloads.test.invalid/disposition",
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
          headers: { "Content-Disposition": "inline" },
        },
        {
          url: "https://downloads.test.invalid/extra",
          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
          providerSecret: "secret-provider-response",
        },
      ];
      const errors = [];
      for (const response of invalidResponses) {
        storage.reset();
        storage.response = response;
        await assert.rejects(
          run(downloadInput("public-report", "public-message")),
          (error) => {
            assert.ok(error instanceof AttachmentDownloadQueryError);
            assert.equal(error.code, "storage_unavailable");
            assert.equal(error.statusCode, 503);
            errors.push({
              name: error.name,
              message: error.message,
              code: error.code,
              statusCode: error.statusCode,
            });
            return true;
          },
        );
        assert.equal(storage.calls.length, 1);
      }
      assert.ok(errors.every((error) =>
        JSON.stringify(error) === JSON.stringify(errors[0])));

      storage.reset();
      storage.failure = new Error("signed-url-provider-secret-internal");
      await assert.rejects(
        run(downloadInput("public-report", "public-message")),
        (error) =>
          error instanceof AttachmentDownloadQueryError &&
          !error.message.includes("provider-secret"),
      );
      assert.equal(storage.calls.length, 1);
    });

    await t.test("leaves descriptor and provider secrets out of durable and logged state", async () => {
      storage.reset();
      const capturedLogs = [];
      const originalMethods = {
        log: console.log,
        warn: console.warn,
        error: console.error,
      };
      console.log = (...values) => capturedLogs.push(values);
      console.warn = (...values) => capturedLogs.push(values);
      console.error = (...values) => capturedLogs.push(values);
      let result;
      try {
        result = await run(downloadInput("public-report", "public-message"));
      } finally {
        console.log = originalMethods.log;
        console.warn = originalMethods.warn;
        console.error = originalMethods.error;
      }
      assert.equal(capturedLogs.length, 0);
      const publicResult = JSON.stringify(result);
      for (const secret of [
        "provider-secret",
        "provider-credential",
        "private/tenant-a/public-report",
        "storage_key",
        "storageKey",
        "signature",
        "authorization",
      ]) {
        assert.equal(publicResult.includes(secret), false, secret);
      }

      const schema = quoteIdentifier(harness.schema);
      const durable = (
        await harness.pool.query(
          `SELECT
             (SELECT jsonb_agg(to_jsonb(attachment) - 'storage_key')
                FROM ${schema}.chat_attachments AS attachment) AS attachments,
             (SELECT jsonb_agg(to_jsonb(audit))
                FROM ${schema}.chat_audit_events AS audit) AS audits,
             (SELECT jsonb_agg(to_jsonb(outbox))
                FROM ${schema}.chat_outbox_events AS outbox) AS outbox,
             (SELECT jsonb_agg(to_jsonb(idempotency))
                FROM ${schema}.chat_idempotency_keys AS idempotency) AS idempotency,
             (SELECT storage_key FROM ${schema}.chat_attachments
                WHERE tenant_id = 'tenant-a' AND id = 'public-report') AS storage_key`,
        )
      ).rows[0];
      assert.equal(durable.storage_key, "private/tenant-a/public-report");
      const serializedDurable = JSON.stringify({
        attachments: durable.attachments,
        audits: durable.audits,
        outbox: durable.outbox,
        idempotency: durable.idempotency,
      });
      for (const secret of [
        result.download.descriptor,
        "provider-secret",
        "provider-credential",
        "private/tenant-a/public-report",
        "signed-url-provider-secret-internal",
      ]) {
        assert.equal(serializedDurable.includes(secret), false, secret);
      }
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
