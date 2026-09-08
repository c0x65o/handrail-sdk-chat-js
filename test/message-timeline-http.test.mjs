import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_MESSAGE_TIMELINE_INVALID_REQUEST_CODE,
  CHAT_MESSAGE_TIMELINE_UNAVAILABLE_CODE,
  DEFAULT_MESSAGE_TIMELINE_LIMIT,
  MAX_MESSAGE_TIMELINE_LIMIT,
  MAX_MESSAGE_TIMELINE_RESPONSE_BYTES,
  MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
  MESSAGE_TIMELINE_LIMIT_HEADER,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  roles: Object.freeze(["employee"]),
});

const timestamp = (minute) => `2030-01-01T00:${minute}:00.000Z`;

const messageRow = ({
  id,
  conversationId,
  sequence,
  text,
  revision = 1,
  edited = false,
  deleted = false,
  reactions = [],
  attachments = [],
  threadSummary = null,
}) => ({
  conversation_type: conversationId === "thread-4" ? "thread" : "channel",
  entity_type: conversationId === "parent" ? "order" : null,
  entity_id: conversationId === "parent" ? "42" : null,
  replay_event_id: "event-a-9",
  older_available: false,
  newer_available: false,
  message_id: id,
  sequence,
  author_user_id: sequence % 2 === 0 ? "user-a" : "user-b",
  reply_to_message_id: null,
  reply_notify_author: null,
  content: deleted
    ? { format: "plain", text: "deleted source must not leak" }
    : {
        format: "plain",
        text,
        ...(attachments.length === 0
          ? {}
          : {
              attachments: attachments.map(({ attachmentId }) => ({
                attachmentId,
              })),
            }),
      },
  current_revision: revision,
  created_at: timestamp(`0${sequence}`.slice(-2)),
  updated_at: edited ? timestamp("09") : timestamp(`0${sequence}`.slice(-2)),
  edited_at: edited ? timestamp("09") : null,
  edited_by_user_id: edited ? "user-a" : null,
  deleted_at: deleted ? timestamp("10") : null,
  deleted_by_user_id: deleted ? "user-b" : null,
  reactions,
  attachments,
  thread_summary: threadSummary,
  storage_key: "must-not-leak-row-storage-key",
  provider_headers: { authorization: "must-not-leak" },
  internal_buffer: Buffer.from("must-not-leak-buffer"),
});

const parentRows = [
  messageRow({
    id: "message-1",
    conversationId: "parent",
    sequence: 1,
    text: "active",
  }),
  messageRow({
    id: "message-2",
    conversationId: "parent",
    sequence: 2,
    text: "edited",
    revision: 2,
    edited: true,
  }),
  messageRow({
    id: "message-3",
    conversationId: "parent",
    sequence: 3,
    text: "deleted",
    deleted: true,
  }),
  messageRow({
    id: "message-4",
    conversationId: "parent",
    sequence: 4,
    text: "thread root",
    reactions: [
      { reactionKey: "eyes", count: 1, reactedByCurrentUser: false },
      { reactionKey: "thumbsup", count: 2, reactedByCurrentUser: true },
    ],
    attachments: [
      {
        attachmentId: "attachment-1",
        storageKey: "tenant-a/private/attachment-1",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: 12,
        providerMetadata: "must-not-leak",
      },
    ],
    threadSummary: {
      threadId: "thread-4",
      replyCount: 2,
      participantIds: ["user-a", "user-b"],
      unreadCount: 1,
      lastReplyAt: timestamp("08"),
      internalState: "must-not-leak",
    },
  }),
];

const threadRows = [
  messageRow({
    id: "reply-1",
    conversationId: "thread-4",
    sequence: 1,
    text: "reply one",
  }),
  messageRow({
    id: "reply-2",
    conversationId: "thread-4",
    sequence: 2,
    text: "reply two",
  }),
];

const sentinelRow = (conversationId) => ({
  conversation_type: "channel",
  entity_type: null,
  entity_id: null,
  replay_event_id: "event-a-9",
  older_available: false,
  newer_available: false,
  message_id: null,
  sequence: null,
  author_user_id: null,
  reply_to_message_id: null,
  reply_notify_author: null,
  content: null,
  current_revision: null,
  created_at: null,
  updated_at: null,
  edited_at: null,
  edited_by_user_id: null,
  deleted_at: null,
  deleted_by_user_id: null,
  reactions: [],
  attachments: [],
  thread_summary: null,
  conversation_id: conversationId,
  internal_row_marker: "must-not-leak",
});

