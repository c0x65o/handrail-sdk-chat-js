import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { Window } from "happy-dom";

process.env.NODE_ENV = "test";
const window = new Window({ url: "https://default-workspace.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  FocusEvent: window.FocusEvent,
  HTMLElement: window.HTMLElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  window,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, createElement } = React;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CHAT_PROTOCOL_VERSION } = await import("@handrail/chat");
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
} = await import("@handrail/chat/client");
const { ChatProvider } = await import("@handrail/chat/react");
const { ChatWorkspace } = await import("@handrail/chat/ui");

const tenantId = "tenant-default-workspace";
const userId = "user-default-workspace";
const otherUserId = "user-default-workspace-other";
const publicId = "conversation-public";
const privateId = "conversation-private";
const directId = "conversation-direct";
const groupDirectId = "conversation-group-direct";
const threadId = "conversation-thread";
const unavailableConversationId = "conversation-unavailable";
const rootMessageId = "message-public-root";
const forwardSourceMessageId = "message-forward-source";
const forwardedMessageId = "message-forwarded-canonical";
const now = "2038-05-06T07:08:09.000Z";
const existingReminderDue = "2038-05-07T10:30:00.000Z";
const scope = Object.freeze({ type: "organization" });
const enabledFeatures = Object.freeze({ huddles: true });
const metadata = Object.freeze({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures,
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
});
const readyState = Object.freeze({
  state: "ready",
  clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  metadata,
  enabledFeatures,
});
const allowAllHuddles = Object.freeze({
  canStart: true,
  canJoin: true,
  canLeave: true,
  canControlMicrophone: true,
  canShareScreen: true,
  canSelectDevices: true,
  canRetry: true,
  canRejoin: true,
  canEnd: true,
});

const membership = (conversationId) => ({
  tenantId,
  conversationId,
  userId,
  role: "member",
  state: "active",
  joinedAt: now,
  updatedAt: now,
});
const readState = (conversationId, latest = 0) => ({
  conversationId,
  userId,
  lastReadSequence: latest,
  updatedAt: now,
});
const currentPreference = (conversationId) => ({
  conversationId,
  userId,
  notificationPreference: "all",
  isStarred: false,
  mute: { muted: false },
  updatedAt: now,
});
const conversationState = (conversation, latestSequence = 1) => Object.freeze({
  ...conversation,
  tenantId,
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence,
  unreadMentionCount: 0,
  activeMemberUserIds: [userId, otherUserId],
  currentMember: membership(conversation.id),
  currentReadState: readState(conversation.id),
  currentPreference: currentPreference(conversation.id),
});
const publicConversation = conversationState({
  id: publicId,
  type: "channel",
  name: "Public channel",
  visibility: "public",
});
const privateConversation = conversationState({
  id: privateId,
  type: "channel",
  name: "Private channel",
  visibility: "private",
});
const directConversation = conversationState({
  id: directId,
  type: "direct",
  visibility: "private",
});
const groupDirectConversation = conversationState({
  id: groupDirectId,
  type: "group_direct",
  visibility: "private",
});
const threadConversation = conversationState({
  id: threadId,
  type: "thread",
  visibility: "public",
  parentConversationId: publicId,
  rootMessageId,
});
const archivedConversation = conversationState({
  id: "conversation-archived",
  type: "channel",
  name: "Archived channel",
  visibility: "public",
  archivedAt: now,
  archivedByUserId: userId,
});
const conversations = Object.freeze([
  publicConversation,
  privateConversation,
  directConversation,
  threadConversation,
]);
const threadSummary = Object.freeze({
  threadId,
  replyCount: 1,
  participantIds: Object.freeze([otherUserId]),
  unreadCount: 1,
  lastReplyAt: now,
});
const message = (id, conversationId, text, overrides = {}) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: otherUserId },
  sequence: 1,
  createdAt: now,
  updatedAt: now,
  revision: { revision: 1 },
  content: { format: "plain", text },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
  ...overrides,
});
const publicRoot = message(rootMessageId, publicId, "Public root message", {
  isThreadRoot: true,
  threadSummary,
  content: {
    format: "plain",
    text: "Public root message",
    blocks: [
      { type: "system_event", data: { kind: "joined", summary: "Avery joined" } },
      { type: "entity_reference", data: { entity: { type: "invoice", id: "42" }, label: "Invoice 42" } },
    ],
  },
  attachmentMetadata: [{
    attachmentId: "attachment-workspace",
    fileName: "workspace.txt",
    contentType: "text/plain",
    sizeBytes: 9,
    downloadUrl: "/files/workspace.txt",
  }],
});
const threadlessPublicRoot = Object.freeze({
  ...publicRoot,
  isThreadRoot: false,
  threadSummary: undefined,
});
const replyActionMessages = Object.freeze([
  threadlessPublicRoot,
  message("message-deleted", publicId, "Deleted message", {
    sequence: 2,
    content: null,
    deletedAt: now,
    deletedByUserId: otherUserId,
  }),
  message("message-sending", publicId, "Sending message", {
    sequence: 3,
    delivery: { state: "sending", clientMessageId: "client-message-sending" },
  }),
  message("message-failed", publicId, "Failed message", {
    sequence: 4,
    delivery: { state: "failed", clientMessageId: "client-message-failed", retryable: true },
  }),
]);
const forwardActionMessages = Object.freeze([
  message(forwardSourceMessageId, publicId, "A message worth forwarding"),
  message("message-forward-deleted", publicId, "Deleted", {
    sequence: 2,
    content: null,
    deletedAt: now,
    deletedByUserId: otherUserId,
  }),
  message("message-forward-sending", publicId, "Sending", {
    sequence: 3,
    delivery: { state: "sending", clientMessageId: "client-forward-sending" },
  }),
  message("message-forward-failed", publicId, "Failed", {
    sequence: 4,
    delivery: { state: "failed", clientMessageId: "client-forward-failed", retryable: true },
  }),
  message("message-forward-attachment", publicId, "Attachment metadata", {
    sequence: 5,
    attachmentMetadata: [{
      attachmentId: "forward-attachment",
      fileName: "forward.txt",
      contentType: "text/plain",
      sizeBytes: 7,
      downloadUrl: "/files/forward.txt",
    }],
  }),
  message("message-forward-reference", publicId, "Attachment reference", {
    sequence: 6,
    content: {
      format: "plain",
      text: "Attachment reference",
      attachments: [{ attachmentId: "forward-attachment-reference" }],
    },
  }),
  message("message-forward-block", publicId, "Structured block", {
    sequence: 7,
    content: {
      format: "plain",
      text: "Structured block",
      blocks: [{ type: "custom", data: { value: true } }],
    },
  }),
]);
const messages = new Map([
  [publicId, [publicRoot]],
  [privateId, [message("message-private", privateId, "Private message")]],
  [directId, [message("message-direct", directId, "Direct message")]],
  [threadId, [message("message-thread", threadId, "Thread reply")]],
]);

const detail = (conversation) => ({
  kind: "conversation_detail",
  conversation: {
    ...conversation,
    memberUserIds: [userId, otherUserId],
    currentPreference: conversation.currentPreference ??
      currentPreference(conversation.id),
  },
  _meta: metadata,
});
const timeline = (conversationId, rows) => ({
  conversationId,
  messages: rows,
  pagination: {
    older: { available: false },
    newer: { available: false },
  },
  replay: { resumeFrom: { eventId: `event-${conversationId}` } },
});
const directory = new Map([
  [userId, Object.freeze({
    kind: "active",
    userId,
    displayName: "Current User",
    avatar: Object.freeze({ kind: "initials", initials: "CU" }),
  })],
  [otherUserId, Object.freeze({
    kind: "active",
    userId: otherUserId,
    displayName: "Avery Example",
    avatar: Object.freeze({ kind: "initials", initials: "AE" }),
  })],
]);

const createFixture = ({
  conversationDetails = new Map(),
  detailState = "ready",
  directoryUsers = directory,
  empty = false,
  forwardActionStates = false,
  forwardFailure = false,
  forwardNavigationFailure = false,
  forwardPending = false,
  hydrateListedConversationDetails = true,
  listNextCursor,
  listNextPageConversations = [],
  listNextPageCursor,
  listNextPagePending = false,
  listState = "ready",
  listedConversations,
  messageRows = messages,
  noForwardDestinations = false,
  preferenceMutationMode = "success",
  preferenceRevision = 0,
  reminderExisting = false,
  reminderFailure = false,
  reminderPending = false,
  reminderPendingStateDeferred = false,
  replyActionStates = false,
} = {}) => {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: "session-default-workspace",
  });
  const hydratedConversations = listedConversations ?? (
    forwardActionStates
      ? noForwardDestinations
        ? [publicConversation, threadConversation, archivedConversation]
        : [...conversations, archivedConversation]
      : replyActionStates
        ? conversations.filter(({ id }) => id !== threadId)
        : conversations
  );
  if (listState === "ready") {
    cache.hydrateConversationList({
      kind: "conversation_list",
      scope,
      items: empty
        ? []
        : hydratedConversations.map((item) => ({ ...item, hasActiveHuddle: false })),
      page: listNextCursor === undefined ? {} : { nextCursor: listNextCursor },
      _meta: metadata,
    });
  }
  if (listState === "ready" && !empty) {
    for (const item of hydratedConversations) {
      if (!hydrateListedConversationDetails) continue;
      if (item.id !== publicId || ["ready", "unavailable"].includes(detailState)) {
        cache.hydrateConversationDetail(detail(conversationDetails.get(item.id) ?? item));
      }
      cache.hydrateMessageTimeline(timeline(
        item.id,
        forwardActionStates && item.id === publicId
          ? forwardActionMessages
          : replyActionStates && item.id === publicId
            ? replyActionMessages
            : messageRows.get(item.id) ?? [],
      ));
    }
    if (detailState === "unavailable") {
      const canonical = structuredClone(cache.getState());
      canonical.metadata.conversationDetails[unavailableConversationId] = metadata;
      assert.equal(cache.hydrateCanonicalState(canonical), true);
    }
  }
  if (reminderExisting) {
    cache.hydrateMessageReminderList({
      kind: "message_reminder_list",
      privacy: "actor_private",
      items: [{
        conversationId: publicId,
        messageId: rootMessageId,
        reminderRevision: 3,
        reminder: {
          privacy: "affected_authenticated_actor",
          state: "scheduled",
          dueAt: existingReminderDue,
        },
      }],
      page: { nextCursor: null },
    });
  }
  if (preferenceRevision !== 0) {
    for (let revision = 0; revision < preferenceRevision; revision += 1) {
      const preference = cache.getState().currentUser.preferences[publicId];
      const command = {
        operation: "update_conversation_preference",
        conversationId: publicId,
        expectedPreferenceRevision: revision,
        idempotencyKey: `default-workspace-preference-seed-${revision}`,
        notificationPreference: preference.notificationPreference,
        isStarred: preference.isStarred,
        mute: preference.mute,
      };
      cache.beginOptimisticConversationPreference(
        command,
        new Date(Date.parse(now) + ((revision * 2) + 1) * 1_000).toISOString(),
      );
      cache.reconcileCurrentUserConversationPreference(command, {
        operation: command.operation,
        reconciliationStatus: "applied",
        conversationId: publicId,
        expectedPreferenceRevision: revision,
        idempotencyKey: command.idempotencyKey,
        requestedPreference: {
          notificationPreference: command.notificationPreference,
          isStarred: command.isStarred,
          mute: command.mute,
        },
        preferenceRevision: revision + 1,
        preference: {
          notificationPreference: command.notificationPreference,
          isStarred: command.isStarred,
          mute: command.mute,
          updatedAt: new Date(
            Date.parse(now) + ((revision * 2) + 2) * 1_000,
          ).toISOString(),
        },
      });
    }
  }

  const calls = [];
  const reminderInputs = new Map();
  let reminderKey = 0;
  let reminderMode = reminderFailure ? "failure" : reminderPending ? "pending" : "success";
  let conversationPagePending = listNextPagePending;
  let heldConversationPage;
  let heldPreference;
  let heldReminder;
  let heldForward;
  let preferenceKey = 0;
  const drafts = new Map(conversations.map(({ id }) => [id, Object.freeze({
    conversationId: id,
    status: "ready",
    authoritativeRevision: 0,
    dirty: false,
  })]));
  const draftListeners = new Map();
  const openingListeners = new Set();
  const idleOpenings = new Map();
  let opening = Object.freeze(replyActionStates
    ? { state: "idle", rootMessageId }
    : {
        state: "ready",
        rootMessageId,
        parentConversationId: publicId,
        threadConversationId: threadId,
        reconciliationStatus: "existing_for_root",
      });
  const huddleListeners = new Map();
  const huddles = new Map(conversations.map(({ id }) => [id, Object.freeze({
    conversationId: id,
    hydrationStatus: "ready",
    media: Object.freeze({ state: "idle" }),
    canonicalState: Object.freeze({ status: "inactive", conversationId: id }),
  })]));
  const notifyDraft = (conversationId, next) => {
    const previous = drafts.get(conversationId);
    drafts.set(conversationId, Object.freeze(next));
    for (const listener of draftListeners.get(conversationId) ?? []) listener(next, previous);
    return drafts.get(conversationId);
  };
  const success = (name) => Promise.resolve({ status: "success", value: { operation: name } });
  const reminderResult = (command, overrides = {}) => ({
    operation: command.operation,
    intent: command.intent,
    reconciliationStatus: "applied",
    conversationId: command.conversationId,
    messageId: command.messageId,
    expectedReminderRevision: command.expectedReminderRevision,
    idempotencyKey: command.idempotencyKey,
    reminderRevision: command.expectedReminderRevision + 1,
    reminder: command.intent === "set"
      ? { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: command.dueAt }
      : { privacy: "affected_authenticated_actor", state: "cancelled" },
    ...overrides,
  });
  const settleReminder = (command, overrides) => {
    const value = reminderResult(command, overrides);
    cache.reconcileCurrentUserMessageReminder(command, value);
    return { status: "success", value };
  };
  const beginReminder = (intent, authored) => {
    const command = {
      operation: "message_reminder.v1",
      intent,
      conversationId: authored.conversationId,
      messageId: authored.messageId,
      expectedReminderRevision:
        cache.getState().currentUser.messageReminderRevisions[authored.messageId] ?? 0,
      idempotencyKey: `default-workspace-reminder-${++reminderKey}`,
      ...(intent === "set" ? { dueAt: authored.dueAt } : {}),
    };
    calls.push({ name: "messageReminderCommand", args: [command] });
    reminderInputs.set(command.messageId, command);
    if (reminderMode === "pending" && reminderPendingStateDeferred) {
      reminderMode = "success";
      return new Promise((resolve) => {
        heldReminder = { beginOptimistic: true, command, resolve };
      });
    }
    cache.beginOptimisticMessageReminder(command);
    if (reminderMode === "failure") {
      reminderMode = "success";
      cache.failOptimisticMessageReminder(command.messageId, command.idempotencyKey, "transport");
      return Promise.resolve({ status: "transport", message: "The chat command could not be completed." });
    }
    if (reminderMode === "pending") {
      reminderMode = "success";
      return new Promise((resolve) => {
        heldReminder = { command, resolve };
      });
    }
    return Promise.resolve(settleReminder(command));
  };
  const settleConversationPage = (input) => {
    cache.hydrateConversationList({
      kind: "conversation_list",
      scope,
      items: listNextPageConversations.map((item) => ({
        ...item,
        hasActiveHuddle: false,
      })),
      page: listNextPageCursor === undefined ? {} : { nextCursor: listNextPageCursor },
      _meta: metadata,
    }, { requestCursor: input.cursor });
    return { status: "success" };
  };
  const desiredPreference = (command) => ({
    notificationPreference: command.notificationPreference,
    isStarred: command.isStarred,
    mute: command.mute,
  });
  const settlePreference = (command, {
    preference = desiredPreference(command),
    reconciliationStatus = "applied",
  } = {}) => {
    const value = {
      operation: command.operation,
      reconciliationStatus,
      conversationId: command.conversationId,
      expectedPreferenceRevision: command.expectedPreferenceRevision,
      idempotencyKey: command.idempotencyKey,
      requestedPreference: desiredPreference(command),
      preferenceRevision: reconciliationStatus === "preference_revision_conflict"
        ? command.expectedPreferenceRevision + 2
        : command.expectedPreferenceRevision + 1,
      preference: {
        ...preference,
        updatedAt: new Date(Date.parse(now) + 2_000).toISOString(),
      },
    };
    cache.reconcileCurrentUserConversationPreference(command, value);
    return { status: "success", value };
  };
  const client = {
    endpoint: "/chat",
    state: readyState,
    cache,
    start: async () => readyState,
    close() {},
    subscribeLifecycle: () => () => undefined,
    listConversations: (input = {}) => {
      if (input.cursor !== undefined && listNextCursor !== undefined) {
        calls.push({ name: "listConversations", args: [input] });
        if (conversationPagePending) {
          conversationPagePending = false;
          return new Promise((resolve) => {
            heldConversationPage = { input, resolve };
          });
        }
        return Promise.resolve(settleConversationPage(input));
      }
      return listState === "loading"
        ? new Promise(() => undefined)
        : Promise.resolve(listState === "error"
          ? { status: "transport", message: "The conversation list could not be loaded." }
          : { status: "success" });
    },
    getConversation: ({ conversationId }) =>
      conversationId === publicId && detailState === "loading"
        ? new Promise(() => undefined)
        : Promise.resolve(conversationId === publicId && detailState === "error"
          ? { status: "transport", message: "The conversation detail could not be loaded." }
          : { status: "success" }),
    getMessageTimeline: async () => ({ status: "success" }),
    selectDirectoryUser: (selectedUserId) => directoryUsers.get(selectedUserId),
    hydrateDirectoryUsers: async () => ({ status: "success", value: { users: [] } }),
    cancelDirectorySearch() {},
    getThreadOpeningState(selectedRootId) {
      if (selectedRootId === rootMessageId) return opening;
      let idle = idleOpenings.get(selectedRootId);
      if (idle === undefined) {
        idle = Object.freeze({ state: "idle", rootMessageId: selectedRootId });
        idleOpenings.set(selectedRootId, idle);
      }
      return idle;
    },
    subscribeThreadOpening(_selectedRootId, listener) {
      openingListeners.add(listener);
      return () => openingListeners.delete(listener);
    },
    openThread(selectedRootId) {
      calls.push({ name: "openThread", args: [selectedRootId] });
      const previous = opening;
      if (replyActionStates && selectedRootId === rootMessageId) {
        const createdSummary = {
          threadId,
          replyCount: 0,
          participantIds: [],
          unreadCount: 0,
        };
        cache.reconcileThreadOpening(
          {
            operation: "create_thread",
            parentConversationId: publicId,
            rootMessageId,
            idempotencyKey: "reply-action-thread",
          },
          {
            operation: "create_thread",
            reconciliationStatus: "created",
            parentConversationId: publicId,
            rootMessageId,
            conversation: detail({ ...threadConversation, latestSequence: 0 }),
            rootThreadSummary: createdSummary,
          },
          timeline(threadId, []),
        );
        opening = Object.freeze({
          state: "ready",
          rootMessageId,
          parentConversationId: publicId,
          threadConversationId: threadId,
          reconciliationStatus: "created",
        });
      }
      for (const listener of openingListeners) listener(opening, previous);
      return Promise.resolve(opening);
    },
    selectConversationDraft: (conversationId) => drafts.get(conversationId) ?? Object.freeze({
      conversationId,
      status: "ready",
      authoritativeRevision: 0,
      dirty: false,
    }),
    subscribeConversationDraft(conversationId, listener) {
      const listeners = draftListeners.get(conversationId) ?? new Set();
      listeners.add(listener);
      draftListeners.set(conversationId, listeners);
      return () => listeners.delete(listener);
    },
    openConversationDraft: async (conversationId) => drafts.get(conversationId),
    replaceConversationDraft(input) {
      calls.push({ name: "replaceConversationDraft", args: [input] });
      return notifyDraft(input.conversationId, {
        ...drafts.get(input.conversationId),
        status: "debouncing",
        dirty: true,
        draft: Object.freeze({ kind: "replaced", content: input.content }),
      });
    },
    clearConversationDraft(conversationId) {
      calls.push({ name: "clearConversationDraft", args: [conversationId] });
      return notifyDraft(conversationId, {
        ...drafts.get(conversationId),
        status: "debouncing",
        dirty: true,
        draft: Object.freeze({ kind: "clear_tombstone", content: null }),
      });
    },
    flushConversationDraft: async () => ({ status: "success" }),
    retryConversationDraft: async () => ({ status: "success" }),
    closeConversationDraft: async () => ({ status: "success" }),
    startTyping(conversationId) {
      calls.push({ name: "startTyping", args: [conversationId] });
      return true;
    },
    stopTyping(conversationId) {
      calls.push({ name: "stopTyping", args: [conversationId] });
    },
    sendMessage(input) {
      calls.push({ name: "sendMessage", args: [input] });
      return success("send_message");
    },
    forwardMessage(input) {
      calls.push({ name: "forwardMessage", args: [input] });
      if (forwardFailure) {
        return Promise.resolve({
          status: "transport",
          message: "The chat command could not be completed.",
        });
      }
      const canonical = message(
        forwardedMessageId,
        input.destinationConversationId,
        "A message worth forwarding",
        {
          author: { type: "user", userId },
          sequence: 2,
          content: {
            format: "plain",
            text: "A message worth forwarding",
            forwarded: {
              sourceMessageId: input.sourceMessageId,
              originalAuthor: { userId: otherUserId, displayName: "Avery Example" },
              originalCreatedAt: now,
            },
          },
        },
      );
      const settleForward = () => {
        if (!forwardNavigationFailure) {
          cache.hydrateMessageTimeline(timeline(input.destinationConversationId, [
            ...(messages.get(input.destinationConversationId) ?? []),
            canonical,
          ]));
        }
        return {
          status: "success",
          value: {
            operation: "forward_message.v1",
            reconciliationStatus: "applied",
            clientCorrelationId: "forward-correlation",
            destinationConversationId: input.destinationConversationId,
            message: canonical,
            canonicalRevision: 1,
          },
        };
      };
      if (forwardPending) {
        return new Promise((resolve) => {
          heldForward = () => resolve(settleForward());
        });
      }
      return Promise.resolve(settleForward());
    },
    retryMessage: () => success("retry_message"),
    setReaction(input) {
      calls.push({ name: "setReaction", args: [input] });
      return success("set_reaction");
    },
    setMessageReminder(input) {
      return beginReminder("set", input);
    },
    cancelMessageReminder(input) {
      return beginReminder("cancel", input);
    },
    retryMessageReminder(selectedMessageId) {
      const command = reminderInputs.get(selectedMessageId);
      const pending = cache.getState().currentUser.pendingMessageReminderUpdates[selectedMessageId];
      if (command === undefined || pending?.state !== "failed") {
        return Promise.resolve({ status: "validation", message: "The chat command was invalid." });
      }
      calls.push({ name: "messageReminderRetry", args: [command] });
      cache.retryOptimisticMessageReminder(selectedMessageId, command.idempotencyKey);
      return Promise.resolve(settleReminder(command));
    },
    getHuddleState(conversationId) {
      const existing = huddles.get(conversationId);
      if (existing !== undefined) return existing;
      const idle = Object.freeze({
        conversationId,
        hydrationStatus: "idle",
        media: Object.freeze({ state: "idle" }),
      });
      huddles.set(conversationId, idle);
      return idle;
    },
    subscribeHuddle(conversationId, listener) {
      const listeners = huddleListeners.get(conversationId) ?? new Set();
      listeners.add(listener);
      huddleListeners.set(conversationId, listeners);
      return () => listeners.delete(listener);
    },
    hydrateHuddle: () => success("hydrate_huddle"),
    getHuddleMediaJoinDescriptor: () => undefined,
    startHuddle(conversationId) {
      calls.push({ name: "startHuddle", args: [conversationId] });
      return success("start_huddle");
    },
    joinHuddle: () => success("join_huddle"),
    leaveHuddle: () => success("leave_huddle"),
    setHuddleScreenShare: () => success("set_huddle_screen_share"),
    clearHuddleScreenShare: () => success("clear_huddle_screen_share"),
    endHuddle: () => success("end_huddle"),
    retryHuddle: () => success("retry_huddle"),
    rejoinHuddle: () => success("rejoin_huddle"),
    updateConversationPreference(authored) {
      const command = {
        operation: "update_conversation_preference",
        conversationId: authored.conversationId,
        expectedPreferenceRevision:
          cache.getState().currentUser.preferenceRevisions[authored.conversationId] ?? 0,
        idempotencyKey: `default-workspace-preference-${++preferenceKey}`,
        notificationPreference: authored.notificationPreference,
        isStarred: authored.isStarred,
        mute: authored.mute,
      };
      calls.push({ name: "updateConversationPreference", args: [command] });
      cache.beginOptimisticConversationPreference(
        command,
        new Date(Date.parse(now) + 1_000).toISOString(),
      );
      if (preferenceMutationMode === "transport") {
        cache.rollbackOptimisticConversationPreference(
          command.conversationId,
          command.idempotencyKey,
        );
        return Promise.resolve({
          status: "transport",
          message: "The chat command could not be completed.",
        });
      }
      if (preferenceMutationMode === "conflict-once" && preferenceKey === 1) {
        return Promise.resolve(settlePreference(command, {
          reconciliationStatus: "preference_revision_conflict",
          preference: {
            notificationPreference: "mentions",
            isStarred: false,
            mute: { muted: true },
          },
        }));
      }
      if (preferenceMutationMode === "pending") {
        return new Promise((resolve) => {
          heldPreference = { command, resolve };
        });
      }
      return Promise.resolve(settlePreference(command));
    },
    followThread: () => success("follow_thread"),
    unfollowThread: () => success("unfollow_thread"),
    markRead(input) {
      calls.push({ name: "markRead", args: [input] });
      const state = cache.getState();
      const current = state.currentUser.readStates[input.conversationId];
      const latestSequence = state.metadata.conversations[input.conversationId]?.latestSequence;
      assert.notEqual(current, undefined);
      assert.notEqual(latestSequence, undefined);
      const throughSequence = Math.max(current.lastReadSequence, input.throughSequence);
      cache.reconcileCurrentUserReadState({
        operation: "mark_read",
        conversationId: input.conversationId,
        readState: {
          conversationId: input.conversationId,
          userId: current.userId,
          lastReadSequence: throughSequence,
          updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
        },
        latestSequence,
        unreadCount: Math.max(0, latestSequence - throughSequence),
      });
      return success("mark_read");
    },
  };
  return {
    cache,
    calls,
    client,
    publishHuddle(conversationId, next) {
      const previous = huddles.get(conversationId);
      huddles.set(conversationId, Object.freeze(next));
      for (const listener of huddleListeners.get(conversationId) ?? []) {
        listener(huddles.get(conversationId), previous);
      }
    },
    pushReminderCanonical(revision, dueAt) {
      cache.hydrateMessageReminderList({
        kind: "message_reminder_list",
        privacy: "actor_private",
        items: [{
          conversationId: publicId,
          messageId: rootMessageId,
          reminderRevision: revision,
          reminder: { privacy: "affected_authenticated_actor", state: "scheduled", dueAt },
        }],
        page: { nextCursor: null },
      });
    },
    releaseReminder(overrides) {
      if (heldReminder === undefined) throw new Error("No reminder command is pending");
      const pending = heldReminder;
      heldReminder = undefined;
      if (pending.beginOptimistic) cache.beginOptimisticMessageReminder(pending.command);
      pending.resolve(settleReminder(pending.command, overrides));
    },
    releaseForward() {
      if (heldForward === undefined) throw new Error("No forward command is pending");
      const release = heldForward;
      heldForward = undefined;
      release();
    },
    releaseConversationPage() {
      if (heldConversationPage === undefined) {
        throw new Error("No conversation page request is pending");
      }
      const pending = heldConversationPage;
      heldConversationPage = undefined;
      pending.resolve(settleConversationPage(pending.input));
    },
    releasePreference(overrides) {
      if (heldPreference === undefined) {
        throw new Error("No conversation preference command is pending");
      }
      const pending = heldPreference;
      heldPreference = undefined;
      pending.resolve(settlePreference(pending.command, overrides));
    },
  };
};

