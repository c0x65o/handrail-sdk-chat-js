import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_CONVERSATION_SNAPSHOT_INVALID_REQUEST_CODE,
  CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE_CODE,
  CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
  CONVERSATION_LIST_ENTITY_POLICY_ACTION,
  CONVERSATION_SNAPSHOT_FEATURE,
  CONVERSATION_SNAPSHOT_LIMIT_HEADER,
  CONVERSATION_SNAPSHOT_NEXT_CURSOR_HEADER,
  CONVERSATION_SNAPSHOT_VERSION,
  createChatServer,
  parseConversationDetailSnapshot,
  parseConversationListSnapshot,
} from "@handrail/chat/server";

const actor = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  roles: Object.freeze(["employee"]),
});

const timestamp = (hour) => `2030-01-02T${hour}:00:00.000000Z`;

const row = ({
  id,
  type = "channel",
  visibility = "public",
  name = null,
  entityType = null,
  entityId = null,
  activityHour,
  member = false,
  activeMemberUserIds = [],
  unreadMentionCount = 0,
  hasActiveHuddle = false,
}) => ({
  id,
  type,
  visibility,
  name,
  entity_type: entityType,
  entity_id: entityId,
  parent_conversation_id: null,
  root_message_id: null,
  current_message_sequence: 7,
  member_list_revision: 2,
  archived_at: null,
  archived_by_user_id: null,
  created_at: "2030-01-01T08:00:00.000Z",
  updated_at: timestamp(activityHour),
  activity_at: timestamp(activityHour),
  member_role: member ? "member" : null,
  member_state: member ? "active" : null,
  member_joined_at: member ? "2030-01-01T08:00:00.000Z" : null,
  member_updated_at: member ? "2030-01-01T09:00:00.000Z" : null,
  last_read_sequence: member ? 3 : null,
  manual_unread_from_sequence: null,
  read_updated_at: member ? "2030-01-01T09:30:00.000Z" : null,
  notification_level: member ? "mentions" : null,
  is_starred: member ? true : null,
  muted: member,
  muted_until: null,
  preference_updated_at: member ? "2030-01-01T09:40:00.000Z" : null,
  active_member_user_ids: activeMemberUserIds,
  unread_mention_count: unreadMentionCount,
  has_active_huddle: hasActiveHuddle,
  huddle_session_id: "must-not-leak-huddle-session",
  provider_room_reference: "must-not-leak-provider-room",
  huddle_participant_user_ids: ["must-not-leak-participant"],
  huddle_connection_state: "must-not-leak-connection-state",
  internal_buffer: Buffer.from("must-not-leak"),
  internal_row_marker: "must-not-leak",
});

const publicRow = row({
  id: "public-open",
  name: "Public",
  activityHour: "10",
});
const privateRow = row({
  id: "private-active",
  visibility: "private",
  name: "Private",
  activityHour: "09",
  member: true,
  activeMemberUserIds: ["user-a", "user-private"],
  unreadMentionCount: 2,
  hasActiveHuddle: true,
});
const directRow = row({
  id: "direct-active",
  type: "direct",
  visibility: "private",
  activityHour: "08",
  member: true,
  activeMemberUserIds: ["user-a", "user-c"],
});
const entityRow = row({
  id: "entity-public",
  name: "Order 42",
  entityType: "order",
  entityId: "42",
  activityHour: "07",
  unreadMentionCount: 1,
});

const makeDatabase = (options = {}) => {
  const calls = [];
  const listPublicRow = Object.hasOwn(options, "hasActiveHuddle")
    ? { ...publicRow, has_active_huddle: options.hasActiveHuddle }
    : publicRow;
  return {
    calls,
    resource: {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes("SELECT EXISTS")) {
          return { rows: [{ exists: false }] };
        }
        if (!sql.includes("chat_conversations")) {
          throw new Error(`unexpected snapshot HTTP query: ${sql}`);
        }
        if (sql.includes("AS member_user_ids")) {
          const conversationId = values[2];
          if (conversationId === "direct-active") {
            return {
              rows: [{ ...directRow, member_user_ids: ["user-a", "user-c"] }],
            };
          }
          if (conversationId === "entity-public") {
            return {
              rows: [{ ...entityRow, member_user_ids: ["user-a"] }],
            };
          }
          return { rows: [] };
        }
        if (sql.includes("conversation.entity_type =")) {
          return { rows: [entityRow] };
        }
        if (sql.includes("conversation.updated_at, conversation.id")) {
          return { rows: [directRow, entityRow] };
        }
        return { rows: [listPublicRow, privateRow, directRow] };
      },
      async connect() {
        throw new Error("snapshot HTTP routes must not apply migrations");
      },
    },
  };
};

