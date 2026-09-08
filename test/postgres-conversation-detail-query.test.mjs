import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationSnapshotMetadata,
  parseConversationDetailSnapshot,
} from "@handrail/chat";

import {
  CHAT_AUTHORIZATION_ERROR_CODE,
  CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
  ChatAuthorizationError,
  queryConversationDetail,
} from "@handrail/chat/server";
import {
  createChatTestHarness,
  createPostgresTestBackend,
} from "@handrail/chat/testing";

const actorA = {
  credential: "conversation-detail-actor-a",
  actor: {
    tenantId: "tenant-a",
    userId: "user-a",
    roles: ["employee"],
  },
};

const actorB = {
  credential: "conversation-detail-actor-b",
  actor: {
    tenantId: "tenant-b",
    userId: "user-b",
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

const runDetail = (harness, database, conversationId) =>
  queryConversationDetail({
    database,
    permissions: harness.adapters.permissions,
    actor: actorA.actor,
    input: { conversationId },
    schema: harness.schema,
  });

const authorizationShape = (error) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  statusCode: error.statusCode,
});

const assertSnapshotRoundTrip = (conversation) => {
  const snapshot = JSON.parse(JSON.stringify({
    kind: "conversation_detail",
    conversation,
    _meta: createConversationSnapshotMetadata({
      packageVersion: "test",
      protocolVersion: 1,
      schemaVersion: 1,
      enabledFeatures: {},
    }),
  }));
  assert.deepEqual(parseConversationDetailSnapshot(snapshot).conversation, conversation);
};

