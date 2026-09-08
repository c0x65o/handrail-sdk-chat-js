import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_SEARCH_ENTITY_POLICY_ACTION,
  MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
  ChatAuthorizationError,
  MessageSearchQueryError,
  queryMessageSearch,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorA = {
  credential: "message-search-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
};

const actorB = {
  credential: "message-search-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["employee"],
  },
};

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const seedSearch = async (harness) => {
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const messages = `${schema}.chat_messages`;

  await harness.pool.query(
    `INSERT INTO ${conversations}
       (tenant_id, id, type, visibility, name, entity_type, entity_id,
        archived_at, archived_by_user_id)
     VALUES
       ('tenant-a', 'public-ranked', 'channel', 'public', 'Ranked', NULL, NULL, NULL, NULL),
       ('tenant-a', 'public-ties', 'channel', 'public', 'Ties', NULL, NULL, NULL, NULL),
       ('tenant-a', 'public-entity-allow', 'channel', 'public', 'Allowed entity', 'order', 'allow', NULL, NULL),
       ('tenant-a', 'public-entity-deny', 'channel', 'public', 'Denied entity', 'order', 'deny', NULL, NULL),
       ('tenant-a', 'public-entity-throw', 'channel', 'public', 'Throw entity', 'order', 'throw', NULL, NULL),
       ('tenant-a', 'private-active', 'channel', 'private', 'Private active', NULL, NULL, NULL, NULL),
       ('tenant-a', 'private-left', 'channel', 'private', 'Private left', NULL, NULL, NULL, NULL),
       ('tenant-a', 'private-none', 'channel', 'private', 'Private none', NULL, NULL, NULL, NULL),
       ('tenant-a', 'archived', 'channel', 'public', 'Archived', NULL, NULL, '2030-01-02T00:00:00Z', 'user-a'),
       ('tenant-b', 'tenant-b-public', 'channel', 'public', 'Other tenant', NULL, NULL, NULL, NULL)`,
  );
  await harness.pool.query(
    `INSERT INTO ${members}
       (tenant_id, conversation_id, user_id, role, state)
     VALUES
       ('tenant-a', 'private-active', 'user-a', 'member', 'active'),
       ('tenant-a', 'private-left', 'user-a', 'member', 'left'),
       ('tenant-b', 'tenant-b-public', 'user-b', 'member', 'active')`,
  );
  await harness.pool.query(
    `INSERT INTO ${messages}
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, created_at, updated_at)
     VALUES
       ('tenant-a', 'rank-high', 'public-ranked', 1, 'author-a', 'client-rank-high',
        '{"format":"markdown","text":"**Nebula** nebula nebula launch"}',
        '2030-01-01T00:01:00Z', '2030-01-01T00:01:00Z'),
       ('tenant-a', 'tie-z', 'public-ties', 1, 'author-b', 'client-tie-z',
        '{"format":"plain","text":"Nebula release"}',
        '2030-01-01T00:05:00Z', '2030-01-01T00:05:00Z'),
       ('tenant-a', 'tie-a', 'public-ties', 2, 'author-a', 'client-tie-a',
        '{"format":"plain","text":"Nebula release"}',
        '2030-01-01T00:05:00Z', '2030-01-01T00:05:00Z'),
       ('tenant-a', 'allowed-hit', 'public-entity-allow', 1, 'author-c', 'client-allowed',
        '{"format":"plain","text":"Nebula allowed entity"}',
        '2030-01-01T00:04:00Z', '2030-01-01T00:04:00Z'),
       ('tenant-a', 'denied-hit', 'public-entity-deny', 1, 'author-c', 'client-denied',
        '{"format":"plain","text":"Nebula denied secret"}',
        '2030-01-01T00:06:00Z', '2030-01-01T00:06:00Z'),
       ('tenant-a', 'throw-hit', 'public-entity-throw', 1, 'author-c', 'client-throw',
        '{"format":"plain","text":"Policythrow confidential"}',
        '2030-01-01T00:07:00Z', '2030-01-01T00:07:00Z'),
       ('tenant-a', 'private-active-hit', 'private-active', 1, 'author-a', 'client-private-active',
        '{"format":"plain","text":"Visibilityprobe active"}',
        '2030-01-01T00:08:00Z', '2030-01-01T00:08:00Z'),
       ('tenant-a', 'private-left-hit', 'private-left', 1, 'author-a', 'client-private-left',
        '{"format":"plain","text":"Visibilityprobe left"}',
        '2030-01-01T00:09:00Z', '2030-01-01T00:09:00Z'),
       ('tenant-a', 'private-none-hit', 'private-none', 1, 'author-a', 'client-private-none',
        '{"format":"plain","text":"Visibilityprobe none"}',
        '2030-01-01T00:10:00Z', '2030-01-01T00:10:00Z'),
       ('tenant-a', 'archived-hit', 'archived', 1, 'author-a', 'client-archived',
        '{"format":"plain","text":"Visibilityprobe archived"}',
        '2030-01-01T00:11:00Z', '2030-01-01T00:11:00Z'),
       ('tenant-b', 'tenant-b-hit', 'tenant-b-public', 1, 'author-b', 'client-tenant-b',
        '{"format":"plain","text":"Visibilityprobe other tenant"}',
        '2030-01-01T00:12:00Z', '2030-01-01T00:12:00Z'),
       ('tenant-a', 'deleted-hit', 'public-ranked', 2, 'author-a', 'client-deleted',
        '{"format":"plain","text":"Visibilityprobe deleted"}',
        '2030-01-01T00:13:00Z', '2030-01-01T00:13:00Z'),
       ('tenant-a', 'forwarded-hit', 'public-ranked', 3, 'forwarding-user', 'client-forwarded',
        '{"format":"plain","text":"Attributionprobe analytical engine","forwarded":{"sourceMessageId":"source-message","originalAuthor":{"userId":"ada-user","displayName":"Ada Lovelace"},"originalCreatedAt":"2030-01-01T00:00:00.000Z"}}',
        '2030-01-01T00:15:00Z', '2030-01-01T00:15:00Z')`,
  );
  await harness.pool.query(
    `UPDATE ${messages}
     SET content = NULL,
         deleted_at = '2030-01-01T00:14:00Z',
         deleted_by_user_id = 'author-a',
         updated_at = '2030-01-01T00:14:00Z'
     WHERE tenant_id = 'tenant-a' AND id = 'deleted-hit'`,
  );
};

