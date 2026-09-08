import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES,
  parseSetSavedMessageResult,
} from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_SAVED_MESSAGE_CONFLICT_CODE,
  CHAT_SAVED_MESSAGE_INVALID_REQUEST_CODE,
  CHAT_SAVED_MESSAGE_UNAVAILABLE_CODE,
  MAX_SAVED_MESSAGE_REQUEST_BYTES,
  SAVED_MESSAGE_ROUTE,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "actor-a",
  roles: Object.freeze(["employee"]),
});

const savedInput = (
  intent,
  messageId,
  suffix,
  expectedSavedMessageRevision = 0,
  privateNote,
) => ({
  operation: "set_saved_message",
  intent,
  messageId,
  expectedSavedMessageRevision,
  idempotencyKey: `http-saved-${suffix}`,
  ...(privateNote === undefined ? {} : { privateNote }),
});

const savedPath = (messageId) =>
  SAVED_MESSAGE_ROUTE.replace(":messageId", encodeURIComponent(messageId));

const savedResultRequestFields = (input) => ({
  operation: input.operation,
  intent: input.intent,
  messageId: input.messageId,
  expectedSavedMessageRevision: input.expectedSavedMessageRevision,
  idempotencyKey: input.idempotencyKey,
});

const withHttpServer = async (
  runtime,
  callback,
  { forwardErrors = false } = {},
) => {
  const forwarded = [];
  const listener = forwardErrors
    ? (request, response) => {
        runtime.router(request, response, (error) => {
          if (error === undefined) {
            response.statusCode = 404;
            response.end();
            return;
          }
          forwarded.push(error);
          response.statusCode = error.statusCode ?? 500;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.setHeader("cache-control", "private, no-store");
          response.end(
            JSON.stringify({
              error: { code: error.code, message: error.message },
            }),
          );
        });
      }
    : runtime.router;
  const server = createServer({ joinDuplicateHeaders: true }, listener);
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
      forwarded,
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

const createScriptedSavedMessageDatabase = () => {
  const messages = new Map([
    ["lifecycle", { tenantId: "tenant-a", visible: true }],
    ["without-note", { tenantId: "tenant-a", visible: true }],
    ["conflict", { tenantId: "tenant-a", visible: true }],
    ["validation", { tenantId: "tenant-a", visible: true }],
    ["invisible", { tenantId: "tenant-a", visible: false }],
    ["deleted", { tenantId: "tenant-a", visible: false }],
    ["archived", { tenantId: "tenant-a", visible: false }],
    ["cross-tenant", { tenantId: "tenant-b", visible: true }],
    [
      "entity-denied",
      {
        tenantId: "tenant-a",
        visible: true,
        entityType: "record",
        entityId: "denied",
      },
    ],
    ["failure", { tenantId: "tenant-a", visible: true }],
    ["in-progress", { tenantId: "tenant-a", visible: true }],
  ]);
  const savedIdentity = (tenantId, userId, messageId) =>
    JSON.stringify([tenantId, userId, messageId]);
  const idempotencyIdentity = (tenantId, userId, operation, key) =>
    JSON.stringify([tenantId, userId, operation, key]);
  let committed = {
    saved: new Map([
      [
        savedIdentity("tenant-a", "actor-a", "conflict"),
        { isSaved: true, privateNote: "existing private note", revision: 3 },
      ],
    ]),
    idempotency: new Map(),
    audit: new Map(),
    auditMetadata: new Map(),
    outbox: new Map(),
  };
  let connectCount = 0;
  let failAccess = false;

  const resource = {
    async query(sql) {
      throw new Error(`unexpected direct saved-message HTTP query: ${sql}`);
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
          assert.equal(
            active,
            true,
            "saved-message command SQL must be transactional",
          );

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
            sql.includes("chat_messages AS message") &&
            sql.includes("FOR UPDATE OF message, conversation")
          ) {
            const [tenantId, , messageId] = values;
            if (failAccess && messageId === "failure") {
              throw new Error(
                "sensitive database provider credential and private note detail",
              );
            }
            const message = messages.get(messageId);
            if (
              message === undefined ||
              message.tenantId !== tenantId ||
              message.visible !== true
            ) {
              return { rows: [], rowCount: 0 };
            }
            return {
              rows: [
                {
                  conversation_id: `conversation-${messageId}`,
                  entity_type: message.entityType ?? null,
                  entity_id: message.entityId ?? null,
                  occurred_at: "2030-01-01T00:00:00.000Z",
                },
              ],
              rowCount: 1,
            };
          }
          if (
            sql.includes("SELECT is_saved") &&
            sql.includes("chat_saved_messages")
          ) {
            const [tenantId, userId, messageId] = values;
            const current = working.saved.get(
              savedIdentity(tenantId, userId, messageId),
            );
            return current === undefined
              ? { rows: [], rowCount: 0 }
              : {
                  rows: [
                    {
                      is_saved: current.isSaved,
                      private_note: current.privateNote,
                      saved_message_revision: current.revision,
                    },
                  ],
                  rowCount: 1,
                };
          }
          if (
            sql.includes("INSERT INTO") &&
            sql.includes("chat_saved_messages")
          ) {
            const [tenantId, userId, messageId, , isSaved, privateNote, revision] =
              values;
            working.saved.set(savedIdentity(tenantId, userId, messageId), {
              isSaved,
              privateNote,
              revision,
            });
            return { rows: [], rowCount: 1 };
          }
          if (
            sql.includes("UPDATE") &&
            sql.includes("chat_saved_messages")
          ) {
            const [
              isSaved,
              privateNote,
              revision,
              ,
              tenantId,
              userId,
              messageId,
              expectedRevision,
            ] = values;
            const identity = savedIdentity(tenantId, userId, messageId);
            const current = working.saved.get(identity);
            if (current === undefined || current.revision !== expectedRevision) {
              return { rows: [], rowCount: 0 };
            }
            working.saved.set(identity, { isSaved, privateNote, revision });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_audit_events")) {
            const messageId = values[4];
            working.audit.set(messageId, (working.audit.get(messageId) ?? 0) + 1);
            working.auditMetadata.set(messageId, structuredClone(values[6]));
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO") && sql.includes("chat_outbox_events")) {
            const messageId = values[6].messageId;
            working.outbox.set(
              messageId,
              (working.outbox.get(messageId) ?? 0) + 1,
            );
            assert.equal(values[3], `user:${actor.userId}`);
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
              key === "http-saved-in-progress" ||
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
          throw new Error(`unexpected saved-message command query: ${sql}`);
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
    state(messageId) {
      const current = committed.saved.get(
        savedIdentity(actor.tenantId, actor.userId, messageId),
      );
      return {
        ...(current === undefined ? {} : structuredClone(current)),
        audit: committed.audit.get(messageId) ?? 0,
        auditMetadata: committed.auditMetadata.get(messageId),
        outbox: committed.outbox.get(messageId) ?? 0,
      };
    },
  };
};

const createRuntime = (database) =>
  createChatServer({
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
        throw new Error("saved-message route must not use the directory");
      },
      async searchUsers() {
        throw new Error("saved-message route must not use the directory");
      },
    },
    permissions: {
      async getCapabilities({ actor: requestActor }) {
        assert.deepEqual(requestActor, actor);
        return [];
      },
      async authorizeEntity({ entity }) {
        return entity.id !== "denied";
      },
    },
  });

