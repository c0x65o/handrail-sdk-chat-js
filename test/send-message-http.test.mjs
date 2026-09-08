import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Bundle current source so HTTP checks cannot accidentally exercise stale dist.
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(repositoryRoot, ".send-message-http-"));
let transport;
try {
  // Match src/server depth for the runtime package-version lookup.
  const outfile = join(temporaryRoot, "server", "transport.mjs");
  await build({
    stdin: {
      contents: 'export * from "./src/server/index.ts"; export { parseSendMessageResult } from "./src/contracts/generated/send-message.ts";',
      resolveDir: repositoryRoot, loader: "ts",
    },
    outfile, bundle: true, packages: "external", format: "esm", platform: "node", target: "node22",
  });
  transport = await import(pathToFileURL(outfile).href);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
const {
  parseSendMessageResult,
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_MESSAGE_SEND_ATTACHMENT_UNAVAILABLE_CODE,
  CHAT_MESSAGE_SEND_CONFLICT_CODE,
  CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE,
  CHAT_MESSAGE_SEND_MENTION_UNAVAILABLE_CODE,
  CHAT_MESSAGE_SEND_UNAVAILABLE_CODE,
  MAX_SEND_MESSAGE_REQUEST_BYTES,
  SEND_MESSAGE_ENTITY_POLICY_ACTION,
  createChatServer,
} = transport;

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const input = (conversationId, suffix, overrides = {}) => ({
  operation: "send",
  conversationId,
  clientMessageId: `client-${suffix}`,
  idempotencyKey: `http-send-${suffix}`,
  content: { format: "plain", text: `Message ${suffix}` },
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
            method: "POST",
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
          method: "POST",
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

const createScriptedSendDatabase = () => {
  const conversations = new Map(
    [
      ["plain", {}],
      ["idempotent", {}],
      ["validation-errors", {}],
      ["capability-denied", {}],
      ["rich", { entityType: "order", entityId: "order-42" }],
      [
        "entity-denied",
        { entityType: "invoice", entityId: "invoice-denied" },
      ],
      ["cross-tenant", { tenantId: "tenant-b" }],
    ].map(([id, overrides]) => [
      id,
      {
        id,
        tenantId: "tenant-a",
        memberUserId: actor.userId,
        memberState: "active",
        sequence: 0,
        entityType: null,
        entityId: null,
        ...overrides,
      },
    ]),
  );
  const attachments = new Map([
    [
      "attachment-finalized",
      {
        id: "attachment-finalized",
        tenantId: actor.tenantId,
        uploaderUserId: actor.userId,
        state: "pending",
        checksum: `sha256:${"a".repeat(64)}`,
      },
    ],
    [
      "attachment-unfinished",
      {
        id: "attachment-unfinished",
        tenantId: actor.tenantId,
        uploaderUserId: actor.userId,
        state: "pending",
        checksum: null,
      },
    ],
  ]);
  const freshState = () => ({
    conversations,
    attachments,
    idempotency: new Map(),
    messages: new Map(),
    audit: new Map(),
    outbox: new Map(),
  });
  let committed = structuredClone(freshState());
  let connectCount = 0;
  let failConnect = false;

  const resource = {
    async query(sql) {
      throw new Error(`unexpected direct send HTTP query: ${sql}`);
    },
    async connect() {
      connectCount += 1;
      if (failConnect) {
        throw new Error("sensitive database host and credential detail");
      }
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
          assert.equal(active, true, "send command SQL must be transactional");

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
                { idempotency_state: "pending", stored_response_body: null },
              ],
              rowCount: 1,
            };
          }
          if (
            sql.includes("UPDATE") &&
            sql.includes("chat_conversations AS conversation")
          ) {
            const [tenantId, conversationId, userId] = values;
            const conversation = working.conversations.get(conversationId);
            if (
              conversation === undefined ||
              conversation.tenantId !== tenantId ||
              conversation.memberUserId !== userId ||
              conversation.memberState !== "active"
            ) {
              return { rows: [], rowCount: 0 };
            }
            conversation.sequence += 1;
            return {
              rows: [
                {
                  sequence: conversation.sequence,
                  occurred_at: "2030-01-01T00:00:00.000Z",
                  entity_type: conversation.entityType,
                  entity_id: conversation.entityId,
                },
              ],
              rowCount: 1,
            };
          }
          if (
            sql.includes("SELECT attachment.id") &&
            sql.includes("chat_attachments")
          ) {
            const [tenantId, userId, attachmentIds] = values;
            const rows = attachmentIds.flatMap((attachmentId) => {
              const attachment = working.attachments.get(attachmentId);
              return attachment !== undefined &&
                attachment.tenantId === tenantId &&
                attachment.uploaderUserId === userId &&
                attachment.state === "pending" &&
                attachment.checksum !== null
                ? [{ id: attachmentId }]
                : [];
            });
            return { rows, rowCount: rows.length };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_messages (")
          ) {
            const [tenantId, messageId, conversationId, sequence, userId,
              clientMessageId, content] = values;
            working.messages.set(messageId, {
              tenantId,
              messageId,
              conversationId,
              sequence,
              userId,
              clientMessageId,
              content,
            });
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_message_revisions")
          ) {
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("UPDATE") &&
            sql.includes("chat_attachments")
          ) {
            const [messageId, , tenantId, userId, attachmentIds] = values;
            let rowCount = 0;
            for (const attachmentId of attachmentIds) {
              const attachment = working.attachments.get(attachmentId);
              if (
                attachment !== undefined &&
                attachment.tenantId === tenantId &&
                attachment.uploaderUserId === userId &&
                attachment.state === "pending" &&
                attachment.checksum !== null
              ) {
                attachment.state = "attached";
                attachment.messageId = messageId;
                rowCount += 1;
              }
            }
            return { rows: [], rowCount };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_audit_events")
          ) {
            const conversationId = values[5].conversationId;
            working.audit.set(
              conversationId,
              (working.audit.get(conversationId) ?? 0) + 1,
            );
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_outbox_events")
          ) {
            const conversationId = values[3];
            working.outbox.set(
              conversationId,
              (working.outbox.get(conversationId) ?? 0) + 1,
            );
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("UPDATE") &&
            sql.includes("chat_idempotency_keys")
          ) {
            const [responseBody, , tenantId, userId, operation, key,
              requestHash] = values;
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
          throw new Error(`unexpected send command query: ${sql}`);
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
    setFailConnect(value) {
      failConnect = value;
    },
    attachmentState(attachmentId) {
      return committed.attachments.get(attachmentId)?.state;
    },
    sideEffects(conversationId) {
      return {
        messages: [...committed.messages.values()].filter(
          (message) => message.conversationId === conversationId,
        ).length,
        audit: committed.audit.get(conversationId) ?? 0,
        outbox: committed.outbox.get(conversationId) ?? 0,
        sequence:
          committed.conversations.get(conversationId)?.sequence ?? null,
      };
    },
  };
};

test("POST /conversations/:conversationId/messages mounts the canonical send command", async (t) => {
  const database = createScriptedSendDatabase();
  let capabilities = ["message.send"];
  let entityAllowed = true;
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
      async getUser(request) {
        directoryCalls.push(request);
        return request.userId === "mentioned-a"
          ? {
              tenantId: actor.tenantId,
              userId: request.userId,
              displayName: "Mentioned User",
            }
          : null;
      },
      async searchUsers() {
        throw new Error("message send route must not search the directory");
      },
    },
    permissions: {
      async getCapabilities({ actor: requestActor }) {
        assert.deepEqual(requestActor, actor);
        return capabilities;
      },
      async authorizeEntity(request) {
        entityCalls.push(request);
        return entityAllowed;
      },
    },
  });

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await t.test("accepts plain and rich markdown content with canonical actor identity", async () => {
      const plainInput = input("plain", "plain");
      const beforePlain = database.connectCount;
      const plainResponse = await request(
        "/conversations/plain/messages",
        plainInput,
      );
      assert.equal(plainResponse.status, 201);
      const plain = parseSendMessageResult(await plainResponse.json());
      assert.equal(database.connectCount - beforePlain, 1);
      assert.equal(plain.reconciliationStatus, "applied");
      assert.equal(plain.clientMessageId, plainInput.clientMessageId);
      assert.equal(plain.message.sequence, 1);
      assert.deepEqual(plain.message.author, {
        type: "user",
        userId: actor.userId,
      });
      assert.deepEqual(Object.keys(plain).sort(), [
        "canonicalRevision",
        "clientMessageId",
        "message",
        "operation",
        "reconciliationStatus",
      ]);

      const richInput = input("rich", "rich", {
        content: {
          format: "markdown",
          text: "Hello **team**",
          mentions: [
            { type: "user", userId: "mentioned-a" },
            { type: "conversation", conversationId: "plain" },
            { type: "entity", entity: { type: "order", id: "order-42" } },
          ],
          attachments: [{ attachmentId: "attachment-finalized" }],
        },
      });
      const richResponse = await request(
        "/conversations/rich/messages",
        richInput,
      );
      assert.equal(richResponse.status, 201);
      const rich = parseSendMessageResult(await richResponse.json());
      assert.deepEqual(rich.message.content, richInput.content);
      assert.equal(rich.message.sequence, 1);
      assert.equal(database.attachmentState("attachment-finalized"), "attached");
      assert.deepEqual(directoryCalls.at(-1), {
        actor,
        userId: "mentioned-a",
      });
      assert.deepEqual(entityCalls.at(-1), {
        actor,
        entity: { type: "order", id: "order-42" },
        action: SEND_MESSAGE_ENTITY_POLICY_ACTION,
      });
    });

    await t.test("replays an exact retry and rejects conflicting key reuse", async () => {
      const requestInput = input("idempotent", "retry");
      const firstResponse = await request(
        "/conversations/idempotent/messages",
        requestInput,
      );
      const first = await firstResponse.json();
      assert.equal(firstResponse.status, 201);
      assert.equal(first.reconciliationStatus, "applied");

      const replayResponse = await request(
        "/conversations/idempotent/messages",
        requestInput,
      );
      const replay = await replayResponse.json();
      assert.equal(replayResponse.status, 200);
      assert.equal(replay.reconciliationStatus, "replayed");
      assert.equal(replay.clientMessageId, requestInput.clientMessageId);
      assert.deepEqual(replay.message, first.message);
      assert.deepEqual(database.sideEffects("idempotent"), {
        messages: 1,
        audit: 1,
        outbox: 1,
        sequence: 1,
      });

      await assertStableError(
        await request("/conversations/idempotent/messages", {
          ...requestInput,
          content: { ...requestInput.content, text: "Conflicting payload" },
        }),
        409,
        CHAT_MESSAGE_SEND_CONFLICT_CODE,
        "Message send conflicts with current server state",
      );
      assert.deepEqual(database.sideEffects("idempotent"), {
        messages: 1,
        audit: 1,
        outbox: 1,
        sequence: 1,
      });
    });

    await t.test("rejects malformed transport and trusted identity spoofing before command dispatch", async () => {
      const valid = input("validation-errors", "invalid-base");
      const invalidRequests = [
        () => request("/conversations/validation-errors/messages", valid, { body: "{" }),
        () => request("/conversations/validation-errors/messages", valid, { contentType: "text/plain" }),
        () => request("/conversations/validation-errors/messages?unexpected=true", valid),
        () => request("/conversations/other/messages", valid),
        () => request("/conversations/validation-errors%2Fchild/messages", valid),
        () => request("/conversations/validation-errors/messages/extra", valid),
        () => request("/conversations/validation-errors/messages", { ...valid, tenantId: "tenant-b" }),
        () => request("/conversations/validation-errors/messages", { ...valid, author: { type: "user", userId: "spoofed" } }),
        () => request("/conversations/validation-errors/messages", valid, { omitIdempotencyKey: true }),
        () => request("/conversations/validation-errors/messages", valid, { idempotencyKey: "other-key" }),
        () => request("/conversations/validation-errors/messages", { ...valid, idempotencyKey: "bad,key" }, { idempotencyKey: "bad,key" }),
        () => request("/conversations/validation-errors/messages", valid, {
          body: JSON.stringify({
            ...valid,
            content: {
              format: "plain",
              text: "x".repeat(MAX_SEND_MESSAGE_REQUEST_BYTES),
            },
          }),
        }),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeConnects = database.connectCount;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE,
          "Invalid message send request",
        );
        assert.equal(database.connectCount, beforeConnects);
      }

      const duplicateBody = JSON.stringify(valid);
      const beforeDuplicate = database.connectCount;
      await assertStableError(
        await rawRequest("/conversations/validation-errors/messages", {
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
        CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE,
        "Invalid message send request",
      );
      assert.equal(database.connectCount, beforeDuplicate);

      const beforeStreamedOverflow = database.connectCount;
      const streamedOverflow = await rawRequest(
        "/conversations/validation-errors/messages",
        {
          chunks: [
            " ".repeat(MAX_SEND_MESSAGE_REQUEST_BYTES),
            "x",
          ],
          headers: [
            "authorization", "Bearer valid",
            "content-type", "application/json",
            "transfer-encoding", "chunked",
            "idempotency-key", valid.idempotencyKey,
          ],
        },
      );
      await assertStableError(
        streamedOverflow,
        400,
        CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE,
        "Invalid message send request",
      );
      assert.equal(database.connectCount, beforeStreamedOverflow);
    });

    await t.test("maps authentication and safe authorization failures", async () => {
      await assertStableError(
        await request(
          "/conversations/capability-denied/messages",
          input("capability-denied", "unauthenticated"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      capabilities = [];
      await assertStableError(
        await request(
          "/conversations/capability-denied/messages",
          input("capability-denied", "capability-denied"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      capabilities = ["message.send"];

      for (const conversationId of ["missing", "cross-tenant"]) {
        await assertStableError(
          await request(
            `/conversations/${conversationId}/messages`,
            input(conversationId, conversationId),
          ),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        );
      }

      entityAllowed = false;
      await assertStableError(
        await request(
          "/conversations/entity-denied/messages",
          input("entity-denied", "entity-denied"),
        ),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
      entityAllowed = true;
    });

    await t.test("maps invalid mentions and unfinished attachments", async () => {
      await assertStableError(
        await request(
          "/conversations/validation-errors/messages",
          input("validation-errors", "missing-mention", {
            content: {
              format: "plain",
              text: "Hello",
              mentions: [{ type: "user", userId: "missing-user" }],
            },
          }),
        ),
        422,
        CHAT_MESSAGE_SEND_MENTION_UNAVAILABLE_CODE,
        "One or more mentioned users are unavailable",
      );
      for (const attachmentId of [
        "attachment-unfinished",
        "missing-attachment",
      ]) {
        await assertStableError(
          await request(
            "/conversations/validation-errors/messages",
            input("validation-errors", attachmentId, {
              content: {
                format: "plain",
                text: "Attachment",
                attachments: [{ attachmentId }],
              },
            }),
          ),
          422,
          CHAT_MESSAGE_SEND_ATTACHMENT_UNAVAILABLE_CODE,
          "One or more attachments are unavailable",
        );
      }
      assert.deepEqual(database.sideEffects("validation-errors"), {
        messages: 0,
        audit: 0,
        outbox: 0,
        sequence: 0,
      });
    });

    await t.test("sanitizes unexpected failures", async () => {
      database.setFailConnect(true);
      const response = await request(
        "/conversations/validation-errors/messages",
        input("validation-errors", "internal-failure", {
          content: { format: "plain", text: "sensitive request value" },
        }),
      );
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), {
        error: {
          code: CHAT_MESSAGE_SEND_UNAVAILABLE_CODE,
          message: "Message send temporarily unavailable",
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
      database.setFailConnect(false);
    });
  });
});


test("reply references cross HTTP parsing and malformed references never dispatch", async () => {
  let databaseCalls = 0;
  const unavailableDatabase = async () => {
    databaseCalls += 1;
    throw new Error("Persistence is unavailable in this transport-only test");
  };
  const runtime = createChatServer({
    outbox: { pollIntervalMs: 60_000 },
    postgresMaintenance: { pollIntervalMs: 60_000 },
    database: { pool: { query: unavailableDatabase, connect: unavailableDatabase } },
    auth: { async resolveActor() { return actor; } },
    directory: { async getUser() { return null; }, async searchUsers() { return { users: [] }; } },
    // A denied capability gives a deterministic boundary after request parsing.
    permissions: { async getCapabilities() { return []; }, async authorizeEntity() { return false; } },
  });
  await withHttpServer(runtime, async ({ request }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const backgroundDatabaseCalls = databaseCalls;
    for (const replyTo of [undefined, { messageId: "source-1", notifyAuthor: true },
      { messageId: "source-1", notifyAuthor: false }]) {
      const wire = input("conversation-1", "reply", replyTo === undefined ? {} : { replyTo });
      const response = await request("/conversations/conversation-1/messages", wire);
      assert.equal(response.status, 403, await response.text());
    }
    for (const replyTo of [null, {}, [], "source-1", { messageId: "source-1" },
      { messageId: "source-1", notifyAuthor: "false" },
      ...["", " source", "source\nline", "é".repeat(128)].map((messageId) => ({ messageId, notifyAuthor: false })),
      ...["actor", "authorId", "displayName", "source", "content"].map((key) =>
        ({ messageId: "source-1", notifyAuthor: false, [key]: "injected" }))]) {
      await assertStableError(
        await request("/conversations/conversation-1/messages", input("conversation-1", "bad-reply", { replyTo })),
        400, CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE, "Invalid message send request",
      );
    }
    assert.equal(databaseCalls, backgroundDatabaseCalls);
  });
});
