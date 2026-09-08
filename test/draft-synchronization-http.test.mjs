import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  MAX_DRAFT_TEXT_UTF8_BYTES,
  parseSynchronizeDraftResult,
} from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_DRAFT_SYNCHRONIZATION_CONFLICT_CODE,
  CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST_CODE,
  CHAT_DRAFT_SYNCHRONIZATION_UNAVAILABLE_CODE,
  DRAFT_SYNCHRONIZATION_ROUTE_SUFFIX,
  MAX_DRAFT_SYNCHRONIZATION_REQUEST_BYTES,
  SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
  SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE,
  createChatServer,
} from "@handrail/chat/server";

const actorA = Object.freeze({
  tenantId: "tenant-a",
  userId: "draft-author-a",
  roles: Object.freeze(["sensitive-host-role"]),
});
const actorB = Object.freeze({
  tenantId: "tenant-a",
  userId: "draft-author-b",
  roles: Object.freeze(["employee"]),
});

const replaceInput = (conversationId, suffix, overrides = {}) => ({
  operation: "synchronize_draft",
  intent: "replace",
  conversationId,
  baseRevision: 0,
  deviceMutationId: `device-${suffix}`,
  idempotencyKey: `draft-http-${suffix}`,
  content: {
    format: "markdown",
    text: `private draft ${suffix}`,
    attachments: [{ attachmentId: `attachment-${suffix}` }],
  },
  ...overrides,
});

const clearInput = (conversationId, suffix, baseRevision) => ({
  operation: "synchronize_draft",
  intent: "clear",
  conversationId,
  baseRevision,
  deviceMutationId: `device-${suffix}`,
  idempotencyKey: `draft-http-${suffix}`,
});

const route = (conversationId) =>
  `/conversations/${conversationId}${DRAFT_SYNCHRONIZATION_ROUTE_SUFFIX}`;

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
            authorization: options.authorization ?? "Bearer actor-a",
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

const createScriptedDraftDatabase = () => {
  const memberships = new Set([
    JSON.stringify(["tenant-a", "draft-main", actorA.userId]),
    JSON.stringify(["tenant-a", "draft-main", actorB.userId]),
    JSON.stringify(["tenant-a", "draft-nonmember", "another-user"]),
    JSON.stringify(["tenant-b", "draft-cross-tenant", actorA.userId]),
  ]);
  let committed = {
    drafts: new Map(),
    idempotency: new Map(),
    outbox: [],
  };
  let timestamp = 0;

  return {
    snapshot() {
      return structuredClone(committed);
    },
    async query(sql) {
      throw new Error(`unexpected direct draft HTTP query: ${sql}`);
    },
    async connect() {
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
          assert.equal(active, true, "draft command SQL must be transactional");

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
              rows: [{
                idempotency_state: "pending",
                stored_response_body: null,
              }],
              rowCount: 1,
            };
          }

          if (sql.includes("SELECT type, parent_conversation_id FROM")) {
            // These transport fixtures contain only non-thread conversations.
            return { rows: [{ type: "channel", parent_conversation_id: null }], rowCount: 1 };
          }

          if (
            sql.includes("chat_conversations AS conversation") &&
            sql.includes("FOR UPDATE OF conversation, member")
          ) {
            const [tenantId, conversationId, userId] = values;
            const member = memberships.has(
              JSON.stringify([tenantId, conversationId, userId]),
            );
            if (!member) return { rows: [], rowCount: 0 };
            timestamp += 1;
            return {
              rows: [{
                observed_at: `2030-01-01T00:00:${String(timestamp).padStart(2, "0")}.000Z`,
              }],
              rowCount: 1,
            };
          }

          if (sql.includes("synchronize_chat_draft")) {
            const [tenantId, conversationId, userId, content, revision, updatedAt] =
              values;
            const identity = JSON.stringify([tenantId, conversationId, userId]);
            const current = working.drafts.get(identity);
            if (current === undefined || current.revision < revision) {
              const stored = {
                content: structuredClone(content),
                revision,
                updatedAt,
              };
              working.drafts.set(identity, stored);
              return {
                rows: [{
                  did_apply: true,
                  stored_revision: revision,
                  stored_content: structuredClone(content),
                  stored_updated_at: updatedAt,
                }],
                rowCount: 1,
              };
            }
            return {
              rows: [{
                did_apply: false,
                stored_revision: current.revision,
                stored_content: structuredClone(current.content),
                stored_updated_at: current.updatedAt,
              }],
              rowCount: 1,
            };
          }

          if (sql.includes("INSERT INTO") && sql.includes("chat_outbox_events")) {
            const [eventId, protocolVersion, tenantId, streamId, type, occurredAt, payload] =
              values;
            working.outbox.push({
              eventId,
              protocolVersion,
              tenantId,
              streamId,
              type,
              occurredAt,
              payload: structuredClone(payload),
            });
            return { rows: [], rowCount: 1 };
          }

          if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
            const [responseBody, completedAt, tenantId, userId, operation, key, requestHash] =
              values;
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const current = working.idempotency.get(identity);
            if (
              current === undefined ||
              current.state !== "pending" ||
              current.requestHash !== requestHash
            ) {
              return { rows: [], rowCount: 0 };
            }
            working.idempotency.set(identity, {
              ...current,
              state: "completed",
              responseBody: structuredClone(responseBody),
              completedAt,
            });
            return { rows: [], rowCount: 1 };
          }

          throw new Error(`unexpected draft HTTP query: ${sql}`);
        },
        release() {},
      };
    },
  };
};

