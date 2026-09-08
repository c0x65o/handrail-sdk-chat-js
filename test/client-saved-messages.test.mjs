import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventReductionError,
  createChatClient,
  createNormalizedChatCache,
  reduceDurableChatEvent,
  selectCurrentUserSavedMessageState,
  selectCurrentUserSavedMessages,
  selectIsCurrentUserMessageSaved,
  selectMessage,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-saved-client";
const userId = "user-saved-client";
const conversationId = "conversation-saved-client";
const messageId = "message-saved-client";
const identity = { tenantId, userId, sessionId: "session-saved-client" };
const at = (second) =>
  `2038-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;
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

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const detail = (type = "channel") => ({
  kind: "conversation_detail",
  conversation: {
    id: conversationId,
    tenantId,
    type,
    visibility: type === "channel" ? "public" : "private",
    ...(type === "channel" ? { name: "Saved client" } : {}),
    createdAt: at(0),
    updatedAt: at(0),
    latestSequence: 1,
    activityAt: at(0),
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: "member",
      state: "active",
      joinedAt: at(0),
      updatedAt: at(0),
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: 0,
      updatedAt: at(0),
    },
    memberUserIds: [userId],
    currentPreference: {
      conversationId,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: at(0),
    },
  },
  _meta: metadata,
});

const timelineMessage = (overrides = {}) => ({
  id: messageId,
  tenantId,
  conversationId,
  author: { type: "user", userId: "user-author" },
  sequence: 1,
  createdAt: at(0),
  updatedAt: at(0),
  revision: { revision: 1 },
  content: { format: "plain", text: "content that must be removed" },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
  ...overrides,
});

const seed = (type = "channel") => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationDetail(detail(type));
  cache.hydrateMessageTimeline({
    conversationId,
    messages: [timelineMessage()],
    pagination: {
      older: { available: false },
      newer: { available: false },
    },
    replay: { resumeFrom: { eventId: "saved-snapshot" } },
  });
  return cache;
};

const canonicalResult = (input, overrides = {}) => {
  const isSaved = input.intent === "save";
  return {
    operation: "set_saved_message",
    intent: input.intent,
    reconciliationStatus: "applied",
    messageId: input.messageId,
    expectedSavedMessageRevision: input.expectedSavedMessageRevision,
    idempotencyKey: input.idempotencyKey,
    savedMessageRevision: input.expectedSavedMessageRevision + 1,
    savedMessage: {
      messageId: input.messageId,
      isSaved,
      ...(isSaved && input.privateNote !== undefined
        ? { privateNote: input.privateNote }
        : {}),
    },
    ...overrides,
  };
};

const savedEvent = (eventId, revision, savedMessage, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId: overrides.tenantId ?? tenantId,
  streamId: overrides.streamId ?? `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.savedMessageUpdated,
  occurredAt: overrides.occurredAt ?? at(10 + revision),
  payload: {
    operation: "set_saved_message",
    messageId: savedMessage.messageId,
    savedMessageRevision: revision,
    savedMessage,
  },
});

const flush = () => new Promise(setImmediate);

