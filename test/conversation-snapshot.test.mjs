import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  CONVERSATION_SNAPSHOT_FEATURE,
  CONVERSATION_SNAPSHOT_CURSOR_VERSION,
  CONVERSATION_SNAPSHOT_VERSION,
  CONVERSATION_NAVIGATION_RANK,
  MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  ConversationSnapshotParseError,
  createConversationSnapshotMetadata,
  decodeConversationSnapshotCursor,
  encodeConversationSnapshotCursor,
  encodeLegacyConversationSnapshotCursor,
  encodeStarredFirstLegacyConversationSnapshotCursor,
  parseConversationDetailSnapshot,
  parseConversationDetailSnapshotInput,
  parseConversationListSnapshot,
  parseConversationListSnapshotInput,
  parseConversationSnapshotScope,
} from "../dist/client/index.js";
import * as serverSnapshotContracts from "../dist/server/index.js";

const tenantId = "tenant-1";
const userId = "user-current";
const now = "2026-08-25T20:00:00.000Z";
const metadata = createConversationSnapshotMetadata({
  packageVersion: "0.1.2",
  protocolVersion: 4,
  schemaVersion: 9,
  enabledFeatures: { threads: true, reactions: true },
});

function currentState(conversationId, latestSequence, activityAt = now) {
  return {
    latestSequence,
    activityAt,
    unreadMentionCount: 0,
    hasActiveHuddle: false,
    activeMemberUserIds: [userId],
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: "member",
      state: "active",
      joinedAt: now,
      updatedAt: now,
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: Math.max(0, latestSequence - 1),
      updatedAt: now,
    },
    currentPreference: {
      conversationId,
      userId,
      isStarred: false,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: now,
    },
  };
}

const conversations = [
  {
    id: "conversation-public",
    tenantId,
    type: "channel",
    name: "Orders",
    visibility: "public",
    entity: { type: "order", id: "order-42" },
    createdAt: now,
    updatedAt: now,
    ...currentState("conversation-public", 12),
  },
  {
    id: "conversation-private",
    tenantId,
    type: "channel",
    name: "Finance",
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    ...currentState("conversation-private", 8),
  },
  {
    id: "conversation-direct",
    tenantId,
    type: "direct",
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    ...currentState("conversation-direct", 4),
  },
  {
    id: "conversation-group",
    tenantId,
    type: "group_direct",
    visibility: "private",
    createdAt: now,
    updatedAt: now,
    ...currentState("conversation-group", 5),
  },
  {
    id: "conversation-thread",
    tenantId,
    type: "thread",
    visibility: "public",
    parentConversationId: "conversation-public",
    rootMessageId: "message-root",
    createdAt: now,
    updatedAt: now,
    ...currentState("conversation-thread", 3),
  },
];

const cursor = encodeConversationSnapshotCursor({
  isStarred: false,
  navigationRank: CONVERSATION_NAVIGATION_RANK.groupDirect,
  activityAt: now,
  conversationId: "conversation-group",
});

test("JSON-round-trips public, private, direct, group-direct, and thread list snapshots", () => {
  const snapshot = {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: conversations,
    page: { nextCursor: cursor },
    _meta: metadata,
  };

  const roundTripped = parseConversationListSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
  );
  assert.deepEqual(roundTripped, snapshot);
  assert.deepEqual(roundTripped.items.map(({ type }) => type), [
    "channel",
    "channel",
    "direct",
    "group_direct",
    "thread",
  ]);
});

test("validates bounded unique active member user IDs in list snapshots", () => {
  const snapshot = {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversations[0]],
    page: {},
    _meta: metadata,
  };
  const bounded = Array.from(
    { length: MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS },
    (_, index) => `user-${index}`,
  );
  assert.deepEqual(
    parseConversationListSnapshot({
      ...snapshot,
      items: [{ ...conversations[0], activeMemberUserIds: bounded }],
    }).items[0].activeMemberUserIds,
    bounded,
  );

  for (const activeMemberUserIds of [
    undefined,
    "user-not-an-array",
    [""],
    ["   "],
    [7],
    [userId, userId],
    [...bounded, "user-over-limit"],
  ]) {
    assert.throws(
      () =>
        parseConversationListSnapshot({
          ...snapshot,
          items: [{ ...conversations[0], activeMemberUserIds }],
        }),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_snapshot",
    );
  }
});