const seedBudgetSearch = async (harness, threads = false) => {
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const messages = `${schema}.chat_messages`;
  const deniedConversationCount = 17;
  const deniedMessageCount = MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT * 2 + 1;

  await harness.pool.query(
    `INSERT INTO ${conversations}
       (tenant_id, id, type, visibility, name, entity_type, entity_id,
        archived_at, archived_by_user_id)
     SELECT
       'tenant-a',
       'budget-denied-' || candidate,
       'channel',
       'public',
       'Budget denied ' || candidate,
       'budget',
       'deny-' || candidate,
       NULL::timestamptz,
       NULL
     FROM generate_series(0, $1::integer - 1) AS candidate
     UNION ALL
     VALUES
       ('tenant-a', 'budget-allowed', 'channel', 'public', 'Budget allowed', NULL, NULL, NULL::timestamptz, NULL)`,
    [deniedConversationCount],
  );
  if (threads) {
    await harness.pool.query(`INSERT INTO ${messages}
      (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
      SELECT tenant_id, id || '-root', id, 1, 'author-budget', id || '-root',
        '{"format":"plain","text":"Root context"}'::jsonb
      FROM ${conversations} WHERE tenant_id = 'tenant-a' AND id LIKE 'budget-%'`);
    await harness.pool.query(`INSERT INTO ${conversations}
      (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id)
      SELECT tenant_id, id || '-thread', 'thread', 'private', name, id, id || '-root'
      FROM ${conversations} WHERE tenant_id = 'tenant-a' AND id LIKE 'budget-%'`);
  }
  await harness.pool.query(
    `INSERT INTO ${messages}
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, created_at, updated_at)
     SELECT
       'tenant-a',
       'budget-denied-message-' || lpad(candidate::text, 6, '0'),
       'budget-denied-' || ((candidate - 1) % $2::integer) || $3::text,
       ((candidate - 1) / $2::integer) + 1,
       'author-budget',
       'client-budget-denied-' || candidate,
       jsonb_build_object('format', 'plain', 'text', 'Budgetprobe'),
       '2031-01-01T00:00:00Z'::timestamptz + ($1::integer - candidate) * interval '1 second',
       '2031-01-01T00:00:00Z'::timestamptz + ($1::integer - candidate) * interval '1 second'
     FROM generate_series(1, $1::integer) AS candidate`,
    [deniedMessageCount, deniedConversationCount, threads ? "-thread" : ""],
  );
  await harness.pool.query(
    `INSERT INTO ${messages}
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content, created_at, updated_at)
     VALUES
       ('tenant-a', 'budget-allowed-leading', $1, 1, 'author-budget',
        'client-budget-allowed-leading', '{"format":"plain","text":"Budgetprobe"}',
        '2032-01-01T00:00:00Z', '2032-01-01T00:00:00Z'),
       ('tenant-a', 'budget-allowed-trailing-a', $1, 2, 'author-budget',
        'client-budget-allowed-trailing-a', '{"format":"plain","text":"Budgetprobe"}',
        '2030-01-01T00:00:02Z', '2030-01-01T00:00:02Z'),
       ('tenant-a', 'budget-allowed-trailing-b', $1, 3, 'author-budget',
        'client-budget-allowed-trailing-b', '{"format":"plain","text":"Budgetprobe"}',
        '2030-01-01T00:00:01Z', '2030-01-01T00:00:01Z')`,
    [threads ? 'budget-allowed-thread' : 'budget-allowed'],
  );
};

