import assert from "node:assert/strict";
import test from "node:test";

const buildRoot = process.env.HANDRAIL_COMPOSER_BUILD ?? new URL("../dist/", import.meta.url).href;
const {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createChatDraftRuntime,
  createNormalizedChatCache,
} = await import(`${buildRoot}client/index.js`);
const { CHAT_PROTOCOL_VERSION } = await import(`${buildRoot}contracts/realtime.js`);

const tenantId = "tenant-drafts";
const userId = "user-drafts";
const identity = { tenantId, userId, sessionId: "session-drafts" };
const now = "2026-08-26T20:00:00.000Z";

const content = (text, format = "plain", mentions) => ({
  format,
  text,
  ...(mentions === undefined ? {} : { mentions }),
  attachments: [],
});
const replaced = (text, mentions) => ({
  kind: "replaced",
  content: content(text, "plain", mentions),
});
const cleared = () => ({ kind: "clear_tombstone", content: null });
const replyContent = (replyTo) => ({
  ...content("Friday"),
  attachments: [{ attachmentId: "reply-upload" }],
  ...(replyTo === undefined ? {} : { replyTo }),
});
const snapshot = (conversationId, revision, draft) => draft === undefined
  ? {
      kind: "conversation_draft",
      privacy: "actor_private",
      conversationId,
      state: "absent",
      canonicalRevision: revision,
      canonicalUpdatedAt: revision === 0 ? null : now,
      content: null,
    }
  : {
      kind: "conversation_draft",
      privacy: "actor_private",
      conversationId,
      state: "present",
      canonicalRevision: revision,
      canonicalUpdatedAt: now,
      content: { privacy: "actor_private", value: draft.content },
    };

const resultFor = (input, revision = input.baseRevision + 1, overrides = {}) => ({
  operation: "synchronize_draft",
  intent: input.intent,
  reconciliationStatus: "applied",
  conversationId: input.conversationId,
  baseRevision: input.baseRevision,
  deviceMutationId: input.deviceMutationId,
  idempotencyKey: input.idempotencyKey,
  canonicalRevision: revision,
  canonicalUpdatedAt: now,
  draft: input.intent === "replace"
    ? { kind: "replaced", content: input.content }
    : cleared(),
  ...overrides,
});

const draftEvent = (eventId, input, result, overrides = {}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: `user:${userId}`,
  type: "conversation.draft.updated",
  occurredAt: now,
  payload: { actorUserId: userId, input, result },
  ...overrides,
});

const seedConversation = (cache, conversationId) => cache.applyDurableEvent({
  eventId: `seed:${conversationId}`,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: conversationId,
  type: CHAT_DURABLE_EVENT_TYPES.conversationCreated,
  occurredAt: "2026-08-26T19:59:59.000Z",
  payload: {
    conversation: {
      id: conversationId,
      tenantId,
      type: "channel",
      visibility: "private",
      name: "Private",
      createdAt: "2026-08-26T19:59:59.000Z",
      updatedAt: "2026-08-26T19:59:59.000Z",
    },
  },
});

class ManualTimer {
  next = 0;
  tasks = new Map();
  schedule = (task) => {
    const id = ++this.next;
    this.tasks.set(id, task);
    return id;
  };
  cancel = (id) => { this.tasks.delete(id); };
  runAll() {
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) task();
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
};