test("requires a nonnegative safe-integer unread mention count", () => {
  const snapshot = {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversations[0]],
    page: {},
    _meta: metadata,
  };

  for (const unreadMentionCount of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        parseConversationListSnapshot({
          ...snapshot,
          items: [{ ...conversations[0], unreadMentionCount }],
        }),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_snapshot",
    );
  }

  assert.equal(
    parseConversationListSnapshot({
      ...snapshot,
      items: [{ ...conversations[0], unreadMentionCount: 0 }],
    }).items[0].unreadMentionCount,
    0,
  );
});

test("requires an actual boolean active-huddle flag only in list snapshots", () => {
  const snapshot = {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversations[0]],
    page: {},
    _meta: metadata,
  };

  for (const hasActiveHuddle of [undefined, null, "true", 1, {}, []]) {
    assert.throws(
      () =>
        parseConversationListSnapshot({
          ...snapshot,
          items: [{ ...conversations[0], hasActiveHuddle }],
        }),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_snapshot",
    );
  }

  assert.equal(
    parseConversationListSnapshot({
      ...snapshot,
      items: [{ ...conversations[0], hasActiveHuddle: true }],
    }).items[0].hasActiveHuddle,
    true,
  );

  const detailConversation = { ...conversations[0] };
  delete detailConversation.hasActiveHuddle;
  assert.equal(
    parseConversationDetailSnapshot({
      kind: "conversation_detail",
      conversation: { ...detailConversation, memberUserIds: [userId] },
      _meta: metadata,
    }).conversation.id,
    conversations[0].id,
  );
});

test("JSON-round-trips each representative one-conversation detail snapshot", () => {
  for (const conversation of conversations) {
    const detailConversation = {
      ...conversation,
      memberUserIds: [userId, "user-other"],
      currentPreference: {
        conversationId: conversation.id,
        userId,
        isStarred: true,
        notificationPreference: "mentions",
        mute: { muted: false },
        updatedAt: now,
      },
    };
    const snapshot = {
      kind: "conversation_detail",
      conversation: detailConversation,
      _meta: metadata,
    };
    assert.deepEqual(
      parseConversationDetailSnapshot(JSON.parse(JSON.stringify(snapshot))),
      snapshot,
    );
  }
});

test("requires opaque member IDs and matching current preference in detail snapshots", () => {
  const conversation = {
    ...conversations[0],
    memberUserIds: [userId],
    currentPreference: {
      conversationId: conversations[0].id,
      userId,
      isStarred: false,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: now,
    },
  };
  const snapshot = {
    kind: "conversation_detail",
    conversation,
    _meta: metadata,
  };

  assert.throws(() =>
    parseConversationDetailSnapshot({
      ...snapshot,
      conversation: { ...conversation, memberUserIds: [userId, userId] },
    }),
  );
  assert.throws(() =>
    parseConversationDetailSnapshot({
      ...snapshot,
      conversation: {
        ...conversation,
        currentPreference: {
          ...conversation.currentPreference,
          userId: "user-spoofed",
        },
      },
    }),
  );
});

test("requires boolean starred state and round-trips both values", () => {
  const snapshot = {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversations[0]],
    page: {},
    _meta: metadata,
  };

  for (const isStarred of [false, true]) {
    const wire = {
      ...snapshot,
      items: [{
        ...conversations[0],
        currentPreference: {
          ...conversations[0].currentPreference,
          isStarred,
        },
      }],
    };
    assert.deepEqual(parseConversationListSnapshot(wire), wire);
  }

  for (const isStarred of [undefined, null, "true", 1, {}, []]) {
    assert.throws(
      () => parseConversationListSnapshot({
        ...snapshot,
        items: [{
          ...conversations[0],
          currentPreference: {
            ...conversations[0].currentPreference,
            isStarred,
          },
        }],
      }),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_snapshot",
    );
  }
});

test("requires list preferences to match the current conversation actor", () => {
  const snapshot = {
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversations[0]],
    page: {},
    _meta: metadata,
  };

  for (const currentPreference of [
    { ...conversations[0].currentPreference, conversationId: "conversation-other" },
    { ...conversations[0].currentPreference, userId: "user-spoofed" },
  ]) {
    assert.throws(
      () => parseConversationListSnapshot({
        ...snapshot,
        items: [{ ...conversations[0], currentPreference }],
      }),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_snapshot",
    );
  }
});

