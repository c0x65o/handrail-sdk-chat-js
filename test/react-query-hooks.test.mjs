import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const React = await import("react");
const { act, createElement } = React;
const { renderToString } = await import("react-dom/server");
const ReactTestRenderer = await import("react-test-renderer");
const { create } = ReactTestRenderer.default;
const {
  ChatProvider,
  useAttachmentUpload,
  useConversation,
  useConversationParticipants,
  useConversations,
  useDirectMessageReceipt,
  useDirectorySearch,
  useDirectoryUsers,
  useDraft,
  useHuddle,
  useMembers,
  useMessages,
  useMessageReminders,
  usePresence,
  useReadState,
  useSavedMessages,
  useThread,
  useTyping,
  useChatSelector,
} = await import("@handrail/chat/react");
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createNormalizedChatCache,
  encodeHostDirectorySearchCursor,
} = await import("@handrail/chat/client");
const { CHAT_PROTOCOL_VERSION, encodeConversationSnapshotCursor, parseConversationListSnapshot } = await import("@handrail/chat");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const tenantId = "tenant-react-hooks";
const userId = "actor-react-hooks";
const otherUserId = "user-other";
const channelId = "conversation-parent";
const directId = "conversation-direct";
const threadId = "conversation-thread";
const rootMessageId = "message-root";
const now = "2035-01-02T03:04:05.000Z";
const identity = { tenantId, userId, sessionId: "session-react-hooks" };
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: { typing: true, presence: true, huddles: true },
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const snapshotMetadata = {
  ...metadata,
  feature: { name: "conversation_snapshots", version: 1 },
};
const directoryMetadata = {
  ...metadata,
  feature: { name: "host_directory_snapshots", version: 1 },
};
const readyState = Object.freeze({
  state: "ready",
  clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  metadata,
  enabledFeatures: metadata.enabledFeatures,
});

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

const member = (conversationId, selectedUserId = userId) => ({
  tenantId,
  conversationId,
  userId: selectedUserId,
  role: "member",
  state: "active",
  joinedAt: now,
  updatedAt: now,
});
const readState = (conversationId, selectedUserId = userId, lastReadSequence = 1) => ({
  conversationId,
  userId: selectedUserId,
  lastReadSequence,
  updatedAt: now,
});
const conversation = (id, type = "channel", overrides = {}) => ({
  id,
  tenantId,
  type,
  visibility: type === "channel" ? "public" : "private",
  ...(type === "channel" ? { name: "Project chat" } : {}),
  ...(type === "thread"
    ? { parentConversationId: channelId, rootMessageId }
    : {}),
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 3,
  unreadMentionCount: 0,
  currentMember: member(id),
  currentReadState: readState(id),
  currentPreference: {
    conversationId: id,
    userId,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: now,
  },
  activeMemberUserIds: [userId, otherUserId],
  ...overrides,
});
const listSnapshot = (items, nextCursor) => ({
  kind: "conversation_list",
  scope: { type: "organization" },
  items,
  page: nextCursor === undefined ? {} : { nextCursor },
  _meta: snapshotMetadata,
});
const detailSnapshot = (item) => ({
  kind: "conversation_detail",
  conversation: {
    ...item,
    memberUserIds: [userId, otherUserId],
    currentPreference: {
      conversationId: item.id,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: now,
    },
  },
  _meta: snapshotMetadata,
});
const message = (conversationId, sequence, id = `${conversationId}-${sequence}`, overrides = {}) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: otherUserId },
  sequence,
  createdAt: now,
  updatedAt: now,
  revision: { revision: 1 },
  content: { format: "plain", text: `${conversationId} ${sequence}` },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
  ...overrides,
});
const timeline = (conversationId, messages) => ({
  conversationId,
  messages,
  pagination: {
    older: { available: false },
    newer: { available: false },
  },
  replay: { resumeFrom: { eventId: `event-${conversationId}` } },
});

const createSeededCache = () => {
  const cache = createNormalizedChatCache(identity);
  const channel = conversation(channelId, "channel", { unreadMentionCount: 1 });
  const thread = conversation(threadId, "thread");
  const direct = conversation(directId, "direct");
  cache.hydrateConversationList(listSnapshot([channel, direct, thread]));
  cache.hydrateConversationDetail(detailSnapshot(channel));
  cache.hydrateMessageTimeline(timeline(channelId, [
    message(channelId, 1, rootMessageId, {
      isThreadRoot: true,
      threadSummary: {
        threadId,
        replyCount: 1,
        participantIds: [otherUserId],
        unreadCount: 1,
        lastReplyAt: now,
      },
    }),
  ]));
  cache.hydrateMessageTimeline(timeline(threadId, [message(threadId, 1)]));
  return cache;
};

const safeUser = (selectedUserId) => ({
  kind: "active",
  userId: selectedUserId,
  displayName: `User ${selectedUserId}`,
  avatar: { kind: "none" },
});

