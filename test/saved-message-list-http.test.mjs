import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

const {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_SAVED_MESSAGE_LIST_INVALID_REQUEST_CODE,
  CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE_CODE,
  SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
  SAVED_MESSAGE_LIST_ROUTE,
  createChatServer,
  parseSavedMessageListSnapshot,
} = await import(
  process.env.HANDRAIL_CHAT_SERVER_TEST_MODULE ?? "@handrail/chat/server"
);

const actors = Object.freeze({
  valid: Object.freeze({
    tenantId: "tenant-a",
    userId: "actor-a",
    roles: Object.freeze(["employee"]),
  }),
  "other-user": Object.freeze({
    tenantId: "tenant-a",
    userId: "actor-b",
    roles: Object.freeze(["employee"]),
  }),
  "other-tenant": Object.freeze({
    tenantId: "tenant-b",
    userId: "actor-a",
    roles: Object.freeze(["employee"]),
  }),
  "database-failure": Object.freeze({
    tenantId: "tenant-a",
    userId: "database-failure",
    roles: Object.freeze(["employee"]),
  }),
  "storage-failure": Object.freeze({
    tenantId: "tenant-a",
    userId: "storage-failure",
    roles: Object.freeze(["employee"]),
  }),
  "unexpected-failure": Object.freeze({
    tenantId: "tenant-a",
    userId: "unexpected-failure",
    roles: Object.freeze(["employee"]),
  }),
  "authorization-failure": Object.freeze({
    tenantId: "tenant-a",
    userId: "authorization-failure",
    roles: Object.freeze(["employee"]),
  }),
});

const savedRow = ({
  messageId,
  savedAt,
  privateNote = null,
  conversationId = `conversation-${messageId}`,
  conversationVisible = true,
  entityType = null,
  entityId = null,
  deleted = false,
  attachments = [],
  contentText = `current ${messageId}`,
  currentRevision = 1,
}) => ({
  message_id: messageId,
  saved_at: savedAt,
  updated_at: savedAt,
  saved_message_revision: 2,
  private_note: privateNote,
  conversation_id: conversationId,
  entity_type: entityType,
  entity_id: entityId,
  conversation_visible: conversationVisible,
  sequence: 7,
  author_user_id: deleted || !conversationVisible ? "secret-author" : "author-a",
  content: {
    format: "plain",
    text: deleted || !conversationVisible ? "secret message content" : contentText,
    ...(attachments.length === 0
      ? {}
      : {
          attachments: attachments.map(({ attachmentId }) => ({ attachmentId })),
        }),
  },
  current_revision: currentRevision,
  message_created_at: "2030-01-01T10:00:00.000Z",
  message_updated_at: "2030-01-01T10:01:00.000Z",
  edited_at: null,
  edited_by_user_id: null,
  deleted_at: deleted ? "2030-01-01T10:02:00.000Z" : null,
  deleted_by_user_id: deleted ? "secret-deleter" : null,
  attachments,
  provider_detail: "must-not-leak-row-provider-detail",
});

const actorARows = [
  savedRow({
    messageId: "visible",
    savedAt: "2030-02-01T12:40:00.000000Z",
    privateNote: "Actor A private note",
    entityType: "order",
    entityId: "allow",
    attachments: [
      {
        attachmentId: "attachment-visible",
        storageKey: "tenant-a/private/attachment-visible",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: 12,
      },
    ],
  }),
  savedRow({
    messageId: "deleted",
    savedAt: "2030-02-01T12:30:00.000000Z",
    privateNote: "Deleted actor-private note",
    deleted: true,
  }),
  savedRow({
    messageId: "revoked",
    savedAt: "2030-02-01T12:20:00.000000Z",
    conversationId: "private-revoked-conversation",
    conversationVisible: false,
  }),
  savedRow({
    messageId: "entity-denied",
    savedAt: "2030-02-01T12:10:00.000000Z",
    entityType: "order",
    entityId: "deny",
    contentText: "denied entity secret",
  }),
  savedRow({
    messageId: "entity-provider-error",
    savedAt: "2030-02-01T12:00:00.000000Z",
    entityType: "order",
    entityId: "provider-error",
    contentText: "provider error entity secret",
  }),
];