const typingSignal = ({
  actorUserId = otherUserId,
  conversationId = publicId,
  eventId,
  expiresAt = "2038-05-06T07:10:00.000Z",
  sentAt = now,
  sessionId = "typing-session",
  state = "start",
}) => ({
  eventId,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  tenantId,
  streamId: conversationId,
  type: "typing.signal",
  occurredAt: sentAt,
  payload: {
    capability: "typing",
    durability: "ephemeral",
    actorUserId,
    deviceId: `typing-device-${sessionId}`,
    sessionId,
    sequence: 1,
    sentAt,
    expiresAt,
    state,
    scope: {
      type: "conversation",
      conversationId,
      visibility: conversationId === publicId || conversationId === threadId
        ? "public"
        : "private",
      audience: "active_participants",
    },
  },
});

const applyTypingSignal = (fixture, input) => {
  const signal = typingSignal(input);
  fixture.cache.applyEphemeralSignal(signal, Date.parse(signal.payload.sentAt));
};

const workspace = (fixture, props = {}) => createElement(
  ChatProvider,
  { client: fixture.client },
  createElement(ChatWorkspace, {
    scope,
    conversationId: publicId,
    currentUserId: userId,
    huddlePermissions: allowAllHuddles,
    ...props,
  }),
);
const renderGroupDirectHeader = ({ directoryUsers, memberUserIds }) => {
  const fixture = createFixture({ directoryUsers });
  const snapshot = detail(groupDirectConversation);
  fixture.cache.hydrateConversationDetail({
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      memberUserIds,
    },
  });
  const markup = renderToStaticMarkup(workspace(fixture, {
    conversationId: groupDirectId,
    renderComposer: () => null,
    renderTimeline: () => null,
  }));
  const rendered = document.createElement("div");
  rendered.innerHTML = markup;
  return rendered.querySelector(".handrail-chat__header");
};
const renderEmptyConversation = ({
  components,
  conversation,
  directoryUsers = directory,
  memberUserIds = [userId, otherUserId],
}) => {
  const messageRows = new Map(messages);
  messageRows.set(conversation.id, []);
  const fixture = createFixture({
    conversationDetails: new Map([[conversation.id, conversation]]),
    directoryUsers,
    messageRows,
  });
  const snapshot = detail(conversation);
  fixture.cache.hydrateConversationDetail({
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      memberUserIds,
    },
  });
  fixture.cache.hydrateMessageTimeline(timeline(conversation.id, []));
  const markup = renderToStaticMarkup(workspace(fixture, {
    ...(components === undefined ? {} : { components }),
    conversationId: conversation.id,
    renderComposer: () => null,
  }));
  const rendered = document.createElement("div");
  rendered.innerHTML = markup;
  return rendered;
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
const mounted = [];
const mount = async (element) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(element);
    await flush();
  });
  return container;
};
const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flush();
  });
};
const pointerActivate = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flush();
  });
};
const keyboardActivate = async (element, key) => {
  await act(async () => {
    const keyDownEvent = new window.KeyboardEvent("keydown", { bubbles: true, key });
    element.dispatchEvent(keyDownEvent);
    assert.equal(keyDownEvent.defaultPrevented, false);
    element.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true, key }));
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flush();
  });
};
const keyDown = async (element, key, init = {}) => {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key, ...init }));
    await flush();
  });
};
const input = async (element, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
      .set.call(element, value);
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }));
    await flush();
  });
};
const dateTimeInput = async (element, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(element, value);
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }));
    await flush();
  });
};

const originalIntersectionObserverDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "IntersectionObserver",
);
const installIntersectionObserver = () => {
  const instances = [];
  class FixtureIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = [];
      this.disconnectCalls = 0;
      instances.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }

    disconnect() {
      this.disconnectCalls += 1;
    }

    intersect(target = this.targets[0]) {
      this.callback([{ isIntersecting: true, target }], this);
    }
  }
  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: FixtureIntersectionObserver,
    writable: true,
  });
  return instances;
};

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  document.body.replaceChildren();
  if (originalIntersectionObserverDescriptor === undefined) {
    delete window.IntersectionObserver;
  } else {
    Object.defineProperty(
      window,
      "IntersectionObserver",
      originalIntersectionObserverDescriptor,
    );
  }
});

test("automatic selection refreshes cached history once and cancels on selection or actor replacement", async () => {
  const fixture = createFixture();
  const requests = [];
  fixture.client.getMessageTimeline = async (input, options) => {
    requests.push({ input, signal: options.signal });
    return { status: "success" };
  };
  // No controlled/default selection: the workspace resolves its first channel.
  await mount(workspace(fixture, { conversationId: undefined }));
  assert.equal(requests.length, 1);
  const selected = requests[0].input.conversationId;
  assert.ok(fixture.cache.getState().timelines[selected]);
  assert.deepEqual(requests[0].input, {
    conversationId: selected, direction: "backward", limit: 50,
  });
  await act(async () => {
    fixture.cache.hydrateMessageTimeline(timeline(selected, messages.get(selected)));
    await flush();
  });
  assert.equal(requests.length, 1, "cache updates must not cause a refresh loop");
  assert.equal(requests[0].signal.aborted, false);

  const next = selected === publicId ? privateId : publicId;
  await act(async () => {
    mounted.at(-1).root.render(workspace(fixture, { conversationId: next }));
    await flush();
  });
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.conversationId, next);

  const replacement = createFixture();
  replacement.client.getMessageTimeline = fixture.client.getMessageTimeline;
  await act(async () => {
    mounted.at(-1).root.render(React.cloneElement(
      workspace(replacement, { conversationId: next }), { key: "replacement-actor" },
    ));
    await flush();
  });
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(requests.length, 3, "a recreated actor must refresh even for the same channel");
  assert.equal(requests[2].input.conversationId, next);
});

test("the default workspace composes complete public, private, direct, and thread surfaces", () => {
  const fixture = createFixture();
  for (const [conversationId, expected] of [
    [publicId, "Public root message"],
    [privateId, "Private message"],
    [directId, "Direct message"],
    [threadId, "Thread reply"],
  ]) {
    const markup = renderToStaticMarkup(workspace(fixture, { conversationId }));
    assert.match(markup, new RegExp(expected));
    assert.match(markup, /aria-label="Message timeline"/);
    assert.doesNotMatch(markup, /class="handrail-chat__timeline-reaction"/);
    assert.match(markup, /aria-label="Add reaction"/);
    assert.match(markup, /aria-label="Conversation composer"/);
    assert.match(markup, /aria-label="Start huddle"/);
    assert.match(markup, /<textarea/);
  }
});

test("a projected mark-read update clears the selected conversation sidebar badge", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture, { conversationId: publicId }));
  const row = container.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  );

  assert.equal(row.querySelector(".handrail-chat__conversation-unread-badge").textContent, "1");
  assert.match(row.getAttribute("aria-label"), /1 unread message/);

  await act(async () => {
    await fixture.client.markRead({ conversationId: publicId, throughSequence: 1 });
    await flush();
  });

  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "markRead"),
    [{ name: "markRead", args: [{ conversationId: publicId, throughSequence: 1 }] }],
  );
  assert.equal(row.querySelector(".handrail-chat__conversation-unread-badge"), null);
  assert.equal(row.classList.contains("handrail-chat__conversation-button--unread"), false);
  assert.doesNotMatch(row.getAttribute("aria-label"), /unread message/);
});