const createExternalClient = (cache, overrides = {}) => {
  const directory = new Map([
    [userId, safeUser(userId)],
    [otherUserId, { kind: "redacted", userId: otherUserId }],
  ]);
  const draftListeners = new Set();
  const huddleListeners = new Set();
  const threadListeners = new Set();
  let draft = Object.freeze({
    conversationId: channelId,
    status: "ready",
    authoritativeRevision: 1,
    dirty: false,
    draft: Object.freeze({
      kind: "replaced",
      content: Object.freeze({ format: "plain", text: "initial", attachments: Object.freeze([]) }),
    }),
  });
  let huddle = Object.freeze({
    conversationId: channelId,
    hydrationStatus: "ready",
    media: Object.freeze({ state: "idle" }),
    canonicalState: Object.freeze({ status: "inactive", conversationId: channelId }),
  });
  let opening = Object.freeze({
    state: "ready",
    rootMessageId,
    parentConversationId: channelId,
    threadConversationId: threadId,
    reconciliationStatus: "existing",
  });
  const client = {
    endpoint: "/chat",
    state: readyState,
    realtime: undefined,
    coordination: undefined,
    cache,
    start: async () => readyState,
    subscribeLifecycle: () => () => {},
    close() {},
    listConversations: async () => ({ status: "validation", message: "The snapshot query input is invalid." }),
    getConversation: async () => ({ status: "validation", message: "The snapshot query input is invalid." }),
    getMessageTimeline: async () => ({ status: "validation", message: "The snapshot query input is invalid." }),
    hydrateDirectoryUsers: async (ids) => ({
      status: "success",
      value: { users: ids.flatMap((id) => directory.has(id) ? [directory.get(id)] : []) },
    }),
    selectDirectoryUser: (id) => directory.get(id),
    getDirectorySearchState: () => ({ state: "idle" }),
    subscribeDirectorySearch: () => () => {},
    cancelDirectorySearch() {},
    searchDirectoryUsers: async () => ({ status: "validation", message: "invalid" }),
    getThreadOpeningState: () => opening,
    subscribeThreadOpening(_id, listener) {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    openThread: async () => opening,
    selectConversationDraft: () => draft,
    subscribeConversationDraft(_id, listener) {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    openConversationDraft: async () => draft,
    getHuddleState: () => Object.freeze({ ...huddle }),
    subscribeHuddle(_id, listener) {
      huddleListeners.add(listener);
      return () => huddleListeners.delete(listener);
    },
    hydrateHuddle: async () => ({ status: "success", operation: "hydrate", state: huddle.canonicalState, applied: false }),
    ...overrides,
  };
  return {
    client,
    setDraft(next) {
      const previous = draft;
      draft = Object.freeze(next);
      for (const listener of draftListeners) listener(draft, previous);
    },
    setHuddle(next) {
      const previous = huddle;
      huddle = Object.freeze(next);
      for (const listener of huddleListeners) listener(huddle, previous);
    },
    setOpening(next) {
      const previous = opening;
      opening = Object.freeze(next);
      for (const listener of threadListeners) listener(opening, previous);
    },
  };
};

test("cache hooks update declaratively and selector equality isolates unrelated rerenders", async () => {
  const cache = createSeededCache();
  const { client } = createExternalClient(cache, {
    listConversations: async () => ({ status: "success", value: listSnapshot([
      conversation(channelId, "channel", { unreadMentionCount: 1 }),
      conversation(directId, "direct"), conversation(threadId, "thread"),
    ]) }),
  });
  const results = [];
  let selectorRenders = 0;
  const stableSelector = (state) => state.entities.conversations[channelId];
  const Capture = () => {
    selectorRenders += 1;
    useChatSelector(stableSelector);
    results.push({
      conversations: useConversations(),
      conversation: useConversation(channelId),
      messages: useMessages(channelId),
      members: useMembers(channelId),
      read: useReadState(channelId),
      receipt: useDirectMessageReceipt({
        conversationId: directId,
        otherMemberReadState: readState(directId, otherUserId, 3),
        messageSequence: 2,
      }),
      typing: useTyping(channelId),
      presence: usePresence(),
    });
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture)));
    await flush();
  });
  const value = results.at(-1);
  assert.equal(value.conversations.status, "ready");
  assert.equal(value.conversation.data.name, "Project chat");
  assert.deepEqual(value.messages.data.messages.map(({ id }) => id), [rootMessageId]);
  assert.equal(value.members.data.members[1].user.kind, "redacted");
  assert.equal(value.read.data.unreadCount, 2);
  assert.equal(value.read.data.unreadMentionCount, 1);
  assert.equal(value.receipt.status, "ready");
  assert.equal(value.receipt.data, true);
  assert.equal(value.typing.status, "empty");
  assert.equal(value.presence.status, "empty");

  await act(async () => {
    cache.applyEphemeralSignal({
      eventId: "typing-react-hook",
      protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId,
      streamId: channelId,
      type: "typing.signal",
      occurredAt: now,
      payload: {
        capability: "typing",
        durability: "ephemeral",
        actorUserId: otherUserId,
        deviceId: "device-other",
        sessionId: "session-other",
        sequence: 1,
        sentAt: now,
        expiresAt: "2035-01-02T03:05:05.000Z",
        state: "start",
        scope: {
          type: "conversation",
          conversationId: channelId,
          visibility: "public",
          audience: "active_participants",
        },
      },
    }, Date.parse(now));
    cache.applyEphemeralSignal({
      eventId: "presence-react-hook",
      protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId,
      streamId: `user:${userId}`,
      type: "presence.signal",
      occurredAt: now,
      payload: {
        capability: "presence",
        durability: "ephemeral",
        actorUserId: otherUserId,
        deviceId: "device-other",
        sessionId: "session-other",
        sequence: 2,
        sentAt: now,
        expiresAt: "2035-01-02T03:05:05.000Z",
        state: "online",
        scope: { type: "user_private", userId },
      },
    }, Date.parse(now));
  });
  assert.equal(results.at(-1).typing.data[0].userId, otherUserId);
  assert.equal(results.at(-1).presence.data[0].state, "online");

  const beforeUnrelatedMutation = selectorRenders;
  await act(async () => {
    cache.setHuddleState({ status: "inactive", conversationId: threadId });
  });
  assert.equal(selectorRenders, beforeUnrelatedMutation);

  await act(async () => {
    cache.hydrateConversationList(listSnapshot([
      conversation(channelId, "channel", {
        name: "Renamed project chat",
        updatedAt: "2035-01-02T03:04:06.000Z",
      }),
      conversation(threadId, "thread"),
    ]));
  });
  assert.equal(results.at(-1).conversation.data.name, "Renamed project chat");
  assert.ok(selectorRenders > beforeUnrelatedMutation);
  await act(async () => renderer.unmount());
});