const createRuntime = (options) => {
  const database = makeDatabase(options);
  const authorizationCalls = [];
  let entityAuthorized = true;
  const runtime = createChatServer({
    database: { pool: database.resource },
    auth: {
      async resolveActor(request) {
        if (request.headers.authorization !== "Bearer valid") {
          throw new Error("sensitive auth failure");
        }
        return actor;
      },
    },
    directory: {
      async getUser() {
        throw new Error("snapshot routes must not read the directory");
      },
      async searchUsers() {
        throw new Error("snapshot routes must not search the directory");
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
  });
  return {
    runtime,
    database,
    authorizationCalls,
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
    return await callback((path, init = {}) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, init),
    );
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
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code, message } });
};

test("GET conversation lists reject non-boolean huddle projections", async () => {
  for (const hasActiveHuddle of [undefined, null, "true", 1, {}, []]) {
    const fixture = createRuntime({ hasActiveHuddle });
    await withHttpServer(fixture.runtime, async (request) => {
      await assertStableError(
        await request("/conversations?scope=organization", authenticated),
        503,
        CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE_CODE,
        "Conversation snapshot temporarily unavailable",
      );
    });
  }
});

test("GET conversation snapshots are canonical, paginated, actor-scoped, and read-only", async () => {
  const fixture = createRuntime();

  await withHttpServer(fixture.runtime, async (request) => {
    const firstResponse = await request(
      "/conversations?scope=organization&limit=2",
      authenticated,
    );
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(
      firstResponse.headers.get(CONVERSATION_SNAPSHOT_LIMIT_HEADER),
      "2",
    );
    const firstCursor = firstResponse.headers.get(
      CONVERSATION_SNAPSHOT_NEXT_CURSOR_HEADER,
    );
    assert.ok(firstCursor);
    assert.match(firstResponse.headers.get("link") ?? "", /rel="next"/);

    const first = parseConversationListSnapshot(await firstResponse.json());
    assert.deepEqual(first.items.map(({ id }) => id), [
      "public-open",
      "private-active",
    ]);
    assert.deepEqual(first.scope, { type: "organization" });
    assert.equal(first.page.nextCursor, firstCursor);
    assert.equal(first._meta.protocolVersion, CHAT_PROTOCOL_VERSION);
    assert.equal(first._meta.schemaVersion, 0);
    assert.equal(typeof first._meta.packageVersion, "string");
    assert.deepEqual(first._meta.feature, {
      name: CONVERSATION_SNAPSHOT_FEATURE,
      version: CONVERSATION_SNAPSHOT_VERSION,
    });
    assert.equal(first.items[1].currentMember.userId, actor.userId);
    assert.equal(first.items[1].currentReadState.lastReadSequence, 3);
    assert.deepEqual(first.items[0].activeMemberUserIds, []);
    assert.deepEqual(first.items[1].activeMemberUserIds, [
      "user-a",
      "user-private",
    ]);
    assert.equal(first.items[0].unreadMentionCount, 0);
    assert.equal(first.items[1].unreadMentionCount, 2);
    assert.equal(first.items[0].hasActiveHuddle, false);
    assert.equal(first.items[1].hasActiveHuddle, true);
    assert.equal(first.items[0].currentPreference.isStarred, false);
    assert.equal(first.items[1].currentPreference.isStarred, true);
    assert.equal("unreadCount" in first.items[1], false);

    const secondResponse = await request(
      `/conversations?scope=organization&limit=2&cursor=${encodeURIComponent(firstCursor)}`,
      authenticated,
    );
    const second = parseConversationListSnapshot(await secondResponse.json());
    assert.deepEqual(second.items.map(({ id }) => id), [
      "direct-active",
      "entity-public",
    ]);
    assert.deepEqual(second.items[0].activeMemberUserIds, ["user-a", "user-c"]);
    assert.deepEqual(second.items[1].activeMemberUserIds, []);
    assert.equal(second.items[0].unreadMentionCount, 0);
    assert.equal(second.items[1].unreadMentionCount, 1);
    assert.equal(second.items[0].hasActiveHuddle, false);
    assert.equal(second.items[1].hasActiveHuddle, false);
    assert.equal(second.page.nextCursor, undefined);
    assert.equal(
      secondResponse.headers.get(CONVERSATION_SNAPSHOT_NEXT_CURSOR_HEADER),
      null,
    );
    assert.equal(secondResponse.headers.get("link"), null);

    fixture.authorizationCalls.length = 0;
    const entityResponse = await request(
      "/conversations?scope=entity&entityType=order&entityId=42",
      authenticated,
    );
    const entity = parseConversationListSnapshot(await entityResponse.json());
    assert.deepEqual(entity.scope, {
      type: "entity",
      entity: { type: "order", id: "42" },
    });
    assert.deepEqual(entity.items.map(({ id }) => id), ["entity-public"]);
    assert.deepEqual(fixture.authorizationCalls, [
      {
        actor,
        entity: { type: "order", id: "42" },
        action: CONVERSATION_LIST_ENTITY_POLICY_ACTION,
      },
    ]);

    const detailResponse = await request(
      "/conversations/direct-active",
      authenticated,
    );
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.headers.get("cache-control"), "private, no-store");
    const detail = parseConversationDetailSnapshot(await detailResponse.json());
    assert.equal(detail.conversation.id, "direct-active");
    assert.equal(detail.conversation.type, "direct");
    assert.deepEqual(detail.conversation.activeMemberUserIds, [
      "user-a",
      "user-c",
    ]);
    assert.deepEqual(detail.conversation.memberUserIds, ["user-a", "user-c"]);
    assert.equal(detail.conversation.memberListRevision, 2);
    assert.equal(detail.conversation.currentMember.userId, actor.userId);
    assert.deepEqual(detail.conversation.currentPreference, {
      conversationId: "direct-active",
      userId: "user-a",
      isStarred: true,
      notificationPreference: "mentions",
      mute: { muted: true },
      updatedAt: "2030-01-01T09:40:00.000Z",
    });

    fixture.authorizationCalls.length = 0;
    const entityDetailResponse = await request(
      "/conversations/entity-public",
      authenticated,
    );
    assert.equal(entityDetailResponse.status, 200);
    await entityDetailResponse.json();
    assert.equal(fixture.authorizationCalls.length, 1);
    assert.equal(
      fixture.authorizationCalls[0].action,
      CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
    );

    for (const path of [
      "/conversations?scope=organization&scope=entity",
      "/conversations?scope=organization&limit=101",
      "/conversations?scope=organization&cursor=not-a-cursor",
      "/conversations?scope=organization&tenantId=spoofed",
      "/conversations?scope=organization&actorId=spoofed",
      "/conversations?scope=organization&entityType=order",
      "/conversations?scope=entity&entityType=order",
      "/conversations?scope=organization&unknown=value",
      "/conversations/",
      "/conversations/direct-active/duplicate",
      "/conversations/direct-active?conversationId=duplicate",
      "/conversations/direct-active?tenantId=spoofed",
      "/conversations/direct-active?roles=admin",
    ]) {
      await assertStableError(
        await request(path, authenticated),
        400,
        CHAT_CONVERSATION_SNAPSHOT_INVALID_REQUEST_CODE,
        "Invalid conversation snapshot request",
      );
    }

    await assertStableError(
      await request("/conversations?scope=organization"),
      401,
      CHAT_AUTHENTICATION_ERROR_CODE,
      "Chat authentication failed",
    );

    const nondisclosure = [];
    for (const id of ["missing", "private-forbidden", "cross-tenant"]) {
      const response = await request(`/conversations/${id}`, authenticated);
      assert.equal(response.status, 403);
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
      await request(
        "/conversations?scope=entity&entityType=order&entityId=42",
        authenticated,
      ),
      403,
      CHAT_AUTHORIZATION_ERROR_CODE,
      "Chat authorization failed",
    );
    await assertStableError(
      await request("/conversations/entity-public", authenticated),
      403,
      CHAT_AUTHORIZATION_ERROR_CODE,
      "Chat authorization failed",
    );

    const successfulJson = JSON.stringify({ first, second, entity, detail });
    for (const forbiddenField of [
      "must-not-leak",
      "internal_buffer",
      "internal_row_marker",
      "socket",
      "headers",
      "stack",
      "rows",
      "rowCount",
      "current_message_sequence",
      "active_member_user_ids",
      "unread_mention_count",
      "has_active_huddle",
      "huddle_session_id",
      "provider_room_reference",
      "huddle_participant_user_ids",
      "huddle_connection_state",
      "member_user_ids",
      "messages",
    ]) {
      assert.equal(successfulJson.includes(forbiddenField), false);
    }
  });

  assert.ok(
    fixture.database.calls.some(({ sql }) => sql.includes("chat_conversations")),
  );
  assert.ok(
    fixture.database.calls.every(
      ({ sql }) => !/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql),
    ),
    "snapshot handlers must not execute mutations",
  );
  const mentionAggregateCalls = fixture.database.calls.filter(({ sql }) =>
    /FROM\s+"[^"]+"\.chat_messages\s+AS\s+message/iu.test(sql),
  );
  assert.ok(mentionAggregateCalls.length > 0);
  assert.ok(
    mentionAggregateCalls.every(
      ({ sql }) =>
        sql.includes("LEFT JOIN LATERAL") &&
        sql.includes("AS unread_mention_count") &&
        sql.includes("chat_conversations AS conversation"),
    ),
    "unread mentions must be aggregated inside the set-based conversation query",
  );
  const huddleProjectionCalls = fixture.database.calls.filter(({ sql }) =>
    /chat_huddle_sessions\s+AS\s+huddle_session/iu.test(sql),
  );
  assert.ok(huddleProjectionCalls.length > 0);
  assert.ok(
    huddleProjectionCalls.every(
      ({ sql }) =>
        /huddle_session\.tenant_id\s*=\s*conversation\.tenant_id/iu.test(sql) &&
        /huddle_session\.conversation_id\s*=\s*conversation\.id/iu.test(sql) &&
        /huddle_session\.status\s+IN\s*\('starting',\s*'active'\)/iu.test(sql) &&
        /EXISTS\s*\(/iu.test(sql),
    ),
    "active huddles must be projected by a scoped non-multiplying EXISTS",
  );
});