const createRuntimeFixture = () => {
  const cache = createNormalizedChatCache(identity);
  const timer = new ManualTimer();
  const snapshotReads = [];
  const dispatches = [];
  let device = 0;
  let key = 0;
  const diagnostics = [];
  const runtime = createChatDraftRuntime({
    cache,
    snapshots: {
      getConversationDraft(input, options) {
        const pending = deferred();
        snapshotReads.push({ input, signal: options?.signal, ...pending });
        return pending.promise;
      },
    },
    dispatch(descriptor, input, options) {
      const pending = deferred();
      dispatches.push({ descriptor, input, options, ...pending });
      return pending.promise;
    },
    options: {
      debounceMs: 25,
      timer,
      generateDeviceMutationId: () => `device-mutation-${++device}`,
      generateIdempotencyKey: () => `draft-key-${++key}`,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  return { cache, timer, snapshotReads, dispatches, diagnostics, runtime };
};

test("default draft correlation IDs remain unique across client instances", async () => {
  const inputs = [];
  const createRuntime = () => createChatDraftRuntime({
    cache: createNormalizedChatCache(identity),
    snapshots: {
      getConversationDraft() {
        throw new Error("snapshot hydration is not expected");
      },
    },
    async dispatch(_descriptor, input) {
      inputs.push(input);
      return { status: "success", value: resultFor(input) };
    },
  });
  const first = createRuntime();
  const second = createRuntime();

  first.replace({ conversationId: "first-runtime", content: content("first") });
  second.replace({ conversationId: "second-runtime", content: content("second") });
  const [firstResult, secondResult] = await Promise.all([
    first.flush("first-runtime"),
    second.flush("second-runtime"),
  ]);

  assert.equal(firstResult.status, "success");
  assert.equal(secondResult.status, "success");
  assert.equal(inputs.length, 2);
  assert.notEqual(inputs[0].deviceMutationId, inputs[1].deviceMutationId);
  assert.notEqual(inputs[0].idempotencyKey, inputs[1].idempotencyKey);
});

test("draft open hydrates present and absent actor-private snapshots", async () => {
  const fixture = createRuntimeFixture();
  const presentId = "draft-present";
  const absentId = "draft-absent";

  const presentOpen = fixture.runtime.open(presentId);
  fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(presentId, 3, replaced("saved")) });
  assert.deepEqual(await presentOpen, {
    conversationId: presentId,
    status: "ready",
    draft: replaced("saved"),
    authoritativeRevision: 3,
    dirty: false,
  });

  const absentOpen = fixture.runtime.open(absentId);
  fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(absentId, 0) });
  assert.deepEqual(await absentOpen, {
    conversationId: absentId,
    status: "ready",
    authoritativeRevision: 0,
    dirty: false,
  });
});

test("draft projections clone and freeze all mention kinds while preserving optionality", async () => {
  const fixture = createRuntimeFixture();
  const conversationId = "draft-mentioned-snapshot";
  const sourceMentions = [
    { type: "user", userId: "mentioned-user" },
    { type: "conversation", conversationId: "mentioned-conversation" },
    { type: "entity", entity: { type: "ticket", id: "ticket-42" } },
  ];
  const sourceContent = content("saved mentions", "markdown", sourceMentions);

  const opening = fixture.runtime.open(conversationId);
  fixture.snapshotReads.shift().resolve({
    status: "success",
    value: snapshot(conversationId, 3, { kind: "replaced", content: sourceContent }),
  });
  const state = await opening;
  const projectedMentions = state.draft.content.mentions;
  assert.deepEqual(projectedMentions, sourceMentions);
  assert.notStrictEqual(projectedMentions, sourceMentions);
  assert.notStrictEqual(projectedMentions[2].entity, sourceMentions[2].entity);
  assert.equal(Object.isFrozen(state.draft), true);
  assert.equal(Object.isFrozen(state.draft.content), true);
  assert.equal(Object.isFrozen(projectedMentions), true);
  assert.equal(projectedMentions.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(projectedMentions[2].entity), true);

  const cachedMentions = fixture.cache.getState().currentUser.drafts[conversationId].content.mentions;
  assert.deepEqual(cachedMentions, sourceMentions);
  assert.notStrictEqual(cachedMentions, projectedMentions);
  assert.notStrictEqual(cachedMentions[2].entity, projectedMentions[2].entity);
  assert.equal(Object.isFrozen(cachedMentions), true);
  assert.equal(Object.isFrozen(cachedMentions[2].entity), true);

  sourceMentions[0].userId = "mutated-user";
  sourceMentions[2].entity.id = "mutated-ticket";
  sourceMentions.push({ type: "user", userId: "late-user" });
  assert.deepEqual(state.draft.content.mentions, [
    { type: "user", userId: "mentioned-user" },
    { type: "conversation", conversationId: "mentioned-conversation" },
    { type: "entity", entity: { type: "ticket", id: "ticket-42" } },
  ]);

  const emptyId = "draft-empty-mentions";
  const emptyOpening = fixture.runtime.open(emptyId);
  fixture.snapshotReads.shift().resolve({
    status: "success",
    value: snapshot(emptyId, 1, replaced("empty mentions", [])),
  });
  const emptyState = await emptyOpening;
  assert.equal(Object.hasOwn(emptyState.draft.content, "mentions"), true);
  assert.deepEqual(emptyState.draft.content.mentions, []);
  assert.equal(Object.isFrozen(emptyState.draft.content.mentions), true);

  const legacyId = "draft-legacy-without-mentions";
  const legacyOpening = fixture.runtime.open(legacyId);
  fixture.snapshotReads.shift().resolve({
    status: "success",
    value: snapshot(legacyId, 1, replaced("legacy")),
  });
  const legacyState = await legacyOpening;
  assert.equal(Object.hasOwn(legacyState.draft.content, "mentions"), false);
});