for (const [clock, occurredAt] of [["tied", at(20)], ["decreasing", at(19)]]) {
  test(`saved messages reconcile independently at ${clock} stream clocks`, () => {
    const cache = seed();
    const secondMessageId = "message-saved-second";
    const first = savedEvent("saved-first", 1, { messageId, isSaved: true }, {
      occurredAt: at(20),
    });
    const second = savedEvent("saved-second", 1, {
      messageId: secondMessageId, isSaved: true,
    }, { occurredAt });

    for (const event of [first, second]) {
      assert.equal(cache.applyDurableEvent(event).status, "applied");
      const state = cache.getState();
      assert.equal(state.currentUser.savedMessageRevisions[event.payload.messageId], 1);
      assert.deepEqual(state.currentUser.savedMessages[event.payload.messageId], event.payload.savedMessage);
      assert.deepEqual(state.metadata.realtimeCursor, { eventId: event.eventId });
      assert.equal(state.metadata.durableStreams[event.streamId].lastEventId, event.eventId);
      assert.equal(state.metadata.durableStreams[event.streamId].lastOccurredAt, at(20));
    }
    assert.deepEqual(cache.getState().currentUser.savedMessageRevisions, {
      [messageId]: 1, [secondMessageId]: 1,
    });
    const beforeReplay = cache.getState();
    for (const event of [first, second]) {
      assert.equal(cache.applyDurableEvent(event).status, "duplicate");
      assert.equal(cache.getState(), beforeReplay);
    }

    const newer = savedEvent("saved-newer", 2, { messageId, isSaved: false }, { occurredAt });
    assert.equal(cache.applyDurableEvent(newer).status, "applied");
    const canonical = cache.getState().currentUser;
    for (const event of [
      savedEvent("saved-stale-revision", 1, { messageId, isSaved: true }, { occurredAt }),
      savedEvent("saved-equal-revision", 2, { messageId, isSaved: false }, { occurredAt }),
    ]) {
      assert.equal(cache.applyDurableEvent(event).status, "applied");
      assert.deepEqual(cache.getState().currentUser, canonical);
      assert.equal(cache.getState().currentUser.savedMessageRevisions[messageId], 2);
      assert.deepEqual(cache.getState().currentUser.savedMessages[messageId], { messageId, isSaved: false });
      assert.deepEqual(cache.getState().metadata.realtimeCursor, { eventId: event.eventId });
      assert.equal(cache.getState().metadata.durableStreams[event.streamId].lastOccurredAt, at(20));
      const before = cache.getState();
      assert.equal(cache.applyDurableEvent(event).status, "duplicate");
      assert.equal(cache.getState(), before);
    }
  });

  for (const [invalidCase, overrides, payload, code] of [
    ["conflicting equal revision", {}, { savedMessage: { messageId, isSaved: false } }, "incoherent_payload"],
    ["malformed payload", {}, { savedMessageRevision: "2" }, "incoherent_payload"],
    ["wrong private stream", { streamId: "user:someone-else" }, {}, "private_stream_mismatch"],
    ["wrong tenant", { tenantId: "tenant-other" }, {}, "tenant_mismatch"],
  ]) {
    test(`saved-message ${invalidCase} is atomic at ${clock} stream clocks`, () => {
      const cache = seed();
      cache.applyDurableEvent(savedEvent("saved-valid", 1, {
        messageId, isSaved: true,
      }, { occurredAt: at(20) }));
      const event = savedEvent("saved-invalid", 1, { messageId, isSaved: true }, {
        occurredAt, ...overrides,
      });
      Object.assign(event.payload, payload);
      const before = cache.getState();
      const snapshot = structuredClone(before);
      const expectedError = (error) => error instanceof DurableEventReductionError &&
        error.diagnostic.code === code;
      assert.throws(() => cache.applyDurableEvent(event), expectedError);
      assert.equal(cache.getState(), before);
      assert.deepEqual(before, snapshot);
      assert.deepEqual(cache.getState().metadata.realtimeCursor, { eventId: "saved-valid" });

      // Give even the wrong private stream a clock so admission cannot mask its guard.
      const callerState = structuredClone(before);
      callerState.metadata.durableStreams[event.streamId] = structuredClone(
        before.metadata.durableStreams[`user:${userId}`],
      );
      const callerSnapshot = structuredClone(callerState);
      assert.throws(() => reduceDurableChatEvent(callerState, event), expectedError);
      assert.deepEqual(callerState, callerSnapshot);
    });
  }
}

test("save and unsave project synchronously, retry safely, and redact private notes from diagnostics", async () => {
  const cache = seed();
  const requests = [];
  const diagnostics = [];
  const privateNote = "never-log-this-actor-private-note";
  let transient = true;
  let key = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    savedMessages: {
      generateIdempotencyKey: () => `saved-key-${++key}`,
    },
    commands: {
      retry: { maxAttempts: 2, wait: async () => undefined },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    async fetch(url, init) {
      const input = JSON.parse(init.body);
      requests.push({ url, input, key: init.headers["idempotency-key"] });
      if (transient) {
        transient = false;
        throw new Error(privateNote);
      }
      return response(canonicalResult(input));
    },
  });

  const saving = client.saveMessage({ messageId, privateNote });
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), true);
  assert.equal(
    selectCurrentUserSavedMessageState(cache.getState(), messageId).pending.state,
    "pending",
  );
  assert.equal((await saving).status, "success");
  assert.equal(requests[0].url, `/chat/messages/${messageId}/saved`);
  assert.equal(requests[0].key, "saved-key-1");
  assert.equal(requests[1].key, "saved-key-1");
  assert.deepEqual(requests[0].input, requests[1].input);
  assert.equal(JSON.stringify(diagnostics).includes(privateNote), false);

  assert.equal((await client.unsaveMessage({ messageId })).status, "success");
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), false);
  assert.equal(
    selectCurrentUserSavedMessageState(cache.getState(), messageId)
      .authoritativeRevision,
    2,
  );
  assert.equal(selectCurrentUserSavedMessages(cache.getState()).length, 0);
});