const createCandidateTrackingDatabase = (database) => {
  const batches = [];
  const queries = [];
  return {
    batches,
    queries,
    database: {
      async query(text, values) {
        queries.push(text);
        const result = await database.query(text, values);
        if (text.includes("WITH search_input AS")) {
          batches.push({
            limit: values.at(-1),
            messageIds: result.rows.map(({ message_id: messageId }) => messageId),
          });
        }
        return result;
      },
    },
  };
};

const createPermissions = () => {
  const calls = [];
  return {
    calls,
    adapter: {
      async authorizeEntity(input) {
        calls.push(input);
        if (input.entity.id === "throw") {
          throw new Error("sensitive host policy failure");
        }
        return input.entity.id !== "deny";
      },
    },
  };
};

const runSearch = (
  harness,
  permissions,
  input,
  actor = actorA.actor,
  database = harness.pool,
) =>
  queryMessageSearch({
    database,
    permissions,
    actor,
    input,
    schema: harness.schema,
  });

test("PostgreSQL message search ranks deterministically and paginates after authorization filtering", async () => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_message_search",
    });
    await seedSearch(harness);
    const permissions = createPermissions();

    const all = await runSearch(harness, permissions.adapter, {
      query: "nebula",
      pageSize: 100,
    });
    assert.deepEqual(all.hits.map(({ messageId }) => messageId), [
      "rank-high",
      "tie-z",
      "tie-a",
      "allowed-hit",
    ]);
    assert.deepEqual(all.hits[0], {
      type: "message",
      conversationId: "public-ranked",
      messageId: "rank-high",
      title: "Ranked",
      snippet: "Nebula nebula nebula launch",
      authorUserId: "author-a",
      sentAt: "2030-01-01T00:01:00.000Z",
    });
    assert.equal(all.nextCursor, undefined);

    const forwarded = await runSearch(harness, permissions.adapter, {
      query: "attributionprobe",
      pageSize: 10,
    });
    assert.deepEqual(forwarded.hits, [{
      type: "message",
      conversationId: "public-ranked",
      messageId: "forwarded-hit",
      title: "Ranked",
      snippet: "Attributionprobe analytical engine",
      authorUserId: "forwarding-user",
      authorDisplayName: "Ada Lovelace",
      sentAt: "2030-01-01T00:15:00.000Z",
    }]);
    assert.deepEqual(
      permissions.calls.map(({ entity, action }) => ({ entity, action })),
      [
        { entity: { type: "order", id: "deny" }, action: MESSAGE_SEARCH_ENTITY_POLICY_ACTION },
        { entity: { type: "order", id: "allow" }, action: MESSAGE_SEARCH_ENTITY_POLICY_ACTION },
      ],
    );

    const seen = [];
    let cursor;
    do {
      const page = await runSearch(harness, permissions.adapter, {
        query: "nebula",
        pageSize: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.hits.map(({ messageId }) => messageId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    assert.deepEqual(seen, ["rank-high", "tie-z", "tie-a", "allowed-hit"]);
    assert.equal(new Set(seen).size, seen.length);

    const first = await runSearch(harness, permissions.adapter, {
      query: "nebula",
      pageSize: 1,
    });
    assert.equal(typeof first.nextCursor, "string");
    for (const [input, actor] of [
      [{ query: "visibilityprobe", pageSize: 1, cursor: first.nextCursor }, actorA.actor],
      [{ query: "nebula", pageSize: 1, cursor: first.nextCursor }, { ...actorA.actor, tenantId: "tenant-b" }],
      [{ query: "nebula", pageSize: 1, cursor: first.nextCursor }, { ...actorA.actor, userId: "user-other" }],
      [{ query: "nebula", filters: { conversationIds: ["public-ranked"] }, pageSize: 1, cursor: first.nextCursor }, actorA.actor],
      [{ query: "nebula", filters: { authorUserIds: ["author-a"] }, pageSize: 1, cursor: first.nextCursor }, actorA.actor],
      [{ query: "nebula", filters: { sentAfter: "2029-01-01T00:00:00.000Z" }, pageSize: 1, cursor: first.nextCursor }, actorA.actor],
      [{ query: "nebula", filters: { sentBefore: "2031-01-01T00:00:00.000Z" }, pageSize: 1, cursor: first.nextCursor }, actorA.actor],
    ]) {
      await assert.rejects(
        runSearch(harness, permissions.adapter, input, actor),
        (error) => error instanceof MessageSearchQueryError && error.code === "invalid_cursor",
      );
    }
    await runSearch(harness, permissions.adapter, {
      query: "  nebula  ",
      pageSize: 1,
      cursor: first.nextCursor,
    });

    await assertBudgetSearch(harness);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("PostgreSQL message search enforces visibility, tenant/deletion boundaries, filters, and entity failure policy", async () => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_search_policy",
    });
    await seedSearch(harness);
    const permissions = createPermissions();

    const visibility = await runSearch(harness, permissions.adapter, {
      query: "visibilityprobe",
      pageSize: 100,
    });
    assert.deepEqual(visibility.hits.map(({ messageId }) => messageId), [
      "private-active-hit",
    ]);

    assert.deepEqual(
      (await runSearch(harness, permissions.adapter, {
        query: "nebula",
        filters: { conversationIds: ["public-ties"] },
        pageSize: 100,
      })).hits.map(({ messageId }) => messageId),
      ["tie-z", "tie-a"],
    );
    assert.deepEqual(
      (await runSearch(harness, permissions.adapter, {
        query: "nebula",
        filters: { authorUserIds: ["author-a"] },
        pageSize: 100,
      })).hits.map(({ messageId }) => messageId),
      ["rank-high", "tie-a"],
    );
    assert.deepEqual(
      (await runSearch(harness, permissions.adapter, {
        query: "nebula",
        filters: {
          sentAfter: "2030-01-01T00:01:00.000Z",
          sentBefore: "2030-01-01T00:05:00.000Z",
        },
        pageSize: 100,
      })).hits.map(({ messageId }) => messageId),
      ["allowed-hit"],
    );
    assert.deepEqual(
      (await runSearch(harness, permissions.adapter, {
        query: "nebula",
        filters: { conversationIds: [] },
        pageSize: 100,
      })).hits,
      [],
    );

    assert.deepEqual(
      (await runSearch(harness, permissions.adapter, {
        query: "denied secret",
        pageSize: 10,
      })).hits,
      [],
    );
    await assert.rejects(
      runSearch(harness, permissions.adapter, {
        query: "policythrow",
        pageSize: 10,
      }),
      ChatAuthorizationError,
    );
    for (const conversationId of [
      "public-entity-deny",
      "public-entity-throw",
      "private-left",
      "private-none",
      "archived",
      "tenant-b-public",
      "missing",
    ]) {
      await assert.rejects(
        runSearch(harness, permissions.adapter, {
          query: "nebula",
          filters: { conversationIds: [conversationId] },
          pageSize: 10,
        }),
        ChatAuthorizationError,
      );
    }

    const tenantB = await runSearch(
      harness,
      permissions.adapter,
      { query: "visibilityprobe", pageSize: 100 },
      actorB.actor,
    );
    assert.deepEqual(tenantB.hits.map(({ messageId }) => messageId), ["tenant-b-hit"]);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

const assertBudgetSearch = async (harness, threads = false) => {
  await seedBudgetSearch(harness, threads);
  const tracked = createCandidateTrackingDatabase(harness.pool);
  const authorizationCalls = [];
  const budgetPermissions = {
    async authorizeEntity(input) {
      authorizationCalls.push(input);
      return !input.entity.id.startsWith("deny-");
    },
  };
  const pages = [];
  const scannedMessageIds = [];
  const candidateCounts = [];
  const authorizationCallCounts = [];
  let budgetCursor;
  do {
    const batchStart = tracked.batches.length;
    const queryStart = tracked.queries.length;
    const callStart = authorizationCalls.length;
    const page = await runSearch(
      harness,
      budgetPermissions,
      {
        query: "budgetprobe",
        pageSize: 33,
        ...(budgetCursor === undefined ? {} : { cursor: budgetCursor }),
      },
      actorA.actor,
      tracked.database,
    );
    const requestBatches = tracked.batches.slice(batchStart);
    assert.equal(tracked.queries.length - queryStart, requestBatches.length,
      "parent authorization adds no per-thread or per-message SQL");
    assert.ok(requestBatches.length <= 10);
    const requestMessageIds = requestBatches.flatMap(({ messageIds }) => messageIds);
    const requestCalls = authorizationCalls.slice(callStart);
    assert.ok(requestMessageIds.length <= MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT);
    assert.ok(requestBatches.every(({ limit }) => Number.isInteger(limit) && limit > 0));
    assert.ok(
      requestBatches.reduce((total, { limit }) => total + limit, 0) <=
        MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
    );
    assert.equal(
      new Set(requestCalls.map(({ entity }) => `${entity.type}:${entity.id}`)).size,
      requestCalls.length,
    );
    assert.ok(requestCalls.length <= MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT);
    pages.push(page);
    scannedMessageIds.push(...requestMessageIds);
    candidateCounts.push(requestMessageIds.length);
    authorizationCallCounts.push(requestCalls.length);
    budgetCursor = page.nextCursor;
  } while (budgetCursor !== undefined);

  assert.deepEqual(pages.map((page) => page.hits.map(({ messageId }) => messageId)), [
    ["budget-allowed-leading"],
    [],
    ["budget-allowed-trailing-a", "budget-allowed-trailing-b"],
  ]);
  assert.ok(pages[0].nextCursor);
  assert.ok(pages[1].nextCursor);
  assert.equal(pages[2].nextCursor, undefined);
  assert.deepEqual(candidateCounts, [
    MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
    MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT,
    4,
  ]);
  assert.deepEqual(authorizationCallCounts, [17, 17, 2]);
  assert.equal(scannedMessageIds.length, MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT * 2 + 4);
  assert.equal(new Set(scannedMessageIds).size, scannedMessageIds.length);
};

test("PostgreSQL thread search retains scan budgets and continuation through denied-only pages", async () => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await createChatTestHarness({ backend, actors: [actorA], schemaPrefix: "chat_search_thread_scan" });
    await assertBudgetSearch(harness, true);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("PostgreSQL named-thread search uses current parent access independently of participation", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await createChatTestHarness({ backend, actors: [actorA, actorB], schemaPrefix: "chat_search_parent" });
    const prefix = quoteIdentifier(harness.schema);
    const sql = (text, values) => harness.pool.query(text, values);
    await sql(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id, id, type, visibility, name, created_at, updated_at)
      VALUES ('tenant-a', 'parent', 'channel', 'public', 'Parent', '2001-01-01', '2001-01-01')`);
    await sql(`INSERT INTO ${prefix}.chat_messages
      (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
      VALUES ('tenant-a', 'root', 'parent', 1, 'author-a', 'root',
        '{"format":"plain","text":"Rootcontextonly"}')`);
    await sql(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id, created_at, updated_at)
      VALUES ('tenant-a', 'named-thread', 'thread', 'private', 'Launch date', 'parent', 'root',
        '2001-01-01', '2001-01-01')`);
    await sql(`INSERT INTO ${prefix}.chat_messages
      (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content,
       reply_to_message_id, reply_notify_author, created_at, updated_at)
      VALUES ('tenant-a', 'thread-hit-a', 'named-thread', 1, 'author-a', 'thread-hit-a',
        '{"format":"plain","text":"Threadprobe sourcewordonly"}', NULL, false, '2001-01-01', '2001-01-01'),
      ('tenant-a', 'thread-hit-b', 'named-thread', 2, 'author-a', 'thread-hit-b',
        '{"format":"plain","text":"Threadprobe reply"}', 'thread-hit-a', false, '2001-01-01', '2001-01-01')`);
    const expected = ["thread-hit-b", "thread-hit-a"];
    const permissions = createPermissions();
    const member = (id, state = "active") => sql(`INSERT INTO ${prefix}.chat_conversation_members
      (tenant_id, conversation_id, user_id, role, state) VALUES ('tenant-a', $1, 'user-a', 'member', $2)
      ON CONFLICT (tenant_id, conversation_id, user_id) DO UPDATE SET state = EXCLUDED.state`, [id, state]);
    const state = async () => {
      const result = {};
      for (const table of ["chat_conversation_members", "chat_thread_follows", "chat_conversation_preferences", "chat_read_cursors"]) {
        result[table] = (await sql(`SELECT to_jsonb(row) AS value FROM ${prefix}.${table} AS row
          ORDER BY tenant_id, conversation_id, user_id`)).rows;
      }
      return result;
    };
    const search = (filtered, extra = {}, database = harness.pool) => runSearch(harness, permissions.adapter, {
      query: "threadprobe", pageSize: 10,
      ...(filtered ? { filters: { conversationIds: ["named-thread"] } } : {}), ...extra,
    }, actorA.actor, database);
    const readable = async () => {
      const before = await state();
      const connection = await harness.pool.connect();
      try {
        await connection.query("BEGIN READ ONLY");
        for (const filtered of [false, true]) {
          const tracked = createCandidateTrackingDatabase(connection);
          const callStart = permissions.calls.length;
          const result = await search(filtered, {}, tracked.database);
          assert.deepEqual(result.hits.map(hit => hit.messageId), expected);
          assert.ok(result.hits.every(hit => hit.conversationId === "named-thread" && hit.title === "Launch date"));
          assert.equal(result.nextCursor, undefined);
          assert.equal(tracked.queries.length, filtered ? 2 : 1);
          assert.ok(permissions.calls.length - callStart <= 1,
            "entity authorization is reused across messages and filtered preflight");
          const first = await search(filtered, { pageSize: 1 }, tracked.database);
          assert.deepEqual(first.hits.map(hit => hit.messageId), [expected[0]]);
          assert.ok(first.nextCursor);
          const second = await search(filtered, { pageSize: 1, cursor: first.nextCursor }, tracked.database);
          assert.deepEqual(second.hits.map(hit => hit.messageId), [expected[1]]);
          assert.equal(second.nextCursor, undefined);
        }
        await connection.query("COMMIT");
      } finally { connection.release(); }
      assert.deepEqual(await state(), before, "reads preserve participation, follows, preferences and cursors");
    };
    const denied = async () => {
      assert.deepEqual((await search(false)).hits, []);
      await assert.rejects(search(true), ChatAuthorizationError);
    };

    await t.test("no child participation preserves named thread destinations in filtered and unfiltered search", async () => {
      await readable();
      assert.ok(Object.values(await state()).every(rows => rows.length === 0));
      assert.deepEqual((await search(true, { query: "rootcontextonly" })).hits, []);
      assert.deepEqual((await search(true, { query: "sourcewordonly" })).hits.map(hit => hit.messageId), ["thread-hit-a"],
        "a reply does not index the referenced message's text");
      assert.deepEqual((await runSearch(harness, permissions.adapter, { query: "threadprobe", pageSize: 10 }, actorB.actor)).hits, []);
    });

    await t.test("explicit unfollow retains search access and all private user state", async () => {
      await member("named-thread");
      await sql(`INSERT INTO ${prefix}.chat_thread_follows
        (tenant_id, conversation_id, user_id, is_following, follow_source, follow_revision)
        VALUES ('tenant-a', 'named-thread', 'user-a', false, 'manual', 1)`);
      await readable();
    });

    await t.test("private parent revocation overrides a retained active child row", async () => {
      await sql(`UPDATE ${prefix}.chat_conversations SET visibility = 'private' WHERE id = 'parent'`);
      await member("parent");
      await readable();
      for (const parentState of ["left", "removed"]) {
        await member("parent", parentState);
        await denied();
      }
      await sql(`DELETE FROM ${prefix}.chat_conversation_members WHERE conversation_id = 'parent'`);
      await denied();
      assert.equal((await sql(`SELECT state FROM ${prefix}.chat_conversation_members WHERE conversation_id = 'named-thread'`)).rows[0].state, "active");
      await member("parent");
      await readable();
      // Direct and group-direct parents use the same active-parent membership rule.
      for (const type of ["direct", "group_direct"]) {
        await sql(`UPDATE ${prefix}.chat_conversations SET type = $1, name = NULL WHERE id = 'parent'`, [type]);
        await readable();
        await member("parent", "left");
        await denied();
        await member("parent");
      }
      await sql(`UPDATE ${prefix}.chat_conversations SET type = 'channel', visibility = 'public', name = 'Parent' WHERE id = 'parent'`);
    });

    await t.test("current parent entity metadata governs denial and sanitized host errors", async () => {
      // Child entity columns remain NULL while the parent acquires a current host entity.
      await sql(`UPDATE ${prefix}.chat_conversations SET entity_type = 'order', entity_id = 'allow' WHERE id = 'parent'`);
      await readable();
      assert.ok(permissions.calls.every(call => call.entity.type === "order" && call.entity.id === "allow" && call.action === MESSAGE_SEARCH_ENTITY_POLICY_ACTION));
      for (const entityId of ["deny", "throw"]) {
        await sql(`UPDATE ${prefix}.chat_conversations SET entity_id = $1 WHERE id = 'parent'`, [entityId]);
        const start = permissions.calls.length;
        if (entityId === "deny") await denied();
        else for (const filtered of [false, true]) {
          await assert.rejects(search(filtered), error => error instanceof ChatAuthorizationError &&
            error.message === "Chat authorization failed" && error.cause === undefined);
        }
        assert.deepEqual(permissions.calls.slice(start).map(call => call.entity.id), [entityId, entityId]);
      }
      await sql(`UPDATE ${prefix}.chat_conversations SET entity_type = NULL, entity_id = NULL WHERE id = 'parent'`);
    });

    await t.test("old inactive and closed or locked history remains searchable; administrative archives do not", async () => {
      // Inactivity hiding is derived from last activity by discovery's host policy;
      // it has no persisted hidden flag. This history has been inactive since 2001.
      await readable();
      for (const locked of [false, true]) {
        await sql(`UPDATE ${prefix}.chat_conversations SET closed_at = '2002-01-01', closed_by_user_id = 'admin',
          locked = $1, lifecycle_revision = lifecycle_revision + 1, updated_at = '2002-01-01'
          WHERE id = 'named-thread'`, [locked]);
        await readable();
      }
      for (const id of ["named-thread", "parent"]) {
        await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = '2003-01-01', archived_by_user_id = 'admin',
          updated_at = '2003-01-01' WHERE id = $1`, [id]);
        await denied();
        await sql(`UPDATE ${prefix}.chat_conversations SET archived_at = NULL, archived_by_user_id = NULL WHERE id = $1`, [id]);
      }
      await readable();
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
