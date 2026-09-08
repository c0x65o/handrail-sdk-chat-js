import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import {
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  queryMessageTimeline,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";
import {
  selectRootThreadFacts,
  selectRootThreadSummary,
} from "../dist/server/thread-summary-query.js";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;
const tenantId = "tenant-shared-facts";
const parentId = "parent-channel";
const threadId = "root-thread";
const viewer = { tenantId, userId: "viewer-a", roles: [] };
let backend;
let harness;
let schema;

before(async () => {
  backend = await createPostgresTestBackend();
});
after(async () => {
  await backend?.teardown();
});
afterEach(async () => {
  await harness?.teardown();
});
beforeEach(async () => {
  harness = await backend.createHarness({ schemaPrefix: "chat_thread_facts" });
  schema = quoteIdentifier(harness.schema);
  await createPostgresMigrationRunner({
    database: harness.pool,
    schema: harness.schema,
    migrations: handrailChatPostgresMigrations,
  }).apply();
  await seedThread();
});

const seedThread = async (tenantId = viewer.tenantId) => {
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversations
       (tenant_id, id, type, visibility, name, current_message_sequence)
     VALUES ($1, $2, 'channel', 'private', 'Parent channel', 1)`,
    [tenantId, parentId],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_messages
       (tenant_id, id, conversation_id, sequence, author_user_id,
        client_message_id, content)
     VALUES ($1, 'root-message', $2, 1, 'root-author', 'client-root',
             '{"format":"plain","text":"Thread root"}'::jsonb)`,
    [tenantId, parentId],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversations
       (tenant_id, id, type, visibility, parent_conversation_id, root_message_id)
     VALUES ($1, $2, 'thread', 'private', $3, 'root-message')`,
    [tenantId, threadId, parentId],
  );
};

const seedReplies = async (tenantId = viewer.tenantId) => {
  // The latest reply is soft-deleted; it must still contribute all shared facts.
  for (const [id, sequence, author, createdAt, deletedAt] of [
    ["reply-first", 1, "author-a", "2026-08-20T10:00:00.000Z", null],
    ["reply-repeat", 2, "author-a", "2026-08-20T10:01:00.000Z", null],
    ["reply-deleted", 3, "author-b", "2026-08-20T10:02:00.123Z", "2026-08-20T10:03:00.000Z"],
  ]) {
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_messages
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, created_at, updated_at,
          deleted_at, deleted_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $2, $6, $7, $8, $9, $10)`,
      [tenantId, id, threadId, sequence, author,
        deletedAt === null ? { format: "plain", text: id } : null,
        createdAt, deletedAt ?? createdAt, deletedAt,
        deletedAt === null ? null : author],
    );
  }
  await harness.pool.query(
    `UPDATE ${schema}.chat_conversations SET current_message_sequence = 3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, threadId],
  );
};

test("empty thread returns only shared zero facts without a viewer cursor", async () => {
  const expected = { threadId, replyCount: 0, participantIds: [] };
  const facts = await selectRootThreadFacts(harness.pool, schema, tenantId, threadId);
  assert.deepEqual(facts, expected);
  assert.equal(Object.hasOwn(facts, "unreadCount"), false);
  assert.equal(Object.hasOwn(facts, "lastReplyAt"), false);
  assert.deepEqual((await harness.pool.query(
    `SELECT * FROM ${schema}.chat_read_cursors`,
  )).rows, []);

  // Negative control: the combined selector cannot replace the shared selector.
  const connection = await harness.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `SELECT id FROM ${schema}.chat_conversations
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, threadId],
    );
    const combined = await selectRootThreadSummary(connection, schema, viewer, threadId);
    assert.deepEqual(combined, { ...expected, unreadCount: 0 });
    assert.notDeepEqual(combined, facts);
  } finally {
    try {
      await connection.query("ROLLBACK");
    } finally {
      connection.release();
    }
  }
});