test("conversation detail query returns tenant-safe stream state and active member IDs set-wise", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_detail_query",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const members = `${schema}.chat_conversation_members`;
    const messages = `${schema}.chat_messages`;
    const readCursors = `${schema}.chat_read_cursors`;
    const preferences = `${schema}.chat_conversation_preferences`;

    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id,
          current_message_sequence, archived_at, archived_by_user_id,
          created_at, updated_at)
       VALUES
         ('tenant-a', 'public-open', 'channel', 'public', 'Public', NULL, NULL,
          4, '2030-01-02T10:00:00Z', 'user-archiver',
          '2030-01-01T08:00:00Z', '2030-01-02T10:00:00.123456Z'),
         ('tenant-a', 'private-active', 'channel', 'private', 'Private', NULL, NULL,
          10, NULL, NULL,
          '2030-01-01T08:01:00Z', '2030-01-02T09:00:00Z'),
         ('tenant-a', 'direct-active', 'direct', 'private', NULL, NULL, NULL,
          3, NULL, NULL,
          '2030-01-01T08:02:00Z', '2030-01-02T08:00:00Z'),
         ('tenant-a', 'thread-parent', 'channel', 'private', 'Thread parent', NULL, NULL,
          1, NULL, NULL,
          '2030-01-01T08:03:00Z', '2030-01-02T07:00:00Z'),
         ('tenant-a', 'entity-public', 'channel', 'public', 'Order 42', 'order', '42',
          2, NULL, NULL,
          '2030-01-01T08:04:00Z', '2030-01-02T06:00:00Z'),
         ('tenant-a', 'private-other', 'channel', 'private', 'Other private', NULL, NULL,
          2, NULL, NULL,
          '2030-01-01T08:05:00Z', '2030-01-02T05:00:00Z'),
         ('tenant-b', 'tenant-b-only', 'channel', 'public', 'Tenant B', NULL, NULL,
          99, NULL, NULL,
          '2030-01-01T08:00:00Z', '2030-01-03T10:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${messages}
         (tenant_id, id, conversation_id, sequence, author_user_id,
          client_message_id, content, created_at, updated_at)
       VALUES
         ('tenant-a', 'root-message', 'thread-parent', 1, 'user-a',
          'root-client-message', '{"format":"plain","text":"Root"}',
          '2030-01-01T09:00:00Z', '2030-01-01T09:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, parent_conversation_id,
          root_message_id, current_message_sequence, created_at, updated_at)
       VALUES
         ('tenant-a', 'thread-active', 'thread', 'private', 'thread-parent',
          'root-message', 6, '2030-01-01T09:01:00Z',
          '2030-01-02T04:00:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state, joined_at, updated_at)
       VALUES
         ('tenant-a', 'public-open', 'user-public', 'member', 'active',
          '2030-01-01T08:00:00Z', '2030-01-01T08:00:00Z'),
         ('tenant-a', 'private-active', 'user-a', 'moderator', 'active',
          '2030-01-01T08:01:00Z', '2030-01-01T09:01:00Z'),
         ('tenant-a', 'private-active', 'user-c', 'member', 'active',
          '2030-01-01T08:01:00Z', '2030-01-01T09:01:00Z'),
         ('tenant-a', 'direct-active', 'user-a', 'member', 'active',
          '2030-01-01T08:02:00Z', '2030-01-01T09:02:00Z'),
         ('tenant-a', 'direct-active', 'user-b', 'member', 'active',
          '2030-01-01T08:02:00Z', '2030-01-01T09:02:00Z'),
         ('tenant-a', 'direct-active', 'user-c', 'member', 'removed',
          '2030-01-01T08:02:00Z', '2030-01-01T09:02:00Z'),
         ('tenant-a', 'thread-parent', 'user-a', 'member', 'active',
          '2030-01-01T08:03:00Z', '2030-01-01T09:03:00Z'),
         ('tenant-a', 'thread-active', 'user-a', 'member', 'active',
          '2030-01-01T09:01:00Z', '2030-01-01T09:04:00Z'),
         ('tenant-a', 'thread-active', 'user-d', 'member', 'active',
          '2030-01-01T09:01:00Z', '2030-01-01T09:04:00Z'),
         ('tenant-a', 'private-other', 'user-other', 'member', 'active',
          '2030-01-01T08:05:00Z', '2030-01-01T09:05:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${readCursors}
         (tenant_id, conversation_id, user_id, last_read_sequence,
          manual_unread_from_sequence, updated_at)
       VALUES
         ('tenant-a', 'private-active', 'user-a', 7, 5,
          '2030-01-01T09:30:00Z'),
         ('tenant-a', 'thread-active', 'user-a', 6, NULL,
          '2030-01-01T09:31:00Z')`,
    );
    await harness.pool.query(
      `INSERT INTO ${preferences}
         (tenant_id, conversation_id, user_id, notification_level, is_starred, muted,
          muted_until, created_at, updated_at)
       VALUES
         ('tenant-a', 'private-active', 'user-a', 'mentions', true, true,
          '2030-03-01T00:00:00Z', '2030-01-01T09:00:00Z',
          '2030-01-01T09:40:00Z'),
         ('tenant-a', 'public-open', 'user-public', 'none', true, false, NULL,
          '2030-01-01T09:00:00Z', '2030-01-01T09:41:00Z')`,
    );

    const counted = countedDatabase(harness.pool);
    const publicDetail = await runDetail(
      harness,
      counted.database,
      "public-open",
    );
    const privateDetail = await runDetail(
      harness,
      counted.database,
      "private-active",
    );
    const directDetail = await runDetail(
      harness,
      counted.database,
      "direct-active",
    );
    const threadDetail = await runDetail(
      harness,
      counted.database,
      "thread-active",
    );

    assert.equal(counted.count(), 5); // One extra parent authorization for the thread.
    assert.equal(publicDetail.type, "channel");
    assert.equal(publicDetail.archivedAt, "2030-01-02T10:00:00.000Z");
    assert.equal(publicDetail.archivedByUserId, "user-archiver");
    assert.equal(publicDetail.latestSequence, 4);
    assert.equal(publicDetail.activityAt, "2030-01-02T10:00:00.123456Z");
    assert.deepEqual(publicDetail.memberUserIds, ["user-public"]);
    assert.deepEqual(publicDetail.currentMember, {
      tenantId: "tenant-a",
      conversationId: "public-open",
      userId: "user-a",
      role: "member",
      state: "active",
      joinedAt: "2030-01-01T08:00:00.000Z",
      updatedAt: "2030-01-01T08:00:00.000Z",
    });
    assert.deepEqual(publicDetail.currentPreference, {
      preferenceRevision: 0,
      conversationId: "public-open",
      userId: "user-a",
      isStarred: false,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: "2030-01-01T08:00:00.000Z",
    });

    assert.equal(privateDetail.type, "channel");
    assert.equal(privateDetail.currentMember.role, "moderator");
    assert.deepEqual(privateDetail.currentReadState, {
      conversationId: "private-active",
      userId: "user-a",
      lastReadSequence: 7,
      manualUnreadFromSequence: 5,
      updatedAt: "2030-01-01T09:30:00.000Z",
    });
    assert.deepEqual(privateDetail.currentPreference, {
      preferenceRevision: 1,
      conversationId: "private-active",
      userId: "user-a",
      isStarred: true,
      notificationPreference: "mentions",
      mute: {
        muted: true,
        mutedUntil: "2030-03-01T00:00:00.000Z",
      },
      updatedAt: "2030-01-01T09:40:00.000Z",
    });
    assert.deepEqual(privateDetail.memberUserIds, ["user-a", "user-c"]);

    assert.equal(directDetail.type, "direct");
    assert.equal(directDetail.visibility, "private");
    assert.deepEqual(directDetail.memberUserIds, ["user-a", "user-b"]);
    assert.equal("messages" in directDetail, false);

    assert.equal(threadDetail.type, "thread");
    assert.equal(Object.hasOwn(threadDetail, "name"), false);
    assert.deepEqual(threadDetail.threadLifecycle, { revision: 1, locked: false });
    assert.equal(Object.hasOwn(threadDetail.threadLifecycle, "closedAt"), false);
    assert.equal(Object.hasOwn(threadDetail.threadLifecycle, "closedByUserId"), false);
    assertSnapshotRoundTrip(threadDetail);
    const { threadLifecycle, ...legacySnapshot } = threadDetail;
    assertSnapshotRoundTrip(legacySnapshot);
    for (const detail of [publicDetail, privateDetail, directDetail]) {
      assert.equal(Object.hasOwn(detail, "threadLifecycle"), false);
      assertSnapshotRoundTrip(detail);
    }
    assert.equal(threadDetail.parentConversationId, "thread-parent");
    assert.equal(threadDetail.rootMessageId, "root-message");
    assert.equal(threadDetail.currentReadState.lastReadSequence, 6);
    assert.deepEqual(threadDetail.memberUserIds, ["user-a", "user-d"]);
    assert.equal(harness.calls.count("directory.getUser"), 0);

    harness.calls.reset();
    const entityCounted = countedDatabase(harness.pool);
    const entityDetail = await runDetail(
      harness,
      entityCounted.database,
      "entity-public",
    );
    assert.equal(entityCounted.count(), 1);
    assert.deepEqual(entityDetail.entity, { type: "order", id: "42" });
    assert.equal(harness.calls.count("permissions.authorizeEntity"), 1);
    assert.deepEqual(
      harness.calls.all("permissions.authorizeEntity")[0].input,
      {
        actor: actorA.actor,
        entity: { type: "order", id: "42" },
        action: CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
      },
    );
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

test("conversation detail reload retains a named thread's lifecycle independently of administrative archive", async () => {
  const backend = await createPostgresTestBackend();
  let harness;
  try {
    harness = await createChatTestHarness({
      backend, actors: [actorA], schemaPrefix: "chat_detail_metadata",
    });
    const schema = quoteIdentifier(harness.schema);
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_conversations (tenant_id, id, type, visibility, name)
       VALUES ('tenant-a', 'parent', 'channel', 'private', 'Parent')`,
    );
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_messages
         (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
       VALUES ('tenant-a', 'root', 'parent', 1, 'user-a', 'root-client',
         '{"format":"plain","text":"Which launch date?"}')`,
    );
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_conversations
         (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id,
          lifecycle_revision, closed_at, closed_by_user_id, locked)
       VALUES ('tenant-a', 'named-thread', 'thread', 'private', 'Launch planning', 'parent', 'root',
         9007199254740991, '2030-01-02T12:00:00.123+02:00', 'user-closer', true)`,
    );
    await harness.pool.query(
      `INSERT INTO ${schema}.chat_conversation_members
         (tenant_id, conversation_id, user_id, role, state)
       VALUES ('tenant-a', 'parent', 'user-a', 'member', 'active'),
              ('tenant-a', 'named-thread', 'user-a', 'member', 'active')`,
    );

    const detail = await runDetail(harness, harness.pool, "named-thread");
    assert.equal(detail.name, "Launch planning");
    assert.deepEqual(detail.threadLifecycle, {
      revision: Number.MAX_SAFE_INTEGER,
      closedAt: "2030-01-02T10:00:00.123Z",
      closedByUserId: "user-closer",
      locked: true,
    });
    assert.equal(Object.hasOwn(detail, "archivedAt"), false);
    assert.equal(Object.hasOwn(detail, "archivedByUserId"), false);
    assertSnapshotRoundTrip(detail);

    // Persist fixture states directly: this tests reload, not transition commands.
    await harness.pool.query(
      `UPDATE ${schema}.chat_conversations
       SET archived_at = '2030-01-03T11:00:00Z', archived_by_user_id = 'user-archiver'
       WHERE tenant_id = 'tenant-a' AND id = 'named-thread'`,
    );
    const archived = await runDetail(harness, harness.pool, "named-thread");
    assert.equal(archived.name, detail.name);
    assert.deepEqual(archived.threadLifecycle, detail.threadLifecycle);
    assert.equal(archived.archivedAt, "2030-01-03T11:00:00.000Z");
    assert.equal(archived.archivedByUserId, "user-archiver");
    assertSnapshotRoundTrip(archived);

    await harness.pool.query(
      `UPDATE ${schema}.chat_conversations SET locked = false
       WHERE tenant_id = 'tenant-a' AND id = 'named-thread'`,
    );
    const unlocked = await runDetail(harness, harness.pool, "named-thread");
    assert.deepEqual(unlocked.threadLifecycle, { ...detail.threadLifecycle, locked: false });
    assertSnapshotRoundTrip(unlocked);

    await harness.pool.query(
      `UPDATE ${schema}.chat_conversations SET closed_at = NULL, closed_by_user_id = NULL
       WHERE tenant_id = 'tenant-a' AND id = 'named-thread'`,
    );
    const open = await runDetail(harness, harness.pool, "named-thread");
    assert.deepEqual(open.threadLifecycle, { revision: Number.MAX_SAFE_INTEGER, locked: false });
    assert.equal(open.archivedAt, archived.archivedAt);
    assert.equal(open.archivedByUserId, archived.archivedByUserId);
    assertSnapshotRoundTrip(open);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});

