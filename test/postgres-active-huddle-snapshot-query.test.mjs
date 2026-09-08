import assert from "node:assert/strict";
import test from "node:test";

import { HuddleContractError } from "@handrail/chat";
import {
  ACTIVE_HUDDLE_ENTITY_POLICY_ACTION,
  CHAT_AUTHORIZATION_ERROR_CODE,
  ChatAuthorizationError,
  queryActiveHuddleSnapshot,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorA = {
  credential: "active-huddle-actor-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
};

const actorB = {
  credential: "active-huddle-actor-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-b",
    roles: ["employee"],
  },
};

const quoteIdentifier = (identifier) =>
  `"${identifier.replaceAll('"', '""')}"`;

const captureDatabase = (pool) => {
  const calls = [];
  return {
    database: {
      query(text, values) {
        calls.push({ text, values });
        return pool.query(text, values);
      },
      connect() {
        return pool.connect();
      },
    },
    calls,
  };
};

const authorizationShape = (error) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  statusCode: error.statusCode,
});

test("active-huddle snapshot is actor-scoped, canonical, and provider-secret-free", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_huddle_snapshot",
    });
    const schema = quoteIdentifier(harness.schema);
    const tables = {
      conversations: `${schema}.chat_conversations`,
      members: `${schema}.chat_conversation_members`,
      messages: `${schema}.chat_messages`,
      sessions: `${schema}.chat_huddle_sessions`,
      participants: `${schema}.chat_huddle_participants`,
    };

    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          current_message_sequence)
       VALUES
         ('tenant-a', 'public-inactive', 'channel', 'public', 'Public inactive', NULL, NULL, 0),
         ('tenant-a', 'public-starting', 'channel', 'public', 'Public starting', NULL, NULL, 0),
         ('tenant-a', 'private-active', 'channel', 'private', 'Private active', NULL, NULL, 0),
         ('tenant-a', 'thread-parent', 'channel', 'public', 'Entity parent', 'order', '42', 1),
         ('tenant-a', 'private-denied', 'channel', 'private', 'Private denied', NULL, NULL, 0),
         ('tenant-a', 'denied-thread-parent', 'channel', 'public', 'Denied parent', NULL, NULL, 1),
         ('tenant-a', 'entity-public', 'channel', 'public', 'Entity public', 'invoice', '7', 0),
         ('tenant-b', 'cross-tenant', 'channel', 'public', 'Cross tenant', NULL, NULL, 0)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content)
       VALUES
         ('tenant-a', 'thread-root-message', 'thread-parent', 1, 'thread-owner',
          'thread-root-client', '{"format":"plain","text":"root"}'),
         ('tenant-a', 'denied-root-message', 'denied-thread-parent', 1, 'thread-owner',
          'denied-root-client', '{"format":"plain","text":"root"}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.conversations}
         (tenant_id, id, type, visibility, parent_conversation_id,
          root_message_id, current_message_sequence)
       VALUES
         ('tenant-a', 'thread-active', 'thread', 'private', 'thread-parent',
          'thread-root-message', 0),
         ('tenant-a', 'thread-denied', 'thread', 'private', 'denied-thread-parent',
          'denied-root-message', 0)`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'public-starting', 'huddle-host', 'member', 'active'),
         ('tenant-a', 'private-active', 'user-a', 'member', 'active'),
         ('tenant-a', 'thread-active', 'user-a', 'member', 'active'),
         ('tenant-a', 'private-denied', 'other-user', 'member', 'active'),
         ('tenant-a', 'thread-denied', 'other-user', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.sessions}
         (tenant_id, id, conversation_id, provider_room_reference,
          initiated_by_user_id, started_at, updated_at)
       VALUES
         ('tenant-a', 'huddle-starting', 'public-starting',
          'provider-secret-room-starting', 'huddle-host',
          '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z'),
         ('tenant-a', 'huddle-active', 'private-active',
          'provider-secret-room-active', 'user-a',
          '2030-01-02T00:00:00Z', '2030-01-02T00:00:00Z'),
         ('tenant-a', 'huddle-thread', 'thread-active',
          'provider-secret-room-thread', 'user-a',
          '2030-01-03T00:00:00Z', '2030-01-03T00:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${tables.participants}
         (tenant_id, huddle_session_id, user_id, joined_at, left_at)
       VALUES
         ('tenant-a', 'huddle-active', 'participant-beta',
          '2030-01-02T00:00:01Z', NULL),
         ('tenant-a', 'huddle-active', 'participant-alpha',
          '2030-01-02T00:00:01Z', '2030-01-02T00:01:00Z'),
         ('tenant-a', 'huddle-active', 'user-a',
          '2030-01-02T00:00:02Z', NULL),
         ('tenant-a', 'huddle-thread', 'user-a',
          '2030-01-03T00:00:01Z', NULL)`,
    );
    await harness.pool.query(
      `UPDATE ${tables.sessions}
          SET status = 'active',
              activated_at = CASE id
                WHEN 'huddle-active' THEN '2030-01-02T00:00:02Z'::timestamptz
                ELSE '2030-01-03T00:00:01Z'::timestamptz
              END,
              active_screen_share_owner_user_id = CASE id
                WHEN 'huddle-active' THEN 'user-a'
                ELSE NULL
              END,
              updated_at = CASE id
                WHEN 'huddle-active' THEN '2030-01-02T00:00:02Z'::timestamptz
                ELSE '2030-01-03T00:00:01Z'::timestamptz
              END
        WHERE tenant_id = 'tenant-a'
          AND id IN ('huddle-active', 'huddle-thread')`,
    );

    const mediaSentinel = new Proxy(
      {},
      {
        get() {
          throw new Error("active-huddle snapshot must not touch media");
        },
      },
    );
    const run = async (conversationId, actor = actorA.actor) => {
      const captured = captureDatabase(harness.pool);
      try {
        const state = await queryActiveHuddleSnapshot({
          database: captured.database,
          permissions: harness.adapters.permissions,
          actor,
          input: { conversationId },
          schema: harness.schema,
          media: mediaSentinel,
        });
        return { state, query: captured.calls[0] };
      } finally {
        assert.equal(captured.calls.length, 1);
      }
    };

    await t.test("projects inactive, starting, active, and thread snapshots", async () => {
      const inactive = await run("public-inactive");
      assert.deepEqual(inactive.state, {
        status: "inactive",
        conversationId: "public-inactive",
      });

      const starting = await run("public-starting");
      assert.deepEqual(starting.state, {
        status: "starting",
        conversationId: "public-starting",
        huddleSessionId: "huddle-starting",
        startedAt: "2030-01-01T00:00:00.000Z",
        participants: [],
        screenShareOwnerUserId: null,
      });

      const active = await run("private-active");
      assert.deepEqual(active.state, {
        status: "active",
        conversationId: "private-active",
        huddleSessionId: "huddle-active",
        startedAt: "2030-01-02T00:00:00.000Z",
        participants: [
          {
            userId: "participant-alpha",
            status: "left",
            joinedAt: "2030-01-02T00:00:01.000Z",
            leftAt: "2030-01-02T00:01:00.000Z",
          },
          {
            userId: "participant-beta",
            status: "joined",
            joinedAt: "2030-01-02T00:00:01.000Z",
          },
          {
            userId: "user-a",
            status: "joined",
            joinedAt: "2030-01-02T00:00:02.000Z",
          },
        ],
        screenShareOwnerUserId: "user-a",
      });

      harness.calls.reset();
      const thread = await run("thread-active");
      assert.equal(thread.state.status, "active");
      assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
      assert.deepEqual(
        harness.calls.all("permissions.authorizeEntity")[0].input,
        {
          actor: actorA.actor,
          entity: { type: "order", id: "42" },
          action: ACTIVE_HUDDLE_ENTITY_POLICY_ACTION,
        },
      );
    });

    await t.test("uses one bounded parameterized and secret-free query", async () => {
      const { state, query } = await run("private-active");
      assert.deepEqual(query.values, ["tenant-a", "user-a", "private-active"]);
      assert.match(query.text, /conversation\.tenant_id = \$1/);
      assert.match(query.text, /current_member\.user_id = \$2/);
      assert.match(query.text, /conversation\.id = \$3/);
      assert.equal((query.text.match(/LIMIT 1/g) ?? []).length, 3);
      assert.doesNotMatch(query.text, /tenant-a|user-a|private-active/);
      assert.doesNotMatch(
        query.text,
        /provider_room_reference|room[_ ]?id|token|credential|media/i,
      );
      assert.doesNotMatch(JSON.stringify(state), /provider-secret-room/);
      assert.equal(harness.calls.count("media.createRoom"), 0);
      assert.equal(harness.calls.count("media.createParticipantToken"), 0);
      assert.equal(harness.calls.count("media.terminateRoom"), 0);
    });

    await t.test("hides private ending recovery and ended history", async () => {
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ending', ended_by_user_id = 'user-a',
                updated_at = '2030-01-02T00:02:00Z'
          WHERE tenant_id = 'tenant-a' AND id = 'huddle-active'`,
      );
      assert.deepEqual((await run("private-active")).state, {
        status: "inactive",
        conversationId: "private-active",
      });

      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET active_screen_share_owner_user_id = NULL
          WHERE tenant_id = 'tenant-a' AND id = 'huddle-active'`,
      );
      await harness.pool.query(
        `UPDATE ${tables.participants}
            SET left_at = COALESCE(left_at, '2030-01-02T00:04:00Z')
          WHERE tenant_id = 'tenant-a' AND huddle_session_id = 'huddle-active'`,
      );
      await harness.pool.query(
        `UPDATE ${tables.sessions}
            SET status = 'ended', ended_at = '2030-01-02T00:05:00Z',
                updated_at = '2030-01-02T00:05:00Z'
          WHERE tenant_id = 'tenant-a' AND id = 'huddle-active'`,
      );
      assert.deepEqual((await run("private-active")).state, {
        status: "inactive",
        conversationId: "private-active",
      });
    });

    await t.test("sanitizes missing, tenant, membership, and entity denial", async () => {
      const denials = [];
      for (const conversationId of [
        "missing",
        "cross-tenant",
        "private-denied",
        "thread-denied",
      ]) {
        const captured = captureDatabase(harness.pool);
        await assert.rejects(
          queryActiveHuddleSnapshot({
            database: captured.database,
            permissions: harness.adapters.permissions,
            actor: actorA.actor,
            input: { conversationId },
            schema: harness.schema,
          }),
          (error) => {
            assert.ok(error instanceof ChatAuthorizationError);
            assert.equal(error.code, CHAT_AUTHORIZATION_ERROR_CODE);
            denials.push(authorizationShape(error));
            return true;
          },
        );
        assert.equal(captured.calls.length, 1);
      }

      harness.setEntityAuthorization(false);
      await assert.rejects(run("entity-public"), (error) => {
        denials.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      });
      harness.setEntityAuthorization(true);
      harness.failures.failNext(
        "permissions.authorizeEntity",
        new Error("sensitive entity adapter diagnostics"),
      );
      await assert.rejects(run("entity-public"), (error) => {
        denials.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      });

      assert.equal(denials.length, 6);
      for (const denial of denials) {
        assert.deepEqual(denial, denials[0]);
      }
    });

    await t.test("rejects untrusted caller fields and invalid schemas before SQL", async () => {
      const unavailableDatabase = {
        async query() {
          throw new Error("database must not be called");
        },
        async connect() {
          throw new Error("database must not be called");
        },
      };
      await assert.rejects(
        queryActiveHuddleSnapshot({
          database: unavailableDatabase,
          permissions: harness.adapters.permissions,
          actor: actorA.actor,
          input: { conversationId: "public-inactive", tenantId: "forged" },
          schema: harness.schema,
        }),
        (error) =>
          error instanceof HuddleContractError &&
          error.code === "malformed_input",
      );
      await assert.rejects(
        queryActiveHuddleSnapshot({
          database: unavailableDatabase,
          permissions: harness.adapters.permissions,
          actor: actorA.actor,
          input: { conversationId: "public-inactive" },
          schema: "unsafe;schema",
        }),
        /schema/i,
      );
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
