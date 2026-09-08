import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createNormalizedChatCache,
  selectConversationUnreadCount,
  selectDirectMessageOtherUserRead,
  selectFirstUnreadMessage,
  selectFirstUnreadSequence,
  selectManualUnreadFromSequence,
} from "../dist/client/index.js";
import {
  CHAT_PROTOCOL_VERSION,
  createReadCursorUpdatedEvent,
} from "../dist/index.js";

const tenantId = "tenant-read-client";
const userId = "reader-client";
const conversationId = "conversation-read-client";
const directId = "conversation-direct-client";
const identity = { tenantId, userId, sessionId: "session-read-client" };
const at = (second) =>
  `2030-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

const metadata = {
  packageVersion: "0.1.3",
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
};

const summary = (id, type, latestSequence, lastReadSequence) => ({
  id,
  tenantId,
  type,
  visibility: type === "direct" ? "private" : "public",
  ...(type === "channel" ? { name: "Read state" } : {}),
  createdAt: at(0),
  updatedAt: at(0),
  latestSequence,
  unreadMentionCount: 0,
  activityAt: at(0),
  activeMemberUserIds: [userId, "other-user"],
  currentMember: {
    tenantId,
    conversationId: id,
    userId,
    role: "member",
    state: "active",
    joinedAt: at(0),
    updatedAt: at(0),
  },
  currentReadState: {
    conversationId: id,
    userId,
    lastReadSequence,
    updatedAt: at(0),
  },
  currentPreference: {
    conversationId: id,
    userId,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: at(0),
  },
});

const message = (id, sequence, overrides = {}) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: "other-user" },
  sequence,
  createdAt: at(sequence),
  updatedAt: at(sequence),
  revision: { revision: 1 },
  content: { format: "plain", text: id },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
  ...overrides,
});

const seedCache = ({ latestSequence = 5, lastReadSequence = 1 } = {}) => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [
      summary(conversationId, "channel", latestSequence, lastReadSequence),
      summary(directId, "direct", 5, 1),
    ],
    page: {},
    _meta: metadata,
  });
  if (latestSequence >= 3) {
    cache.hydrateMessageTimeline({
      conversationId,
      messages: [message("message-1", 1), message("message-2", 2), message("message-3", 3)],
      pagination: { older: { available: false }, newer: { available: true, cursor: 3 } },
      replay: { resumeFrom: { eventId: "timeline-read" } },
    });
  }
  return cache;
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const result = (operation, sequence, second, overrides = {}) => ({
  operation,
  conversationId,
  readState: {
    conversationId,
    userId,
    lastReadSequence: sequence,
    updatedAt: at(second),
    ...(operation === "mark_unread" ? { manualUnreadFromSequence: 2 } : {}),
    ...overrides,
  },
  latestSequence: 5,
  unreadCount:
    operation === "mark_unread" ? 4 : Math.max(0, 5 - sequence),
});

test("exports derived unread selectors and keeps DM receipts cursor-only and private", () => {
  const cache = seedCache({ latestSequence: 3, lastReadSequence: 1 });
  const before = cache.getState();
  assert.equal(selectConversationUnreadCount(before, conversationId), 2);
  assert.equal(selectFirstUnreadSequence(before, conversationId), 2);
  assert.equal(selectFirstUnreadMessage(before, conversationId).id, "message-2");
  assert.equal(selectManualUnreadFromSequence(before, conversationId), undefined);

  const otherCursor = {
    conversationId: directId,
    userId: "other-user",
    lastReadSequence: 4,
    updatedAt: at(4),
  };
  assert.equal(selectDirectMessageOtherUserRead(cache.getState(), {
    conversationId: directId,
    otherMemberReadState: otherCursor,
    messageSequence: 4,
  }), true);
  assert.equal(selectDirectMessageOtherUserRead(cache.getState(), {
    conversationId: directId,
    otherMemberReadState: otherCursor,
    messageSequence: 5,
  }), false);
  assert.equal(selectDirectMessageOtherUserRead(cache.getState(), {
    conversationId,
    otherMemberReadState: { ...otherCursor, conversationId },
    messageSequence: 1,
  }), undefined, "channels never expose other-reader state");
  assert.equal(cache.getState().currentUser.readStates[directId].userId, userId);
  assert.equal(JSON.stringify(cache.getState()).includes("other-user\",\"lastReadSequence\":4"), false);

  const readState = cache.getState().currentUser.readStates[conversationId];
  const {
    isThreadRoot: _isThreadRoot,
    reactions: _reactions,
    attachmentMetadata: _attachmentMetadata,
    ...editedMessage
  } = message("message-2", 2, {
    updatedAt: at(4),
    revision: { revision: 2, editedAt: at(4), editedByUserId: "other-user" },
    content: { format: "plain", text: "edited" },
  });
  cache.applyDurableEvent({
    eventId: "message-edit-read-invariant",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.messageUpdated,
    occurredAt: at(4),
    payload: {
      message: editedMessage,
    },
  });
  assert.equal(cache.getState().currentUser.readStates[conversationId], readState);
  assert.equal(selectConversationUnreadCount(cache.getState(), conversationId), 2);
});

test("markRead is monotonic, optimistic, coalesced, and uses one stable logical key", async () => {
  const cache = seedCache();
  const requests = [];
  let release;
  let key = 0;
  const client = createChatClient({
    endpoint: "/api/chat",
    getAccessToken: () => "token",
    cache,
    readState: { generateIdempotencyKey: () => `read-key-${++key}` },
    fetch(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const first = client.markRead({ conversationId, throughSequence: 3 });
  const second = client.markRead({ conversationId, throughSequence: 5 });
  assert.equal(cache.getState().currentUser.readStates[conversationId].lastReadSequence, 5);
  assert.equal(selectConversationUnreadCount(cache.getState(), conversationId), 0);
  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/chat/conversations/${conversationId}/read-cursor`);
  assert.equal(requests[0].body.throughSequence, 5);
  assert.equal(requests[0].body.idempotencyKey, "read-key-1");
  assert.equal(requests[0].init.headers["idempotency-key"], "read-key-1");
  release(response(result("mark_read", 5, 5)));
  assert.equal((await first).status, "success");
  assert.equal((await second).status, "success");

  assert.equal((await client.markRead({
    conversationId,
    throughSequence: 4,
  })).status, "validation");
  assert.equal(requests.length, 1);
  client.close();
});