test("mention identity, order, and absence participate in canonical equality", async () => {
  const fixture = createRuntimeFixture();
  const optionalityId = "draft-mention-optionality";
  const optionalityOpening = fixture.runtime.open(optionalityId);
  fixture.snapshotReads.shift().resolve({
    status: "success",
    value: snapshot(optionalityId, 2, replaced("same text")),
  });
  await optionalityOpening;
  const emptyMentionInput = {
    operation: "synchronize_draft",
    intent: "replace",
    conversationId: optionalityId,
    baseRevision: 1,
    deviceMutationId: "empty-mention-device",
    idempotencyKey: "empty-mention-key",
    content: content("same text", "plain", []),
  };
  fixture.runtime.handleCanonicalEvent(draftEvent(
    "empty-mention-event",
    emptyMentionInput,
    resultFor(emptyMentionInput, 2),
  ));
  assert.equal(fixture.runtime.select(optionalityId).status, "conflict");
  assert.equal(fixture.runtime.select(optionalityId).conflict.code, "incompatible_revision");
  assert.equal(
    Object.hasOwn(fixture.runtime.select(optionalityId).draft.content, "mentions"),
    false,
  );

  const orderId = "draft-mention-order";
  const orderedMentions = [
    { type: "user", userId: "ordered-user" },
    { type: "conversation", conversationId: "ordered-conversation" },
  ];
  const orderOpening = fixture.runtime.open(orderId);
  fixture.snapshotReads.shift().resolve({
    status: "success",
    value: snapshot(orderId, 4, replaced("same text", orderedMentions)),
  });
  await orderOpening;
  const reorderedInput = {
    operation: "synchronize_draft",
    intent: "replace",
    conversationId: orderId,
    baseRevision: 3,
    deviceMutationId: "reordered-device",
    idempotencyKey: "reordered-key",
    content: content("same text", "plain", [...orderedMentions].reverse()),
  };
  fixture.runtime.handleCanonicalEvent(draftEvent(
    "reordered-event",
    reorderedInput,
    resultFor(reorderedInput, 4),
  ));
  assert.equal(fixture.runtime.select(orderId).status, "conflict");
  assert.deepEqual(fixture.runtime.select(orderId).draft.content.mentions, orderedMentions);
});

test("mention-only synchronization survives optimistic projection, conflicts, retries, and clear", async () => {
  const fixture = createRuntimeFixture();
  const conversationId = "draft-mention-retry";
  const callerMentions = [
    { type: "user", userId: "local-user" },
    { type: "conversation", conversationId: "local-conversation" },
    { type: "entity", entity: { type: "issue", id: "issue-9" } },
  ];
  fixture.runtime.replace({
    conversationId,
    content: content("unchanged text", "plain", callerMentions),
  });
  const optimistic = fixture.runtime.select(conversationId).draft.content.mentions;
  assert.deepEqual(
    fixture.cache.getState().currentUser.drafts[conversationId].content.mentions,
    optimistic,
  );
  assert.notStrictEqual(optimistic, callerMentions);
  assert.notStrictEqual(optimistic[2].entity, callerMentions[2].entity);
  callerMentions[0].userId = "caller-mutated";
  callerMentions[2].entity.id = "caller-mutated";

  const firstFlush = fixture.runtime.flush(conversationId);
  await new Promise(setImmediate);
  const first = fixture.dispatches[0];
  assert.deepEqual(first.input.content.mentions, [
    { type: "user", userId: "local-user" },
    { type: "conversation", conversationId: "local-conversation" },
    { type: "entity", entity: { type: "issue", id: "issue-9" } },
  ]);
  first.resolve({ status: "transport", message: "The chat command could not be completed." });
  assert.equal((await firstFlush).status, "retryable");

  const retry = fixture.runtime.retry(conversationId);
  await new Promise(setImmediate);
  const second = fixture.dispatches[1];
  assert.deepEqual(second.input, first.input);
  second.resolve({
    status: "success",
    value: resultFor(second.input, 5, {
      reconciliationStatus: "stale_base",
      draft: replaced("unchanged text", [
        { type: "conversation", conversationId: "canonical-conversation" },
      ]),
    }),
  });
  assert.equal((await retry).status, "conflict");
  assert.deepEqual(
    fixture.runtime.select(conversationId).draft.content.mentions,
    first.input.content.mentions,
  );
  assert.deepEqual(
    fixture.cache.getState().currentUser.drafts[conversationId].content.mentions,
    first.input.content.mentions,
  );

  const conflictRetry = fixture.runtime.retry(conversationId);
  await new Promise(setImmediate);
  const third = fixture.dispatches[2];
  assert.equal(third.input.baseRevision, 5);
  assert.deepEqual(third.input.content.mentions, first.input.content.mentions);
  third.resolve({ status: "success", value: resultFor(third.input) });
  assert.equal((await conflictRetry).status, "success");
  assert.deepEqual(
    fixture.runtime.select(conversationId).draft.content.mentions,
    first.input.content.mentions,
  );

  const canonicalInput = {
    operation: "synchronize_draft",
    intent: "replace",
    conversationId,
    baseRevision: 6,
    deviceMutationId: "canonical-mention-device",
    idempotencyKey: "canonical-mention-key",
    content: content("unchanged text", "plain", [
      { type: "conversation", conversationId: "adopted-conversation" },
    ]),
  };
  fixture.runtime.handleCanonicalEvent(draftEvent(
    "canonical-mention-event",
    canonicalInput,
    resultFor(canonicalInput, 7),
  ));
  assert.deepEqual(fixture.runtime.select(conversationId).draft.content.mentions, [
    { type: "conversation", conversationId: "adopted-conversation" },
  ]);

  fixture.runtime.clear(conversationId);
  const clearFlush = fixture.runtime.flush(conversationId);
  await new Promise(setImmediate);
  const clearRequest = fixture.dispatches[3];
  assert.equal(clearRequest.input.intent, "clear");
  assert.equal(Object.hasOwn(clearRequest.input, "content"), false);
  clearRequest.resolve({ status: "success", value: resultFor(clearRequest.input) });
  assert.equal((await clearFlush).status, "success");
  assert.deepEqual(fixture.runtime.select(conversationId).draft, cleared());
  assert.deepEqual(fixture.cache.getState().currentUser.drafts[conversationId], cleared());
});