test("parses organization and opaque host-entity scopes", () => {
  assert.deepEqual(parseConversationSnapshotScope({ type: "organization" }), {
    type: "organization",
  });
  assert.deepEqual(
    parseConversationSnapshotScope({
      type: "entity",
      entity: { type: "erp.invoice", id: "opaque/invoice/42" },
    }),
    {
      type: "entity",
      entity: { type: "erp.invoice", id: "opaque/invoice/42" },
    },
  );
});

test("deterministically round-trips every v3 navigation rank", () => {
  assert.deepEqual(CONVERSATION_NAVIGATION_RANK, {
    direct: 0,
    publicChannel: 1,
    privateChannel: 2,
    groupDirect: 3,
  });

  for (const navigationRank of [0, 1, 2, 3]) {
    const position = {
      isStarred: navigationRank % 2 === 0,
      navigationRank,
      activityAt: "2026-08-25T20:00:00.123Z",
      conversationId: `conversation-rank-${navigationRank}`,
    };
    const expected = `handrail-conversations.v3.${encodeURIComponent(
      JSON.stringify([
        position.isStarred,
        position.navigationRank,
        position.activityAt,
        position.conversationId,
      ]),
    )}`;
    const encoded = encodeConversationSnapshotCursor(position);

    assert.equal(encoded, expected);
    assert.equal(encoded, encodeConversationSnapshotCursor(position));
    assert.deepEqual(decodeConversationSnapshotCursor(encoded), position);
    assert.match(
      encoded,
      new RegExp(`^handrail-conversations\\.v${CONVERSATION_SNAPSHOT_CURSOR_VERSION}\\.`),
    );
  }
});

test("decodes v2 starred-first and v1 activity-only fixtures as distinct shapes", () => {
  const activityAt = "2026-08-25T20:00:00.123Z";
  const conversationId = "conversation-legacy";
  const v2Position = { isStarred: true, activityAt, conversationId };
  const v2Fixture = `handrail-conversations.v2.${encodeURIComponent(
    JSON.stringify([true, activityAt, conversationId]),
  )}`;
  assert.equal(
    encodeStarredFirstLegacyConversationSnapshotCursor(v2Position),
    v2Fixture,
  );
  const decodedV2 = decodeConversationSnapshotCursor(v2Fixture);
  assert.deepEqual(decodedV2, v2Position);
  assert.equal("isStarred" in decodedV2, true);
  assert.equal("navigationRank" in decodedV2, false);

  const v1Position = { activityAt, conversationId };
  const v1Fixture = `handrail-conversations.v1.${encodeURIComponent(
    JSON.stringify([activityAt, conversationId]),
  )}`;
  assert.equal(encodeLegacyConversationSnapshotCursor(v1Position), v1Fixture);
  const decodedV1 = decodeConversationSnapshotCursor(v1Fixture);
  assert.deepEqual(decodedV1, v1Position);
  assert.equal("isStarred" in decodedV1, false);
  assert.equal("navigationRank" in decodedV1, false);
});

test("rejects malformed, structurally invalid, and unsupported cursors", () => {
  const invalid = [
    "",
    "not-a-cursor",
    "handrail-conversations.v1.%",
    `handrail-conversations.v1.${encodeURIComponent(JSON.stringify([now]))}`,
    `handrail-conversations.v1.${encodeURIComponent(JSON.stringify(["yesterday", "conversation-1"]))}`,
    `handrail-conversations.v2.${encodeURIComponent(JSON.stringify([now, "conversation-1"]))}`,
    `handrail-conversations.v2.${encodeURIComponent(JSON.stringify(["true", now, "conversation-1"]))}`,
    `handrail-conversations.v2.${encodeURIComponent(JSON.stringify([false, "yesterday", "conversation-1"]))}`,
    `handrail-conversations.v3.${encodeURIComponent(JSON.stringify([false, now, "conversation-1"]))}`,
    ...[undefined, null, 1.5, -1, 4, "1", true, {}, []].map((navigationRank) =>
      `handrail-conversations.v3.${encodeURIComponent(
        JSON.stringify([false, navigationRank, now, "conversation-1"]),
      )}`
    ),
  ];

  for (const value of invalid) {
    assert.throws(
      () => decodeConversationSnapshotCursor(value),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_cursor",
    );
  }

  for (const navigationRank of [undefined, null, 1.5, -1, 4, "1", true, {}, []]) {
    assert.throws(
      () => encodeConversationSnapshotCursor({
        isStarred: false,
        navigationRank,
        activityAt: now,
        conversationId: "conversation-1",
      }),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "malformed_cursor",
    );
  }

  assert.throws(
    () =>
      decodeConversationSnapshotCursor(
        `handrail-conversations.v4.${encodeURIComponent(JSON.stringify([false, 0, now, "conversation-1"]))}`,
      ),
    (error) =>
      error instanceof ConversationSnapshotParseError &&
      error.code === "unsupported_cursor",
  );
});

