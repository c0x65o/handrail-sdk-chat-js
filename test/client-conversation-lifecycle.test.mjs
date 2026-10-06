import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createNormalizedChatCache,
  deriveCanonicalParticipantIdentity,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-lifecycle";
const userId = "user-actor";
const identity = { tenantId, userId, sessionId: "session-lifecycle" };
const timestamp = "2032-04-05T06:07:08.000Z";
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { conversation_snapshots: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
});

const member = (conversationId, memberUserId, role = "member", state = "active") => ({
  tenantId,
  conversationId,
  userId: memberUserId,
  role,
  state,
  joinedAt: timestamp,
  updatedAt: timestamp,
});

const canonicalMember = (memberUserId, role = "member", state = "active") => ({
  userId: memberUserId,
  role,
  state,
  joinedAt: timestamp,
  updatedAt: timestamp,
});

function summary(id, type = "channel", overrides = {}) {
  return {
    id,
    tenantId,
    type,
    visibility: type === "channel" ? "public" : "private",
    ...(type === "channel" ? { name: `Channel ${id}` } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    latestSequence: 0,
    unreadMentionCount: 0,
    activityAt: timestamp,
    currentMember: member(id, userId, "owner"),
    currentReadState: {
      conversationId: id,
      userId,
      lastReadSequence: 0,
      updatedAt: timestamp,
    },
    ...overrides,
  };
}

function detail(item, memberUserIds = [userId]) {
  return {
    kind: "conversation_detail",
    conversation: {
      ...item,
      memberUserIds,
      activeMemberUserIds: memberUserIds,
      memberListRevision: 1,
      currentPreference: {
        conversationId: item.id,
        userId,
        notificationPreference: "all",
        isStarred: false,
        mute: { muted: false },
        updatedAt: timestamp,
      },
    },
    _meta: metadata,
  };
}

function creationResult(input, id, reconciliationStatus = "created") {
  const item = summary(id, input.type, {
    ...(input.type === "channel"
      ? { name: input.name, visibility: input.visibility }
      : {}),
  });
  const participantUserIds = input.type === "channel"
    ? [userId]
    : [userId, ...input.intendedMemberUserIds].sort();
  return {
    operation: "create_conversation",
    type: input.type,
    reconciliationStatus,
    clientRequestId: input.clientRequestId,
    conversation: detail(item, participantUserIds),
    ...(input.type === "channel"
      ? {}
      : {
          participantIdentity: deriveCanonicalParticipantIdentity(
            userId,
            input.intendedMemberUserIds,
          ),
        }),
  };
}

function membershipResult(input, members, reconciliationStatus = "applied", extra = {}) {
  const targeted = Object.hasOwn(input, "targetUserId");
  return {
    operation: "mutate_conversation_membership",
    intent: input.intent,
    reconciliationStatus,
    conversationId: input.conversationId,
    expectedMemberListRevision: input.expectedMemberListRevision,
    memberListRevision:
      reconciliationStatus === "applied"
        ? input.expectedMemberListRevision + 1
        : reconciliationStatus === "member_list_conflict"
          ? input.expectedMemberListRevision + 2
          : input.expectedMemberListRevision,
    memberUserId: targeted ? input.targetUserId : userId,
    members,
    ...(targeted ? { targetUserId: input.targetUserId } : {}),
    ...(Object.hasOwn(input, "requestedRole")
      ? { requestedRole: input.requestedRole }
      : {}),
    ...extra,
  };
}

test("creation actions deduplicate, retain retry identity, and reuse canonical directs", async () => {
  const cache = createNormalizedChatCache(identity);
  const requests = [];
  let identities = 0;
  let firstChannelAttempt = true;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    conversationLifecycle: {
      generateIdempotencyKey: () => `lifecycle-${++identities}`,
    },
    commands: {
      retry: { maxAttempts: 2, wait: async () => undefined },
    },
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      requests.push({ url, body, idempotencyKey: init.headers["idempotency-key"] });
      if (body.type === "channel" && firstChannelAttempt) {
        firstChannelAttempt = false;
        throw new Error("retryable transport failure");
      }
      const id = body.type === "channel"
        ? "channel-1"
        : body.type === "direct"
          ? "direct-existing"
          : "group-1";
      return response(creationResult(
        body,
        id,
        body.type === "direct" ? "existing_equivalent" : "created",
      ), body.type === "channel" ? 201 : 200);
    },
  });

  const first = client.createChannel({ name: "General", visibility: "public" });
  const duplicate = client.createChannel({ name: "General", visibility: "public" });
  assert.equal(first, duplicate);
  assert.equal((await first).status, "success");
  assert.equal(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(requests[0].body.clientRequestId, requests[1].body.clientRequestId);

  assert.equal((await client.createDirect({
    intendedMemberUserIds: ["user-b"],
  })).status, "success");
  assert.equal((await client.createDirect({
    intendedMemberUserIds: ["user-b"],
  })).status, "success");
  assert.equal((await client.createGroupDirect({
    intendedMemberUserIds: ["user-c", "user-b"],
  })).status, "success");

  assert.deepEqual(
    Object.keys(cache.getState().entities.conversations).sort(),
    ["channel-1", "direct-existing", "group-1"],
  );
  assert.equal(
    Object.keys(cache.getState().metadata.pendingConversationOperations).length,
    0,
  );

  const beforeValidation = requests.length;
  assert.equal((await client.createChannel({
    name: "Untrusted",
    visibility: "private",
    actorUserId: userId,
  })).status, "validation");
  assert.equal(requests.length, beforeValidation);
});

