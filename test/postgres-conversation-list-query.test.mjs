import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  CONVERSATION_LIST_ENTITY_POLICY_ACTION,
  CONVERSATION_NAVIGATION_RANK,
  MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  ChatAuthorizationError,
  chatConversationListOrderingMigration,
  decodeConversationSnapshotCursor,
  encodeConversationSnapshotCursor,
  encodeLegacyConversationSnapshotCursor,
  encodeStarredFirstLegacyConversationSnapshotCursor,
  handrailChatPostgresMigrations,
  queryConversationList,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorA = {
  credential: "conversation-list-actor-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
};

const actorB = {
  credential: "conversation-list-actor-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["employee"],
  },
};

const actorSameTenant = {
  credential: "conversation-list-actor-same-tenant",
  actor: {
    tenantId: "tenant-a",
    userId: "user-same-tenant",
    roles: ["employee"],
  },
};

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const countedDatabase = (pool) => {
  let queryCount = 0;
  return {
    database: {
      query(...args) {
        queryCount += 1;
        return pool.query(...args);
      },
      connect() {
        return pool.connect();
      },
    },
    count: () => queryCount,
  };
};

const capturedDatabase = (pool) => {
  let query;
  return {
    database: {
      async query(text, values) {
        query = { text, values };
        return pool.query(text, values);
      },
      connect() {
        return pool.connect();
      },
    },
    captured: () => query,
  };
};

const findPlanIndexes = (plan, indexes = []) => {
  if (plan && typeof plan === "object") {
    if (typeof plan["Index Name"] === "string") {
      indexes.push(plan["Index Name"]);
    }
    for (const value of Object.values(plan)) {
      findPlanIndexes(value, indexes);
    }
  }
  return indexes;
};

const explainCapturedQuery = async (pool, captured) => {
  assert.ok(captured);
  assert.match(
    captured.text,
    /COALESCE\(preference\.is_starred, false\) < \$\d+::boolean/,
  );
  assert.match(
    captured.text,
    /ORDER BY COALESCE\(preference\.is_starred, false\) DESC, CASE[\s\S]+END ASC, conversation\.updated_at DESC, conversation\.id DESC/,
  );

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL enable_seqscan = off");
    const explained = await connection.query(
      `EXPLAIN (FORMAT JSON) ${captured.text}`,
      captured.values,
    );
    return findPlanIndexes(explained.rows[0]["QUERY PLAN"]);
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
};

const runList = (harness, database, input) =>
  queryConversationList({
    database,
    permissions: harness.adapters.permissions,
    actor: actorA.actor,
    input,
    schema: harness.schema,
  });

test("conversation list SQL and emitted cursors preserve v3, v2, and v1 keysets", async () => {
  const activityAt = "2030-01-01T10:00:00.000000Z";
  const row = {
    id: "cursor-direct",
    type: "direct",
    visibility: "private",
    name: null,
    entity_type: null,
    entity_id: null,
    parent_conversation_id: null,
    root_message_id: null,
    current_message_sequence: 0,
    created_at: "2030-01-01T09:00:00Z",
    updated_at: "2030-01-01T10:00:00Z",
    activity_at: activityAt,
    member_role: "member",
    member_state: "active",
    member_joined_at: "2030-01-01T09:00:00Z",
    member_updated_at: "2030-01-01T09:00:00Z",
    last_read_sequence: null,
    manual_unread_from_sequence: null,
    read_updated_at: null,
    notification_level: null,
    is_starred: false,
    muted: null,
    muted_until: null,
    preference_revision: null,
    preference_updated_at: null,
    active_member_user_ids: ["user-a"],
    unread_mention_count: 0,
    has_active_huddle: false,
  };
  const queries = [];
  const database = {
    async query(text, values) {
      queries.push({ text, values });
      return { rows: [row, row] };
    },
  };
  const permissions = {
    async authorizeEntity() {
      throw new Error("organization scope must not authorize an entity");
    },
  };
  const scope = { type: "organization" };
  const cursorActivityAt = "2031-01-01T00:00:00.000Z";
  const v3InputCursor = encodeConversationSnapshotCursor({
    isStarred: false,
    navigationRank: CONVERSATION_NAVIGATION_RANK.privateChannel,
    activityAt: cursorActivityAt,
    conversationId: "v3-position",
  });
  const v2InputCursor = encodeStarredFirstLegacyConversationSnapshotCursor({
    isStarred: true,
    activityAt: cursorActivityAt,
    conversationId: "v2-position",
  });
  const v1InputCursor = encodeLegacyConversationSnapshotCursor({
    activityAt: cursorActivityAt,
    conversationId: "v1-position",
  });

  const results = [];
  for (const cursor of [undefined, v3InputCursor, v2InputCursor, v1InputCursor]) {
    results.push(
      await queryConversationList({
        database,
        permissions,
        actor: actorA.actor,
        input: { scope, limit: 1, ...(cursor === undefined ? {} : { cursor }) },
        schema: "cursor_shapes",
      }),
    );
  }

  assert.equal(queries.length, 4);
  const [freshQuery, v3Query, v2Query, v1Query] = queries.map((query) => ({
    ...query,
    normalizedText: query.text.replaceAll(/\s+/g, " ").trim(),
  }));
  const v3Order =
    "ORDER BY COALESCE(preference.is_starred, false) DESC, CASE WHEN conversation.type = 'direct' THEN 0 WHEN conversation.type = 'channel' AND conversation.visibility = 'public' THEN 1 WHEN conversation.type = 'channel' AND conversation.visibility = 'private' THEN 2 WHEN conversation.type = 'group_direct' THEN 3 ELSE 4 END ASC, conversation.updated_at DESC, conversation.id DESC";

  assert.deepEqual(freshQuery.values, ["tenant-a", "user-a", 2]);
  assert.ok(freshQuery.normalizedText.includes(v3Order));
  assert.doesNotMatch(freshQuery.normalizedText, /conversation\.updated_at, conversation\.id\) </);

  assert.deepEqual(v3Query.values, [
    "tenant-a",
    "user-a",
    false,
    CONVERSATION_NAVIGATION_RANK.privateChannel,
    cursorActivityAt,
    "v3-position",
    2,
  ]);
  assert.match(v3Query.normalizedText, /is_starred, false\) < \$3::boolean/);
  assert.match(v3Query.normalizedText, /END > \$4::integer/);
  assert.match(v3Query.normalizedText, /END = \$4::integer/);
  assert.match(
    v3Query.normalizedText,
    /conversation\.updated_at, conversation\.id\) < \(\$5::timestamptz, \$6::text\)/,
  );
  assert.ok(v3Query.normalizedText.includes(v3Order));

  assert.deepEqual(v2Query.values, [
    "tenant-a",
    "user-a",
    true,
    cursorActivityAt,
    "v2-position",
    2,
  ]);
  assert.match(
    v2Query.normalizedText,
    /\(COALESCE\(preference\.is_starred, false\), conversation\.updated_at, conversation\.id\) < \(\$3::boolean, \$4::timestamptz, \$5::text\)/,
  );
  assert.match(
    v2Query.normalizedText,
    /ORDER BY COALESCE\(preference\.is_starred, false\) DESC, conversation\.updated_at DESC, conversation\.id DESC/,
  );
  assert.doesNotMatch(v2Query.normalizedText, /WHEN conversation\.type = 'direct' THEN 0/);

  assert.deepEqual(v1Query.values, [
    "tenant-a",
    "user-a",
    cursorActivityAt,
    "v1-position",
    2,
  ]);
  assert.match(
    v1Query.normalizedText,
    /\(conversation\.updated_at, conversation\.id\) < \(\$3::timestamptz, \$4::text\)/,
  );
  assert.match(
    v1Query.normalizedText,
    /ORDER BY conversation\.updated_at DESC, conversation\.id DESC/,
  );
  assert.doesNotMatch(v1Query.normalizedText, /COALESCE\(preference\.is_starred, false\) DESC/);

  assert.deepEqual(
    results.map(({ nextCursor }) => decodeConversationSnapshotCursor(nextCursor)),
    [
      {
        isStarred: false,
        navigationRank: CONVERSATION_NAVIGATION_RANK.direct,
        activityAt,
        conversationId: "cursor-direct",
      },
      {
        isStarred: false,
        navigationRank: CONVERSATION_NAVIGATION_RANK.direct,
        activityAt,
        conversationId: "cursor-direct",
      },
      {
        isStarred: false,
        activityAt,
        conversationId: "cursor-direct",
      },
      {
        activityAt,
        conversationId: "cursor-direct",
      },
    ],
  );
  assert.match(results[0].nextCursor, /^handrail-conversations\.v3\./);
  assert.match(results[1].nextCursor, /^handrail-conversations\.v3\./);
  assert.match(results[2].nextCursor, /^handrail-conversations\.v2\./);
  assert.match(results[3].nextCursor, /^handrail-conversations\.v1\./);
});