test("directory-user batches coalesce duplicates, request only misses, and retain caller order", async () => {
  const cache = createSeededCache();
  const cachedId = "directory-cached";
  const firstMissingId = "directory-first-missing";
  const secondMissingId = "directory-second-missing";
  const directory = new Map([[cachedId, safeUser(cachedId)]]);
  const calls = [];
  const { client } = createExternalClient(cache, {
    async hydrateDirectoryUsers(ids) {
      calls.push([...ids]);
      for (const id of ids) directory.set(id, safeUser(id));
      return {
        status: "success",
        value: { users: ids.map((id) => directory.get(id)) },
      };
    },
    selectDirectoryUser: (id) => directory.get(id),
  });
  const results = [];
  const Capture = ({ ids }) => {
    results.push(useDirectoryUsers(ids));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(
      ChatProvider,
      { client },
      createElement(Capture, {
        ids: [firstMissingId, cachedId, secondMissingId, firstMissingId],
      }),
    ));
    await flush();
  });

  assert.deepEqual(calls, [[firstMissingId, secondMissingId]]);
  assert.equal(results.at(-1).status, "ready");
  assert.deepEqual(results.at(-1).data.map(({ userId: id }) => id), [
    firstMissingId,
    cachedId,
    secondMissingId,
  ]);

  await act(async () => {
    renderer.update(createElement(
      ChatProvider,
      { client },
      createElement(Capture, {
        ids: [secondMissingId, cachedId, firstMissingId, cachedId],
      }),
    ));
    await flush();
  });
  assert.equal(calls.length, 1, "a fully cached request must not hydrate again");
  assert.deepEqual(results.at(-1).data.map(({ userId: id }) => id), [
    secondMissingId,
    cachedId,
    firstMissingId,
  ]);
  await act(async () => renderer.unmount());
});