// Thread metadata must pass the same current-parent admission as history.
for (const denial of ["private parent membership", "parent entity denial", "parent entity error"]) {
  test(`conversation detail withholds thread metadata after denied ${denial}`, async () => {
    const backend = await createPostgresTestBackend();
    let harness;
    try {
      harness = await createChatTestHarness({
        backend, actors: [actorA], schemaPrefix: "chat_detail_parent",
      });
      const schema = quoteIdentifier(harness.schema);
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_conversations
           (tenant_id, id, type, visibility, name, entity_type, entity_id)
         VALUES ('tenant-a', 'denied-parent', 'channel', 'private', 'Private parent', 'order', '42')`,
      );
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_messages
           (tenant_id, id, conversation_id, sequence, author_user_id, client_message_id, content)
         VALUES ('tenant-a', 'private-root', 'denied-parent', 1, 'user-a', 'root-client',
           '{"format":"plain","text":"Private root"}')`,
      );
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_conversations
           (tenant_id, id, type, visibility, name, parent_conversation_id, root_message_id,
            lifecycle_revision, closed_at, closed_by_user_id, locked)
         VALUES ('tenant-a', 'denied-thread', 'thread', 'private', 'Sensitive thread name',
           'denied-parent', 'private-root', 7, '2030-01-02T10:00:00Z', 'private-moderator', true)`,
      );
      await harness.pool.query(
        `INSERT INTO ${schema}.chat_conversation_members
           (tenant_id, conversation_id, user_id, role, state)
         VALUES ('tenant-a', 'denied-thread', 'user-a', 'member', 'active'),
                ('tenant-a', 'denied-parent', 'user-a', 'member', $1)`,
        [denial === "private parent membership" ? "removed" : "active"],
      );
      if (denial === "parent entity denial") harness.setEntityAuthorization(false);
      if (denial === "parent entity error") {
        harness.failures.failNext("permissions.authorizeEntity", new Error("sensitive host failure"));
      }
      await assert.rejects(
        runDetail(harness, harness.pool, "denied-thread"),
        (error) => {
          assert.ok(error instanceof ChatAuthorizationError);
          assert.deepEqual(authorizationShape(error), authorizationShape(new ChatAuthorizationError()));
          for (const field of ["threadLifecycle", "closedAt", "closedByUserId", "rootMessageId"]) {
            assert.equal(Object.hasOwn(error, field), false);
          }
          assert.doesNotMatch(JSON.stringify(error), /Sensitive thread name|private-root|private-moderator|sensitive host failure/);
          return true;
        },
      );
    } finally {
      await harness?.teardown();
      await backend.teardown();
    }
  });
}

test("conversation detail query sanitizes missing, inaccessible, cross-tenant, and entity failures identically", async () => {
  const backend = await createPostgresTestBackend();
  let harness;

  try {
    harness = await createChatTestHarness({
      backend,
      actors: [actorA, actorB],
      schemaPrefix: "chat_detail_denial",
    });
    const schema = quoteIdentifier(harness.schema);
    const conversations = `${schema}.chat_conversations`;
    const members = `${schema}.chat_conversation_members`;
    await harness.pool.query(
      `INSERT INTO ${conversations}
         (tenant_id, id, type, visibility, name, entity_type, entity_id)
       VALUES
         ('tenant-a', 'private-other', 'channel', 'private', 'Other', NULL, NULL),
         ('tenant-a', 'entity-public', 'channel', 'public', 'Entity', 'order', '42'),
         ('tenant-b', 'cross-tenant', 'channel', 'public', 'Tenant B', NULL, NULL)`,
    );
    await harness.pool.query(
      `INSERT INTO ${members}
         (tenant_id, conversation_id, user_id, role, state)
       VALUES
         ('tenant-a', 'private-other', 'user-other', 'member', 'active')`,
    );

    const failures = [];
    for (const conversationId of [
      "missing",
      "private-other",
      "cross-tenant",
    ]) {
      const counted = countedDatabase(harness.pool);
      await assert.rejects(
        runDetail(harness, counted.database, conversationId),
        (error) => {
          assert.ok(error instanceof ChatAuthorizationError);
          assert.equal(error.code, CHAT_AUTHORIZATION_ERROR_CODE);
          failures.push(authorizationShape(error));
          return true;
        },
      );
      assert.equal(counted.count(), 1);
    }

    harness.setEntityAuthorization(false);
    await assert.rejects(
      runDetail(harness, harness.pool, "entity-public"),
      (error) => {
        failures.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      },
    );
    harness.setEntityAuthorization(true);
    harness.failures.failNext(
      "permissions.authorizeEntity",
      new Error("sensitive host adapter failure"),
    );
    await assert.rejects(
      runDetail(harness, harness.pool, "entity-public"),
      (error) => {
        failures.push(authorizationShape(error));
        return error instanceof ChatAuthorizationError;
      },
    );

    assert.equal(failures.length, 5);
    for (const failure of failures) {
      assert.deepEqual(failure, failures[0]);
    }

    const invalid = countedDatabase(harness.pool);
    await assert.rejects(
      queryConversationDetail({
        database: invalid.database,
        permissions: harness.adapters.permissions,
        actor: actorA.actor,
        input: { conversationId: "entity-public", tenantId: "spoofed" },
        schema: harness.schema,
      }),
      /server-derived/,
    );
    assert.equal(invalid.count(), 0);
  } finally {
    await harness?.teardown();
    await backend.teardown();
  }
});