test("explicit retry reuses the exact original idempotency key, revision, and private request", async () => {
  const cache = seed();
  const requests = [];
  let fail = true;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    savedMessages: { generateIdempotencyKey: () => "stable-retry-key" },
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      requests.push({ input, key: init.headers["idempotency-key"] });
      if (fail) {
        fail = false;
        throw new Error("transport detail must remain private");
      }
      return response(canonicalResult(input));
    },
  });

  assert.equal((await client.saveMessage({ messageId, privateNote: "retry-note" })).status, "transport");
  const failed = selectCurrentUserSavedMessageState(cache.getState(), messageId);
  assert.equal(failed.pending.state, "failed");
  assert.equal(failed.pending.retryable, true);
  assert.equal((await client.retrySavedMessage(messageId)).status, "success");
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(
    selectCurrentUserSavedMessageState(cache.getState(), messageId).pending,
    undefined,
  );
});

test("a private durable event before the HTTP response converges without regressing the optimistic projection", async () => {
  const cache = seed();
  let request;
  let release;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    savedMessages: { generateIdempotencyKey: () => "event-first-key" },
    async fetch(_url, init) {
      request = JSON.parse(init.body);
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const pending = client.saveMessage({ messageId, privateNote: "private" });
  await flush();
  const canonical = canonicalResult(request);
  cache.applyDurableEvent(savedEvent("saved-before-http", 1, canonical.savedMessage));
  const eventFirst = selectCurrentUserSavedMessageState(cache.getState(), messageId);
  assert.equal(eventFirst.savedMessage.isSaved, true);
  assert.equal(eventFirst.authoritativeRevision, 1);
  assert.equal(eventFirst.pending.idempotencyKey, "event-first-key");
  release(response(canonical));
  assert.equal((await pending).status, "success");
  const settled = selectCurrentUserSavedMessageState(cache.getState(), messageId);
  assert.equal(settled.pending, undefined);
  assert.equal(settled.authoritativeRevision, 1);
  assert.equal(settled.message.availability, "available");
});

test("deleted and inaccessible saved messages lose content and private notes but retain safe reconciliation metadata", () => {
  const deletedCache = seed();
  deletedCache.applyDurableEvent(savedEvent("saved-for-delete", 1, {
    messageId,
    isSaved: true,
    privateNote: "delete-secret",
  }));
  deletedCache.applyDurableEvent({
    eventId: "delete-saved-message",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.messageDeleted,
    occurredAt: at(20),
    payload: {
      message: {
        id: messageId,
        tenantId,
        conversationId,
        author: { type: "user", userId: "user-author" },
        sequence: 1,
        createdAt: at(0),
        updatedAt: at(20),
        revision: {
          revision: 2,
          editedAt: at(20),
          editedByUserId: userId,
        },
        content: null,
        deletedAt: at(20),
        deletedByUserId: userId,
      },
    },
  });
  const deleted = selectCurrentUserSavedMessageState(
    deletedCache.getState(),
    messageId,
  );
  assert.deepEqual(deleted.savedMessage, { messageId, isSaved: true });
  assert.equal(deleted.authoritativeRevision, 1);
  assert.deepEqual(deleted.message, {
    availability: "unavailable",
    reason: "deleted",
  });
  assert.equal(selectMessage(deletedCache.getState(), messageId).content, null);

  const inaccessibleCache = seed("direct");
  inaccessibleCache.applyDurableEvent(savedEvent("saved-before-leave", 1, {
    messageId,
    isSaved: true,
    privateNote: "membership-secret",
  }));
  const input = {
    operation: "mutate_conversation_membership",
    intent: "leave",
    conversationId,
    expectedMemberListRevision: 1,
    idempotencyKey: "leave-private-conversation",
  };
  inaccessibleCache.applyDurableEvent({
    eventId: "private-membership-left",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: `user:${userId}`,
    type: CHAT_DURABLE_EVENT_TYPES.membershipUpdated,
    occurredAt: at(21),
    payload: {
      input,
      result: {
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: "applied",
        conversationId,
        expectedMemberListRevision: 1,
        memberListRevision: 2,
        memberUserId: userId,
        members: [{
          userId,
          role: "member",
          state: "left",
          joinedAt: at(0),
          updatedAt: at(21),
        }],
      },
    },
  });
  const inaccessible = selectCurrentUserSavedMessageState(
    inaccessibleCache.getState(),
    messageId,
  );
  assert.deepEqual(inaccessible.savedMessage, { messageId, isSaved: true });
  assert.deepEqual(inaccessible.message, {
    availability: "unavailable",
    reason: "inaccessible",
  });
  assert.equal(selectMessage(inaccessibleCache.getState(), messageId), undefined);
});

test("authorization rollback and identity/private-stream checks isolate saved state", async () => {
  const cache = seed();
  const diagnostics = [];
  const privateNote = "do-not-render-auth-note";
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    savedMessages: { generateIdempotencyKey: () => "unauthorized-key" },
    commands: {
      retry: { maxAttempts: 1 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
    async fetch() {
      return response({ error: { code: "FORBIDDEN", message: privateNote } }, 403);
    },
  });
  const pending = client.saveMessage({ messageId, privateNote });
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), true);
  const failure = await pending;
  assert.equal(failure.status, "authentication");
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), undefined);
  assert.equal(JSON.stringify(failure).includes(privateNote), false);
  assert.equal(JSON.stringify(diagnostics).includes(privateNote), false);

  cache.applyDurableEvent(savedEvent("saved-before-identity-change", 1, {
    messageId,
    isSaved: true,
    privateNote: "old-user-note",
  }));
  cache.setIdentity({ tenantId, userId: "user-next", sessionId: "session-next" });
  assert.deepEqual(cache.getState().currentUser.savedMessages, {});
  assert.deepEqual(cache.getState().currentUser.savedMessageRevisions, {});
  const before = cache.getState();
  assert.throws(
    () => cache.applyDurableEvent(savedEvent(
      "wrong-private-user",
      2,
      { messageId, isSaved: true, privateNote: "must-not-leak" },
      { streamId: `user:${userId}`, occurredAt: at(30) },
    )),
    (error) => error instanceof DurableEventReductionError,
  );
  assert.equal(cache.getState(), before);
});

