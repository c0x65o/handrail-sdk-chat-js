import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_MESSAGE_REMINDER_CONFLICT_CODE,
  CHAT_MESSAGE_REMINDER_INVALID_REQUEST_CODE,
  MESSAGE_REMINDER_LIST_ROUTE,
  MESSAGE_REMINDER_ROUTE,
  createChatServer,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const route = (conversationId, messageId) =>
  MESSAGE_REMINDER_ROUTE
    .replace(":conversationId", encodeURIComponent(conversationId))
    .replace(":messageId", encodeURIComponent(messageId));

const input = (suffix, overrides = {}) => ({
  operation: "message_reminder.v1",
  intent: "set",
  conversationId: "conversation-a",
  messageId: "message-a",
  expectedReminderRevision: 0,
  idempotencyKey: `http-reminder-${suffix}`,
  dueAt: "2099-01-01T12:00:00.000Z",
  ...overrides,
});

const adapters = {
  auth: {
    async resolveActor(request) {
      if (request.headers.authorization === "Bearer valid") return actor;
      if (request.headers.authorization === "Bearer other") return { ...actor, userId: "other-actor" };
      throw new Error("sensitive authentication provider detail");
    },
  },
  directory: {
    async getUser() {
      throw new Error("message reminder route must not query the directory");
    },
    async searchUsers() {
      throw new Error("message reminder route must not search the directory");
    },
  },
  permissions: {
    async getCapabilities() {
      return [];
    },
    async authorizeEntity() {
      return true;
    },
  },
};

const withServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    return await callback({
      put(path, body, options = {}) {
        return fetch(`${origin}${path}`, {
          method: "PUT",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey
              ? {}
              : { "idempotency-key": options.idempotencyKey ?? body.idempotencyKey }),
          },
          body: options.rawBody ?? JSON.stringify(body),
        });
      },
      get(path, options = {}) {
        return fetch(`${origin}${path}`, {
          headers: { authorization: options.authorization ?? "Bearer valid" },
        });
      },
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await runtime.close();
  }
};

const assertPrivateJson = (response, status) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
};

