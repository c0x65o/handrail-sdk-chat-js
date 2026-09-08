import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseConversationArchiveResult } from "@handrail/chat";
import {
  ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_CONVERSATION_ARCHIVE_CONFLICT_CODE,
  CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_ARCHIVE_UNAVAILABLE_CODE,
  MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const archiveInput = (suffix, overrides = {}) => ({
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId: "owner-target",
  expectedLifecycleRevision: 1,
  idempotencyKey: `archive-http-${suffix}`,
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
    const rawRequest = (path, { body = "", chunks, headers = [] } = {}) =>
      new Promise((resolve, reject) => {
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
        if (chunks === undefined) {
          request.end(body);
          return;
        }
        const writeChunk = (index) => {
          const chunk = chunks[index];
          if (chunk === undefined) {
            request.end();
            return;
          }
          request.write(chunk);
          setImmediate(() => writeChunk(index + 1));
        };
        writeChunk(0);
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
  assert.deepEqual(await response.json(), { error: { code, message } });
};

const createScriptedArchiveDatabase = () => {
  const conversation = (
    tenantId,
    id,
    { lifecycleRevision = 1, memberRole = "owner", entity } = {},
  ) => ({
    tenantId,
    id,
    lifecycleRevision,
    archivedAt: null,
    archivedByUserId: null,
    memberRole,
    memberState: "active",
    entityType: entity?.type ?? null,
    entityId: entity?.id ?? null,
  });
  const conversations = new Map(
    [
      conversation("tenant-a", "owner-target"),
      conversation("tenant-a", "stale-target", { lifecycleRevision: 3 }),
      conversation("tenant-a", "member-target", { memberRole: "member" }),
      conversation("tenant-a", "entity-target", {
        entity: { type: "work_order", id: "42" },
      }),
      conversation("tenant-b", "cross-tenant-target"),
    ].map((value) => [`${value.tenantId}\0${value.id}`, value]),
  );
  let committed = {
    conversations,
    idempotency: new Map(),
    auditCount: 0,
    outboxCount: 0,
  };
  let connectCount = 0;
  let directQueryCount = 0;
  let inProgressKey;

  const resource = {
    async query(sql) {
      directQueryCount += 1;
      throw new Error(`unexpected direct archive HTTP query: ${sql}`);
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
          assert.equal(active, true, "archive SQL must use one transaction");

          if (sql.includes("claim_chat_idempotency_key")) {
            const [tenantId, userId, operation, key, requestHash] = values;
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const current = working.idempotency.get(identity);
            if (current !== undefined && current.requestHash !== requestHash) {
              return { rows: [], rowCount: 0 };
            }
            if (current !== undefined) {
              return {
                rows: [
                  {
                    idempotency_state: current.state,
                    stored_response_body: current.responseBody,
                  },
                ],
                rowCount: 1,
              };
            }
            working.idempotency.set(identity, {
              requestHash,
              state: "pending",
              responseBody: null,
            });
            return {
              rows: [
                {
                  idempotency_state: "pending",
                  stored_response_body: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("FROM") && sql.includes("AS conversation")) {
            const [tenantId, conversationId] = values;
            const current = working.conversations.get(
              `${tenantId}\0${conversationId}`,
            );
            if (current === undefined) return { rows: [], rowCount: 0 };
            return {
              rows: [
                {
                  lifecycle_revision: current.lifecycleRevision,
                  archived_at: current.archivedAt,
                  archived_by_user_id: current.archivedByUserId,
                  member_role: current.memberRole,
                  member_state: current.memberState,
                  entity_type: current.entityType,
                  entity_id: current.entityId,
                  occurred_at: "2030-01-01T00:00:00.000Z",
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("UPDATE") && sql.includes("chat_conversations")) {
            const [occurredAt, userId, nextRevision, tenantId, conversationId] =
              values;
            const current = working.conversations.get(
              `${tenantId}\0${conversationId}`,
            );
            if (current === undefined) return { rows: [], rowCount: 0 };
            current.lifecycleRevision = nextRevision;
            if (sql.includes("archived_at = NULL")) {
              current.archivedAt = null;
              current.archivedByUserId = null;
            } else {
              current.archivedAt = occurredAt;
              current.archivedByUserId = userId;
            }
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("chat_audit_events")) {
            working.auditCount += 1;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("chat_outbox_events")) {
            working.outboxCount += 1;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
            const [responseBody, , tenantId, userId, operation, key, requestHash] =
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
          throw new Error(`unexpected archive command query: ${sql}`);
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
    setInProgressKey(value) {
      inProgressKey = value;
    },
    get transitionCounts() {
      return { audit: committed.auditCount, outbox: committed.outboxCount };
    },
  };
};

test("PATCH /conversations/:conversationId/lifecycle mounts canonical archive lifecycle", async (t) => {
  const database = createScriptedArchiveDatabase();
  let capabilities = [];
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
        throw new Error("archive must not query the directory");
      },
      async searchUsers() {
        throw new Error("archive must not query the directory");
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
    await t.test("archives, repeats, restores, and replays canonically", async () => {
      const initial = archiveInput("apply");
      const beforeConnects = database.connectCount;
      const archivedResponse = await request(
        "/conversations/owner-target/lifecycle",
        initial,
      );
      assert.equal(database.connectCount, beforeConnects + 1);
      assert.equal(archivedResponse.status, 200);
      assert.equal(
        archivedResponse.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
      assert.equal(
        archivedResponse.headers.get("cache-control"),
        "private, no-store",
      );
      const archivedText = await archivedResponse.text();
      const archived = parseConversationArchiveResult(
        JSON.parse(archivedText),
        initial,
      );
      assert.equal(archivedText, JSON.stringify(archived));
      assert.deepEqual(archived, {
        operation: "set_conversation_archive",
        intent: "archive",
        reconciliationStatus: "applied",
        conversationId: "owner-target",
        expectedLifecycleRevision: 1,
        lifecycleRevision: 2,
        archiveState: {
          status: "archived",
          archivedAt: "2030-01-01T00:00:00.000Z",
          archivedByUserId: actor.userId,
        },
      });

      const repeatedInput = archiveInput("repeat");
      const repeatedResponse = await request(
        "/conversations/owner-target/lifecycle",
        repeatedInput,
      );
      assert.equal(repeatedResponse.status, 200);
      assert.equal(
        (await repeatedResponse.json()).reconciliationStatus,
        "already_requested_state",
      );

      const restoreInput = archiveInput("restore", {
        intent: "restore",
        expectedLifecycleRevision: 2,
      });
      const restoreResponse = await request(
        "/conversations/owner-target/lifecycle",
        restoreInput,
      );
      const restored = parseConversationArchiveResult(
        await restoreResponse.json(),
        restoreInput,
      );
      assert.equal(restoreResponse.status, 200);
      assert.equal(restored.reconciliationStatus, "applied");
      assert.equal(restored.lifecycleRevision, 3);
      assert.deepEqual(restored.archiveState, { status: "active" });

      const replayResponse = await request(
        "/conversations/owner-target/lifecycle",
        initial,
      );
      const replay = parseConversationArchiveResult(
        await replayResponse.json(),
        initial,
      );
      assert.equal(replayResponse.status, 200);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.deepEqual(replay.archiveState, archived.archiveState);
      assert.deepEqual(database.transitionCounts, { audit: 2, outbox: 2 });
      assert.ok(
        actorCalls.every(
          (trustedActor) => assert.deepEqual(trustedActor, actor) === undefined,
        ),
      );
    });

    await t.test("returns stale lifecycle state as a canonical 409 result", async () => {
      const staleInput = archiveInput("stale", {
        conversationId: "stale-target",
        expectedLifecycleRevision: 1,
      });
      const response = await request(
        "/conversations/stale-target/lifecycle",
        staleInput,
      );
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const result = parseConversationArchiveResult(
        await response.json(),
        staleInput,
      );
      assert.deepEqual(result, {
        operation: "set_conversation_archive",
        intent: "archive",
        reconciliationStatus: "lifecycle_conflict",
        conversationId: "stale-target",
        expectedLifecycleRevision: 1,
        lifecycleRevision: 3,
        archiveState: { status: "active" },
      });
    });

    await t.test("rejects malformed, ambiguous, mismatched, and spoofed transport input before database work", async () => {
      const valid = archiveInput("invalid-base");
      const invalidRequests = [
        () => request("/conversations//lifecycle", valid),
        () => request("/conversations/owner%2Ftarget/lifecycle", valid),
        () => request("/conversations/owner-target/lifecycle/extra", valid),
        () => request("/conversations/owner-target/lifecycle?toggle=true", valid),
        () =>
          request("/conversations/other-target/lifecycle", valid),
        () =>
          request("/conversations/owner-target/lifecycle", {
            ...valid,
            toggle: true,
          }),
        () =>
          request("/conversations/owner-target/lifecycle", {
            ...valid,
            tenantId: "tenant-b",
          }),
        () =>
          request("/conversations/owner-target/lifecycle", {
            ...valid,
            nested: { authorization: "spoofed" },
          }),
        () =>
          request("/conversations/owner-target/lifecycle", valid, { body: "{" }),
        () =>
          request("/conversations/owner-target/lifecycle", valid, {
            contentType: "text/plain",
          }),
        () =>
          request("/conversations/owner-target/lifecycle", valid, {
            omitIdempotencyKey: true,
          }),
        () =>
          request("/conversations/owner-target/lifecycle", valid, {
            idempotencyKey: "other-key",
          }),
        () =>
          request(
            "/conversations/owner-target/lifecycle",
            { ...valid, idempotencyKey: "bad,key" },
            { idempotencyKey: "bad,key" },
          ),
        () =>
          request("/conversations/owner-target/lifecycle", valid, {
            body: JSON.stringify({ ...valid, idempotencyKey: undefined }),
          }),
        () =>
          request("/conversations/owner-target/lifecycle", valid, {
            body: JSON.stringify({
              ...valid,
              conversationId: "x".repeat(
                MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES,
              ),
            }),
          }),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeDirectQueries = database.directQueryCount;
        const beforeConnects = database.connectCount;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST_CODE,
          "Invalid conversation archive request",
        );
        assert.equal(database.directQueryCount, beforeDirectQueries);
        assert.equal(database.connectCount, beforeConnects);
      }

      const beforeOverflowDirectQueries = database.directQueryCount;
      const beforeOverflowConnects = database.connectCount;
      const streamedOverflow = await rawRequest(
        "/conversations/owner-target/lifecycle",
        {
          chunks: [
            " ".repeat(MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES),
            "x",
          ],
          headers: [
            "authorization",
            "Bearer valid",
            "content-type",
            "application/json",
            "idempotency-key",
            valid.idempotencyKey,
          ],
        },
      );
      await assertStableError(
        streamedOverflow,
        400,
        CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST_CODE,
        "Invalid conversation archive request",
      );
      assert.equal(database.directQueryCount, beforeOverflowDirectQueries);
      assert.equal(database.connectCount, beforeOverflowConnects);

      const body = JSON.stringify(valid);
      const beforeConnects = database.connectCount;
      const duplicate = await rawRequest(
        "/conversations/owner-target/lifecycle",
        {
          body,
          headers: [
            "authorization",
            "Bearer valid",
            "content-type",
            "application/json",
            "idempotency-key",
            valid.idempotencyKey,
            "idempotency-key",
            valid.idempotencyKey,
            "content-length",
            String(Buffer.byteLength(body)),
          ],
        },
      );
      await assertStableError(
        duplicate,
        400,
        CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST_CODE,
        "Invalid conversation archive request",
      );
      assert.equal(database.connectCount, beforeConnects);
    });

    await t.test("sanitizes authentication, authorization, entity, and cross-tenant failures", async () => {
      await assertStableError(
        await request(
          "/conversations/owner-target/lifecycle",
          archiveInput("unauthenticated"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      await assertStableError(
        await request(
          "/conversations/member-target/lifecycle",
          archiveInput("member-denied", { conversationId: "member-target" }),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );

      entityAllowed = false;
      await assertStableError(
        await request(
          "/conversations/entity-target/lifecycle",
          archiveInput("entity-denied", { conversationId: "entity-target" }),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "work_order", id: "42" },
        action: ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
      });
      entityAllowed = true;

      const inaccessibleBodies = [];
      for (const conversationId of ["missing-target", "cross-tenant-target"]) {
        const response = await request(
          `/conversations/${conversationId}/lifecycle`,
          archiveInput(conversationId, { conversationId }),
        );
        assert.equal(response.status, 403);
        inaccessibleBodies.push(await response.json());
      }
      assert.deepEqual(
        inaccessibleBodies,
        inaccessibleBodies.map(() => ({
          error: {
            code: CHAT_AUTHORIZATION_ERROR_CODE,
            message: "Chat authorization failed",
          },
        })),
      );
    });

    await t.test("maps command idempotency failures to a stable 409 error", async () => {
      const first = archiveInput("conflict", {
        conversationId: "stale-target",
        expectedLifecycleRevision: 3,
      });
      assert.equal(
        (
          await request(
            "/conversations/stale-target/lifecycle",
            first,
          )
        ).status,
        200,
      );
      await assertStableError(
        await request("/conversations/stale-target/lifecycle", {
          ...first,
          expectedLifecycleRevision: 4,
        }),
        409,
        CHAT_CONVERSATION_ARCHIVE_CONFLICT_CODE,
        "Conversation archive conflicts with current server state",
      );

      database.setInProgressKey("archive-http-in-progress");
      await assertStableError(
        await request(
          "/conversations/member-target/lifecycle",
          archiveInput("in-progress", {
            conversationId: "member-target",
          }),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      capabilities = ["conversation.archive"];
      await assertStableError(
        await request(
          "/conversations/member-target/lifecycle",
          archiveInput("in-progress", {
            conversationId: "member-target",
          }),
        ),
        409,
        CHAT_CONVERSATION_ARCHIVE_CONFLICT_CODE,
        "Conversation archive conflicts with current server state",
      );
    });
  });

  await t.test("sanitizes unexpected archive failures", async () => {
    const failingRuntime = createChatServer({
      database: {
        pool: {
          async query() {
            throw new Error("unexpected direct query");
          },
          async connect() {
            throw new Error("sensitive database host and credential detail");
          },
        },
      },
      auth: { async resolveActor() { return actor; } },
      directory: {
        async getUser() { return null; },
        async searchUsers() { return []; },
      },
      permissions: {
        async getCapabilities() { return []; },
        async authorizeEntity() { return true; },
      },
    });
    await withHttpServer(failingRuntime, async ({ request }) => {
      const response = await request(
        "/conversations/owner-target/lifecycle",
        archiveInput("internal-failure"),
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: {
          code: CHAT_CONVERSATION_ARCHIVE_UNAVAILABLE_CODE,
          message: "Conversation archive temporarily unavailable",
        },
      });
      for (const forbidden of ["database host", "credential", "stack", "rows"]) {
        assert.equal(text.includes(forbidden), false);
      }
    });
  });
});