test("rejects client-supplied trusted tenant and actor identity fields", () => {
  const clientAuthoredInputs = [
    { scope: { type: "organization" }, tenantId: "spoofed" },
    { scope: { type: "organization", actorId: "spoofed" } },
    { scope: { type: "organization" }, user: { id: "spoofed" } },
    { scope: { type: "organization" }, role: "owner" },
    {
      scope: {
        type: "entity",
        entity: { type: "order", id: "42", userId: "spoofed" },
      },
    },
  ];

  for (const input of clientAuthoredInputs) {
    assert.throws(
      () => parseConversationListSnapshotInput(input),
      (error) =>
        error instanceof ConversationSnapshotParseError &&
        error.code === "trusted_identity_field",
    );
  }

  assert.throws(
    () =>
      parseConversationDetailSnapshotInput({
        conversationId: "conversation-1",
        actor: { userId: "spoofed" },
      }),
    (error) =>
      error instanceof ConversationSnapshotParseError &&
      error.code === "trusted_identity_field",
  );
});

test("exports aligned feature metadata and the same codecs from the server entry", () => {
  assert.deepEqual(metadata.feature, {
    name: CONVERSATION_SNAPSHOT_FEATURE,
    version: CONVERSATION_SNAPSHOT_VERSION,
  });
  assert.equal(
    serverSnapshotContracts.encodeConversationSnapshotCursor,
    encodeConversationSnapshotCursor,
  );
  assert.deepEqual(
    parseConversationListSnapshotInput({
      scope: { type: "entity", entity: { type: "order", id: "42" } },
      cursor,
      limit: 25,
    }),
    {
      scope: { type: "entity", entity: { type: "order", id: "42" } },
      cursor,
      limit: 25,
    },
  );
});


test("thread detail validates actor-private follow authority including absent and explicit unfollow state", () => {
  const thread = conversations.find(({ type }) => type === "thread");
  const follow = { target: { type: "thread", id: thread.id }, isFollowing: false, source: "manual", updatedAt: now };
  const snapshot = (currentThreadFollow) => ({ kind: "conversation_detail", conversation: { ...thread, memberUserIds: [userId], currentThreadFollow }, _meta: metadata });
  for (const authority of [{ followRevision: 0, follow: null }, { followRevision: 4, follow }]) {
    assert.deepEqual(parseConversationDetailSnapshot(snapshot(authority)).conversation.currentThreadFollow, authority);
  }
  for (const authority of [
    { followRevision: 4, follow: null },
    { followRevision: 0, follow },
    { followRevision: 4, follow: { ...follow, target: { type: "thread", id: "wrong-thread" } } },
    { followRevision: 4, follow: { ...follow, source: "reply" } },
  ]) assert.throws(() => parseConversationDetailSnapshot(snapshot(authority)));
});

const threadNames = JSON.parse(await readFile("conformance-tests/thread-names.json", "utf8"));

function threadSnapshots(conversation) {
  return [
    [parseConversationListSnapshot, {
      kind: "conversation_list", scope: { type: "organization" },
      items: [conversation], page: {}, _meta: metadata,
    }],
    [parseConversationDetailSnapshot, {
      kind: "conversation_detail",
      conversation: { ...conversation, memberUserIds: [userId] }, _meta: metadata,
    }],
  ];
}

test("named and legacy thread list/detail snapshots retain exact names through JSON", () => {
  for (const visibility of ["public", "private"]) {
    for (const name of [undefined, ...threadNames.valid]) {
      const conversation = { ...conversations[4], visibility, ...(name === undefined ? {} : { name }) };
      for (const [parse, wire] of threadSnapshots(conversation)) {
        const parsed = parse(JSON.parse(JSON.stringify(wire)));
        assert.deepEqual(parsed, wire);
        assert.deepEqual(parse(JSON.parse(JSON.stringify(parsed))), wire);
        const retained = parsed.items?.[0] ?? parsed.conversation;
        assert.equal(Object.hasOwn(retained, "name"), name !== undefined);
        assert.equal(retained.name, name);
      }
    }
  }
});