test("the conversation header uses a three-dot menu with Star as its only option", async () => {
  const fixture = createFixture({ preferenceRevision: 4 });
  const container = await mount(workspace(fixture, { conversationId: publicId }));
  const header = container.querySelector(".handrail-chat__header");
  const trigger = header.querySelector(
    '.handrail-chat__conversation-header-menu-trigger[aria-haspopup="menu"]',
  );

  assert.ok(trigger);
  assert.equal(trigger.getAttribute("aria-label"), "More actions for #Public channel");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(header.querySelector(".handrail-chat__conversation-star"), null);

  await click(trigger);

  let menu = header.querySelector('.handrail-chat__conversation-header-menu[role="menu"]');
  assert.ok(menu);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  let items = [...menu.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 1);
  assert.equal(items[0].textContent, "Star conversation");
  assert.equal(document.activeElement, items[0]);

  await click(items[0]);

  const commands = fixture.calls.filter(
    ({ name }) => name === "updateConversationPreference",
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args[0], {
    operation: "update_conversation_preference",
    conversationId: publicId,
    expectedPreferenceRevision: 4,
    idempotencyKey: "default-workspace-preference-1",
    notificationPreference: "all",
    isStarred: true,
    mute: { muted: false },
  });
  assert.equal(header.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  menu = header.querySelector('.handrail-chat__conversation-header-menu[role="menu"]');
  items = [...menu.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 1);
  assert.equal(items[0].textContent, "Unstar conversation");

  await keyDown(items[0], "Escape");
  assert.equal(header.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, trigger);
});

test("conversation stars project immediately, block duplicates, and settle canonical success", async () => {
  const conversationChanges = [];
  const fixture = createFixture({
    preferenceMutationMode: "pending",
    preferenceRevision: 4,
  });
  const container = await mount(workspace(fixture, {
    conversationId: publicId,
    onConversationChange: (conversationId) => conversationChanges.push(conversationId),
  }));
  const row = container.querySelector(
    `[data-conversation-section="public-channels"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item");
  const star = row.querySelector(".handrail-chat__conversation-star");
  assert.equal(row.querySelector(".handrail-chat__notification-preferences-trigger"), null);

  assert.equal(star.getAttribute("aria-label"), "Star Public channel");
  assert.equal(star.getAttribute("aria-pressed"), "false");
  await pointerActivate(star);

  const commands = fixture.calls.filter(
    ({ name }) => name === "updateConversationPreference",
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args[0], {
    operation: "update_conversation_preference",
    conversationId: publicId,
    expectedPreferenceRevision: 4,
    idempotencyKey: "default-workspace-preference-1",
    notificationPreference: "all",
    isStarred: true,
    mute: { muted: false },
  });
  const optimisticStarredSection = container.querySelector(
    '[data-conversation-section="starred"]',
  );
  assert.ok(optimisticStarredSection);
  assert.equal(container.querySelectorAll(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).length, 1);
  assert.equal(container.querySelector(
    `[data-conversation-section="public-channels"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ), null);
  const optimisticStar = optimisticStarredSection.querySelector(
    ".handrail-chat__conversation-star",
  );
  assert.equal(optimisticStar.getAttribute("aria-label"), "Unstar Public channel");
  assert.equal(optimisticStar.getAttribute("aria-pressed"), "true");
  assert.equal(optimisticStar.disabled, true);
  assert.equal(optimisticStar.closest("li").querySelector(
    ".handrail-chat__conversation-button",
  ).getAttribute("aria-current"), "page");
  assert.deepEqual(conversationChanges, []);

  await pointerActivate(optimisticStar);
  assert.equal(fixture.calls.filter(
    ({ name }) => name === "updateConversationPreference",
  ).length, 1);

  await act(async () => {
    fixture.releasePreference();
    await flush();
  });

  const settledStar = optimisticStarredSection.querySelector(
    ".handrail-chat__conversation-star",
  );
  assert.equal(settledStar.getAttribute("aria-pressed"), "true");
  assert.equal(settledStar.disabled, false);
  assert.equal(settledStar.closest("li").querySelector('[role="alert"]'), null);
  assert.equal(
    fixture.cache.getState().currentUser.preferences[publicId].notificationPreference,
    "all",
  );
  assert.deepEqual(
    fixture.cache.getState().currentUser.preferences[publicId].mute,
    { muted: false },
  );

  await pointerActivate(settledStar);
  assert.equal(container.querySelector('[data-conversation-section="starred"]'), null);
  const remainingStars = [...container.querySelectorAll(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  )].map((button) => button.closest("li").querySelector(
    ".handrail-chat__conversation-star",
  ));
  assert.equal(remainingStars.length, 1);
  assert.equal(remainingStars[0].getAttribute("aria-pressed"), "false");
  assert.equal(remainingStars[0].disabled, true);

  await act(async () => {
    fixture.releasePreference();
    await flush();
  });
  assert.equal(container.querySelector('[data-conversation-section="starred"]'), null);
  assert.equal(remainingStars[0].disabled, false);
});

test("conversation star failures roll back and revision conflicts retry canonical state", async () => {
  const failedFixture = createFixture({ preferenceMutationMode: "transport" });
  const failedContainer = await mount(workspace(failedFixture));
  const failedRow = failedContainer.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item");
  const failedStar = failedRow.querySelector(".handrail-chat__conversation-star");

  await pointerActivate(failedStar);

  assert.equal(failedStar.getAttribute("aria-pressed"), "false");
  assert.equal(failedStar.disabled, false);
  assert.match(
    failedRow.querySelector('[role="alert"]').textContent,
    /Could not star Public channel\. Check your connection, then retry\./,
  );

  const conflictFixture = createFixture({
    preferenceMutationMode: "conflict-once",
    preferenceRevision: 4,
  });
  const conflictContainer = await mount(workspace(conflictFixture));
  const conflictRow = conflictContainer.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item");
  const conflictStar = conflictRow.querySelector(".handrail-chat__conversation-star");
  const conflictSelection = conflictRow.querySelector(".handrail-chat__conversation-button");

  await pointerActivate(conflictStar);
  await act(async () => {
    await flush();
  });
  const conflictCommands = conflictFixture.calls
    .filter(({ name }) => name === "updateConversationPreference")
    .map(({ args }) => args[0]);
  assert.equal(conflictCommands.length, 2);
  assert.equal(
    conflictFixture.cache.getState().currentUser.preferences[publicId].isStarred,
    true,
  );
  const settledConflictRow = conflictContainer.querySelector(
    `[data-conversation-section="starred"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item");
  const settledConflictStar = settledConflictRow.querySelector(
    ".handrail-chat__conversation-star",
  );
  const settledConflictSelection = settledConflictRow.querySelector(
    ".handrail-chat__conversation-button",
  );
  assert.equal(settledConflictStar.getAttribute("aria-label"), "Unstar Public channel");
  assert.equal(settledConflictStar.getAttribute("aria-pressed"), "true");
  assert.equal(settledConflictSelection.dataset.notificationLevel, "mentions");
  assert.equal(settledConflictSelection.dataset.muteState, "indefinite");
  assert.equal(settledConflictRow.querySelector('[role="alert"]'), null);
  assert.equal(conflictCommands[0].expectedPreferenceRevision, 4);
  assert.equal(conflictCommands[1].expectedPreferenceRevision, 6);
  assert.deepEqual({
    notificationPreference: conflictCommands[1].notificationPreference,
    isStarred: conflictCommands[1].isStarred,
    mute: conflictCommands[1].mute,
  }, {
    notificationPreference: "mentions",
    isStarred: true,
    mute: { muted: true },
  });
});

test("star pointer and keyboard activation stay isolated from row selection and popups", async () => {
  const starredPublicConversation = Object.freeze({
    ...publicConversation,
    currentPreference: Object.freeze({
      ...publicConversation.currentPreference,
      isStarred: true,
    }),
  });
  const conversationChanges = [];
  const fixture = createFixture({ listedConversations: [starredPublicConversation] });
  const container = await mount(workspace(fixture, {
    conversationId: publicId,
    onConversationChange: (conversationId) => conversationChanges.push(conversationId),
  }));
  const row = container.querySelector(
    `[data-conversation-section="starred"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item");
  let star = row.querySelector(".handrail-chat__conversation-star");
  assert.equal(row.querySelector(".handrail-chat__notification-preferences-trigger"), null);

  assert.equal(star.getAttribute("aria-label"), "Unstar Public channel");
  await pointerActivate(star);
  star = container.querySelector(
    `[data-conversation-section="public-channels"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item")
    .querySelector(".handrail-chat__conversation-star");
  await keyboardActivate(star, "Enter");
  star = container.querySelector(
    `[data-conversation-section="starred"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item")
    .querySelector(".handrail-chat__conversation-star");
  await keyboardActivate(star, " ");
  star = container.querySelector(
    `[data-conversation-section="public-channels"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item")
    .querySelector(".handrail-chat__conversation-star");

  assert.deepEqual(
    fixture.calls
      .filter(({ name }) => name === "updateConversationPreference")
      .map(({ args }) => args[0].isStarred),
    [false, true, false],
  );
  assert.equal(star.getAttribute("aria-pressed"), "false");
  assert.deepEqual(conversationChanges, []);
  assert.equal(container.querySelector('[role="dialog"]'), null);
});

test("read-only conversation rows disable the star action", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture, { readOnly: true }));
  const star = container.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  ).closest(".handrail-chat__conversation-item")
    .querySelector(".handrail-chat__conversation-star");

  assert.equal(star.disabled, true);
  await pointerActivate(star);
  assert.equal(fixture.calls.some(
    ({ name }) => name === "updateConversationPreference",
  ), false);
});

test("the navigation sentinel loads one page, deduplicates pending intersections, and stops at cursor exhaustion", async () => {
  const observers = installIntersectionObserver();
  const starredPrivateConversation = Object.freeze({
    ...privateConversation,
    currentPreference: Object.freeze({
      ...privateConversation.currentPreference,
      isStarred: true,
    }),
  });
  const fixture = createFixture({
    listNextCursor: "conversation-page-2",
    listNextPageConversations: [starredPrivateConversation],
    listNextPagePending: true,
    listedConversations: [publicConversation],
  });
  const container = await mount(workspace(fixture, { conversationId: publicId }));
  const navigation = container.querySelector('nav[aria-label="Conversations"]');
  const sentinel = navigation.querySelector(".handrail-chat__conversation-load-more");
  const selected = navigation.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${publicId}"]`,
  );

  assert.equal(observers.length, 1);
  assert.equal(observers[0].options.root, navigation);
  assert.equal(observers[0].options.rootMargin, "0px 0px 160px 0px");
  assert.deepEqual(observers[0].targets, [sentinel]);
  assert.equal(selected.getAttribute("aria-current"), "page");

  await act(async () => {
    observers[0].intersect();
    observers[0].intersect();
    await flush();
  });

  assert.equal(
    fixture.calls.filter(({ name }) => name === "listConversations").length,
    1,
  );
  assert.equal(
    navigation.querySelector(".handrail-chat__conversation-load-more-button").disabled,
    true,
  );

  await act(async () => {
    fixture.releaseConversationPage();
    await flush();
  });

  assert.notEqual(navigation.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${privateId}"]`,
  ), null);
  assert.equal(navigation.querySelectorAll(
    `.handrail-chat__conversation-button[data-conversation-id="${privateId}"]`,
  ).length, 1);
  assert.equal(
    navigation.querySelector("[data-conversation-section]").dataset.conversationSection,
    "starred",
  );
  const appendedPrivateRows = [...navigation.querySelectorAll(
    `.handrail-chat__conversation-button[data-conversation-id="${privateId}"]`,
  )];
  assert.equal(new Set(appendedPrivateRows.map(({ id }) => id)).size, 1);
  assert.deepEqual(appendedPrivateRows.map((row) => row.dataset.navigationRowId), [
    `starred:${privateId}`,
  ]);
  assert.equal(selected.getAttribute("aria-current"), "page");
  assert.equal(navigation.querySelector(".handrail-chat__conversation-load-more"), null);
  assert.equal(observers[0].disconnectCalls, 1);

  await act(async () => {
    observers[0].intersect();
    await flush();
  });
  assert.equal(
    fixture.calls.filter(({ name }) => name === "listConversations").length,
    1,
  );
});

test("5,000 conversations keep navigation mounts bounded while scrolling and revealing keyboard targets", async () => {
  const observers = installIntersectionObserver();
  const largeConversations = Object.freeze(Array.from({ length: 5_000 }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    const conversation = conversationState({
      id: `conversation-large-${suffix}`,
      type: "channel",
      name: `Large channel ${suffix}`,
      visibility: index < 2_500 ? "public" : "private",
    });
    return index === 0
      ? Object.freeze({
          ...conversation,
          currentPreference: Object.freeze({
            ...conversation.currentPreference,
            isStarred: true,
          }),
        })
      : conversation;
  }));
  const pagedConversation = conversationState({
    id: "conversation-large-5000",
    type: "channel",
    name: "Large channel 5000",
    visibility: "private",
  });
  const fixture = createFixture({
    hydrateListedConversationDetails: false,
    listNextCursor: "large-page-2",
    listNextPageConversations: [pagedConversation],
    listNextPagePending: true,
    listedConversations: largeConversations,
  });
  const container = await mount(workspace(fixture, {
    conversationId: undefined,
    defaultConversationId: largeConversations[0].id,
    renderComposer: () => null,
    renderTimeline: () => null,
  }));
  const navigation = container.querySelector('nav[aria-label="Conversations"]');
  Object.defineProperty(navigation, "clientHeight", {
    configurable: true,
    value: 320,
  });
  const mountedRows = () => [...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-navigation-row-id]",
  )];
  const logicalIdentities = [
    `starred:${largeConversations[0].id}`,
    ...largeConversations.slice(1, 2_500).map(({ id }) => `public-channels:${id}`),
    ...largeConversations.slice(2_500).map(({ id }) => `private-channels:${id}`),
  ];

  assert.deepEqual(
    [...navigation.querySelectorAll("[data-conversation-section]")]
      .map((section) => section.dataset.conversationSection),
    [
      "starred",
      "direct-messages",
      "public-channels",
      "private-channels",
      "group-conversations",
      "threads",
    ],
  );
  assert.ok(mountedRows().length > 0);
  assert.ok(mountedRows().length <= 32);
  assert.equal(mountedRows().filter(({ tabIndex }) => tabIndex === 0).length, 1);
  const starredRows = mountedRows().filter(
    (row) => row.dataset.conversationId === largeConversations[0].id,
  );
  assert.deepEqual(starredRows.map((row) => row.dataset.navigationRowId), [
    `starred:${largeConversations[0].id}`,
  ]);
  assert.equal(new Set(starredRows.map(({ id }) => id)).size, 1);

  const midIdentity = `public-channels:${largeConversations[2_000].id}`;
  await act(async () => {
    navigation.scrollTop = logicalIdentities.indexOf(midIdentity) * 36;
    navigation.dispatchEvent(new window.Event("scroll", { bubbles: true }));
    await flush();
  });
  assert.ok(mountedRows().length <= 32);
  assert.notEqual(navigation.querySelector(
    `[data-navigation-row-id="${midIdentity}"]`,
  ), null);
  assert.equal(mountedRows().filter(({ tabIndex }) => tabIndex === 0).length, 1);

  const boundaryRow = mountedRows().at(-1);
  const boundaryIndex = logicalIdentities.indexOf(boundaryRow.dataset.navigationRowId);
  assert.ok(boundaryIndex >= 0 && boundaryIndex < logicalIdentities.length - 1);
  const nextIdentity = logicalIdentities[boundaryIndex + 1];
  boundaryRow.focus();
  await keyDown(boundaryRow, "ArrowDown");
  assert.equal(document.activeElement.dataset.navigationRowId, nextIdentity);
  assert.ok(mountedRows().length <= 32);

  await keyDown(document.activeElement, "ArrowRight");
  assert.equal(
    document.activeElement.dataset.navigationRowId,
    logicalIdentities[boundaryIndex + 2],
  );
  await keyDown(document.activeElement, "ArrowLeft");
  assert.equal(document.activeElement.dataset.navigationRowId, nextIdentity);
  await keyDown(document.activeElement, "ArrowUp");
  assert.equal(document.activeElement.dataset.navigationRowId, boundaryRow.dataset.navigationRowId);

  await keyDown(document.activeElement, "End");
  assert.equal(document.activeElement.dataset.navigationRowId, logicalIdentities.at(-1));
  assert.ok(navigation.scrollTop > 0);
  assert.ok(mountedRows().length <= 32);
  await keyDown(document.activeElement, "Home");
  assert.equal(document.activeElement.dataset.navigationRowId, logicalIdentities[0]);
  assert.equal(navigation.scrollTop, 0);

  assert.equal(observers.length, 1);
  await act(async () => {
    observers[0].intersect();
    observers[0].intersect();
    await flush();
  });
  assert.equal(
    fixture.calls.filter(({ name }) => name === "listConversations").length,
    1,
  );
  await act(async () => {
    fixture.releaseConversationPage();
    await flush();
  });
  assert.equal(navigation.querySelector(".handrail-chat__conversation-load-more"), null);
  assert.ok(mountedRows().length <= 32);
  await act(async () => {
    observers[0].intersect();
    await flush();
  });
  assert.equal(
    fixture.calls.filter(({ name }) => name === "listConversations").length,
    1,
  );
});

test("5,000-conversation windowing keeps selection, starring, filtering, and collapse state coherent", async () => {
  const largeConversations = Object.freeze(Array.from({ length: 5_000 }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    const conversation = conversationState({
      id: `conversation-coherent-${suffix}`,
      type: "channel",
      name: `Coherent channel ${suffix}`,
      visibility: index < 2_500 ? "public" : "private",
    });
    return index === 0
      ? Object.freeze({
          ...conversation,
          currentPreference: Object.freeze({
            ...conversation.currentPreference,
            isStarred: true,
          }),
        })
      : conversation;
  }));
  const fixture = createFixture({
    hydrateListedConversationDetails: false,
    listedConversations: largeConversations,
  });
  const container = await mount(workspace(fixture, {
    conversationId: undefined,
    defaultConversationId: largeConversations[0].id,
    renderComposer: () => null,
    renderTimeline: () => null,
  }));
  const navigation = container.querySelector('nav[aria-label="Conversations"]');
  const mountedRows = () => [...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-navigation-row-id]",
  )];
  const rowFor = (sectionKind, conversationId) => navigation.querySelector(
    `[data-conversation-section="${sectionKind}"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${conversationId}"]`,
  );
  const selectedConversation = largeConversations[2];
  const ordinaryRow = rowFor("public-channels", selectedConversation.id);
  assert.notEqual(ordinaryRow, null);
  await click(ordinaryRow);
  assert.equal(ordinaryRow.getAttribute("aria-current"), "page");

  const star = ordinaryRow.closest(".handrail-chat__conversation-item")
    .querySelector(".handrail-chat__conversation-star");
  await pointerActivate(star);
  const selectedProjections = mountedRows().filter(
    (row) => row.dataset.conversationId === selectedConversation.id,
  );
  assert.deepEqual(selectedProjections.map((row) => row.dataset.navigationRowId), [
    `starred:${selectedConversation.id}`,
  ]);
  assert.equal(new Set(selectedProjections.map(({ id }) => id)).size, 1);
  assert.deepEqual(selectedProjections.map((row) => row.getAttribute("aria-current")), [
    "page",
  ]);
  assert.ok(mountedRows().length <= 32);

  const filter = navigation.querySelector(".handrail-chat__conversation-filter-input");
  const setFilter = async (value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
        .set.call(filter, value);
      filter.dispatchEvent(new window.InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: value.length === 0 ? "deleteContentBackward" : "insertText",
      }));
      await flush();
    });
  };
  await setFilter("Coherent channel 4999");
  assert.deepEqual(mountedRows().map((row) => row.dataset.conversationId), [
    largeConversations[4_999].id,
  ]);
  assert.equal(
    navigation.querySelector('[data-conversation-section="private-channels"] ' +
      ".handrail-chat__conversation-section-count").textContent,
    "1",
  );

  await setFilter("");
  const publicDisclosure = navigation.querySelector(
    '[data-conversation-section="public-channels"] ' +
      ".handrail-chat__conversation-section-disclosure",
  );
  await click(publicDisclosure);
  assert.equal(publicDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(rowFor("public-channels", selectedConversation.id), null);
  assert.equal(
    rowFor("starred", selectedConversation.id).getAttribute("aria-current"),
    "page",
  );
  assert.ok(mountedRows().length <= 32);

  await setFilter("Coherent channel 0002");
  assert.notEqual(rowFor("starred", selectedConversation.id), null);
  assert.equal(rowFor("public-channels", selectedConversation.id), null);
  assert.equal(navigation.querySelector(
    '[data-conversation-section="public-channels"]',
  ), null);
  await setFilter("");
  const restoredPublicDisclosure = navigation.querySelector(
    '[data-conversation-section="public-channels"] ' +
      ".handrail-chat__conversation-section-disclosure",
  );
  assert.equal(restoredPublicDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(rowFor("public-channels", selectedConversation.id), null);
  assert.equal(
    rowFor("starred", selectedConversation.id).getAttribute("aria-current"),
    "page",
  );
});

test("the navigation sentinel observer disconnects when ChatWorkspace unmounts", async () => {
  const observers = installIntersectionObserver();
  const fixture = createFixture({
    listNextCursor: "conversation-page-2",
    listedConversations: [publicConversation],
  });
  await mount(workspace(fixture));
  assert.equal(observers.length, 1);

  const entry = mounted.pop();
  await act(async () => entry.root.unmount());
  entry.container.remove();

  assert.equal(observers[0].disconnectCalls, 1);
});

test("the Load more conversations button remains operable without IntersectionObserver", async () => {
  Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  const fixture = createFixture({
    listNextCursor: "conversation-page-2",
    listNextPageConversations: [privateConversation],
    listedConversations: [publicConversation],
  });
  const container = await mount(workspace(fixture));
  const loadMore = container.querySelector(
    ".handrail-chat__conversation-load-more-button",
  );

  assert.equal(loadMore.disabled, false);
  await click(loadMore);

  assert.equal(
    fixture.calls.filter(({ name }) => name === "listConversations").length,
    1,
  );
  assert.notEqual(container.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${privateId}"]`,
  ), null);
  assert.equal(container.querySelector(".handrail-chat__conversation-load-more"), null);
});

test("conversation navigation moves starred rows out of their original sections and roves once", async () => {
  const starredPublicConversation = Object.freeze({
    ...publicConversation,
    currentPreference: Object.freeze({
      ...publicConversation.currentPreference,
      isStarred: true,
    }),
  });
  const fixture = createFixture({
    listedConversations: [
      threadConversation,
      privateConversation,
      groupDirectConversation,
      starredPublicConversation,
      directConversation,
    ],
  });
  const container = await mount(workspace(fixture, {
    conversationId: undefined,
    defaultConversationId: publicId,
  }));
  const navigation = container.querySelector('nav[aria-label="Conversations"]');
  const rows = [...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )];
  const rowFor = (sectionKind, conversationId) => navigation.querySelector(
    `[data-conversation-section="${sectionKind}"] ` +
      `.handrail-chat__conversation-button[data-conversation-id="${conversationId}"]`,
  );

  assert.deepEqual(
    [...navigation.querySelectorAll("[data-conversation-section]")]
      .map((section) => section.dataset.conversationSection),
    [
      "starred",
      "direct-messages",
      "public-channels",
      "private-channels",
      "group-conversations",
      "threads",
    ],
  );
  assert.deepEqual(rows.map((row) => row.dataset.conversationId), [
    publicId,
    directId,
    privateId,
    groupDirectId,
    threadId,
  ]);
  assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.dataset.navigationRowId)).size, rows.length);
  const publicRows = rows.filter((row) => row.dataset.conversationId === publicId);
  assert.deepEqual(publicRows.map((row) => row.getAttribute("aria-current")), [
    "page",
  ]);
  assert.deepEqual(publicRows.map(({ tabIndex }) => tabIndex), [0]);

  rowFor("starred", publicId).focus();
  await keyDown(rowFor("starred", publicId), "ArrowDown");
  assert.equal(document.activeElement, rowFor("direct-messages", directId));
  await keyDown(rowFor("private-channels", privateId), "ArrowLeft");
  assert.equal(document.activeElement, rowFor("direct-messages", directId));
  await keyDown(rowFor("private-channels", privateId), "Home");
  assert.equal(document.activeElement, rowFor("starred", publicId));
  await keyDown(rowFor("starred", publicId), "End");
  assert.equal(document.activeElement, rowFor("threads", threadId));
  await keyDown(rowFor("threads", threadId), "ArrowUp");
  assert.equal(document.activeElement, rowFor("group-conversations", groupDirectId));
});

test("Starred collapse and filtering do not restore an ordinary duplicate", async () => {
  const starredPublicConversation = Object.freeze({
    ...publicConversation,
    currentPreference: Object.freeze({
      ...publicConversation.currentPreference,
      isStarred: true,
    }),
  });
  const fixture = createFixture({
    listedConversations: [directConversation, starredPublicConversation],
  });
  const container = await mount(workspace(fixture, { conversationId: publicId }));
  const section = (kind) => container.querySelector(
    `[data-conversation-section="${kind}"]`,
  );
  const disclosure = (kind) => section(kind).querySelector(
    ".handrail-chat__conversation-section-disclosure",
  );
  const visibleProjectionIds = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-button[data-navigation-row-id]",
  )].map((row) => row.dataset.navigationRowId);

  await click(disclosure("starred"));
  assert.equal(disclosure("starred").getAttribute("aria-expanded"), "false");
  assert.equal(disclosure("public-channels").getAttribute("aria-expanded"), "true");
  assert.deepEqual(visibleProjectionIds(), [
    `direct-messages:${directId}`,
  ]);

  await click(disclosure("public-channels"));
  assert.equal(disclosure("starred").getAttribute("aria-expanded"), "false");
  assert.equal(disclosure("public-channels").getAttribute("aria-expanded"), "false");
  assert.deepEqual(visibleProjectionIds(), [`direct-messages:${directId}`]);

  const filter = container.querySelector(".handrail-chat__conversation-filter-input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(filter, "Public");
    filter.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Public",
      inputType: "insertText",
    }));
    await flush();
  });
  assert.deepEqual(visibleProjectionIds(), [
    `starred:${publicId}`,
  ]);
  assert.equal(disclosure("starred").disabled, true);
  assert.equal(section("public-channels"), null);

  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(filter, "");
    filter.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: null,
      inputType: "deleteContentBackward",
    }));
    await flush();
  });
  assert.equal(disclosure("starred").getAttribute("aria-expanded"), "false");
  assert.equal(disclosure("public-channels").getAttribute("aria-expanded"), "false");
  assert.deepEqual(visibleProjectionIds(), [`direct-messages:${directId}`]);
});

test("conversation navigation filtering and an empty direct bucket add no blank or duplicate rows", async () => {
  const mixedFixture = createFixture({
    listedConversations: [directConversation, publicConversation, privateConversation],
  });
  const filtered = await mount(workspace(mixedFixture));
  const filter = filtered.querySelector(".handrail-chat__conversation-filter-input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(filter, "Public");
    filter.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: "Public",
      inputType: "insertText",
    }));
    await flush();
  });
  const filteredRows = [...filtered.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )];
  assert.deepEqual(
    [...filtered.querySelectorAll("[data-conversation-section]")]
      .map((section) => section.dataset.conversationSection),
    ["public-channels"],
  );
  assert.equal(filtered.querySelector('[data-conversation-section="starred"]'), null);
  assert.deepEqual(filteredRows.map((row) => row.dataset.conversationId), [publicId]);
  assert.equal(filtered.querySelectorAll(".handrail-chat__conversation-section-empty").length, 0);

  const emptyDirectFixture = createFixture({
    listedConversations: [
      publicConversation,
      privateConversation,
      groupDirectConversation,
      threadConversation,
    ],
  });
  const emptyDirect = await mount(workspace(emptyDirectFixture));
  const directSections = emptyDirect.querySelectorAll(
    '[data-conversation-section="direct-messages"]',
  );
  const rowIds = [...emptyDirect.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )].map((row) => row.dataset.conversationId);

  assert.equal(directSections.length, 1);
  assert.equal(emptyDirect.querySelector('[data-conversation-section="starred"]'), null);
  assert.equal(directSections[0].querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  ).length, 0);
  assert.equal(
    directSections[0].querySelector(".handrail-chat__conversation-section-empty").textContent,
    "No direct messages yet.",
  );
  assert.deepEqual(rowIds, [publicId, privateId, groupDirectId, threadId]);
  assert.equal(new Set(rowIds).size, rowIds.length);
});

test("mounted direct heading, avatar, and composer recover after directory rate limiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directoryUsers = new Map();
  const fixture = createFixture({ directoryUsers });
  let limited = true;
  fixture.client.hydrateDirectoryUsers = async (ids) => {
    if (limited) return { status: "rejected", httpStatus: 429, message: "Rate limited" };
    for (const id of ids) directoryUsers.set(id, {
      kind: "active",
      userId: id,
      displayName: id === otherUserId ? "Grace Hopper" : "Ada Lovelace",
      avatar: { kind: "initials", initials: id === otherUserId ? "GH" : "AL" },
    });
    return { status: "success", value: { users: ids.map((id) => directoryUsers.get(id)) } };
  };
  const container = await mount(workspace(fixture, { conversationId: directId }));
  const heading = () => container.querySelector(".handrail-chat__header");
  const composer = container.querySelector("textarea");
  assert.match(heading().textContent, /Unknown participant/);
  assert.equal(composer.getAttribute("placeholder"), "Message Unknown participant");
  const stateBeforeRecovery = fixture.cache.getState();

  limited = false;
  await act(async () => { t.mock.timers.tick(60_000); await flush(); });

  assert.match(heading().textContent, /Grace Hopper/);
  assert.doesNotMatch(heading().textContent, /Unknown participant/);
  assert.equal(container.querySelector("textarea"), composer, "composer stays mounted");
  assert.equal(composer.getAttribute("placeholder"), "Message Grace Hopper");
  assert.equal(composer.getAttribute("aria-label"), "Message Grace Hopper");
  assert.match(heading().textContent, /GH/);
  assert.equal(fixture.cache.getState(), stateBeforeRecovery,
    "directory recovery does not mutate conversation, thread, or follow revisions");
});