test("late snapshots never replace a newer local edit or private durable event", async () => {
  const fixture = createRuntimeFixture();
  const localId = "draft-local-race";
  const eventId = "draft-event-race";
  seedConversation(fixture.cache, eventId);

  const localOpen = fixture.runtime.open(localId);
  fixture.runtime.replace({ conversationId: localId, content: content("new local") });
  fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(localId, 4, replaced("older snapshot")) });
  await localOpen;
  assert.equal(fixture.runtime.select(localId).draft.content.text, "new local");
  assert.equal(fixture.runtime.select(localId).authoritativeRevision, 4);

  const eventOpen = fixture.runtime.open(eventId);
  const eventInput = {
    operation: "synchronize_draft",
    intent: "replace",
    conversationId: eventId,
    baseRevision: 7,
    deviceMutationId: "other-device",
    idempotencyKey: "other-key",
    content: content("newer event"),
  };
  const eventResult = resultFor(eventInput, 8);
  const event = draftEvent("private-event-newer", eventInput, eventResult);
  fixture.cache.applyDurableEvent(event);
  fixture.runtime.handleCanonicalEvent(event);
  fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(eventId, 7, replaced("older snapshot")) });
  await eventOpen;
  assert.equal(fixture.runtime.select(eventId).draft.content.text, "newer event");
  assert.equal(fixture.runtime.select(eventId).authoritativeRevision, 8);
});

test("typing projects immediately, coalesces debounce, and serializes revisions per conversation", async () => {
  const fixture = createRuntimeFixture();
  const conversationId = "draft-serialization";
  const independentId = "draft-independent";
  fixture.runtime.replace({ conversationId, content: content("a") });
  fixture.runtime.replace({ conversationId, content: content("ab") });
  assert.equal(fixture.cache.getState().currentUser.drafts[conversationId].content.text, "ab");
  assert.equal(fixture.timer.tasks.size, 1);

  fixture.timer.runAll();
  await new Promise(setImmediate);
  assert.equal(fixture.dispatches.length, 1);
  assert.equal(fixture.dispatches[0].input.content.text, "ab");
  fixture.runtime.replace({ conversationId, content: content("abc") });
  fixture.timer.runAll();
  await new Promise(setImmediate);
  assert.equal(fixture.dispatches.length, 1, "the next revision waits for the first response");

  fixture.runtime.replace({ conversationId: independentId, content: content("parallel conversation") });
  fixture.timer.runAll();
  await new Promise(setImmediate);
  assert.equal(fixture.dispatches.length, 2, "a different conversation persists independently");
  assert.equal(fixture.dispatches[1].input.conversationId, independentId);
  fixture.dispatches[1].resolve({ status: "success", value: resultFor(fixture.dispatches[1].input) });

  const first = fixture.dispatches[0];
  first.resolve({ status: "success", value: resultFor(first.input) });
  await new Promise(setImmediate);
  assert.equal(fixture.dispatches.length, 3);
  assert.equal(fixture.dispatches[2].input.baseRevision, 1);
  assert.equal(fixture.dispatches[2].input.content.text, "abc");
  fixture.dispatches[2].resolve({ status: "success", value: resultFor(fixture.dispatches[2].input) });
  await new Promise(setImmediate);
  assert.equal(fixture.runtime.select(conversationId).status, "ready");
  assert.equal(fixture.runtime.select(conversationId).authoritativeRevision, 2);
});