test("directory rate limits retry after cooldown, recover identities, and cancel on unmount", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = createSeededCache();
  const initialState = cache.getState();
  const directory = new Map();
  let calls = 0;
  let limited = true;
  const { client } = createExternalClient(cache, {
    async hydrateDirectoryUsers(ids) {
      calls += 1;
      if (limited) return { status: "rejected", httpStatus: 429, message: "Rate limited" };
      for (const id of ids) directory.set(id, safeUser(id));
      return { status: "success", value: { users: ids.map((id) => directory.get(id)) } };
    },
    selectDirectoryUser: (id) => directory.get(id),
  });
  let result;
  let members;
  let thread;
  const Capture = () => {
    result = useDirectoryUsers(["recovering-user"]);
    members = useMembers(channelId);
    thread = useThread(rootMessageId);
    return null;
  };
  let renderer;
  const mount = async () => act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture)));
    await flush();
  });
  await mount();
  assert.equal(result.status, "error");
  assert.equal(calls, 2);
  assert.equal(members.data.members[1].user, undefined);
  const initialThread = thread.data;
  await act(async () => { t.mock.timers.tick(59_999); await flush(); });
  assert.equal(calls, 2, "no immediate retry storm");
  await act(async () => { t.mock.timers.tick(1); await flush(); });
  assert.equal(calls, 4);
  assert.equal(result.status, "error");
  limited = false;
  await act(async () => { t.mock.timers.tick(60_000); await flush(); });
  assert.equal(calls, 6);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.data, [safeUser("recovering-user")]);
  assert.deepEqual(members.data.members[1].user, safeUser(otherUserId));
  assert.equal(thread.data, initialThread, "mounted thread identity and follow state stay unchanged");
  assert.equal(cache.getState(), initialState, "identity recovery must not mutate thread/follow state");
  await act(async () => { t.mock.timers.tick(120_000); await flush(); });
  assert.equal(calls, 6, "successful recovery stops retries");
  await act(async () => renderer.unmount());

  directory.clear();
  limited = true;
  await mount();
  assert.equal(calls, 8);
  await act(async () => renderer.unmount());
  await act(async () => { t.mock.timers.tick(120_000); await flush(); });
  assert.equal(calls, 8, "unmount cancels the pending retry");
});

test("directory-user batches ignore aborted completions from a previous identity", async () => {
  const cache = createSeededCache();
  const requestedId = "directory-identity-bound";
  const directory = new Map();
  const pending = [];
  const { client } = createExternalClient(cache, {
    hydrateDirectoryUsers(ids, options) {
      return new Promise((resolve) => {
        pending.push({ ids: [...ids], signal: options?.signal, resolve });
      });
    },
    selectDirectoryUser: (id) => directory.get(id),
  });
  const results = [];
  const Capture = () => {
    results.push(useDirectoryUsers([requestedId]));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture)));
    await flush();
  });
  assert.equal(pending.length, 1);

  await act(async () => {
    cache.setIdentity({
      tenantId,
      userId: "actor-directory-replacement",
      sessionId: "session-directory-replacement",
    });
    await flush();
  });
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 2);

  await act(async () => {
    const staleUser = { ...safeUser(requestedId), displayName: "Stale identity" };
    directory.set(requestedId, staleUser);
    pending[0].resolve({ status: "success", value: { users: [staleUser] } });
    await flush();
  });
  assert.equal(results.at(-1).status, "loading");
  assert.deepEqual(results.at(-1).data, []);

  await act(async () => {
    const currentUser = { ...safeUser(requestedId), displayName: "Current identity" };
    directory.set(requestedId, currentUser);
    pending[1].resolve({ status: "success", value: { users: [currentUser] } });
    await flush();
  });
  assert.equal(results.at(-1).status, "ready");
  assert.equal(results.at(-1).data[0].displayName, "Current identity");
  await act(async () => renderer.unmount());
});