test("persisted shared facts include deleted replies and ignore viewer read state", async () => {
  await seedReplies();
  const facts = await selectRootThreadFacts(harness.pool, schema, tenantId, threadId);
  assert.deepEqual(facts, {
    threadId,
    replyCount: 3,
    participantIds: ["author-a", "author-b"],
    lastReplyAt: "2026-08-20T10:02:00.123Z",
  });
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversation_members
       (tenant_id, conversation_id, user_id, role, state)
     VALUES ($1, $2, 'viewer-a', 'member', 'active'),
            ($1, $2, 'viewer-b', 'member', 'active')`,
    [tenantId, threadId],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_read_cursors
       (tenant_id, conversation_id, user_id, last_read_sequence)
     VALUES ($1, $2, 'viewer-a', 3), ($1, $2, 'viewer-b', 2)`,
    [tenantId, threadId],
  );
  assert.deepEqual(
    await selectRootThreadFacts(harness.pool, schema, tenantId, threadId), facts,
  );
  await harness.pool.query(
    `UPDATE ${schema}.chat_read_cursors
     SET manual_unread_from_sequence = CASE user_id WHEN 'viewer-a' THEN 2 ELSE 1 END
     WHERE tenant_id = $1 AND conversation_id = $2`,
    [tenantId, threadId],
  );
  assert.deepEqual(
    await selectRootThreadFacts(harness.pool, schema, tenantId, threadId), facts,
  );
});

test("wrong tenant and missing thread reject without returning seeded facts", async () => {
  await seedReplies();
  for (const [requestedTenant, requestedThread] of [
    ["wrong-tenant", threadId],
    [tenantId, "missing-thread"],
  ]) {
    await assert.rejects(
      selectRootThreadFacts(harness.pool, schema, requestedTenant, requestedThread),
      { name: "Error", message: "Thread facts could not be loaded" },
    );
  }
});

// Parent authorization is independent of whether this viewer is eligible for
// thread unread enrichment. There are no entity policies or attachments here.
const seedViewer = async (actor, { state = "active", following = false, lastRead } = {}) => {
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_conversation_members
       (tenant_id, conversation_id, user_id, role, state)
     VALUES ($1, $2, $3, 'member', 'active'), ($1, $4, $3, 'member', $5)`,
    [actor.tenantId, parentId, actor.userId, threadId, state],
  );
  await harness.pool.query(
    `INSERT INTO ${schema}.chat_thread_follows
       (tenant_id, conversation_id, user_id, is_following)
     VALUES ($1, $2, $3, $4)`,
    [actor.tenantId, threadId, actor.userId, following],
  );
  if (lastRead !== undefined) {
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_read_cursors
         (tenant_id, conversation_id, user_id, last_read_sequence)
       VALUES ($1, $2, $3, $4)`,
      [actor.tenantId, threadId, actor.userId, lastRead],
    );
  }
};

const viewerRows = async (database) => {
  const rows = {};
  for (const table of ["chat_read_cursors", "chat_conversation_members", "chat_thread_follows"]) {
    rows[table] = (await database.query(
      `SELECT * FROM ${schema}.${table} ORDER BY tenant_id, conversation_id, user_id`,
    )).rows;
  }
  return rows;
};

