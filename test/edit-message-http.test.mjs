import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseEditMessageResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_MESSAGE_EDIT_CONFLICT_CODE,
  CHAT_MESSAGE_EDIT_INVALID_REQUEST_CODE,
  CHAT_MESSAGE_EDIT_UNAVAILABLE_CODE,
  MAX_EDIT_MESSAGE_REQUEST_BYTES,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const editInput = (messageId, suffix, overrides = {}) => ({
  operation: "edit",
  messageId,
  expectedRevision: 1,
  idempotencyKey: `http-edit-${suffix}`,
  content: { format: "plain", text: `Edited ${suffix}` },
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

const createScriptedEditDatabase = () => {
  const makeMessage = (id, overrides = {}) => ({
    id,
    tenantId: "tenant-a",
    conversationId: "conversation-a",
    sequence: 41,
    authorUserId: actor.userId,
    clientMessageId: `client-${id}`,
    content: { format: "plain", text: `Original ${id}` },
    currentRevision: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    editedAt: null,
    editedByUserId: null,
    deletedAt: null,
    ...overrides,
  });
  const freshState = () => ({
    messages: new Map([
      ["owned", makeMessage("owned")],
      ["retry", makeMessage("retry", { sequence: 42 })],
      ["stale", makeMessage("stale", { sequence: 43, currentRevision: 3 })],
      ["unauthorized", makeMessage("unauthorized", { authorUserId: "other-user" })],
      ["cross-tenant", makeMessage("cross-tenant", { tenantId: "tenant-b" })],
      ["in-progress", makeMessage("in-progress", { sequence: 44 })],
      ["failure", makeMessage("failure", { sequence: 45 })],
      ["validation", makeMessage("validation", { sequence: 46 })],
    ]),
    idempotency: new Map(),
    revisions: new Map(),
    audit: new Map(),
    outbox: new Map(),
  });
  let committed = structuredClone(freshState());
  let authorLookupCount = 0;
  let connectCount = 0;
  let failAuthorLookup = false;
  let failCompletion = false;
  let timestamp = 0;

  const toRow = (message) => ({
    id: message.id,
    conversation_id: message.conversationId,
    sequence: message.sequence,
    author_user_id: message.authorUserId,
    client_message_id: message.clientMessageId,
    content: structuredClone(message.content),
    current_revision: message.currentRevision,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
    edited_at: message.editedAt,
    edited_by_user_id: message.editedByUserId,
    observed_at: message.updatedAt,
  });

  const resource = {
    async query(sql, values = []) {
      if (
        sql.includes("SELECT author_user_id") &&
        sql.includes("chat_messages")
      ) {
        authorLookupCount += 1;
        if (failAuthorLookup) {
          throw new Error("sensitive database host and credential detail");
        }
        const [tenantId, messageId] = values;
        const message = committed.messages.get(messageId);
        if (message === undefined || message.tenantId !== tenantId) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ author_user_id: message.authorUserId }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected direct edit HTTP query: ${sql}`);
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
          assert.equal(active, true, "edit command SQL must be transactional");

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
          if (sql.includes("FOR UPDATE") && sql.includes("chat_messages")) {
            const [tenantId, messageId] = values;
            const message = working.messages.get(messageId);
            if (
              message === undefined ||
              message.tenantId !== tenantId ||
              message.deletedAt !== null
            ) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [toRow(message)], rowCount: 1 };
          }
          if (
            sql.includes("UPDATE") &&
            sql.includes("chat_messages AS message")
          ) {
            const [content, editorUserId, tenantId, messageId, expectedRevision] = values;
            const message = working.messages.get(messageId);
            if (
              message === undefined ||
              message.tenantId !== tenantId ||
              message.currentRevision !== expectedRevision ||
              message.deletedAt !== null
            ) {
              return { rows: [], rowCount: 0 };
            }
            timestamp += 1;
            const occurredAt = `2030-01-01T00:00:${String(timestamp).padStart(2, "0")}.000Z`;
            message.content = structuredClone(content);
            message.currentRevision += 1;
            message.updatedAt = occurredAt;
            message.editedAt = occurredAt;
            message.editedByUserId = editorUserId;
            return { rows: [toRow(message)], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_message_revisions")) {
            const messageId = values[1];
            working.revisions.set(
              messageId,
              (working.revisions.get(messageId) ?? 0) + 1,
            );
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_audit_events")) {
            const messageId = values[3];
            working.audit.set(messageId, (working.audit.get(messageId) ?? 0) + 1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_outbox_events")) {
            const messageId = values[5].message.id;
            working.outbox.set(messageId, (working.outbox.get(messageId) ?? 0) + 1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
            if (failCompletion) {
              return { rows: [], rowCount: 0 };
            }
            const [responseStatus, responseBody, , tenantId, userId, operation,
              key, requestHash] = values;
            const identity = JSON.stringify([tenantId, userId, operation, key]);
            const current = working.idempotency.get(identity);
            if (current === undefined || current.requestHash !== requestHash) {
              return { rows: [], rowCount: 0 };
            }
            working.idempotency.set(identity, {
              requestHash,
              state: "completed",
              responseStatus,
              responseBody: structuredClone(responseBody),
            });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected edit command query: ${sql}`);
        },
        release() {},
      };
    },
  };

  return {
    resource,
    get authorLookupCount() {
      return authorLookupCount;
    },
    get connectCount() {
      return connectCount;
    },
    setFailAuthorLookup(value) {
      failAuthorLookup = value;
    },
    setFailCompletion(value) {
      failCompletion = value;
    },
    state(messageId) {
      const message = committed.messages.get(messageId);
      return {
        sequence: message?.sequence ?? null,
        revision: message?.currentRevision ?? null,
        content: message?.content ?? null,
        revisions: committed.revisions.get(messageId) ?? 0,
        audit: committed.audit.get(messageId) ?? 0,
        outbox: committed.outbox.get(messageId) ?? 0,
      };
    },
  };
};