test("PATCH /messages/:messageId/saved mounts setSavedMessage", async (t) => {
  const database = createScriptedSavedMessageDatabase();
  const runtime = createRuntime(database);

  await withHttpServer(runtime, async ({ request, rawRequest }) => {
    await t.test("saves with and without a private note and returns only actor-private state", async () => {
      const withoutNote = savedInput("save", "without-note", "without-note");
      const withoutNoteResponse = await request(
        savedPath("without-note"),
        withoutNote,
      );
      assert.equal(withoutNoteResponse.status, 200);
      assert.equal(
        withoutNoteResponse.headers.get("cache-control"),
        "private, no-store",
      );
      assert.deepEqual(
        parseSetSavedMessageResult(await withoutNoteResponse.json(), withoutNote),
        {
          ...withoutNote,
          reconciliationStatus: "applied",
          savedMessageRevision: 1,
          savedMessage: { messageId: "without-note", isSaved: true },
        },
      );

      const privateNote = "Actor-only follow-up";
      const withNote = savedInput(
        "save",
        "lifecycle",
        "lifecycle-save",
        0,
        privateNote,
      );
      const withNoteResponse = await request(savedPath("lifecycle"), withNote);
      assert.equal(withNoteResponse.status, 200);
      const result = parseSetSavedMessageResult(
        await withNoteResponse.json(),
        withNote,
      );
      assert.deepEqual(result, {
        ...savedResultRequestFields(withNote),
        reconciliationStatus: "applied",
        savedMessageRevision: 1,
        savedMessage: {
          messageId: "lifecycle",
          isSaved: true,
          privateNote,
        },
      });
      for (const forbidden of [
        "conversationId",
        "channelId",
        "stream",
        "deliveryTarget",
        "audience",
        "tenantId",
        "userId",
        "actor",
      ]) {
        assert.equal(Object.hasOwn(result, forbidden), false);
      }
      assert.deepEqual(database.state("without-note"), {
        isSaved: true,
        privateNote: null,
        revision: 1,
        audit: 1,
        auditMetadata: {
          messageId: "without-note",
          conversationId: "conversation-without-note",
          intent: "save",
          previousSaved: null,
          currentSaved: true,
          privateNoteChanged: false,
          previousSavedMessageRevision: 0,
          currentSavedMessageRevision: 1,
        },
        outbox: 1,
      });
      assert.deepEqual(database.state("lifecycle"), {
        isSaved: true,
        privateNote,
        revision: 1,
        audit: 1,
        auditMetadata: {
          messageId: "lifecycle",
          conversationId: "conversation-lifecycle",
          intent: "save",
          previousSaved: null,
          currentSaved: true,
          privateNoteChanged: true,
          previousSavedMessageRevision: 0,
          currentSavedMessageRevision: 1,
        },
        outbox: 1,
      });
      assert.equal(
        JSON.stringify(database.state("lifecycle").auditMetadata).includes(
          privateNote,
        ),
        false,
      );
    });

    await t.test("replays once, recognizes already-requested state, and explicitly unsaves", async () => {
      const privateNote = "Actor-only follow-up";
      const original = savedInput(
        "save",
        "lifecycle",
        "lifecycle-save",
        0,
        privateNote,
      );
      const connectsBeforeReplay = database.connectCount;
      const replayResponse = await request(savedPath("lifecycle"), original);
      assert.equal(replayResponse.status, 200);
      assert.equal(database.connectCount, connectsBeforeReplay + 1);
      assert.deepEqual(await replayResponse.json(), {
        ...savedResultRequestFields(original),
        reconciliationStatus: "replayed",
        savedMessageRevision: 1,
        savedMessage: {
          messageId: "lifecycle",
          isSaved: true,
          privateNote,
        },
      });
      assert.deepEqual(database.state("lifecycle"), {
        isSaved: true,
        privateNote,
        revision: 1,
        audit: 1,
        auditMetadata: {
          messageId: "lifecycle",
          conversationId: "conversation-lifecycle",
          intent: "save",
          previousSaved: null,
          currentSaved: true,
          privateNoteChanged: true,
          previousSavedMessageRevision: 0,
          currentSavedMessageRevision: 1,
        },
        outbox: 1,
      });

      const already = savedInput(
        "save",
        "lifecycle",
        "already",
        1,
        privateNote,
      );
      const alreadyResponse = await request(savedPath("lifecycle"), already);
      assert.equal(alreadyResponse.status, 200);
      assert.deepEqual(await alreadyResponse.json(), {
        ...savedResultRequestFields(already),
        reconciliationStatus: "already_requested_state",
        savedMessageRevision: 1,
        savedMessage: {
          messageId: "lifecycle",
          isSaved: true,
          privateNote,
        },
      });
      assert.deepEqual(database.state("lifecycle"), {
        isSaved: true,
        privateNote,
        revision: 1,
        audit: 1,
        auditMetadata: {
          messageId: "lifecycle",
          conversationId: "conversation-lifecycle",
          intent: "save",
          previousSaved: null,
          currentSaved: true,
          privateNoteChanged: true,
          previousSavedMessageRevision: 0,
          currentSavedMessageRevision: 1,
        },
        outbox: 1,
      });

      const unsave = savedInput("unsave", "lifecycle", "unsave", 1);
      const unsaveResponse = await request(savedPath("lifecycle"), unsave);
      assert.equal(unsaveResponse.status, 200);
      assert.deepEqual(await unsaveResponse.json(), {
        ...unsave,
        reconciliationStatus: "applied",
        savedMessageRevision: 2,
        savedMessage: { messageId: "lifecycle", isSaved: false },
      });
      assert.deepEqual(database.state("lifecycle"), {
        isSaved: false,
        privateNote: null,
        revision: 2,
        audit: 2,
        auditMetadata: {
          messageId: "lifecycle",
          conversationId: "conversation-lifecycle",
          intent: "unsave",
          previousSaved: true,
          currentSaved: false,
          privateNoteChanged: true,
          previousSavedMessageRevision: 1,
          currentSavedMessageRevision: 2,
        },
        outbox: 2,
      });
    });

    await t.test("returns a canonical saved-message revision conflict as 409", async () => {
      const input = savedInput("unsave", "conflict", "revision-conflict", 0);
      const response = await request(savedPath("conflict"), input);
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await response.json(), {
        ...input,
        reconciliationStatus: "saved_message_revision_conflict",
        savedMessageRevision: 3,
        savedMessage: {
          messageId: "conflict",
          isSaved: true,
          privateNote: "existing private note",
        },
      });
      assert.deepEqual(database.state("conflict"), {
        isSaved: true,
        privateNote: "existing private note",
        revision: 3,
        audit: 0,
        auditMetadata: undefined,
        outbox: 0,
      });
    });

    await t.test("rejects malformed transport, notes, aliases, toggles, unknown fields, and spoofed identity before command work", async () => {
      const valid = savedInput("save", "validation", "validation");
      const path = savedPath("validation");
      const spoofedFields = [
        "tenant",
        "tenantId",
        "organization",
        "organizationId",
        "actor",
        "actorId",
        "actorContext",
        "actorRole",
        "actorRoles",
        "actorUserId",
        "currentActor",
        "currentActorId",
        "currentUser",
        "currentUserId",
        "user",
        "userId",
        "principal",
        "principalId",
        "subject",
        "subjectId",
        "authenticatedUser",
        "authenticatedUserId",
        "identity",
        "session",
        "sessionId",
        "auth",
        "authentication",
        "authorization",
        "role",
        "roles",
        "capability",
        "capabilities",
        "permission",
        "permissions",
      ];
      const invalidRequests = [
        () => request(path, valid, { body: "{" }),
        () => request(path, valid, { body: "" }),
        () => request(path, valid, { contentType: "text/plain" }),
        () => request(`${path}?unexpected=true`, valid),
        () => request("/messages/validation/saved/", valid),
        () => request("/messages/validation/saved/extra", valid),
        () => request("/messages/validation%2Fchild/saved", valid),
        () => request("/messages/%/saved", valid),
        () => request(savedPath("other"), valid),
        () => request(path, { ...valid, privateNote: "" }),
        () => request(path, { ...valid, privateNote: "   " }),
        () => request(path, { ...valid, privateNote: "unsafe\u0000note" }),
        () => request(path, { ...valid, privateNote: "cafe\u0301" }),
        () =>
          request(path, {
            ...valid,
            privateNote: "x".repeat(
              MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES + 1,
            ),
          }),
        () => request(path, { ...valid, note: "alias secret" }),
        () => request(path, { ...valid, private_note: "alias secret" }),
        () => request(path, { ...valid, privateNotes: "alias secret" }),
        () => request(path, { ...valid, intent: "toggle" }),
        () => request(path, { ...valid, operation: "toggle_saved_message" }),
        () => request(path, { ...valid, saved: true }),
        () => request(path, { ...valid, isSaved: true }),
        () => request(path, { ...valid, toggle: true }),
        () => request(path, { ...valid, unknown: true }),
        () => request(path, valid, { omitIdempotencyKey: true }),
        () => request(path, valid, { idempotencyKey: "other-key" }),
        () =>
          request(
            path,
            { ...valid, idempotencyKey: "bad,key" },
            { idempotencyKey: "bad,key" },
          ),
        () =>
          request(path, valid, {
            body: JSON.stringify({
              ...valid,
              padding: "x".repeat(MAX_SAVED_MESSAGE_REQUEST_BYTES),
            }),
          }),
        ...spoofedFields.map((field) => () =>
          request(path, { ...valid, [field]: "spoofed" }),
        ),
      ];
      for (const makeRequest of invalidRequests) {
        const beforeConnects = database.connectCount;
        await assertStableError(
          await makeRequest(),
          400,
          CHAT_SAVED_MESSAGE_INVALID_REQUEST_CODE,
          "Invalid saved-message request",
        );
        assert.equal(database.connectCount, beforeConnects);
      }

      const duplicateBody = JSON.stringify(valid);
      const beforeDuplicate = database.connectCount;
      await assertStableError(
        await rawRequest(path, {
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
        CHAT_SAVED_MESSAGE_INVALID_REQUEST_CODE,
        "Invalid saved-message request",
      );
      assert.equal(database.connectCount, beforeDuplicate);

      await assertStableError(
        await rawRequest(path, {
          headers: [
            "authorization",
            "Bearer valid",
            "content-type",
            "application/json",
            "idempotency-key",
            valid.idempotencyKey,
            "content-length",
            String(MAX_SAVED_MESSAGE_REQUEST_BYTES + 1),
          ],
        }),
        400,
        CHAT_SAVED_MESSAGE_INVALID_REQUEST_CODE,
        "Invalid saved-message request",
      );
      assert.equal(database.connectCount, beforeDuplicate);
    });

    await t.test("maps authentication and indistinguishable authorization failures", async () => {
      await assertStableError(
        await request(
          savedPath("validation"),
          savedInput("save", "validation", "unauthenticated"),
          { authorization: "Bearer invalid" },
        ),
        401,
        CHAT_AUTHENTICATION_ERROR_CODE,
        "Chat authentication failed",
      );

      const responses = [];
      for (const messageId of [
        "invisible",
        "deleted",
        "archived",
        "missing",
        "cross-tenant",
        "entity-denied",
      ]) {
        const response = await request(
          savedPath(messageId),
          savedInput("save", messageId, `authorization-${messageId}`),
        );
        responses.push({
          status: response.status,
          headers: response.headers.get("cache-control"),
          body: await response.json(),
        });
      }
      assert.deepEqual(
        responses,
        Array.from({ length: 6 }, () => ({
          status: 403,
          headers: "private, no-store",
          body: {
            error: {
              code: CHAT_AUTHORIZATION_ERROR_CODE,
              message: "Chat authorization failed",
            },
          },
        })),
      );
    });

    await t.test("maps idempotency conflicts to one safe 409 without notes", async () => {
      const originalNote = "first private conflict note";
      const path = savedPath("validation");
      const input = savedInput(
        "save",
        "validation",
        "idempotency-conflict",
        0,
        originalNote,
      );
      assert.equal((await request(path, input)).status, 200);
      const conflictingNote = "second private conflict note";
      const conflictResponse = await request(path, {
        ...input,
        privateNote: conflictingNote,
      });
      const conflictText = await conflictResponse.text();
      assert.equal(conflictResponse.status, 409);
      assert.deepEqual(JSON.parse(conflictText), {
        error: {
          code: CHAT_SAVED_MESSAGE_CONFLICT_CODE,
          message: "Saved-message request conflicts with current server state",
        },
      });
      assert.equal(conflictText.includes(originalNote), false);
      assert.equal(conflictText.includes(conflictingNote), false);

      await assertStableError(
        await request(
          savedPath("in-progress"),
          savedInput("save", "in-progress", "in-progress"),
        ),
        409,
        CHAT_SAVED_MESSAGE_CONFLICT_CODE,
        "Saved-message request conflicts with current server state",
      );
    });

    await t.test("redacts private notes and unexpected sensitive details from responses and console output", async () => {
      database.setFailAccess(true);
      const privateNote = "never-log-this-private-note";
      const captured = [];
      const originalConsole = {
        error: console.error,
        log: console.log,
        warn: console.warn,
      };
      console.error = (...values) => captured.push(values.join(" "));
      console.log = (...values) => captured.push(values.join(" "));
      console.warn = (...values) => captured.push(values.join(" "));
      try {
        const response = await request(
          savedPath("failure"),
          savedInput("save", "failure", "sensitive-request-key", 0, privateNote),
        );
        const text = await response.text();
        assert.equal(response.status, 503);
        assert.deepEqual(JSON.parse(text), {
          error: {
            code: CHAT_SAVED_MESSAGE_UNAVAILABLE_CODE,
            message: "Saved message temporarily unavailable",
          },
        });
        for (const forbidden of [
          privateNote,
          "sensitive-request-key",
          "database provider",
          "credential",
          "stack",
        ]) {
          assert.equal(text.includes(forbidden), false);
          assert.equal(captured.join("\n").includes(forbidden), false);
        }
      } finally {
        console.error = originalConsole.error;
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        database.setFailAccess(false);
      }
    });
  });
});

test("saved-message middleware receives only a redacted route error", async () => {
  const database = createScriptedSavedMessageDatabase();
  database.setFailAccess(true);
  const runtime = createRuntime(database);
  const privateNote = "forwarded-private-note";
  await withHttpServer(
    runtime,
    async ({ request, forwarded }) => {
      const response = await request(
        savedPath("failure"),
        savedInput("save", "failure", "forwarded-sensitive-key", 0, privateNote),
      );
      await assertStableError(
        response,
        503,
        CHAT_SAVED_MESSAGE_UNAVAILABLE_CODE,
        "Saved message temporarily unavailable",
      );
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].code, CHAT_SAVED_MESSAGE_UNAVAILABLE_CODE);
      assert.equal(
        forwarded[0].message,
        "Saved message temporarily unavailable",
      );
      const serialized = JSON.stringify(forwarded[0], Object.getOwnPropertyNames(forwarded[0]));
      for (const forbidden of [
        privateNote,
        "forwarded-sensitive-key",
        "database provider",
        "credential",
      ]) {
        assert.equal(serialized.includes(forbidden), false);
      }
    },
    { forwardErrors: true },
  );
});