test("offline retry reuses correlation and stale-base conflicts preserve and redact local text", async () => {
  const fixture = createRuntimeFixture();
  const offlineId = "draft-offline";
  fixture.runtime.replace({ conversationId: offlineId, content: content("offline private body") });
  const firstFlush = fixture.runtime.flush(offlineId);
  await new Promise(setImmediate);
  const first = fixture.dispatches[0];
  first.resolve({ status: "transport", message: "The chat command could not be completed." });
  assert.equal((await firstFlush).status, "retryable");

  const retry = fixture.runtime.retry(offlineId);
  await new Promise(setImmediate);
  const second = fixture.dispatches[1];
  assert.deepEqual(second.input, first.input);
  assert.equal(second.options.idempotencyKey, first.options.idempotencyKey);
  second.resolve({ status: "success", value: resultFor(second.input) });
  assert.equal((await retry).status, "success");

  const conflictId = "draft-conflict";
  fixture.runtime.replace({ conversationId: conflictId, content: content("never leak this") });
  const conflictFlush = fixture.runtime.flush(conflictId);
  await new Promise(setImmediate);
  const conflictRequest = fixture.dispatches[2];
  conflictRequest.resolve({
    status: "success",
    value: resultFor(conflictRequest.input, 5, {
      reconciliationStatus: "stale_base",
      draft: replaced("other device private body"),
    }),
  });
  assert.equal((await conflictFlush).status, "conflict");
  const state = fixture.runtime.select(conflictId);
  assert.equal(state.draft.content.text, "never leak this");
  assert.equal(state.conflict.code, "stale_base");
  assert.equal(JSON.stringify(state.conflict).includes("never leak this"), false);
  assert.equal(JSON.stringify(state.conflict).includes("other device private body"), false);
  assert.equal(JSON.stringify(fixture.diagnostics).includes("never leak this"), false);
  assert.equal(JSON.stringify(fixture.diagnostics).includes("other device private body"), false);

  const conflictRetry = fixture.runtime.retry(conflictId);
  await new Promise(setImmediate);
  const retriedConflict = fixture.dispatches[3];
  assert.equal(retriedConflict.input.baseRevision, 5);
  assert.notEqual(retriedConflict.input.idempotencyKey, conflictRequest.input.idempotencyKey);
  retriedConflict.resolve({ status: "success", value: resultFor(retriedConflict.input) });
  assert.equal((await conflictRetry).status, "success");

  const incompatibleId = "draft-same-revision";
  seedConversation(fixture.cache, incompatibleId);
  const opened = fixture.runtime.open(incompatibleId);
  fixture.snapshotReads.shift().resolve({
    status: "success",
    value: snapshot(incompatibleId, 2, replaced("known canonical")),
  });
  await opened;
  fixture.runtime.replace({ conversationId: incompatibleId, content: content("preserved local") });
  const incompatibleInput = {
    operation: "synchronize_draft",
    intent: "replace",
    conversationId: incompatibleId,
    baseRevision: 1,
    deviceMutationId: "same-revision-device",
    idempotencyKey: "same-revision-key",
    content: content("incompatible canonical"),
  };
  const incompatibleResult = resultFor(incompatibleInput, 2);
  const incompatibleEvent = draftEvent(
    "same-revision-event",
    incompatibleInput,
    incompatibleResult,
  );
  fixture.cache.applyDurableEvent(incompatibleEvent);
  fixture.runtime.handleCanonicalEvent(incompatibleEvent);
  assert.equal(fixture.runtime.select(incompatibleId).status, "conflict");
  assert.equal(fixture.runtime.select(incompatibleId).conflict.code, "incompatible_revision");
  assert.equal(fixture.runtime.select(incompatibleId).draft.content.text, "preserved local");
});

