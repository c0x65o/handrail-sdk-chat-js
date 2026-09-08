import assert from "node:assert/strict";
import test from "node:test";

import {
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
} from "@handrail/chat/server";
import { createPostgresTestBackend } from "@handrail/chat/testing";

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const findIndexes = (plan, indexes = []) => {
  if (plan && typeof plan === "object") {
    if (typeof plan["Index Name"] === "string") {
      indexes.push(plan["Index Name"]);
    }
    for (const value of Object.values(plan)) {
      findIndexes(value, indexes);
    }
  }
  return indexes;
};

test("huddle migration persists tenant-safe lifecycle and participant history", async (t) => {
  const backend = await createPostgresTestBackend();
  const harness = await backend.createHarness({ schemaPrefix: "chat_huddles" });
  const schema = quoteIdentifier(harness.schema);
  const conversations = `${schema}.chat_conversations`;
  const members = `${schema}.chat_conversation_members`;
  const sessions = `${schema}.chat_huddle_sessions`;
  const participants = `${schema}.chat_huddle_participants`;

  const createSession = ({
    tenantId = "tenant-a",
    id = "huddle-a",
    conversationId = "conversation-a",
    roomReference = `opaque-room-${id}`,
    initiatorUserId = "user-alice",
    startedAt = "2030-01-01T00:00:00Z",
  } = {}) =>
    harness.pool.query(
      `INSERT INTO ${sessions}
         (tenant_id, id, conversation_id, provider_room_reference,
          initiated_by_user_id, started_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING *`,
      [
        tenantId,
        id,
        conversationId,
        roomReference,
        initiatorUserId,
        startedAt,
      ],
    );

  try {
    const runner = createPostgresMigrationRunner({
      database: harness.pool,
      schema: harness.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const applied = await runner.apply();

    assert.deepEqual(
      applied.applied.map(({ id, order }) => ({ id, order })),
      [
        { id: "0001-chat-conversations-membership", order: 1 },
        { id: "0002-chat-messages-revisions", order: 2 },
        { id: "0003-chat-reactions", order: 3 },
        { id: "0004-chat-read-cursors", order: 4 },
        { id: "0005-chat-outbox-events", order: 5 },
        { id: "0006-chat-idempotency-keys", order: 6 },
        { id: "0007-chat-drafts", order: 7 },
        { id: "0008-chat-conversation-preferences", order: 8 },
        { id: "0009-chat-thread-follows", order: 9 },
        { id: "0010-chat-attachments", order: 10 },
        { id: "0011-chat-audit-events", order: 11 },
        { id: "0012-chat-saved-messages", order: 12 },
        { id: "0013-chat-huddle-sessions", order: 13 },
        { id: "0014-chat-notification-deliveries", order: 14 },
        { id: "0015-chat-conversation-lifecycle-revision", order: 15 },
        { id: "0016-chat-thread-follow-revision", order: 16 },
        { id: "0017-chat-conversation-member-list-revision", order: 17 },
        { id: "0018-chat-conversation-preference-revision", order: 18 },
        { id: "0019-chat-saved-message-mutation-state", order: 19 },
        { id: "0020-chat-huddle-participant-leave-reason", order: 20 },
        { id: "0021-chat-huddle-ending-recovery", order: 21 },
        { id: "0022-chat-device-push-tokens", order: 22 },
        { id: "0023-chat-conversation-list-ordering", order: 23 },
        { id: "0024-chat-outbox-unpublished-stream-heads", order: 24 },
        { id: "0025-chat-outbox-tenant-replay-positions", order: 25 },
        { id: "0026-chat-notification-global-claim-indexes", order: 26 },
        { id: "0027-chat-notification-materializer-offsets", order: 27 },
        { id: "0028-chat-outbox-expiry-cleanup", order: 28 },
        { id: "0029-chat-message-search-vector", order: 29 },
      ],
    );

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name)
       VALUES
         ('tenant-a', 'conversation-a', 'channel', 'private', 'Tenant A'),
         ('tenant-b', 'conversation-b', 'channel', 'private', 'Tenant B')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'conversation-a', 'user-alice', 'member', 'active'),
         ('tenant-a', 'conversation-a', 'user-bob', 'member', 'active'),
         ('tenant-b', 'conversation-b', 'user-beth', 'member', 'active')`,
    );

    await t.test("creates and finishes a contract-shaped session", async () => {
      const starting = (await createSession()).rows[0];
      assert.deepEqual(
        {
          status: starting.status,
          roomReference: starting.provider_room_reference,
          activatedAt: starting.activated_at,
          endedAt: starting.ended_at,
          screenShareOwner: starting.active_screen_share_owner_user_id,
        },
        {
          status: "starting",
          roomReference: "opaque-room-huddle-a",
          activatedAt: null,
          endedAt: null,
          screenShareOwner: null,
        },
      );

      await harness.pool.query(
        `INSERT INTO ${participants}
           (tenant_id, huddle_session_id, user_id, joined_at)
         VALUES
           ('tenant-a', 'huddle-a', 'user-alice', '2030-01-01T00:00:01Z'),
           ('tenant-a', 'huddle-a', 'user-bob', '2030-01-01T00:00:02Z')`,
      );
      await harness.pool.query(
        `UPDATE ${sessions}
         SET status = 'active',
             activated_at = '2030-01-01T00:00:01Z',
             active_screen_share_owner_user_id = 'user-alice',
             updated_at = '2030-01-01T00:00:01Z'
         WHERE tenant_id = 'tenant-a' AND id = 'huddle-a'`,
      );

      await assert.rejects(
        harness.pool.query(
          `UPDATE ${participants}
           SET left_at = '2030-01-01T00:01:00Z'
           WHERE tenant_id = 'tenant-a'
             AND huddle_session_id = 'huddle-a'
             AND user_id = 'user-alice'`,
        ),
        (error) =>
          error?.code === "23514" &&
          error.constraint ===
            "chat_huddle_participants_active_screen_share_owner_check",
      );
      await harness.pool.query(
        `UPDATE ${sessions}
         SET status = 'ending',
             ended_by_user_id = 'user-alice',
             updated_at = '2030-01-01T00:01:00Z'
         WHERE tenant_id = 'tenant-a' AND id = 'huddle-a'`,
      );
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${sessions}
           SET status = 'ended',
               active_screen_share_owner_user_id = NULL,
               ended_at = '2030-01-01T00:02:00Z',
               updated_at = '2030-01-01T00:02:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'huddle-a'`,
        ),
        (error) =>
          error?.code === "23514" &&
          error.constraint === "chat_huddle_sessions_ended_participants_check",
      );

      await harness.pool.query(
        `UPDATE ${sessions}
         SET active_screen_share_owner_user_id = NULL,
             updated_at = '2030-01-01T00:01:00Z'
         WHERE tenant_id = 'tenant-a' AND id = 'huddle-a'`,
      );
      await harness.pool.query(
        `UPDATE ${participants}
         SET left_at = CASE user_id
           WHEN 'user-alice' THEN '2030-01-01T00:01:00Z'::timestamptz
           ELSE '2030-01-01T00:02:00Z'::timestamptz
         END
         WHERE tenant_id = 'tenant-a' AND huddle_session_id = 'huddle-a'`,
      );
      const ended = (
        await harness.pool.query(
          `UPDATE ${sessions}
           SET status = 'ended',
               ended_at = '2030-01-01T00:02:00Z',
               updated_at = '2030-01-01T00:02:00Z'
           WHERE tenant_id = 'tenant-a' AND id = 'huddle-a'
           RETURNING status, ended_at, ended_by_user_id,
                     active_screen_share_owner_user_id`,
        )
      ).rows[0];

      assert.deepEqual(
        {
          status: ended.status,
          endedAt: ended.ended_at.toISOString(),
          endedBy: ended.ended_by_user_id,
          screenShareOwner: ended.active_screen_share_owner_user_id,
        },
        {
          status: "ended",
          endedAt: "2030-01-01T00:02:00.000Z",
          endedBy: "user-alice",
          screenShareOwner: null,
        },
      );
    });

    await t.test("rejects concurrent live and cross-tenant relationships", async () => {
      await createSession({ id: "huddle-current", startedAt: "2030-01-02T00:00:00Z" });
      await assert.rejects(
        createSession({ id: "huddle-conflict", startedAt: "2030-01-02T00:00:01Z" }),
        /chat_huddle_sessions_active_conversation_idx/,
      );

      await assert.rejects(
        createSession({
          tenantId: "tenant-b",
          id: "huddle-cross-tenant",
          conversationId: "conversation-a",
          initiatorUserId: "user-beth",
        }),
        (error) =>
          error?.code === "23503" &&
          [
            "chat_huddle_sessions_conversation_fkey",
            "chat_huddle_sessions_initiator_membership_fkey",
          ].includes(error.constraint),
      );
      await assert.rejects(
        harness.pool.query(
          `INSERT INTO ${participants}
             (tenant_id, huddle_session_id, user_id, joined_at)
           VALUES
             ('tenant-b', 'huddle-current', 'user-beth',
              '2030-01-02T00:00:01Z')`,
        ),
        /chat_huddle_participants_session_fkey/,
      );
    });

    await t.test("requires an actively joined exclusive screen-share owner", async () => {
      await assert.rejects(
        harness.pool.query(
          `UPDATE ${sessions}
           SET active_screen_share_owner_user_id = 'user-bob',
               updated_at = '2030-01-02T00:00:01Z'
           WHERE tenant_id = 'tenant-a' AND id = 'huddle-current'`,
        ),
        (error) =>
          error?.code === "23514" &&
          error.constraint ===
            "chat_huddle_sessions_active_screen_share_owner_check",
      );

      await harness.pool.query(
        `INSERT INTO ${participants}
           (tenant_id, huddle_session_id, user_id, joined_at)
         VALUES
           ('tenant-a', 'huddle-current', 'user-alice',
            '2030-01-02T00:00:01Z')`,
      );
      const active = (
        await harness.pool.query(
          `UPDATE ${sessions}
           SET status = 'active',
               activated_at = '2030-01-02T00:00:01Z',
               active_screen_share_owner_user_id = 'user-alice',
               updated_at = '2030-01-02T00:00:01Z'
           WHERE tenant_id = 'tenant-a' AND id = 'huddle-current'
           RETURNING status, active_screen_share_owner_user_id`,
        )
      ).rows[0];
      assert.deepEqual(active, {
        status: "active",
        active_screen_share_owner_user_id: "user-alice",
      });
    });

    await t.test("preserves participant history after leave and session end", async () => {
      const rows = (
        await harness.pool.query(
          `SELECT user_id, joined_at, left_at
           FROM ${participants}
           WHERE tenant_id = 'tenant-a' AND huddle_session_id = 'huddle-a'
           ORDER BY joined_at, user_id`,
        )
      ).rows;
      assert.deepEqual(
        rows.map(({ user_id, joined_at, left_at }) => ({
          userId: user_id,
          joinedAt: joined_at.toISOString(),
          leftAt: left_at.toISOString(),
        })),
        [
          {
            userId: "user-alice",
            joinedAt: "2030-01-01T00:00:01.000Z",
            leftAt: "2030-01-01T00:01:00.000Z",
          },
          {
            userId: "user-bob",
            joinedAt: "2030-01-01T00:00:02.000Z",
            leftAt: "2030-01-01T00:02:00.000Z",
          },
        ],
      );

      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${participants}
           WHERE tenant_id = 'tenant-a' AND huddle_session_id = 'huddle-a'`,
        ),
        /chat_huddle_participants are retained as history/,
      );
      await assert.rejects(
        harness.pool.query(
          `DELETE FROM ${sessions}
           WHERE tenant_id = 'tenant-a' AND id = 'huddle-a'`,
        ),
        /chat_huddle_sessions are retained as history/,
      );
    });

    await t.test("stores no secret or media transport material", async () => {
      const columns = async (tableName) =>
        (
          await harness.pool.query(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2
             ORDER BY ordinal_position`,
            [harness.schema, tableName],
          )
        ).rows.map(({ column_name }) => column_name);

      assert.deepEqual(await columns("chat_huddle_sessions"), [
        "tenant_id",
        "id",
        "conversation_id",
        "provider_room_reference",
        "status",
        "initiated_by_user_id",
        "started_at",
        "activated_at",
        "ended_at",
        "ended_by_user_id",
        "active_screen_share_owner_user_id",
        "updated_at",
      ]);
      assert.deepEqual(await columns("chat_huddle_participants"), [
        "tenant_id",
        "huddle_session_id",
        "user_id",
        "joined_at",
        "left_at",
      ]);
    });

    await t.test("uses active-conversation and participant-lookup indexes", async () => {
      const client = await harness.pool.connect();
      try {
        await client.query(`ANALYZE ${sessions}`);
        await client.query(`ANALYZE ${participants}`);
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");

        const activePlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT id, status, started_at, active_screen_share_owner_user_id
           FROM ${sessions}
           WHERE tenant_id = 'tenant-a'
             AND conversation_id = 'conversation-a'
             AND status IN ('starting', 'active')`,
        );
        const participantPlan = await client.query(
          `EXPLAIN (FORMAT JSON)
           SELECT user_id, joined_at, left_at
           FROM ${participants}
           WHERE tenant_id = 'tenant-a'
             AND huddle_session_id = 'huddle-a'
             AND joined_at >= '2030-01-01T00:00:00Z'
           ORDER BY joined_at, user_id`,
        );

        assert.ok(
          findIndexes(activePlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_huddle_sessions_active_conversation_idx",
          ),
        );
        assert.ok(
          findIndexes(participantPlan.rows[0]?.["QUERY PLAN"]).includes(
            "chat_huddle_participants_lookup_idx",
          ),
        );
      } finally {
        await client.query("RESET enable_bitmapscan").catch(() => undefined);
        await client.query("RESET enable_seqscan").catch(() => undefined);
        client.release();
      }
    });
  } finally {
    await harness.teardown().catch(() => undefined);
    await backend.teardown();
  }
});