test("the default composer exposes contextual accessible labels and placeholders", () => {
  const groupFixture = createFixture();
  groupFixture.cache.hydrateConversationDetail(detail(groupDirectConversation));

  const unavailableDirectory = new Map(directory);
  unavailableDirectory.set(otherUserId, Object.freeze({
    kind: "unavailable",
    userId: otherUserId,
    reason: "temporarily_unavailable",
  }));
  const unresolvedDirectory = new Map(directory);
  unresolvedDirectory.delete(otherUserId);

  for (const [fixture, conversationId, expectedLabel] of [
    [createFixture(), publicId, "Message #Public channel"],
    [createFixture(), privateId, "Message #Private channel"],
    [createFixture(), directId, "Message Avery Example"],
    [createFixture({ directoryUsers: unavailableDirectory }), directId, "Message Unknown user"],
    [createFixture({ directoryUsers: unresolvedDirectory }), directId, "Message Unknown participant"],
    [groupFixture, groupDirectId, "Message Avery Example"],
    [createFixture(), threadId, "Reply to thread"],
  ]) {
    const markup = renderToStaticMarkup(workspace(fixture, { conversationId }));
    const rendered = document.createElement("div");
    rendered.innerHTML = markup;
    const textarea = rendered.querySelector("textarea");

    assert.equal(textarea.getAttribute("aria-label"), expectedLabel);
    assert.equal(textarea.getAttribute("placeholder"), expectedLabel);
    assert.doesNotMatch(
      `${textarea.getAttribute("aria-label")} ${textarea.getAttribute("placeholder")}`,
      /temporarily_unavailable|user-default-workspace-other/,
    );
  }
});

test("typing status keeps stable composer layout, excludes the current user, and ignores heartbeat-only copy changes", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture));
  const indicator = container.querySelector(".handrail-chat__typing-indicator");
  const liveRegion = indicator.querySelector('[role="status"]');

  assert.equal(indicator.getAttribute("data-active"), "false");
  assert.equal(liveRegion.getAttribute("aria-live"), "polite");
  assert.equal(liveRegion.getAttribute("aria-atomic"), "true");
  assert.equal(liveRegion.textContent, "");
  assert.ok(indicator.nextElementSibling.matches(".handrail-chat__composer"));

  await act(async () => {
    applyTypingSignal(fixture, {
      actorUserId: userId,
      eventId: "typing-current-user",
      sessionId: "current-user",
    });
    await flush();
  });
  assert.equal(liveRegion.textContent, "");

  await act(async () => {
    applyTypingSignal(fixture, {
      eventId: "typing-other-user",
      sessionId: "other-user-one",
    });
    await flush();
  });
  assert.equal(liveRegion.textContent, "Avery Example is typing…");
  assert.equal(indicator.getAttribute("data-active"), "true");

  const mutations = [];
  const observer = new window.MutationObserver((records) => mutations.push(...records));
  observer.observe(liveRegion, { childList: true, characterData: true, subtree: true });
  await act(async () => {
    applyTypingSignal(fixture, {
      eventId: "typing-other-user-heartbeat",
      expiresAt: "2038-05-06T07:11:00.000Z",
      sentAt: "2038-05-06T07:08:10.000Z",
      sessionId: "other-user-two",
    });
    await flush();
  });
  observer.disconnect();

  assert.equal(liveRegion.textContent, "Avery Example is typing…");
  assert.equal(mutations.length, 0);
});

test("typing status renders bounded plural copy and safe directory fallbacks", () => {
  const fallbackCases = [
    [
      "typing-redacted",
      Object.freeze({ kind: "redacted", userId: "typing-redacted" }),
      "Hidden user is typing…",
    ],
    [
      "typing-unavailable",
      Object.freeze({
        kind: "unavailable",
        userId: "typing-unavailable",
        reason: "private-provider-detail",
      }),
      "Unavailable user is typing…",
    ],
    ["typing-unresolved", undefined, "Unknown participant is typing…"],
  ];

  for (const [actorUserId, summary, expected] of fallbackCases) {
    const directoryUsers = new Map(directory);
    if (summary !== undefined) directoryUsers.set(actorUserId, summary);
    const fixture = createFixture({ directoryUsers });
    applyTypingSignal(fixture, {
      actorUserId,
      eventId: `fallback-${actorUserId}`,
      sessionId: actorUserId,
    });
    const markup = renderToStaticMarkup(workspace(fixture));
    const rendered = document.createElement("div");
    rendered.innerHTML = markup;
    const copy = rendered.querySelector(".handrail-chat__typing-indicator").textContent;

    assert.equal(copy, expected);
    assert.doesNotMatch(copy, /typing-(?:redacted|unavailable|unresolved)|private-provider-detail/);
  }

  const directoryUsers = new Map(directory);
  for (const [actorUserId, displayName] of [
    ["typing-a", "Alex"],
    ["typing-b", "Blair"],
    ["typing-c", "Casey"],
    ["typing-d", "Devon"],
  ]) {
    directoryUsers.set(actorUserId, Object.freeze({
      kind: "active",
      userId: actorUserId,
      displayName,
      avatar: Object.freeze({ kind: "initials", initials: displayName.slice(0, 1) }),
    }));
  }
  const fixture = createFixture({ directoryUsers });
  for (const actorUserId of ["typing-a", "typing-b", "typing-c", "typing-d"]) {
    applyTypingSignal(fixture, {
      actorUserId,
      eventId: `multiple-${actorUserId}`,
      sessionId: actorUserId,
    });
  }
  const markup = renderToStaticMarkup(workspace(fixture));
  const rendered = document.createElement("div");
  rendered.innerHTML = markup;
  assert.equal(
    rendered.querySelector(".handrail-chat__typing-indicator").textContent,
    "Alex, Blair, and 2 others are typing…",
  );
});

test("typing status clears on stop and expiry without retaining names across conversation switches", async () => {
  const privateTyperId = "typing-private-redacted";
  const directoryUsers = new Map(directory);
  directoryUsers.set(privateTyperId, Object.freeze({
    kind: "redacted",
    userId: privateTyperId,
  }));
  const fixture = createFixture({ directoryUsers });
  applyTypingSignal(fixture, {
    eventId: "typing-public-before-switch",
    expiresAt: "2038-05-06T07:09:00.000Z",
    sessionId: "public-switch",
  });
  applyTypingSignal(fixture, {
    actorUserId: privateTyperId,
    conversationId: privateId,
    eventId: "typing-private-before-switch",
    sessionId: "private-switch",
  });
  const container = await mount(workspace(fixture, {
    conversationId: undefined,
    defaultConversationId: publicId,
  }));
  const statusCopy = () => container.querySelector(
    ".handrail-chat__typing-indicator [role=\"status\"]",
  ).textContent;
  const selectConversation = async (conversationId) => click(container.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${conversationId}"]`,
  ));

  assert.equal(statusCopy(), "Avery Example is typing…");
  await selectConversation(privateId);
  assert.equal(statusCopy(), "Hidden user is typing…");
  assert.doesNotMatch(statusCopy(), /Avery Example/);

  await act(async () => {
    applyTypingSignal(fixture, {
      actorUserId: privateTyperId,
      conversationId: privateId,
      eventId: "typing-private-stop",
      sentAt: "2038-05-06T07:08:10.000Z",
      sessionId: "private-switch",
      state: "stop",
    });
    await flush();
  });
  assert.equal(statusCopy(), "");

  await act(async () => {
    fixture.cache.expireEphemeralSignals(Date.parse("2038-05-06T07:09:00.000Z"));
    await flush();
  });
  await selectConversation(publicId);
  assert.equal(statusCopy(), "");
});

test("switching conversations updates composer context and restores each draft", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture, {
    conversationId: undefined,
    defaultConversationId: publicId,
  }));
  const composerInput = () => container.querySelector(
    '[aria-label="Conversation composer"] textarea',
  );
  const selectConversation = async (conversationId) => {
    await click(container.querySelector(
      `.handrail-chat__conversation-button[data-conversation-id="${conversationId}"]`,
    ));
  };

  assert.equal(composerInput().getAttribute("aria-label"), "Message #Public channel");
  assert.equal(composerInput().placeholder, "Message #Public channel");
  await input(composerInput(), "Public draft");

  await selectConversation(privateId);
  assert.equal(composerInput().getAttribute("aria-label"), "Message #Private channel");
  assert.equal(composerInput().placeholder, "Message #Private channel");
  assert.equal(composerInput().value, "");
  await input(composerInput(), "Private draft");

  await selectConversation(publicId);
  assert.equal(composerInput().getAttribute("aria-label"), "Message #Public channel");
  assert.equal(composerInput().placeholder, "Message #Public channel");
  assert.equal(composerInput().value, "Public draft");

  await selectConversation(privateId);
  assert.equal(composerInput().getAttribute("aria-label"), "Message #Private channel");
  assert.equal(composerInput().placeholder, "Message #Private channel");
  assert.equal(composerInput().value, "Private draft");
});

test("WorkspaceHeader preserves defaults, renders safe identity, and composes wired controls", async () => {
  const defaultMarkup = renderToStaticMarkup(workspace(createFixture()));
  const defaultRendered = document.createElement("div");
  defaultRendered.innerHTML = defaultMarkup;
  assert.equal(
    defaultRendered.querySelector(".handrail-chat__navigation-title").textContent,
    "Conversations",
  );
  assert.equal(defaultRendered.querySelector(".handrail-chat__workspace-menu-trigger"), null);
  assert.equal(defaultRendered.querySelector(".handrail-chat__workspace-settings-trigger").getAttribute("aria-haspopup"), "dialog");

  const identityMarkup = renderToStaticMarkup(workspace(createFixture(), {
    workspaceIdentity: {
      id: "workspace-support",
      name: "Support workspace",
      description: "Customer collaboration",
    },
  }));
  const identityRendered = document.createElement("div");
  identityRendered.innerHTML = identityMarkup;
  assert.equal(
    identityRendered.querySelector(".handrail-chat__navigation-title").textContent,
    "Support workspace",
  );
  assert.equal(
    identityRendered.querySelector(".handrail-chat__navigation-header")
      .dataset.workspaceId,
    "workspace-support",
  );
  assert.match(
    identityRendered.querySelector(".handrail-chat__workspace-description").textContent,
    /Customer collaboration/,
  );

  const defaultControlMarkup = renderToStaticMarkup(workspace(createFixture(), {
    channelCreationAvailability: { canCreate: true },
    onWorkspaceMenuOpen: () => {},
    onWorkspaceSettingsOpen: () => {},
  }));
  const defaultControls = document.createElement("div");
  defaultControls.innerHTML = defaultControlMarkup;
  for (const [selector, label, iconName] of [
    [".handrail-chat__workspace-menu-trigger", "Open workspace menu", "workspace-menu"],
    [".handrail-chat__workspace-settings-trigger", "Open workspace settings", "settings"],
    [".handrail-chat__creation-menu-trigger", "Add conversation", "add"],
  ]) {
    const control = defaultControls.querySelector(selector);
    assert.ok(control, `${label} renders when its existing gate is open`);
    assert.equal(control.getAttribute("aria-label"), label);
    const icon = control.querySelector("[data-navigation-icon]");
    assert.equal(icon?.tagName, "svg");
    assert.equal(icon?.dataset.navigationIcon, iconName);
    assert.equal(icon?.getAttribute("aria-hidden"), "true");
    assert.equal(icon?.getAttribute("focusable"), "false");
    assert.equal(icon?.getAttribute("stroke"), "currentColor");
    assert.equal(icon?.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(control.textContent, "");
  }

  const callbackCalls = [];
  let renderedIdentity;
  const WorkspaceHeader = ({ identity, controls, hostProps }) => {
    renderedIdentity = identity;
    return createElement(
      "div",
      { ...hostProps, className: "custom-workspace-header" },
      createElement("h2", null, identity?.name ?? "Conversations"),
      createElement("span", null, identity?.description),
      controls.menu,
      controls.settings,
      controls.messageSearch,
      controls.createConversation,
    );
  };
  const customFixture = createFixture();
  const messageSearchListeners = new Set();
  let messageSearchState = Object.freeze({ state: "idle" });
  const publishMessageSearch = (next) => {
    const previous = messageSearchState;
    messageSearchState = Object.freeze(next);
    for (const listener of messageSearchListeners) listener(messageSearchState, previous);
  };
  Object.assign(customFixture.client, {
    getMessageSearchState: () => messageSearchState,
    subscribeMessageSearch(listener) {
      messageSearchListeners.add(listener);
      return () => messageSearchListeners.delete(listener);
    },
    cancelMessageSearch() {
      if (messageSearchState.state !== "idle") publishMessageSearch({ state: "idle" });
    },
    searchMessages(input) {
      publishMessageSearch({ state: "success", query: input.query, hits: [] });
      return Promise.resolve({ status: "success", value: { hits: [] } });
    },
  });
  const container = await mount(workspace(customFixture, {
    channelCreationAvailability: { canCreate: true },
    components: { WorkspaceHeader },
    workspaceIdentity: {
      id: "workspace-support",
      name: "Support workspace",
      description: "Customer collaboration",
      tenantId,
      actor: { userId },
      client: customFixture.client,
      provider: "private-provider",
      token: "private-token",
    },
    workspaceMenuContent: "Switch workspace",
    onWorkspaceMenuOpen: () => callbackCalls.push("menu"),
    onWorkspaceSettingsOpen: () => callbackCalls.push("settings"),
  }));

  assert.match(container.querySelector(".custom-workspace-header").textContent, /Support workspace/);
  assert.match(container.querySelector(".custom-workspace-header").textContent, /Customer collaboration/);
  assert.deepEqual(renderedIdentity, {
    id: "workspace-support",
    name: "Support workspace",
    description: "Customer collaboration",
  });
  assert.equal(Object.isFrozen(renderedIdentity), true);
  const customMenu = container.querySelector(".handrail-chat__workspace-menu-trigger");
  assert.equal(customMenu.textContent, "Switch workspace");
  assert.equal(customMenu.querySelector("[data-navigation-icon]"), null);
  assert.equal(customMenu.getAttribute("aria-label"), "Open workspace menu");
  const defaultSettings = container.querySelector(
    ".handrail-chat__workspace-settings-trigger",
  );
  assert.equal(
    defaultSettings.querySelector("[data-navigation-icon]")?.dataset.navigationIcon,
    "settings",
  );
  assert.equal(defaultSettings.getAttribute("aria-label"), "Open workspace settings");
  await click(container.querySelector(".handrail-chat__workspace-menu-trigger"));
  await click(container.querySelector(".handrail-chat__workspace-settings-trigger"));
  assert.deepEqual(callbackCalls, ["menu", "settings"]);

  await click(container.querySelector(".handrail-chat__message-search-trigger"));
  assert.ok(container.querySelector('.handrail-chat__message-search input[name="messageSearchQuery"]'));
  await click(container.querySelector(".handrail-chat__message-search-close"));

  await click(container.querySelector('button[aria-label="Add conversation"]'));
  const createChannel = [...container.querySelectorAll('[role="menuitem"]')]
    .find(({ textContent }) => textContent === "Create channel");
  assert.ok(createChannel);
  await click(createChannel);
  assert.match(container.querySelector('[role="dialog"]').textContent, /Create channel/);
});

test("channel creation is a workspace modal with contained focus and global-trigger restoration", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture, {
    channelCreationAvailability: { canCreate: true },
  }));
  const root = container.querySelector(".handrail-chat");
  const navigation = root.querySelector('nav[aria-label="Conversations"]');
  const rowIdsBefore = [...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )].map((row) => row.dataset.conversationId);
  const globalTrigger = navigation.querySelector('button[aria-label="Add conversation"]');

  await click(globalTrigger);
  const createChannel = [...navigation.querySelectorAll('[role="menuitem"]')]
    .find(({ textContent }) => textContent === "Create channel");
  await click(createChannel);

  const overlay = root.querySelector(".handrail-chat__channel-creation");
  const dialog = overlay.querySelector('[role="dialog"]');
  const workspaceContent = [...root.children]
    .filter((element) => element.classList.contains("handrail-chat__workspace-content"));
  const nameInput = dialog.querySelector('input[name="channelName"]');
  const publicChoice = dialog.querySelector('input[value="public"]');
  const privateChoice = dialog.querySelector('input[value="private"]');
  const cancel = dialog.querySelector(".handrail-chat__channel-creation-cancel");

  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(navigation.contains(overlay), false);
  assert.equal(overlay.parentElement, root);
  assert.deepEqual(
    [...navigation.querySelectorAll(
      ".handrail-chat__conversation-button[data-conversation-id]",
    )].map((row) => row.dataset.conversationId),
    rowIdsBefore,
  );
  assert.ok(workspaceContent.length >= 2);
  assert.ok(workspaceContent.every((region) => region.hasAttribute("inert")));
  assert.equal(dialog.hasAttribute("inert"), false);
  assert.equal(document.activeElement, nameInput);
  assert.equal(publicChoice.checked, false);
  assert.equal(privateChoice.checked, false);

  await keyDown(nameInput, "Tab", { shiftKey: true });
  assert.equal(document.activeElement, cancel);
  await keyDown(cancel, "Tab");
  assert.equal(document.activeElement, nameInput);

  await click(dialog);
  assert.equal(root.querySelector('[role="dialog"][aria-modal="true"]'), dialog);
  await keyDown(dialog, "Escape");
  assert.equal(root.querySelector(".handrail-chat__channel-creation"), null);
  assert.ok(workspaceContent.every((region) => !region.hasAttribute("inert")));
  assert.equal(document.activeElement, globalTrigger);

  await click(globalTrigger);
  const reopenedCreateChannel = [...navigation.querySelectorAll('[role="menuitem"]')]
    .find(({ textContent }) => textContent === "Create channel");
  await click(reopenedCreateChannel);
  const reopenedOverlay = root.querySelector(".handrail-chat__channel-creation");
  await click(reopenedOverlay);
  assert.equal(root.querySelector(".handrail-chat__channel-creation"), null);
  assert.ok(workspaceContent.every((region) => !region.hasAttribute("inert")));
  assert.equal(document.activeElement, globalTrigger);
});

test("channel section actions retain their visibility defaults across dismiss and reopen", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture, {
    channelCreationAvailability: { canCreate: true },
  }));
  const publicTrigger = container.querySelector(
    'button[aria-label="Create public channel"]',
  );
  const privateTrigger = container.querySelector(
    'button[aria-label="Create private channel"]',
  );

  await click(publicTrigger);
  let dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  assert.equal(dialog.querySelector('input[value="public"]').checked, true);
  assert.equal(dialog.querySelector('input[value="private"]').checked, false);
  await click(dialog.querySelector(".handrail-chat__channel-creation-cancel"));
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, publicTrigger);

  await click(privateTrigger);
  dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  assert.equal(dialog.querySelector('input[value="public"]').checked, false);
  assert.equal(dialog.querySelector('input[value="private"]').checked, true);
  const overlay = dialog.parentElement;
  await click(overlay);
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, privateTrigger);

  await click(publicTrigger);
  dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  assert.equal(dialog.querySelector('input[value="public"]').checked, true);
  assert.equal(dialog.querySelector('input[value="private"]').checked, false);
  await dateTimeInput(
    dialog.querySelector('input[name="channelName"]'),
    "Repeated public launch",
  );
  assert.equal(
    dialog.querySelector(".handrail-chat__channel-creation-submit").disabled,
    false,
  );
  await keyDown(dialog, "Escape");
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, publicTrigger);

  await click(privateTrigger);
  dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  assert.equal(dialog.querySelector('input[value="public"]').checked, false);
  assert.equal(dialog.querySelector('input[value="private"]').checked, true);
  await click(dialog.querySelector(".handrail-chat__channel-creation-cancel"));
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, privateTrigger);
});

test("pending channel creation disables controls and ignores Escape, Cancel, and backdrop dismissal", async () => {
  const fixture = createFixture();
  Object.assign(fixture.client, {
    createChannel: () => new Promise(() => undefined),
  });
  const container = await mount(workspace(fixture, {
    channelCreationAvailability: { canCreate: true },
  }));
  const trigger = container.querySelector('button[aria-label="Create public channel"]');
  await click(trigger);
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  const overlay = dialog.parentElement;
  const nameInput = dialog.querySelector('input[name="channelName"]');
  const publicChoice = dialog.querySelector('input[value="public"]');

  await dateTimeInput(nameInput, "Pending channel");
  await click(publicChoice);
  const submit = dialog.querySelector(".handrail-chat__channel-creation-submit");
  assert.equal(submit.disabled, false);
  await click(submit);

  const cancel = dialog.querySelector(".handrail-chat__channel-creation-cancel");
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute("aria-busy"), "true");
  assert.equal(cancel.disabled, true);
  assert.match(dialog.querySelector('[role="status"]').textContent, /Creating channel/);

  await keyDown(dialog, "Escape");
  await click(cancel);
  await click(overlay);
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), dialog);
  assert.equal(document.activeElement === trigger, false);
});