test("archive, restore, and every membership intent reconcile canonical cache state", async () => {
  const conversationId = "conversation-1";
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationDetail(detail(summary(conversationId), [userId, "user-b"]));
  const seenIntents = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      if (input.operation === "set_conversation_archive") {
        return response({
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "applied",
          conversationId,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          lifecycleRevision: input.expectedLifecycleRevision + 1,
          archiveState: input.intent === "archive"
            ? { status: "archived", archivedAt: timestamp, archivedByUserId: userId }
            : { status: "active" },
        });
      }
      seenIntents.push(input.intent);
      const states = input.intent === "leave"
        ? [canonicalMember(userId, "owner", "left"), canonicalMember("user-b", "member")]
        : input.intent === "remove_member"
          ? [canonicalMember(userId, "owner"), canonicalMember("user-b", "member", "removed")]
          : input.intent === "change_member_role"
            ? [canonicalMember(userId, "owner"), canonicalMember("user-b", "moderator")]
            : input.intent === "add_member"
              ? [canonicalMember(userId, "owner"), canonicalMember("user-b", "member")]
              : [canonicalMember(userId, "member"), canonicalMember("user-b", "owner")];
      return response(membershipResult(input, states));
    },
  });

  assert.equal((await client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  })).status, "success");
  assert.equal(cache.getState().entities.conversations[conversationId].archivedByUserId, userId);
  assert.equal(cache.getState().metadata.lifecycleRevisions[conversationId], 2);
  assert.equal((await client.restoreConversation({
    conversationId,
    expectedLifecycleRevision: 2,
  })).status, "success");
  assert.equal(cache.getState().entities.conversations[conversationId].archivedAt, undefined);

  assert.equal((await client.joinConversation({
    conversationId,
    expectedMemberListRevision: 1,
  })).status, "success");
  assert.equal((await client.leaveConversation({
    conversationId,
    expectedMemberListRevision: 2,
  })).status, "success");
  assert.equal(cache.getState().currentUser.memberships[conversationId].state, "left");
  assert.equal((await client.addConversationMember({
    conversationId,
    expectedMemberListRevision: 3,
    targetUserId: "user-b",
    requestedRole: "member",
  })).status, "success");
  assert.equal((await client.removeConversationMember({
    conversationId,
    expectedMemberListRevision: 4,
    targetUserId: "user-b",
  })).status, "success");
  assert.equal((await client.changeConversationMemberRole({
    conversationId,
    expectedMemberListRevision: 5,
    targetUserId: "user-b",
    requestedRole: "moderator",
  })).status, "success");
  assert.deepEqual(seenIntents, [
    "join",
    "leave",
    "add_member",
    "remove_member",
    "change_member_role",
  ]);
  assert.equal(
    cache.getState().entities.membersByConversation[conversationId]["user-b"].role,
    "moderator",
  );
  assert.equal(cache.getState().metadata.memberListRevisions[conversationId], 6);
});

