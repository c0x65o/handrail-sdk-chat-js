import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { parseHuddleSessionState } from "@handrail/chat";
import {
  ACTIVE_HUDDLE_ENTITY_POLICY_ACTION,
  ACTIVE_HUDDLE_SNAPSHOT_ROUTE,
  CHAT_ACTIVE_HUDDLE_SNAPSHOT_INVALID_REQUEST_CODE,
  CHAT_ACTIVE_HUDDLE_SNAPSHOT_UNAVAILABLE_CODE,
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  createChatServer,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  roles: Object.freeze(["employee"]),
});

const inactiveRow = Object.freeze({
  entity_type: null,
  entity_id: null,
  huddle_session_id: null,
  huddle_status: null,
  started_at: null,
  active_screen_share_owner_user_id: null,
  participants: Object.freeze([]),
});

const liveRow = ({
  conversationId,
  status,
  participants = [],
  screenShareOwnerUserId = null,
  entityType = null,
  entityId = null,
}) => ({
  entity_type: entityType,
  entity_id: entityId,
  huddle_session_id: `huddle-${conversationId}`,
  huddle_status: status,
  started_at: "2030-01-02T00:00:00.000Z",
  active_screen_share_owner_user_id: screenShareOwnerUserId,
  participants,
});

const rowForRequest = (tenantId, conversationId) => {
  if (
    tenantId !== "tenant-a" ||
    ["missing", "private-nonmember", "cross-tenant"].includes(conversationId)
  ) {
    return undefined;
  }
  if (conversationId === "inactive") return inactiveRow;
  if (conversationId === "starting") {
    return liveRow({ conversationId, status: "starting" });
  }
  if (conversationId === "active") {
    return liveRow({
      conversationId,
      status: "active",
      participants: [
        {
          user_id: "participant-left",
          joined_at: "2030-01-02T00:00:01.000Z",
          left_at: "2030-01-02T00:01:00.000Z",
        },
        {
          user_id: "participant-joined",
          joined_at: "2030-01-02T00:00:02.000Z",
        },
      ],
      screenShareOwnerUserId: "participant-joined",
    });
  }
  if (conversationId === "entity-allowed" || conversationId === "entity-denied") {
    return liveRow({
      conversationId,
      status: "active",
      entityType: "order",
      entityId: conversationId === "entity-denied" ? "denied-42" : "42",
    });
  }
  return inactiveRow;
};

const createFixture = () => {
  const databaseCalls = [];
  const authorizationCalls = [];
  const database = {
    async query(sql, values = []) {
      databaseCalls.push({ sql, values });
      if (!sql.includes("WITH authorized_conversation AS")) {
        return { rows: [] };
      }
      const [tenantId, , conversationId] = values;
      if (conversationId === "temporary-failure") {
        throw new Error(
          "postgres://database-user:database-password@private-host/provider-room-secret?token=provider-token-secret",
        );
      }
      const row = rowForRequest(tenantId, conversationId);
      return row === undefined ? { rows: [] } : { rows: [row] };
    },
    async connect() {
      throw new Error("active-huddle snapshot HTTP route must remain read-only");
    },
  };
  const runtime = createChatServer({
    database: { pool: database, schema: "active_huddle_http" },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization !== "Bearer valid") {
          throw new Error("credential-secret must not leak");
        }
        return actor;
      },
    },
    directory: {
      async getUser() {
        throw new Error("active-huddle snapshot must not read the directory");
      },
      async searchUsers() {
        throw new Error("active-huddle snapshot must not search the directory");
      },
    },
    permissions: {
      async getCapabilities() {
        return ["huddle.read"];
      },
      async authorizeEntity(input) {
        authorizationCalls.push(input);
        return input.entity.id !== "denied-42";
      },
    },
    outbox: { pollIntervalMs: 60_000 },
  });
  return {
    runtime,
    databaseCalls,
    authorizationCalls,
    get snapshotDatabaseCalls() {
      return databaseCalls.filter(({ sql }) =>
        sql.includes("WITH authorized_conversation AS"),
      );
    },
  };
};

const route = (conversationId) =>
  ACTIVE_HUDDLE_SNAPSHOT_ROUTE.replace(
    ":conversationId",
    encodeURIComponent(conversationId),
  );