test("revision conflicts adopt authoritative state and close removes only local pending projection", async () => {
  const cache = seed();
  let call = 0;
  let release;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    savedMessages: {
      generateIdempotencyKey: () => `conflict-close-${++call}`,
    },
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      if (call === 1) {
        return response(canonicalResult(input, {
          reconciliationStatus: "saved_message_revision_conflict",
          savedMessageRevision: 4,
          savedMessage: { messageId, isSaved: false },
        }), 409);
      }
      return new Promise((resolve) => { release = resolve; });
    },
  });

  assert.equal((await client.saveMessage({ messageId })).status, "success");
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), false);
  assert.equal(
    selectCurrentUserSavedMessageState(cache.getState(), messageId)
      .authoritativeRevision,
    4,
  );

  const pending = client.saveMessage({ messageId, privateNote: "close-private" });
  await flush();
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), true);
  client.close();
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), false);
  assert.equal(
    selectCurrentUserSavedMessageState(cache.getState(), messageId).pending,
    undefined,
  );
  release(response({ error: { code: "CLOSED" } }, 503));
  assert.equal((await pending).status, "closed");
  assert.equal(selectIsCurrentUserMessageSaved(cache.getState(), messageId), false);
});

test("canonical cross-tab hydration accepts only the exact trusted cache identity", () => {
  const source = seed();
  source.applyDurableEvent(savedEvent("saved-cross-tab", 1, {
    messageId,
    isSaved: true,
    privateNote: "same-user-private-note",
  }));
  const envelope = JSON.parse(JSON.stringify(source.getState()));

  const matching = createNormalizedChatCache(identity);
  assert.equal(matching.hydrateCanonicalState(envelope), true);
  assert.equal(
    selectCurrentUserSavedMessageState(matching.getState(), messageId)
      .savedMessage.privateNote,
    "same-user-private-note",
  );

  const otherUser = createNormalizedChatCache({
    tenantId,
    userId: "user-cross-tab-other",
    sessionId: "session-cross-tab-other",
  });
  assert.equal(otherUser.hydrateCanonicalState(envelope), false);
  assert.deepEqual(otherUser.getState().currentUser.savedMessages, {});
});
