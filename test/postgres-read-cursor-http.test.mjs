import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseReadCursorMutationResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_READ_CURSOR_CONFLICT_CODE,
  CHAT_READ_CURSOR_INVALID_REQUEST_CODE,
  CHAT_READ_CURSOR_SEQUENCE_CONFLICT_CODE,
  READ_CURSOR_ROUTE_SUFFIX,
  UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "reader-a",
  roles: Object.freeze(["sensitive-host-role"]),
});

const markRead = (conversationId, throughSequence, suffix) => ({
  operation: "mark_read",
  conversationId,
  throughSequence,
  idempotencyKey: `read-http-${suffix}`,
});

const markUnread = (conversationId, fromSequence, suffix) => ({
  operation: "mark_unread",
  conversationId,
  fromSequence,
  idempotencyKey: `read-http-${suffix}`,
});

const route = (conversationId) =>
  `/conversations/${conversationId}${READ_CURSOR_ROUTE_SUFFIX}`;

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const rawRequest = (
      path,
      { body = "", headers = [], sendBody = true } = {},
    ) =>
      new Promise((resolve, reject) => {
        let timeout;
        const request = httpRequest(
          `${origin}${path}`,
          {
            method: "PATCH",
            headers: ["host", new URL(origin).host, ...headers],
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              clearTimeout(timeout);
              if (!request.writableEnded) request.destroy();
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        if (sendBody) {
          request.end(body);
          return;
        }
        timeout = setTimeout(() => {
          request.destroy();
          reject(new Error("server did not reject the declared length early"));
        }, 5_000);
        request.flushHeaders();
      });

    return await callback({
      request(path, requestInput, options = {}) {
        const body = options.body ?? JSON.stringify(requestInput);
        const idempotencyKey =
          options.idempotencyKey === undefined
            ? requestInput?.idempotencyKey
            : options.idempotencyKey;
        return fetch(`${origin}${path}`, {
          method: "PATCH",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey === true ||
            idempotencyKey === undefined
              ? {}
              : { "idempotency-key": idempotencyKey }),
          },
          body,
        });
      },
      rawRequest,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body, { error: { code, message } });
  return body;
};