test("thread snapshots reject every invalid supplied name with the snapshot error contract", () => {
  for (const name of [...threadNames.invalid, undefined]) {
    for (const [parse, wire] of threadSnapshots({ ...conversations[4], name })) {
      assert.throws(() => parse(wire), error =>
        error instanceof ConversationSnapshotParseError && error.code === "malformed_snapshot");
    }
  }
});

test("named thread snapshots retain metadata and current-state invariants", () => {
  const thread = { ...conversations[4], name: "Launch 🚀" };
  const patches = [
    ...["parentConversationId", "rootMessageId"].flatMap(field =>
      [undefined, null, "", 7].map(value => ({ [field]: value }))),
    { visibility: "invited" }, { visibility: null },
    { entity: { type: "project", id: "project-1" } },
    { archivedAt: "invalid" }, { archivedByUserId: "user-other" },
    { currentMember: { ...thread.currentMember, tenantId: "other" } },
    { currentReadState: { ...thread.currentReadState, userId: "other" } },
    { currentPreference: { ...thread.currentPreference, conversationId: "other" } },
  ];
  for (const patch of patches) {
    for (const [parse, wire] of threadSnapshots({ ...thread, ...patch })) {
      assert.throws(() => parse(wire), error =>
        error instanceof ConversationSnapshotParseError && error.code === "malformed_snapshot");
    }
  }
});

const lifecycleFixtures = JSON.parse(await readFile("conformance-tests/thread-lifecycle.json", "utf8"));

test("list/detail lifecycle round trips preserve legacy absence, names, archive and private state", () => {
  for (const threadLifecycle of [undefined, ...lifecycleFixtures.valid]) {
    for (const name of [undefined, "Launch 🚀"]) {
      for (const archived of [false, true]) {
        const conversation = {
          ...conversations[4],
          ...(name === undefined ? {} : { name }),
          ...(threadLifecycle === undefined ? {} : { threadLifecycle }),
          ...(archived ? { archivedAt: now, archivedByUserId: "user-archiver" } : {}),
        };
        for (const [parse, wire] of threadSnapshots(conversation)) {
          const parsed = parse(JSON.parse(JSON.stringify(wire)));
          assert.deepEqual(parsed, wire);
          assert.deepEqual(parse(JSON.parse(JSON.stringify(parsed))), wire);
          assert.equal(Object.hasOwn(parsed.items?.[0] ?? parsed.conversation, "threadLifecycle"), threadLifecycle !== undefined);
        }
      }
    }
  }
});

test("list/detail snapshots reject malformed lifecycle and lifecycle on every non-thread", () => {
  for (const conversation of conversations) {
    const invalid = conversation.type === "thread"
      ? [...lifecycleFixtures.invalid, undefined, { revision: NaN, locked: false }, { revision: Infinity, locked: false }]
      : [...lifecycleFixtures.valid, null, undefined];
    for (const threadLifecycle of invalid) {
      for (const [parse, wire] of threadSnapshots({ ...conversation, threadLifecycle })) {
        assert.throws(() => parse(wire), (error) => error instanceof ConversationSnapshotParseError && error.code === "malformed_snapshot");
      }
    }
  }
});

test("snapshot preference revision round trips zero and stored authority, rejects invalid revisions", () => {
  for (const revision of [undefined, 0, 1, 7, Number.MAX_SAFE_INTEGER]) {
    const snapshot = { kind: "conversation_list", scope: { type: "organization" },
      items: [{ ...conversations[0], currentPreference: { ...conversations[0].currentPreference,
        ...(revision === undefined ? {} : { preferenceRevision: revision }) } }], page: {}, _meta: metadata };
    assert.equal(parseConversationListSnapshot(snapshot).items[0].currentPreference.preferenceRevision, revision);
  }
  for (const revision of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseConversationListSnapshot({
      kind: "conversation_list", scope: { type: "organization" }, page: {}, _meta: metadata,
      items: [{ ...conversations[0], currentPreference: {
        ...conversations[0].currentPreference, preferenceRevision: revision,
      } }],
    }), ConversationSnapshotParseError);
  }
});