test("detail state panels expose stable loading and automatic-selection semantics", async () => {
  const loadingContainer = await mount(workspace(
    createFixture({ listState: "loading" }),
  ));
  const loadingDetail = loadingContainer.querySelector(".handrail-chat__detail");
  const loadingPanel = loadingDetail.querySelector(
    '[data-state-kind="workspace-loading"]',
  );
  assert.ok(loadingPanel);
  assert.equal(loadingPanel.getAttribute("role"), "status");
  assert.equal(loadingPanel.getAttribute("aria-live"), "polite");
  assert.equal(loadingPanel.getAttribute("aria-busy"), "true");
  assert.equal(loadingDetail.getAttribute("aria-busy"), "true");
  assert.equal(
    loadingPanel.querySelectorAll(
      '.handrail-chat__state-panel-progress[aria-hidden="true"] .handrail-chat__state-panel-progress-dot',
    ).length,
    3,
  );
  assert.match(loadingPanel.textContent, /Loading chat workspace/);

  const selectingMarkup = renderToStaticMarkup(workspace(
    createFixture(),
    { conversationId: null },
  ));
  assert.match(selectingMarkup, /data-state-kind="conversation-selecting"/);
  assert.match(selectingMarkup, /aria-busy="true"/);
  assert.match(selectingMarkup, /Selecting a conversation/);

  const detailLoadingContainer = await mount(workspace(
    createFixture({ detailState: "loading" }),
  ));
  const detailLoadingPanel = detailLoadingContainer.querySelector(
    '.handrail-chat__detail > [data-state-kind="conversation-loading"]',
  );
  assert.ok(detailLoadingPanel);
  assert.equal(detailLoadingPanel.getAttribute("role"), "status");
  assert.equal(detailLoadingPanel.getAttribute("aria-busy"), "true");
  assert.match(detailLoadingPanel.textContent, /Loading conversation/);
});

test("a ready workspace with no selected conversation does not access huddle runtime state", async () => {
  const fixture = createFixture();
  const huddleAccesses = [];
  const originalGetHuddleState = fixture.client.getHuddleState;
  const originalSubscribeHuddle = fixture.client.subscribeHuddle;
  const originalHydrateHuddle = fixture.client.hydrateHuddle;
  fixture.client.getHuddleState = (conversationId) => {
    huddleAccesses.push({ name: "getHuddleState", conversationId });
    if (conversationId.length === 0) throw new TypeError("Huddle conversation id is invalid");
    return originalGetHuddleState(conversationId);
  };
  fixture.client.subscribeHuddle = (conversationId, listener) => {
    huddleAccesses.push({ name: "subscribeHuddle", conversationId });
    if (conversationId.length === 0) throw new TypeError("Huddle conversation id is invalid");
    return originalSubscribeHuddle(conversationId, listener);
  };
  fixture.client.hydrateHuddle = (conversationId) => {
    huddleAccesses.push({ name: "hydrateHuddle", conversationId });
    if (conversationId.length === 0) throw new TypeError("Huddle conversation id is invalid");
    return originalHydrateHuddle(conversationId);
  };

  const container = await mount(workspace(fixture, { conversationId: null }));

  assert.ok(container.querySelector('[data-state-kind="conversation-selecting"]'));
  assert.deepEqual(huddleAccesses, []);
});

test("detail empty and unavailable panels preserve live-region and decorative semantics", async () => {
  const emptyContainer = await mount(workspace(
    createFixture({ empty: true }),
    { conversationId: null },
  ));
  const emptyPanel = emptyContainer.querySelector(
    '.handrail-chat__detail > [data-state-kind="no-conversation"]',
  );
  assert.ok(emptyPanel);
  assert.equal(emptyPanel.getAttribute("role"), "status");
  assert.equal(emptyPanel.getAttribute("aria-live"), "polite");
  assert.equal(emptyPanel.getAttribute("aria-busy"), null);
  assert.equal(
    emptyPanel.querySelector(".handrail-chat__state-panel-glyph").getAttribute("aria-hidden"),
    "true",
  );
  assert.match(emptyPanel.textContent, /No conversations/);

  const unavailableContainer = await mount(workspace(
    createFixture({ detailState: "unavailable" }),
    { conversationId: unavailableConversationId },
  ));
  const unavailablePanel = unavailableContainer.querySelector(
    '.handrail-chat__detail > [data-state-kind="conversation-unavailable"]',
  );
  assert.ok(unavailablePanel);
  assert.equal(unavailablePanel.getAttribute("role"), "status");
  assert.equal(unavailablePanel.getAttribute("aria-live"), "polite");
  assert.match(unavailablePanel.textContent, /Conversation unavailable/);
});

test("detail failures use a distinct alert panel without a nonfunctional retry control", async () => {
  const container = await mount(workspace(
    createFixture({ detailState: "error" }),
  ));
  const panel = container.querySelector(
    '.handrail-chat__detail > [data-state-kind="conversation-error"]',
  );
  assert.ok(panel);
  assert.equal(panel.getAttribute("role"), "alert");
  assert.equal(panel.getAttribute("aria-live"), "assertive");
  assert.equal(panel.getAttribute("aria-busy"), null);
  assert.match(panel.className, /handrail-chat__state-panel--error/);
  assert.match(panel.textContent, /Unable to load conversation/);
  assert.match(panel.textContent, /conversation detail could not be loaded/);
  assert.equal(panel.querySelector("button"), null);
});

test("custom EmptyState slots retain the detail panel host contract", async () => {
  const seen = [];
  const CustomEmptyState = (props) => {
    seen.push(props);
    return createElement(
      "aside",
      { ...props.hostProps, "data-custom-empty-state": props.kind },
      `${props.title}: Custom empty state`,
    );
  };
  const container = await mount(workspace(
    createFixture({ empty: true }),
    {
      components: { EmptyState: CustomEmptyState },
      conversationId: null,
    },
  ));
  const panel = container.querySelector(
    '[data-custom-empty-state="no_conversation"]',
  );
  assert.ok(panel);
  assert.equal(panel.getAttribute("role"), "status");
  assert.equal(panel.getAttribute("aria-live"), "polite");
  assert.equal(panel.getAttribute("data-state-kind"), "no-conversation");
  assert.match(panel.className, /handrail-chat__state-panel--empty/);
  assert.equal(panel.querySelector(".handrail-chat__state-panel-glyph"), null);
  assert.equal(seen.at(-1).kind, "no_conversation");
  assert.match(panel.textContent, /Custom empty state/);
});

test("empty public and private channels render specific visibility introductions in the timeline column", () => {
  const publicRendered = renderEmptyConversation({
    conversation: conversationState({
      id: "conversation-empty-public",
      type: "channel",
      name: "Public channel",
      visibility: "public",
      entity: { type: "invoice", id: "42" },
    }),
  });
  const publicIntroduction = publicRendered.querySelector(
    '[data-conversation-introduction="channel"]',
  );
  assert.ok(publicIntroduction.classList.contains("handrail-chat__timeline-column"));
  assert.ok(publicIntroduction.classList.contains("handrail-chat__timeline-introduction"));
  assert.equal(publicIntroduction.dataset.conversationVisibility, "public");
  assert.equal(
    publicIntroduction.querySelector(".handrail-chat__timeline-introduction-title").textContent,
    "#Public channel",
  );
  assert.match(publicIntroduction.textContent, /Public channel/);
  assert.match(publicIntroduction.textContent, /anyone in the workspace can find and join/);
  assert.match(publicIntroduction.textContent, /Connected to invoice 42/);
  assert.match(publicIntroduction.textContent, /Send the first message when you’re ready/);
  assert.doesNotMatch(publicIntroduction.textContent, /tenant-default-workspace|Current User/);

  const privateRendered = renderEmptyConversation({ conversation: privateConversation });
  const privateIntroduction = privateRendered.querySelector(
    '[data-conversation-introduction="channel"]',
  );
  assert.ok(privateIntroduction.classList.contains("handrail-chat__timeline-column"));
  assert.equal(privateIntroduction.dataset.conversationVisibility, "private");
  assert.equal(
    privateIntroduction.querySelector(".handrail-chat__timeline-introduction-title").textContent,
    "#Private channel",
  );
  assert.match(privateIntroduction.textContent, /Private channel/);
  assert.match(privateIntroduction.textContent, /private channel for invited members/);
  assert.match(privateIntroduction.textContent, /Send the first message when you’re ready/);
  assert.doesNotMatch(privateIntroduction.textContent, /tenant-default-workspace|Current User/);
});

test("empty direct and group-direct timelines use safe other-participant identity", () => {
  const directRendered = renderEmptyConversation({ conversation: directConversation });
  const directIntroduction = directRendered.querySelector(
    '[data-conversation-introduction="direct"]',
  );
  assert.equal(
    directIntroduction.querySelector(".handrail-chat__timeline-introduction-title").textContent,
    "Avery Example",
  );
  assert.match(directIntroduction.textContent, /private conversation with Avery Example/);
  assert.match(directIntroduction.textContent, /Send the first message when you’re ready/);
  assert.doesNotMatch(directIntroduction.textContent, /Current User|user-default-workspace/);

  const redactedId = "user-empty-group-redacted";
  const unavailableId = "user-empty-group-unavailable";
  const unresolvedId = "user-empty-group-unresolved";
  const directoryUsers = new Map(directory);
  directoryUsers.set(redactedId, Object.freeze({
    kind: "redacted",
    userId: redactedId,
  }));
  directoryUsers.set(unavailableId, Object.freeze({
    kind: "unavailable",
    userId: unavailableId,
    reason: "temporarily_unavailable",
  }));
  const groupRendered = renderEmptyConversation({
    conversation: groupDirectConversation,
    directoryUsers,
    memberUserIds: [unresolvedId, userId, unavailableId, otherUserId, redactedId],
  });
  const groupIntroduction = groupRendered.querySelector(
    '[data-conversation-introduction="group_direct"]',
  );
  assert.ok(groupIntroduction.classList.contains("handrail-chat__timeline-column"));
  assert.equal(groupIntroduction.dataset.participantResolution, "ready");
  assert.equal(
    groupIntroduction.querySelector(".handrail-chat__timeline-introduction-title").textContent,
    "Avery Example, Hidden user, Unavailable user, Unknown participant",
  );
  assert.match(groupIntroduction.textContent, /4 other participants/);
  assert.match(groupIntroduction.textContent, /private group conversation/);
  assert.match(groupIntroduction.textContent, /Send the first message when you’re ready/);
  assert.doesNotMatch(
    groupIntroduction.textContent,
    /Current User|user-empty-group-|temporarily_unavailable|tenant-default-workspace/,
  );
});

test("custom EmptyState overrides receive the compatible frozen safe introduction projection", () => {
  const seen = [];
  const directoryUsers = new Map(directory);
  directoryUsers.set(otherUserId, Object.freeze({
    kind: "redacted",
    userId: otherUserId,
  }));
  const CustomEmptyState = (props) => {
    seen.push(props);
    return createElement(
      "aside",
      { ...props.hostProps, "data-custom-empty-state": props.kind },
      `${props.title}: ${props.description}`,
    );
  };
  const rendered = renderEmptyConversation({
    components: { EmptyState: CustomEmptyState },
    conversation: directConversation,
    directoryUsers,
  });
  const panel = rendered.querySelector('[data-custom-empty-state="no_messages"]');
  const props = seen.at(-1);

  assert.equal(panel.textContent, "Hidden user: Send the first message when you’re ready.");
  assert.ok(panel.classList.contains("handrail-chat__timeline-column"));
  assert.equal(props.kind, "no_messages");
  assert.equal(props.title, "Hidden user");
  assert.equal(props.description, "Send the first message when you’re ready.");
  assert.deepEqual(props.introduction.participants, [{
    label: "Hidden user",
    state: "redacted",
  }]);
  assert.equal(Object.isFrozen(props.introduction), true);
  assert.equal(Object.isFrozen(props.introduction.participants), true);
  assert.equal(Object.isFrozen(props.introduction.participants[0]), true);
  const serialized = JSON.stringify(props.introduction);
  assert.doesNotMatch(
    serialized,
    /tenant|client|provider|token|membership|userId|Current User|user-default-workspace/,
  );
});

test("member management is absent unless viewing is explicitly authorized", () => {
  const fixture = createFixture();
  for (const props of [
    {},
    { memberManagementAvailability: { canView: false } },
  ]) {
    const markup = renderToStaticMarkup(workspace(fixture, props));
    assert.doesNotMatch(markup, /Open conversation members/);
    assert.doesNotMatch(markup, /handrail-chat__member-management-panel/);
  }
});

test("the header members count opens a named panel and close actions restore focus", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture, {
    memberManagementAvailability: { canView: true },
  }));
  const trigger = container.querySelector(
    'button[aria-label="Open conversation members (2 members)"]',
  );

  assert.ok(trigger);
  assert.equal(trigger.querySelector(".handrail-chat__member-management-count").textContent, "2");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector(".handrail-chat__member-management-panel"), null);

  trigger.focus();
  await click(trigger);
  let dialog = container.querySelector('.handrail-chat__member-management-panel[role="dialog"]');
  assert.ok(dialog);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-controls"), dialog.id);
  assert.equal(
    dialog.querySelector(`#${dialog.getAttribute("aria-labelledby")}`).textContent,
    "Conversation members",
  );
  const close = dialog.querySelector('button[aria-label="Close conversation members"]');
  assert.ok(close);
  const closeIcon = close?.querySelector('svg[data-pane-control-icon="close"]');
  assert.equal(closeIcon?.tagName, "svg");
  assert.equal(closeIcon?.getAttribute("aria-hidden"), "true");
  assert.equal(closeIcon?.getAttribute("focusable"), "false");
  assert.equal(closeIcon?.getAttribute("stroke"), "currentColor");
  assert.equal(close?.textContent, "");
  assert.doesNotMatch(close?.textContent ?? "", /[←×]/u);
  assert.equal(document.activeElement, close);
  await click(close);
  assert.equal(container.querySelector(".handrail-chat__member-management-panel"), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  dialog = container.querySelector('.handrail-chat__member-management-panel[role="dialog"]');
  await keyDown(dialog, "Escape");
  assert.equal(container.querySelector(".handrail-chat__member-management-panel"), null);
  assert.equal(document.activeElement, trigger);
});

test("switching conversations closes members without restoring focus to a stale trigger", async () => {
  const fixture = createFixture();
  const StatefulWorkspace = () => {
    const [conversationId, setConversationId] = React.useState(publicId);
    return workspace(fixture, {
      conversationId,
      memberManagementAvailability: { canView: true },
      onConversationChange: setConversationId,
    });
  };
  const container = await mount(createElement(StatefulWorkspace));
  const oldTrigger = container.querySelector(
    'button[aria-label="Open conversation members (2 members)"]',
  );
  await click(oldTrigger);
  assert.ok(container.querySelector(".handrail-chat__member-management-panel"));

  const privateConversationButton = [...container.querySelectorAll(
    ".handrail-chat__conversation-button",
  )].find(({ textContent }) => textContent.includes("Private channel"));
  await click(privateConversationButton);

  const newTrigger = container.querySelector(
    'button[aria-label="Open conversation members (2 members)"]',
  );
  assert.equal(container.querySelector(".handrail-chat__member-management-panel"), null);
  assert.equal(newTrigger.dataset.conversationId, privateId);
  assert.notEqual(document.activeElement, oldTrigger);
  assert.notEqual(document.activeElement, newTrigger);
});

test("default public actions send, open and close a focus-restoring thread, and start a huddle", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture));

  const textarea = container.querySelector('textarea[aria-label="Message #Public channel"]');
  await input(textarea, "Sent from the workspace");
  await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Send"));
  assert.equal(
    fixture.calls.find(({ name }) => name === "sendMessage").args[0].conversationId,
    publicId,
  );

  const openThread = container.querySelector('[aria-label^="Open thread"]');
  openThread.focus();
  await click(openThread);
  assert.equal(fixture.calls.find(({ name }) => name === "openThread").args[0], rootMessageId);
  assert.ok(container.querySelector("[data-handrail-thread-panel]"));
  await click(container.querySelector('button[aria-label="Close panel"]'));
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  assert.equal(document.activeElement, openThread);

  await click(container.querySelector('button[aria-label="Start huddle"]'));
  assert.deepEqual(fixture.calls.find(({ name }) => name === "startHuddle").args, [publicId]);
});

test("the default workspace coordinates empty-composer ArrowUp with timeline edit focus and Escape restoration", async () => {
  const editableMessage = message(
    "message-owned-editable",
    publicId,
    "Latest owned message",
    {
      author: { type: "user", userId },
      sequence: 2,
    },
  );
  const messageRows = new Map(messages);
  messageRows.set(publicId, [publicRoot, editableMessage]);
  const fixture = createFixture({ messageRows });
  const container = await mount(workspace(fixture));
  const composer = container.querySelector('textarea[aria-label="Message #Public channel"]');
  composer.focus();
  const arrowUp = new window.KeyboardEvent("keydown", {
    key: "ArrowUp",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    composer.dispatchEvent(arrowUp);
    await flush();
  });

  assert.equal(arrowUp.defaultPrevented, true);
  const editor = container.querySelector('textarea[id="edit-message-owned-editable"]');
  assert.notEqual(editor, null);
  assert.equal(document.activeElement, editor);
  assert.equal(editor.selectionStart, editor.value.length);
  assert.equal(editor.selectionEnd, editor.value.length);

  await keyDown(editor, "Escape");
  assert.equal(container.querySelector('textarea[id="edit-message-owned-editable"]'), null);
  assert.equal(document.activeElement, composer);

  const readOnlyContainer = await mount(workspace(createFixture({ messageRows }), {
    readOnly: true,
  }));
  const readOnlyComposer = readOnlyContainer.querySelector(
    'textarea[aria-label="Message #Public channel"]',
  );
  const readOnlyArrowUp = new window.KeyboardEvent("keydown", {
    key: "ArrowUp",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    readOnlyComposer.dispatchEvent(readOnlyArrowUp);
    await flush();
  });
  assert.equal(readOnlyArrowUp.defaultPrevented, false);
  assert.equal(readOnlyContainer.querySelector("textarea[id^=edit-]"), null);

  const customMessageContainer = await mount(workspace(createFixture({ messageRows }), {
    components: {
      Message: ({ message: value, hostProps }) => createElement(
        "div",
        { ...hostProps, "data-custom-message": value.id },
        value.content?.text,
      ),
    },
  }));
  const customComposer = customMessageContainer.querySelector(
    'textarea[aria-label="Message #Public channel"]',
  );
  const customArrowUp = new window.KeyboardEvent("keydown", {
    key: "ArrowUp",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    customComposer.dispatchEvent(customArrowUp);
    await flush();
  });
  assert.equal(customArrowUp.defaultPrevented, false);
  assert.equal(customMessageContainer.querySelector("textarea[id^=edit-]"), null);
});

test("places the inactive huddle in the channel header and the live call bar between timeline and composer", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture));
  const header = container.querySelector(".handrail-chat__header");
  const timeline = container.querySelector('[aria-label="Conversation timeline"]');
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  const inactive = container.querySelector('[data-huddle-status="inactive"]');

  assert.ok(header.contains(inactive));
  assert.ok(inactive.classList.contains("handrail-chat__huddle-header-button"));
  assert.equal(inactive.getAttribute("aria-label"), "Start huddle");
  assert.equal(inactive.title, "Start huddle");
  assert.equal(header.textContent.includes("Media connection:"), false);
  assert.equal(header.querySelector("[data-handrail-huddle-controls]"), null);
  assert.equal(container.querySelector('[aria-label="Conversation huddle"]'), null);

  await act(async () => {
    fixture.publishHuddle(publicId, {
      conversationId: publicId,
      hydrationStatus: "ready",
      media: Object.freeze({ state: "idle" }),
      canonicalState: Object.freeze({
        status: "starting",
        conversationId: publicId,
        huddleSessionId: "workspace-huddle-session",
        startedAt: now,
        participants: Object.freeze([{
          userId: otherUserId,
          status: "joined",
          joinedAt: now,
        }]),
        screenShareOwnerUserId: null,
      }),
    });
    await flush();
  });

  const callBar = container.querySelector('[aria-label="Conversation huddle"]');
  const live = callBar.querySelector('[data-huddle-status="starting"]');
  assert.ok(live.classList.contains("handrail-chat--huddle-live"));
  assert.equal(header.contains(live), false);
  assert.ok(timeline.compareDocumentPosition(callBar) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(callBar.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING);
});

test("docks an opened thread beside a stable independently scrolling timeline pane", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture));
  const body = container.querySelector(".handrail-chat__conversation-body");
  const timeline = container.querySelector('[aria-label="Conversation timeline"]');
  const timelineViewport = timeline.querySelector(".handrail-chat__timeline-viewport");
  const openThread = timeline.querySelector('[aria-label^="Open thread"]');

  assert.ok(body);
  assert.equal(timeline.parentElement, body);
  assert.equal(body.classList.contains("handrail-chat__conversation-body--thread-open"), false);
  assert.equal(container.querySelector('[aria-label="Conversation thread"]'), null);

  timelineViewport.scrollTop = 73;
  openThread.focus();
  await click(openThread);

  const thread = container.querySelector('[aria-label="Conversation thread"]');
  assert.ok(thread);
  assert.equal(thread.parentElement, body);
  assert.equal(timeline.parentElement, body);
  assert.equal(body.classList.contains("handrail-chat__conversation-body--thread-open"), true);
  assert.equal(timeline.querySelector(".handrail-chat__timeline-viewport"), timelineViewport);
  assert.equal(timelineViewport.scrollTop, 73);
  assert.ok(thread.querySelector("[data-handrail-thread-panel]"));
  assert.ok(thread.querySelector('[aria-label="Thread replies"]'));
  assert.ok(thread.querySelector('textarea[aria-label="Reply to thread"]'));

  await click(thread.querySelector('button[aria-label="Close panel"]'));
  assert.equal(container.querySelector('[aria-label="Conversation thread"]'), null);
  assert.equal(body.classList.contains("handrail-chat__conversation-body--thread-open"), false);
  assert.equal(timeline.querySelector(".handrail-chat__timeline-viewport"), timelineViewport);
  assert.equal(timelineViewport.scrollTop, 73);
  assert.equal(document.activeElement, openThread);
});