test("PATCH /conversations/:conversationId/read-cursor mounts the private read-state command", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_cursor_http" });
  const quoteIdentifier = (identifier) =>
    `"${identifier.replaceAll('"', '""')}"`;
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const cursors = `${schema}.chat_read_cursors`;
  const audits = `${schema}.chat_audit_events`;
  const outbox = `${schema}.chat_outbox_events`;
  const idempotency = `${schema}.chat_idempotency_keys`;
  let commandConnectCount = 0;

  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES
         ('tenant-a', 'read-target', 'channel', 'private', 'Read target', 8),
         ('tenant-a', 'retry-target', 'channel', 'private', 'Retry target', 5),
         ('tenant-a', 'conflict-target', 'channel', 'private', 'Conflict target', 4),
         ('tenant-a', 'nonmember-target', 'channel', 'private', 'Nonmember', 2),
         ('tenant-b', 'cross-tenant-target', 'channel', 'private', 'Cross tenant', 2)`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'read-target', 'reader-a', 'member', 'active'),
         ('tenant-a', 'retry-target', 'reader-a', 'member', 'active'),
         ('tenant-a', 'conflict-target', 'reader-a', 'member', 'active'),
         ('tenant-a', 'nonmember-target', 'other-user', 'member', 'active'),
         ('tenant-b', 'cross-tenant-target', 'reader-a', 'member', 'active')`,
    );

    const instrumentedDatabase = {
      query(...args) {
        return harness.pool.query(...args);
      },
      async connect() {
        commandConnectCount += 1;
        return harness.pool.connect();
      },
    };
    const runtime = createChatServer({
      database: { pool: instrumentedDatabase, schema: harness.schema },
      auth: {
        async resolveActor(request) {
          if (request.headers.authorization === "Bearer valid") return actor;
          throw new Error("sensitive authentication-provider detail");
        },
      },
      directory: {
        async getUser() {
          throw new Error("read-cursor route must not query the directory");
        },
        async searchUsers() {
          throw new Error("read-cursor route must not search the directory");
        },
      },
      permissions: {
        async getCapabilities() {
          return [];
        },
        async authorizeEntity() {
          throw new Error("read-cursor membership is enforced by the command");
        },
      },
    });

    const sideEffectCounts = async (conversationId, idempotencyKey) =>
      (
        await harness.pool.query(
          `SELECT
             (SELECT count(*)::integer FROM ${cursors}
               WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3)
               AS cursor_count,
             (SELECT count(*)::integer FROM ${audits}
               WHERE tenant_id = $1 AND target_id = $2
                 AND action = 'conversation.read_cursor_updated')
               AS audit_count,
             (SELECT count(*)::integer FROM ${outbox}
               WHERE tenant_id = $1 AND stream_id = $4
                 AND type = 'conversation.read_cursor_updated'
                 AND payload->>'conversationId' = $2)
               AS outbox_count,
             (SELECT count(*)::integer FROM ${idempotency}
               WHERE tenant_id = $1 AND user_id = $3
                 AND operation_name = $5 AND client_key = $6)
               AS idempotency_count`,
          [
            actor.tenantId,
            conversationId,
            actor.userId,
            `user:${actor.userId}`,
            UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
            idempotencyKey,
          ],
        )
      ).rows[0];

    await withHttpServer(runtime, async ({ request, rawRequest }) => {
      await t.test("returns the exact canonical actor-private response and advances monotonically", async () => {
        const before = commandConnectCount;
        const initial = markRead("read-target", 3, "initial");
        const initialResponse = await request(route("read-target"), initial);
        assert.equal(commandConnectCount, before + 1);
        assert.equal(initialResponse.status, 200);
        assert.equal(
          initialResponse.headers.get("content-type"),
          "application/json; charset=utf-8",
        );
        assert.equal(
          initialResponse.headers.get("cache-control"),
          "private, no-store",
        );
        const initialJson = await initialResponse.json();
        assert.deepEqual(initialJson, {
          operation: "mark_read",
          conversationId: "read-target",
          readState: {
            conversationId: "read-target",
            userId: actor.userId,
            lastReadSequence: 3,
            updatedAt: initialJson.readState.updatedAt,
          },
          latestSequence: 8,
          unreadCount: 5,
        });
        assert.deepEqual(parseReadCursorMutationResult(initialJson), initialJson);
        assert.deepEqual(Object.keys(initialJson), [
          "operation",
          "conversationId",
          "readState",
          "latestSequence",
          "unreadCount",
        ]);
        assert.equal("tenantId" in initialJson, false);
        assert.equal("roles" in initialJson, false);
        assert.equal("idempotencyKey" in initialJson, false);
        assert.equal("actorUserId" in initialJson, false);
        assert.equal(initialJson.readState.userId, actor.userId);

        const advanced = await request(
          route("read-target"),
          markRead("read-target", 6, "advance"),
        );
        assert.equal((await advanced.json()).readState.lastReadSequence, 6);

        const unread = await request(
          route("read-target"),
          markUnread("read-target", 4, "unread"),
        );
        const unreadJson = await unread.json();
        assert.equal(unreadJson.readState.lastReadSequence, 6);
        assert.equal(unreadJson.readState.manualUnreadFromSequence, 4);
        assert.equal(unreadJson.unreadCount, 5);

        const cleared = await request(
          route("read-target"),
          markRead("read-target", 6, "clear"),
        );
        const clearedJson = await cleared.json();
        assert.equal(clearedJson.readState.lastReadSequence, 6);
        assert.equal("manualUnreadFromSequence" in clearedJson.readState, false);
        assert.equal(clearedJson.unreadCount, 2);
      });

      await t.test("replays an identical key without duplicating durable effects", async () => {
        const input = markRead("retry-target", 4, "retry");
        const first = await request(route("retry-target"), input);
        const firstJson = await first.json();
        const beforeRetry = commandConnectCount;
        const retry = await request(route("retry-target"), input);
        assert.equal(commandConnectCount, beforeRetry + 1);
        assert.deepEqual(await retry.json(), firstJson);
        assert.deepEqual(
          await sideEffectCounts("retry-target", input.idempotencyKey),
          { cursor_count: 1, audit_count: 1, outbox_count: 1, idempotency_count: 1 },
        );
      });

      await t.test("maps regression and sequence bounds to one safe state conflict", async () => {
        for (const invalidInput of [
          markRead("read-target", 5, "regression"),
          markRead("read-target", 9, "future"),
          markUnread("read-target", 7, "unread-range"),
        ]) {
          await assertStableError(
            await request(route("read-target"), invalidInput),
            409,
            CHAT_READ_CURSOR_SEQUENCE_CONFLICT_CODE,
            "Read cursor conflicts with current conversation state",
          );
        }
        const persisted = (
          await harness.pool.query(
            `SELECT last_read_sequence::integer AS last_read_sequence,
                    manual_unread_from_sequence
               FROM ${cursors}
              WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
            [actor.tenantId, "read-target", actor.userId],
          )
        ).rows[0];
        assert.deepEqual(persisted, {
          last_read_sequence: 6,
          manual_unread_from_sequence: null,
        });
      });

      await t.test("rejects malformed, ambiguous, mismatched, and spoofed transport input before command work", async () => {
        const valid = markRead("read-target", 6, "invalid-base");
        const malformedCases = [
          () => request(`${route("read-target")}?tenantId=tenant-b`, valid),
          () => request(route("read-target"), { ...valid, conversationId: "other" }),
          () => request("/conversations/read%2Ftarget/read-cursor", valid),
          () => request("/conversations//read-cursor", valid),
          () => request(route("read-target"), valid, { contentType: "text/plain" }),
          () => request(route("read-target"), valid, { body: "{" }),
          () => request(route("read-target"), { ...valid, unknown: true }),
          () => request(route("read-target"), { ...valid, tenantId: "tenant-b" }),
          () => request(route("read-target"), { ...valid, user_id: "other" }),
          () => request(route("read-target"), { ...valid, actor: actor }),
          () => request(route("read-target"), { ...valid, roles: ["owner"] }),
          () => request(route("read-target"), valid, { omitIdempotencyKey: true }),
          () => request(route("read-target"), valid, { idempotencyKey: "mismatch" }),
          () =>
            request(route("read-target"), {
              ...valid,
              idempotencyKey: "unsafe/key",
            }),
          () => request(route("read-target"), markUnread("read-target", 0, "zero")),
          () => request(route("read-target"), valid, { body: "" }),
        ];
        const before = commandConnectCount;
        for (const send of malformedCases) {
          await assertStableError(
            await send(),
            400,
            CHAT_READ_CURSOR_INVALID_REQUEST_CODE,
            "Invalid read-cursor request",
          );
        }

        const duplicate = await rawRequest(route("read-target"), {
          body: JSON.stringify(valid),
          headers: [
            "authorization",
            "Bearer valid",
            "content-type",
            "application/json",
            "idempotency-key",
            valid.idempotencyKey,
            "idempotency-key",
            valid.idempotencyKey,
          ],
        });
        await assertStableError(
          duplicate,
          400,
          CHAT_READ_CURSOR_INVALID_REQUEST_CODE,
          "Invalid read-cursor request",
        );

        assert.equal(commandConnectCount, before);
      });

      await t.test("keeps nonmember and cross-tenant failures indistinguishable and maps authentication", async () => {
        for (const conversationId of ["nonmember-target", "cross-tenant-target"]) {
          await assertStableError(
            await request(
              route(conversationId),
              markRead(conversationId, 1, `authorization-${conversationId}`),
            ),
            403,
            CHAT_AUTHORIZATION_ERROR_CODE,
            "Chat authorization failed",
          );
        }
        await assertStableError(
          await request(
            route("read-target"),
            markRead("read-target", 6, "authentication"),
            { authorization: "Bearer invalid" },
          ),
          401,
          CHAT_AUTHENTICATION_ERROR_CODE,
          "Chat authentication failed",
        );
      });

      await t.test("maps conflicting idempotency-key reuse without changing the cursor", async () => {
        const firstInput = markRead("conflict-target", 2, "conflict");
        assert.equal((await request(route("conflict-target"), firstInput)).status, 200);
        await assertStableError(
          await request(route("conflict-target"), {
            ...firstInput,
            throughSequence: 3,
          }),
          409,
          CHAT_READ_CURSOR_CONFLICT_CODE,
          "Read-cursor request conflicts with current server state",
        );
        const stored = (
          await harness.pool.query(
            `SELECT last_read_sequence::integer AS last_read_sequence
               FROM ${cursors}
              WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
            [actor.tenantId, "conflict-target", actor.userId],
          )
        ).rows[0];
        assert.equal(stored.last_read_sequence, 2);
      });
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