test("PATCH /conversations/:conversationId/draft mounts actor-private draft synchronization", async (t) => {
  const scriptedDatabase = createScriptedDraftDatabase();
  let commandConnectCount = 0;
  const instrumentedDatabase = {
    query(...args) {
      return scriptedDatabase.query(...args);
    },
    async connect() {
      commandConnectCount += 1;
      return scriptedDatabase.connect();
    },
  };
  const runtime = createChatServer({
    database: { pool: instrumentedDatabase, schema: "chat_draft_http" },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization === "Bearer actor-a") return actorA;
        if (request.headers.authorization === "Bearer actor-b") return actorB;
        throw new Error("sensitive authentication-provider detail");
      },
    },
    directory: {
      async getUser() {
        throw new Error("draft route must not query the directory");
      },
      async searchUsers() {
        throw new Error("draft route must not search the directory");
      },
    },
    permissions: {
      async getCapabilities() {
        return [];
      },
      async authorizeEntity() {
        throw new Error("draft membership is enforced by the command");
      },
    },
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
      await t.test("replaces, replays, reports stale state, and clears canonically", async () => {
        const input = replaceInput("draft-main", "main-secret");
        const beforeReplace = commandConnectCount;
        const response = await request(route("draft-main"), input);
        assert.equal(commandConnectCount, beforeReplace + 1);
        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get("content-type"),
          "application/json; charset=utf-8",
        );
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        const applied = await response.json();
        assert.deepEqual(parseSynchronizeDraftResult(applied, input), applied);
        assert.equal(applied.reconciliationStatus, "applied");
        assert.equal(applied.canonicalRevision, 1);
        assert.match(applied.canonicalUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(applied.draft, { kind: "replaced", content: input.content });
        assert.deepEqual(Object.keys(applied), [
          "operation",
          "intent",
          "reconciliationStatus",
          "conversationId",
          "baseRevision",
          "deviceMutationId",
          "idempotencyKey",
          "canonicalRevision",
          "canonicalUpdatedAt",
          "draft",
        ]);
        assert.equal("tenantId" in applied, false);
        assert.equal("userId" in applied, false);
        assert.equal("roles" in applied, false);

        const persisted = scriptedDatabase.snapshot().drafts.get(
          JSON.stringify([actorA.tenantId, "draft-main", actorA.userId]),
        );
        assert.deepEqual(persisted.content, input.content);
        assert.equal(persisted.revision, 1);
        assert.equal(persisted.updatedAt, applied.canonicalUpdatedAt);

        const beforeRetry = commandConnectCount;
        const retry = await request(route("draft-main"), input);
        assert.equal(commandConnectCount, beforeRetry + 1);
        const replayed = await retry.json();
        assert.equal(retry.status, 200);
        assert.equal(replayed.reconciliationStatus, "replayed");
        assert.equal(replayed.canonicalRevision, applied.canonicalRevision);
        assert.equal(replayed.canonicalUpdatedAt, applied.canonicalUpdatedAt);
        assert.deepEqual(replayed.draft, applied.draft);

        const staleInput = replaceInput("draft-main", "stale", {
          content: {
            format: "plain",
            text: "stale device must not overwrite",
            attachments: [],
          },
        });
        const beforeStale = commandConnectCount;
        const staleResponse = await request(route("draft-main"), staleInput);
        assert.equal(commandConnectCount, beforeStale + 1);
        assert.equal(staleResponse.status, 409);
        assert.equal(
          staleResponse.headers.get("cache-control"),
          "private, no-store",
        );
        const stale = await staleResponse.json();
        assert.deepEqual(parseSynchronizeDraftResult(stale, staleInput), stale);
        assert.equal(stale.reconciliationStatus, "stale_base");
        assert.equal(stale.canonicalRevision, 1);
        assert.equal(stale.canonicalUpdatedAt, applied.canonicalUpdatedAt);
        assert.deepEqual(stale.draft, applied.draft);

        const clear = clearInput("draft-main", "clear", 1);
        const beforeClear = commandConnectCount;
        const clearResponse = await request(route("draft-main"), clear);
        assert.equal(commandConnectCount, beforeClear + 1);
        assert.equal(clearResponse.status, 200);
        const cleared = await clearResponse.json();
        assert.deepEqual(parseSynchronizeDraftResult(cleared, clear), cleared);
        assert.equal(cleared.reconciliationStatus, "applied");
        assert.equal(cleared.canonicalRevision, 2);
        assert.deepEqual(cleared.draft, {
          kind: "clear_tombstone",
          content: null,
        });

        const state = scriptedDatabase.snapshot();
        assert.equal(
          [...state.drafts.keys()].filter((key) =>
            key === JSON.stringify([actorA.tenantId, "draft-main", actorA.userId])
          ).length,
          1,
        );
        assert.equal(
          state.outbox.filter((event) =>
            event.tenantId === actorA.tenantId &&
            event.streamId === `user:${actorA.userId}` &&
            event.type === SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE &&
            event.payload.result.conversationId === "draft-main"
          ).length,
          2,
        );
        assert.equal(
          [...state.idempotency.keys()].filter((key) => {
            const [tenantId, userId, operation] = JSON.parse(key);
            return tenantId === actorA.tenantId &&
              userId === actorA.userId &&
              operation === SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION;
          }).length,
          3,
        );
      });

      await t.test("isolates actors and never projects trusted context", async () => {
        const privateB = replaceInput("draft-main", "actor-b", {
          content: {
            format: "plain",
            text: "actor-b private draft",
            attachments: [{ attachmentId: "actor-b-private-attachment" }],
          },
        });
        const response = await request(route("draft-main"), privateB, {
          authorization: "Bearer actor-b",
        });
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.deepEqual(json.draft, { kind: "replaced", content: privateB.content });
        assert.equal(JSON.stringify(json).includes("main-secret"), false);
        assert.equal("tenantId" in json, false);
        assert.equal("userId" in json, false);
        assert.equal("roles" in json, false);

        const rows = [...scriptedDatabase.snapshot().drafts.entries()]
          .map(([key, draft]) => ({
            identity: JSON.parse(key),
            content: draft.content,
          }))
          .filter(({ identity }) =>
            identity[0] === "tenant-a" && identity[1] === "draft-main"
          )
          .sort((left, right) => left.identity[2].localeCompare(right.identity[2]));
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((row) => row.identity[2]), [actorA.userId, actorB.userId]);
        assert.equal(rows[0].content, null);
        assert.deepEqual(rows[1].content, privateB.content);
      });

      await t.test("rejects malformed, oversized, mismatched, and spoofed input before command work", async () => {
        const valid = replaceInput("draft-main", "invalid-base", {
          baseRevision: 2,
        });
        const oversizedContent = replaceInput("draft-main", "oversized-content", {
          baseRevision: 2,
          content: {
            format: "plain",
            text: "é".repeat(MAX_DRAFT_TEXT_UTF8_BYTES / 2 + 1),
            attachments: [],
          },
        });
        const oversizedBody = JSON.stringify({
          ...valid,
          padding: "x".repeat(MAX_DRAFT_SYNCHRONIZATION_REQUEST_BYTES),
        });
        const invalidCases = [
          () => request(`${route("draft-main")}?tenantId=tenant-b`, valid),
          () => request(route("draft-main"), { ...valid, conversationId: "other" }),
          () => request("/conversations/draft%2Fmain/draft", valid),
          () => request("/conversations//draft", valid),
          () => request(route("draft-main"), valid, { contentType: "text/plain" }),
          () => request(route("draft-main"), valid, { body: "{" }),
          () => request(route("draft-main"), { ...valid, unknown: true }),
          () => request(route("draft-main"), { ...valid, tenantId: "tenant-b" }),
          () => request(route("draft-main"), { ...valid, user_id: "another-user" }),
          () => request(route("draft-main"), { ...valid, actor: actorB }),
          () => request(route("draft-main"), { ...valid, roles: ["owner"] }),
          () => request(route("draft-main"), { ...valid, authorization: "trusted" }),
          () => request(route("draft-main"), valid, { omitIdempotencyKey: true }),
          () => request(route("draft-main"), valid, { idempotencyKey: "mismatch" }),
          () => request(route("draft-main"), { ...valid, idempotencyKey: "unsafe/key" }),
          () => request(route("draft-main"), oversizedContent),
          () => request(route("draft-main"), valid, { body: oversizedBody }),
          () => request(route("draft-main"), valid, { body: "" }),
        ];
        const before = commandConnectCount;
        for (const send of invalidCases) {
          await assertStableError(
            await send(),
            400,
            CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST_CODE,
            "Invalid draft synchronization request",
          );
        }

        const duplicate = await rawRequest(route("draft-main"), {
          body: JSON.stringify(valid),
          headers: [
            "authorization",
            "Bearer actor-a",
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
          CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST_CODE,
          "Invalid draft synchronization request",
        );

        const streamedOverflow = await rawRequest(route("draft-main"), {
          chunks: [
            " ".repeat(MAX_DRAFT_SYNCHRONIZATION_REQUEST_BYTES),
            "SECRET_DRAFT_STREAMED_OVERFLOW",
          ],
          headers: [
            "authorization",
            "Bearer actor-a",
            "content-type",
            "application/json",
            "transfer-encoding",
            "chunked",
            "idempotency-key",
            valid.idempotencyKey,
          ],
        });
        const streamedOverflowBody = await assertStableError(
          streamedOverflow,
          400,
          CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST_CODE,
          "Invalid draft synchronization request",
        );
        assert.doesNotMatch(
          JSON.stringify(streamedOverflowBody),
          /SECRET_DRAFT_STREAMED_OVERFLOW|sensitive/iu,
        );
        assert.equal(commandConnectCount, before);
      });

      await t.test("maps authorization and idempotency conflicts to stable private errors", async () => {
        for (const conversationId of ["draft-nonmember", "draft-cross-tenant"]) {
          await assertStableError(
            await request(
              route(conversationId),
              replaceInput(conversationId, `authorization-${conversationId}`),
            ),
            403,
            CHAT_AUTHORIZATION_ERROR_CODE,
            "Chat authorization failed",
          );
        }

        const conflict = replaceInput("draft-main", "conflict", {
          baseRevision: 2,
        });
        assert.equal((await request(route("draft-main"), conflict)).status, 200);
        await assertStableError(
          await request(route("draft-main"), {
            ...conflict,
            deviceMutationId: "different-device-mutation",
          }),
          409,
          CHAT_DRAFT_SYNCHRONIZATION_CONFLICT_CODE,
          "Draft synchronization conflicts with current server state",
        );
      });
  });
});

