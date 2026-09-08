import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { parseForwardMessageResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_MESSAGE_FORWARD_ATTACHMENTS_UNSUPPORTED_CODE,
  CHAT_MESSAGE_FORWARD_CONFLICT_CODE,
  CHAT_MESSAGE_FORWARD_INVALID_REQUEST_CODE,
  CHAT_MESSAGE_FORWARD_SOURCE_UNAVAILABLE_CODE,
  FORWARD_MESSAGE_ROUTE,
  MAX_FORWARD_MESSAGE_REQUEST_BYTES,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const actor = Object.freeze({
  tenantId: "tenant-http",
  userId: "forwarder-http",
  roles: Object.freeze(["employee"]),
});

const requestInput = (suffix, overrides = {}) => ({
  operation: "forward_message.v1",
  sourceMessageId: "source-message-http",
  destinationConversationId: "destination-http",
  clientCorrelationId: `correlation-${suffix}`,
  idempotencyKey: `forward-${suffix}`,
  ...overrides,
});

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

test("POST /messages/forward validates transport and uses the real PostgreSQL command", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "forward_http" });
  const schema = quoteIdentifier(harness.schema);
  const tables = {
    conversations: `${schema}.chat_conversations`,
    members: `${schema}.chat_conversation_members`,
    messages: `${schema}.chat_messages`,
    attachments: `${schema}.chat_attachments`,
  };
  let capabilities = ["message.send"];

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES
         ('tenant-http', 'source-http', 'channel', 'private', 'Source', 2),
         ('tenant-http', 'destination-http', 'channel', 'private', 'Destination', 0)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-http', 'source-http', 'forwarder-http', 'member', 'active'),
         ('tenant-http', 'destination-http', 'forwarder-http', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages} (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, current_revision,
         created_at, updated_at
       ) VALUES
         ('tenant-http', 'source-message-http', 'source-http', 1, 'author-http',
          'seed-source-http', '{"format":"plain","text":"Frozen HTTP source"}'::jsonb,
          1, '2026-08-20T12:30:00Z', '2026-08-20T12:30:00Z'),
         ('tenant-http', 'attached-source-http', 'source-http', 2, 'author-http',
          'seed-attached-http', '{"format":"plain","text":"Attached HTTP source"}'::jsonb,
          1, '2026-08-20T12:31:00Z', '2026-08-20T12:31:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.attachments} (
         tenant_id, id, uploader_user_id, storage_key, file_name,
         content_type, size_bytes, checksum, created_at, updated_at, expires_at
       ) VALUES (
         'tenant-http', 'attachment-http', 'forwarder-http',
         'tenant-http/attachment-http', 'attachment.txt', 'text/plain', 12,
         $1, '2026-08-20T12:30:00Z',
         '2026-08-20T12:30:00Z', '2099-01-01T00:00:00Z'
       )`,
      [`sha256:${"a".repeat(64)}`],
    );
    await harness.pool.query(
      `UPDATE ${tables.attachments}
       SET state = 'attached', attached_message_id = 'attached-source-http',
           attached_at = '2026-08-20T12:32:00Z',
           updated_at = '2026-08-20T12:32:00Z'
       WHERE tenant_id = 'tenant-http' AND id = 'attachment-http'`,
    );

    const runtime = createChatServer({
      database: { pool: harness.pool, schema: harness.schema },
      auth: {
        async resolveActor(request) {
          if (request.headers.authorization !== "Bearer valid") {
            throw new Error("sensitive auth provider detail");
          }
          return actor;
        },
      },
      directory: {
        async getUser({ userId }) {
          return {
            tenantId: actor.tenantId,
            userId,
            displayName: "Frozen HTTP Author",
          };
        },
        async searchUsers() {
          throw new Error("forward must not search the directory");
        },
      },
      permissions: {
        async getCapabilities() {
          return capabilities;
        },
        async authorizeEntity() {
          return true;
        },
      },
    });

    await withHttpServer(runtime, async (origin) => {
      const post = (body, options = {}) =>
        fetch(`${origin}${FORWARD_MESSAGE_ROUTE}${options.query ?? ""}`, {
          method: "POST",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey
              ? {}
              : { "idempotency-key": options.idempotencyKey ?? body.idempotencyKey }),
          },
          body: options.rawBody ?? JSON.stringify(body),
        });

      const canonicalInput = requestInput("applied");
      const appliedResponse = await post(canonicalInput);
      assert.equal(appliedResponse.status, 201);
      assert.equal(appliedResponse.headers.get("cache-control"), "private, no-store");
      const applied = parseForwardMessageResult(await appliedResponse.json(), canonicalInput);
      assert.equal(applied.reconciliationStatus, "applied");
      assert.equal(applied.message.content.forwarded.originalAuthor.displayName, "Frozen HTTP Author");

      const replayResponse = await post(canonicalInput);
      assert.equal(replayResponse.status, 200);
      const replay = parseForwardMessageResult(await replayResponse.json(), canonicalInput);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.message, applied.message);

      await assertStableError(
        await post({ ...canonicalInput, destinationConversationId: "different" }),
        409,
        CHAT_MESSAGE_FORWARD_CONFLICT_CODE,
        "Message forward conflicts with current server state",
      );

      for (const invalidRequest of [
        () => post({ ...requestInput("identity"), tenantId: "spoofed" }),
        () => post({ ...requestInput("content"), content: { format: "plain", text: "spoofed" } }),
        () => post(requestInput("missing-key"), { omitIdempotencyKey: true }),
        () => post(requestInput("mismatch"), { idempotencyKey: "different" }),
        () => post(requestInput("query"), { query: "?unexpected=true" }),
        () => post(requestInput("content-type"), { contentType: "text/plain" }),
        () => post(requestInput("malformed"), { rawBody: "{" }),
        () => post(requestInput("oversize"), { rawBody: `{"padding":"${"x".repeat(MAX_FORWARD_MESSAGE_REQUEST_BYTES)}"}` }),
      ]) {
        await assertStableError(
          await invalidRequest(),
          400,
          CHAT_MESSAGE_FORWARD_INVALID_REQUEST_CODE,
          "Invalid message forward request",
        );
      }

      await assertStableError(
        await post(requestInput("unauthenticated"), { authorization: "Bearer invalid" }),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      capabilities = [];
      const denied = await post(requestInput("capability"));
      assert.equal(denied.status, 403);
      capabilities = ["message.send"];

      await assertStableError(
        await post(requestInput("missing-source", { sourceMessageId: "missing" })),
        404,
        CHAT_MESSAGE_FORWARD_SOURCE_UNAVAILABLE_CODE,
        "Source message is unavailable",
      );
      await assertStableError(
        await post(requestInput("attachment", { sourceMessageId: "attached-source-http" })),
        422,
        CHAT_MESSAGE_FORWARD_ATTACHMENTS_UNSUPPORTED_CODE,
        "Source message attachments cannot be forwarded",
      );
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