test("PUT reminder and GET private reminder recovery snapshot mount stable HTTP surfaces", async () => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_reminder_http" });
  const schema = `"${harness.schema.replaceAll('"', '""')}"`;
  try {
    await createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_conversations
         (tenant_id, id, type, visibility, name, current_message_sequence)
       VALUES ('tenant-a', 'conversation-a', 'channel', 'public', 'Public', 1)`,
    );
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_messages
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES ('tenant-a', 'message-a', 'conversation-a', 1, 'author-a',
               'client-a', '{"format":"plain","text":"private body"}'),
              ('tenant-a', 'message-b', 'conversation-a', 2, 'author-a',
               'client-b', '{"format":"plain","text":"second message"}')`,
    );
    const runtime = createChatServer({
      database: { pool: harness.pool, schema: harness.schema },
      ...adapters,
    });
    await withServer(runtime, async ({ put, get }) => {
      const request = input("set");
      const applied = await put(route("conversation-a", "message-a"), request);
      assertPrivateJson(applied, 200);
      const { dueAt: _dueAt, ...requestCorrelation } = request;
      assert.deepEqual(await applied.json(), {
        ...requestCorrelation,
        reconciliationStatus: "applied",
        reminderRevision: 1,
        reminder: {
          privacy: "affected_authenticated_actor",
          state: "scheduled",
          dueAt: request.dueAt,
        },
      });

      const replay = await put(route("conversation-a", "message-a"), request);
      assertPrivateJson(replay, 200);
      assert.equal((await replay.json()).reconciliationStatus, "replayed");

      const stale = input("stale", {
        dueAt: "2099-02-01T12:00:00.000Z",
      });
      const conflict = await put(route("conversation-a", "message-a"), stale);
      assertPrivateJson(conflict, 409);
      assert.equal((await conflict.json()).reconciliationStatus, "revision-conflict");

      const snapshot = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=10`);
      assertPrivateJson(snapshot, 200);
      const recovered = await snapshot.json();
      assert.equal(recovered.kind, "message_reminder_list");
      assert.equal(recovered.privacy, "actor_private");
      assert.deepEqual(recovered.items.map((entry) => entry.messageId), ["message-a"]);
      assert.equal(JSON.stringify(recovered).includes("private body"), false);

      const updated = await put(route("conversation-a", "message-a"), {
        ...request, dueAt: "2099-01-02T12:00:00.000Z", expectedReminderRevision: 1, idempotencyKey: "http-reminder-update",
      });
      assertPrivateJson(updated, 200);
      assert.equal((await updated.json()).reminderRevision, 2);
      const cancelled = await put(route("conversation-a", "message-a"), {
        ...requestCorrelation, intent: "cancel", expectedReminderRevision: 2,
        idempotencyKey: "http-reminder-cancel",
      });
      assertPrivateJson(cancelled, 200);
      assert.equal((await cancelled.json()).reminderRevision, 3);
      const activeOnly = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=1`);
      assert.deepEqual((await activeOnly.json()).items, []);
      const scheduledB = await put(route("conversation-a", "message-b"), {
        ...input("set-b"), messageId: "message-b", dueAt: "2099-01-02T12:00:00.000Z",
      });
      assertPrivateJson(scheduledB, 200);
      const canonicalB = await scheduledB.json();
      for (const inclusion of ["", "&includeCancelled=false"]) {
        const active = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=1${inclusion}`);
        assertPrivateJson(active, 200);
        const snapshot = await active.json();
        assert.deepEqual(snapshot.items.map(({ messageId }) => messageId), ["message-b"]);
        assert.equal(snapshot.page.nextCursor, null);
      }
      for (const inclusion of ["1", "TRUE", "", "true&includeCancelled=false"]) {
        const invalid = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=1&includeCancelled=${inclusion}`);
        assertPrivateJson(invalid, 400);
      }
      const authority = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=1&includeCancelled=true`);
      assertPrivateJson(authority, 200);
      const cancelledSnapshot = await authority.json();
      assert.equal(cancelledSnapshot.items[0].reminderRevision, 3);
      assert.equal(cancelledSnapshot.items[0].reminder.state, "cancelled");
      assert.equal(cancelledSnapshot.items[0].reminder.dueAt, undefined);
      assert.equal(new Date(cancelledSnapshot.items[0].lastScheduledDueAt).toISOString(), "2099-01-02T12:00:00.000Z");
      assert.ok(cancelledSnapshot.page.nextCursor);
      const next = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=1&includeCancelled=true&cursor=${encodeURIComponent(cancelledSnapshot.page.nextCursor)}`);
      assertPrivateJson(next, 200);
      const scheduledPage = await next.json();
      assert.deepEqual(scheduledPage.items.map(({ messageId }) => messageId), ["message-b"]);
      assert.equal(scheduledPage.items[0].reminderRevision, canonicalB.reminderRevision);
      assert.equal(new Date(scheduledPage.items[0].reminder.dueAt).toISOString(), canonicalB.reminder.dueAt);
      assert.equal(scheduledPage.page.nextCursor, null);
      const otherActor = await get(`${MESSAGE_REMINDER_LIST_ROUTE}?limit=1&includeCancelled=true`, { authorization: "Bearer other" });
      assert.deepEqual((await otherActor.json()).items, []);
      const rescheduled = await put(route("conversation-a", "message-a"), {
        ...request, expectedReminderRevision: cancelledSnapshot.items[0].reminderRevision,
        idempotencyKey: "http-reminder-reschedule",
      });
      assertPrivateJson(rescheduled, 200);
      assert.equal((await rescheduled.json()).reconciliationStatus, "applied");

      const malformed = await put(route("conversation-a", "message-a"), request, {
        omitIdempotencyKey: true,
      });
      assertPrivateJson(malformed, 400);
      assert.deepEqual(await malformed.json(), {
        error: {
          code: CHAT_MESSAGE_REMINDER_INVALID_REQUEST_CODE,
          message: "Invalid message-reminder request",
        },
      });

      const wrongHeader = await put(route("conversation-a", "message-a"), request, {
        idempotencyKey: "different-key",
      });
      assertPrivateJson(wrongHeader, 400);

      const reused = await put(route("conversation-a", "message-a"), {
        ...request,
        dueAt: "2099-03-01T12:00:00.000Z",
      });
      assertPrivateJson(reused, 409);
      assert.deepEqual(await reused.json(), {
        error: {
          code: CHAT_MESSAGE_REMINDER_CONFLICT_CODE,
          message: "Message-reminder request conflicts with current server state",
        },
      });

      const unauthenticated = await put(route("conversation-a", "message-a"), input("auth"), {
        authorization: "Bearer invalid",
      });
      assertPrivateJson(unauthenticated, 401);
      assert.equal((await unauthenticated.json()).error.code, CHAT_AUTHENTICATION_ERROR_CODE);
    });
  } finally {
    await harness.teardown();
    await backend.teardown();
  }
});