test("Reply starts a new thread and is hidden for deleted and unsent messages", async () => {
  const fixture = createFixture({ replyActionStates: true });
  const container = await mount(workspace(fixture));
  const timeline = container.querySelector('[aria-label="Conversation timeline"]');
  const root = timeline.querySelector(`[data-message-id="${rootMessageId}"]`);
  const reply = root.querySelector('button[aria-label="Reply"]');

  assert.ok(reply);
  assert.equal(root.querySelector('[aria-label^="Open thread"]'), null);
  for (const messageId of ["message-deleted", "message-sending", "message-failed"]) {
    const row = timeline.querySelector(`[data-message-id="${messageId}"]`);
    assert.equal(row.querySelector('button[aria-label="Reply"]'), null);
  }

  reply.focus();
  await click(reply);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "openThread").args, [rootMessageId]);
  assert.ok(container.querySelector("[data-handrail-thread-panel]"));
  assert.ok(container.querySelector('[aria-label="Thread replies"]'));
  assert.ok(container.querySelector('textarea[aria-label="Reply to thread"]'));

  await click(container.querySelector('button[aria-label="Close panel"]'));
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  assert.equal(document.activeElement, reply);
});

test("Remind me schedules exact preset and custom local instants and validates future input", async (t) => {
  const fixedNow = Date.parse(now);
  t.mock.method(Date, "now", () => fixedNow);
  const fixture = createFixture();
  const container = await mount(workspace(fixture));
  const row = container.querySelector(`[data-message-id="${rootMessageId}"]`);

  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me"));
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "In 20 minutes"));
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "messageReminderCommand")[0].args[0], {
    operation: "message_reminder.v1",
    intent: "set",
    conversationId: publicId,
    messageId: rootMessageId,
    expectedReminderRevision: 0,
    idempotencyKey: "default-workspace-reminder-1",
    dueAt: "2038-05-06T07:28:09.000Z",
  });

  const local = row.querySelector('input[type="datetime-local"]');
  await dateTimeInput(local, "2038-05-06T09:45");
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Set reminder"));
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "messageReminderCommand")[1].args[0], {
    operation: "message_reminder.v1",
    intent: "set",
    conversationId: publicId,
    messageId: rootMessageId,
    expectedReminderRevision: 1,
    idempotencyKey: "default-workspace-reminder-2",
    dueAt: new Date("2038-05-06T09:45").toISOString(),
  });

  await dateTimeInput(local, "2000-01-01T00:00");
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Set reminder"));
  assert.equal(fixture.calls.filter(({ name }) => name === "messageReminderCommand").length, 2);
  assert.match(row.querySelector('[role="alert"]').textContent, /future date and time/i);
});

test("a preset synchronously latches every reminder control against a rapid empty custom submit", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const fixture = createFixture({
    reminderExisting: true,
    reminderPending: true,
    reminderPendingStateDeferred: true,
  });
  const container = await mount(workspace(fixture));
  const row = container.querySelector(`[data-message-id="${rootMessageId}"]`);

  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me"));
  const preset = [...row.querySelectorAll("button")].find(({ textContent }) => textContent === "In 20 minutes");
  const customSubmit = [...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Set reminder");

  await act(async () => {
    preset.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    customSubmit.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await flush();
  });

  assert.equal(fixture.calls.filter(({ name }) => name === "messageReminderCommand").length, 1);
  assert.equal(row.querySelector('[role="alert"]'), null);
  assert.equal(row.querySelector('input[type="datetime-local"]').disabled, true);
  for (const label of ["In 20 minutes", "In 1 hour", "Tomorrow", "Set reminder", "Cancel reminder"]) {
    assert.equal([...row.querySelectorAll("button")].find(({ textContent }) => textContent === label).disabled, true);
  }

  await act(async () => {
    fixture.releaseReminder();
    await flush();
  });
  assert.equal(row.querySelector('[role="alert"]'), null);
  assert.match(row.querySelector('[role="status"]').textContent, /scheduled/i);
});

test("an existing reminder is displayed, rescheduled, and cancelled at canonical revisions", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const fixture = createFixture({ reminderExisting: true });
  const container = await mount(workspace(fixture));
  const row = container.querySelector(`[data-message-id="${rootMessageId}"]`);
  assert.equal(row.querySelector(`time[datetime="${existingReminderDue}"]`)?.dateTime, existingReminderDue);

  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me"));
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "In 1 hour"));
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Cancel reminder"));

  const commands = fixture.calls.filter(({ name }) => name === "messageReminderCommand").map(({ args }) => args[0]);
  assert.deepEqual(commands.map(({ intent, expectedReminderRevision }) => ({ intent, expectedReminderRevision })), [
    { intent: "set", expectedReminderRevision: 3 },
    { intent: "cancel", expectedReminderRevision: 4 },
  ]);
  assert.equal("dueAt" in commands[1], false);
  assert.equal(row.querySelector(".handrail-chat__timeline-status time[datetime]"), null);
  assert.match(row.querySelector('[role="status"]').textContent, /cancelled/i);
});

test("reminder pending and retryable failures are accessible and preserve retry correlation", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const pendingFixture = createFixture({ reminderPending: true });
  const pendingContainer = await mount(workspace(pendingFixture));
  const pendingRow = pendingContainer.querySelector(`[data-message-id="${rootMessageId}"]`);
  await click([...pendingRow.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me"));
  await click([...pendingRow.querySelectorAll("button")].find(({ textContent }) => textContent === "Tomorrow"));
  assert.match(pendingRow.querySelector('[role="status"]').textContent, /updating reminder/i);
  assert.equal([...pendingRow.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me").disabled, true);

  const failedFixture = createFixture({ reminderFailure: true });
  const failedContainer = await mount(workspace(failedFixture));
  const failedRow = failedContainer.querySelector(`[data-message-id="${rootMessageId}"]`);
  await click([...failedRow.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me"));
  await click([...failedRow.querySelectorAll("button")].find(({ textContent }) => textContent === "Tomorrow"));
  assert.match(failedRow.querySelector('[role="status"]').textContent, /retry is available/i);
  await click([...failedRow.querySelectorAll("button")].find(({ textContent }) => textContent === "Retry reminder"));
  assert.deepEqual(
    failedFixture.calls.find(({ name }) => name === "messageReminderRetry").args[0],
    failedFixture.calls.find(({ name }) => name === "messageReminderCommand").args[0],
  );
});

test("a newer canonical reminder replaces stale optimistic UI and drives subsequent revisions", async (t) => {
  t.mock.method(Date, "now", () => Date.parse(now));
  const fixture = createFixture({ reminderExisting: true, reminderPending: true });
  const container = await mount(workspace(fixture));
  const row = container.querySelector(`[data-message-id="${rootMessageId}"]`);
  const canonicalDue = "2038-05-09T16:00:00.000Z";

  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Remind me"));
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Tomorrow"));
  await act(async () => {
    fixture.pushReminderCanonical(5, canonicalDue);
    await flush();
  });
  assert.equal(row.querySelector(".handrail-chat__timeline-status time[datetime]").dateTime, canonicalDue);
  assert.match(row.querySelector('[role="status"]').textContent, /changed elsewhere/i);

  await act(async () => {
    fixture.releaseReminder();
    await flush();
  });
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "In 20 minutes"));
  await click([...row.querySelectorAll("button")].find(({ textContent }) => textContent === "Cancel reminder"));
  const commands = fixture.calls.filter(({ name }) => name === "messageReminderCommand").map(({ args }) => args[0]);
  assert.deepEqual(commands.map(({ intent, expectedReminderRevision }) => ({ intent, expectedReminderRevision })), [
    { intent: "set", expectedReminderRevision: 3 },
    { intent: "set", expectedReminderRevision: 5 },
    { intent: "cancel", expectedReminderRevision: 6 },
  ]);
});

test("Remind me is hidden for deleted, sending, and failed messages", async () => {
  const fixture = createFixture({ replyActionStates: true });
  const container = await mount(workspace(fixture));
  const timeline = container.querySelector('[aria-label="Conversation timeline"]');
  assert.ok([...timeline.querySelector(`[data-message-id="${rootMessageId}"]`).querySelectorAll("button")]
    .some(({ textContent }) => textContent === "Remind me"));
  for (const messageId of ["message-deleted", "message-sending", "message-failed"]) {
    const row = timeline.querySelector(`[data-message-id="${messageId}"]`);
    assert.equal([...row.querySelectorAll("button")].some(({ textContent }) => textContent === "Remind me"), false);
  }
});

test("Forward selects an authorized destination once and focuses the canonical row", async (t) => {
  const fixture = createFixture({ forwardActionStates: true });
  const conversationChanges = [];
  const scrolled = [];
  const previousScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolled.push({ element: this, options });
  };
  t.after(() => {
    window.HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
  });
  const container = await mount(workspace(fixture, {
    conversationId: undefined,
    defaultConversationId: publicId,
    onConversationChange: (conversationId) => conversationChanges.push(conversationId),
  }));
  const sourceRow = container.querySelector(`[data-message-id="${forwardSourceMessageId}"]`);
  const trigger = [...sourceRow.querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");

  trigger.focus();
  await click(trigger);
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /A message worth forwarding/);
  assert.match(dialog.textContent, /Forward this message to Private channel\?/);
  assert.equal(dialog.textContent.includes("Public channel"), false);
  assert.equal(dialog.textContent.includes("Thread"), false);
  assert.equal(dialog.textContent.includes("Archived channel"), false);

  const choices = dialog.querySelectorAll('input[name="forwardDestination"]');
  assert.equal(choices.length, 2);
  assert.equal(document.activeElement, choices[0]);
  await keyDown(choices[0], "ArrowRight");
  assert.equal(document.activeElement, choices[1]);
  assert.equal(choices[1].checked, true);
  assert.match(dialog.textContent, /Forward this message to Direct conversation\?/);

  await click(dialog.querySelector('button[type="submit"]'));
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "forwardMessage"),
    [{
      name: "forwardMessage",
      args: [{
        sourceMessageId: forwardSourceMessageId,
        destinationConversationId: directId,
      }],
    }],
  );
  assert.deepEqual(conversationChanges, [directId]);
  const canonicalRow = container.querySelector(`[data-message-id="${forwardedMessageId}"]`);
  assert.ok(canonicalRow);
  assert.equal(document.activeElement, canonicalRow);
  assert.equal(scrolled.length, 1);
  assert.equal(scrolled[0].element, canonicalRow);
  assert.match(container.textContent, /Message forwarded and opened/);
});

test("Forward contains focus, supports every radio navigation key, and makes only the background inert", async () => {
  const fixture = createFixture({ forwardActionStates: true });
  const container = await mount(workspace(fixture));
  const trigger = [...container
    .querySelector(`[data-message-id="${forwardSourceMessageId}"]`)
    .querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");
  const workspaceContent = [...container.querySelectorAll(".handrail-chat__workspace-content")];
  assert.equal(workspaceContent.length, 2);
  assert.ok(workspaceContent.every((region) => !region.hasAttribute("inert")));

  trigger.focus();
  await click(trigger);
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  const choices = [...dialog.querySelectorAll('input[name="forwardDestination"]')];
  const cancel = dialog.querySelector(".handrail-chat__forward-action--secondary");
  const submit = dialog.querySelector(".handrail-chat__forward-action--primary");
  assert.equal(document.activeElement, choices[0]);
  assert.ok(workspaceContent.every((region) => region.hasAttribute("inert")));
  assert.equal(dialog.hasAttribute("inert"), false);
  assert.ok(workspaceContent.every((region) => !region.contains(dialog)));

  const expectChoiceAfter = async (fromIndex, key, expectedIndex) => {
    await keyDown(choices[fromIndex], key);
    assert.equal(document.activeElement, choices[expectedIndex], key);
    assert.equal(choices[expectedIndex].checked, true, key);
  };
  await expectChoiceAfter(0, "ArrowDown", 1);
  await expectChoiceAfter(1, "ArrowDown", 0);
  await expectChoiceAfter(0, "ArrowUp", 1);
  await expectChoiceAfter(1, "ArrowLeft", 0);
  await expectChoiceAfter(0, "ArrowRight", 1);
  await expectChoiceAfter(1, "Home", 0);
  await expectChoiceAfter(0, "End", 1);

  await keyDown(choices[1], "Tab", { shiftKey: true });
  assert.equal(document.activeElement, submit);
  await keyDown(submit, "Tab");
  assert.equal(document.activeElement, choices[1]);
  await keyDown(choices[1], "Tab");
  assert.equal(document.activeElement, cancel);
  await keyDown(cancel, "Tab");
  assert.equal(document.activeElement, submit);

  await keyDown(dialog, "Escape");
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.ok(workspaceContent.every((region) => !region.hasAttribute("inert")));
  assert.equal(document.activeElement, trigger);
});

test("Forward pending submission disables controls and ignores Escape", async () => {
  const fixture = createFixture({ forwardActionStates: true, forwardPending: true });
  const container = await mount(workspace(fixture));
  const trigger = [...container
    .querySelector(`[data-message-id="${forwardSourceMessageId}"]`)
    .querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");

  await click(trigger);
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  await click(dialog.querySelector('button[type="submit"]'));
  assert.match(dialog.textContent, /Forwarding message…/);
  assert.equal(dialog.querySelector("fieldset").disabled, true);
  assert.ok([...dialog.querySelectorAll("input")].every((control) => control.matches(":disabled")));
  assert.ok([...dialog.querySelectorAll("button")].every(({ disabled }) => disabled));
  assert.equal(dialog.querySelector('button[type="submit"]').getAttribute("aria-busy"), "true");
  assert.equal(fixture.calls.filter(({ name }) => name === "forwardMessage").length, 1);

  await keyDown(dialog, "Escape");
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), dialog);
  assert.equal(container.querySelector(".handrail-chat__workspace-content").hasAttribute("inert"), true);

  await act(async () => {
    fixture.releaseForward();
    await flush();
  });
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(fixture.calls.filter(({ name }) => name === "forwardMessage").length, 1);
});