const assertViewerParity = async (actor, unreadCount, expectedFacts) => {
  const before = await viewerRows(harness.pool);
  const connection = await harness.pool.connect();
  let combined;
  try {
    // Honor the wrapper's lock contract and keep both reads on one snapshot.
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await connection.query(
      `SELECT id FROM ${schema}.chat_conversations
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [actor.tenantId, threadId],
    );
    const page = await queryMessageTimeline({
      database: connection,
      schema: harness.schema,
      actor,
      input: { conversationId: parentId, direction: "backward", limit: 10 },
      permissions: { authorizeEntity: async () => assert.fail("Unexpected entity policy") },
      storage: { createDownloadUrl: async () => assert.fail("Unexpected attachment") },
    });
    assert.equal(page.messages.length, 1);
    const root = page.messages[0];
    assert.equal(root.id, "root-message");
    assert.equal(root.tenantId, actor.tenantId);
    assert.deepEqual(root.threadSummary, { ...expectedFacts, unreadCount }, "timeline unread and facts");
    combined = await selectRootThreadSummary(connection, schema, actor, threadId);
    assert.deepEqual(combined, { ...expectedFacts, unreadCount }, "wrapper unread and facts");
    assert.deepEqual(combined, root.threadSummary, "wrapper/timeline parity");
    const facts = await selectRootThreadFacts(connection, schema, actor.tenantId, threadId);
    assert.deepEqual(facts, expectedFacts);
    assert.equal(Object.hasOwn(facts, "unreadCount"), false);
    assert.notDeepEqual(facts, combined);
    assert.deepEqual(await viewerRows(connection), before, "selection must not write viewer state");
    await connection.query("COMMIT");
  } finally {
    try {
      await connection.query("ROLLBACK");
    } finally {
      connection.release();
    }
  }
  assert.deepEqual(await viewerRows(harness.pool), before, "no committed viewer state changes");
  return combined;
};

test("viewer cursors and manual unread remain user- and tenant-isolated with timeline parity", async () => {
  await seedReplies();
  const otherViewer = { ...viewer, userId: "viewer-b" };
  const otherTenant = { ...viewer, tenantId: "tenant-other" };
  await seedViewer(viewer, { lastRead: 1 });
  await seedViewer(otherViewer, { lastRead: 3 });
  // Colliding conversation/message/user IDs in another tenant, with a distinct
  // cursor and empty thread, must not affect either unread or shared facts.
  await seedThread(otherTenant.tenantId);
  await seedViewer(otherTenant, { lastRead: 0 });
  const facts = await selectRootThreadFacts(harness.pool, schema, tenantId, threadId);
  const checkViewers = async (expectedB) => {
    const a = await assertViewerParity(viewer, 2, facts);
    const b = await assertViewerParity(otherViewer, expectedB, facts);
    const { unreadCount: unreadA, ...factsA } = a;
    const { unreadCount: unreadB, ...factsB } = b;
    assert.deepEqual(factsA, factsB);
    assert.notEqual(unreadA, unreadB);
    await assertViewerParity(otherTenant, 0, { threadId, replyCount: 0, participantIds: [] });
  };
  await checkViewers(0);
  await harness.pool.query(
    `UPDATE ${schema}.chat_read_cursors SET manual_unread_from_sequence = 1
     WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, threadId, otherViewer.userId],
  );
  await checkViewers(3);
  await harness.pool.query(
    `UPDATE ${schema}.chat_read_cursors SET manual_unread_from_sequence = NULL
     WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, threadId, otherViewer.userId],
  );
  await checkViewers(0);
});

describe("cursor presence does not determine viewer eligibility", () => {
  for (const { name, options, unreadCount } of [
    { name: "eligible viewer without a cursor gets all three persisted replies unread", options: {}, unreadCount: 3 },
    { name: "inactive nonfollowing viewer with a retained cursor gets zero unread", options: { state: "left", lastRead: 1 }, unreadCount: 0 },
  ]) {
    test(name, async () => {
      await seedReplies();
      await seedViewer(viewer, options);
      const facts = await selectRootThreadFacts(harness.pool, schema, tenantId, threadId);
      await assertViewerParity(viewer, unreadCount, facts);
    });
  }
});

test("active membership OR following preserves unread eligibility until neither remains", async () => {
  await seedReplies();
  await seedViewer(viewer, { following: true, lastRead: 1 });
  const facts = await selectRootThreadFacts(harness.pool, schema, tenantId, threadId);
  await assertViewerParity(viewer, 2, facts);
  await harness.pool.query(
    `UPDATE ${schema}.chat_thread_follows SET is_following = false
     WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, threadId, viewer.userId],
  );
  await assertViewerParity(viewer, 2, facts); // Unfollow while still active.
  await harness.pool.query(
    `UPDATE ${schema}.chat_thread_follows SET is_following = true
     WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, threadId, viewer.userId],
  );
  await harness.pool.query(
    `UPDATE ${schema}.chat_conversation_members SET state = 'left'
     WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, threadId, viewer.userId],
  );
  await assertViewerParity(viewer, 2, facts); // Membership lost while following.
  await harness.pool.query(
    `UPDATE ${schema}.chat_thread_follows SET is_following = false
     WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [tenantId, threadId, viewer.userId],
  );
  await assertViewerParity(viewer, 0, facts);
});