test("manual unread is explicit, rolls back on rejection, and is cleared by read intent", async () => {
  const cache = seedCache({ lastReadSequence: 5 });
  const bodies = [
    response({ error: { code: "READ_CURSOR_SEQUENCE_CONFLICT", message: "stale" } }, 409),
    response(result("mark_unread", 5, 6)),
    response(result("mark_read", 5, 7)),
  ];
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    readState: { generateIdempotencyKey: (() => { let key = 0; return () => `manual-${++key}`; })() },
    fetch: async () => bodies.shift(),
  });

  const rejected = client.markUnread({ conversationId, fromSequence: 2 });
  assert.equal(selectManualUnreadFromSequence(cache.getState(), conversationId), 2);
  assert.equal(selectConversationUnreadCount(cache.getState(), conversationId), 4);
  assert.equal((await rejected).status, "conflict");
  assert.equal(selectManualUnreadFromSequence(cache.getState(), conversationId), undefined);

  assert.equal((await client.markUnread({ conversationId, fromSequence: 2 })).status, "success");
  assert.equal(selectFirstUnreadSequence(cache.getState(), conversationId), 2);
  const clear = client.markRead({ conversationId, throughSequence: 5 });
  assert.equal(selectManualUnreadFromSequence(cache.getState(), conversationId), undefined);
  assert.equal((await clear).status, "success");
  assert.equal((await client.markUnread({ conversationId, fromSequence: 6 })).status, "validation");
  client.close();
});

test("cross-device events win over stale HTTP responses and older failures", async () => {
  for (const settle of ["success", "failure"]) {
    const cache = seedCache();
    let release;
    const client = createChatClient({
      endpoint: "/chat",
      getAccessToken: () => "token",
      cache,
      readState: { generateIdempotencyKey: () => `ordering-${settle}` },
      fetch: () => new Promise((resolve) => { release = resolve; }),
    });
    const pending = client.markRead({ conversationId, throughSequence: 3 });
    await new Promise(setImmediate);
    const crossDevice = result("mark_read", 4, 8);
    cache.applyDurableEvent(createReadCursorUpdatedEvent({
      eventId: `cross-device-${settle}`,
      protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId,
      occurredAt: at(8),
      result: crossDevice,
    }));
    assert.equal(cache.getState().currentUser.readStates[conversationId].lastReadSequence, 4);

    release(settle === "success"
      ? response(result("mark_read", 3, 3))
      : response({ error: { code: "READ_CURSOR_SEQUENCE_CONFLICT", message: "older" } }, 409));
    assert.equal((await pending).status, settle === "success" ? "success" : "conflict");
    assert.equal(cache.getState().currentUser.readStates[conversationId].lastReadSequence, 4);
    assert.equal(selectConversationUnreadCount(cache.getState(), conversationId), 1);
    client.close();
  }
});

test("close resolves queued read work and restores the last canonical state", async () => {
  const cache = seedCache();
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    readState: { generateIdempotencyKey: () => "closing-read" },
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const pending = client.markRead({ conversationId, throughSequence: 4 });
  assert.equal(cache.getState().currentUser.readStates[conversationId].lastReadSequence, 4);
  await new Promise(setImmediate);
  client.close();
  assert.equal((await pending).status, "closed");
  assert.equal(cache.getState().currentUser.readStates[conversationId].lastReadSequence, 1);
});