const withHttpServer = async (runtime, callback) => {
  const server = createServer(runtime.router);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({
      endpoint,
      request(path, init = {}) {
        return fetch(`${endpoint}${path}`, {
          ...init,
          headers: { authorization: "Bearer valid", ...init.headers },
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

const requestGetBody = (endpoint, path, value) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const request = httpRequest(
      `${endpoint}${path}`,
      {
        method: "GET",
        headers: {
          authorization: "Bearer valid",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
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

const assertSafeHeaders = (response) => {
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
};

const assertStableError = async (response, status, code, message) => {
  assert.equal(response.status, status);
  assertSafeHeaders(response);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: { code, message } });
  for (const secret of [
    "tenant-a",
    "database-password",
    "private-host",
    "provider-room-secret",
    "provider-token-secret",
    "credential-secret",
  ]) {
    assert.equal(text.includes(secret), false);
  }
  return text;
};

const assertNoSensitiveFields = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveFields(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    for (const forbidden of [
      "provider",
      "room",
      "token",
      "credential",
      "descriptor",
      "secret",
    ]) {
      assert.equal(normalized.includes(forbidden), false, `forbidden field: ${key}`);
    }
    assertNoSensitiveFields(nested);
  }
};

test("GET active-huddle snapshot returns canonical inactive, starting, and participant/share state exactly once", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    const expected = [
      {
        conversationId: "inactive",
        state: { status: "inactive", conversationId: "inactive" },
      },
      {
        conversationId: "starting",
        state: {
          status: "starting",
          conversationId: "starting",
          huddleSessionId: "huddle-starting",
          startedAt: "2030-01-02T00:00:00.000Z",
          participants: [],
          screenShareOwnerUserId: null,
        },
      },
      {
        conversationId: "active",
        state: {
          status: "active",
          conversationId: "active",
          huddleSessionId: "huddle-active",
          startedAt: "2030-01-02T00:00:00.000Z",
          participants: [
            {
              userId: "participant-left",
              status: "left",
              joinedAt: "2030-01-02T00:00:01.000Z",
              leftAt: "2030-01-02T00:01:00.000Z",
            },
            {
              userId: "participant-joined",
              status: "joined",
              joinedAt: "2030-01-02T00:00:02.000Z",
            },
          ],
          screenShareOwnerUserId: "participant-joined",
        },
      },
    ];

    for (const { conversationId, state } of expected) {
      const callsBefore = fixture.snapshotDatabaseCalls.length;
      const response = await request(route(conversationId));
      assert.equal(response.status, 200);
      assertSafeHeaders(response);
      const parsed = parseHuddleSessionState(await response.json());
      assert.deepEqual(parsed, state);
      assertNoSensitiveFields(parsed);
      assert.equal(fixture.snapshotDatabaseCalls.length, callsBefore + 1);
    }

    for (const call of fixture.snapshotDatabaseCalls) {
      assert.deepEqual(call.values.slice(0, 2), [actor.tenantId, actor.userId]);
      assert.match(call.sql, /"active_huddle_http"\.chat_huddle_sessions/u);
      assert.doesNotMatch(
        call.sql,
        /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/iu,
      );
    }
  });
});

test("active-huddle denial is indistinguishable for nonmembers, entities, missing records, and cross-tenant records", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    const allowed = await request(route("entity-allowed"));
    assert.equal(allowed.status, 200);
    assertSafeHeaders(allowed);
    await allowed.json();
    assert.deepEqual(fixture.authorizationCalls[0], {
      actor,
      entity: { type: "order", id: "42" },
      action: ACTIVE_HUDDLE_ENTITY_POLICY_ACTION,
    });

    const denialBodies = [];
    for (const conversationId of [
      "entity-denied",
      "private-nonmember",
      "missing",
      "cross-tenant",
    ]) {
      const callsBefore = fixture.snapshotDatabaseCalls.length;
      denialBodies.push(
        await assertStableError(
          await request(route(conversationId)),
          403,
          CHAT_AUTHORIZATION_ERROR_CODE,
          "Chat authorization failed",
        ),
      );
      assert.equal(fixture.snapshotDatabaseCalls.length, callsBefore + 1);
    }
    assert.equal(new Set(denialBodies).size, 1);
  });
});

test("active-huddle route rejects malformed, query, body, and spoofed input before querying", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ endpoint, request }) => {
    for (const path of [
      `${route("active")}?tenantId=tenant-b`,
      `${route("active")}?userId=other-user&providerRoomId=provider-room-secret`,
      `${route("active")}?token=provider-token-secret`,
      "/conversations/%E0%A4%A/huddle",
      "/conversations/active%2Fother/huddle",
      "/conversations/%20%20/huddle",
      "/conversations//huddle",
      "/conversations/active/huddle/extra",
    ]) {
      await assertStableError(
        await request(path),
        400,
        CHAT_ACTIVE_HUDDLE_SNAPSHOT_INVALID_REQUEST_CODE,
        "Invalid active huddle snapshot request",
      );
    }

    await assertStableError(
      await requestGetBody(endpoint, route("active"), {
        tenantId: "tenant-b",
        userId: "other-user",
        provider: "secret-provider",
        token: "provider-token-secret",
      }),
      400,
      CHAT_ACTIVE_HUDDLE_SNAPSHOT_INVALID_REQUEST_CODE,
      "Invalid active huddle snapshot request",
    );
    assert.equal(fixture.snapshotDatabaseCalls.length, 0);
  });
});

test("active-huddle route sanitizes authentication and temporary failures", async () => {
  const fixture = createFixture();
  await withHttpServer(fixture.runtime, async ({ request }) => {
    await assertStableError(
      await request(route("inactive"), {
        headers: { authorization: "Bearer invalid" },
      }),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );
    assert.equal(fixture.snapshotDatabaseCalls.length, 0);

    await assertStableError(
      await request(route("temporary-failure")),
      503,
      CHAT_ACTIVE_HUDDLE_SNAPSHOT_UNAVAILABLE_CODE,
      "Active huddle snapshot temporarily unavailable",
    );
    assert.equal(fixture.snapshotDatabaseCalls.length, 1);
  });
});