test("conversation participants resolve 50 list summaries without opening conversation details", async () => {
  const cache = createNormalizedChatCache(identity);
  const sharedId = "participant-shared-redacted";
  const unavailableId = "participant-unavailable";
  const conversationIds = Array.from({ length: 50 }, (_, index) =>
    `conversation-participants-${index}`);
  const summaries = conversationIds.map((id, index) => conversation(
    id,
    index % 2 === 0 ? "direct" : "group_direct",
    {
      activeMemberUserIds: [
        userId,
        sharedId,
        index === 0 ? unavailableId : `participant-${index}`,
      ],
    },
  ));
  cache.hydrateConversationList(listSnapshot(summaries));

  const batchCalls = [];
  const detailRequests = [];
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url, init = {}) {
      if (url === "/chat/_meta") return response(metadata);
      if (url === "/chat/directory/users:batch") {
        const ids = JSON.parse(init.body).userIds;
        batchCalls.push(ids);
        return response({
          kind: "host_directory_batch",
          users: ids.map((id) => {
            if (id === sharedId) return { kind: "redacted", userId: id };
            if (id === unavailableId) {
              return {
                kind: "unavailable",
                userId: id,
                reason: "temporarily_unavailable",
              };
            }
            return safeUser(id);
          }),
          _meta: directoryMetadata,
        });
      }
      if (url.includes("/conversations/")) detailRequests.push(url);
      return response({ error: { code: "unexpected_request" } }, 500);
    },
  });
  assert.equal((await client.start()).state, "ready");

  const results = new Map();
  const Capture = ({ conversationId }) => {
    results.set(conversationId, useConversationParticipants(conversationId));
    return null;
  };
  const tree = () => createElement(
    ChatProvider,
    { client },
    ...conversationIds.map((conversationId) => createElement(Capture, {
      key: conversationId,
      conversationId,
    })),
    createElement(Capture, {
      key: "conversation-inaccessible",
      conversationId: "conversation-inaccessible",
    }),
  );
  let renderer;
  await act(async () => {
    renderer = create(tree());
    await flush();
    await flush();
  });

  assert.equal(results.size, 51);
  for (const conversationId of conversationIds) {
    assert.equal(results.get(conversationId).status, "ready");
    assert.equal(results.get(conversationId).data.participantUserIds.length, 3);
  }
  assert.equal(results.get("conversation-inaccessible").status, "loading");
  assert.equal(results.get("conversation-inaccessible").data, undefined);
  const hydratedIds = batchCalls.flat();
  assert.equal(hydratedIds.length, 52);
  assert.equal(new Set(hydratedIds).size, 52);
  assert.equal(hydratedIds.filter((id) => id === userId).length, 1);
  assert.equal(hydratedIds.filter((id) => id === sharedId).length, 1);
  assert.equal(detailRequests.length, 0);
  const firstParticipants = results.get(conversationIds[0]).data.participants;
  assert.deepEqual(firstParticipants[1], {
    userId: sharedId,
    user: { kind: "redacted", userId: sharedId },
  });
  assert.deepEqual(firstParticipants[2], {
    userId: unavailableId,
    user: {
      kind: "unavailable",
      userId: unavailableId,
      reason: "temporarily_unavailable",
    },
  });
  assert.doesNotMatch(
    JSON.stringify([firstParticipants[1], firstParticipants[2]]),
    /displayName|avatar|email|roles|permissions|token/,
  );

  const authoritativeId = "participant-authoritative";
  await act(async () => {
    cache.hydrateConversationDetail({
      ...detailSnapshot(summaries[0]),
      conversation: {
        ...detailSnapshot(summaries[0]).conversation,
        memberUserIds: [userId, authoritativeId],
        memberListRevision: 9,
      },
    });
    await flush();
  });
  assert.deepEqual(
    results.get(conversationIds[0]).data.participantUserIds,
    [userId, authoritativeId],
  );
  assert.equal(
    results.get(conversationIds[0]).data.participants[1].user.displayName,
    `User ${authoritativeId}`,
  );
  assert.deepEqual(batchCalls.at(-1), [authoritativeId]);
  assert.deepEqual(
    cache.getState().metadata.conversationListParticipantUserIds[conversationIds[0]],
    [userId, sharedId, unavailableId],
  );
  assert.equal(cache.getState().metadata.memberListRevisions[conversationIds[0]], 9);
  assert.equal(detailRequests.length, 0);

  await act(async () => {
    cache.setIdentity({
      tenantId,
      userId: "participant-replacement",
      sessionId: "participant-replacement-session",
    });
    await flush();
  });
  assert.equal(results.get(conversationIds[0]).status, "loading");
  assert.equal(results.get(conversationIds[0]).data, undefined);
  assert.deepEqual(cache.getState().metadata.conversationListParticipantUserIds, {});
  assert.equal(detailRequests.length, 0);

  await act(async () => renderer.unmount());
  client.close();
});

test("conversation discovery refreshes restored lists and preserves pagination without refetch loops", async () => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationList(listSnapshot([conversation(channelId)]));
  const calls = [];
  const cursor = encodeConversationSnapshotCursor({ isStarred: false, navigationRank: 1, activityAt: now, conversationId: channelId });
  const serverSnapshot = (items, nextCursor) => parseConversationListSnapshot(listSnapshot(items.map(item => ({
    ...item, hasActiveHuddle: false, currentPreference: { ...item.currentPreference, isStarred: false },
  })), nextCursor));
  let finishRefresh;
  const client = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "token",
    async fetch(url, init) {
      if (url === "/chat/_meta") return response(metadata);
      calls.push({ url, signal: init.signal });
      if (!url.includes("cursor=")) {
        return new Promise(resolve => { finishRefresh = () => resolve(response(serverSnapshot([
          conversation(directId, "direct"), conversation(channelId),
        ], cursor))); });
      }
      return response(serverSnapshot([conversation("new-group", "group_direct")]));
    },
  });
  await client.start();
  let result;
  const Capture = ({ enabled = true }) => {
    result = useConversations({ enabled });
    return null;
  };
  let renderer;
  const render = enabled => createElement(ChatProvider, { client }, createElement(Capture, { enabled }));
  await act(async () => { renderer = create(render(false)); await flush(); });
  assert.equal(calls.length, 0, "disabled discovery must not request a snapshot");
  await act(async () => { renderer.update(render(true)); await flush(); });
  assert.equal(calls.length, 1, "cached list still needs a current server snapshot");
  assert.deepEqual(result.data.conversations.map(item => item.id), [channelId], "cached entries stay visible during refresh");
  await act(async () => { finishRefresh(); await flush(); });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.data.conversations.map(item => item.id), [directId, channelId]);
  assert.equal(calls[0].signal.aborted, false, "hydration must not cancel its own request");
  await act(async () => { await result.data.loadMore(); await flush(); });
  assert.deepEqual(result.data.conversations.map(item => item.id), [directId, channelId, "new-group"]);
  assert.equal(calls.length, 2, "pagination must not trigger another first-page request");
  await act(async () => { renderer.unmount(); });
  await act(async () => { renderer = create(render(true)); await flush(); });
  assert.equal(calls.length, 3, "a remounted consumer revalidates discovery");
  await act(async () => {
    cache.setIdentity({ ...identity, sessionId: "replacement-session" });
    await flush();
  });
  assert.equal(calls[2].signal.aborted, true, "a replaced identity cancels the old refresh");
  assert.equal(calls.length, 4, "a replaced identity gets its own discovery request");
  await act(async () => { renderer.unmount(); });
  assert.equal(calls[3].signal.aborted, true, "unmount cancels an in-flight refresh");
  client.close();
});