test("private event and response converge in either order without losing a newer projection", async () => {
  const fixture = createRuntimeFixture();
  const eventFirstId = "draft-event-first";
  const responseFirstId = "draft-response-first";
  seedConversation(fixture.cache, eventFirstId);
  seedConversation(fixture.cache, responseFirstId);

  fixture.runtime.replace({ conversationId: eventFirstId, content: content("event first") });
  const eventFirstFlush = fixture.runtime.flush(eventFirstId);
  await new Promise(setImmediate);
  const first = fixture.dispatches[0];
  const firstResult = resultFor(first.input);
  const firstEvent = draftEvent("event-before-response", first.input, firstResult);
  fixture.cache.applyDurableEvent(firstEvent);
  fixture.runtime.handleCanonicalEvent(firstEvent);
  first.resolve({ status: "transport", message: "The chat command could not be completed." });
  assert.equal((await eventFirstFlush).status, "success");
  assert.equal(fixture.runtime.select(eventFirstId).status, "ready");

  fixture.runtime.replace({ conversationId: responseFirstId, content: content("response first") });
  const responseFirstFlush = fixture.runtime.flush(responseFirstId);
  await new Promise(setImmediate);
  const second = fixture.dispatches[1];
  const secondResult = resultFor(second.input);
  second.resolve({ status: "success", value: secondResult });
  assert.equal((await responseFirstFlush).status, "success");
  const secondEvent = draftEvent("response-before-event", second.input, secondResult, {
    occurredAt: "2026-08-26T20:00:01.000Z",
  });
  fixture.cache.applyDurableEvent(secondEvent);
  fixture.runtime.handleCanonicalEvent(secondEvent);
  assert.equal(fixture.runtime.select(responseFirstId).status, "ready");
  assert.equal(fixture.runtime.select(responseFirstId).authoritativeRevision, 1);
});

test("conversation/client boundaries flush or abort and identity changes cancel private work", async () => {
  const fixture = createRuntimeFixture();
  const flushId = "draft-close-flush";
  fixture.runtime.replace({ conversationId: flushId, content: content("flush me") });
  const closing = fixture.runtime.closeConversation(flushId);
  await new Promise(setImmediate);
  assert.equal(fixture.dispatches.length, 1);
  fixture.dispatches[0].resolve({ status: "success", value: resultFor(fixture.dispatches[0].input) });
  assert.equal((await closing).status, "success");
  assert.equal(fixture.runtime.select(flushId).status, "idle");

  const abortId = "draft-close-abort";
  fixture.runtime.replace({ conversationId: abortId, content: content("discard local") });
  await fixture.runtime.closeConversation(abortId, { policy: "abort" });
  assert.equal(fixture.timer.tasks.size, 0);
  assert.equal(fixture.cache.getState().currentUser.drafts[abortId], undefined);

  const identityId = "draft-identity";
  const opening = fixture.runtime.open(identityId);
  const pendingRead = fixture.snapshotReads.at(-1);
  fixture.cache.setIdentity({ tenantId, userId: "replacement-user", sessionId: "replacement-session" });
  assert.equal(pendingRead.signal.aborted, true);
  pendingRead.resolve({ status: "success", value: snapshot(identityId, 9, replaced("old actor")) });
  await opening;
  assert.equal(fixture.cache.getState().currentUser.drafts[identityId], undefined);

  const clientAbort = createRuntimeFixture();
  clientAbort.runtime.replace({ conversationId: "draft-client-close", content: content("pending") });
  const pendingFlush = clientAbort.runtime.flush("draft-client-close");
  await new Promise(setImmediate);
  clientAbort.runtime.closeActive();
  assert.equal(clientAbort.dispatches[0].options.signal.aborted, true);
  clientAbort.dispatches[0].resolve({ status: "aborted", message: "The chat command was aborted." });
  assert.equal((await pendingFlush).status, "closed");
});

test("tenant/actor-private events are isolated and diagnostics remain structurally redacted", () => {
  const fixture = createRuntimeFixture();
  const conversationId = "draft-isolation";
  fixture.runtime.replace({ conversationId, content: content("actor secret") });
  const input = {
    operation: "synchronize_draft",
    intent: "replace",
    conversationId,
    baseRevision: 0,
    deviceMutationId: "foreign-device",
    idempotencyKey: "foreign-key",
    content: content("foreign secret"),
  };
  fixture.runtime.handleCanonicalEvent(draftEvent("foreign-actor", input, resultFor(input), {
    streamId: "user:another-user",
    payload: { actorUserId: "another-user", input, result: resultFor(input) },
  }));
  fixture.runtime.handleCanonicalEvent(draftEvent("foreign-tenant", input, resultFor(input), {
    tenantId: "another-tenant",
  }));
  assert.equal(fixture.runtime.select(conversationId).draft.content.text, "actor secret");
  assert.equal(JSON.stringify(fixture.diagnostics).includes("actor secret"), false);
  assert.equal(JSON.stringify(fixture.diagnostics).includes("foreign secret"), false);
});