test("conversation list ordering migration is immutable and forward-registered", () => {
  assert.deepEqual(
    {
      id: chatConversationListOrderingMigration.id,
      order: chatConversationListOrderingMigration.order,
    },
    { id: "0023-chat-conversation-list-ordering", order: 23 },
  );
  assert.equal(Object.isFrozen(chatConversationListOrderingMigration), true);
  assert.equal(
    Object.isFrozen(chatConversationListOrderingMigration.statements),
    true,
  );
  assert.equal(Object.isFrozen(handrailChatPostgresMigrations), true);

  const migrationIndex = handrailChatPostgresMigrations.indexOf(
    chatConversationListOrderingMigration,
  );
  assert.ok(migrationIndex > 0);
  assert.equal(
    handrailChatPostgresMigrations[migrationIndex - 1].order <
      chatConversationListOrderingMigration.order,
    true,
  );
  assert.deepEqual(
    handrailChatPostgresMigrations.map(({ order }) => order),
    [...handrailChatPostgresMigrations]
      .map(({ order }) => order)
      .sort((left, right) => left - right),
  );
  assert.equal(
    new Set(handrailChatPostgresMigrations.map(({ id }) => id)).size,
    handrailChatPostgresMigrations.length,
  );
  assert.equal(
    new Set(handrailChatPostgresMigrations.map(({ order }) => order)).size,
    handrailChatPostgresMigrations.length,
  );
});

