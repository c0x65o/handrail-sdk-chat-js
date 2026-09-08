import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseReactionMutationResult } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_MESSAGE_REACTION_CONFLICT_CODE,
  CHAT_MESSAGE_REACTION_INVALID_REQUEST_CODE,
  CHAT_MESSAGE_REACTION_UNAVAILABLE_CODE,
  MAX_REACTION_MUTATION_REQUEST_BYTES,
  MESSAGE_REACTION_ROUTE_PREFIX,
  MESSAGE_REACTION_ROUTE_SEGMENT,
  SET_REACTION_CAPABILITY,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const reactionInput = (
  operation,
  messageId,
  suffix,
  reactionKey = "👍",
) => ({
  operation,
  messageId,
  reactionKey,
  idempotencyKey: `http-reaction-${suffix}`,
});

const reactionPath = (messageId, reactionKey) =>
  `${MESSAGE_REACTION_ROUTE_PREFIX}${encodeURIComponent(messageId)}` +
  `${MESSAGE_REACTION_ROUTE_SEGMENT}${encodeURIComponent(reactionKey)}`;

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
        if (Array.isArray(body)) {
          for (const chunk of body) request.write(chunk);
          request.end();
        } else {
          request.end(body);
        }
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

const createScriptedReactionDatabase = () => {
  const messages = new Map([
    ["aggregate", { tenantId: "tenant-a", accessible: true }],
    ["normalized", { tenantId: "tenant-a", accessible: true }],
    ["validation", { tenantId: "tenant-a", accessible: true }],
    ["unauthorized", { tenantId: "tenant-a", accessible: false }],
    ["cross-tenant", { tenantId: "tenant-b", accessible: true }],
    ["failure", { tenantId: "tenant-a", accessible: true }],
    ["in-progress", { tenantId: "tenant-a", accessible: true }],
  ]);
  let committed = {
    reactions: new Set(),
    idempotency: new Map(),
    audit: new Map(),
    outbox: new Map(),
  };
  let connectCount = 0;
  let failAccess = false;

  const reactionIdentity = (tenantId, messageId, userId, reactionKey) =>
    JSON.stringify([tenantId, messageId, userId, reactionKey]);
  const idempotencyIdentity = (tenantId, userId, operation, key) =>
    JSON.stringify([tenantId, userId, operation, key]);

  const resource = {
    async query(sql) {
      throw new Error(`unexpected direct reaction HTTP query: ${sql}`);
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
          assert.equal(active, true, "reaction command SQL must be transactional");

          if (sql.includes("claim_chat_idempotency_key")) {
            const [tenantId, userId, operation, key, requestHash] = values;
            const identity = idempotencyIdentity(
              tenantId,
              userId,
              operation,
              key,
            );
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
            const state = "pending";
            working.idempotency.set(identity, {
              requestHash,
              state,
              responseBody: null,
            });
            return {
              rows: [{
                idempotency_state: state,
                stored_response_body: null,
              }],
              rowCount: 1,
            };
          }
          if (
            sql.includes("FROM") &&
            sql.includes("chat_messages AS message") &&
            sql.includes("FOR UPDATE OF message, conversation")
          ) {
            const [tenantId, , messageId] = values;
            if (failAccess && messageId === "failure") {
              throw new Error(
                "sensitive database host, credential, and request detail",
              );
            }
            const message = messages.get(messageId);
            if (
              message === undefined ||
              message.tenantId !== tenantId ||
              message.accessible !== true
            ) {
              return { rows: [], rowCount: 0 };
            }
            return {
              rows: [{
                conversation_id: `conversation-${messageId}`,
                entity_type: null,
                entity_id: null,
                observed_at: "2030-01-01T00:00:00.000Z",
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_reactions")) {
            const [tenantId, messageId, userId, reactionKey] = values;
            working.reactions.add(
              reactionIdentity(tenantId, messageId, userId, reactionKey),
            );
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("DELETE FROM") && sql.includes("chat_reactions")) {
            const [tenantId, messageId, userId, reactionKey] = values;
            const deleted = working.reactions.delete(
              reactionIdentity(tenantId, messageId, userId, reactionKey),
            );
            return { rows: [], rowCount: deleted ? 1 : 0 };
          }
          if (sql.includes("SELECT count(*)") && sql.includes("chat_reactions")) {
            const [tenantId, messageId, reactionKey] = values;
            let count = 0;
            for (const encoded of working.reactions) {
              const [storedTenantId, storedMessageId, , storedReactionKey] =
                JSON.parse(encoded);
              if (
                storedTenantId === tenantId &&
                storedMessageId === messageId &&
                storedReactionKey === reactionKey
              ) {
                count += 1;
              }
            }
            return { rows: [{ reaction_count: String(count) }], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_audit_events")) {
            const messageId = values[4];
            working.audit.set(messageId, (working.audit.get(messageId) ?? 0) + 1);
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_outbox_events")) {
            const messageId = values[6].messageId;
            working.outbox.set(
              messageId,
              (working.outbox.get(messageId) ?? 0) + 1,
            );
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE") && sql.includes("chat_idempotency_keys")) {
            const [responseBody, , tenantId, userId, operation, key, requestHash] =
              values;
            const identity = idempotencyIdentity(
              tenantId,
              userId,
              operation,
              key,
            );
            const current = working.idempotency.get(identity);
            if (
              key === "http-reaction-in-progress" ||
              current === undefined ||
              current.state !== "pending" ||
              current.requestHash !== requestHash
            ) {
              return { rows: [], rowCount: 0 };
            }
            working.idempotency.set(identity, {
              requestHash,
              state: "completed",
              responseBody: structuredClone(responseBody),
            });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected reaction command query: ${sql}`);
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
    setFailAccess(value) {
      failAccess = value;
    },
    state(messageId, reactionKey) {
      return {
        reacted: committed.reactions.has(
          reactionIdentity(actor.tenantId, messageId, actor.userId, reactionKey),
        ),
        audit: committed.audit.get(messageId) ?? 0,
        outbox: committed.outbox.get(messageId) ?? 0,
      };
    },
  };
};

test("PATCH /messages/:messageId/reactions/:reactionKey mounts setReaction", async (t) => {
  const database = createScriptedReactionDatabase();
  let capabilities = [SET_REACTION_CAPABILITY];
  let capabilityCalls = 0;
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
        throw new Error("message reaction route must not use the directory");
      },
      async searchUsers() {
        throw new Error("message reaction route must not use the directory");
      },
    },
    permissions: {
      async getCapabilities({ actor: requestActor }) {
        capabilityCalls += 1;
        assert.deepEqual(requestActor, actor);
        return capabilities;
      },
      async authorizeEntity() {
        return true;
      },
    },
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await t.test("adds, repeats, removes, and replays canonical aggregates", async () => {
      const path = reactionPath("aggregate", "👍");
      const add = reactionInput("add_reaction", "aggregate", "add");
      const firstResponse = await request(path, add);
      assert.equal(firstResponse.status, 200);
      assert.equal(firstResponse.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(parseReactionMutationResult(await firstResponse.json()), {
        operation: "add_reaction",
        reconciliationStatus: "applied",
        messageId: "aggregate",
        reactionKey: "👍",
        count: 1,
        reactedByCurrentUser: true,
      });

      const repeatedAdd = reactionInput(
        "add_reaction",
        "aggregate",
        "repeated-add",
      );
      assert.deepEqual(
        parseReactionMutationResult(
          await (await request(path, repeatedAdd)).json(),
        ),
        {
          operation: "add_reaction",
          reconciliationStatus: "applied",
          messageId: "aggregate",
          reactionKey: "👍",
          count: 1,
          reactedByCurrentUser: true,
        },
      );

      const replayResponse = await request(path, add);
      assert.deepEqual(parseReactionMutationResult(await replayResponse.json()), {
        operation: "add_reaction",
        reconciliationStatus: "replayed",
        messageId: "aggregate",
        reactionKey: "👍",
        count: 1,
        reactedByCurrentUser: true,
      });

      const remove = reactionInput("remove_reaction", "aggregate", "remove");
      assert.deepEqual(
        parseReactionMutationResult(await (await request(path, remove)).json()),
        {
          operation: "remove_reaction",
          reconciliationStatus: "applied",
          messageId: "aggregate",
          reactionKey: "👍",
          count: 0,
          reactedByCurrentUser: false,
        },
      );
      const repeatedRemove = reactionInput(
        "remove_reaction",
        "aggregate",
        "repeated-remove",
      );
      assert.deepEqual(
        parseReactionMutationResult(
          await (await request(path, repeatedRemove)).json(),
        ),
        {
          operation: "remove_reaction",
          reconciliationStatus: "applied",
          messageId: "aggregate",
          reactionKey: "👍",
          count: 0,
          reactedByCurrentUser: false,
        },
      );
      assert.deepEqual(database.state("aggregate", "👍"), {
        reacted: false,
        audit: 4,
        outbox: 4,
      });
      assert.equal(capabilityCalls, 10, "context and command resolve capabilities once each");
    });

    await t.test("decodes one canonical NFC reaction key and serializes it unchanged", async () => {
      const reactionKey = "café";
      const input = reactionInput(
        "add_reaction",
        "normalized",
        "normalized",
        reactionKey,
      );
      const response = await request(reactionPath("normalized", reactionKey), input);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        operation: "add_reaction",
        reconciliationStatus: "applied",
        messageId: "normalized",
        reactionKey,
        count: 1,
        reactedByCurrentUser: true,
      });
    });

    await t.test("rejects malformed, mismatched, toggle, spoofed, and invalid idempotency input before command work", async () => {
      const valid = reactionInput(
        "add_reaction",
        "validation",
        "validation",
        "👍",
      );
      const validPath = reactionPath("validation", "👍");
      const decomposedKey = "cafe\u0301";
      const invalidRequests = [
        () => request(validPath, valid, { body: "{" }),
        () => request(validPath, valid, { contentType: "text/plain" }),
        () => request(`${validPath}?unexpected=true`, valid),
        () => request("/messages/validation/reactions", valid),
        () => request("/messages/validation/reactions/", valid),
        () => request(`${validPath}/extra`, valid),
        () => request("/messages/validation%2Fchild/reactions/%F0%9F%91%8D", valid),
        () => request("/messages/validation/reactions/%", valid),
        () => request(reactionPath("other", "👍"), valid),
        () => request(reactionPath("validation", "🔥"), valid),
        () => request(reactionPath("validation", decomposedKey), {
          ...valid,
          reactionKey: "café",
        }),
        () => request(validPath, { ...valid, operation: "toggle_reaction" }),
        () => request(validPath, { ...valid, tenantId: "tenant-b" }),
        () => request(validPath, { ...valid, userId: "spoofed" }),
        () => request(validPath, { ...valid, roles: ["admin"] }),
        () => request(validPath, { ...valid, actor }),
        () => request(validPath, { ...valid, unknown: true }),
        () => request(validPath, valid, { omitIdempotencyKey: true }),
        () => request(validPath, valid, { idempotencyKey: "other-key" }),
        () => request(
          validPath,
          { ...valid, idempotencyKey: "bad,key" },
          { idempotencyKey: "bad,key" },
        ),
        () => request(validPath, valid, {
          body: JSON.stringify({
            ...valid,
            padding: "x".repeat(MAX_REACTION_MUTATION_REQUEST_BYTES),
          }),
        }),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeConnects = database.connectCount;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_MESSAGE_REACTION_INVALID_REQUEST_CODE,
          "Invalid message reaction request",
        );
        assert.equal(database.connectCount, beforeConnects);
      }

      const duplicateBody = JSON.stringify(valid);
      const beforeDuplicate = database.connectCount;
      await assertStableError(
        await rawRequest(validPath, {
          body: duplicateBody,
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
            String(Buffer.byteLength(duplicateBody)),
          ],
        }),
        400,
        CHAT_MESSAGE_REACTION_INVALID_REQUEST_CODE,
        "Invalid message reaction request",
      );
      assert.equal(database.connectCount, beforeDuplicate);

      await assertStableError(
        await rawRequest(validPath, {
          body: [
            Buffer.alloc(MAX_REACTION_MUTATION_REQUEST_BYTES, 0x20),
            Buffer.from("x"),
          ],
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "idempotency-key", valid.idempotencyKey,
            "transfer-encoding", "chunked",
          ],
        }),
        400,
        CHAT_MESSAGE_REACTION_INVALID_REQUEST_CODE,
        "Invalid message reaction request",
      );
      assert.equal(database.connectCount, beforeDuplicate);
    });

    await t.test("maps authentication and indistinguishable authorization failures", async () => {
      await assertStableError(
        await request(
          reactionPath("validation", "👍"),
          reactionInput("add_reaction", "validation", "unauthenticated"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      const responses = [];
      for (const messageId of ["unauthorized", "missing", "cross-tenant"]) {
        const response = await request(
          reactionPath(messageId, "👍"),
          reactionInput("add_reaction", messageId, messageId),
        );
        responses.push({ status: response.status, body: await response.json() });
      }
      assert.deepEqual(
        responses,
        Array.from({ length: 3 }, () => ({
          status: 403,
          body: {
            error: {
              code: CHAT_AUTHORIZATION_ERROR_CODE,
              message: "Chat authorization failed",
            },
          },
        })),
      );

      capabilities = [];
      await assertStableError(
        await request(
          reactionPath("validation", "👍"),
          reactionInput("add_reaction", "validation", "capability"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      capabilities = [SET_REACTION_CAPABILITY];
    });

    await t.test("maps replay conflicts and in-progress claims to one safe conflict", async () => {
      const path = reactionPath("validation", "🔥");
      const input = reactionInput(
        "add_reaction",
        "validation",
        "conflict",
        "🔥",
      );
      assert.equal((await request(path, input)).status, 200);
      await assertStableError(
        await request(path, { ...input, operation: "remove_reaction" }),
        409,
        CHAT_MESSAGE_REACTION_CONFLICT_CODE,
        "Message reaction conflicts with current server state",
      );

      await assertStableError(
        await request(
          reactionPath("in-progress", "🔥"),
          reactionInput("add_reaction", "in-progress", "in-progress", "🔥"),
        ),
        409,
        CHAT_MESSAGE_REACTION_CONFLICT_CODE,
        "Message reaction conflicts with current server state",
      );
    });

    await t.test("sanitizes unexpected command failures", async () => {
      database.setFailAccess(true);
      const response = await request(
        reactionPath("failure", "👍"),
        reactionInput(
          "add_reaction",
          "failure",
          "sensitive-request-value",
        ),
      );
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: {
          code: CHAT_MESSAGE_REACTION_UNAVAILABLE_CODE,
          message: "Message reaction temporarily unavailable",
        },
      });
      for (const forbidden of [
        "sensitive-request-value",
        "database host",
        "credential",
        "stack",
      ]) {
        assert.equal(text.includes(forbidden), false);
      }
      database.setFailAccess(false);
    });
  });
});