const response = (body, overrides = {}) => ({
  ok: true,
  status: 200,
  async json() { return body; },
  ...overrides,
});

test("successful message sends clear and synchronize drafts; failed sends leave them intact", async () => {
  const cache = createNormalizedChatCache(identity);
  const conversationId = "draft-send-clear";
  seedConversation(cache, conversationId);
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    optimisticMessages: {
      generateClientMessageId: () => "message-client-id",
      generateIdempotencyKey: () => "message-key",
      now: () => Date.parse(now),
    },
    drafts: {
      debounceMs: 1000,
      generateDeviceMutationId: () => "draft-clear-device",
      generateIdempotencyKey: () => "draft-clear-key",
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (url.endsWith("/messages")) {
        return response({
          operation: "send",
          reconciliationStatus: "applied",
          clientMessageId: body.clientMessageId,
          message: {
            id: "sent-message",
            tenantId,
            conversationId,
            author: { type: "user", userId },
            sequence: 1,
            createdAt: now,
            updatedAt: now,
            revision: { revision: 1 },
            content: body.content,
          },
          canonicalRevision: 1,
        });
      }
      return response(resultFor(body));
    },
  });
  client.replaceConversationDraft({ conversationId, content: content("sent body") });
  assert.equal((await client.sendMessage({ conversationId, content: content("sent body") })).status, "success");
  await new Promise(setImmediate);
  assert.deepEqual(requests.map(({ url }) => url), [
    `/chat/conversations/${conversationId}/messages`,
    `/chat/conversations/${conversationId}/draft`,
  ]);
  assert.equal(requests[1].body.intent, "clear");
  assert.equal(client.selectConversationDraft(conversationId).draft.kind, "clear_tombstone");

  const failedId = "draft-send-failed";
  seedConversation(cache, failedId);
  client.replaceConversationDraft({ conversationId: failedId, content: content("keep after failure") });
  const originalFetch = requests.length;
  const failedClient = createChatClient({
    endpoint: "/chat",
    getAccessToken: () => "token",
    cache,
    commands: { retry: { maxAttempts: 1 } },
    drafts: { debounceMs: 1000 },
    fetch: async () => response({ error: { code: "rejected" } }, { ok: false, status: 422 }),
  });
  assert.notEqual((await failedClient.sendMessage({ conversationId: failedId, content: content("no") })).status, "success");
  assert.equal(cache.getState().currentUser.drafts[failedId].content.text, "keep after failure");
  assert.equal(requests.length, originalFetch);
  client.close();
  failedClient.close();
});

test("late client send success cannot clear newer durable reply edits or another conversation", async () => {
  const cache = createNormalizedChatCache(identity);
  const conversationId = "late-reply-send";
  const otherId = "other-draft";
  seedConversation(cache, conversationId);
  seedConversation(cache, otherId);
  const pending = deferred();
  const started = deferred();
  const client = createChatClient({
    endpoint: "/chat", getAccessToken: () => "token", cache,
    commands: { retry: { maxAttempts: 1 } },
    drafts: { debounceMs: 60_000 },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      started.resolve();
      await pending.promise;
      return response({ operation: "send", reconciliationStatus: "applied", clientMessageId: body.clientMessageId,
        message: { id: "late-message", tenantId, conversationId, author: { type: "user", userId },
          sequence: 1, createdAt: now, updatedAt: now, revision: { revision: 1 }, content: body.content,
          replyTo: body.replyTo }, canonicalRevision: 1 });
    },
  });
  try {
    const replyTo = { messageId: "source-a", notifyAuthor: true };
    client.replaceConversationDraft({ conversationId, content: { ...content("Friday"), replyTo } });
    const sending = client.sendMessage({ conversationId, content: content("Friday"), replyTo });
    await started.promise;
    const newer = { ...content("Friday"), replyTo: { messageId: "source-b", notifyAuthor: false } };
    client.replaceConversationDraft({ conversationId, content: newer });
    client.replaceConversationDraft({ conversationId: otherId, content: content("Other conversation") });
    pending.resolve();
    assert.equal((await sending).status, "success");
    assert.deepEqual(client.selectConversationDraft(conversationId).draft.content, newer);
    assert.equal(client.selectConversationDraft(otherId).draft.content.text, "Other conversation");
  } finally { client.close(); }
});