test("draft synchronization redacts authentication and unexpected failure details from responses and logs", async () => {
  const sensitiveText = "UNIQUE_DRAFT_SECRET_7mK4v";
  const sensitiveAttachment = "UNIQUE_ATTACHMENT_SECRET_9qP2x";
  const input = replaceInput("draft-failure", "redaction", {
    content: {
      format: "plain",
      text: sensitiveText,
      attachments: [{ attachmentId: sensitiveAttachment }],
    },
  });
  let failDatabase = false;
  const runtime = createChatServer({
    database: {
      pool: {
        async query() {
          throw new Error("unexpected direct query");
        },
        async connect() {
          if (failDatabase) {
            throw new Error(`${sensitiveText} ${sensitiveAttachment}`);
          }
          throw new Error("unexpected connection");
        },
      },
      schema: "chat_draft_redaction",
    },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization === "Bearer actor-a") return actorA;
        throw new Error(`${sensitiveText} ${sensitiveAttachment}`);
      },
    },
    directory: {
      async getUser() {
        throw new Error("unused");
      },
      async searchUsers() {
        throw new Error("unused");
      },
    },
    permissions: {
      async getCapabilities() {
        return [];
      },
      async authorizeEntity() {
        throw new Error("unused");
      },
    },
  });

  const logged = [];
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  console.error = (...values) => logged.push(values.join(" "));
  console.warn = (...values) => logged.push(values.join(" "));
  console.log = (...values) => logged.push(values.join(" "));
  try {
    await withHttpServer(runtime, async ({ request }) => {
      const authResponse = await request(route("draft-failure"), input, {
        authorization: "Bearer invalid",
      });
      await assertStableError(
        authResponse,
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      failDatabase = true;
      const unavailableResponse = await request(route("draft-failure"), input);
      await assertStableError(
        unavailableResponse,
        503,
        CHAT_DRAFT_SYNCHRONIZATION_UNAVAILABLE_CODE,
        "Draft synchronization temporarily unavailable",
      );
    });
  } finally {
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.log = originalConsole.log;
  }

  const output = logged.join("\n");
  assert.equal(output.includes(sensitiveText), false);
  assert.equal(output.includes(sensitiveAttachment), false);
});
