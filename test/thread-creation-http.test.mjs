import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseThreadCreationResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_THREAD_CREATION_CONFLICT_CODE,
  CHAT_THREAD_CREATION_INVALID_REQUEST_CODE,
  CHAT_THREAD_CREATION_UNAVAILABLE_CODE,
  CREATE_THREAD_ENTITY_POLICY_ACTION,
  MAX_THREAD_CREATION_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const input = (suffix, overrides = {}) => ({
  operation: "create_thread",
  parentConversationId: "parent-main",
  rootMessageId: "root-main",
  initialFollow: true,
  idempotencyKey: `thread-http-${suffix}`,
  ...overrides,
});

const withHttpServer = async (runtime, callback) => {
  const server = createServer({ joinDuplicateHeaders: true }, runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const rawRequest = (path, { body = "", headers = [] } = {}) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          `${origin}${path}`,
          { method: "POST", headers: ["host", new URL(origin).host, ...headers] },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: response.statusCode,
                headers: new Headers(response.headers),
                text: async () => text,
                json: async () => JSON.parse(text),
              });
            });
          },
        );
        request.on("error", reject);
        request.end(body);
      });

    return await callback({
      request(path, requestInput, options = {}) {
        const body = options.body ?? JSON.stringify(requestInput);
        const idempotencyKey =
          options.idempotencyKey === undefined
            ? requestInput?.idempotencyKey
            : options.idempotencyKey;
        return fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            authorization: options.authorization ?? "Bearer valid",
            "content-type": options.contentType ?? "application/json",
            ...(options.omitIdempotencyKey === true || idempotencyKey === undefined
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
  assert.deepEqual(await response.json(), { error: { code, message } });
};

const createScriptedThreadDatabase = () => {
  const parents = new Map([
    ["tenant-a\0parent-main", {
      visibility: "public", entityType: null, entityId: null,
      rootMessageId: "root-main",
    }],
    ["tenant-a\0parent-conflict", {
      visibility: "public", entityType: null, entityId: null,
      rootMessageId: "root-conflict",
    }],
    ["tenant-a\0parent-progress", {
      visibility: "public", entityType: null, entityId: null,
      rootMessageId: "root-progress",
    }],
    ["tenant-a\0parent-entity", {
      visibility: "public", entityType: "order", entityId: "42",
      rootMessageId: "root-entity",
    }],
    ["tenant-b\0parent-cross-tenant", {
      visibility: "public", entityType: null, entityId: null,
      rootMessageId: "root-cross-tenant",
    }],
  ]);
  const emptyState = () => ({
    threads: new Map(),
    idempotency: new Map(),
    audit: new Map(),
    outbox: new Map(),
  });
  let committed = emptyState();
  let connectCount = 0;
  let directQueryCount = 0;
  let inProgressKey;

  const resource = {
    async query(sql) {
      directQueryCount += 1;
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ exists: false }] };
      }
      throw new Error(`unexpected direct thread HTTP query: ${sql}`);
    },
    async connect() {
      connectCount += 1;
      let working = structuredClone(committed);
      let active = false;
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") {
            active = true;
            working = structuredClone(committed);
            return { rows: [], rowCount: null };
          }
          if (sql === "COMMIT") {
            committed = working;
            active = false;
            return { rows: [], rowCount: null };
          }
          if (sql === "ROLLBACK") {
            active = false;
            return { rows: [], rowCount: null };
          }
          assert.equal(active, true, "command SQL must execute in one transaction");

          if (sql.includes("claim_chat_idempotency_key")) {
            const [tenantId, userId, operation, key, requestHash] = values;
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const current = working.idempotency.get(identity);
            if (current !== undefined && current.requestHash !== requestHash) {
              return { rows: [], rowCount: 0 };
            }
            if (current !== undefined) {
              return {
                rows: [{
                  idempotency_state: current.state,
                  stored_response_body: current.responseBody,
                }],
                rowCount: 1,
              };
            }
            working.idempotency.set(identity, {
              requestHash,
              state: "pending",
              responseBody: null,
            });
            return {
              rows: [{ idempotency_state: "pending", stored_response_body: null }],
              rowCount: 1,
            };
          }
          if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
            return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
          }
          if (sql.includes("chat_conversations AS parent")) {
            const [tenantId, , parentConversationId, rootMessageId] = values;
            const parent = parents.get(`${tenantId}\0${parentConversationId}`);
            if (parent === undefined || parent.rootMessageId !== rootMessageId) {
              return { rows: [], rowCount: 0 };
            }
            return {
              rows: [{
                visibility: parent.visibility,
                entity_type: parent.entityType,
                entity_id: parent.entityId,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("SELECT conversation.id, conversation.archived_at")) {
            const [tenantId, parentConversationId, rootMessageId] = values;
            const thread = [...working.threads.values()].find(
              (candidate) =>
                candidate.tenantId === tenantId &&
                candidate.parentConversationId === parentConversationId &&
                candidate.rootMessageId === rootMessageId,
            );
            return {
              rows: thread === undefined
                ? []
                : [{ id: thread.id, archived_at: null }],
              rowCount: thread === undefined ? 0 : 1,
            };
          }
          if (sql === "SELECT clock_timestamp() AS occurred_at") {
            return {
              rows: [{ occurred_at: "2030-01-01T00:00:00.000Z" }],
              rowCount: 1,
            };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_conversations") &&
            sql.includes("parent_conversation_id")
          ) {
            const [tenantId, id, visibility, parentConversationId, rootMessageId,
              createdAt] = values;
            working.threads.set(id, {
              tenantId,
              id,
              visibility,
              parentConversationId,
              rootMessageId,
              createdAt,
              role: "owner",
              memberUpdatedAt: createdAt,
            });
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_conversation_members")
          ) {
            const [, conversationId, , role, updatedAt] = values;
            const thread = working.threads.get(conversationId);
            thread.role = role;
            thread.memberUpdatedAt = updatedAt;
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("INSERT INTO") &&
            (sql.includes("chat_read_cursors") ||
              sql.includes("chat_conversation_preferences") ||
              sql.includes("chat_thread_follows"))
          ) {
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("SELECT conversation.id, conversation.visibility")
          ) {
            const [, , conversationId] = values;
            const thread = working.threads.get(conversationId);
            if (thread === undefined) return { rows: [], rowCount: 0 };
            return {
              rows: [{
                id: thread.id,
                visibility: thread.visibility,
                parent_conversation_id: thread.parentConversationId,
                root_message_id: thread.rootMessageId,
                current_message_sequence: 0,
                created_at: thread.createdAt,
                updated_at: thread.createdAt,
                member_role: thread.role,
                member_state: "active",
                member_joined_at: thread.createdAt,
                member_updated_at: thread.memberUpdatedAt,
                last_read_sequence: 0,
                manual_unread_from_sequence: null,
                read_updated_at: thread.createdAt,
                notification_level: "all",
                muted: false,
                muted_until: null,
                preference_updated_at: thread.createdAt,
                member_user_ids: [actor.userId],
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("SELECT count(reply.id)::integer")) {
            return {
              rows: [{
                reply_count: 0,
                participant_ids: [],
                unread_count: 0,
                last_reply_at: null,
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("chat_audit_events")) {
            const conversationId = values[3];
            working.audit.set(
              conversationId,
              (working.audit.get(conversationId) ?? 0) + 1,
            );
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("chat_outbox_events")) {
            const streamId = values[3];
            working.outbox.set(streamId, (working.outbox.get(streamId) ?? 0) + 1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
            const [, responseBody, tenantId, userId, operation, key, requestHash] =
              values;
            if (key === inProgressKey) return { rows: [], rowCount: 0 };
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const current = working.idempotency.get(identity);
            if (current === undefined || current.requestHash !== requestHash) {
              return { rows: [], rowCount: 0 };
            }
            working.idempotency.set(identity, {
              requestHash,
              state: "completed",
              responseBody: structuredClone(responseBody),
            });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected thread command query: ${sql}`);
        },
        release() {},
      };
    },
  };

  return {
    resource,
    get connectCount() { return connectCount; },
    get directQueryCount() { return directQueryCount; },
    setInProgressKey(value) { inProgressKey = value; },
    messageCount() { return 0; },
  };
};

test("POST /messages/:messageId/thread mounts canonical thread creation", async (t) => {
  const database = createScriptedThreadDatabase();
  let capabilities = ["thread.create"];
  let entityAllowed = true;
  const actorCalls = [];
  const entityCalls = [];

  const runtime = createChatServer({
      database: { pool: database.resource },
      auth: {
        async resolveActor(request) {
          if (request.headers.authorization !== "Bearer valid") {
            throw new Error("sensitive authentication provider detail");
          }
          return actor;
        },
      },
      directory: {
        async getUser() {
          throw new Error("thread creation must not query the directory");
        },
        async searchUsers() {
          throw new Error("thread creation must not query the directory");
        },
      },
      permissions: {
        async getCapabilities({ actor: trustedActor }) {
          actorCalls.push(trustedActor);
          return capabilities;
        },
        async authorizeEntity(request) {
          entityCalls.push(request);
          return entityAllowed;
        },
      },
    });

    await withHttpServer(runtime, async ({ request, rawRequest }) => {
      await t.test("returns created, existing-for-root, and stable replay results", async () => {
        const createdInput = input("created");
        const createdResponse = await request(
          "/messages/root-main/thread",
          createdInput,
        );
        assert.equal(createdResponse.status, 201);
        assert.equal(
          createdResponse.headers.get("content-type"),
          "application/json; charset=utf-8",
        );
        assert.equal(
          createdResponse.headers.get("cache-control"),
          "private, no-store",
        );
        const createdText = await createdResponse.text();
        const created = parseThreadCreationResult(
          JSON.parse(createdText),
          createdInput,
        );
        assert.equal(createdText, JSON.stringify(created));
        assert.equal(created.reconciliationStatus, "created");
        assert.equal(created.conversation.conversation.type, "thread");
        assert.equal(created.conversation.conversation.tenantId, actor.tenantId);
        assert.equal(created.conversation.conversation.latestSequence, 0);
        assert.deepEqual(created.rootThreadSummary, {
          threadId: created.conversation.conversation.id,
          replyCount: 0,
          participantIds: [],
          unreadCount: 0,
        });

        const existingInput = input("existing");
        const existingResponse = await request(
          "/messages/root-main/thread",
          existingInput,
        );
        assert.equal(existingResponse.status, 200);
        const existing = parseThreadCreationResult(
          await existingResponse.json(),
          existingInput,
        );
        assert.equal(existing.reconciliationStatus, "existing_for_root");
        assert.equal(
          existing.conversation.conversation.id,
          created.conversation.conversation.id,
        );

        const replayResponse = await request(
          "/messages/root-main/thread",
          createdInput,
        );
        const replay = await replayResponse.json();
        const repeatedReplayResponse = await request(
          "/messages/root-main/thread",
          createdInput,
        );
        const repeatedReplay = await repeatedReplayResponse.json();
        assert.equal(replayResponse.status, 200);
        assert.equal(repeatedReplayResponse.status, 200);
        assert.equal(replay.reconciliationStatus, "replayed");
        assert.deepEqual(repeatedReplay, replay);
        assert.equal(
          replay.conversation.conversation.id,
          created.conversation.conversation.id,
        );

        assert.equal(
          database.messageCount(created.conversation.conversation.id),
          0,
        );
        assert.ok(
          actorCalls.every(
            (trustedActor) =>
              assert.deepEqual(trustedActor, actor) === undefined,
          ),
        );
      });

      await t.test("rejects malformed paths, bodies, and idempotency before database work", async () => {
        const valid = input("invalid-base");
        const invalidRequests = [
          () => request("/messages//thread", valid),
          () => request("/messages/root%2Fmain/thread", valid),
          () => request("/messages/root-main/thread/extra", valid),
          () => request("/messages/root-main/thread?unexpected=true", valid),
          () => request("/messages/root-other/thread", valid),
          () => request("/messages/root-main/thread", { ...valid, unknown: true }),
          () => request("/messages/root-main/thread", { ...valid, tenantId: "tenant-b" }),
          () => request("/messages/root-main/thread", { ...valid, firstReply: "not accepted" }),
          () => request("/messages/root-main/thread", valid, { body: "{" }),
          () => request("/messages/root-main/thread", valid, { contentType: "text/plain" }),
          () => request("/messages/root-main/thread", valid, { omitIdempotencyKey: true }),
          () => request("/messages/root-main/thread", valid, { idempotencyKey: "other-key" }),
          () => request(
            "/messages/root-main/thread",
            { ...valid, idempotencyKey: "bad,key" },
            { idempotencyKey: "bad,key" },
          ),
          () => request("/messages/root-main/thread", valid, {
            body: JSON.stringify({ ...valid, idempotencyKey: undefined }),
          }),
          () => request("/messages/root-main/thread", valid, {
            body: JSON.stringify({
              ...valid,
              parentConversationId: "x".repeat(MAX_THREAD_CREATION_REQUEST_BYTES),
            }),
          }),
        ];
        for (const makeRequest of invalidRequests) {
          const beforeDirectQueries = database.directQueryCount;
          const beforeConnects = database.connectCount;
          await assertStableError(
            await makeRequest(),
            400,
            CHAT_THREAD_CREATION_INVALID_REQUEST_CODE,
            "Invalid thread creation request",
          );
          assert.equal(database.directQueryCount, beforeDirectQueries);
          assert.equal(database.connectCount, beforeConnects);
        }

        const duplicateBody = JSON.stringify(valid);
        const beforeDirectQueries = database.directQueryCount;
        const beforeConnects = database.connectCount;
        const duplicate = await rawRequest("/messages/root-main/thread", {
          body: duplicateBody,
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "idempotency-key", valid.idempotencyKey,
            "idempotency-key", valid.idempotencyKey,
            "content-length", String(Buffer.byteLength(duplicateBody)),
          ],
        });
        await assertStableError(
          duplicate,
          400,
          CHAT_THREAD_CREATION_INVALID_REQUEST_CODE,
          "Invalid thread creation request",
        );
        assert.equal(database.directQueryCount, beforeDirectQueries);
        assert.equal(database.connectCount, beforeConnects);

        const beforeOverDeclaredDirectQueries = database.directQueryCount;
        const beforeOverDeclaredConnects = database.connectCount;
        const overDeclared = await rawRequest("/messages/root-main/thread", {
          body: duplicateBody,
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "idempotency-key", valid.idempotencyKey,
            "content-length", String(MAX_THREAD_CREATION_REQUEST_BYTES + 1),
          ],
        });
        await assertStableError(
          overDeclared,
          400,
          CHAT_THREAD_CREATION_INVALID_REQUEST_CODE,
          "Invalid thread creation request",
        );
        assert.equal(
          database.directQueryCount,
          beforeOverDeclaredDirectQueries,
        );
        assert.equal(database.connectCount, beforeOverDeclaredConnects);
      });

      await t.test("maps authentication and all inaccessible roots to safe boundaries", async () => {
        await assertStableError(
          await request(
            "/messages/root-main/thread",
            input("unauthenticated"),
            { authorization: "Bearer invalid" },
          ),
          401,
          CHAT_AUTHENTICATION_ERROR_CODE,
          "Chat authentication failed",
        );

        capabilities = [];
        await assertStableError(
          await request(
            "/messages/root-main/thread",
            input("capability-denied"),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
        capabilities = ["thread.create"];

        entityAllowed = false;
        await assertStableError(
          await request(
            "/messages/root-entity/thread",
            input("entity-denied", {
              parentConversationId: "parent-entity",
              rootMessageId: "root-entity",
            }),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
        assert.deepEqual(entityCalls.at(-1), {
          actor,
          entity: { type: "order", id: "42" },
          action: CREATE_THREAD_ENTITY_POLICY_ACTION,
        });
        entityAllowed = true;

        const inaccessible = [
          input("wrong-parent", { parentConversationId: "parent-conflict" }),
          input("missing", {
            parentConversationId: "parent-missing",
            rootMessageId: "root-missing",
          }),
          input("cross-tenant", {
            parentConversationId: "parent-cross-tenant",
            rootMessageId: "root-cross-tenant",
          }),
        ];
        const bodies = [];
        for (const requestInput of inaccessible) {
          const response = await request(
            `/messages/${requestInput.rootMessageId}/thread`,
            requestInput,
          );
          assert.equal(response.status, 403);
          bodies.push(await response.json());
        }
        assert.deepEqual(bodies, bodies.map(() => ({
          error: {
            code: CHAT_AUTHORIZATION_ERROR_CODE,
            message: "Chat authorization failed",
          },
        })));
      });

      await t.test("maps idempotency conflicts and in-progress completion to 409", async () => {
        const conflict = input("conflict", {
          parentConversationId: "parent-conflict",
          rootMessageId: "root-conflict",
          initialFollow: false,
        });
        assert.equal(
          (await request("/messages/root-conflict/thread", conflict)).status,
          201,
        );
        await assertStableError(
          await request("/messages/root-conflict/thread", {
            ...conflict,
            initialFollow: true,
          }),
          409,
          CHAT_THREAD_CREATION_CONFLICT_CODE,
          "Thread creation conflicts with current server state",
        );

        database.setInProgressKey("thread-http-in-progress");
        await assertStableError(
          await request(
            "/messages/root-progress/thread",
            input("in-progress", {
              parentConversationId: "parent-progress",
              rootMessageId: "root-progress",
            }),
          ),
          409,
          CHAT_THREAD_CREATION_CONFLICT_CODE,
          "Thread creation conflicts with current server state",
        );
      });
    });

    await t.test("sanitizes unexpected internal failures", async () => {
      const outcomes = [];
      const runtime = createChatServer({
        httpObservability: { onOutcome: (outcome) => { outcomes.push(outcome); } },
        database: {
          pool: {
            async query() {
              throw new Error("sensitive database host and credential detail");
            },
            async connect() {
              throw new Error("must fail while reading metadata");
            },
          },
        },
        auth: { async resolveActor() { return actor; } },
        directory: {
          async getUser() { return null; },
          async searchUsers() { return []; },
        },
        permissions: {
          async getCapabilities() { return ["thread.create"]; },
          async authorizeEntity() { return true; },
        },
      });
      await withHttpServer(runtime, async ({ request }) => {
        const response = await request(
          "/messages/root-main/thread",
          input("internal-failure"),
        );
        assert.equal(response.status, 503);
        const requestId = response.headers.get("x-handrail-request-id");
        assert.ok(requestId);
        assert.ok(outcomes.some((outcome) =>
          outcome.requestId === requestId && outcome.statusCode === 503 &&
          outcome.outcomeCode === CHAT_THREAD_CREATION_UNAVAILABLE_CODE));
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const text = await response.text();
        assert.deepEqual(JSON.parse(text), {
          error: {
            code: CHAT_THREAD_CREATION_UNAVAILABLE_CODE,
            message: "Thread creation temporarily unavailable",
          },
        });
        for (const forbidden of [
          "database host",
          "credential",
          "stack",
          "rows",
          "adapter",
        ]) {
          assert.equal(text.includes(forbidden), false);
        }
      });
    });
});
