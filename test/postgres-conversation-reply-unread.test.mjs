import assert from "node:assert/strict";
import test from "node:test";

import {
  queryConversationDetail,
  queryConversationList,
  updateReadCursor,
} from "@handrail/chat/server";
import { createChatTestHarness, createPostgresTestBackend } from "@handrail/chat/testing";

const actor = { tenantId: "tenant-a", userId: "alice", roles: [] };
const mention = { type: "user", userId: "alice" };

test("detail and list count eligible reply pings as unread read facts", async (t) => {
  const backend = await createPostgresTestBackend();
  t.diagnostic(`PostgreSQL backend: ${backend.kind}`);
  let harness;
  try {
    harness = await createChatTestHarness({
      backend,
      actors: [{ credential: "alice", actor }],
      schemaPrefix: "reply_unread",
    });
    const prefix = `"${harness.schema.replaceAll('"', '""')}"`;
    const messages = `${prefix}.chat_messages`;
    const options = {
      database: harness.pool,
      permissions: harness.adapters.permissions,
      actor,
      schema: harness.schema,
    };
    const seedConversation = async (id, tenant = "tenant-a", sequence = 2) => {
      await harness.pool.query(
        `INSERT INTO ${prefix}.chat_conversations
           (tenant_id, id, type, visibility, name, current_message_sequence)
         VALUES ($1, $2, 'channel', 'public', $2, $3)`,
        [tenant, id, sequence],
      );
      await harness.pool.query(
        `INSERT INTO ${prefix}.chat_conversation_members
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ($1, $2, 'alice', 'member', 'active')`,
        [tenant, id],
      );
    };
    const seedMessage = async ({
      conversation, id, sequence, author = "bob", tenant = "tenant-a",
      source = null, ping = false, deleted = false,
      content = { format: "plain", text: id },
    }) => {
      await harness.pool.query(
        `INSERT INTO ${messages}
           (tenant_id, conversation_id, id, sequence, author_user_id,
            client_message_id, content, reply_to_message_id, reply_notify_author,
            deleted_at, deleted_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $3, $6, $7, $8,
           CASE WHEN $9 THEN '2026-01-01'::timestamptz END,
           CASE WHEN $9 THEN $5 END, '2026-01-01', '2026-01-01')`,
        [tenant, conversation, id, sequence, author, content, source, ping, deleted],
      );
    };
    const assertCounts = async (conversationId, mentions, unread = 2) => {
      const detail = await queryConversationDetail({ ...options, input: { conversationId } });
      const list = await queryConversationList({
        ...options, input: { scope: { type: "organization" }, limit: 100 },
      });
      const item = list.items.find(({ id }) => id === conversationId);
      assert.ok(item, `list contains ${conversationId}`);
      assert.equal(detail.unreadMentionCount, mentions, `${conversationId}: detail mentions`);
      assert.equal(item.unreadMentionCount, mentions, `${conversationId}: list mentions`);
      assert.equal(item.unreadCount, unread, `${conversationId}: total unread`);
      return { detail, item };
    };
    const cases = [
      { id: "ping-on", ping: true, expected: 1 },
      { id: "ping-off", ping: false, expected: 0 },
      { id: "legacy", legacy: true, expected: 0 },
      { id: "self-reply", ping: true, author: "alice", expected: 0 },
      { id: "self-explicit", ping: true, author: "alice", mentions: [mention], expected: 1 },
      { id: "dedup", ping: true, mentions: [mention, mention], expected: 1 },
      { id: "explicit-off", ping: false, mentions: [mention], expected: 1 },
      { id: "deleted-source", ping: true, sourceDeleted: true, expected: 0 },
      { id: "explicit-deleted-source", ping: true, sourceDeleted: true, mentions: [mention], expected: 1 },
      { id: "deleted-reply", ping: true, deleted: true, mentions: [mention], expected: 0 },
      { id: "other-source-author", ping: true, sourceAuthor: "carol", expected: 0 },
      { id: "non-user-mention", ping: false, mentions: [{ type: "conversation", conversationId: "alice" }], expected: 0 },
    ];
    for (const scenario of cases) {
      await t.test(scenario.id, async () => {
        await seedConversation(scenario.id);
        await seedMessage({
          conversation: scenario.id, id: `${scenario.id}-source`, sequence: 1,
          author: scenario.sourceAuthor ?? "alice", deleted: scenario.sourceDeleted,
        });
        await seedMessage({
          conversation: scenario.id, id: `${scenario.id}-reply`, sequence: 2,
          source: scenario.legacy ? null : `${scenario.id}-source`,
          ping: scenario.ping, author: scenario.author, deleted: scenario.deleted,
          content: { format: "plain", text: "Reply", ...(scenario.mentions ? { mentions: scenario.mentions } : {}) },
        });
        await assertCounts(scenario.id, scenario.expected);
      });
    }

    await t.test("source deletion changes only the synthetic contribution", async () => {
      await assertCounts("ping-on", 1);
      await assertCounts("dedup", 1);
      await harness.pool.query(
        `UPDATE ${messages} SET deleted_at = now(), updated_at = now(), deleted_by_user_id = 'alice'
         WHERE tenant_id = 'tenant-a' AND id IN ('ping-on-source', 'dedup-source', 'explicit-off-source')`,
      );
      await assertCounts("ping-on", 0);
      await assertCounts("dedup", 1);
      await assertCounts("explicit-off", 1);
    });

    await t.test("tenant and conversation isolation with enforced source foreign keys", async () => {
      await seedConversation("isolation");
      await seedConversation("isolation", "tenant-b");
      // Identical message IDs across tenants must resolve to the local author.
      for (const tenant of ["tenant-a", "tenant-b"]) {
        await seedMessage({ conversation: "isolation", tenant, id: "same-source", sequence: 1, author: tenant === "tenant-a" ? "carol" : "alice" });
        await seedMessage({ conversation: "isolation", tenant, id: "same-reply", sequence: 2, source: "same-source", ping: true });
      }
      await assertCounts("isolation", 0);
      const otherTenant = await queryConversationDetail({ ...options, actor: { ...actor, tenantId: "tenant-b" }, input: { conversationId: "isolation" } });
      assert.equal(otherTenant.unreadMentionCount, 1);
      await seedConversation("isolated-empty", "tenant-a", 0);
      for (const source of ["missing-source", "dedup-source"]) {
        await assert.rejects(
          seedMessage({ conversation: "isolated-empty", id: "invalid-reply", sequence: 1, source, ping: true }),
          (error) => error.code === "23503" && error.constraint === "chat_messages_reply_source_fkey",
        );
      }
      await seedMessage({ conversation: "isolation", tenant: "tenant-b", id: "tenant-b-only-source", sequence: 3, author: "alice" });
      await assert.rejects(
        seedMessage({ conversation: "isolated-empty", id: "invalid-reply", sequence: 1, source: "tenant-b-only-source", ping: true }),
        (error) => error.code === "23503" && error.constraint === "chat_messages_reply_source_fkey",
      );
      await assertCounts("isolated-empty", 0, 0);
    });

    await t.test("mark-read boundaries, manual-unread restoration, and preferences", async () => {
      await seedConversation("read-boundary", "tenant-a", 4);
      await seedMessage({ conversation: "read-boundary", id: "read-source", sequence: 1, author: "alice" });
      for (const sequence of [2, 3, 4]) {
        await seedMessage({ conversation: "read-boundary", id: `read-reply-${sequence}`, sequence, source: "read-source", ping: true });
      }
      const storedBefore = (await harness.pool.query(`SELECT id, content FROM ${messages} ORDER BY tenant_id, id`)).rows;
      await assertCounts("read-boundary", 3, 4);
      for (const level of ["none", "mentions", "all"]) {
        await harness.pool.query(
          `INSERT INTO ${prefix}.chat_conversation_preferences
             (tenant_id, conversation_id, user_id, notification_level, muted)
           VALUES ('tenant-a', 'read-boundary', 'alice', $1, true)
           ON CONFLICT (tenant_id, conversation_id, user_id)
           DO UPDATE SET notification_level = EXCLUDED.notification_level`, [level],
        );
        const { detail, item } = await assertCounts("read-boundary", 3, 4);
        assert.equal(detail.currentPreference.mute.muted, true);
        assert.equal(item.currentPreference.notificationPreference, level);
      }
      const mutate = (input) => updateReadCursor({ ...options, input: { conversationId: "read-boundary", ...input } });
      await mutate({ operation: "mark_read", throughSequence: 2, idempotencyKey: "read-through-2" });
      await assertCounts("read-boundary", 2, 2);
      await mutate({ operation: "mark_read", throughSequence: 4, idempotencyKey: "read-through-4" });
      await assertCounts("read-boundary", 0, 0);
      await mutate({ operation: "mark_unread", fromSequence: 2, idempotencyKey: "restore-from-2" });
      await assertCounts("read-boundary", 3, 3);
      await mutate({ operation: "mark_read", throughSequence: 4, idempotencyKey: "clear-manual" });
      await assertCounts("read-boundary", 0, 0);
      assert.deepEqual((await harness.pool.query(`SELECT id, content FROM ${messages} ORDER BY tenant_id, id`)).rows, storedBefore);
      assert.equal(harness.calls.count("notifications.send"), 0);
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