test("message hooks pass stable conversation-local cursors and merge adjacent pages", async () => {
  const cache = createSeededCache();
  cache.hydrateMessageTimeline({
    ...timeline(channelId, [message(channelId, 1, rootMessageId, {
      isThreadRoot: true,
      threadSummary: {
        threadId,
        replyCount: 1,
        participantIds: [otherUserId],
        unreadCount: 1,
      },
    })]),
    pagination: {
      older: { available: true, cursor: 1 },
      newer: { available: false },
    },
  });
  const calls = [];
  const { client } = createExternalClient(cache, {
    async getMessageTimeline(input) {
      calls.push(input);
      const value = timeline(channelId, [message(channelId, 0, "message-older")]);
      cache.hydrateMessageTimeline(value);
      return { status: "success", value };
    },
  });
  const results = [];
  const Capture = () => {
    results.push(useMessages(channelId, { limit: 25 }));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture)));
  });
  await act(async () => results.at(-1).data.loadOlder());
  assert.deepEqual(calls, [{
    conversationId: channelId,
    direction: "backward",
    cursor: 1,
    limit: 25,
  }]);
  assert.deepEqual(results.at(-1).data.messages.map(({ id }) => id), [
    "message-older",
    rootMessageId,
  ]);
  await act(async () => renderer.unmount());
});

test("saved-message hooks preserve opaque pagination order and unavailable entries", async () => {
  const cache = createSeededCache();
  const cursor = "opaque-saved-page-token";
  const calls = [];
  const pages = [
    {
      kind: "saved_message_list",
      privacy: "actor_private",
      items: [{
        messageId: "saved-visible",
        savedMessageRevision: 1,
        savedAt: now,
        updatedAt: now,
        message: {
          availability: "available",
          current: {
            id: "saved-visible",
            conversationId: channelId,
            author: { type: "user", userId: otherUserId },
            sequence: 2,
            createdAt: now,
            updatedAt: now,
            revision: { revision: 1 },
            content: { format: "plain", text: "saved" },
            attachmentMetadata: [],
          },
        },
      }],
      page: { nextCursor: cursor },
    },
    {
      kind: "saved_message_list",
      privacy: "actor_private",
      items: [{
        messageId: "saved-unavailable",
        savedMessageRevision: 2,
        savedAt: now,
        updatedAt: now,
        message: { availability: "unavailable", reason: "inaccessible" },
      }],
      page: { nextCursor: null },
    },
    {
      kind: "saved_message_list",
      privacy: "actor_private",
      items: [],
      page: { nextCursor: null },
    },
  ];
  const { client } = createExternalClient(cache, {
    async listSavedMessages(input) {
      calls.push(input);
      const value = pages.shift();
      cache.hydrateSavedMessageList(value);
      return { status: "success", value };
    },
  });
  const results = [];
  const Capture = () => {
    results.push(useSavedMessages({ limit: 1 }));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture)));
    await flush();
  });
  assert.equal(results.at(-1).status, "ready");
  assert.equal(results.at(-1).data.nextCursor, cursor);
  await act(async () => {
    await results.at(-1).data.loadMore();
  });
  assert.deepEqual(calls, [{ limit: 1 }, { limit: 1, cursor }]);
  assert.deepEqual(results.at(-1).data.items.map(({ messageId }) => messageId), [
    "saved-visible",
    "saved-unavailable",
  ]);
  assert.deepEqual(results.at(-1).data.items[1].message, {
    availability: "unavailable",
    reason: "inaccessible",
  });
  assert.equal(results.at(-1).data.nextCursor, null);
  await act(async () => {
    cache.setIdentity({
      tenantId,
      userId: "actor-replacement",
      sessionId: "session-replacement",
    });
    await flush();
  });
  assert.equal(results.at(-1).status, "empty");
  assert.deepEqual(results.at(-1).data.items, []);
  assert.deepEqual(calls.at(-1), { limit: 1 });
  await act(async () => renderer.unmount());
});