test("PATCH /messages/:messageId mounts the canonical edit command", async (t) => {
  const database = createScriptedEditDatabase();
  let capabilities = ["message.edit"];
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
        throw new Error("message edit route must not use the directory");
      },
      async searchUsers() {
        throw new Error("message edit route must not use the directory");
      },
    },
    permissions: {
      async getCapabilities({ actor: requestActor }) {
        assert.deepEqual(requestActor, actor);
        return capabilities;
      },
      async authorizeEntity() {
        throw new Error("message edit route must not authorize host entities");
      },
    },
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await t.test("applies an edit without changing message sequence", async () => {
      const requestInput = editInput("owned", "success");
      const beforeLookups = database.authorLookupCount;
      const response = await request("/messages/owned", requestInput);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const result = parseEditMessageResult(await response.json());
      assert.equal(database.authorLookupCount - beforeLookups, 1);
      assert.equal(result.reconciliationStatus, "applied");
      assert.equal(result.message.sequence, 41);
      assert.equal(result.message.revision.revision, 2);
      assert.equal(result.canonicalRevision, 2);
      assert.deepEqual(result.message.content, requestInput.content);
      assert.deepEqual(result.message.author, { type: "user", userId: actor.userId });
      assert.deepEqual(database.state("owned"), {
        sequence: 41,
        revision: 2,
        content: requestInput.content,
        revisions: 1,
        audit: 1,
        outbox: 1,
      });
    });

    await t.test("replays an exact key without a second mutation", async () => {
      const requestInput = editInput("retry", "retry");
      const firstResponse = await request("/messages/retry", requestInput);
      const first = parseEditMessageResult(await firstResponse.json());
      const replayResponse = await request("/messages/retry", requestInput);
      const replay = parseEditMessageResult(await replayResponse.json());
      assert.equal(firstResponse.status, 200);
      assert.equal(replayResponse.status, 200);
      assert.equal(first.reconciliationStatus, "applied");
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.equal(replay.message.sequence, 42);
      assert.deepEqual(replay.message, first.message);
      assert.deepEqual(database.state("retry"), {
        sequence: 42,
        revision: 2,
        content: requestInput.content,
        revisions: 1,
        audit: 1,
        outbox: 1,
      });

      await assertStableError(
        await request("/messages/retry", {
          ...requestInput,
          content: { format: "plain", text: "Conflicting key reuse" },
        }),
        409,
        CHAT_MESSAGE_EDIT_CONFLICT_CODE,
        "Message edit conflicts with current server state",
      );
      assert.equal(database.state("retry").revision, 2);
    });

    await t.test("returns canonical state for stale revisions and conflict replay", async () => {
      const requestInput = editInput("stale", "stale", { expectedRevision: 1 });
      const firstResponse = await request("/messages/stale", requestInput);
      const first = parseEditMessageResult(await firstResponse.json());
      assert.equal(firstResponse.status, 409);
      assert.equal(first.reconciliationStatus, "revision_conflict");
      assert.equal(first.expectedRevision, 1);
      assert.equal(first.canonicalRevision, 3);
      assert.equal(first.message.sequence, 43);
      assert.equal(first.message.revision.revision, 3);

      const replayResponse = await request("/messages/stale", requestInput);
      const replay = parseEditMessageResult(await replayResponse.json());
      assert.equal(replayResponse.status, 409);
      assert.deepEqual(replay, first);
      assert.deepEqual(database.state("stale"), {
        sequence: 43,
        revision: 3,
        content: { format: "plain", text: "Original stale" },
        revisions: 0,
        audit: 0,
        outbox: 0,
      });
    });

    await t.test("rejects malformed transport and spoofed identity before command execution", async () => {
      const valid = editInput("validation", "validation");
      const invalidRequests = [
        () => request("/messages/validation", valid, { body: "{" }),
        () => request("/messages/validation", valid, { contentType: "text/plain" }),
        () => request("/messages/validation?unexpected=true", valid),
        () => request("/messages", valid),
        () => request("/messages/", valid),
        () => request("/messages/validation/extra", valid),
        () => request("/messages/validation%2Fchild", valid),
        () => request("/messages/validation%5Cchild", valid),
        () => request("/messages/%", valid),
        () => request("/messages/other", valid),
        () => request("/messages/validation", { ...valid, expectedRevision: 0 }),
        () => request("/messages/validation", { ...valid, expectedRevision: 1.5 }),
        () => request("/messages/validation", { ...valid, content: { format: "html", text: "bad" } }),
        () => request("/messages/validation", { ...valid, tenantId: "tenant-b" }),
        () => request("/messages/validation", { ...valid, userId: "spoofed" }),
        () => request("/messages/validation", { ...valid, actor: actor }),
        () => request("/messages/validation", { ...valid, unknown: true }),
        () => request("/messages/validation", valid, { omitIdempotencyKey: true }),
        () => request("/messages/validation", valid, { idempotencyKey: "other-key" }),
        () => request("/messages/validation", { ...valid, idempotencyKey: "bad,key" }, { idempotencyKey: "bad,key" }),
        () => request("/messages/validation", valid, {
          body: JSON.stringify({
            ...valid,
            content: { format: "plain", text: "x".repeat(MAX_EDIT_MESSAGE_REQUEST_BYTES) },
          }),
        }),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeLookups = database.authorLookupCount;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_MESSAGE_EDIT_INVALID_REQUEST_CODE,
          "Invalid message edit request",
        );
        assert.equal(database.authorLookupCount, beforeLookups);
      }

      const duplicateBody = JSON.stringify(valid);
      const beforeDuplicate = database.authorLookupCount;
      await assertStableError(
        await rawRequest("/messages/validation", {
          body: duplicateBody,
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "idempotency-key", valid.idempotencyKey,
            "idempotency-key", valid.idempotencyKey,
            "content-length", String(Buffer.byteLength(duplicateBody)),
          ],
        }),
        400,
        CHAT_MESSAGE_EDIT_INVALID_REQUEST_CODE,
        "Invalid message edit request",
      );
      assert.equal(database.authorLookupCount, beforeDuplicate);

      await assertStableError(
        await rawRequest("/messages/validation", {
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "idempotency-key", valid.idempotencyKey,
            "content-length", String(MAX_EDIT_MESSAGE_REQUEST_BYTES + 1),
          ],
        }),
        400,
        CHAT_MESSAGE_EDIT_INVALID_REQUEST_CODE,
        "Invalid message edit request",
      );
      assert.equal(database.authorLookupCount, beforeDuplicate);
    });

    await t.test("maps authentication and indistinguishable authorization failures", async () => {
      await assertStableError(
        await request(
          "/messages/validation",
          editInput("validation", "unauthenticated"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      capabilities = [];
      const responses = [];
      for (const messageId of ["unauthorized", "missing", "cross-tenant"]) {
        const response = await request(
          `/messages/${messageId}`,
          editInput(messageId, messageId),
        );
        responses.push({ status: response.status, body: await response.json() });
      }
      assert.deepEqual(responses, Array.from({ length: 3 }, () => ({
        status: 403,
        body: {
          error: {
            code: CHAT_AUTHORIZATION_ERROR_CODE,
            message: "Chat authorization failed",
          },
        },
      })));
      capabilities = ["message.edit"];
    });

    await t.test("maps in-progress command conflicts and unexpected failures safely", async () => {
      database.setFailCompletion(true);
      await assertStableError(
        await request(
          "/messages/in-progress",
          editInput("in-progress", "in-progress"),
        ),
        409,
        CHAT_MESSAGE_EDIT_CONFLICT_CODE,
        "Message edit conflicts with current server state",
      );
      database.setFailCompletion(false);
      assert.deepEqual(database.state("in-progress"), {
        sequence: 44,
        revision: 1,
        content: { format: "plain", text: "Original in-progress" },
        revisions: 0,
        audit: 0,
        outbox: 0,
      });

      database.setFailAuthorLookup(true);
      const response = await request(
        "/messages/failure",
        editInput("failure", "failure", {
          content: { format: "plain", text: "sensitive request value" },
        }),
      );
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: {
          code: CHAT_MESSAGE_EDIT_UNAVAILABLE_CODE,
          message: "Message edit temporarily unavailable",
        },
      });
      for (const forbidden of [
        "sensitive request value",
        "database host",
        "credential",
        "stack",
      ]) {
        assert.equal(text.includes(forbidden), false);
      }
      database.setFailAuthorLookup(false);
    });
  });
});
