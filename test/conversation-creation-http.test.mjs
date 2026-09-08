import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseConversationCreationResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_CONVERSATION_CREATION_CONFLICT_CODE,
  CHAT_CONVERSATION_CREATION_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_CREATION_MEMBER_UNAVAILABLE_CODE,
  CHAT_CONVERSATION_CREATION_UNAVAILABLE_CODE,
  CREATE_CONVERSATION_ENTITY_POLICY_ACTION,
  MAX_CONVERSATION_CREATION_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const channelInput = (suffix, overrides = {}) => ({
  operation: "create_conversation",
  type: "channel",
  name: `Channel ${suffix}`,
  visibility: "public",
  idempotencyKey: `http-${suffix}`,
  clientRequestId: `client-${suffix}`,
  ...overrides,
});

const directInput = (suffix, userId = "user-b") => ({
  operation: "create_conversation",
  type: "direct",
  visibility: "private",
  intendedMemberUserIds: [userId],
  idempotencyKey: `http-${suffix}`,
  clientRequestId: `client-${suffix}`,
});

const groupInput = (suffix) => ({
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: ["user-c", "user-b"],
  idempotencyKey: `http-${suffix}`,
  clientRequestId: `client-${suffix}`,
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
      request(path, input, options = {}) {
        const body = options.body ?? JSON.stringify(input);
        const idempotencyKey =
          options.idempotencyKey === undefined
            ? input?.idempotencyKey
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

const createScriptedCreationDatabase = () => {
  const emptyState = () => ({
    conversations: new Map(),
    idempotency: new Map(),
    audit: new Map(),
    outbox: new Map(),
  });
  let committed = emptyState();
  let connectCount = 0;
  let directQueryCount = 0;
  let failMetadata = false;
  const transactionSql = [];

  const rowFor = (state, conversationId, actorUserId) => {
    const conversation = state.conversations.get(conversationId);
    if (conversation === undefined) return undefined;
    return {
      id: conversation.id,
      type: conversation.type,
      visibility: conversation.visibility,
      name: conversation.name,
      entity_type: conversation.entityType,
      entity_id: conversation.entityId,
      current_message_sequence: 0,
      created_at: conversation.createdAt,
      updated_at: conversation.createdAt,
      member_role: actorUserId === actor.userId ? "owner" : "member",
      member_state: "active",
      member_joined_at: conversation.createdAt,
      member_updated_at: conversation.createdAt,
      last_read_sequence: 0,
      read_updated_at: conversation.createdAt,
      notification_level: "all",
      muted: false,
      muted_until: null,
      preference_updated_at: conversation.createdAt,
      member_user_ids: conversation.memberUserIds,
    };
  };

  const resource = {
    async query(sql) {
      directQueryCount += 1;
      if (failMetadata) {
        throw new Error("sensitive database host and credential detail");
      }
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ exists: false }] };
      }
      throw new Error(`unexpected direct creation HTTP query: ${sql}`);
    },
    async connect() {
      connectCount += 1;
      let working = structuredClone(committed);
      let active = false;
      return {
        async query(sql, values = []) {
          transactionSql.push(sql);
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
          if (
            sql.includes("SELECT conversation.id") &&
            !sql.includes("conversation.visibility")
          ) {
            const [tenantId, type, participantUserIds] = values;
            const equivalent = [...working.conversations.values()].find(
              (conversation) =>
                conversation.tenantId === tenantId &&
                conversation.type === type &&
                JSON.stringify(conversation.memberUserIds) ===
                  JSON.stringify(participantUserIds),
            );
            return {
              rows: equivalent === undefined ? [] : [{ id: equivalent.id }],
              rowCount: equivalent === undefined ? 0 : 1,
            };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_conversations")) {
            const [tenantId, id, type, visibility, name, entityType, entityId] = values;
            const createdAt = "2030-01-01T00:00:00.000Z";
            working.conversations.set(id, {
              tenantId,
              id,
              type,
              visibility,
              name,
              entityType,
              entityId,
              createdAt,
              memberUserIds: [],
            });
            return { rows: [{ created_at: createdAt }], rowCount: 1 };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_conversation_members")
          ) {
            const conversation = working.conversations.get(values[1]);
            conversation.memberUserIds = [...values[4]];
            return { rows: [], rowCount: conversation.memberUserIds.length };
          }
          if (
            sql.includes("INSERT INTO") &&
            (sql.includes("chat_read_cursors") ||
              sql.includes("chat_conversation_preferences"))
          ) {
            return { rows: [], rowCount: values[3].length };
          }
          if (
            sql.includes("SELECT conversation.id") &&
            sql.includes("conversation.visibility")
          ) {
            const row = rowFor(working, values[2], values[1]);
            return {
              rows: row === undefined ? [] : [row],
              rowCount: row === undefined ? 0 : 1,
            };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_audit_events")) {
            const conversationId = values[3];
            working.audit.set(conversationId, (working.audit.get(conversationId) ?? 0) + 1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_outbox_events")) {
            const conversationId = values[3];
            working.outbox.set(conversationId, (working.outbox.get(conversationId) ?? 0) + 1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
            const [, responseBody, tenantId, userId, operation, key, requestHash] = values;
            if (key === "http-in-progress") return { rows: [], rowCount: 0 };
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
          throw new Error(`unexpected creation command query: ${sql}`);
        },
        release() {},
      };
    },
  };

  return {
    resource,
    get connectCount() {
      return connectCount;
    },
    get directQueryCount() {
      return directQueryCount;
    },
    get transactionSql() {
      return transactionSql;
    },
    setFailMetadata(value) {
      failMetadata = value;
    },
    sideEffects(conversationId) {
      return {
        conversations: committed.conversations.has(conversationId) ? 1 : 0,
        audit: committed.audit.get(conversationId) ?? 0,
        outbox: committed.outbox.get(conversationId) ?? 0,
      };
    },
  };
};

test("POST /conversations mounts the canonical actor-scoped creation command", async (t) => {
  const database = createScriptedCreationDatabase();
  let capabilities = ["conversation.create"];
  let entityAllowed = true;
  const actorCalls = [];
  const directoryCalls = [];
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
      async getUser(input) {
        directoryCalls.push(input);
        if (input.userId === "missing-user") return null;
        return {
          tenantId: actor.tenantId,
          userId: input.userId,
          displayName: `User ${input.userId}`,
        };
      },
      async searchUsers() {
        throw new Error("creation route must not search the directory");
      },
    },
    permissions: {
      async getCapabilities(input) {
        actorCalls.push(input.actor);
        return capabilities;
      },
      async authorizeEntity(input) {
        entityCalls.push(input);
        return entityAllowed;
      },
    },
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await t.test("creates channel, direct, and group-direct conversations once", async () => {
      const inputs = [
        channelInput("channel", {
          visibility: "private",
          entity: { type: "order", id: "42" },
        }),
        directInput("direct"),
        groupInput("group"),
      ];
      const results = [];
      for (const input of inputs) {
        const beforeConnects = database.connectCount;
        const response = await request("/conversations", input);
        assert.equal(response.status, 201);
        assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const result = parseConversationCreationResult(await response.json(), input);
        assert.equal(result.type, input.type);
        assert.equal(result.reconciliationStatus, "created");
        assert.equal(result.conversation.conversation.currentMember.userId, actor.userId);
        assert.equal(database.connectCount - beforeConnects, 1);
        results.push(result);
      }
      assert.deepEqual(results.map(({ type }) => type), ["channel", "direct", "group_direct"]);
      assert.deepEqual(entityCalls, [{
        actor,
        entity: { type: "order", id: "42" },
        action: CREATE_CONVERSATION_ENTITY_POLICY_ACTION,
      }]);
      assert.ok(actorCalls.every((value) => assert.deepEqual(value, actor) === undefined));
      assert.ok(
        directoryCalls.every(
          (value) => assert.deepEqual(value.actor, actor) === undefined,
        ),
      );
      assert.equal(database.transactionSql.filter((sql) => sql === "BEGIN").length, 3);
    });

    await t.test("retries and equivalent directs do not duplicate side effects", async () => {
      const input = channelInput("replay");
      const firstResponse = await request("/conversations", input);
      const first = parseConversationCreationResult(await firstResponse.json(), input);
      assert.equal(firstResponse.status, 201);
      const replayResponse = await request("/conversations", input);
      const replayBody = await replayResponse.json();
      const repeatedReplayResponse = await request("/conversations", input);
      const repeatedReplayBody = await repeatedReplayResponse.json();
      assert.equal(replayResponse.status, 200);
      assert.equal(repeatedReplayResponse.status, 200);
      assert.deepEqual(repeatedReplayBody, replayBody);
      assert.equal(replayBody.reconciliationStatus, "replayed");
      assert.equal(replayBody.conversation.conversation.id, first.conversation.conversation.id);
      assert.deepEqual(database.sideEffects(first.conversation.conversation.id), {
        conversations: 1,
        audit: 1,
        outbox: 1,
      });

      const direct = directInput("equivalent-a", "user-c");
      const created = await (await request("/conversations", direct)).json();
      const equivalentInput = directInput("equivalent-b", "user-c");
      const equivalentResponse = await request("/conversations", equivalentInput);
      const equivalent = await equivalentResponse.json();
      assert.equal(equivalentResponse.status, 200);
      assert.equal(equivalent.reconciliationStatus, "existing_equivalent");
      assert.equal(equivalent.conversation.conversation.id, created.conversation.conversation.id);
      assert.deepEqual(database.sideEffects(created.conversation.conversation.id), {
        conversations: 1,
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("rejects malformed transport and trusted identity spoofing before database access", async () => {
      const valid = channelInput("invalid-base");
      const invalidRequests = [
        () => request("/conversations", valid, { body: "{" }),
        () => request("/conversations", valid, { contentType: "text/plain" }),
        () => request("/conversations?unexpected=true", valid),
        () => request("/conversations", { ...valid, unknown: true }),
        () => request("/conversations", { ...valid, tenantId: "tenant-b" }),
        () => request("/conversations", {
          ...valid,
          entity: { type: "order", id: "42", userId: "spoofed" },
        }),
        () => request("/conversations", valid, { omitIdempotencyKey: true }),
        () => request("/conversations", valid, { idempotencyKey: "other-key" }),
        () => request("/conversations", { ...valid, idempotencyKey: "bad,key" }, {
          idempotencyKey: "bad,key",
        }),
        () => request("/conversations", valid, {
          body: JSON.stringify({ ...valid, idempotencyKey: undefined }),
        }),
        () => request("/conversations", valid, {
          body: JSON.stringify({
            ...valid,
            name: "x".repeat(MAX_CONVERSATION_CREATION_REQUEST_BYTES),
          }),
        }),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeDirectQueries = database.directQueryCount;
        const beforeConnects = database.connectCount;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_CONVERSATION_CREATION_INVALID_REQUEST_CODE,
          "Invalid conversation creation request",
        );
        assert.equal(database.directQueryCount, beforeDirectQueries);
        assert.equal(database.connectCount, beforeConnects);
      }

      const duplicateBody = JSON.stringify(valid);
      const beforeDirectQueries = database.directQueryCount;
      const duplicate = await rawRequest("/conversations", {
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
        CHAT_CONVERSATION_CREATION_INVALID_REQUEST_CODE,
        "Invalid conversation creation request",
      );
      assert.equal(database.directQueryCount, beforeDirectQueries);

      const beforeOverDeclaredDirectQueries = database.directQueryCount;
      const beforeOverDeclaredConnects = database.connectCount;
      const overDeclared = await rawRequest("/conversations", {
        body: duplicateBody,
        headers: [
          "authorization", "Bearer valid",
          "content-type", "application/json",
          "idempotency-key", valid.idempotencyKey,
          "content-length", String(MAX_CONVERSATION_CREATION_REQUEST_BYTES + 1),
        ],
      });
      await assertStableError(
        overDeclared,
        400,
        CHAT_CONVERSATION_CREATION_INVALID_REQUEST_CODE,
        "Invalid conversation creation request",
      );
      assert.equal(database.directQueryCount, beforeOverDeclaredDirectQueries);
      assert.equal(database.connectCount, beforeOverDeclaredConnects);
    });

    await t.test("maps authentication, authorization, conflicts, and member availability", async () => {
      await assertStableError(
        await request("/conversations", channelInput("unauthenticated"), {
          authorization: "Bearer invalid",
        }),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );
      capabilities = [];
      const beforeCapabilityConnects = database.connectCount;
      await assertStableError(
        await request("/conversations", channelInput("capability-denied")),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      assert.equal(database.connectCount, beforeCapabilityConnects);
      capabilities = ["conversation.create"];

      entityAllowed = false;
      await assertStableError(
        await request("/conversations", channelInput("entity-denied", {
          entity: { type: "order", id: "denied" },
        })),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      entityAllowed = true;

      await assertStableError(
        await request("/conversations", directInput("missing-member", "missing-user")),
        422,
        CHAT_CONVERSATION_CREATION_MEMBER_UNAVAILABLE_CODE,
        "One or more intended conversation members are unavailable",
      );
      const conflictInput = channelInput("conflict");
      await request("/conversations", conflictInput);
      await assertStableError(
        await request("/conversations", {
          ...conflictInput,
          name: "Different request for the same key",
        }),
        409,
        CHAT_CONVERSATION_CREATION_CONFLICT_CODE,
        "Conversation creation conflicts with current server state",
      );
      await assertStableError(
        await request("/conversations", channelInput("in-progress")),
        409,
        CHAT_CONVERSATION_CREATION_CONFLICT_CODE,
        "Conversation creation conflicts with current server state",
      );
    });

    await t.test("sanitizes unexpected internal failures", async () => {
      database.setFailMetadata(true);
      const response = await request("/conversations", channelInput("internal-failure", {
        name: "sensitive request body value",
      }));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: {
          code: CHAT_CONVERSATION_CREATION_UNAVAILABLE_CODE,
          message: "Conversation creation temporarily unavailable",
        },
      });
      for (const forbidden of [
        "sensitive request body value",
        "database host",
        "credential",
        "stack",
        "rows",
        "adapter",
      ]) {
        assert.equal(text.includes(forbidden), false);
      }
      database.setFailMetadata(false);
    });
  });
});