const makeDatabase = () => {
  const calls = [];
  return {
    calls,
    resource: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.startsWith("SELECT thread.id, thread.parent_conversation_id")) {
          assert.deepEqual(values, [actor.tenantId, "thread-4", actor.userId, true]);
          return { rows: [{ id: "thread-4", parent_conversation_id: "parent", is_archived: false, entity_type: "order", entity_id: "42", can_manage: false }] };
        }
        assert.match(sql, /^WITH admitted_conversation/u);
        const [tenantId, userId, conversationId, cursor, limit] = values;
        assert.equal(tenantId, actor.tenantId);
        assert.equal(userId, actor.userId);

        if (conversationId === "backend-failure") {
          throw new Error("sensitive database connection detail");
        }
        if (["missing", "private-forbidden", "cross-tenant"].includes(conversationId)) {
          return { rows: [] };
        }
        if (conversationId === "empty") {
          return { rows: [sentinelRow(conversationId)] };
        }
        if (conversationId === "oversized") {
          return {
            rows: [
              messageRow({
                id: "oversized-1",
                conversationId,
                sequence: 1,
                text: "x".repeat(MAX_MESSAGE_TIMELINE_RESPONSE_BYTES),
              }),
            ],
          };
        }
        if (conversationId === "serialization-failure") {
          const row = messageRow({
            id: "serialization-1",
            conversationId,
            sequence: 1,
            text: "not used",
          });
          row.content.text = 1n;
          return { rows: [row] };
        }
        if (conversationId === "storage-failure") {
          return {
            rows: [
              messageRow({
                id: "storage-1",
                conversationId,
                sequence: 1,
                text: "storage",
                attachments: [
                  {
                    attachmentId: "attachment-failure",
                    storageKey: "fail/private-key",
                    fileName: "fail.txt",
                    contentType: "text/plain",
                    sizeBytes: 3,
                  },
                ],
              }),
            ],
          };
        }

        const allRows = conversationId === "thread-4" ? threadRows : parentRows;
        const backward = sql.includes("ORDER BY message.sequence DESC");
        const candidates = allRows.filter(({ sequence }) =>
          cursor === null
            ? true
            : backward
              ? sequence < cursor
              : sequence > cursor,
        );
        candidates.sort((left, right) =>
          backward ? right.sequence - left.sequence : left.sequence - right.sequence,
        );
        const selected = candidates.slice(0, limit).sort((left, right) =>
          left.sequence - right.sequence,
        );
        const first = selected[0]?.sequence;
        const last = selected.at(-1)?.sequence;
        return {
          rows: selected.map((row) => ({
            ...row,
            older_available:
              first !== undefined && allRows.some(({ sequence }) => sequence < first),
            newer_available:
              last !== undefined && allRows.some(({ sequence }) => sequence > last),
          })),
        };
      },
      async connect() {
        throw new Error("timeline HTTP routes must not apply migrations");
      },
    },
  };
};