test("lifecycle conflicts, safety rejection, malformed results, and auth failures refresh or roll back safely", async () => {
  const conversationId = "conversation-conflict";
  const cache = createNormalizedChatCache(identity);
  const canonicalDetail = detail(summary(conversationId));
  cache.hydrateConversationDetail(canonicalDetail);
  const requests = [];
  let command = 0;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    commands: { retry: { maxAttempts: 1, maxAuthRefreshes: 0 } },
    async fetch(url, init) {
      requests.push({ url, method: init.method });
      if (init.method === "GET") return response(canonicalDetail);
      const input = JSON.parse(init.body);
      command += 1;
      if (command === 1) {
        return response({
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "lifecycle_conflict",
          conversationId,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          lifecycleRevision: input.expectedLifecycleRevision + 2,
          archiveState: { status: "active" },
        }, 409);
      }
      if (command === 2) {
        return response(membershipResult(
          input,
          [canonicalMember(userId, "owner")],
          "safety_rejected",
          { safetyError: { code: "last_owner", message: "Cannot remove the last owner" } },
        ), 409);
      }
      if (command === 3) return response({ malformed: true });
      return response({
        error: { code: "CHAT_FORBIDDEN", message: "Forbidden", refreshable: false },
      }, 403);
    },
  });

  assert.equal((await client.archiveConversation({
    conversationId,
    expectedLifecycleRevision: 1,
  })).status, "success");
  assert.equal((await client.leaveConversation({
    conversationId,
    expectedMemberListRevision: 1,
  })).status, "success");
  assert.equal((await client.joinConversation({
    conversationId,
    expectedMemberListRevision: 1,
  })).status, "malformed_response");
  assert.equal((await client.removeConversationMember({
    conversationId,
    expectedMemberListRevision: 1,
    targetUserId: "user-b",
  })).status, "rejected");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requests.filter(({ method }) => method === "GET").length >= 3);
  assert.equal(
    Object.keys(cache.getState().metadata.pendingConversationOperations).length,
    0,
  );
  assert.equal(cache.getState().entities.conversations[conversationId].archivedAt, undefined);
});

test("a canonical creation event wins over a late HTTP failure and close settles pending work", async () => {
  const cache = createNormalizedChatCache(identity);
  let rejectRequest;
  let sentBody;
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    commands: { retry: { maxAttempts: 1 } },
    fetch(_url, init) {
      sentBody = JSON.parse(init.body);
      markRequestStarted();
      return new Promise((_resolve, reject) => {
        rejectRequest = reject;
        init.signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
      });
    },
  });

  const pending = client.createChannel({ name: "Events", visibility: "public" });
  await requestStarted;
  cache.applyDurableEvent({
    eventId: "created-event",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: "event-channel",
    type: CHAT_DURABLE_EVENT_TYPES.conversationCreated,
    occurredAt: timestamp,
    payload: {
      clientRequestId: sentBody.clientRequestId,
      conversation: {
        id: "event-channel",
        tenantId,
        type: "channel",
        visibility: "public",
        name: "Events",
        createdAt: timestamp,
        updatedAt: timestamp,
        memberUserIds: [userId],
      },
    },
  });
  rejectRequest(new Error("late failure"));
  assert.equal((await pending).status, "transport");
  assert.equal(cache.getState().entities.conversations["event-channel"].name, "Events");
  assert.equal(
    Object.keys(cache.getState().metadata.pendingConversationOperations).length,
    0,
  );

  const closing = client.archiveConversation({
    conversationId: "event-channel",
    expectedLifecycleRevision: 1,
  });
  await Promise.resolve();
  client.close();
  assert.equal((await closing).status, "closed");
  assert.equal(
    Object.keys(cache.getState().metadata.pendingConversationOperations).length,
    0,
  );
});

test("affected-user private membership events update only current-user membership state", () => {
  const conversationId = "conversation-private-membership";
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationDetail(detail(summary(conversationId), [userId, "user-b"]));
  const input = {
    operation: "mutate_conversation_membership",
    intent: "leave",
    conversationId,
    expectedMemberListRevision: 7,
    idempotencyKey: "private-leave-1",
  };
  const result = membershipResult(input, [
    canonicalMember(userId, "owner", "left"),
    canonicalMember("user-b", "member"),
  ]);
  assert.equal(cache.applyDurableEvent({
    eventId: "private-membership-event",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: `user:${userId}`,
    type: CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
    occurredAt: timestamp,
    payload: { input, result },
  }).status, "applied");
  assert.equal(cache.getState().currentUser.memberships[conversationId].state, "left");
  assert.equal(cache.getState().metadata.memberListRevisions[conversationId], 8);
});