test("Forward cancellation supports Escape and Cancel without a command and restores focus", async () => {
  const fixture = createFixture({ forwardActionStates: true });
  const container = await mount(workspace(fixture));
  const sourceRow = container.querySelector(`[data-message-id="${forwardSourceMessageId}"]`);
  const trigger = [...sourceRow.querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");

  trigger.focus();
  await click(trigger);
  await keyDown(container.querySelector('[role="dialog"][aria-modal="true"]'), "Escape");
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  await click([...dialog.querySelectorAll("button")].find(({ textContent }) => textContent === "Cancel"));
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(fixture.calls.some(({ name }) => name === "forwardMessage"), false);
});

test("Forward command failure reports a safe notice and restores focus", async () => {
  const failedFixture = createFixture({ forwardActionStates: true, forwardFailure: true });
  const failedContainer = await mount(workspace(failedFixture));
  const failedTrigger = [...failedContainer
    .querySelector(`[data-message-id="${forwardSourceMessageId}"]`)
    .querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");
  failedTrigger.focus();
  await click(failedTrigger);
  await click(failedContainer.querySelector('.handrail-chat__forward-form button[type="submit"]'));
  assert.match(failedContainer.textContent, /The message could not be forwarded\. Try again\./);
  assert.equal(failedContainer.textContent.includes("transport"), false);
  assert.equal(document.activeElement, failedTrigger);
});

test("Forward navigation failure reports a safe destination notice", async () => {
  const navigationFixture = createFixture({
    forwardActionStates: true,
    forwardNavigationFailure: true,
  });
  const navigationContainer = await mount(workspace(navigationFixture, {
    conversationId: undefined,
    defaultConversationId: publicId,
  }));
  const navigationTrigger = [...navigationContainer
    .querySelector(`[data-message-id="${forwardSourceMessageId}"]`)
    .querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");
  await click(navigationTrigger);
  await click(navigationContainer.querySelector('.handrail-chat__forward-form button[type="submit"]'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_600));
  });
  assert.match(
    navigationContainer.textContent,
    /The message was forwarded, but its destination row could not be opened\./,
  );
});

test("Forward filters unavailable destinations and is suppressed for unsupported source states", async () => {
  const fixture = createFixture({
    forwardActionStates: true,
    noForwardDestinations: true,
  });
  const container = await mount(workspace(fixture));
  const actionFor = (messageId) => [...container
    .querySelector(`[data-message-id="${messageId}"]`)
    .querySelectorAll("button")]
    .find(({ textContent }) => textContent === "Forward");
  const trigger = actionFor(forwardSourceMessageId);
  assert.ok(trigger);
  for (const messageId of [
    "message-forward-deleted",
    "message-forward-sending",
    "message-forward-failed",
    "message-forward-attachment",
    "message-forward-reference",
    "message-forward-block",
  ]) {
    assert.equal(actionFor(messageId), undefined, messageId);
  }

  trigger.focus();
  await click(trigger);
  assert.equal(container.querySelector('[role="dialog"][aria-modal="true"]'), null);
  assert.match(container.textContent, /No available destination conversation can receive this message/);
  assert.equal(document.activeElement, trigger);
  assert.equal(fixture.calls.some(({ name }) => name === "forwardMessage"), false);
});

test("host reaction keys flow to the default main timeline and opened thread", async () => {
  const reactions = [
    { reactionKey: "canonical-outside", count: 3, reactedByCurrentUser: true },
    { reactionKey: "eyes", count: 2, reactedByCurrentUser: false },
    { reactionKey: "shipit", count: 1, reactedByCurrentUser: false },
  ];
  const messageRows = new Map(messages);
  messageRows.set(publicId, [{ ...publicRoot, reactions }]);
  messageRows.set(threadId, [message("message-thread", threadId, "Thread reply", { reactions })]);
  const fixture = createFixture({ messageRows });
  const container = await mount(workspace(fixture, {
    reactionKeys: ["shipit", "shipit", "", " ", " eyes ", "e\u0301", "eyes"],
  }));

  const main = container.querySelector('[aria-label="Conversation timeline"]');
  assert.deepEqual(
    [...main.querySelectorAll(".handrail-chat__timeline-reaction")]
      .map((button) => button.getAttribute("aria-label")),
    ["Add shipit reaction", "Add eyes reaction", "Remove canonical-outside reaction"],
  );
  assert.equal(main.querySelectorAll('[aria-label="Add shipit reaction"]').length, 1);
  assert.equal(main.querySelectorAll('[aria-label="Add eyes reaction"]').length, 1);
  assert.notEqual(main.querySelector('button[aria-label="Add reaction"]'), null);

  await click(main.querySelector('[aria-label="Add shipit reaction"]'));
  assert.deepEqual(fixture.calls.find(({ name }) => name === "setReaction").args, [{
    messageId: rootMessageId,
    reactionKey: "shipit",
    reacted: true,
  }]);

  await click(main.querySelector('[aria-label^="Open thread"]'));
  const thread = container.querySelector('[aria-label="Thread replies"]');
  assert.deepEqual(
    [...thread.querySelectorAll(".handrail-chat__timeline-reaction")]
      .map((button) => button.getAttribute("aria-label")),
    ["Add shipit reaction", "Add eyes reaction", "Remove canonical-outside reaction"],
  );
  assert.notEqual(thread.querySelector('button[aria-label="Add reaction"]'), null);
});

test("host message mutation availability flows to the default main timeline and opened thread", async () => {
  const fixture = createFixture();
  const targets = [];
  const container = await mount(workspace(fixture, {
    resolveMessageMutationAvailability: (target) => {
      targets.push(target);
      return target.conversationId === publicId
        ? { canEdit: false, canDelete: true }
        : { canEdit: true, canDelete: false };
    },
  }));
  const mainTimeline = container.querySelector('[aria-label="Message timeline"]');

  assert.equal([...mainTimeline.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit"), false);
  assert.equal([...mainTimeline.querySelectorAll("button")].some(({ textContent }) => textContent === "Delete"), true);
  assert.deepEqual(targets.find(({ id }) => id === rootMessageId), {
    id: rootMessageId,
    conversationId: publicId,
    authorUserId: otherUserId,
  });

  await click(mainTimeline.querySelector('[aria-label^="Open thread"]'));
  const threadTimeline = container.querySelector('[aria-label="Thread replies"]');
  assert.equal([...threadTimeline.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit"), true);
  assert.equal([...threadTimeline.querySelectorAll("button")].some(({ textContent }) => textContent === "Delete"), false);
});

test("the default workspace bounds host reaction keys", async () => {
  const reactionKeys = Array.from({ length: 18 }, (_, index) => `choice-${index}`);
  const reactions = [...reactionKeys]
    .reverse()
    .map((reactionKey) => ({ reactionKey, count: 1, reactedByCurrentUser: false }));
  const messageRows = new Map(messages);
  messageRows.set(publicId, [{ ...publicRoot, reactions }]);
  const fixture = createFixture({ messageRows });
  const container = await mount(workspace(fixture, { reactionKeys }));
  const main = container.querySelector('[aria-label="Conversation timeline"]');

  assert.deepEqual(
    [...main.querySelectorAll(".handrail-chat__timeline-reaction")]
      .map((button) => button.getAttribute("aria-label")),
    [
      ...reactionKeys.slice(0, 16).map((reactionKey) => `Add ${reactionKey} reaction`),
      "Add choice-17 reaction",
      "Add choice-16 reaction",
    ],
  );
  assert.notEqual(main.querySelector('button[aria-label="Add reaction"]'), null);
});

test("every documented slot flows through the complete default composition", () => {
  const seen = new Set();
  const slot = (name, element = "div") => (props) => {
    seen.add(name);
    const child = name === "WorkspaceHeader"
      ? createElement(
          React.Fragment,
          null,
          props.identity?.name ?? name,
          props.controls.menu,
          props.controls.settings,
          props.controls.messageSearch,
          props.controls.createConversation,
        )
      : name === "Message"
      ? props.message.content?.text
      : name === "Composer"
        ? "Custom composer"
        : name;
    return createElement(element, { ...props.hostProps, [`data-slot-${name.toLowerCase()}`]: "" }, child);
  };
  const components = {
    WorkspaceHeader: slot("WorkspaceHeader"),
    Avatar: slot("Avatar", "span"),
    Message: slot("Message"),
    ChannelHeader: slot("ChannelHeader"),
    Composer: slot("Composer", "form"),
    EmptyState: slot("EmptyState", "section"),
    Attachment: slot("Attachment", "article"),
    SystemEvent: slot("SystemEvent", "p"),
    User: slot("User", "span"),
    EntityReference: slot("EntityReference", "span"),
  };
  renderToStaticMarkup(workspace(createFixture(), { components }));
  renderToStaticMarkup(workspace(createFixture({ empty: true }), {
    components,
    conversationId: null,
  }));
  renderToStaticMarkup(workspace(createFixture(), {
    components,
    conversationId: directId,
    renderComposer: () => null,
    renderTimeline: () => null,
  }));
  assert.deepEqual(seen, new Set(Object.keys(components)));
});

test("public and private channel headers omit member identity and expose canonical visibility", () => {
  for (const [conversationId, title, visibility, visibilityLabel] of [
    [publicId, "Public channel", "public", "Public channel"],
    [privateId, "Private channel", "private", "Private channel"],
  ]) {
    const markup = renderToStaticMarkup(workspace(createFixture(), {
      conversationId,
      renderComposer: () => null,
      renderTimeline: () => null,
    }));
    const rendered = document.createElement("div");
    rendered.innerHTML = markup;
    const header = rendered.querySelector(".handrail-chat__header");
    const channelHeader = header.querySelector(".handrail-chat__channel-header");

    assert.equal(header.querySelector(".handrail-chat__timeline-avatar"), null);
    assert.equal(header.querySelector(".handrail-chat__user"), null);
    assert.doesNotMatch(header.textContent, /Avery Example|Current User/);
    assert.equal(channelHeader.dataset.channelVisibility, visibility);
    assert.equal(
      channelHeader.querySelector(".handrail-chat__channel-title").textContent,
      title,
    );
    assert.equal(
      channelHeader.querySelector('.handrail-chat__channel-glyph[role="img"]')
        .getAttribute("aria-label"),
      visibilityLabel,
    );
    const icon = channelHeader.querySelector(
      ".handrail-chat__channel-glyph [data-navigation-icon]",
    );
    assert.equal(
      icon?.dataset.navigationIcon,
      visibility === "private" ? "private-channel" : "public-channel",
    );
    assert.equal(icon?.getAttribute("aria-hidden"), "true");
    assert.equal(icon?.getAttribute("focusable"), "false");
    assert.equal(icon?.getAttribute("stroke"), "currentColor");
    assert.equal(icon?.textContent, "");
  }
});

test("direct headers select the other member and expose only canonical availability", () => {
  const longDisplayName = "Avery Example with a deliberately long direct-message display name";
  for (const [availability, displayName] of [
    ["online", longDisplayName],
    ["offline", "Offline Avery"],
  ]) {
    const directoryUsers = new Map(directory);
    directoryUsers.set(otherUserId, Object.freeze({
      kind: "active",
      userId: otherUserId,
      displayName,
      avatar: Object.freeze({ kind: "initials", initials: "AE" }),
      status: Object.freeze({
        availability,
        text: "Sensitive host status text",
      }),
    }));
    const markup = renderToStaticMarkup(workspace(createFixture({ directoryUsers }), {
      conversationId: directId,
      renderComposer: () => null,
      renderTimeline: () => null,
    }));
    const rendered = document.createElement("div");
    rendered.innerHTML = markup;
    const header = rendered.querySelector(".handrail-chat__header");
    const title = header.querySelector(".handrail-chat__direct-participant-title");
    const availabilityCue = header.querySelector(
      ".handrail-chat__direct-participant-availability",
    );

    assert.equal(title.textContent, displayName);
    assert.equal(title.title, displayName);
    assert.equal(title.querySelector(".handrail-chat__user").textContent, displayName);
    assert.equal(availabilityCue.dataset.availability, availability);
    assert.equal(
      availabilityCue.getAttribute("aria-label"),
      `${availability} availability`,
    );
    assert.equal(header.querySelector(".handrail-chat__channel-header"), null);
    assert.doesNotMatch(header.textContent, /Current User|Direct conversation/);
    assert.doesNotMatch(header.textContent, /Sensitive host status text/);
  }
});

test("direct headers render safe directory and unresolved participant fallbacks", () => {
  for (const [summary, expectedLabel] of [
    [{ kind: "redacted", userId: otherUserId }, "Hidden user"],
    [{
      kind: "unavailable",
      userId: otherUserId,
      reason: "temporarily_unavailable",
    }, "Unknown user"],
    [undefined, "Unknown participant"],
  ]) {
    const directoryUsers = new Map(directory);
    if (summary === undefined) directoryUsers.delete(otherUserId);
    else directoryUsers.set(otherUserId, Object.freeze(summary));
    const markup = renderToStaticMarkup(workspace(createFixture({ directoryUsers }), {
      conversationId: directId,
      renderComposer: () => null,
      renderTimeline: () => null,
    }));
    const rendered = document.createElement("div");
    rendered.innerHTML = markup;
    const header = rendered.querySelector(".handrail-chat__header");

    assert.equal(
      header.querySelector(".handrail-chat__direct-participant-title").textContent,
      expectedLabel,
    );
    assert.equal(
      header.querySelector(".handrail-chat__direct-participant-availability"),
      null,
    );
    assert.equal(header.querySelector(".handrail-chat__channel-header"), null);
    assert.doesNotMatch(header.textContent, /Direct conversation/);
  }
});

test("group-direct headers render the other participant and exclude the current user", () => {
  const header = renderGroupDirectHeader({
    directoryUsers: new Map(directory),
    memberUserIds: [userId, otherUserId],
  });
  const title = header.querySelector(
    ".handrail-chat__group-direct-participant-title",
  );
  const avatars = header.querySelectorAll(
    ".handrail-chat__group-direct-avatar-stack > .handrail-chat__timeline-avatar",
  );

  assert.equal(title.textContent, "Avery Example");
  assert.equal(title.title, "Avery Example");
  assert.equal(title.getAttribute("aria-label"), "Avery Example");
  assert.equal(avatars.length, 1);
  assert.equal(avatars[0].title, "Avery Example");
  assert.equal(
    header.querySelector(".handrail-chat__group-direct-avatar-overflow"),
    null,
  );
  assert.equal(header.querySelector(".handrail-chat__channel-header"), null);
  assert.doesNotMatch(header.textContent, /Current User|Group conversation/);
});

test("group-direct headers order participants deterministically and bound avatar overflow", () => {
  const participants = [
    ["user-group-delta", "Delta"],
    ["user-group-beta", "Beta"],
    ["user-group-echo", "Echo"],
    ["user-group-alpha", "Alpha"],
    ["user-group-charlie", "Charlie"],
  ];
  const directoryUsers = new Map(directory);
  for (const [participantId, displayName] of participants) {
    directoryUsers.set(participantId, Object.freeze({
      kind: "active",
      userId: participantId,
      displayName,
      avatar: Object.freeze({ kind: "initials", initials: displayName[0] }),
    }));
  }
  const header = renderGroupDirectHeader({
    directoryUsers,
    memberUserIds: [
      "user-group-delta",
      userId,
      "user-group-beta",
      "user-group-echo",
      "user-group-alpha",
      "user-group-charlie",
    ],
  });
  const title = header.querySelector(
    ".handrail-chat__group-direct-participant-title",
  );
  const avatars = [...header.querySelectorAll(
    ".handrail-chat__group-direct-avatar-stack > .handrail-chat__timeline-avatar",
  )];
  const overflow = header.querySelector(
    ".handrail-chat__group-direct-avatar-overflow",
  );

  assert.equal(title.textContent, "Alpha, Beta, Charlie, Delta, Echo");
  assert.deepEqual(avatars.map((avatar) => avatar.title), [
    "Alpha",
    "Beta",
    "Charlie",
  ]);
  assert.equal(overflow.textContent, "+2");
  assert.equal(overflow.getAttribute("aria-label"), "2 more participants");
  assert.equal(overflow.title, "2 more participants");
  assert.doesNotMatch(header.textContent, /Current User/);
});

test("group-direct headers truncate long names while exposing the complete safe label", () => {
  const longDisplayName =
    "Avery Example with a deliberately long group-conversation display name";
  const directoryUsers = new Map(directory);
  directoryUsers.set(otherUserId, Object.freeze({
    kind: "active",
    userId: otherUserId,
    displayName: longDisplayName,
    avatar: Object.freeze({ kind: "initials", initials: "AE" }),
  }));
  const header = renderGroupDirectHeader({
    directoryUsers,
    memberUserIds: [otherUserId, userId],
  });
  const title = header.querySelector(
    ".handrail-chat__group-direct-participant-title",
  );

  assert.equal(title.textContent, longDisplayName);
  assert.equal(title.title, longDisplayName);
  assert.equal(title.getAttribute("aria-label"), longDisplayName);
});

test("group-direct headers use non-sensitive redacted, unavailable, and unresolved fallbacks", () => {
  const redactedId = "user-group-redacted";
  const unavailableId = "user-group-unavailable";
  const unresolvedId = "user-group-unresolved";
  const directoryUsers = new Map(directory);
  directoryUsers.set(redactedId, Object.freeze({
    kind: "redacted",
    userId: redactedId,
  }));
  directoryUsers.set(unavailableId, Object.freeze({
    kind: "unavailable",
    userId: unavailableId,
    reason: "temporarily_unavailable",
  }));
  const header = renderGroupDirectHeader({
    directoryUsers,
    memberUserIds: [unresolvedId, userId, unavailableId, redactedId],
  });
  const title = header.querySelector(
    ".handrail-chat__group-direct-participant-title",
  );

  assert.equal(
    title.textContent,
    "Hidden user, Unavailable user, Unknown participant",
  );
  assert.equal(title.title, title.textContent);
  assert.equal(title.getAttribute("aria-label"), title.textContent);
  assert.equal(
    header.querySelectorAll(".handrail-chat__group-direct-avatar-stack > *").length,
    3,
  );
  assert.equal(
    header.querySelectorAll(".handrail-chat__group-direct-avatar-fallback").length,
    1,
  );
  assert.doesNotMatch(
    header.textContent,
    /user-group-|temporarily_unavailable|Current User|Group conversation/,
  );
});

test("modes, scoped tokens, themes, and accessibility landmarks survive default composition", () => {
  const fixture = createFixture();
  for (const mode of ["full-screen", "side-panel", "modal", "record"]) {
    const markup = renderToStaticMarkup(workspace(fixture, {
      mode,
      theme: "dark",
      ariaLabel: "Project chat",
      navigationLabel: "Project conversations",
      style: { "--hr-chat-color-accent": "rgb(1 2 3)" },
    }));
    assert.match(markup, new RegExp(`data-handrail-chat-mode="${mode}"`));
    assert.match(markup, /data-handrail-theme="dark"/);
    assert.match(markup, /--hr-chat-color-accent:rgb\(1 2 3\)/);
    assert.match(markup, /aria-label="Project chat"/);
    assert.match(markup, /<nav aria-label="Project conversations"/);
    assert.match(markup, /<main aria-labelledby=/);
    assert.match(markup, /<footer aria-label="Conversation composer"/);
    if (mode === "modal") assert.match(markup, /role="dialog"/);
  }
});

test("reply style settings opens with keyboard, contains focus and restores the trigger", async () => {
  const fixture = createFixture();
  const container = await mount(workspace(fixture));
  const composer = container.querySelector('[aria-label="Conversation composer"] textarea');
  await input(composer, "Keep my draft while changing settings");
  const trigger = container.querySelector('.handrail-chat__workspace-settings-trigger');
  trigger.focus(); await keyboardActivate(trigger, "Enter");
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog); assert.equal(document.activeElement, dialog);
  assert.match(dialog.textContent, /Reply and thread style/);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const content = [...container.querySelectorAll('.handrail-chat__workspace-content')];
  assert.ok(content.every(node => node.hasAttribute("inert")));
  const close = dialog.querySelector('button');
  await keyDown(dialog, "Tab", { cancelable: true }); assert.equal(document.activeElement, close);
  await keyDown(close, "Tab", { cancelable: true }); assert.equal(document.activeElement, close);
  await keyDown(close, "Tab", { shiftKey: true, cancelable: true }); assert.equal(document.activeElement, close);
  await keyDown(close, "Escape", { cancelable: true });
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  assert.ok(content.every(node => !node.hasAttribute("inert")));
  assert.equal(container.querySelector('[aria-label="Conversation composer"] textarea'), composer);
  assert.equal(composer.value, "Keep my draft while changing settings");
  await keyboardActivate(trigger, " "); await click(container.querySelector('[role="dialog"] button'));
  assert.equal(document.activeElement, trigger);
});

test("host settings content and custom settings slot retain ownership", async () => {
  const calls = [];
  const container = await mount(workspace(createFixture(), {
    workspaceSettingsContent: createElement("button", { onClick: () => calls.push("content") }, "Host settings"),
    components: { WorkspaceHeader: ({ controls }) => createElement("header", { className: "host-header" }, controls.settings) },
  }));
  assert.equal(container.querySelector('.handrail-chat__workspace-settings-trigger'), null);
  await click(container.querySelector('.host-header button'));
  assert.deepEqual(calls, ["content"]); assert.equal(container.querySelector('[role="dialog"]'), null);
  const second = await mount(workspace(createFixture(), {
    workspaceSettingsContent: "Preferences", onWorkspaceSettingsOpen: () => calls.push("callback"),
  }));
  const trigger = second.querySelector('.handrail-chat__workspace-settings-trigger');
  assert.equal(trigger.textContent, "Preferences"); await click(trigger);
  assert.deepEqual(calls, ["content", "callback"]); assert.equal(second.querySelector('[role="dialog"]'), null);
});

// Real reply-style runtime; only its server read/write boundary is replaced.
async function withReplyRouting(fixture, { style = "discord", inlineReplies = true, persistence = true, namedThreads = true } = {}) {
  const { createReplyStyleRuntime } = await import("../dist/client/reply-style-runtime.js");
  const features = { ...enabledFeatures, ...(namedThreads === null ? {} : { namedThreads }), ...(inlineReplies === null ? {} : { inlineReplies }),
    reply_style_preference_v1: persistence };
  fixture.client.state = Object.freeze({ ...readyState, enabledFeatures: features });
  let revision = 1;
  const runtime = createReplyStyleRuntime({ cache: fixture.cache,
    configuration: persistence ? {} : { hostDefault: style },
    enabledFeatures: () => features, online: () => true, generateIdempotencyKey: () => `style-${revision}`,
    reader: { getReplyStylePreference: async () => ({ status: "success", value: { state: "saved", revision, style } }) },
    dispatch: async (_command, input) => ({ status: "success", value: {
      operation: input.operation, baseRevision: input.baseRevision, idempotencyKey: input.idempotencyKey,
      requestedStyle: input.style, reconciliationStatus: "applied",
      preference: { state: "saved", revision: ++revision, style: input.style },
    } }),
  });
  fixture.client.replyStyle = runtime.api;
  await runtime.api.load();
  return async next => { await act(async () => { await runtime.api.update(next); await flush(); }); };
}
const routingReply = (container, id) => container.querySelector(`[data-message-id="${id}"] button[aria-label="Reply"]`);
const routingSend = container => container.querySelector('button[type="submit"]');
const routingSends = fixture => fixture.calls.filter(call => call.name === "sendMessage").map(call => call.args[0]);
const assertNoThreadCommand = fixture => assert.equal(fixture.calls.some(call => ["openThread", "createThread"].includes(call.name)), false);

for (const conversationId of [publicId, directId, groupDirectId]) {
  test(`inline Reply routing sends Alice/Bob payload in ${conversationId} without opening threads`, async () => {
    const source = message("alice-question", conversationId, "Which launch date?");
    const fixture = createFixture({ listedConversations: [...conversations, groupDirectConversation],
      messageRows: new Map([...messages, [conversationId, [source]]]) });
    await withReplyRouting(fixture);
    const container = await mount(workspace(fixture, { conversationId }));
    const composer = container.querySelector('[aria-label="Conversation composer"]');
    await input(composer.querySelector("textarea"), "Friday");
    await click(routingReply(container, source.id));
    assert.equal(composer.querySelector("textarea").value, "Friday");
    assert.deepEqual(fixture.client.selectConversationDraft(conversationId).draft.content.replyTo,
      { messageId: source.id, notifyAuthor: true });
    await click(routingSend(composer));
    assert.deepEqual(routingSends(fixture), [{ conversationId,
      content: { format: "plain", text: "Friday" }, replyTo: { messageId: source.id, notifyAuthor: true } }]);
    assertNoThreadCommand(fixture);
    assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  });
}

test("inline Reply routing in an already-open ThreadPanel keeps its thread ID and parent draft", async () => {
  const fixture = createFixture(); const switchStyle = await withReplyRouting(fixture, { style: "current" });
  const container = await mount(workspace(fixture));
  const parentComposer = container.querySelector('[aria-label="Conversation composer"]');
  await input(parentComposer.querySelector("textarea"), "Parent draft");
  await click(routingReply(container, rootMessageId));
  assert.deepEqual(fixture.calls.find(call => call.name === "openThread").args, [rootMessageId]);
  const panel = container.querySelector("[data-handrail-thread-panel]");
  await switchStyle("discord");
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), panel);
  fixture.calls.length = 0;
  await input(panel.querySelector("textarea"), "Friday in this thread");
  await click(routingReply(panel, "message-thread"));
  await click(routingSend(panel));
  assert.deepEqual(routingSends(fixture), [{ conversationId: threadId,
    content: { format: "plain", text: "Friday in this thread" }, replyTo: { messageId: "message-thread", notifyAuthor: true } }]);
  assert.equal(parentComposer.querySelector("textarea").value, "Parent draft");
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), panel);
  assertNoThreadCommand(fixture);
});

for (const [label, options, props, reason] of [
  ["unsupported", { inlineReplies: false }, {}, /not supported/],
  ["unknown", { inlineReplies: null }, {}, /not supported/],
  ["read-only", {}, { readOnly: true }, /read-only/],
  ["send-disabled", {}, { composerAvailability: { canSend: false } }, /permission/],
  ["inactive member", {}, { composerAvailability: { membershipState: "removed" } }, /active member/],
  ["custom composer without connection", {}, { renderComposer: () => null }, /composer is unavailable/],
]) test(`inline Reply routing disables ${label} with an accessible explanation`, async () => {
  const fixture = createFixture(); await withReplyRouting(fixture, options);
  const container = await mount(workspace(fixture, props));
  const reply = routingReply(container, rootMessageId);
  assert.equal(reply.disabled, true);
  assert.match(reply.getAttribute("aria-description"), reason);
  await click(reply); assertNoThreadCommand(fixture);
  assert.equal(fixture.client.selectConversationDraft(publicId).draft, undefined);
});

test("inline Reply routing is independent of preference persistence support and excludes deleted/unsent sources", async () => {
  const fixture = createFixture({ replyActionStates: true });
  await withReplyRouting(fixture, { persistence: false });
  const container = await mount(workspace(fixture));
  assert.equal(routingReply(container, rootMessageId).disabled, false);
  for (const id of ["message-deleted", "message-sending", "message-failed"]) assert.equal(routingReply(container, id), null);
  await click(routingReply(container, rootMessageId));
  assert.equal(fixture.client.selectConversationDraft(publicId).draft.content.replyTo.messageId, rootMessageId);
  assertNoThreadCommand(fixture);
});

test("inline Reply routing preserves attachments, mentions and text when replacing a source", async () => {
  const fixture = createFixture(); await withReplyRouting(fixture);
  const content = { format: "plain", text: "Friday @Avery Example", attachments: [{ attachmentId: "schedule" }],
    mentions: [{ type: "user", userId: otherUserId }], replyTo: { messageId: "old-source", notifyAuthor: false } };
  fixture.client.replaceConversationDraft({ conversationId: publicId, content });
  const container = await mount(workspace(fixture));
  await click(routingReply(container, rootMessageId));
  assert.deepEqual(fixture.client.selectConversationDraft(publicId).draft.content,
    { ...content, replyTo: { messageId: rootMessageId, notifyAuthor: true } });
  await click(routingSend(container.querySelector('[aria-label="Conversation composer"]')));
  assert.deepEqual(routingSends(fixture)[0], { conversationId: publicId,
    content: { format: content.format, text: content.text, attachments: content.attachments, mentions: content.mentions },
    replyTo: { messageId: rootMessageId, notifyAuthor: true } });
  assertNoThreadCommand(fixture);
});