test("message-reminder hooks preserve opaque pagination order and identity scope", async () => {
  const cache = createSeededCache();
  const cursor = "opaque-reminder-page-token";
  const calls = [];
  const pages = [{
    kind: "message_reminder_list",
    privacy: "actor_private",
    items: [{
      conversationId: channelId,
      messageId: "reminder-one",
      reminderRevision: 1,
      reminder: {
        privacy: "affected_authenticated_actor",
        state: "scheduled",
        dueAt: "2099-01-02T12:00:00.000Z",
      },
    }],
    page: { nextCursor: cursor },
  }, {
    kind: "message_reminder_list",
    privacy: "actor_private",
    items: [{
      conversationId: channelId,
      messageId: "reminder-two",
      reminderRevision: 2,
      reminder: {
        privacy: "affected_authenticated_actor",
        state: "scheduled",
        dueAt: "2099-01-03T12:00:00.000Z",
      },
    }],
    page: { nextCursor: null },
  }, {
    kind: "message_reminder_list",
    privacy: "actor_private",
    items: [],
    page: { nextCursor: null },
  }];
  const { client } = createExternalClient(cache, {
    async listMessageReminders(input) {
      calls.push(input);
      const value = pages.shift();
      cache.hydrateMessageReminderList(value);
      return { status: "success", value };
    },
  });
  const results = [];
  const Capture = () => {
    results.push(useMessageReminders({ limit: 1 }));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture)));
    await flush();
  });
  assert.equal(results.at(-1).status, "ready");
  assert.equal(results.at(-1).data.nextCursor, cursor);
  await act(async () => results.at(-1).data.loadMore());
  assert.deepEqual(calls, [{ limit: 1 }, { limit: 1, cursor }]);
  assert.deepEqual(results.at(-1).data.items.map(({ messageId }) => messageId), [
    "reminder-one",
    "reminder-two",
  ]);
  await act(async () => {
    cache.setIdentity({
      tenantId,
      userId: "reminder-replacement",
      sessionId: "reminder-replacement-session",
    });
    await flush();
  });
  assert.equal(results.at(-1).status, "empty");
  assert.deepEqual(results.at(-1).data.items, []);
  await act(async () => renderer.unmount());
});

test("directory search observes the client debounce runtime and exposes only redacted summaries", async () => {
  const tasks = [];
  const cursor = encodeHostDirectorySearchCursor({ query: "avery", continuation: "page-2" });
  const client = createChatClient({
    endpoint: "/chat",
    cache: createNormalizedChatCache(identity),
    getAccessToken: () => "token",
    directory: {
      searchDebounceMs: 300,
      schedule(task, delayMs) {
        const entry = { task, delayMs, cancelled: false };
        tasks.push(entry);
        return () => { entry.cancelled = true; };
      },
    },
    async fetch(url) {
      if (url === "/chat/_meta") return response(metadata);
      return response({
        kind: "host_directory_search",
        users: [{ kind: "redacted", userId: otherUserId }],
        page: { nextCursor: cursor },
        _meta: directoryMetadata,
      });
    },
  });
  assert.equal((await client.start()).state, "ready");
  const results = [];
  const Capture = ({ query }) => {
    results.push(useDirectorySearch(query, { limit: 5 }));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client }, createElement(Capture, { query: "av" })));
    await Promise.resolve();
  });
  await act(async () => {
    renderer.update(createElement(ChatProvider, { client }, createElement(Capture, { query: "avery" })));
    await Promise.resolve();
  });
  assert.equal(tasks[0].cancelled, true);
  assert.equal(tasks[1].delayMs, 300);
  await act(async () => {
    tasks[1].task();
    await flush();
  });
  assert.equal(results.at(-1).status, "ready");
  assert.deepEqual(results.at(-1).data.users, [{ kind: "redacted", userId: otherUserId }]);
  assert.equal(results.at(-1).data.nextCursor, cursor);
  assert.doesNotMatch(JSON.stringify(results.at(-1)), /email|roles|permissions|token/);
  await act(async () => renderer.unmount());
  client.close();
});