test("membership HTTP and durable-event ordering converges on the newest complete list", async () => {
  const conversationId = "conversation-member-ordering";

  const responseFirstCache = createNormalizedChatCache(identity);
  responseFirstCache.hydrateConversationDetail(
    detail(summary(conversationId), [userId, "user-b"]),
  );
  const responseFirstClient = createChatClient({
    endpoint: "/chat",
    cache: responseFirstCache,
    getAccessToken: () => "token",
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      return response(membershipResult(input, [
        canonicalMember(userId, "member"),
        canonicalMember("user-b", "owner"),
      ]));
    },
  });
  assert.equal((await responseFirstClient.joinConversation({
    conversationId,
    expectedMemberListRevision: 1,
  })).status, "success");
  const laterInput = {
    operation: "mutate_conversation_membership",
    intent: "leave",
    conversationId,
    expectedMemberListRevision: 2,
    idempotencyKey: "later-membership-event",
  };
  assert.equal(responseFirstCache.applyDurableEvent({
    eventId: "membership-event-after-response",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
    occurredAt: timestamp,
    payload: {
      input: laterInput,
      result: membershipResult(laterInput, [
        canonicalMember(userId, "member", "left"),
        canonicalMember("user-b", "owner"),
      ]),
    },
  }).status, "applied");
  assert.equal(responseFirstCache.getState().metadata.memberListRevisions[conversationId], 3);
  assert.equal(responseFirstCache.getState().currentUser.memberships[conversationId].state, "left");

  const eventFirstCache = createNormalizedChatCache(identity);
  eventFirstCache.hydrateConversationDetail(
    detail(summary(conversationId), [userId, "user-b"]),
  );
  let resolveHttp;
  let pendingInput;
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve;
  });
  const eventFirstClient = createChatClient({
    endpoint: "/chat",
    cache: eventFirstCache,
    getAccessToken: () => "token",
    commands: { retry: { maxAttempts: 1 } },
    fetch(_url, init) {
      pendingInput = JSON.parse(init.body);
      markRequestStarted();
      return new Promise((resolve) => {
        resolveHttp = resolve;
      });
    },
  });
  const pending = eventFirstClient.joinConversation({
    conversationId,
    expectedMemberListRevision: 1,
  });
  await requestStarted;
  const newerInput = {
    operation: "mutate_conversation_membership",
    intent: "change_member_role",
    conversationId,
    expectedMemberListRevision: 2,
    idempotencyKey: "newer-membership-event",
    targetUserId: "user-b",
    requestedRole: "owner",
  };
  assert.equal(eventFirstCache.applyDurableEvent({
    eventId: "membership-event-before-response",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
    occurredAt: timestamp,
    payload: {
      input: newerInput,
      result: membershipResult(newerInput, [
        canonicalMember(userId, "owner"),
        canonicalMember("user-b", "owner"),
      ]),
    },
  }).status, "applied");
  resolveHttp(response(membershipResult(pendingInput, [
    canonicalMember(userId, "member"),
    canonicalMember("user-b", "member"),
  ])));
  assert.equal((await pending).status, "success");
  assert.equal(eventFirstCache.getState().metadata.memberListRevisions[conversationId], 3);
  assert.equal(
    eventFirstCache.getState().entities.membersByConversation[conversationId]["user-b"].role,
    "owner",
  );
});