test("inline Reply routing freezes a pending send across style and conversation switches and rejects stale slot callbacks", async () => {
  const fixture = createFixture(); const switchStyle = await withReplyRouting(fixture);
  let resolveSend;
  fixture.client.sendMessage = input => { fixture.calls.push({ name: "sendMessage", args: [input] });
    return new Promise(resolve => { resolveSend = resolve; }); };
  const { DefaultMessageRenderer } = await import("@handrail/chat/ui");
  const rowActions = new Map();
  const components = { Message: props => { rowActions.set(props.message.id, props.actions); return createElement(DefaultMessageRenderer, props); } };
  const container = await mount(workspace(fixture, { components }));
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  await input(composer.querySelector("textarea"), "Friday");
  await click(routingReply(container, rootMessageId));
  const retainedSelect = rowActions.get(rootMessageId).selectReply;
  await click(routingSend(composer));
  const frozen = structuredClone(routingSends(fixture)[0]);
  await switchStyle("current");
  await act(async () => retainedSelect(rootMessageId));
  assert.deepEqual(routingSends(fixture)[0], frozen);
  await switchStyle("discord");
  await act(async () => { mounted.at(-1).root.render(workspace(fixture, { conversationId: directId, components })); await flush(); });
  await act(async () => retainedSelect(rootMessageId));
  assert.equal(fixture.client.selectConversationDraft(directId).draft, undefined);
  await click(routingReply(container, "message-direct"));
  assert.equal(fixture.client.selectConversationDraft(directId).draft.content.replyTo.messageId, "message-direct");
  await act(async () => { resolveSend({ status: "success", value: { operation: "send_message" } }); await flush(); });
  assert.deepEqual(routingSends(fixture), [frozen]);
  assert.equal(frozen.conversationId, publicId);
  assert.deepEqual(frozen.replyTo, { messageId: rootMessageId, notifyAuthor: true });
  assert.equal(fixture.client.selectConversationDraft(directId).draft.content.replyTo.messageId, "message-direct");
  assertNoThreadCommand(fixture);
});

for (const props of [{ readOnly: true }, { composerAvailability: { canSend: false } }]) {
  test(`inline Reply routing respects ThreadPanel restrictions ${JSON.stringify(props)}`, async () => {
    const fixture = createFixture(); const switchStyle = await withReplyRouting(fixture, { style: "current" });
    const container = await mount(workspace(fixture, props));
    await click(routingReply(container, rootMessageId));
    const panel = container.querySelector("[data-handrail-thread-panel]");
    assert.ok(panel);
    await switchStyle("discord");
    fixture.calls.length = 0;
    const reply = routingReply(panel, "message-thread");
    assert.equal(reply.disabled, true);
    assert.match(reply.getAttribute("aria-description"), /read-only|permission/);
    await click(reply);
    assert.equal(fixture.client.selectConversationDraft(threadId).draft, undefined);
    assertNoThreadCommand(fixture);
  });
}

test("inline Reply routing retains a selected source when switching to Current before sending", async () => {
  const fixture = createFixture(); const switchStyle = await withReplyRouting(fixture);
  const container = await mount(workspace(fixture));
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  await input(composer.querySelector("textarea"), "Friday");
  await click(routingReply(container, rootMessageId));
  await switchStyle("current");
  await click(routingSend(composer));
  assert.deepEqual(routingSends(fixture)[0], { conversationId: publicId,
    content: { format: "plain", text: "Friday" }, replyTo: { messageId: rootMessageId, notifyAuthor: true } });
  assertNoThreadCommand(fixture);
  await click(routingReply(container, rootMessageId));
  assert.deepEqual(fixture.calls.filter(call => call.name === "openThread").map(call => call.args), [[rootMessageId]]);
});

test("inline Reply routing can replace the next draft source while a send retains its frozen payload", async () => {
  const rows = [publicRoot, message("next-source", publicId, "What about Monday?", { sequence: 2 })];
  const fixture = createFixture({ messageRows: new Map([...messages, [publicId, rows]]) });
  await withReplyRouting(fixture);
  let resolveSend;
  fixture.client.sendMessage = payload => { fixture.calls.push({ name: "sendMessage", args: [payload] });
    return new Promise(resolve => { resolveSend = resolve; }); };
  const container = await mount(workspace(fixture));
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  await input(composer.querySelector("textarea"), "Friday");
  await click(routingReply(container, rootMessageId));
  await click(routingSend(composer));
  const frozen = structuredClone(routingSends(fixture)[0]);
  await click(routingReply(container, "next-source"));
  assert.equal(fixture.client.selectConversationDraft(publicId).draft.content.replyTo.messageId, "next-source");
  await act(async () => { resolveSend({ status: "success", value: { operation: "send_message" } }); await flush(); });
  assert.deepEqual(routingSends(fixture), [frozen]);
  assert.equal(frozen.replyTo.messageId, rootMessageId);
  assert.equal(fixture.client.selectConversationDraft(publicId).draft.content.replyTo.messageId, "next-source");
  assert.equal(composer.querySelector("textarea").value, "Friday");
  assertNoThreadCommand(fixture);
});


const namedCreate = (container, id = rootMessageId) => container.querySelector(`[data-message-id="${id}"] button[aria-label="Create Thread"]`);
const namedDialog = container => container.querySelector('[role="dialog"][aria-labelledby]');
const namedInput = async (container, value) => {
  const element = namedDialog(container).querySelector("input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    await flush();
  });
};
const namedSubmit = async container => {
  await act(async () => {
    namedDialog(container).querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
};
function namedBoundary(fixture, command = async input => ({ name: input.name, reconciliationStatus: "created" })) {
  let opening = fixture.client.getThreadOpeningState(rootMessageId);
  const getOpening = fixture.client.getThreadOpeningState;
  fixture.client.getThreadOpeningState = id => id === rootMessageId ? opening : getOpening(id);
  fixture.client.createThread = async input => {
    fixture.calls.push({ name: "createThread", args: [input] });
    const result = await command(input);
    if (result.state === "error") return result;
    opening = Object.freeze({ state: "ready", rootMessageId, parentConversationId: publicId,
      threadConversationId: threadId, reconciliationStatus: result.reconciliationStatus });
    fixture.cache.reconcileThreadOpening({ operation: "create_thread", rootMessageId, parentConversationId: publicId,
      idempotencyKey: "named-ui-boundary", name: input.name }, {
      operation: "create_thread", rootMessageId, parentConversationId: publicId,
      reconciliationStatus: result.reconciliationStatus,
      conversation: detail({ ...threadConversation, name: result.name }),
      rootThreadSummary: { threadId, replyCount: 0, participantIds: [], unreadCount: 0 },
    }, timeline(threadId, []));
    return opening;
  };
}
const namedCalls = fixture => fixture.calls.filter(call => call.name === "createThread").map(call => call.args[0]);

test("named thread dialog creates a discussion independently of Reply and preserves its channel draft", async () => {
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture); namedBoundary(fixture);
  const { createThreadListRuntime } = await import("../dist/client/thread-list.js");
  const discovery = createThreadListRuntime({
    cache: fixture.cache, online: () => true,
    reader: { listThreads: async query => ({ status: "success", value: {
      parentConversationId: publicId, view: query.view, evaluatedAt: now, lifecycleSupported: true,
      items: [{ thread: { ...threadConversation, name: "Launch date 🚀" },
        currentThreadFollow: { followRevision: 1, follow: {
          target: { type: "thread", id: threadId }, isFollowing: true, source: "manual", updatedAt: now,
        } }, lastActivityAt: now, hideAt: null }],
    } }) },
  });
  fixture.client.threadList = discovery.api;
  const container = await mount(workspace(fixture));
  const threadNavigation = container.querySelector('[data-conversation-section="threads"]');
  assert.equal(threadNavigation.querySelector('.handrail-chat__conversation-section-count').textContent, "0");
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  await input(composer.querySelector("textarea"), "Friday");
  await click(routingReply(container, rootMessageId));
  const draft = fixture.client.selectConversationDraft(publicId).draft.content;
  const trigger = namedCreate(container); trigger.focus(); await click(trigger);
  assert.equal(document.activeElement, namedDialog(container).querySelector("input"));
  assert.equal(namedDialog(container).getAttribute("aria-modal"), "true");
  assert.equal(container.querySelector(".handrail-chat__detail").hasAttribute("inert"), true);
  await namedInput(container, "Launch date 🚀"); await namedSubmit(container);
  assert.deepEqual(namedCalls(fixture), [{ rootMessageId, name: "Launch date 🚀" }]);
  assert.equal(namedDialog(container), null);
  const panel = container.querySelector("[data-handrail-thread-panel]");
  assert.equal(panel.querySelector("h2").textContent, "Launch date 🚀");
  assert.equal(threadNavigation.querySelector('.handrail-chat__conversation-section-count').textContent, "1");
  assert.equal(threadNavigation.querySelector('.handrail-chat__conversation-section-empty'), null);
  assert.match(threadNavigation.querySelector(`[data-conversation-id="${threadId}"]`).textContent, /Launch date 🚀/);
  assert.match(panel.querySelector(".handrail-chat__thread-parent").textContent, /Public channel/);
  assert.equal(document.activeElement, panel);
  assert.deepEqual(fixture.client.selectConversationDraft(publicId).draft.content, draft);
  assert.equal(composer.querySelector("textarea").value, "Friday");
  await click(panel.querySelector('[aria-label="Close panel"]'));
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  assert.equal(fixture.calls.some(call => /lifecycle|closeThread/.test(call.name)), false);
  await click(container.querySelector('[aria-label="Browse channel threads"]'));
  for (const view of ["Active threads", "All threads"]) {
    await click([...container.querySelectorAll('button')].find(button => button.textContent === view));
    const rows = container.querySelectorAll('[data-thread-id]');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataset.threadId, threadId);
    assert.match(rows[0].textContent, /Launch date 🚀/);
    assert.equal(threadNavigation.querySelector('.handrail-chat__conversation-section-count').textContent, "1");
  }
});

test("named thread dialog validates canonical Unicode names before calling the client", async () => {
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture); namedBoundary(fixture);
  const container = await mount(workspace(fixture)); await click(namedCreate(container));
  for (const name of ["", " ", " padded", "padded\u0085", "a".repeat(101), "\ud800"]) {
    await namedInput(container, name); await namedSubmit(container);
    assert.equal(namedDialog(container).querySelector("input").getAttribute("aria-invalid"), "true");
    assert.match(namedDialog(container).querySelector('[role="alert"]').textContent, /1–100/);
    assert.deepEqual(namedCalls(fixture), []);
  }
  await namedInput(container, "🚀".repeat(100)); await namedSubmit(container);
  assert.equal(namedCalls(fixture)[0].name, "🚀".repeat(100));
});

test("named thread dialog latches duplicate submits and retries the original name into a canonical existing thread", async () => {
  let finish; let count = 0;
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture);
  namedBoundary(fixture, () => ++count === 1 ? new Promise(resolve => { finish = resolve; }) :
    Promise.resolve({ name: "Alice's canonical name", reconciliationStatus: "existing_for_root" }));
  const container = await mount(workspace(fixture)); await click(namedCreate(container));
  await namedInput(container, "Bob's requested name");
  await namedSubmit(container); await namedSubmit(container);
  assert.equal(namedCalls(fixture).length, 1);
  assert.equal(namedDialog(container).querySelector('button[type="submit"]').disabled, true);
  assert.equal(namedDialog(container).querySelector("form").getAttribute("aria-busy"), "true");
  await act(async () => { finish({ state: "error", message: "The thread message snapshot could not be loaded." }); await flush(); });
  assert.match(namedDialog(container).querySelector('[role="alert"]').textContent, /snapshot/);
  assert.equal(namedDialog(container).querySelector("input").readOnly, true);
  // Reopening the shell still uses the original retained input.
  await click(namedDialog(container).querySelector('button[type="button"]'));
  await click(namedCreate(container));
  assert.equal(namedDialog(container).querySelector("input").value, "Bob's requested name");
  assert.equal(namedDialog(container).querySelector('button[type="submit"]').textContent, "Retry");
  await namedSubmit(container);
  assert.deepEqual(namedCalls(fixture), Array(2).fill({ rootMessageId, name: "Bob's requested name" }));
  assert.equal(container.querySelector("[data-handrail-thread-panel] h2").textContent, "Alice's canonical name");
  assert.equal(container.querySelector("[data-thread-opening]").dataset.threadOpening, "existing_for_root");
});

test("named thread dialog cancel and Escape preserve drafts, contain keyboard focus and restore the opener", async () => {
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture); namedBoundary(fixture);
  const container = await mount(workspace(fixture));
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  await input(composer.querySelector("textarea"), "Keep this draft"); await click(routingReply(container, rootMessageId));
  const draft = fixture.client.selectConversationDraft(publicId).draft.content;
  const trigger = namedCreate(container); trigger.focus(); await click(trigger);
  await namedInput(container, "Unsubmitted name");
  const dialog = namedDialog(container), field = dialog.querySelector("input"), cancel = dialog.querySelector('button[type="button"]');
  field.focus(); await keyDown(field, "Tab", { shiftKey: true }); assert.equal(document.activeElement, cancel);
  await keyDown(cancel, "Tab"); assert.equal(document.activeElement, field);
  await keyDown(field, "Escape"); assert.equal(namedDialog(container), null); assert.equal(document.activeElement, trigger);
  await click(trigger); assert.equal(namedDialog(container).querySelector("input").value, "Unsubmitted name");
  await click(namedDialog(container).querySelector('button[type="button"]'));
  assert.deepEqual(fixture.client.selectConversationDraft(publicId).draft.content, draft);
  assert.equal(composer.querySelector("textarea").value, "Keep this draft"); assert.deepEqual(namedCalls(fixture), []);
});

for (const dismissal of ["cancel", "navigate"]) test(`named thread dialog ignores completion after ${dismissal}`, async () => {
  let finish;
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture);
  namedBoundary(fixture, () => new Promise(resolve => { finish = resolve; }));
  const container = await mount(workspace(fixture)); await click(namedCreate(container));
  await namedInput(container, "Launch date"); await namedSubmit(container);
  if (dismissal === "cancel") await keyDown(namedDialog(container).querySelector("input"), "Escape");
  else await act(async () => { mounted.at(-1).root.render(workspace(fixture, { conversationId: directId })); await flush(); });
  await act(async () => { finish({ name: "Launch date", reconciliationStatus: "created" }); await flush(); });
  assert.equal(namedDialog(container), null); assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
});

for (const [label, options, props, reason] of [
  ["unsupported", { namedThreads: false }, {}, /not supported/],
  ["unknown", { namedThreads: null }, {}, /not supported/],
  ["read-only", {}, { readOnly: true }, /read-only/],
  ["restricted", {}, { composerAvailability: { canSend: false } }, /unavailable/],
  ["inactive", {}, { composerAvailability: { membershipState: "removed" } }, /active member/],
]) test(`named thread action disables ${label} creation with an explanation`, async () => {
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture, options);
  const container = await mount(workspace(fixture, props)); const trigger = namedCreate(container);
  assert.equal(trigger.disabled, true); assert.match(trigger.getAttribute("aria-description"), reason);
  await click(trigger); assert.equal(namedDialog(container), null); assertNoThreadCommand(fixture);
});

test("named thread existing Open Thread works without named capability or write access in Discord style", async () => {
  const fixture = createFixture(); await withReplyRouting(fixture, { namedThreads: false });
  fixture.cache.hydrateConversationDetail(detail({ ...threadConversation, name: "Existing launch discussion", updatedAt: "2038-05-07T07:08:09.000Z" }));
  const container = await mount(workspace(fixture, { readOnly: true }));
  const trigger = container.querySelector(`[data-message-id="${rootMessageId}"] button[aria-label="Open Thread"]`);
  assert.equal(trigger.disabled, false); assert.equal(namedCreate(container), null);
  await click(trigger); assert.equal(namedDialog(container), null);
  assert.equal(container.querySelector("[data-handrail-thread-panel] h2").textContent, "Existing launch discussion");
  assert.deepEqual(namedCalls(fixture), []);
});

test("named thread Current Reply preserves the legacy entry and understands canonical names", async () => {
  const fixture = createFixture(); await withReplyRouting(fixture, { style: "current", namedThreads: false });
  fixture.cache.hydrateConversationDetail(detail({ ...threadConversation, name: "Current named discussion", updatedAt: "2038-05-07T07:08:09.000Z" }));
  const container = await mount(workspace(fixture));
  assert.equal(namedCreate(container), null); await click(routingReply(container, rootMessageId));
  assert.equal(container.querySelector("[data-handrail-thread-panel] h2").textContent, "Current named discussion");
  assert.equal(namedDialog(container), null); assert.deepEqual(namedCalls(fixture), []);
  assert.match(container.querySelector(".handrail-chat__timeline-thread").textContent, /Current named discussion/);
});

test("named thread custom renderer gets optional actions and custom thread hosts retain ownership", async () => {
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture);
  let retained;
  const container = await mount(workspace(fixture, { components: { Message: props => {
    if (props.message.id === rootMessageId) retained = props.actions;
    return createElement("div", props.hostProps, props.message.content?.text);
  } } }));
  assert.equal(typeof retained.requestThreadCreation, "function");
  await act(async () => { retained.requestThreadCreation(rootMessageId); await flush(); });
  assert.notEqual(namedDialog(container), null);
  await keyDown(namedDialog(container).querySelector("input"), "Escape");
  const old = retained;
  await act(async () => { mounted.at(-1).root.render(workspace(fixture, { renderThread: () => createElement("div", null, "Host thread") })); await flush(); });
  await act(async () => { old.requestThreadCreation(rootMessageId); await flush(); });
  assert.equal(namedDialog(container), null); assert.equal(namedCreate(container), null);
});

test("named thread dialog uses the constrained workspace shell at a narrow viewport", async () => {
  const previousWidth = window.innerWidth; window.innerWidth = 320;
  try {
    const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture); namedBoundary(fixture);
    const container = await mount(workspace(fixture)); await click(namedCreate(container));
    assert.equal(namedDialog(container).classList.contains("handrail-chat__channel-creation-dialog"), true);
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");
    assert.match(css, /channel-creation-dialog,[\s\S]*?inline-size: min\(28rem, 100%\)/);
    assert.match(css, /thread-header h2 \{[^}]*overflow-wrap: anywhere/);
    assert.match(css, /timeline-thread \{[^}]*overflow-wrap: anywhere;[^}]*max-inline-size: 100%/);
    await namedInput(container, "🚀".repeat(100)); await namedSubmit(container);
    assert.notEqual(container.querySelector('[aria-label="Close thread"]'), null);
  } finally { window.innerWidth = previousWidth; }
});


test("named thread dialog retains a failed service attempt and preserves draft through capability loss", async () => {
  const fixture = createFixture({ replyActionStates: true }); await withReplyRouting(fixture);
  namedBoundary(fixture, async () => { throw new Error("private transport details"); });
  const container = await mount(workspace(fixture));
  const composer = container.querySelector('[aria-label="Conversation composer"]');
  await input(composer.querySelector("textarea"), "Keep on failure"); await click(routingReply(container, rootMessageId));
  const draft = fixture.client.selectConversationDraft(publicId).draft.content;
  await click(namedCreate(container)); await namedInput(container, "Launch date"); await namedSubmit(container);
  assert.match(namedDialog(container).querySelector('[role="alert"]').textContent, /could not be reached/);
  assert.doesNotMatch(container.textContent, /private transport/);
  await act(async () => { mounted.at(-1).root.render(workspace(fixture, { readOnly: true })); await flush(); });
  assert.equal(namedDialog(container).querySelector('button[type="submit"]').disabled, true);
  await namedSubmit(container); assert.equal(namedCalls(fixture).length, 1);
  assert.deepEqual(fixture.client.selectConversationDraft(publicId).draft.content, draft);
});

test("named thread creation excludes deleted and unsent roots, and is independent of inline and preference support", async () => {
  const fixture = createFixture({ replyActionStates: true });
  await withReplyRouting(fixture, { inlineReplies: false, persistence: false }); namedBoundary(fixture);
  const container = await mount(workspace(fixture));
  for (const id of ["message-deleted", "message-sending", "message-failed"]) assert.equal(namedCreate(container, id), null);
  assert.equal(namedCreate(container).disabled, false);
  await click(namedCreate(container)); await namedInput(container, "Independent discussion"); await namedSubmit(container);
  const panel = container.querySelector("[data-handrail-thread-panel]");
  assert.equal(panel.querySelector('[aria-label="Create Thread"]'), null);
});


for (const style of ['default', 'current']) {
  test(`inline Reply routing: ${style} directly selected thread focuses its existing composer without nested creation`, async () => {
    const fixture = createFixture();
    if (style === 'current') await withReplyRouting(fixture, { style, inlineReplies: false });
    const container = await mount(workspace(fixture, { conversationId: threadId }));
    const composer = container.querySelector('[aria-label="Conversation composer"]');
    const textarea = composer.querySelector('textarea');
    const editor = composer.querySelector('[role="textbox"]') ?? textarea;
    assert.ok(editor && !editor.hidden, 'Thread composer must expose a visible editor');
    await input(textarea, 'Keep this directly selected thread draft');
    const before = structuredClone(fixture.cache.getState().currentUser.readStates);
    const reply = routingReply(container, 'message-thread');
    assert.equal(reply.disabled, false);
    reply.focus();
    await click(reply);
    assert.ok(document.activeElement === editor, 'Current Reply should focus the selected thread composer');
    assert.equal(textarea.value, 'Keep this directly selected thread draft');
    assert.equal(fixture.client.selectConversationDraft(threadId).draft.content.replyTo, undefined);
    assert.deepEqual(fixture.cache.getState().currentUser.readStates, before);
    assert.equal(container.querySelector('[data-handrail-thread-panel]'), null);
    await click(routingSend(composer));
    assert.deepEqual(routingSends(fixture), [{ conversationId: threadId,
      content: { format: 'plain', text: 'Keep this directly selected thread draft' } }]);
    assertNoThreadCommand(fixture);
  });
}

test('inline Reply routing: Current directly selected thread requires a connected composer', async () => {
  const fixture = createFixture();
  await withReplyRouting(fixture, { style: 'current', inlineReplies: false });
  const container = await mount(workspace(fixture, { conversationId: threadId, renderComposer: () => null }));
  const reply = routingReply(container, 'message-thread');
  assert.equal(reply.disabled, true);
  assert.match(reply.getAttribute('aria-description'), /composer is unavailable/);
  await click(reply);
  assertNoThreadCommand(fixture);
  assert.deepEqual(routingSends(fixture), []);
});
