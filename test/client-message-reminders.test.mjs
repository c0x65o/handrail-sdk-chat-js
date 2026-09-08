import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventReductionError,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserMessageReminderState,
  selectCurrentUserMessageReminders,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-reminder-client";
const userId = "user-reminder-client";
const conversationId = "conversation-reminder-client";
const messageId = "message-reminder-client";
const identity = { tenantId, userId, sessionId: "session-reminder-client" };
const due = (day) => `2099-01-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const occurredAt = "2038-01-02T03:04:05.000Z";
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const flush = () => new Promise(setImmediate);

const canonicalResult = (input, overrides = {}) => ({
  operation: input.operation,
  intent: input.intent,
  reconciliationStatus: "applied",
  conversationId: input.conversationId,
  messageId: input.messageId,
  expectedReminderRevision: input.expectedReminderRevision,
  idempotencyKey: input.idempotencyKey,
  reminderRevision: input.expectedReminderRevision + 1,
  reminder: input.intent === "set"
    ? { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: input.dueAt }
    : { privacy: "affected_authenticated_actor", state: "cancelled" },
  ...overrides,
});

const event = (eventId, revision, reminder, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: `user:${userId}`,
  type: CHAT_DURABLE_EVENT_TYPES.messageReminderUpdated,
  occurredAt,
  ...overrides,
  payload: {
    operation: "message_reminder.v1",
    conversationId,
    messageId,
    reminderRevision: revision,
    reminder,
    ...overrides.payload,
  },
});

for (const [clock, secondOccurredAt] of [
  ["tied", occurredAt],
  ["decreasing", "2038-01-02T03:04:04.999Z"],
]) {
  test(`independent reminder revisions advance replay with ${clock} clocks`, () => {
    const cache = createNormalizedChatCache(identity);
    const firstReminder = { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: due(1) };
    const secondReminder = { ...firstReminder, dueAt: due(2) };
    const secondMessageId = "message-reminder-second";
    const first = event("reminder-first", 1, firstReminder);
    const second = event("reminder-second", 1, secondReminder, {
      occurredAt: secondOccurredAt,
      payload: { messageId: secondMessageId },
    });
    assert.equal(cache.applyDurableEvent(first).status, "applied");
    assert.deepEqual(cache.getState().metadata.realtimeCursor, { eventId: first.eventId });
    assert.equal(cache.applyDurableEvent(second).status, "applied");
    const state = cache.getState();
    assert.deepEqual(state.currentUser.messageReminderRevisions, { [messageId]: 1, [secondMessageId]: 1 });
    assert.deepEqual(state.currentUser.messageReminders, { [messageId]: firstReminder, [secondMessageId]: secondReminder });
    assert.deepEqual(state.metadata.realtimeCursor, { eventId: second.eventId });
    assert.deepEqual(state.metadata.durableStreams[`user:${userId}`], {
      lastEventId: second.eventId,
      lastOccurredAt: occurredAt,
      recentEventIds: [first.eventId, second.eventId],
    });
    assert.equal(cache.applyDurableEvent(second).status, "duplicate");
    assert.equal(cache.getState(), state);
  });
}

test("reminder revisions prevent older canonical state from overwriting newer state", () => {
  const cache = createNormalizedChatCache(identity);
  const reminder = { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: due(3) };
  cache.applyDurableEvent(event("reminder-newer", 2, reminder));
  const canonical = cache.getState().currentUser;
  for (const clock of [occurredAt, "2038-01-02T03:04:04.999Z", "2038-01-02T03:04:06.000Z"]) {
    const older = event(`reminder-older-${clock}`, 1, { ...reminder, dueAt: due(1) }, { occurredAt: clock });
    assert.equal(cache.applyDurableEvent(older).status, "applied");
    assert.deepEqual(cache.getState().currentUser, canonical);
    assert.deepEqual(cache.getState().metadata.realtimeCursor, { eventId: older.eventId });
  }
});

test("invalid reminder events leave the entire cache and replay metadata unchanged", () => {
  const cache = createNormalizedChatCache(identity);
  const reminder = { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: due(3) };
  cache.applyDurableEvent(event("reminder-canonical", 2, reminder));
  const before = cache.getState();
  const snapshot = structuredClone(before);
  const invalid = [
    ["equal-conflict", 2, { ...reminder, dueAt: due(4) }, {}, "incoherent_payload"],
    ["malformed", 3, { ...reminder, dueAt: "invalid" }, {}, "incoherent_payload"],
    ["malformed-payload", 3, reminder, { payload: { messageId: null } }, "incoherent_payload"],
    ["wrong-user", 3, reminder, { streamId: "user:someone-else" }, "private_stream_mismatch"],
    ["public-stream", 3, reminder, { streamId: `conversation:${conversationId}` }, "private_stream_mismatch"],
    ["wrong-tenant", 3, reminder, { tenantId: "another-tenant" }, "tenant_mismatch"],
  ];
  for (const clock of [occurredAt, "2038-01-02T03:04:04.999Z"]) {
    for (const [name, revision, value, overrides, code] of invalid) {
      assert.throws(
        () => cache.applyDurableEvent(event(`${name}-${clock}`, revision, value, { ...overrides, occurredAt: clock })),
        (error) => error instanceof DurableEventReductionError && error.diagnostic.code === code,
        name,
      );
      assert.equal(cache.getState(), before);
      assert.deepEqual(cache.getState(), snapshot);
    }
  }
});

test("message-reminder snapshots hydrate validated opaque-cursor pages monotonically", async () => {
  const cache = createNormalizedChatCache(identity);
  const cursor = "handrail-message-reminders.v1.%5B%222099-01-02T12%3A00%3A00.000Z%22%2C%22message-reminder-client%22%5D";
  const pages = [{
    kind: "message_reminder_list",
    privacy: "actor_private",
    items: [{
      conversationId,
      messageId,
      reminderRevision: 2,
      reminder: { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: due(2) },
    }],
    page: { nextCursor: cursor },
  }, {
    kind: "message_reminder_list",
    privacy: "actor_private",
    items: [],
    page: { nextCursor: null },
  }];
  const calls = [];
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    async fetch(url) {
      calls.push(url);
      return response(pages.shift());
    },
  });
  assert.equal((await client.listMessageReminders({ limit: 1 })).status, "success");
  assert.equal((await client.listMessageReminders({ limit: 1, cursor })).status, "success");
  assert.deepEqual(calls, [
    "/chat/message-reminders?limit=1",
    `/chat/message-reminders?cursor=${encodeURIComponent(cursor)}&limit=1`,
  ]);
  const state = selectCurrentUserMessageReminderState(cache.getState(), messageId);
  assert.equal(state.authoritativeRevision, 2);
  assert.equal(state.reminder.dueAt, due(2));
  cache.hydrateMessageReminderList({
    kind: "message_reminder_list",
    privacy: "actor_private",
    items: [{
      conversationId,
      messageId,
      reminderRevision: 1,
      reminder: { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: due(1) },
    }],
    page: { nextCursor: null },
  });
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).reminder.dueAt, due(2));
});

test("set, reschedule, and cancel project immediately and serialize authoritative revisions", async () => {
  const cache = createNormalizedChatCache(identity);
  const requests = [];
  let releaseFirst;
  let key = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    messageReminders: {
      generateIdempotencyKey: () => `reminder-key-${++key}`,
      now: () => Date.parse("2038-01-01T00:00:00.000Z"),
    },
    async fetch(url, init) {
      const input = JSON.parse(init.body);
      requests.push({ url, input, key: init.headers["idempotency-key"] });
      if (requests.length === 1) {
        return new Promise((resolve) => { releaseFirst = () => resolve(response(canonicalResult(input))); });
      }
      return response(canonicalResult(input));
    },
  });
  const first = client.setMessageReminder({ conversationId, messageId, dueAt: due(3) });
  const second = client.setMessageReminder({ conversationId, messageId, dueAt: due(4) });
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).reminder.dueAt, due(4));
  await flush();
  assert.equal(requests.length, 1);
  releaseFirst();
  assert.equal((await first).status, "success");
  assert.equal((await second).status, "success");
  assert.deepEqual(requests.map(({ input }) => input.expectedReminderRevision), [0, 1]);
  assert.ok(requests.every(({ url }) => url === `/chat/conversations/${conversationId}/messages/${messageId}/reminder`));
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).reminder.dueAt, due(4));
  assert.equal((await client.cancelMessageReminder({ conversationId, messageId })).status, "success");
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).reminder.state, "cancelled");
  assert.equal(selectCurrentUserMessageReminders(cache.getState()).length, 0);
});

test("ambiguous transport retains exact retry correlation and revision conflicts converge", async () => {
  const cache = createNormalizedChatCache(identity);
  const requests = [];
  let attempt = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    messageReminders: {
      generateIdempotencyKey: () => "stable-reminder-key",
      now: () => Date.parse("2038-01-01T00:00:00.000Z"),
    },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      requests.push({ input, key: init.headers["idempotency-key"] });
      if (++attempt === 1) throw new Error("private transport detail");
      if (attempt === 2) return response(canonicalResult(input, {
        reconciliationStatus: "replayed",
      }));
      return response(canonicalResult(input, {
        reconciliationStatus: "revision-conflict",
        reminderRevision: 8,
        reminder: { privacy: "affected_authenticated_actor", state: "cancelled" },
      }), 409);
    },
  });
  assert.equal((await client.setMessageReminder({ conversationId, messageId, dueAt: due(5) })).status, "transport");
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).pending.state, "failed");
  assert.equal((await client.retryMessageReminder(messageId)).status, "success");
  assert.deepEqual(requests[1], requests[0]);
  assert.equal((await client.setMessageReminder({ conversationId, messageId, dueAt: due(6) })).status, "success");
  const state = selectCurrentUserMessageReminderState(cache.getState(), messageId);
  assert.equal(state.authoritativeRevision, 8);
  assert.equal(state.reminder.state, "cancelled");
  assert.equal(state.pending, undefined);
});

test("malformed responses retain retry correlation while unavailable sources roll back", async () => {
  const cache = createNormalizedChatCache(identity);
  let mode = "malformed";
  let key = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    messageReminders: {
      generateIdempotencyKey: () => `failure-reminder-${++key}`,
      now: () => Date.parse("2038-01-01T00:00:00.000Z"),
    },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      if (mode === "malformed") return response({ operation: "wrong" });
      return response({
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: "unavailable-source",
        conversationId: input.conversationId,
        messageId: input.messageId,
        expectedReminderRevision: input.expectedReminderRevision,
        idempotencyKey: input.idempotencyKey,
        reminderRevision: null,
        reminder: null,
      });
    },
  });
  assert.equal((await client.setMessageReminder({ conversationId, messageId, dueAt: due(11) })).status, "malformed_response");
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).pending.state, "failed");
  mode = "unavailable";
  assert.equal((await client.setMessageReminder({ conversationId, messageId, dueAt: due(12) })).status, "success");
  const state = selectCurrentUserMessageReminderState(cache.getState(), messageId);
  assert.equal(state.pending, undefined);
  assert.equal(state.reminder, undefined);
});

test("private realtime reconciles before HTTP and identity/close prevent stale completion", async () => {
  const cache = createNormalizedChatCache(identity);
  const releases = [];
  let key = 0;
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    messageReminders: {
      generateIdempotencyKey: () => `event-reminder-${++key}`,
      now: () => Date.parse("2038-01-01T00:00:00.000Z"),
    },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      return new Promise((resolve) => releases.push(() => resolve(response(canonicalResult(input)))));
    },
  });
  const first = client.setMessageReminder({ conversationId, messageId, dueAt: due(7) });
  await flush();
  cache.applyDurableEvent(event("reminder-before-http", 1, {
    privacy: "affected_authenticated_actor",
    state: "scheduled",
    dueAt: due(7),
  }));
  assert.equal(selectCurrentUserMessageReminderState(cache.getState(), messageId).pending, undefined);
  releases.shift()();
  assert.equal((await first).status, "success");

  const before = cache.getState();
  assert.throws(
    () => cache.applyDurableEvent(event("wrong-reminder-stream", 2, {
      privacy: "affected_authenticated_actor",
      state: "cancelled",
    }, { streamId: "user:someone-else" })),
    (error) => error instanceof DurableEventReductionError,
  );
  assert.equal(cache.getState(), before);

  const stale = client.setMessageReminder({ conversationId, messageId, dueAt: due(8) });
  await flush();
  cache.setIdentity({ tenantId, userId: "replacement-user", sessionId: "replacement-session" });
  releases.shift()();
  assert.equal((await stale).status, "success");
  assert.deepEqual(cache.getState().currentUser.messageReminders, {});

  cache.setIdentity(identity);
  const closing = client.setMessageReminder({ conversationId, messageId, dueAt: due(9) });
  await flush();
  client.close();
  assert.deepEqual(cache.getState().currentUser.messageReminders, {});
  releases.shift()();
  assert.equal((await closing).status, "closed");
});

test("canonical cache hydration preserves reminders only for the exact identity", () => {
  const source = createNormalizedChatCache(identity);
  source.applyDurableEvent(event("reminder-cross-tab", 1, {
    privacy: "affected_authenticated_actor",
    state: "scheduled",
    dueAt: due(10),
  }));
  const envelope = JSON.parse(JSON.stringify(source.getState()));
  const matching = createNormalizedChatCache(identity);
  assert.equal(matching.hydrateCanonicalState(envelope), true);
  assert.equal(
    selectCurrentUserMessageReminderState(matching.getState(), messageId).reminder.dueAt,
    due(10),
  );
  const isolated = createNormalizedChatCache({
    tenantId,
    userId: "other-reminder-user",
    sessionId: "other-reminder-session",
  });
  assert.equal(isolated.hydrateCanonicalState(envelope), false);
  assert.deepEqual(isolated.getState().currentUser.messageReminders, {});
});