const rowsByIdentity = new Map([
  [JSON.stringify(["tenant-a", "actor-a"]), actorARows],
  [
    JSON.stringify(["tenant-a", "actor-b"]),
    [
      savedRow({
        messageId: "other-user-only",
        savedAt: "2030-02-02T12:00:00.000000Z",
        privateNote: "Other user private note",
      }),
    ],
  ],
  [
    JSON.stringify(["tenant-b", "actor-a"]),
    [
      savedRow({
        messageId: "other-tenant-only",
        savedAt: "2030-02-03T12:00:00.000000Z",
        privateNote: "Other tenant private note",
      }),
    ],
  ],
  [
    JSON.stringify(["tenant-a", "storage-failure"]),
    [
      savedRow({
        messageId: "storage-failure-message",
        savedAt: "2030-02-04T12:00:00.000000Z",
        privateNote: "storage failure private note",
        attachments: [
          {
            attachmentId: "attachment-storage-failure",
            storageKey: "sensitive-provider-object-key",
            fileName: "secret.txt",
            contentType: "text/plain",
            sizeBytes: 1,
          },
        ],
      }),
    ],
  ],
  [
    JSON.stringify(["tenant-a", "unexpected-failure"]),
    [
      savedRow({
        messageId: "unexpected-failure-message",
        savedAt: "2030-02-05T12:00:00.000000Z",
        currentRevision: 0,
      }),
    ],
  ],
]);