const createRuntime = () => {
  const database = makeDatabase();
  const authorizationCalls = [];
  const storageCalls = [];
  let entityAuthorized = true;
  const runtime = createChatServer({
    database: { pool: database.resource },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization !== "Bearer valid") {
          throw new Error("sensitive authentication detail");
        }
        return actor;
      },
    },
    directory: {
      async getUser() {
        throw new Error("timeline route must not read the directory");
      },
      async searchUsers() {
        throw new Error("timeline route must not search the directory");
      },
    },
    permissions: {
      async getCapabilities() {
        return ["conversation.read"];
      },
      async authorizeEntity(input) {
        authorizationCalls.push(input);
        return entityAuthorized;
      },
    },
    storage: {
      async createUploadUrl() {
        throw new Error("timeline route must not create upload URLs");
      },
      async verifyObject() {
        throw new Error("timeline route must not verify upload objects");
      },
      async createDownloadUrl(input) {
        storageCalls.push(input);
        if (input.attachmentId === "attachment-failure") {
          throw new Error("sensitive storage provider detail");
        }
        return {
          url: `https://downloads.test.invalid/${input.attachmentId}`,
          expiresAt: timestamp("59"),
          headers: { authorization: "must-not-leak-provider-header" },
          providerResponse: "must-not-leak",
        };
      },
      async deleteObject() {
        throw new Error("timeline route must not delete objects");
      },
    },
  });
  return {
    runtime,
    database,
    authorizationCalls,
    storageCalls,
    setEntityAuthorized(value) {
      entityAuthorized = value;
    },
  };
};

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    return await callback({
      request(path, init = {}) {
        return fetch(`${origin}${path}`, init);
      },
      requestWithGetBody(path, body) {
        return new Promise((resolve, reject) => {
          const request = httpRequest(
            `${origin}${path}`,
            {
              method: "GET",
              headers: {
                authorization: "Bearer valid",
                "content-length": String(Buffer.byteLength(body)),
              },
            },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("end", () => {
                const responseBody = Buffer.concat(chunks).toString("utf8");
                resolve({
                  status: response.statusCode,
                  headers: new Headers(response.headers),
                  async json() {
                    return JSON.parse(responseBody);
                  },
                });
              });
            },
          );
          request.on("error", reject);
          request.end(body);
        });
      },
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const authenticated = { headers: { authorization: "Bearer valid" } };

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("GET message timelines expose canonical exclusive pages and preserve thread separation", async () => {
  const fixture = createRuntime();

  await withHttpServer(fixture.runtime, async ({ request }) => {
    const latestResponse = await request(
      "/conversations/parent/messages?limit=2",
      authenticated,
    );
    assert.equal(latestResponse.status, 200);
    assert.equal(latestResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(
      latestResponse.headers.get(MESSAGE_TIMELINE_LIMIT_HEADER),
      "2",
    );
    const latest = await latestResponse.json();
    assert.deepEqual(latest.messages.map(({ sequence }) => sequence), [3, 4]);
    assert.deepEqual(latest.pagination, {
      older: { available: true, cursor: 3 },
      newer: { available: false },
    });
    assert.deepEqual(latest.replay, { resumeFrom: { eventId: "event-a-9" } });

    const before = await (
      await request(
        "/conversations/parent/messages?before=4&limit=2",
        authenticated,
      )
    ).json();
    assert.deepEqual(before.messages.map(({ sequence }) => sequence), [2, 3]);
    assert.deepEqual(before.pagination, {
      older: { available: true, cursor: 2 },
      newer: { available: true, cursor: 3 },
    });

    const after = await (
      await request(
        "/conversations/parent/messages?after=2&limit=2",
        authenticated,
      )
    ).json();
    assert.deepEqual(after.messages.map(({ sequence }) => sequence), [3, 4]);
    assert.equal(after.messages.some(({ sequence }) => sequence === 2), false);

    const canonical = await (
      await request(
        "/conversations/parent/messages?after=0&limit=4",
        authenticated,
      )
    ).json();
    assert.equal(canonical.conversationId, "parent");
    assert.equal(canonical.messages[0].content.text, "active");
    assert.deepEqual(canonical.messages[1].revision, {
      revision: 2,
      editedAt: timestamp("09"),
      editedByUserId: "user-a",
    });
    assert.equal(canonical.messages[2].content, null);
    assert.equal(canonical.messages[2].deletedAt, timestamp("10"));
    assert.equal(canonical.messages[2].deletedByUserId, "user-b");
    assert.deepEqual(canonical.messages[2].attachmentMetadata, []);
    assert.deepEqual(canonical.messages[3].reactions, [
      { reactionKey: "eyes", count: 1, reactedByCurrentUser: false },
      { reactionKey: "thumbsup", count: 2, reactedByCurrentUser: true },
    ]);
    assert.deepEqual(canonical.messages[3].attachmentMetadata, [
      {
        attachmentId: "attachment-1",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: 12,
        downloadUrl: "https://downloads.test.invalid/attachment-1",
      },
    ]);
    assert.deepEqual(canonical.messages[3].threadSummary, {
      threadId: "thread-4",
      replyCount: 2,
      participantIds: ["user-a", "user-b"],
      unreadCount: 1,
      lastReplyAt: timestamp("08"),
    });

    const thread = await (
      await request(
        "/conversations/thread-4/messages?after=0&limit=10",
        authenticated,
      )
    ).json();
    assert.deepEqual(thread.messages.map(({ id }) => id), ["reply-1", "reply-2"]);
    assert.equal(thread.messages.some(({ id }) => id.startsWith("message-")), false);
    assert.equal(canonical.messages.some(({ id }) => id.startsWith("reply-")), false);

    const empty = await (
      await request("/conversations/empty/messages", authenticated)
    ).json();
    assert.deepEqual(empty.messages, []);
    assert.deepEqual(empty.pagination, {
      older: { available: false },
      newer: { available: false },
    });

    const successfulJson = JSON.stringify({ latest, before, after, canonical, thread, empty });
    for (const forbiddenValue of [
      "must-not-leak",
      "storageKey",
      "storage_key",
      "provider_headers",
      "providerResponse",
      "internal_buffer",
      "internalState",
      "expiresAt",
      "headers",
      "rows",
      "rowCount",
    ]) {
      assert.equal(successfulJson.includes(forbiddenValue), false);
    }
  });

  assert.equal(fixture.storageCalls.length, 3);
  assert.ok(
    fixture.storageCalls.every(
      (input) =>
        input.actor.tenantId === actor.tenantId &&
        input.actor.userId === actor.userId &&
        input.attachmentId === "attachment-1" &&
        input.objectKey === "tenant-a/private/attachment-1",
    ),
  );
  assert.ok(
    fixture.authorizationCalls.every(
      ({ actor: authorizedActor, action }) =>
        authorizedActor.tenantId === actor.tenantId &&
        authorizedActor.userId === actor.userId &&
        action === MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
    ),
  );
  assert.ok(
    fixture.database.calls.every(
      ({ sql }) => !/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql),
    ),
    "timeline handler must remain read-only",
  );
});

test("GET message timeline rejects malformed input before access and sanitizes all failures", async () => {
  const fixture = createRuntime();

  await withHttpServer(fixture.runtime, async ({ request, requestWithGetBody }) => {
    const beforeInvalidCount = fixture.database.calls.length;
    const invalidPaths = [
      "/conversations/parent/messages?before=2&after=3",
      "/conversations/parent/messages?before=2&before=3",
      "/conversations/parent/messages?after=2&after=3",
      "/conversations/parent/messages?before=-1",
      "/conversations/parent/messages?after=1.5",
      "/conversations/parent/messages?after=",
      "/conversations/parent/messages?after=9007199254740992",
      "/conversations/parent/messages?limit=0",
      "/conversations/parent/messages?limit=invalid",
      "/conversations/parent/messages?limit=9007199254740992",
      `/conversations/parent/messages?limit=${MAX_MESSAGE_TIMELINE_LIMIT + 1}`,
      "/conversations/parent/messages?limit=1&limit=2",
      "/conversations/parent/messages?unknown=value",
      "/conversations/parent/messages?tenantId=spoofed",
      "/conversations/parent/messages?userId=spoofed",
      "/conversations/parent/messages?roles=admin",
      "/conversations/parent/messages?conversationId=spoofed",
      "/conversations/parent/messages?direction=forward",
      "/conversations/parent/messages?cursor=1",
      "/conversations/parent%2Fchild/messages",
      "/conversations/parent%5Cchild/messages",
    ];
    for (const path of invalidPaths) {
      await assertStableError(
        await request(path, authenticated),
        400,
        CHAT_MESSAGE_TIMELINE_INVALID_REQUEST_CODE,
        "Invalid message timeline request",
      );
    }
    assert.equal(fixture.database.calls.length, beforeInvalidCount);

    await assertStableError(
      await requestWithGetBody("/conversations/parent/messages", "body"),
      400,
      CHAT_MESSAGE_TIMELINE_INVALID_REQUEST_CODE,
      "Invalid message timeline request",
    );

    await assertStableError(
      await request("/conversations/parent/messages"),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );

    const nondisclosure = [];
    for (const conversationId of ["missing", "private-forbidden", "cross-tenant"]) {
      const response = await request(
        `/conversations/${conversationId}/messages`,
        authenticated,
      );
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      nondisclosure.push(await response.json());
    }
    assert.deepEqual(nondisclosure[1], nondisclosure[0]);
    assert.deepEqual(nondisclosure[2], nondisclosure[0]);
    assert.deepEqual(nondisclosure[0], {
      error: {
        code: CHAT_AUTHORIZATION_ERROR_CODE,
        message: "Chat authorization failed",
      },
    });

    fixture.setEntityAuthorized(false);
    await assertStableError(
      await request("/conversations/parent/messages", authenticated),
      403,
      CHAT_AUTHORIZATION_ERROR_CODE,
      "Chat authorization failed",
    );
    fixture.setEntityAuthorized(true);

    for (const conversationId of [
      "backend-failure",
      "storage-failure",
      "serialization-failure",
      "oversized",
    ]) {
      await assertStableError(
        await request(`/conversations/${conversationId}/messages`, authenticated),
        503,
        CHAT_MESSAGE_TIMELINE_UNAVAILABLE_CODE,
        "Message timeline temporarily unavailable",
      );
    }

    const defaultResponse = await request(
      "/conversations/thread-4/messages",
      authenticated,
    );
    assert.equal(defaultResponse.status, 200);
    assert.equal(
      defaultResponse.headers.get(MESSAGE_TIMELINE_LIMIT_HEADER),
      String(DEFAULT_MESSAGE_TIMELINE_LIMIT),
    );
    const defaultQuery = fixture.database.calls.findLast(({ sql }) =>
      sql.startsWith("WITH admitted_conversation"),
    );
    assert.ok(defaultQuery.sql.includes("ORDER BY message.sequence DESC"));
    assert.equal(defaultQuery.values[3], null);
    assert.equal(defaultQuery.values[4], DEFAULT_MESSAGE_TIMELINE_LIMIT);
  });
});