for (const [label, before, after] of [
  ["adding", undefined, { messageId: "source-a", notifyAuthor: false }],
  ["changing", { messageId: "source-a", notifyAuthor: false }, { messageId: "source-b", notifyAuthor: false }],
  ["toggling ping", { messageId: "source-a", notifyAuthor: false }, { messageId: "source-a", notifyAuthor: true }],
  ["removing", { messageId: "source-a", notifyAuthor: false }, undefined],
]) {
  test(`${label} only replyTo is unequal and survives incompatible-revision retry`, async () => {
    const fixture = createRuntimeFixture();
    const conversationId = `reply-${label}`;
    const canonical = { kind: "replaced", content: replyContent(before) };
    const opening = fixture.runtime.open(conversationId);
    fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(conversationId, 2, canonical) });
    assert.deepEqual((await opening).draft, canonical);

    // A duplicate canonical reference is still a no-op, including legacy absence.
    const duplicate = fixture.runtime.open(conversationId);
    fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(conversationId, 2, structuredClone(canonical)) });
    assert.equal((await duplicate).status, "ready");
    assert.equal((await fixture.runtime.flush(conversationId)).status, "success");
    assert.equal(fixture.dispatches.length, 0);

    const desired = replyContent(after);
    fixture.runtime.replace({ conversationId, content: desired });
    assert.deepEqual(fixture.runtime.select(conversationId).draft.content, desired);
    assert.equal(fixture.runtime.select(conversationId).dirty, true);
    const input = {
      operation: "synchronize_draft", intent: "replace", conversationId,
      baseRevision: 1, deviceMutationId: "remote-device", idempotencyKey: "remote-key",
      content: structuredClone(desired),
    };
    // Same revision, different reply only: it must not silently acknowledge the edit.
    fixture.runtime.handleCanonicalEvent(draftEvent("reply-incompatible", input, resultFor(input, 2)));
    const conflicted = fixture.runtime.select(conversationId);
    assert.equal(conflicted.conflict.code, "incompatible_revision");
    assert.deepEqual(conflicted.draft.content, desired);
    const retry = fixture.runtime.retry(conversationId);
    await new Promise(setImmediate);
    const request = fixture.dispatches[0];
    assert.deepEqual(request.input.content, desired);
    assert.equal(request.input.baseRevision, 2);
    request.resolve({ status: "success", value: resultFor(request.input) });
    assert.equal((await retry).status, "success");
    assert.deepEqual(fixture.runtime.select(conversationId).draft.content, desired);
    assert.equal(Object.hasOwn(fixture.runtime.select(conversationId).draft.content, "replyTo"), after !== undefined);
    fixture.runtime.closeActive();
  });
}

test("reply projections clone and freeze hydration, local input and canonical events", async () => {
  const fixture = createRuntimeFixture();
  const conversationId = "immutable-reply";
  const source = replyContent({ messageId: "source-a", notifyAuthor: false });
  const expected = structuredClone(source);
  const opening = fixture.runtime.open(conversationId);
  fixture.snapshotReads.shift().resolve({ status: "success", value: snapshot(conversationId, 1, { kind: "replaced", content: source }) });
  const hydrated = (await opening).draft.content;
  source.replyTo.messageId = "mutated-source";
  assert.deepEqual(hydrated, expected);
  assert.equal(Object.isFrozen(hydrated.replyTo), true);
  assert.notStrictEqual(hydrated.replyTo, source.replyTo);

  const local = replyContent({ messageId: "source-b", notifyAuthor: true });
  const expectedLocal = structuredClone(local);
  fixture.runtime.replace({ conversationId, content: local });
  local.replyTo.notifyAuthor = false;
  local.attachments[0].attachmentId = "mutated-upload";
  const projected = fixture.runtime.select(conversationId).draft.content;
  assert.deepEqual(projected, expectedLocal);
  assert.equal(Object.isFrozen(projected.replyTo), true);
  assert.deepEqual(fixture.cache.getState().currentUser.drafts[conversationId].content, expectedLocal);
  const flush = fixture.runtime.flush(conversationId);
  await new Promise(setImmediate);
  const request = fixture.dispatches[0];
  const event = draftEvent("reply-acknowledged", request.input, resultFor(request.input));
  fixture.runtime.handleCanonicalEvent(event);
  request.resolve({ status: "transport", message: "The chat command could not be completed." });
  assert.equal((await flush).status, "success");
  assert.deepEqual(fixture.runtime.select(conversationId).draft.content, expectedLocal);
  assert.equal(Object.isFrozen(fixture.runtime.select(conversationId).draft.content.replyTo), true);
  fixture.runtime.closeActive();
});