// HTTP-boundary fixtures: these prove discovery/cache behavior, not persistence.
test("two confirmed creations survive stale discovery, scope changes, errors and acknowledgement", async () => {
  const cache = createNormalizedChatCache(identity);
  const scope = { type: "organization" };
  const entity = { type: "project", id: "fixture-project" };
  const entityScope = { type: "entity", entity };
  const entityKey = JSON.stringify(["entity", entity.type, entity.id]);
  const original = ["A", "B", "C"].map(id => ({ ...detail(summary(id)).conversation, hasActiveHuddle: false }));
  const list = (items, selectedScope = scope, nextCursor) => ({
    kind: "conversation_list", scope: selectedScope, items,
    page: nextCursor === undefined ? {} : { nextCursor }, _meta: metadata,
  });
  cache.hydrateConversationList(list(original));
  cache.hydrateConversationList(list([], entityScope));
  let mode = "stale";
  const client = createChatClient({
    endpoint: "https://fixture.test/chat", getAccessToken: () => "fixture-only",
    cache, realtime: false, commands: { retry: { maxAttempts: 1 } },
    async fetch(url, init) {
      if (init.method === "POST") {
        const input = JSON.parse(init.body);
        if (input.name === "failed") return response({}, 503);
        const result = creationResult(input, input.name);
        if (input.entity) result.conversation.conversation.entity = input.entity;
        return response(result, 201);
      }
      if (String(url).endsWith("/D")) return mode === "denied" ? response({}, 404) : response(detail(summary("D")));
      if (mode === "offline") return response({}, 503);
      return response(list(original));
    },
  });
  const ids = () => cache.getState().metadata.conversationLists.organization.conversationIds;
  try {
    for (const name of ["D", "E"]) {
      assert.equal((await client.createChannel({ name, visibility: "private", ...(name === "E" ? { entity } : {}) })).status, "success");
    }
    assert.deepEqual([...ids()].sort(), ["A", "B", "C", "D", "E"]);
    assert.deepEqual(ids(), ["C", "B", "A", "E", "D"], "navigation rank, newest activity and id ordering");
    assert.deepEqual(cache.getState().metadata.conversationLists[entityKey].conversationIds, ["E"]);
    const unrelated = { type: "entity", entity: { ...entity, id: "unrelated" } };
    cache.hydrateConversationList(list([], unrelated));
    assert.deepEqual(cache.getState().metadata.conversationLists[JSON.stringify(["entity", entity.type, "unrelated"])].conversationIds, []);
    await client.listConversations({ scope });
    assert.deepEqual([...ids()].sort(), ["A", "B", "C", "D", "E"]);
    mode = "offline";
    assert.equal((await client.listConversations({ scope })).status, "transport");
    assert.notEqual((await client.createChannel({ name: "failed", visibility: "private" })).status, "success");
    assert.deepEqual([...ids()].sort(), ["A", "B", "C", "D", "E"]);
    assert.equal((await client.getConversation({ conversationId: "D" })).status, "success");
    cache.hydrateMessageTimeline({ conversationId: "D", messages: [{
      id: "D-message", tenantId, conversationId: "D", author: { type: "user", userId }, sequence: 1,
      createdAt: timestamp, updatedAt: timestamp, revision: { revision: 1 }, content: { format: "plain", text: "Independent history" },
      isThreadRoot: false, reactions: [], attachmentMetadata: [],
    }], pagination: { older: { available: false }, newer: { available: false } }, replay: { resumeFrom: { eventId: "event-D" } } });
    // Independent detail hydration must never leak into navigation.
    cache.hydrateConversationDetail(detail(summary("detail-only")));
    assert.equal(ids().includes("detail-only"), false);
    const created = id => ({ ...detail(summary(id, "channel", { visibility: "private" })).conversation, hasActiveHuddle: false });
    cache.hydrateConversationList(list([...original, created("D")], scope, "page-2"));
    assert.deepEqual(cache.getState().metadata.conversationLists.organization.pendingCreatedIds, ["E"]);
    assert.equal(cache.getState().metadata.conversationLists.organization.nextCursor, "page-2");
    cache.hydrateConversationList(list([created("D"), created("E")]), { requestCursor: "page-2" });
    assert.equal(ids().length, 5);
    assert.deepEqual(cache.getState().metadata.conversationLists.organization.pendingCreatedIds, []);
    assert.equal(cache.getState().metadata.conversationLists.organization.nextCursor, undefined);
    // Once discovery acknowledged a creation, authoritative omission can remove it.
    cache.hydrateConversationList(list(original), { replacePages: true });
    assert.deepEqual(ids(), ["A", "B", "C"]);
    assert.ok(cache.getState().entities.conversations.D);
    assert.ok(cache.getState().metadata.conversationDetails.D);
    assert.deepEqual(cache.getState().timelines.D.messageIds, ["D-message"]);
    assert.equal(cache.getState().entities.messages["D-message"].content.text, "Independent history");
    // A pending creation with an explicit access denial must also be removed.
    assert.equal((await client.createChannel({ name: "D", visibility: "private" })).status, "success");
    mode = "denied";
    assert.equal((await client.getConversation({ conversationId: "D" })).httpStatus, 404);
    assert.equal(ids().includes("D"), false);
    assert.equal(cache.getState().metadata.conversationLists.organization.pendingCreatedIds.includes("D"), false);
    cache.setIdentity({ ...identity, userId: "another-user", sessionId: "another-session" });
    assert.deepEqual(cache.getState().metadata.conversationLists, {});
  } finally { client.close(); }
});


test("a delayed creation result cannot populate a replacement identity or session", async () => {
  for (const replacement of [{ ...identity, sessionId: "replacement" }, { ...identity, userId: "replacement" }]) {
    const cache = createNormalizedChatCache(identity);
    let finish;
    const client = createChatClient({
      endpoint: "/chat", cache, realtime: false, getAccessToken: () => "fixture-only",
      fetch: (_url, init) => new Promise(resolve => { finish = () => resolve(response(creationResult(JSON.parse(init.body), "late"), 201)); }),
    });
    try {
      const pending = client.createChannel({ name: "late", visibility: "private" });
      for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setImmediate(resolve));
      assert.ok(finish);
      cache.setIdentity(replacement);
      finish();
      await pending;
      assert.deepEqual(cache.getState().metadata.conversationLists, {});
      assert.deepEqual(cache.getState().entities.conversations, {});
    } finally { client.close(); }
  }
});