test("thread, draft, attachment, and huddle hooks keep runtime boundaries declarative", async () => {
  const cache = createSeededCache();
  cache.setAttachmentUploadState({
    uploadId: "upload-1",
    conversationId: channelId,
    metadata: { fileName: "photo.png", contentType: "image/png", sizeBytes: 10 },
    status: "preparing",
    progress: { uploadedBytes: 4, totalBytes: 10 },
  });
  const runtime = createExternalClient(cache, {
    getThreadOpeningState: () => Object.freeze({
      state: "ready",
      rootMessageId,
      parentConversationId: channelId,
      threadConversationId: threadId,
      reconciliationStatus: "existing",
    }),
  });
  const results = [];
  const Capture = () => {
    results.push({
      thread: useThread(rootMessageId),
      draft: useDraft(channelId),
      attachment: useAttachmentUpload("upload-1"),
      huddle: useHuddle(channelId),
    });
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(createElement(ChatProvider, { client: runtime.client }, createElement(Capture)));
  });
  const initial = results.at(-1);
  assert.deepEqual(initial.thread.data.parentMessages.map(({ conversationId }) => conversationId), [channelId]);
  assert.deepEqual(initial.thread.data.threadMessages.map(({ conversationId }) => conversationId), [threadId]);
  assert.equal(initial.draft.data.draft.content.text, "initial");
  assert.deepEqual(initial.attachment.data.progress, { uploadedBytes: 4, totalBytes: 10 });
  assert.equal(initial.huddle.data.canonicalState.status, "inactive");

  await act(async () => {
    runtime.setDraft({
      conversationId: channelId,
      status: "ready",
      authoritativeRevision: 2,
      dirty: false,
      draft: {
        kind: "replaced",
        content: { format: "plain", text: "synchronized", attachments: [] },
      },
    });
  });
  assert.equal(results.at(-1).draft.data.draft.content.text, "synchronized");
  await act(async () => renderer.unmount());
});

test("disabled huddle queries keep a stable fallback until a valid conversation is enabled", async () => {
  const cache = createSeededCache();
  const accesses = [];
  const idleHuddle = Object.freeze({
    conversationId: channelId,
    hydrationStatus: "idle",
    media: Object.freeze({ state: "idle" }),
  });
  const { client } = createExternalClient(cache, {
    getHuddleState(conversationId) {
      accesses.push({ name: "getHuddleState", conversationId });
      if (conversationId.length === 0) throw new TypeError("Huddle conversation id is invalid");
      return idleHuddle;
    },
    subscribeHuddle(conversationId) {
      accesses.push({ name: "subscribeHuddle", conversationId });
      if (conversationId.length === 0) throw new TypeError("Huddle conversation id is invalid");
      return () => accesses.push({ name: "unsubscribeHuddle", conversationId });
    },
    async hydrateHuddle(conversationId) {
      accesses.push({ name: "hydrateHuddle", conversationId });
      if (conversationId.length === 0) throw new TypeError("Huddle conversation id is invalid");
      return { status: "success", operation: "hydrate", applied: false };
    },
  });
  const results = [];
  const Capture = ({ conversationId, enabled }) => {
    results.push(useHuddle(conversationId, { enabled }));
    return null;
  };
  const tree = (conversationId, enabled) => createElement(
    ChatProvider,
    { client },
    createElement(Capture, { conversationId, enabled }),
  );
  let renderer;

  await act(async () => {
    renderer = create(tree("", false));
    await flush();
  });
  const disabledFallback = results.at(-1).data;
  assert.equal(results.at(-1).status, "loading");
  assert.deepEqual(disabledFallback, {
    conversationId: "",
    hydrationStatus: "idle",
    media: { state: "idle" },
  });
  assert.deepEqual(accesses, []);

  await act(async () => {
    renderer.update(tree("", false));
    await flush();
  });
  assert.equal(results.at(-1).data, disabledFallback);
  assert.deepEqual(accesses, []);

  await act(async () => {
    renderer.update(tree(channelId, true));
    await flush();
  });
  assert.ok(accesses.some((entry) =>
    entry.name === "getHuddleState" && entry.conversationId === channelId));
  assert.ok(accesses.some((entry) =>
    entry.name === "subscribeHuddle" && entry.conversationId === channelId));
  assert.ok(accesses.some((entry) =>
    entry.name === "hydrateHuddle" && entry.conversationId === channelId));
  assert.equal(accesses.some((entry) => entry.conversationId === ""), false);

  await act(async () => renderer.unmount());
});

test("provider failures are safe and SSR uses a stable prehydrated snapshot", () => {
  const Missing = () => {
    const result = useMessages(channelId);
    return createElement("span", null, `${result.status}:${result.error?.code}`);
  };
  assert.equal(renderToString(createElement(Missing)), "<span>error:provider_missing</span>");

  const cache = createSeededCache();
  const { client } = createExternalClient(cache);
  const ServerMessages = () => {
    const result = useMessages(channelId);
    return createElement("span", null, `${result.status}:${result.data?.messages.length}`);
  };
  assert.equal(
    renderToString(createElement(ChatProvider, { client }, createElement(ServerMessages))),
    "<span>ready:1</span>",
  );

  const failedClient = {
    ...client,
    state: Object.freeze({
      state: "error",
      diagnostic: Object.freeze({
        code: "metadata_request_failed",
        message: "Chat server metadata could not be requested.",
        httpStatus: 503,
      }),
    }),
  };
  const ProviderFailure = () => {
    const result = useConversation(channelId);
    return createElement("span", null, `${result.status}:${result.error?.code}:${result.error?.httpStatus}`);
  };
  assert.equal(
    renderToString(createElement(ChatProvider, { client: failedClient }, createElement(ProviderFailure))),
    "<span>error:provider_error:503</span>",
  );
});
