import assert from "node:assert/strict";
import test from "node:test";

import { parseConversationDraftSnapshot } from "@handrail/chat";
import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
  ChatAuthorizationError,
  queryConversationDraftSnapshot,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorA = {
  credential: "draft-snapshot-actor-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
};

const actorOther = {
  credential: "draft-snapshot-actor-other",
  actor: {
    tenantId: "tenant-a",
    userId: "user-b",
    roles: ["employee"],
  },
};

const actorTenantB = {
  credential: "draft-snapshot-actor-tenant-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-a",
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

test("conversation draft snapshot is actor-private, tenant-safe, and bounded", async (t) => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorOther, actorTenantB],
      schemaPrefix: "chat_draft_snapshot",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const members = `${schema}.chat_conversation_members`;
    const drafts = `${schema}.chat_drafts`;

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id)
       VALUES
         ('tenant-a', 'draft-present', 'channel', 'private', 'Present', NULL, NULL),
         ('tenant-a', 'draft-never', 'channel', 'public', 'Never', NULL, NULL),
         ('tenant-a', 'draft-cleared', 'channel', 'private', 'Cleared', NULL, NULL),
         ('tenant-a', 'draft-actor-shared', 'channel', 'private', 'Actors', NULL, NULL),
         ('tenant-a', 'draft-inactive', 'channel', 'private', 'Inactive', NULL, NULL),
         ('tenant-a', 'draft-public-nonmember', 'channel', 'public', 'Nonmember', NULL, NULL),
         ('tenant-a', 'draft-entity', 'channel', 'public', 'Entity', 'invoice', '42'),
         ('tenant-a', 'draft-tenant-shared', 'channel', 'private', 'Tenant A', NULL, NULL),
         ('tenant-b', 'draft-tenant-shared', 'channel', 'private', 'Tenant B', NULL, NULL),
         ('tenant-b', 'draft-tenant-only', 'channel', 'public', 'Tenant B only', NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'draft-present', 'user-a', 'member', 'active'),
         ('tenant-a', 'draft-never', 'user-a', 'member', 'active'),
         ('tenant-a', 'draft-cleared', 'user-a', 'member', 'active'),
         ('tenant-a', 'draft-actor-shared', 'user-a', 'member', 'active'),
         ('tenant-a', 'draft-actor-shared', 'user-b', 'member', 'active'),
         ('tenant-a', 'draft-inactive', 'user-a', 'member', 'left'),
         ('tenant-a', 'draft-public-nonmember', 'someone-else', 'member', 'active'),
         ('tenant-a', 'draft-entity', 'user-a', 'member', 'active'),
         ('tenant-a', 'draft-tenant-shared', 'user-a', 'member', 'active'),
         ('tenant-b', 'draft-tenant-shared', 'user-a', 'member', 'active'),
         ('tenant-b', 'draft-tenant-only', 'user-a', 'member', 'active')`,
    );
    await harness.pool.query(
      `INSERT INTO ${drafts}
         (tenant_id, conversation_id, user_id, content, revision,
          created_at, updated_at)
       VALUES
         ('tenant-a', 'draft-present', 'user-a',
          '{"format":"markdown","text":"private present","attachments":[{"attachmentId":"attachment-z"},{"attachmentId":"attachment-a"},{"attachmentId":"attachment-m"}]}'::jsonb,
          7, '2030-01-01T00:00:00Z', '2030-01-02T03:04:05Z'),
         ('tenant-a', 'draft-cleared', 'user-a', NULL,
          8, '2030-01-01T00:00:00Z', '2030-01-03T03:04:05Z'),
         ('tenant-a', 'draft-actor-shared', 'user-a',
          '{"format":"plain","text":"actor a secret","attachments":[]}'::jsonb,
          2, '2030-01-01T00:00:00Z', '2030-01-04T03:04:05Z'),
         ('tenant-a', 'draft-actor-shared', 'user-b',
          '{"format":"plain","text":"actor b secret","attachments":[]}'::jsonb,
          11, '2030-01-01T00:00:00Z', '2030-01-05T03:04:05Z'),
         ('tenant-a', 'draft-inactive', 'user-a',
          '{"format":"plain","text":"inactive secret","attachments":[]}'::jsonb,
          4, '2030-01-01T00:00:00Z', '2030-01-06T03:04:05Z'),
         ('tenant-a', 'draft-tenant-shared', 'user-a',
          '{"format":"plain","text":"tenant a secret","attachments":[]}'::jsonb,
          3, '2030-01-01T00:00:00Z', '2030-01-07T03:04:05Z'),
         ('tenant-b', 'draft-tenant-shared', 'user-a',
          '{"format":"plain","text":"tenant b secret","attachments":[]}'::jsonb,
          9, '2030-01-01T00:00:00Z', '2030-01-08T03:04:05Z'),
         ('tenant-b', 'draft-tenant-only', 'user-a',
          '{"format":"plain","text":"cross tenant secret","attachments":[]}'::jsonb,
          5, '2030-01-01T00:00:00Z', '2030-01-09T03:04:05Z')`,
    );

    const run = async (conversationId, actor = actorA.actor) => {
      const captured = captureDatabase(harness.pool);
      try {
        const snapshot = await queryConversationDraftSnapshot({
          database: captured.database,
          permissions: harness.adapters.permissions,
          actor,
          input: { conversationId },
          schema: harness.schema,
        });
        return { snapshot, query: captured.calls[0] };
      } finally {
        assert.equal(captured.calls.length, 1);
      }
    };

    await t.test("returns validated present, never-created, and clear-tombstone states", async () => {
      const present = (await run("draft-present")).snapshot;
      assert.deepEqual(present, {
        kind: "conversation_draft",
        privacy: "actor_private",
        conversationId: "draft-present",
        state: "present",
        canonicalRevision: 7,
        canonicalUpdatedAt: "2030-01-02T03:04:05.000Z",
        content: {
          privacy: "actor_private",
          value: {
            format: "markdown",
            text: "private present",
            attachments: [
              { attachmentId: "attachment-z" },
              { attachmentId: "attachment-a" },
              { attachmentId: "attachment-m" },
            ],
          },
        },
      });
      assert.deepEqual(
        parseConversationDraftSnapshot(present, {
          conversationId: "draft-present",
        }),
        present,
      );

      assert.deepEqual((await run("draft-never")).snapshot, {
        kind: "conversation_draft",
        privacy: "actor_private",
        conversationId: "draft-never",
        state: "absent",
        canonicalRevision: 0,
        canonicalUpdatedAt: null,
        content: null,
      });
      assert.deepEqual((await run("draft-cleared")).snapshot, {
        kind: "conversation_draft",
        privacy: "actor_private",
        conversationId: "draft-cleared",
        state: "absent",
        canonicalRevision: 8,
        canonicalUpdatedAt: "2030-01-03T03:04:05.000Z",
        content: null,
      });
      assert.deepEqual((await run("draft-public-nonmember")).snapshot, {
        kind: "conversation_draft",
        privacy: "actor_private",
        conversationId: "draft-public-nonmember",
        state: "absent",
        canonicalRevision: 0,
        canonicalUpdatedAt: null,
        content: null,
      });
    });

    await t.test("isolates actor and tenant rows with the same conversation", async () => {
      const own = (await run("draft-actor-shared")).snapshot;
      const other = (
        await run("draft-actor-shared", actorOther.actor)
      ).snapshot;
      assert.equal(own.state, "present");
      assert.equal(own.content.value.text, "actor a secret");
      assert.equal(own.canonicalRevision, 2);
      assert.equal(other.state, "present");
      assert.equal(other.content.value.text, "actor b secret");
      assert.equal(other.canonicalRevision, 11);

      const tenantA = (await run("draft-tenant-shared")).snapshot;
      const tenantB = (
        await run("draft-tenant-shared", actorTenantB.actor)
      ).snapshot;
      assert.equal(tenantA.state, "present");
      assert.equal(tenantA.content.value.text, "tenant a secret");
      assert.equal(tenantB.state, "present");
      assert.equal(tenantB.content.value.text, "tenant b secret");
    });

    await t.test("uses exactly one bounded parameterized actor lookup", async () => {
      const { snapshot, query } = await run("draft-present");
      assert.deepEqual(query.values, ["tenant-a", "user-a", "draft-present"]);
      assert.match(query.text, /conversation\.tenant_id = \$1/);
      assert.match(query.text, /current_member\.user_id = \$2/);
      assert.match(query.text, /conversation\.id = \$3/);
      assert.match(
        query.text,
        /conversation\.type = 'channel' AND conversation\.visibility = 'public'/,
      );
      assert.match(query.text, /current_member\.state = 'active'/);
      assert.match(query.text, /draft\.tenant_id = conversation\.tenant_id/);
      assert.match(query.text, /draft\.conversation_id = conversation\.id/);
      assert.match(query.text, /draft\.user_id = \$2/);
      assert.equal((query.text.match(/LIMIT 1/g) ?? []).length, 2);
      assert.doesNotMatch(query.text, /tenant-a|user-a|draft-present/);
      assert.doesNotMatch(
        query.text,
        /chat_attachments|chat_audit_events|storage|object_key|download|url/i,
      );
      assert.deepEqual(
        Object.keys(snapshot.content.value.attachments[0]),
        ["attachmentId"],
      );
    });

    await t.test("applies host entity policy and sanitizes every denial", async () => {
      harness.calls.reset();
      assert.equal((await run("draft-entity")).snapshot.state, "absent");
      assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
      assert.deepEqual(
        harness.calls.all("permissions.authorizeEntity")[0].input,
        {
          actor: actorA.actor,
          entity: { type: "invoice", id: "42" },
          action: CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
        },
      );

      const denials = [];
      for (const conversationId of [
        "missing",
        "draft-inactive",
        "draft-tenant-only",
      ]) {
        await assert.rejects(run(conversationId), (error) => {
          assert.ok(error instanceof ChatAuthorizationError);
          assert.equal(error.code, CHAT_AUTHORIZATION_ERROR_CODE);
          denials.push(authorizationShape(error));
          return true;
        });
      }

      harness.setEntityAuthorization(false);
      await assert.rejects(run("draft-entity"), (error) => {
        denials.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      });
      harness.setEntityAuthorization(true);
      harness.failures.failNext(
        "permissions.authorizeEntity",
        new Error("sensitive host policy diagnostics"),
      );
      await assert.rejects(run("draft-entity"), (error) => {
        denials.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      });

      assert.equal(denials.length, 5);
      for (const denial of denials) {
        assert.deepEqual(denial, denials[0]);
      }
    });
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
