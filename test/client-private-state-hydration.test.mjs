import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  CHAT_CLIENT_PACKAGE_VERSION,
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  createNormalizedChatCache,
  encodeSavedMessageSnapshotCursor,
  selectMessage,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const tenantId = "tenant-private-hydration";
const userId = "user-private-hydration";
const conversationId = "conversation-private-hydration";
const identity = { tenantId, userId, sessionId: "session-private-hydration" };
const privacy = ACTOR_PRIVATE_USER_STATE_PRIVACY;
const at = (second) => `2040-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});

const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
};

function seedConversation(cache) {
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [{
      id: conversationId,
      tenantId,
      type: "channel",
      visibility: "public",
      name: "Private hydration",
      createdAt: at(0),
      updatedAt: at(0),
      latestSequence: 4,
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
    }],
    page: {},
    _meta: metadata,
  });
}

const draft = (revision, text) => ({
  kind: "conversation_draft",
  privacy,
  conversationId,
  state: "present",
  canonicalRevision: revision,
  canonicalUpdatedAt: at(revision),
  content: {
    privacy,
    value: { format: "markdown", text, attachments: [] },
  },
});

const absentDraft = (revision) => ({
  kind: "conversation_draft",
  privacy,
  conversationId,
  state: "absent",
  canonicalRevision: revision,
  canonicalUpdatedAt: revision === 0 ? null : at(revision),
  content: null,
});

const savedCurrent = (messageId, text, revision = 1) => ({
  id: messageId,
  conversationId,
  author: { type: "user", userId: "author-private-hydration" },
  sequence: revision,
  createdAt: at(1),
  updatedAt: at(revision),
  revision: { revision },
  content: { format: "plain", text },
  attachmentMetadata: [],
});

const savedEntry = (messageId, revision, savedAt, message, privateNote) => ({
  messageId,
  savedMessageRevision: revision,
  savedAt,
  updatedAt: savedAt,
  ...(privateNote === undefined
    ? {}
    : { privateNote: { privacy, text: privateNote } }),
  message,
});

const savedPage = (items, nextCursor = null) => ({
  kind: "saved_message_list",
  privacy,
  items,
  page: { nextCursor },
});

const flush = () => new Promise(setImmediate);

test("hydrates present/absent drafts and paginated saved entries without retaining unavailable data", async () => {
  const unbound = createNormalizedChatCache();
  assert.throws(
    () => unbound.hydrateConversationDraft(absentDraft(0)),
    (error) => error?.code === "identity_required",
  );
  assert.throws(
    () => unbound.hydrateSavedMessageList(savedPage([])),
    (error) => error?.code === "identity_required",
  );

  const cache = createNormalizedChatCache(identity);
  seedConversation(cache);
  const privateDraftText = "actor-only draft body";
  const privateNote = "actor-only saved note";
  const deletedNote = "must not survive deleted hydration";
  const inaccessibleNote = "must not survive inaccessible hydration";
  const cursor = encodeSavedMessageSnapshotCursor({
    savedAt: at(20),
    messageId: "message-deleted",
  });
  const bodies = [
    absentDraft(0),
    draft(7, privateDraftText),
    absentDraft(8),
    savedPage([
      savedEntry(
        "message-visible",
        3,
        at(30),
        { availability: "available", current: savedCurrent("message-visible", "visible body", 2) },
        privateNote,
      ),
      savedEntry(
        "message-deleted",
        4,
        at(20),
        { availability: "unavailable", reason: "deleted" },
        deletedNote,
      ),
    ], cursor),
    savedPage([
      savedEntry(
        "message-inaccessible",
        2,
        at(10),
        { availability: "unavailable", reason: "inaccessible" },
        inaccessibleNote,
      ),
    ]),
  ];
  const requests = [];
  const client = createChatClient({
    endpoint: "/chat/",
    cache,
    getAccessToken: () => "private-token",
    async fetch(url, init) {
      requests.push({ url, init });
      return response(bodies.shift());
    },
  });

  assert.equal((await client.getConversationDraft({ conversationId })).status, "success");
  assert.equal(cache.getState().currentUser.drafts[conversationId], undefined);
  assert.equal(cache.getState().currentUser.draftRevisions[conversationId], undefined);
  assert.equal((await client.getConversationDraft({ conversationId })).status, "success");
  assert.equal(cache.getState().currentUser.drafts[conversationId].content.text, privateDraftText);
  assert.equal(cache.getState().currentUser.draftRevisions[conversationId], 7);
  assert.equal((await client.getConversationDraft({ conversationId })).status, "success");
  assert.deepEqual(cache.getState().currentUser.drafts[conversationId], {
    kind: "clear_tombstone",
    content: null,
  });
  assert.equal(cache.getState().currentUser.draftRevisions[conversationId], 8);

  const first = await client.listSavedMessages({ limit: 2 });
  const second = await client.listSavedMessages({ cursor, limit: 2 });
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.deepEqual(requests.map(({ url }) => url), [
    `/chat/conversations/${conversationId}/draft`,
    `/chat/conversations/${conversationId}/draft`,
    `/chat/conversations/${conversationId}/draft`,
    "/chat/saved-messages?limit=2",
    `/chat/saved-messages?cursor=${encodeURIComponent(cursor)}&limit=2`,
  ]);
  assert.equal(cache.getState().currentUser.savedMessages["message-visible"].privateNote, privateNote);
  assert.equal(selectMessage(cache.getState(), "message-visible").content.text, "visible body");
  assert.equal(cache.getState().currentUser.savedMessageUnavailableReasons["message-deleted"], "deleted");
  assert.equal(cache.getState().currentUser.savedMessageUnavailableReasons["message-inaccessible"], "inaccessible");
  assert.equal(selectMessage(cache.getState(), "message-deleted"), undefined);
  assert.equal(selectMessage(cache.getState(), "message-inaccessible"), undefined);
  assert.equal(JSON.stringify(cache.getState().currentUser.savedMessages).includes(deletedNote), false);
  assert.equal(JSON.stringify(cache.getState().currentUser.savedMessages).includes(inaccessibleNote), false);

  cache.setIdentity({ tenantId, userId: "different-user", sessionId: "different-session" });
  const crossIdentity = JSON.stringify(cache.getState());
  for (const secret of [privateDraftText, privateNote, deletedNote, inaccessibleNote]) {
    assert.equal(crossIdentity.includes(secret), false);
  }
});

test("deduplicates private reads and isolates consumer abort while aborting empty, reset, identity, and close scopes", async () => {
  const cache = createNormalizedChatCache(identity);
  const pending = [];
  const signals = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "dedupe-private-token",
    fetch(_url, init) {
      signals.push(init.signal);
      return new Promise((resolve, reject) => {
        pending.push(resolve);
        init.signal.addEventListener("abort", () => reject(new Error("private abort detail")), { once: true });
      });
    },
  });
  const one = new AbortController();
  const two = new AbortController();
  const first = client.getConversationDraft({ conversationId }, { signal: one.signal });
  const second = client.getConversationDraft({ conversationId }, { signal: two.signal });
  await flush();
  assert.equal(signals.length, 1);
  one.abort();
  assert.equal((await first).status, "aborted");
  assert.equal(signals[0].aborted, false);
  pending.shift()(response(draft(1, "deduplicated")));
  assert.equal((await second).status, "success");

  const allOne = new AbortController();
  const allTwo = new AbortController();
  const allFirst = client.listSavedMessages({ limit: 4 }, { signal: allOne.signal });
  const allSecond = client.listSavedMessages({ limit: 4 }, { signal: allTwo.signal });
  await flush();
  allOne.abort();
  allTwo.abort();
  assert.equal((await allFirst).status, "aborted");
  assert.equal((await allSecond).status, "aborted");
  assert.equal(signals[1].aborted, true);

  for (const invalidate of [
    () => cache.reset(),
    () => cache.setIdentity({ tenantId, userId: "next-user", sessionId: "next-session" }),
  ]) {
    cache.setIdentity(identity);
    const read = client.getConversationDraft({ conversationId });
    await flush();
    const signal = signals.at(-1);
    invalidate();
    assert.equal((await read).status, "aborted");
    assert.equal(signal.aborted, true);
  }

  cache.setIdentity(identity);
  const closing = client.listSavedMessages({ limit: 3 });
  await flush();
  const closeSignal = signals.at(-1);
  client.close();
  assert.equal((await closing).status, "closed");
  assert.equal(closeSignal.aborted, true);
});

test("older HTTP private snapshots preserve newer realtime and optimistic state", async () => {
  const cache = createNormalizedChatCache(identity);
  seedConversation(cache);
  const releases = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "ordering-token",
    fetch() { return new Promise((resolve) => releases.push(resolve)); },
  });

  const draftRead = client.getConversationDraft({ conversationId });
  await flush();
  cache.applyDurableEvent({
    eventId: "draft-newer",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: `user:${userId}`,
    type: CHAT_DURABLE_EVENT_TYPES.draftUpdated,
    occurredAt: at(15),
    payload: {
      actorUserId: userId,
      input: {
        operation: "synchronize_draft",
        intent: "clear",
        conversationId,
        baseRevision: 7,
        deviceMutationId: "device-newer",
        idempotencyKey: "draft-newer-key",
      },
      result: {
        operation: "synchronize_draft",
        intent: "clear",
        reconciliationStatus: "applied",
        conversationId,
        baseRevision: 7,
        deviceMutationId: "device-newer",
        idempotencyKey: "draft-newer-key",
        canonicalRevision: 8,
        canonicalUpdatedAt: at(8),
        draft: { kind: "clear_tombstone", content: null },
      },
    },
  });
  releases.shift()(response(draft(7, "older HTTP draft")));
  assert.equal((await draftRead).status, "success");
  assert.equal(cache.getState().currentUser.draftRevisions[conversationId], 8);
  assert.equal(cache.getState().currentUser.drafts[conversationId].kind, "clear_tombstone");

  const savedRead = client.listSavedMessages({ limit: 1 });
  await flush();
  cache.applyDurableEvent({
    eventId: "saved-newer",
    protocolVersion: CHAT_PROTOCOL_VERSION,
    tenantId,
    streamId: `user:${userId}`,
    type: CHAT_DURABLE_EVENT_TYPES.savedMessageUpdated,
    occurredAt: at(16),
    payload: {
      operation: "set_saved_message",
      messageId: "message-ordering",
      savedMessageRevision: 4,
      savedMessage: {
        messageId: "message-ordering",
        isSaved: true,
        privateNote: "newer realtime note",
      },
    },
  });
  releases.shift()(response(savedPage([
    savedEntry(
      "message-ordering",
      3,
      at(30),
      { availability: "available", current: savedCurrent("message-ordering", "older body") },
      "older HTTP note",
    ),
  ])));
  assert.equal((await savedRead).status, "success");
  assert.equal(cache.getState().currentUser.savedMessageRevisions["message-ordering"], 4);
  assert.equal(cache.getState().currentUser.savedMessages["message-ordering"].privateNote, "newer realtime note");

  cache.hydrateMessageTimeline({
    conversationId,
    messages: [{
      ...savedCurrent("message-pending", "locally visible body"),
      tenantId,
      reactions: [],
      isThreadRoot: false,
    }],
    pagination: {
      older: { available: false },
      newer: { available: false },
    },
    replay: { resumeFrom: { eventId: "pending-message-snapshot" } },
  });
  cache.beginOptimisticSavedMessage({
    operation: "set_saved_message",
    intent: "save",
    messageId: "message-pending",
    expectedSavedMessageRevision: 0,
    idempotencyKey: "pending-private-key",
    privateNote: "new optimistic note",
  });
  const pendingRead = client.listSavedMessages({ limit: 1 });
  await flush();
  releases.shift()(response(savedPage([
    savedEntry(
      "message-pending",
      1,
      at(29),
      { availability: "available", current: savedCurrent("message-pending", "canonical body") },
      "older canonical note",
    ),
  ])));
  assert.equal((await pendingRead).status, "success");
  const pendingState = cache.getState().currentUser;
  assert.equal(pendingState.savedMessages["message-pending"].privateNote, "new optimistic note");
  assert.equal(
    pendingState.pendingSavedMessageUpdates["message-pending"].authoritativeSavedMessage.privateNote,
    "older canonical note",
  );
});

test("rejects malformed inputs/responses and structurally redacts all private failure paths", async () => {
  const diagnostics = [];
  const fetches = [];
  const secrets = [
    "token-secret",
    "draft-secret",
    "note-secret",
    "https://private.example.test/path",
    "response-body-secret",
    "thrown-secret",
    "server-detail-secret",
  ];
  const cache = createNormalizedChatCache(identity);
  const outcomes = [];
  const makeClient = (getAccessToken, fetch) => createChatClient({
    endpoint: secrets[3],
    cache,
    getAccessToken,
    fetch,
    queries: { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  });

  const validationClient = makeClient(() => secrets[0], async () => {
    fetches.push("unexpected");
    return response({});
  });
  outcomes.push(await validationClient.getConversationDraft({ conversationId, userId }));
  outcomes.push(await validationClient.listSavedMessages({ limit: 0 }));
  assert.equal(fetches.length, 0);

  const malformedClient = makeClient(() => secrets[0], async () => response({
    kind: "conversation_draft",
    privacy,
    conversationId,
    state: "present",
    canonicalRevision: 1,
    canonicalUpdatedAt: at(1),
    content: { privacy, value: { format: "plain", text: secrets[1], attachments: [] } },
    extraBody: secrets[4],
  }));
  outcomes.push(await malformedClient.getConversationDraft({ conversationId }));

  const tokenClient = makeClient(() => { throw new Error(`${secrets[5]} ${secrets[2]}`); }, async () => response({}));
  outcomes.push(await tokenClient.listSavedMessages({ limit: 1 }));

  let authCalls = 0;
  const authClient = makeClient(() => secrets[0], async () => {
    authCalls += 1;
    return response({ detail: secrets[6] }, authCalls === 1 ? 401 : 403);
  });
  outcomes.push(await authClient.listSavedMessages({ limit: 1 }));
  assert.equal(authCalls, 2);

  const rejectedClient = makeClient(() => secrets[0], async () => response({ detail: secrets[6] }, 422));
  outcomes.push(await rejectedClient.listSavedMessages({ limit: 1 }));
  const serverClient = makeClient(() => secrets[0], async () => response({ detail: secrets[6] }, 503));
  outcomes.push(await serverClient.listSavedMessages({ limit: 1 }));
  const thrownClient = makeClient(() => secrets[0], async () => { throw { body: secrets[4], note: secrets[2] }; });
  outcomes.push(await thrownClient.listSavedMessages({ limit: 1 }));
  const jsonClient = makeClient(() => secrets[0], async () => ({
    ok: true,
    status: 200,
    async json() { throw new Error(`${secrets[5]} ${secrets[1]}`); },
  }));
  outcomes.push(await jsonClient.listSavedMessages({ limit: 1 }));

  assert.deepEqual(outcomes.map((item) => item.status), [
    "validation",
    "validation",
    "malformed_response",
    "authentication",
    "authentication",
    "rejected",
    "transport",
    "transport",
    "malformed_response",
  ]);
  const serializedFailures = JSON.stringify({ diagnostics, outcomes });
  for (const secret of secrets) assert.equal(serializedFailures.includes(secret), false);
  for (const diagnostic of diagnostics) {
    assert.deepEqual(
      Object.keys(diagnostic).sort(),
      ["attempt", "event", "query", ...(diagnostic.httpStatus === undefined ? [] : ["httpStatus"])].sort(),
    );
  }
});