const makeDatabase = () => {
  const calls = [];
  return {
    calls,
    resource: {
      async query(sql, values = []) {
        if (!/^WITH saved_page AS/u.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        calls.push({ sql, values });
        const [tenantId, userId, cursorSavedAt, cursorMessageId, fetchLimit] =
          values;
        if (userId === "database-failure") {
          throw new Error(
            "sensitive database credential private note and conversation detail",
          );
        }
        const rows = rowsByIdentity.get(JSON.stringify([tenantId, userId])) ?? [];
        const afterCursor = rows.filter((row) =>
          cursorSavedAt === null
            ? true
            : row.saved_at < cursorSavedAt ||
              (row.saved_at === cursorSavedAt &&
                row.message_id < cursorMessageId),
        );
        return { rows: afterCursor.slice(0, fetchLimit), rowCount: null };
      },
      async connect() {
        throw new Error("saved-message list HTTP must not open transactions");
      },
    },
  };
};

const createRuntime = () => {
  const database = makeDatabase();
  const authorizationCalls = [];
  const storageCalls = [];
  const runtime = createChatServer({
    database: { pool: database.resource },
    auth: {
      async resolveActor(request) {
        const token = request.headers.authorization?.replace("Bearer ", "");
        const resolved = actors[token];
        if (resolved === undefined) {
          throw new Error("sensitive authentication provider credential");
        }
        return resolved;
      },
    },
    directory: {
      async getUser() {
        throw new Error("saved-message list must not use the directory");
      },
      async searchUsers() {
        throw new Error("saved-message list must not search the directory");
      },
    },
    permissions: {
      async getCapabilities({ actor }) {
        if (actor.userId === "authorization-failure") {
          throw new Error("sensitive capability provider response");
        }
        return ["saved-message.read"];
      },
      async authorizeEntity(input) {
        authorizationCalls.push(input);
        if (input.entity.id === "provider-error") {
          throw new Error("sensitive entity authorization provider response");
        }
        return input.entity.id !== "deny";
      },
    },
    storage: {
      async createUploadUrl() {
        throw new Error("saved-message list must not create upload URLs");
      },
      async verifyObject() {
        throw new Error("saved-message list must not verify objects");
      },
      async createDownloadUrl(input) {
        storageCalls.push(input);
        if (input.attachmentId === "attachment-storage-failure") {
          throw new Error(
            "sensitive storage credentials provider response private note",
          );
        }
        return {
          url: `https://downloads.test.invalid/${input.attachmentId}`,
          expiresAt: "2030-03-01T00:00:00.000Z",
          headers: { authorization: "must-not-leak-provider-header" },
        };
      },
      async deleteObject() {
        throw new Error("saved-message list must not delete objects");
      },
    },
  });
  return { runtime, database, authorizationCalls, storageCalls };
};

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
          response.end(
            JSON.stringify({ error: { code: error.code, message: error.message } }),
          );
        });
      }
    : runtime.router;
  const server = createServer(listener);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    return await callback({
      forwarded,
      request(path, token = "valid", init = {}) {
        return fetch(`${origin}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            ...init.headers,
          },
        });
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

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("GET /saved-messages returns private, safe, actor-scoped keyset pages", async () => {
  const fixture = createRuntime();

  await withHttpServer(fixture.runtime, async ({ request }) => {
    const beforeFirst = fixture.database.calls.length;
    const firstResponse = await request(`${SAVED_MESSAGE_LIST_ROUTE}?limit=2`);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("cache-control"), "private, no-store");
    const firstJson = await firstResponse.json();
    const first = parseSavedMessageListSnapshot(firstJson, { limit: 2 });
    assert.equal(fixture.database.calls.length - beforeFirst, 1);
    assert.equal(first.kind, "saved_message_list");
    assert.equal(first.privacy, ACTOR_PRIVATE_USER_STATE_PRIVACY);
    assert.deepEqual(first.items.map(({ messageId }) => messageId), [
      "visible",
      "deleted",
    ]);
    assert.ok(first.page.nextCursor);
    assert.deepEqual(first.items[0].privateNote, {
      privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
      text: "Actor A private note",
    });
    assert.deepEqual(first.items[0].message, {
      availability: "available",
      current: {
        id: "visible",
        conversationId: "conversation-visible",
        author: { type: "user", userId: "author-a" },
        sequence: 7,
        createdAt: "2030-01-01T10:00:00.000Z",
        updatedAt: "2030-01-01T10:01:00.000Z",
        revision: { revision: 1 },
        content: {
          format: "plain",
          text: "current visible",
          attachments: [{ attachmentId: "attachment-visible" }],
        },
        attachmentMetadata: [
          {
            attachmentId: "attachment-visible",
            fileName: "report.txt",
            contentType: "text/plain",
            sizeBytes: 12,
            downloadUrl: "https://downloads.test.invalid/attachment-visible",
          },
        ],
      },
    });
    assert.deepEqual(first.items[1].message, {
      availability: "unavailable",
      reason: "deleted",
    });

    const beforeSecond = fixture.database.calls.length;
    const secondResponse = await request(
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&cursor=${encodeURIComponent(first.page.nextCursor)}`,
    );
    const secondJson = await secondResponse.json();
    const second = parseSavedMessageListSnapshot(secondJson, {
      limit: 2,
      cursor: first.page.nextCursor,
    });
    assert.equal(fixture.database.calls.length - beforeSecond, 1);
    assert.deepEqual(second.items.map(({ messageId }) => messageId), [
      "revoked",
      "entity-denied",
    ]);
    assert.ok(second.page.nextCursor);
    assert.deepEqual(
      second.items.map(({ message }) => message),
      [
        { availability: "unavailable", reason: "inaccessible" },
        { availability: "unavailable", reason: "inaccessible" },
      ],
    );

    const beforeTerminal = fixture.database.calls.length;
    const terminalResponse = await request(
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&cursor=${encodeURIComponent(second.page.nextCursor)}`,
    );
    const terminalJson = await terminalResponse.json();
    const terminal = parseSavedMessageListSnapshot(terminalJson, {
      limit: 2,
      cursor: second.page.nextCursor,
    });
    assert.equal(fixture.database.calls.length - beforeTerminal, 1);
    assert.deepEqual(terminal.items.map(({ messageId }) => messageId), [
      "entity-provider-error",
    ]);
    assert.equal(terminal.page.nextCursor, null);
    assert.deepEqual(terminal.items[0].message, {
      availability: "unavailable",
      reason: "inaccessible",
    });

    const otherUser = await (
      await request(`${SAVED_MESSAGE_LIST_ROUTE}?limit=10`, "other-user")
    ).json();
    assert.deepEqual(otherUser.items.map(({ messageId }) => messageId), [
      "other-user-only",
    ]);
    const otherTenant = await (
      await request(`${SAVED_MESSAGE_LIST_ROUTE}?limit=10`, "other-tenant")
    ).json();
    assert.deepEqual(otherTenant.items.map(({ messageId }) => messageId), [
      "other-tenant-only",
    ]);

    const successfulJson = JSON.stringify({
      first: firstJson,
      second: secondJson,
      terminal: terminalJson,
      otherUser,
      otherTenant,
    });
    for (const forbidden of [
      "secret message content",
      "secret-author",
      "secret-deleter",
      "private-revoked-conversation",
      "denied entity secret",
      "provider error entity secret",
      "must-not-leak-row-provider-detail",
      "storageKey",
      "expiresAt",
      "must-not-leak-provider-header",
    ]) {
      assert.equal(successfulJson.includes(forbidden), false);
    }
    assert.equal(firstJson.items.some(({ messageId }) => messageId === "other-user-only"), false);
    assert.equal(firstJson.items.some(({ messageId }) => messageId === "other-tenant-only"), false);
  });

  assert.deepEqual(
    fixture.database.calls.map(({ values }) => values.slice(0, 2)),
    [
      ["tenant-a", "actor-a"],
      ["tenant-a", "actor-a"],
      ["tenant-a", "actor-a"],
      ["tenant-a", "actor-b"],
      ["tenant-b", "actor-a"],
    ],
  );
  assert.deepEqual(
    fixture.authorizationCalls.map(({ actor, entity, action }) => ({
      tenantId: actor.tenantId,
      userId: actor.userId,
      entity,
      action,
    })),
    [
      {
        tenantId: "tenant-a",
        userId: "actor-a",
        entity: { type: "order", id: "allow" },
        action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
      },
      {
        tenantId: "tenant-a",
        userId: "actor-a",
        entity: { type: "order", id: "deny" },
        action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
      },
      {
        tenantId: "tenant-a",
        userId: "actor-a",
        entity: { type: "order", id: "provider-error" },
        action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
      },
    ],
  );
  assert.equal(fixture.storageCalls.length, 1);
  assert.deepEqual(fixture.storageCalls[0].actor, actors.valid);
});

test("saved-message list rejects malformed query input before database access", async () => {
  const fixture = createRuntime();
  await withHttpServer(fixture.runtime, async ({ request, requestWithGetBody }) => {
    for (const path of [
      SAVED_MESSAGE_LIST_ROUTE,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=0`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=101`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2.5`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=two`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&limit=3`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&cursor=not-a-cursor`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&cursor=a&cursor=b`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&tenantId=spoofed`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&userId=spoofed`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&roles=admin`,
      `${SAVED_MESSAGE_LIST_ROUTE}?limit=2&unknown=value`,
    ]) {
      const before = fixture.database.calls.length;
      await assertStableError(
        await request(path),
        400,
        CHAT_SAVED_MESSAGE_LIST_INVALID_REQUEST_CODE,
        "Invalid saved-message list request",
      );
      assert.equal(fixture.database.calls.length, before);
    }

    const beforeBody = fixture.database.calls.length;
    await assertStableError(
      await requestWithGetBody(`${SAVED_MESSAGE_LIST_ROUTE}?limit=2`, "{}"),
      400,
      CHAT_SAVED_MESSAGE_LIST_INVALID_REQUEST_CODE,
      "Invalid saved-message list request",
    );
    assert.equal(fixture.database.calls.length, beforeBody);
  });
});

test("saved-message list redacts authentication, authorization, database, storage, and unexpected failures", async () => {
  const fixture = createRuntime();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    await assertStableError(
      await request(`${SAVED_MESSAGE_LIST_ROUTE}?limit=1`, "missing"),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    await assertStableError(
      await request(`${SAVED_MESSAGE_LIST_ROUTE}?limit=1`, "authorization-failure"),
      403,
      CHAT_AUTHORIZATION_ERROR_CODE,
      "Chat authorization failed",
    );
    for (const token of [
      "database-failure",
      "storage-failure",
      "unexpected-failure",
    ]) {
      await assertStableError(
        await request(`${SAVED_MESSAGE_LIST_ROUTE}?limit=1`, token),
        503,
        CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE_CODE,
        "Saved-message list temporarily unavailable",
      );
    }
  });
});

test("saved-message list forwards only redacted errors without console disclosure", async () => {
  const fixture = createRuntime();
  const consoleCalls = [];
  const originals = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  console.error = (...values) => consoleCalls.push(["error", ...values]);
  console.warn = (...values) => consoleCalls.push(["warn", ...values]);
  console.log = (...values) => consoleCalls.push(["log", ...values]);
  try {
    await withHttpServer(
      fixture.runtime,
      async ({ request, forwarded }) => {
        const response = await request(
          `${SAVED_MESSAGE_LIST_ROUTE}?limit=1`,
          "database-failure",
        );
        await assertStableError(
          response,
          503,
          CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE_CODE,
          "Saved-message list temporarily unavailable",
        );
        assert.equal(forwarded.length, 1);
        assert.equal(
          forwarded[0].message,
          "Saved-message list temporarily unavailable",
        );
        assert.equal(
          forwarded[0].code,
          CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE_CODE,
        );
        const forwardedText = `${forwarded[0].message}\n${forwarded[0].stack ?? ""}\n${JSON.stringify(forwarded[0])}`;
        for (const forbidden of [
          "sensitive database credential",
          "private note",
          "conversation detail",
        ]) {
          assert.equal(forwardedText.includes(forbidden), false);
        }
      },
      { forwardErrors: true },
    );
  } finally {
    console.error = originals.error;
    console.warn = originals.warn;
    console.log = originals.log;
  }
  assert.deepEqual(consoleCalls, []);
});