test("conversation list keyset queries use active organization and entity indexes", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_list_indexes",
    });
    const conversations = `${quoteIdentifier(harness.schema)}.chat_conversations`;

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          archived_at, archived_by_user_id, created_at, updated_at)
       SELECT
         'tenant-a',
         'organization-' || lpad(series::text, 5, '0'),
         'channel',
         'public',
         'Organization ' || series,
         NULL,
         NULL,
         NULL,
         NULL,
         '2029-01-01T00:00:00Z'::timestamptz,
         '2030-01-01T00:00:00Z'::timestamptz - series * interval '1 second'
       FROM generate_series(1, 2000) AS series
       UNION ALL
       SELECT
         'tenant-a',
         'entity-' || lpad(series::text, 5, '0'),
         'channel',
         'public',
         'Entity ' || series,
         'invoice',
         'plan-fixture',
         NULL,
         NULL,
         '2029-01-01T00:00:00Z'::timestamptz,
         '2030-02-01T00:00:00Z'::timestamptz - series * interval '1 second'
       FROM generate_series(1, 2000) AS series
       UNION ALL
       SELECT
         'tenant-a',
         'archived-' || lpad(series::text, 5, '0'),
         'channel',
         'public',
         'Archived ' || series,
         'invoice',
         'plan-fixture',
         '2030-03-01T00:00:00Z'::timestamptz,
         'user-a',
         '2029-01-01T00:00:00Z'::timestamptz,
         '2030-03-01T00:00:00Z'::timestamptz - series * interval '1 second'
       FROM generate_series(1, 1000) AS series`,
    );
    await harness.pool.query(`ANALYZE ${conversations}`);

    const organizationFirst = await runList(harness, harness.pool, {
      scope: { type: "organization" },
      limit: 20,
    });
    const organizationCapture = capturedDatabase(harness.pool);
    await runList(harness, organizationCapture.database, {
      scope: { type: "organization" },
      limit: 20,
      cursor: organizationFirst.nextCursor,
    });
    const organizationIndexes = await explainCapturedQuery(
      harness.pool,
      organizationCapture.captured(),
    );
    assert.ok(
      organizationIndexes.includes(
        "chat_conversations_active_organization_list_idx",
      ),
      `organization plan indexes: ${organizationIndexes.join(", ")}`,
    );
    assert.ok(
      organizationIndexes.includes("chat_messages_conversation_timeline_idx"),
      `organization mention plan indexes: ${organizationIndexes.join(", ")}`,
    );

    const entityScope = {
      type: "entity",
      entity: { type: "invoice", id: "plan-fixture" },
    };
    const entityFirst = await runList(harness, harness.pool, {
      scope: entityScope,
      limit: 20,
    });
    const entityCapture = capturedDatabase(harness.pool);
    await runList(harness, entityCapture.database, {
      scope: entityScope,
      limit: 20,
      cursor: entityFirst.nextCursor,
    });
    const entityIndexes = await explainCapturedQuery(
      harness.pool,
      entityCapture.captured(),
    );
    assert.ok(
      entityIndexes.includes("chat_conversations_active_entity_list_idx"),
      `entity plan indexes: ${entityIndexes.join(", ")}`,
    );
    assert.ok(
      entityIndexes.includes("chat_messages_conversation_timeline_idx"),
      `entity mention plan indexes: ${entityIndexes.join(", ")}`,
    );
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("conversation list query enforces tenant, visibility, actor state, and entity authorization", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_list_query",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const messages = `${schema}.chat_messages`;
    const members = `${schema}.chat_conversation_members`;
    const readCursors = `${schema}.chat_read_cursors`;
    const preferences = `${schema}.chat_conversation_preferences`;
    const huddleSessions = `${schema}.chat_huddle_sessions`;
    const huddleParticipants = `${schema}.chat_huddle_participants`;

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          current_message_sequence, archived_at, archived_by_user_id,
          created_at, updated_at)
       VALUES
         ('tenant-a', 'public-open', 'channel', 'public', 'Public', NULL, NULL,
          4, NULL, NULL, '2030-01-01T08:00:00Z', '2030-01-01T10:09:00Z'),
         ('tenant-a', 'public-left', 'channel', 'public', 'Former member', NULL, NULL,
          1, NULL, NULL, '2030-01-01T08:01:00Z', '2030-01-01T10:08:00Z'),
         ('tenant-a', 'private-active', 'channel', 'private', 'Private', NULL, NULL,
          10, NULL, NULL, '2030-01-01T08:02:00Z', '2030-01-01T10:07:00Z'),
         ('tenant-a', 'direct-active', 'direct', 'private', NULL, NULL, NULL,
          3, NULL, NULL, '2030-01-01T08:03:00Z', '2030-01-01T10:06:00Z'),
         ('tenant-a', 'group-active', 'group_direct', 'private', NULL, NULL, NULL,
          2, NULL, NULL, '2030-01-01T08:04:00Z', '2030-01-01T10:05:00Z'),
         ('tenant-a', 'private-inactive', 'channel', 'private', 'Inactive', NULL, NULL,
          2, NULL, NULL, '2030-01-01T08:05:00Z', '2030-01-01T10:04:00Z'),
         ('tenant-a', 'private-other', 'channel', 'private', 'Other private', NULL, NULL,
          2, NULL, NULL, '2030-01-01T08:06:00Z', '2030-01-01T10:03:00Z'),
         ('tenant-a', 'direct-other', 'direct', 'private', NULL, NULL, NULL,
          2, NULL, NULL, '2030-01-01T08:07:00Z', '2030-01-01T10:02:00Z'),
         ('tenant-a', 'archived-public', 'channel', 'public', 'Archived', NULL, NULL,
          9, '2030-01-01T10:01:00Z', 'user-a',
          '2030-01-01T08:08:00Z', '2030-01-01T10:01:00Z'),
         ('tenant-a', 'entity-match', 'channel', 'public', 'Order 42', 'order', '42',
          5, NULL, NULL, '2030-01-01T08:09:00Z', '2030-01-01T10:00:00Z'),
         ('tenant-a', 'entity-other', 'channel', 'public', 'Order 99', 'order', '99',
          1, NULL, NULL, '2030-01-01T08:10:00Z', '2030-01-01T09:59:00Z'),
         ('tenant-b', 'public-open', 'channel', 'public', 'Tenant B collision', NULL, NULL,
          99, NULL, NULL, '2030-01-01T08:00:00Z', '2030-01-02T10:09:00Z'),
         ('tenant-b', 'entity-match', 'channel', 'public', 'Tenant B entity', 'order', '42',
          99, NULL, NULL, '2030-01-01T08:00:00Z', '2030-01-02T10:00:00Z'),
         ('tenant-b', 'tenant-b-only', 'channel', 'public', 'Tenant B only', NULL, NULL,
          99, NULL, NULL, '2030-01-01T08:00:00Z', '2030-01-02T09:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, created_at, updated_at, deleted_at,
          deleted_by_user_id)
       VALUES
         ('tenant-a', 'direct-root', 'direct-active', 1, 'user-a',
          'direct-root-client', '{"format":"plain","text":"Thread root"}',
          '2030-01-01T08:03:00Z', '2030-01-01T08:03:00Z', NULL, NULL),
         ('tenant-a', 'direct-read-mention', 'direct-active', 2, 'user-direct',
          'direct-read-mention-client',
          '{"format":"plain","text":"Already read","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:04:00Z', '2030-01-01T08:04:00Z', NULL, NULL),
         ('tenant-a', 'public-conversation-mention', 'public-open', 1, 'user-public',
          'public-conversation-mention-client',
          '{"format":"plain","text":"Conversation mention","mentions":[{"type":"conversation","conversationId":"user-a"}]}',
          '2030-01-01T08:05:00Z', '2030-01-01T08:05:00Z', NULL, NULL),
         ('tenant-a', 'public-user-mention', 'public-open', 2, 'user-public',
          'public-user-mention-client',
          '{"format":"plain","text":"User mention","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:06:00Z', '2030-01-01T08:06:00Z', NULL, NULL),
         ('tenant-a', 'public-entity-mention', 'public-open', 3, 'user-public',
          'public-entity-mention-client',
          '{"format":"plain","text":"Entity mention","mentions":[{"type":"entity","entity":{"type":"user","id":"user-a"}}]}',
          '2030-01-01T08:07:00Z', '2030-01-01T08:07:00Z', NULL, NULL),
         ('tenant-a', 'public-deleted-mention', 'public-open', 4, 'user-public',
          'public-deleted-mention-client',
          '{"format":"plain","text":"Deleted mention","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:08:00Z', '2030-01-01T09:00:00Z',
          '2030-01-01T09:00:00Z', 'user-public'),
         ('tenant-a', 'private-read-mention', 'private-active', 3, 'user-private',
          'private-read-mention-client',
          '{"format":"plain","text":"Below boundary","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:09:00Z', '2030-01-01T08:09:00Z', NULL, NULL),
         ('tenant-a', 'private-boundary-mention', 'private-active', 4, 'user-private',
          'private-boundary-mention-client',
          '{"format":"plain","text":"At boundary","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:10:00Z', '2030-01-01T08:10:00Z', NULL, NULL),
         ('tenant-a', 'private-manual-unread-mention', 'private-active', 5, 'user-private',
          'private-manual-unread-mention-client',
          '{"format":"plain","text":"Manual unread","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:11:00Z', '2030-01-01T08:11:00Z', NULL, NULL),
         ('tenant-a', 'private-conversation-mention', 'private-active', 6, 'user-private',
          'private-conversation-mention-client',
          '{"format":"plain","text":"Conversation mention","mentions":[{"type":"conversation","conversationId":"user-a"}]}',
          '2030-01-01T08:12:00Z', '2030-01-01T08:12:00Z', NULL, NULL),
         ('tenant-a', 'private-entity-mention', 'private-active', 7, 'user-private',
          'private-entity-mention-client',
          '{"format":"plain","text":"Entity mention","mentions":[{"type":"entity","entity":{"type":"user","id":"user-a"}}]}',
          '2030-01-01T08:13:00Z', '2030-01-01T08:13:00Z', NULL, NULL),
         ('tenant-a', 'private-duplicate-mention', 'private-active', 8, 'user-private',
          'private-duplicate-mention-client',
          '{"format":"plain","text":"One mentioned message","mentions":[{"type":"user","userId":"user-a"},{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:14:00Z', '2030-01-01T08:14:00Z', NULL, NULL),
         ('tenant-a', 'private-other-user-mention', 'private-active', 9, 'user-private',
          'private-other-user-mention-client',
          '{"format":"plain","text":"Other user","mentions":[{"type":"user","userId":"user-other"}]}',
          '2030-01-01T08:15:00Z', '2030-01-01T08:15:00Z', NULL, NULL),
         ('tenant-a', 'private-deleted-mention', 'private-active', 10, 'user-private',
          'private-deleted-mention-client',
          '{"format":"plain","text":"Deleted mention","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:16:00Z', '2030-01-01T09:01:00Z',
          '2030-01-01T09:01:00Z', 'user-private'),
         ('tenant-b', 'cross-tenant-mention', 'public-open', 2, 'user-b',
          'cross-tenant-mention-client',
          '{"format":"plain","text":"Other tenant","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:17:00Z', '2030-01-01T08:17:00Z', NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, parent_conversation_id,
          root_message_id, current_message_sequence, created_at, updated_at)
       VALUES
         ('tenant-a', 'direct-thread', 'thread', 'private', 'direct-active',
          'direct-root', 1, '2030-01-01T08:11:00Z', '2030-01-01T10:10:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
       VALUES
         ('tenant-a', 'public-open', 'user-public', 'member', 'active',
          '2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'public-left', 'user-a', 'member', 'left',
          '2030-01-01T08:01:00Z', '2030-01-01T09:01:00Z'),
         ('tenant-a', 'public-left', 'user-former-other', 'member', 'active',
          '2030-01-01T08:01:00Z', '2030-01-01T09:01:00Z'),
         ('tenant-a', 'private-active', 'user-a', 'moderator', 'active',
          '2030-01-01T08:02:00Z', '2030-01-01T09:02:00Z'),
         ('tenant-a', 'private-active', 'user-private', 'member', 'active',
          '2030-01-01T08:02:00Z', '2030-01-01T09:02:00Z'),
         ('tenant-a', 'private-active', 'user-private-left', 'member', 'left',
          '2030-01-01T08:02:00Z', '2030-01-01T09:02:00Z'),
         ('tenant-a', 'direct-active', 'user-a', 'member', 'active',
          '2030-01-01T08:03:00Z', '2030-01-01T09:03:00Z'),
         ('tenant-a', 'direct-active', 'user-direct', 'member', 'active',
          '2030-01-01T08:03:00Z', '2030-01-01T09:03:00Z'),
         ('tenant-a', 'direct-active', 'user-direct-removed', 'member', 'removed',
          '2030-01-01T08:03:00Z', '2030-01-01T09:03:00Z'),
         ('tenant-a', 'group-active', 'user-a', 'member', 'active',
          '2030-01-01T08:04:00Z', '2030-01-01T09:04:00Z'),
         ('tenant-a', 'group-active', 'user-group-b', 'member', 'active',
          '2030-01-01T08:04:00Z', '2030-01-01T09:04:00Z'),
         ('tenant-a', 'group-active', 'user-group-c', 'member', 'active',
          '2030-01-01T08:04:00Z', '2030-01-01T09:04:00Z'),
         ('tenant-a', 'direct-thread', 'user-a', 'member', 'active',
          '2030-01-01T08:11:00Z', '2030-01-01T09:11:00Z'),
         ('tenant-a', 'private-inactive', 'user-a', 'member', 'removed',
          '2030-01-01T08:05:00Z', '2030-01-01T09:05:00Z'),
         ('tenant-a', 'private-other', 'user-other', 'member', 'active',
          '2030-01-01T08:06:00Z', '2030-01-01T09:06:00Z'),
         ('tenant-a', 'direct-other', 'user-other', 'member', 'active',
          '2030-01-01T08:07:00Z', '2030-01-01T09:07:00Z'),
         ('tenant-a', 'entity-match', 'user-entity', 'member', 'active',
          '2030-01-01T08:09:00Z', '2030-01-01T09:09:00Z'),
         ('tenant-b', 'public-open', 'user-b', 'member', 'active',
          '2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-b', 'public-open', 'user-cross-tenant', 'member', 'active',
          '2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-b', 'entity-match', 'user-b', 'member', 'active',
          '2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${readCursors}
         (tenant_id, conversation_id, user_id, last_read_sequence,
          manual_unread_from_sequence, updated_at)
       VALUES
         ('tenant-a', 'private-active', 'user-a', 7, 5,
          '2030-01-01T09:30:00Z'),
         ('tenant-a', 'direct-active', 'user-a', 3, NULL,
          '2030-01-01T09:31:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${preferences}
         (tenant_id, conversation_id, user_id, notification_level, is_starred, muted,
          muted_until, created_at, updated_at)
       VALUES
         ('tenant-a', 'private-active', 'user-a', 'mentions', true, true, NULL,
          '2030-01-01T09:00:00Z', '2030-01-01T09:40:00Z'),
         ('tenant-a', 'direct-active', 'user-a', 'none', false, true,
          '2030-02-01T00:00:00Z', '2030-01-01T09:00:00Z',
          '2030-01-01T09:41:00Z'),
         ('tenant-a', 'public-open', 'user-public', 'none', true, false, NULL,
          '2030-01-01T09:00:00Z', '2030-01-01T09:42:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${huddleSessions}
         (tenant_id, id, conversation_id, provider_room_reference,
          initiated_by_user_id, started_at, updated_at)
       VALUES
         ('tenant-a', 'huddle-channel-starting', 'public-open',
          'private-provider-channel-starting', 'user-public',
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'huddle-direct-active', 'direct-active',
          'private-provider-direct-active', 'user-a',
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'huddle-group-ending', 'group-active',
          'private-provider-group-ending', 'user-a',
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'huddle-channel-ended', 'private-active',
          'private-provider-channel-ended', 'user-a',
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-b', 'huddle-cross-tenant', 'entity-match',
          'private-provider-cross-tenant', 'user-b',
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${huddleParticipants}
         (tenant_id, huddle_session_id, user_id, joined_at)
       VALUES
         ('tenant-a', 'huddle-direct-active', 'user-a',
          '2030-01-01T09:00:01Z')`,
    );
    await harness.pool.query(
      `UPDATE ${huddleSessions}
          SET status = 'active',
              activated_at = '2030-01-01T09:00:01Z',
              updated_at = '2030-01-01T09:00:01Z'
        WHERE tenant_id = 'tenant-a' AND id = 'huddle-direct-active'`,
    );
    await harness.pool.query(
      `UPDATE ${huddleSessions}
          SET status = 'ending',
              ended_by_user_id = 'user-a',
              updated_at = '2030-01-01T09:00:02Z'
        WHERE tenant_id = 'tenant-a'
          AND id IN ('huddle-group-ending', 'huddle-channel-ended')`,
    );
    await harness.pool.query(
      `UPDATE ${huddleSessions}
          SET status = 'ended',
              ended_at = '2030-01-01T09:00:03Z',
              updated_at = '2030-01-01T09:00:03Z'
        WHERE tenant_id = 'tenant-a' AND id = 'huddle-channel-ended'`,
    );

    const organizationDatabase = countedDatabase(harness.pool);
    const organization = await runList(
      harness,
      organizationDatabase.database,
      { scope: { type: "organization" }, limit: 100 },
    );

    assert.equal(organizationDatabase.count(), 1);
    assert.deepEqual(
      organization.items.map(({ id }) => id),
      [
        "private-active",
        "direct-active",
        "public-open",
        "public-left",
        "entity-match",
        "entity-other",
        "group-active",
      ],
    );
    assert.equal(
      organization.items.some(({ type }) => type === "thread"),
      false,
    );
    assert.ok(organization.items.every(({ tenantId }) => tenantId === "tenant-a"));
    assert.equal(organization.nextCursor, undefined);
    assert.deepEqual(
      organization.items.map(({ id, hasActiveHuddle }) => ({
        id,
        hasActiveHuddle,
      })),
      [
        { id: "private-active", hasActiveHuddle: false },
        { id: "direct-active", hasActiveHuddle: true },
        { id: "public-open", hasActiveHuddle: true },
        { id: "public-left", hasActiveHuddle: false },
        { id: "entity-match", hasActiveHuddle: false },
        { id: "entity-other", hasActiveHuddle: false },
        { id: "group-active", hasActiveHuddle: false },
      ],
    );

    const huddleQueryCapture = capturedDatabase(harness.pool);
    await runList(harness, huddleQueryCapture.database, {
      scope: { type: "organization" },
      limit: 1,
    });
    assert.match(
      huddleQueryCapture.captured().text,
      /EXISTS\s*\([\s\S]*huddle_session\.tenant_id\s*=\s*conversation\.tenant_id[\s\S]*huddle_session\.conversation_id\s*=\s*conversation\.id[\s\S]*huddle_session\.status\s+IN\s*\('starting',\s*'active'\)/u,
    );

    const publicDefault = organization.items.find(({ id }) => id === "public-open");
    assert.deepEqual(publicDefault.currentMember, {
      tenantId: "tenant-a",
      conversationId: "public-open",
      userId: "user-a",
      role: "member",
      state: "active",
      joinedAt: "2030-01-01T08:00:00.000Z",
      updatedAt: "2030-01-01T08:00:00.000Z",
    });
    assert.deepEqual(publicDefault.currentReadState, {
      conversationId: "public-open",
      userId: "user-a",
      lastReadSequence: 0,
      updatedAt: "2030-01-01T08:00:00.000Z",
    });
    assert.equal(publicDefault.unreadCount, 4);
    assert.equal(publicDefault.unreadMentionCount, 1);
    assert.deepEqual(publicDefault.activeMemberUserIds, []);
    assert.equal(Object.isFrozen(publicDefault.activeMemberUserIds), true);
    assert.deepEqual(
      organization.items.find(({ id }) => id === "public-left")
        .activeMemberUserIds,
      [],
    );
    assert.deepEqual(publicDefault.currentPreference, {
      preferenceRevision: 0,
      conversationId: "public-open",
      userId: "user-a",
      isStarred: false,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: "2030-01-01T08:00:00.000Z",
    });

    const privateState = organization.items.find(
      ({ id }) => id === "private-active",
    );
    assert.equal(privateState.currentMember.role, "moderator");
    assert.deepEqual(privateState.activeMemberUserIds, ["user-a", "user-private"]);
    assert.deepEqual(privateState.currentReadState, {
      conversationId: "private-active",
      userId: "user-a",
      lastReadSequence: 7,
      manualUnreadFromSequence: 5,
      updatedAt: "2030-01-01T09:30:00.000Z",
    });
    assert.equal(privateState.unreadCount, 6);
    assert.equal(privateState.unreadMentionCount, 2);
    assert.deepEqual(privateState.currentPreference, {
      preferenceRevision: 1,
      conversationId: "private-active",
      userId: "user-a",
      isStarred: true,
      notificationPreference: "mentions",
      mute: { muted: true },
      updatedAt: "2030-01-01T09:40:00.000Z",
    });

    const directState = organization.items.find(
      ({ id }) => id === "direct-active",
    );
    assert.equal(directState.unreadCount, 0);
    assert.equal(directState.unreadMentionCount, 0);
    assert.deepEqual(directState.activeMemberUserIds, ["user-a", "user-direct"]);
    assert.deepEqual(directState.currentPreference.mute, {
      muted: true,
      mutedUntil: "2030-02-01T00:00:00.000Z",
    });
    assert.equal(directState.currentPreference.isStarred, false);
    assert.deepEqual(
      organization.items.find(({ id }) => id === "group-active")
        .activeMemberUserIds,
      ["user-a", "user-group-b", "user-group-c"],
    );
    assert.deepEqual(
      organization.items.find(({ id }) => id === "entity-match")
        .activeMemberUserIds,
      [],
    );
    assert.deepEqual(
      organization.items.map(({ id, unreadMentionCount }) => ({
        id,
        unreadMentionCount,
      })),
      [
        { id: "private-active", unreadMentionCount: 2 },
        { id: "direct-active", unreadMentionCount: 0 },
        { id: "public-open", unreadMentionCount: 1 },
        { id: "public-left", unreadMentionCount: 0 },
        { id: "entity-match", unreadMentionCount: 0 },
        { id: "entity-other", unreadMentionCount: 0 },
        { id: "group-active", unreadMentionCount: 0 },
      ],
    );

    harness.calls.reset();
    const entityDatabase = countedDatabase(harness.pool);
    const entity = await runList(harness, entityDatabase.database, {
      scope: { type: "entity", entity: { type: "order", id: "42" } },
    });
    assert.equal(entityDatabase.count(), 1);
    assert.deepEqual(entity.items.map(({ id }) => id), ["entity-match"]);
    assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
    assert.deepEqual(
      harness.calls.all("permissions.authorizeEntity")[0].input,
      {
        actor: actorA.actor,
        entity: { type: "order", id: "42" },
        action: CONVERSATION_LIST_ENTITY_POLICY_ACTION,
      },
    );

    harness.setEntityAuthorization(false);
    harness.calls.reset();
    const deniedDatabase = countedDatabase(harness.pool);
    await assert.rejects(
      runList(harness, deniedDatabase.database, {
        scope: { type: "entity", entity: { type: "order", id: "42" } },
      }),
      (error) =>
        error instanceof ChatAuthorizationError &&
        error.code === CHAT_AUTHORIZATION_ERROR_CODE,
    );
    assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
    assert.equal(deniedDatabase.count(), 0);

    harness.calls.reset();
    const invalidDatabase = countedDatabase(harness.pool);
    await assert.rejects(
      runList(harness, invalidDatabase.database, {
        scope: { type: "organization" },
        limit: 101,
      }),
      /limit must be a safe integer between 1 and 100/,
    );
    await assert.rejects(
      runList(harness, invalidDatabase.database, {
        scope: { type: "organization" },
        cursor: "not-a-cursor",
      }),
      /cursor has an invalid envelope/,
    );
    assert.equal(invalidDatabase.count(), 0);
    assert.equal(harness.calls.count("permissions.authorizeEntity"), 0);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("conversation list active member projection is deterministically ordered and capped", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_list_member_cap",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const members = `${schema}.chat_conversation_members`;
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, created_at, updated_at)
       VALUES
         ('tenant-a', 'bounded-group', 'group_direct', 'private',
          '2030-01-01T08:00:00Z', '2030-01-01T10:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
       VALUES
         ('tenant-a', 'bounded-group', 'user-a', 'member', 'active',
          '2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
       SELECT
         'tenant-a',
         'bounded-group',
         'user-' || lpad(series::text, 3, '0'),
         'member',
         'active',
         '2030-01-01T08:00:00Z'::timestamptz,
         '2030-01-01T09:00:00Z'::timestamptz
       FROM generate_series(0, 104) AS series`,
    );

    const counted = countedDatabase(harness.pool);
    const result = await runList(harness, counted.database, {
      scope: { type: "organization" },
    });
    const expected = Array.from(
      { length: MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS },
      (_, index) => `user-${String(index).padStart(3, "0")}`,
    );

    assert.equal(counted.count(), 1);
    assert.deepEqual(result.items.map(({ id }) => id), ["bounded-group"]);
    assert.deepEqual(result.items[0].activeMemberUserIds, expected);
    assert.equal(Object.isFrozen(result.items[0].activeMemberUserIds), true);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("conversation list query paginates actor-private starred rows before activity-ordered rows", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB, actorSameTenant],
      schemaPrefix: "chat_list_pages",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const messages = `${schema}.chat_messages`;
    const members = `${schema}.chat_conversation_members`;
    const preferences = `${schema}.chat_conversation_preferences`;
    const huddleSessions = `${schema}.chat_huddle_sessions`;
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          current_message_sequence, created_at, updated_at)
       VALUES
         ('tenant-a', 'page-e', 'channel', 'public', 'E', 'pagination', 'fixture',
          1, '2030-01-01T08:00:00Z', '2030-01-01T12:00:00Z'),
         ('tenant-a', 'page-d', 'channel', 'public', 'D', 'pagination', 'fixture',
          0, '2030-01-01T08:00:00Z', '2030-01-01T11:00:00Z'),
         ('tenant-a', 'page-c', 'channel', 'public', 'C', 'pagination', 'fixture',
          1, '2030-01-01T08:00:00Z', '2030-01-01T11:00:00Z'),
         ('tenant-a', 'page-b', 'channel', 'public', 'B', 'pagination', 'fixture',
          1, '2030-01-01T08:00:00Z', '2030-01-01T11:00:00Z'),
         ('tenant-a', 'page-a', 'channel', 'public', 'A', 'pagination', 'fixture',
          1, '2030-01-01T08:00:00Z', '2030-01-01T10:00:00Z'),
         ('tenant-b', 'page-z', 'channel', 'public', 'Tenant B', 'pagination', 'fixture',
          1, '2030-01-01T08:00:00Z', '2030-01-02T12:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, created_at, updated_at, deleted_at,
          deleted_by_user_id)
       VALUES
         ('tenant-a', 'page-e-mention', 'page-e', 1, 'user-other',
          'page-e-mention-client',
          '{"format":"plain","text":"Mention","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:00:00Z', '2030-01-01T08:00:00Z', NULL, NULL),
         ('tenant-a', 'page-c-conversation', 'page-c', 1, 'user-other',
          'page-c-conversation-client',
          '{"format":"plain","text":"Conversation","mentions":[{"type":"conversation","conversationId":"user-a"}]}',
          '2030-01-01T08:00:00Z', '2030-01-01T08:00:00Z', NULL, NULL),
         ('tenant-a', 'page-b-deleted', 'page-b', 1, 'user-other',
          'page-b-deleted-client',
          '{"format":"plain","text":"Deleted","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:00:00Z', '2030-01-01T09:00:00Z',
          '2030-01-01T09:00:00Z', 'user-other'),
         ('tenant-a', 'page-a-mention', 'page-a', 1, 'user-other',
          'page-a-mention-client',
          '{"format":"plain","text":"Mention","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:00:00Z', '2030-01-01T08:00:00Z', NULL, NULL),
         ('tenant-b', 'page-z-cross-tenant', 'page-z', 1, 'user-b',
          'page-z-cross-tenant-client',
          '{"format":"plain","text":"Other tenant","mentions":[{"type":"user","userId":"user-a"}]}',
          '2030-01-01T08:00:00Z', '2030-01-01T08:00:00Z', NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'page-e', 'user-page-e', 'member', 'active'),
         ('tenant-a', 'page-c', 'user-page-c', 'member', 'active'),
         ('tenant-a', 'page-c', 'user-a', 'member', 'active'),
         ('tenant-a', 'page-a', 'user-a', 'member', 'active'),
         ('tenant-a', 'page-d', 'user-same-tenant', 'member', 'active'),
         ('tenant-a', 'page-b', 'user-same-tenant', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${preferences}
         (tenant_id, conversation_id, user_id, notification_level, is_starred,
          muted, created_at, updated_at)
       VALUES
         ('tenant-a', 'page-c', 'user-a', 'all', true, false,
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'page-a', 'user-a', 'all', true, false,
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'page-d', 'user-same-tenant', 'all', true, false,
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'page-b', 'user-same-tenant', 'all', true, false,
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${huddleSessions}
         (tenant_id, id, conversation_id, provider_room_reference,
          initiated_by_user_id, started_at, updated_at)
       VALUES
         ('tenant-a', 'huddle-page-e', 'page-e', 'private-page-e-room',
          'user-page-e', '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'),
         ('tenant-a', 'huddle-page-c', 'page-c', 'private-page-c-room',
          'user-page-c', '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z')`,
    );

    const counted = countedDatabase(harness.pool);
    const scope = {
      type: "entity",
      entity: { type: "pagination", id: "fixture" },
    };
    const first = await runList(harness, counted.database, { scope, limit: 2 });
    const second = await runList(harness, counted.database, {
      scope,
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await runList(harness, counted.database, {
      scope,
      limit: 2,
      cursor: second.nextCursor,
    });

    assert.deepEqual(first.items.map(({ id }) => id), ["page-c", "page-a"]);
    assert.deepEqual(second.items.map(({ id }) => id), ["page-e", "page-d"]);
    assert.deepEqual(third.items.map(({ id }) => id), ["page-b"]);
    assert.deepEqual(first.items.map(({ unreadMentionCount }) => unreadMentionCount), [0, 1]);
    assert.deepEqual(second.items.map(({ unreadMentionCount }) => unreadMentionCount), [1, 0]);
    assert.deepEqual(third.items.map(({ unreadMentionCount }) => unreadMentionCount), [0]);
    assert.deepEqual(first.items.map(({ hasActiveHuddle }) => hasActiveHuddle), [true, false]);
    assert.deepEqual(second.items.map(({ hasActiveHuddle }) => hasActiveHuddle), [true, false]);
    assert.deepEqual(third.items.map(({ hasActiveHuddle }) => hasActiveHuddle), [false]);
    assert.deepEqual(decodeConversationSnapshotCursor(first.nextCursor), {
      isStarred: true,
      navigationRank: CONVERSATION_NAVIGATION_RANK.publicChannel,
      activityAt: "2030-01-01T10:00:00.000000Z",
      conversationId: "page-a",
    });
    assert.equal(third.nextCursor, undefined);

    const allIds = [...first.items, ...second.items, ...third.items].map(
      ({ id }) => id,
    );
    assert.deepEqual(allIds, ["page-c", "page-a", "page-e", "page-d", "page-b"]);
    assert.equal(new Set(allIds).size, allIds.length);
    assert.deepEqual(
      [...first.items, ...second.items, ...third.items].map(
        ({ currentPreference }) => currentPreference.isStarred,
      ),
      [true, true, false, false, false],
    );

    const sameTenantActorResult = await queryConversationList({
      database: harness.pool,
      permissions: harness.adapters.permissions,
      actor: actorSameTenant.actor,
      input: { scope: { type: "organization" }, limit: 10 },
      schema: harness.schema,
    });
    assert.deepEqual(
      sameTenantActorResult.items.map(({ id }) => id),
      ["page-d", "page-b", "page-e", "page-c", "page-a"],
    );
    assert.deepEqual(
      sameTenantActorResult.items.map(
        ({ currentPreference }) => currentPreference.isStarred,
      ),
      [true, true, false, false, false],
    );

    const legacyStart = encodeLegacyConversationSnapshotCursor({
      activityAt: "2031-01-01T00:00:00.000Z",
      conversationId: "legacy-start",
    });
    const legacyFirst = await runList(harness, harness.pool, {
      scope: { type: "organization" },
      limit: 2,
      cursor: legacyStart,
    });
    const legacySecond = await runList(harness, harness.pool, {
      scope: { type: "organization" },
      limit: 2,
      cursor: legacyFirst.nextCursor,
    });
    const legacyThird = await runList(harness, harness.pool, {
      scope: { type: "organization" },
      limit: 2,
      cursor: legacySecond.nextCursor,
    });
    assert.deepEqual(
      [...legacyFirst.items, ...legacySecond.items, ...legacyThird.items].map(
        ({ id }) => id,
      ),
      ["page-e", "page-d", "page-c", "page-b", "page-a"],
    );
    assert.match(legacyFirst.nextCursor, /^handrail-conversations\.v1\./);
    assert.match(legacySecond.nextCursor, /^handrail-conversations\.v1\./);
    assert.equal(legacyThird.nextCursor, undefined);

    const malformedV2 = `handrail-conversations.v2.${encodeURIComponent(
      JSON.stringify([true, "2030-01-01T10:00:00.000Z"]),
    )}`;
    await assert.rejects(
      () =>
        runList(harness, harness.pool, {
          scope: { type: "organization" },
          cursor: malformedV2,
        }),
      (error) => error?.code === "malformed_cursor",
    );

    assert.equal(counted.count(), 3);
    assert.equal(harness.calls.count("permissions.authorizeEntity"), 3);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("conversation list v3 paging keeps actor-private stars and direct-first navigation ranks stable", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB, actorSameTenant],
      schemaPrefix: "chat_list_rank_pages",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const members = `${schema}.chat_conversation_members`;
    const preferences = `${schema}.chat_conversation_preferences`;
    const tiedActivityAt = "2030-01-01T10:00:00.000Z";

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          created_at, updated_at)
       VALUES
         ('tenant-a', 'star-direct-b', 'direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-direct-a', 'direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-public-b', 'channel', 'public', 'Star public B', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-public-a', 'channel', 'public', 'Star public A', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-private-b', 'channel', 'private', 'Star private B', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-private-a', 'channel', 'private', 'Star private A', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-group-b', 'group_direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'star-group-a', 'group_direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-direct-b', 'direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-direct-a', 'direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-public-b', 'channel', 'public', 'Plain public B', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-public-a', 'channel', 'public', 'Plain public A', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-private-b', 'channel', 'private', 'Plain private B', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-private-a', 'channel', 'private', 'Plain private A', 'pagination', 'rank-fixture',
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-group-b', 'group_direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}'),
         ('tenant-a', 'plain-group-a', 'group_direct', 'private', NULL, NULL, NULL,
          '2030-01-01T08:00:00Z', '${tiedActivityAt}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       SELECT 'tenant-a', visible_conversation.id, visible_actor.id, 'member', 'active'
       FROM (VALUES
         ('star-direct-b'), ('star-direct-a'),
         ('star-public-b'), ('star-public-a'),
         ('star-private-b'), ('star-private-a'),
         ('star-group-b'), ('star-group-a'),
         ('plain-direct-b'), ('plain-direct-a'),
         ('plain-public-b'), ('plain-public-a'),
         ('plain-private-b'), ('plain-private-a'),
         ('plain-group-b'), ('plain-group-a')
       ) AS visible_conversation(id)
       CROSS JOIN (VALUES ('user-a'), ('user-same-tenant')) AS visible_actor(id)`,
    );
    await harness.pool.query(
      `INSERT INTO ${preferences}
         (tenant_id, conversation_id, user_id, notification_level, is_starred,
          muted, created_at, updated_at)
       SELECT 'tenant-a', actor_star.conversation_id, actor_star.user_id,
              'all', true, false,
              '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z'
       FROM (VALUES
         ('star-direct-b', 'user-a'), ('star-direct-a', 'user-a'),
         ('star-public-b', 'user-a'), ('star-public-a', 'user-a'),
         ('star-private-b', 'user-a'), ('star-private-a', 'user-a'),
         ('star-group-b', 'user-a'), ('star-group-a', 'user-a'),
         ('plain-direct-b', 'user-same-tenant'), ('plain-direct-a', 'user-same-tenant'),
         ('plain-public-b', 'user-same-tenant'), ('plain-public-a', 'user-same-tenant'),
         ('plain-private-b', 'user-same-tenant'), ('plain-private-a', 'user-same-tenant'),
         ('plain-group-b', 'user-same-tenant'), ('plain-group-a', 'user-same-tenant')
       ) AS actor_star(conversation_id, user_id)`,
    );

    const navigationRank = (item) => {
      if (item.type === "direct") return CONVERSATION_NAVIGATION_RANK.direct;
      if (item.type === "group_direct") {
        return CONVERSATION_NAVIGATION_RANK.groupDirect;
      }
      return item.visibility === "public"
        ? CONVERSATION_NAVIGATION_RANK.publicChannel
        : CONVERSATION_NAVIGATION_RANK.privateChannel;
    };
    const collectV3CursorChain = async (actor, scope) => {
      const pages = [];
      let cursor;

      do {
        const page = await queryConversationList({
          database: harness.pool,
          permissions: harness.adapters.permissions,
          actor,
          input: { scope, limit: 3, ...(cursor === undefined ? {} : { cursor }) },
          schema: harness.schema,
        });
        pages.push(page);
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          assert.match(cursor, /^handrail-conversations\.v3\./);
          assert.equal(
            "navigationRank" in decodeConversationSnapshotCursor(cursor),
            true,
          );
        }
        assert.ok(pages.length <= 16, "v3 cursor chain must terminate");
      } while (cursor !== undefined);

      return pages;
    };
    const assertCompleteStableOrdering = (pages, expectedIds) => {
      const items = pages.flatMap(({ items }) => items);
      const ids = items.map(({ id }) => id);
      assert.equal(items.length, expectedIds.length);
      assert.equal(new Set(ids).size, expectedIds.length);
      assert.deepEqual([...ids].sort(), [...expectedIds].sort());
      assert.deepEqual(ids, expectedIds);
      assert.deepEqual(
        items.map(({ updatedAt }) => updatedAt),
        Array.from({ length: items.length }, () => tiedActivityAt),
      );

      let reachedUnstarred = false;
      const ranksByStarBucket = { starred: [], unstarred: [] };
      for (const item of items) {
        const starred = item.currentPreference.isStarred;
        if (!starred) reachedUnstarred = true;
        assert.equal(starred && reachedUnstarred, false);
        ranksByStarBucket[starred ? "starred" : "unstarred"].push(
          navigationRank(item),
        );
      }
      for (const ranks of Object.values(ranksByStarBucket)) {
        assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right));
      }

      return items;
    };
    const assertTieCrossesPageBoundary = (pages, beforeId, afterId) => {
      assert.equal(
        pages.some(
          (page, index) =>
            page.items.at(-1)?.id === beforeId &&
            pages[index + 1]?.items[0]?.id === afterId,
        ),
        true,
      );
    };
    const starredFirst = [
      "star-direct-b",
      "star-direct-a",
      "star-public-b",
      "star-public-a",
      "star-private-b",
      "star-private-a",
      "star-group-b",
      "star-group-a",
    ];
    const plainSecond = [
      "plain-direct-b",
      "plain-direct-a",
      "plain-public-b",
      "plain-public-a",
      "plain-private-b",
      "plain-private-a",
      "plain-group-b",
      "plain-group-a",
    ];

    const organizationPages = await collectV3CursorChain(actorA.actor, {
      type: "organization",
    });
    const organizationItems = assertCompleteStableOrdering(
      organizationPages,
      [...starredFirst, ...plainSecond],
    );
    assertTieCrossesPageBoundary(
      organizationPages,
      "star-public-b",
      "star-public-a",
    );

    const sameTenantPages = await collectV3CursorChain(
      actorSameTenant.actor,
      { type: "organization" },
    );
    const sameTenantItems = assertCompleteStableOrdering(sameTenantPages, [
      ...plainSecond,
      ...starredFirst,
    ]);
    assert.equal(
      organizationItems.find(({ id }) => id === "star-direct-b")
        .currentPreference.isStarred,
      true,
    );
    assert.equal(
      sameTenantItems.find(({ id }) => id === "star-direct-b")
        .currentPreference.isStarred,
      false,
    );
    assert.equal(
      sameTenantItems.find(({ id }) => id === "plain-direct-b")
        .currentPreference.isStarred,
      true,
    );

    const entityPages = await collectV3CursorChain(actorA.actor, {
      type: "entity",
      entity: { type: "pagination", id: "rank-fixture" },
    });
    assertCompleteStableOrdering(entityPages, [
      "star-public-b",
      "star-public-a",
      "star-private-b",
      "star-private-a",
      "plain-public-b",
      "plain-public-a",
      "plain-private-b",
      "plain-private-a",
    ]);
    assertTieCrossesPageBoundary(
      entityPages,
      "star-private-b",
      "star-private-a",
    );
  } finally {
    const schemaName = harness?.schema;
    try {
      await harness?.teardown();
      if (schemaName !== undefined) {
        assert.equal(await backend.schemaExists(schemaName), false);
      }
    } finally {
      await backend.teardown();
    }
  }
});
