import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_MESSAGE_SEARCH_INVALID_REQUEST_CODE,
  CHAT_MESSAGE_SEARCH_UNAVAILABLE_CODE,
  MESSAGE_SEARCH_ENTITY_POLICY_ACTION,
  MESSAGE_SEARCH_ROUTE,
  createChatServer,
} from "@handrail/chat/server";
import { parseMessageSearchResponse } from "@handrail/chat";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  roles: Object.freeze(["employee"]),
});

const candidates = [
  {
    id: "public-one",
    entity_type: null,
    entity_id: null,
    conversation_name: "Launch room",
    message_id: "message-3",
    author_user_id: "author-c",
    content_text: "**Launch** [guide](https://private.invalid)",
    created_at: "2030-01-01T00:03:00.000Z",
    relevance: 0.8,
  },
  {
    id: "public-one",
    entity_type: null,
    entity_id: null,
    conversation_name: "Launch room",
    message_id: "message-2",
    author_user_id: "author-b",
    content_text: "Launch checklist two",
    created_at: "2030-01-01T00:02:00.000Z",
    relevance: 0.5,
  },
  {
    id: "public-two",
    entity_type: null,
    entity_id: null,
    conversation_name: "Other room",
    message_id: "message-1",
    author_user_id: "author-a",
    content_text: "Launch checklist one",
    created_at: "2030-01-01T00:01:00.000Z",
    relevance: 0.5,
  },
];

const makeDatabase = () => {
  const calls = [];
  return {
    calls,
    resource: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        assert.equal(values[0], actor.tenantId);
        assert.equal(values[1], actor.userId);

        if (sql.startsWith("SELECT conversation.id")) {
          const conversationIds = values[2];
          return {
            rows: conversationIds
              .filter((id) => id !== "missing")
              .map((id) => ({
                id,
                entity_type: id.startsWith("entity-") ? "order" : null,
                entity_id: id.startsWith("entity-") ? id : null,
              })),
          };
        }

        assert.match(sql, /^WITH search_input/u);
        if (values[2] === "backend") {
          throw new Error("sensitive database connection detail");
        }
        const cursorMessageId = sql.includes("ranked.relevance, ranked.created_at")
          ? values.at(-2)
          : undefined;
        const start =
          cursorMessageId === undefined
            ? 0
            : candidates.findIndex(({ message_id }) => message_id === cursorMessageId) + 1;
        return { rows: candidates.slice(start, start + values.at(-1)) };
      },
      async connect() {
        throw new Error("message-search HTTP tests must not apply migrations");
      },
    },
  };
};

const createRuntime = () => {
  const database = makeDatabase();
  const authorizationCalls = [];
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
        throw new Error("message search must not read the directory");
      },
      async searchUsers() {
        throw new Error("message search must not search the directory");
      },
    },
    permissions: {
      async getCapabilities() {
        return ["conversation.read"];
      },
      async authorizeEntity(input) {
        authorizationCalls.push(input);
        if (input.entity.id === "entity-throw") {
          throw new Error("sensitive host policy detail");
        }
        return input.entity.id !== "entity-denied";
      },
    },
  });
  return { runtime, database, authorizationCalls };
};

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
  }
};

const post = (origin, body, headers = {}) =>
  fetch(`${origin}${MESSAGE_SEARCH_ROUTE}`, {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("POST /messages/search returns parsed private pages with opaque continuation", async () => {
  const fixture = createRuntime();
  await withHttpServer(fixture.runtime, async (origin) => {
    const firstResponse = await post(origin, {
      query: "  Launch  ",
      pageSize: 2,
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("cache-control"), "private, no-store");
    const first = parseMessageSearchResponse(await firstResponse.json());
    assert.deepEqual(first.hits.map(({ messageId }) => messageId), [
      "message-3",
      "message-2",
    ]);
    assert.equal(first.hits[0].snippet, "Launch guide");
    assert.equal(typeof first.nextCursor, "string");
    assert.doesNotMatch(first.nextCursor, /message-2|launch/iu);

    const second = parseMessageSearchResponse(
      await (
        await post(origin, {
          query: "Launch",
          pageSize: 2,
          cursor: first.nextCursor,
        })
      ).json(),
    );
    assert.deepEqual(second.hits.map(({ messageId }) => messageId), ["message-1"]);
    assert.equal(second.nextCursor, undefined);

    const mismatched = await post(origin, {
      query: "different",
      pageSize: 2,
      cursor: first.nextCursor,
    });
    await assertStableError(
      mismatched,
      400,
      CHAT_MESSAGE_SEARCH_INVALID_REQUEST_CODE,
      "Invalid message search request",
    );
  });
});

test("message-search routing and parsing reject noncanonical, unauthenticated, malformed, and identity-bearing input", async () => {
  const fixture = createRuntime();
  await withHttpServer(fixture.runtime, async (origin) => {
    assert.equal(
      (await fetch(`${origin}${MESSAGE_SEARCH_ROUTE}`, {
        headers: { authorization: "Bearer valid" },
      })).status,
      404,
    );
    assert.equal(
      (await fetch(`${origin}/search/messages`, {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({ query: "launch", pageSize: 2 }),
      })).status,
      404,
    );

    await assertStableError(
      await fetch(`${origin}${MESSAGE_SEARCH_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "launch", pageSize: 2 }),
      }),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    for (const [body, headers = {}] of [
      [{ query: "", pageSize: 2 }],
      [{ query: "launch", pageSize: 0 }],
      [{ query: "launch", pageSize: 2, tenantId: "tenant-b" }],
      [{ query: "launch", pageSize: 2 }, { "x-tenant-id": "tenant-b" }],
    ]) {
      await assertStableError(
        await post(origin, body, headers),
        400,
        CHAT_MESSAGE_SEARCH_INVALID_REQUEST_CODE,
        "Invalid message search request",
      );
    }
    await assertStableError(
      await fetch(`${origin}${MESSAGE_SEARCH_ROUTE}?query=launch`, {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({ query: "launch", pageSize: 2 }),
      }),
      400,
      CHAT_MESSAGE_SEARCH_INVALID_REQUEST_CODE,
      "Invalid message search request",
    );
  });
});

test("message-search maps entity policy and backend failures without leaking details", async () => {
  const fixture = createRuntime();
  await withHttpServer(fixture.runtime, async (origin) => {
    for (const conversationId of ["entity-denied", "entity-throw", "missing"]) {
      await assertStableError(
        await post(origin, {
          query: "launch",
          filters: { conversationIds: [conversationId] },
          pageSize: 2,
        }),
        403,
        CHAT_AUTHORIZATION_ERROR_CODE,
        "Chat authorization failed",
      );
    }
    assert.deepEqual(
      fixture.authorizationCalls.map(({ action }) => action),
      [MESSAGE_SEARCH_ENTITY_POLICY_ACTION, MESSAGE_SEARCH_ENTITY_POLICY_ACTION],
    );

    await assertStableError(
      await post(origin, { query: "backend", pageSize: 2 }),
      503,
      CHAT_MESSAGE_SEARCH_UNAVAILABLE_CODE,
      "Message search temporarily unavailable",
    );
  });
});
