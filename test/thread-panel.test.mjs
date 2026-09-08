import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { Window } from "happy-dom";

process.env.NODE_ENV = "test";
const React = await import("react");
const { act, createElement, useRef, useState } = React;
const { createRoot } = await import("react-dom/client");
const { CHAT_PROTOCOL_VERSION } = await import("@handrail/chat");
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
} = await import("@handrail/chat/client");
const { ChatContext } = await import("@handrail/chat/react");
const { createThreadLifecycleRuntime } = await import("../dist/client/thread-lifecycle.js");
const { createReplyStyleRuntime } = await import("../dist/client/reply-style-runtime.js");
const { MessageTimeline, ThreadPanel } = await import("@handrail/chat/ui");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const window = new Window({ url: "https://thread-panel.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  FocusEvent: window.FocusEvent,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  window,
});

const tenantId = "tenant-thread-panel";
const userId = "user-thread-panel";
const otherUserId = "user-thread-panel-other";
const parentId = "conversation-parent";
const threadId = "conversation-thread";
const rootMessageId = "message-root";
const now = "2037-04-05T06:07:08.000Z";
const metadata = Object.freeze({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
  feature: { name: "conversation_snapshots", version: 1 },
});

const member = (conversationId) => ({
  tenantId,
  conversationId,
  userId,
  role: "member",
  state: "active",
  joinedAt: now,
  updatedAt: now,
});
const readState = (conversationId, lastReadSequence) => ({
  conversationId,
  userId,
  lastReadSequence,
  updatedAt: now,
});
const preference = (conversationId) => ({
  conversationId,
  userId,
  notificationPreference: "all",
  mute: { muted: false },
  updatedAt: now,
});
const parentConversation = Object.freeze({
  id: parentId,
  tenantId,
  type: "channel",
  name: "Parent channel",
  visibility: "public",
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 12,
  currentMember: member(parentId),
  currentReadState: readState(parentId, 12),
  currentPreference: preference(parentId),
});
const threadConversation = Object.freeze({
  id: threadId,
  tenantId,
  type: "thread",
  visibility: "private",
  parentConversationId: parentId,
  rootMessageId,
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 2,
  currentMember: member(threadId),
  currentReadState: readState(threadId, 0),
  currentPreference: preference(threadId),
});
const summary = Object.freeze({
  threadId,
  replyCount: 2,
  participantIds: [otherUserId],
  unreadCount: 2,
  lastReplyAt: now,
});
const message = (id, conversationId, sequence, text, overrides = {}) => ({
  id,
  tenantId,
  conversationId,
  author: { type: "user", userId: otherUserId },
  sequence,
  createdAt: new Date(Date.parse(now) + sequence * 60_000).toISOString(),
  updatedAt: new Date(Date.parse(now) + sequence * 60_000).toISOString(),
  revision: { revision: 1 },
  content: { format: "plain", text },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
  ...overrides,
});
const rootMessage = (withThread = true) => message(
  rootMessageId,
  parentId,
  11,
  "Immutable parent root",
  withThread
    ? { isThreadRoot: true, revision: { revision: 2 }, threadSummary: summary }
    : {},
);
const parentOnlyMessage = message("parent-only", parentId, 12, "Parent timeline only");
const reply = (sequence, overrides = {}) => message(
  `thread-reply-${sequence}`,
  threadId,
  sequence,
  `Thread reply ${sequence}`,
  overrides,
);
const timeline = (conversationId, messages, olderAvailable = false) => ({
  conversationId,
  messages,
  pagination: {
    older: olderAvailable
      ? { available: true, cursor: messages[0]?.sequence ?? 1 }
      : { available: false },
    newer: { available: false },
  },
  replay: { resumeFrom: { eventId: `${conversationId}-${messages[0]?.sequence ?? "empty"}` } },
});
const detail = (conversation) => ({
  kind: "conversation_detail",
  conversation: {
    ...conversation,
    memberUserIds: [userId, otherUserId],
    currentPreference: {
      conversationId: conversation.id,
      userId,
      notificationPreference: "all",
      mute: { muted: false },
      updatedAt: now,
    },
  },
  _meta: metadata,
});

const seedResolvedCache = ({
  withThread = true,
  following = false,
  olderAvailable = true,
  replyOverrides = {},
} = {}) => {
  const cache = createNormalizedChatCache({ tenantId, userId, sessionId: "thread-panel-session" });
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: withThread ? [parentConversation, threadConversation] : [parentConversation],
    page: {},
    _meta: metadata,
  });
  cache.hydrateConversationDetail(detail(parentConversation));
  if (withThread) cache.hydrateConversationDetail(detail(threadConversation));
  cache.hydrateMessageTimeline(timeline(parentId, [rootMessage(withThread), parentOnlyMessage]));
  if (withThread) cache.hydrateMessageTimeline(timeline(threadId, [reply(2, replyOverrides)], olderAvailable));

  if (following) {
    const state = structuredClone(cache.getState());
    state.currentUser.threadFollows = {
      [threadId]: {
        target: { type: "thread", id: threadId },
        isFollowing: true,
        source: "manual",
        updatedAt: now,
      },
    };
    state.currentUser.threadFollowRevisions = { [threadId]: 1 };
    assert.equal(cache.hydrateCanonicalState(state), true);
  }
  return cache;
};

const createFixture = ({
  cache = seedResolvedCache(),
  openingState = {
    state: "ready",
    rootMessageId,
    parentConversationId: parentId,
    threadConversationId: threadId,
    reconciliationStatus: "existing_for_root",
  },
  openingMode = "existing_for_root",
  olderPage = timeline(threadId, [reply(1)]),
} = {}) => {
  const calls = [];
  const openingListeners = new Set();
  const draftListeners = new Set();
  let opening = Object.freeze(openingState);
  const draft = Object.freeze({
    conversationId: threadId,
    status: "ready",
    authoritativeRevision: 0,
    dirty: false,
  });
  const setOpening = (next) => {
    const previous = opening;
    opening = Object.freeze(next);
    for (const listener of openingListeners) listener(opening, previous);
  };
  const hydrateNewThread = () => {
    cache.hydrateConversationList({
      kind: "conversation_list",
      scope: { type: "organization" },
      items: [parentConversation, threadConversation],
      page: {},
      _meta: metadata,
    });
    cache.hydrateConversationDetail(detail(threadConversation));
    cache.hydrateMessageTimeline(timeline(parentId, [rootMessage(true), parentOnlyMessage]));
    cache.hydrateMessageTimeline(timeline(threadId, [], false));
  };
  const success = (name) => Promise.resolve({ status: "success", value: { operation: name } });
  const client = {
    endpoint: "/chat",
    state: { state: "ready" },
    cache,
    getThreadOpeningState: () => opening,
    subscribeThreadOpening(_id, listener) {
      openingListeners.add(listener);
      return () => openingListeners.delete(listener);
    },
    async openThread(id) {
      calls.push({ name: "openThread", args: [id] });
      if (openingMode === "loading") return opening;
      setOpening({ state: "loading", rootMessageId, parentConversationId: parentId });
      if (cache.getState().entities.conversations[threadId] === undefined) hydrateNewThread();
      const ready = {
        state: "ready",
        rootMessageId,
        parentConversationId: parentId,
        threadConversationId: threadId,
        reconciliationStatus: openingMode,
      };
      setOpening(ready);
      return ready;
    },
    selectDirectoryUser: (id) => ({
      kind: "active",
      userId: id,
      displayName: id === otherUserId ? "Other User" : "Current User",
      avatar: { kind: "initials", initials: id === otherUserId ? "OU" : "CU" },
    }),
    hydrateDirectoryUsers: async () => ({ status: "success" }),
    getConversation: async () => ({ status: "transport", error: new Error("unavailable") }),
    async getMessageTimeline(input) {
      calls.push({ name: "getMessageTimeline", args: [input] });
      if (input.conversationId === threadId && input.cursor !== undefined) {
        cache.hydrateMessageTimeline(olderPage);
      }
      return { status: "success" };
    },
    selectConversationDraft: () => draft,
    subscribeConversationDraft(_id, listener) {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    openConversationDraft: async () => draft,
    replaceConversationDraft: () => draft,
    clearConversationDraft: () => draft,
    flushConversationDraft: async () => ({ status: "success", state: draft }),
    retryConversationDraft: async () => ({ status: "success", state: draft }),
    closeConversationDraft: async () => ({ status: "success", state: draft }),
    startTyping: () => true,
    stopTyping: () => undefined,
    followThread(id) {
      calls.push({ name: "followThread", args: [id] });
      return success("follow_thread");
    },
    unfollowThread(id) {
      calls.push({ name: "unfollowThread", args: [id] });
      return success("unfollow_thread");
    },
    markRead(input) {
      calls.push({ name: "markRead", args: [input] });
      return success("mark_read");
    },
    setReaction(input) {
      calls.push({ name: "setReaction", args: [input] });
      return success("set_reaction");
    },
  };
  const context = {
    client,
    state: client.state,
    readiness: "ready",
    isReady: true,
    refreshRequired: null,
    error: null,
  };
  return { cache, calls, client, context, setOpening };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
const mounted = [];
const renderPanel = async (fixture, props = {}) => {
  const container = document.createElement("div");
  container.className = "handrail-chat";
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(createElement(
      ChatContext.Provider,
      { value: fixture.context },
      createElement(ThreadPanel, { rootMessageId, ...props }),
    ));
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
const keyDown = async (element, key) => {
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key }));
    await flush();
  });
};
const renderThreadHarness = async (fixture) => {
  const container = document.createElement("div");
  container.className = "handrail-chat";
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  const closeCalls = [];
  let setTimelineVisible;

  function Harness() {
    const [openRootMessageId, setOpenRootMessageId] = useState();
    const [timelineVisible, setVisible] = useState(true);
    const returnFocusRef = useRef(null);
    setTimelineVisible = setVisible;

    return createElement(
      React.Fragment,
      null,
      timelineVisible
        ? createElement(MessageTimeline, {
            conversationId: parentId,
            onOpenThread: (id, returnFocusTarget) => {
              returnFocusRef.current = returnFocusTarget;
              setOpenRootMessageId(id);
            },
          })
        : null,
      openRootMessageId === undefined
        ? null
        : createElement(ThreadPanel, {
            onClose: () => {
              closeCalls.push("close");
              setOpenRootMessageId(undefined);
            },
            returnFocusRef,
            rootMessageId: openRootMessageId,
          }),
    );
  }

  await act(async () => {
    root.render(createElement(ChatContext.Provider, { value: fixture.context }, createElement(Harness)));
    await flush();
  });

  return {
    closeCalls,
    container,
    removeTimeline: async () => {
      await act(async () => {
        setTimelineVisible(false);
        await flush();
      });
    },
  };
};

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  document.body.replaceChildren();
});

test("opens a new canonical thread and composes its isolated timeline and composer", async () => {
  const fixture = createFixture({
    cache: seedResolvedCache({ withThread: false }),
    openingState: { state: "idle", rootMessageId },
    openingMode: "created",
  });
  const container = await renderPanel(fixture);

  assert.deepEqual(fixture.calls.filter(({ name }) => name === "openThread").map(({ args }) => args), [[rootMessageId]]);
  assert.equal(container.querySelector("[data-thread-conversation-id]").dataset.threadConversationId, threadId);
  assert.equal(container.querySelector("[data-thread-opening]").dataset.threadOpening, "created");
  assert.equal(container.querySelector('[aria-label="Thread replies"]') !== null, true);
  assert.equal(container.querySelector('textarea[aria-label="Reply to thread"]') !== null, true);
});

test("shows immutable parent context and keeps parent messages out of an existing thread", async () => {
  const fixture = createFixture();
  const container = await renderPanel(fixture);
  const root = container.querySelector('[aria-label="Thread root message"]');

  assert.equal(fixture.calls.some(({ name }) => name === "openThread"), false);
  assert.equal(root.getAttribute("aria-readonly"), "true");
  assert.equal(root.dataset.parentConversationId, parentId);
  assert.equal(root.dataset.rootMessageId, rootMessageId);
  assert.match(root.textContent, /Other User/);
  assert.match(root.textContent, /Immutable parent root/);
  assert.equal(root.querySelector(".handrail-chat__thread-parent").textContent, "In Parent channel");
  assert.equal(container.querySelector(".handrail-chat__thread-header h2").textContent, "Thread");
  assert.equal(root.querySelector("button"), null);
  assert.match(container.textContent, /Thread reply 2/);
  assert.equal(container.textContent.includes("Parent timeline only"), false);
  assert.match(container.textContent, /2 replies/);
  assert.match(container.textContent, /2 unread/);
});

test("forwards normalized link-preview overrides through the thread timeline", async () => {
  const fixture = createFixture({
    cache: seedResolvedCache({
      replyOverrides: {
        content: {
          format: "plain",
          text: "Thread link preview",
          blocks: [{
            type: "link_preview",
            data: {
              url: " https://example.test/thread ",
              title: " Thread docs ",
              description: " Read this in the thread ",
              provider: "private-provider",
            },
          }],
        },
      },
    }),
  });
  const seen = [];
  const container = await renderPanel(fixture, {
    timelineSlots: {
      LinkPreview: (props) => {
        seen.push(props);
        return createElement(
          "article",
          { ...props.hostProps, "data-thread-link-preview": props.linkPreview.url },
          props.linkPreview.title,
        );
      },
    },
  });

  assert.equal(container.querySelector("[data-thread-link-preview]").dataset.threadLinkPreview, "https://example.test/thread");
  assert.deepEqual(seen[0].linkPreview, {
    url: "https://example.test/thread",
    title: "Thread docs",
    description: "Read this in the thread",
  });
  assert.equal(Object.isFrozen(seen[0].linkPreview), true);
  assert.equal("provider" in seen[0].linkPreview, false);
  assert.equal(seen[0].hostProps["aria-label"], "Link preview for Thread docs");
});

test("opens the reaction picker for replies without rendering empty configured aggregates", async () => {
  const cache = seedResolvedCache({
    replyOverrides: {
      reactions: [{
        reactionKey: "custom:party-parrot",
        count: 4,
        reactedByCurrentUser: true,
      }],
    },
  });
  const fixture = createFixture({ cache });
  const container = await renderPanel(fixture, {
    reactionKeys: ["shipit", "shipit", "eyes"],
  });
  const replyRow = container.querySelector('[data-message-id="thread-reply-2"]');

  assert.equal(replyRow.querySelectorAll(".handrail-chat__timeline-reaction").length, 1);
  assert.equal(replyRow.querySelector('[aria-label="Add shipit reaction"]'), null);
  assert.equal(replyRow.querySelector('[aria-label="Add eyes reaction"]'), null);
  const unknownAggregate = replyRow.querySelector(
    '[aria-label="Remove custom:party-parrot reaction"]',
  );
  assert.notEqual(unknownAggregate, null);
  assert.match(unknownAggregate.textContent, /4/u);
  const pickerTriggers = replyRow.querySelectorAll('button[aria-label="Add reaction"]');
  assert.equal(pickerTriggers.length, 1);

  await click(pickerTriggers[0]);
  await click(replyRow.querySelector('button[data-reaction-key="🚀"]'));
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "setReaction"), [{
    name: "setReaction",
    args: [{
      messageId: "thread-reply-2",
      reactionKey: "🚀",
      reacted: true,
    }],
  }]);

  await click(unknownAggregate);
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "setReaction")[1], {
    name: "setReaction",
    args: [{
      messageId: "thread-reply-2",
      reactionKey: "custom:party-parrot",
      reacted: false,
    }],
  });
});

test("paginates only the thread and exposes its unread, follow, unfollow, and mark-read actions", async () => {
  const fixture = createFixture({ cache: seedResolvedCache({ following: true }) });
  const container = await renderPanel(fixture);
  const loadOlder = container.querySelector(".handrail-chat__timeline-load-older");
  await click(loadOlder);

  assert.match(container.textContent, /Thread reply 1/);
  const pageCall = fixture.calls.find(({ name }) => name === "getMessageTimeline");
  assert.equal(pageCall.args[0].conversationId, threadId);
  assert.equal(pageCall.args[0].cursor, 2);

  const unfollow = [...container.querySelectorAll("button")].find((button) => button.textContent === "Unfollow");
  await click(unfollow);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "unfollowThread").args, [threadId]);

  const markRead = [...container.querySelectorAll("button")].find((button) => button.textContent === "Mark read");
  await click(markRead);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "markRead").args, [{
    conversationId: threadId,
    throughSequence: 2,
  }]);

  const followFixture = createFixture();
  const followContainer = await renderPanel(followFixture);
  const follow = [...followContainer.querySelectorAll("button")].find((button) => button.textContent === "Follow");
  await click(follow);
  assert.deepEqual(followFixture.calls.find(({ name }) => name === "followThread").args, [threadId]);
});

test("renders accessible loading and retryable error states and retries through the public action", async () => {
  const loadingFixture = createFixture({
    cache: seedResolvedCache({ withThread: false }),
    openingState: { state: "loading", rootMessageId, parentConversationId: parentId },
    openingMode: "loading",
  });
  const loadingContainer = await renderPanel(loadingFixture);
  assert.match(loadingContainer.querySelector('[aria-busy="true"]').textContent, /Opening thread/);

  const errorFixture = createFixture({
    openingState: {
      state: "error",
      rootMessageId,
      parentConversationId: parentId,
      code: "snapshot_failed",
      message: "Thread snapshot is temporarily unavailable.",
      httpStatus: 503,
    },
  });
  const errorContainer = await renderPanel(errorFixture);
  assert.match(errorContainer.querySelector('[role="alert"]').textContent, /temporarily unavailable/);
  await click([...errorContainer.querySelectorAll("button")].find((button) => button.textContent === "Retry"));
  assert.deepEqual(errorFixture.calls.find(({ name }) => name === "openThread").args, [rootMessageId]);
});

test("renders an unavailable state outside ChatProvider without touching private context", async () => {
  const container = document.createElement("div");
  container.className = "handrail-chat";
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(createElement(ThreadPanel, { rootMessageId }));
    await flush();
  });

  assert.match(container.querySelector('[role="alert"]').textContent, /inside ChatProvider/);
  assert.equal(container.querySelector("button"), null);
});

test("moves focus from Reply into the named panel once and preserves it through live replies", async () => {
  const fixture = createFixture();
  const { container } = await renderThreadHarness(fixture);
  const replyButton = container.querySelector(`[data-message-id="${rootMessageId}"] [aria-label="Reply"]`);
  let panelFocusCount = 0;
  container.addEventListener("focusin", (event) => {
    if (event.target?.matches?.("[data-handrail-thread-panel]")) panelFocusCount += 1;
  });

  const focusReply = replyButton.focus.bind(replyButton);
  let replyFocusCalls = 0;
  replyButton.focus = (...args) => {
    replyFocusCalls += 1;
    return focusReply(...args);
  };
  replyButton.focus();
  replyFocusCalls = 0;
  await click(replyButton);

  const panel = container.querySelector('[aria-label="Thread"][data-handrail-thread-panel]');
  assert.equal(document.activeElement, panel);
  assert.equal(panel.tabIndex, -1);
  assert.equal(panelFocusCount, 1);
  assert.equal(replyFocusCalls, 0, "opening must not asynchronously refocus the Reply control");

  const composer = container.querySelector('textarea[aria-label="Reply to thread"]');
  composer.focus();
  await act(async () => {
    fixture.cache.hydrateMessageTimeline(timeline(threadId, [reply(3)]));
    await flush();
  });

  assert.match(container.textContent, /Thread reply 3/);
  assert.equal(document.activeElement, composer);
  assert.equal(panelFocusCount, 1);
});

test("closes by Escape and Close while restoring the connected Reply opener", async () => {
  const fixture = createFixture();
  const { closeCalls, container } = await renderThreadHarness(fixture);
  const findReplyButton = () => container.querySelector(`[data-message-id="${rootMessageId}"] [aria-label="Reply"]`);

  findReplyButton().focus();
  await click(findReplyButton());
  await keyDown(container.querySelector("[data-handrail-thread-panel]"), "Escape");

  assert.deepEqual(closeCalls, ["close"]);
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  assert.equal(document.activeElement, findReplyButton());

  findReplyButton().focus();
  await click(findReplyButton());
  const closeButton = container.querySelector('button[aria-label="Close panel"]');
  const closeIcon = closeButton?.querySelector("svg.handrail-chat__thread-close-icon");
  assert.ok(closeButton, "Close panel remains discoverable by accessible name");
  assert.ok(closeIcon, "Close panel contains an SVG icon");
  assert.equal(closeIcon.getAttribute("aria-hidden"), "true");
  assert.equal(closeIcon.getAttribute("focusable"), "false");
  assert.doesNotMatch(closeButton.textContent, /×/u);
  await click(closeButton);

  assert.deepEqual(closeCalls, ["close", "close"]);
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  assert.equal(document.activeElement, findReplyButton());
});

test("does not try to restore a Reply opener that was removed", async () => {
  const fixture = createFixture();
  const { closeCalls, container, removeTimeline } = await renderThreadHarness(fixture);
  const replyButton = container.querySelector(`[data-message-id="${rootMessageId}"] [aria-label="Reply"]`);

  replyButton.focus();
  await click(replyButton);
  assert.equal(document.activeElement, container.querySelector("[data-handrail-thread-panel]"));

  await removeTimeline();
  assert.equal(replyButton.isConnected, false);
  await click(container.querySelector('[aria-label="Close panel"]'));

  assert.deepEqual(closeCalls, ["close"]);
  assert.equal(container.querySelector("[data-handrail-thread-panel]"), null);
  assert.notEqual(document.activeElement, replyButton);
});


test("a conflicting follow result announces reconciliation rather than an unapplied change", async () => {
  const fixture = createFixture({ cache: seedResolvedCache({ following: true }) });
  fixture.client.unfollowThread = async () => ({
    status: "success",
    value: { reconciliationStatus: "follow_revision_conflict", follow: { isFollowing: true } },
  });
  const container = await renderPanel(fixture);
  await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Unfollow"));
  assert.match(container.textContent, /follow state changed elsewhere/);
  assert.doesNotMatch(container.textContent, /Thread unfollowed\./);
});

for (const initiallyFollowing of [true, false]) {
  test(`${initiallyFollowing ? "unfollow" : "follow"} conflict is announced in the live region and can retry with refreshed authority`, async () => {
    const fixture = createFixture({ cache: seedResolvedCache({ following: initiallyFollowing }) });
    const requests = [];
    const action = initiallyFollowing ? "unfollowThread" : "followThread";
    const label = initiallyFollowing ? "Unfollow" : "Follow";
    fixture.client[action] = async () => {
      const input = {
        operation: "set_thread_follow",
        intent: initiallyFollowing ? "unfollow" : "follow",
        target: { type: "thread", id: threadId },
        expectedFollowRevision: fixture.cache.getState().currentUser.threadFollowRevisions[threadId] ?? 0,
        idempotencyKey: `panel-follow-${requests.length}`,
      };
      requests.push(input);
      fixture.cache.beginOptimisticThreadFollow(input, now);
      const conflict = requests.length === 1;
      const value = {
        ...input,
        reconciliationStatus: conflict ? "follow_revision_conflict" : "applied",
        followRevision: conflict ? 2 : 3,
        follow: {
          target: input.target,
          isFollowing: conflict ? initiallyFollowing : !initiallyFollowing,
          source: "manual",
          updatedAt: now,
        },
      };
      fixture.cache.reconcileCurrentUserThreadFollow(input, value);
      return { status: "success", value };
    };
    const container = await renderPanel(fixture);
    const button = () => [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
    const status = () => container.querySelector('.handrail-chat__thread-conversation > [role="status"][aria-live="polite"]');
    await click(button());
    assert.match(status().textContent, /follow state changed elsewhere/);
    assert.match(status().textContent, new RegExp(`Select ${label} to try again`));
    assert.doesNotMatch(status().textContent, /Thread (unfollowed|followed)\./);
    assert.equal(status().getAttribute("aria-atomic"), "true");
    assert.equal(button().disabled, false);
    assert.equal(fixture.cache.getState().currentUser.threadFollowRevisions[threadId], 2);
    await click(button());
    assert.equal(requests[1].expectedFollowRevision, 2);
    assert.equal(status().textContent, initiallyFollowing ? "Thread unfollowed." : "Thread followed.");
    assert.ok([...container.querySelectorAll("button")].some((entry) => entry.textContent === (initiallyFollowing ? "Follow" : "Unfollow")));
  });
}

for (const reconciliationStatus of ["applied", "replayed", "already_requested_state", "follow_revision_conflict"]) {
  for (const isFollowing of [true, false]) {
    test(`unfollow announcement checks authority for ${reconciliationStatus}, isFollowing=${isFollowing}`, async () => {
      const fixture = createFixture({ cache: seedResolvedCache({ following: true }) });
      fixture.client.unfollowThread = async () => ({
        status: "success",
        value: { reconciliationStatus, follow: { isFollowing } },
      });
      const container = await renderPanel(fixture);
      await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Unfollow"));
      const status = container.querySelector('.handrail-chat__thread-conversation > [role="status"][aria-live="polite"]');
      if (isFollowing) assert.doesNotMatch(status.textContent, /Thread unfollowed\./);
      else assert.equal(status.textContent, "Thread unfollowed.");
    });
  }
}

for (const initiallyFollowing of [false, true]) {
  test(`offline ${initiallyFollowing ? "Unfollow" : "Follow"} announces retry, preserves authority, and recovers without login`, async () => {
    const { createChatClient } = await import("@handrail/chat/client");
    const fixture = createFixture({ cache: seedResolvedCache({ following: initiallyFollowing }) });
    let offline = true;
    const requests = [];
    const client = createChatClient({
      endpoint: "/chat",
      cache: fixture.cache,
      getAccessToken: async () => {
        if (offline) throw new TypeError("Failed to fetch");
        return "same-session-token";
      },
      fetch: async (_url, init) => {
        requests.push(init);
        assert.equal(init.method, "PATCH");
        const input = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...input,
            reconciliationStatus: "applied",
            followRevision: input.expectedFollowRevision + 1,
            follow: {
              target: input.target,
              isFollowing: input.intent === "follow",
              source: "manual",
              updatedAt: now,
            },
          }),
        };
      },
    });
    fixture.client.followThread = (id) => client.followThread(id);
    fixture.client.unfollowThread = (id) => client.unfollowThread(id);
    const authority = () => ({
      follow: fixture.cache.getState().currentUser.threadFollows[threadId],
      revision: fixture.cache.getState().currentUser.threadFollowRevisions[threadId],
    });
    const before = structuredClone(authority());
    try {
      const container = await renderPanel(fixture);
      const label = initiallyFollowing ? "Unfollow" : "Follow";
      const button = () => [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
      const status = () => container.querySelector('.handrail-chat__thread-conversation > [role="status"][aria-live="polite"]');
      await click(button());
      assert.match(status().textContent, /Check your connection and try again/);
      assert.doesNotMatch(status().textContent, /authentication/i);
      assert.deepEqual(authority(), before);
      assert.equal(requests.length, 0);
      assert.equal(fixture.cache.getState().currentUser.pendingThreadFollowUpdates[threadId], undefined);
      assert.equal(button().disabled, false);
      offline = false;
      await click(button());
      assert.equal(requests.length, 1);
      assert.equal(requests[0].headers.authorization, "Bearer same-session-token");
      assert.equal(status().textContent, initiallyFollowing ? "Thread unfollowed." : "Thread followed.");
      assert.equal(authority().follow.isFollowing, !initiallyFollowing);
      assert.equal(authority().revision, (before.revision ?? 0) + 1);
    } finally {
      client.close();
    }
  });
}

for (const evictRoot of [false, true]) {
  for (const beforeMount of [true, false]) {
    test(`recovers missing ${evictRoot ? "root and thread" : "thread"} after canonical hydration ${beforeMount ? "before mount" : "while mounted"}`, async () => {
      const fixture = createFixture({ cache: seedResolvedCache({ following: true }) });
      const canonical = structuredClone(fixture.cache.getState());
      const siblingCache = seedResolvedCache({ withThread: false });
      siblingCache.hydrateMessageTimeline(timeline(parentId, [rootMessage(true), parentOnlyMessage]));
      const sibling = structuredClone(siblingCache.getState());
      if (evictRoot) {
        delete sibling.entities.messages[rootMessageId];
        delete sibling.timelines[parentId];
      }
      const originalOpen = fixture.client.openThread;
      fixture.client.openThread = async (id) => {
        const result = await originalOpen(id);
        fixture.cache.hydrateCanonicalState(canonical);
        return result;
      };
      let container;
      if (!beforeMount) container = await renderPanel(fixture);
      await act(async () => {
        assert.equal(fixture.cache.hydrateCanonicalState(sibling), true);
        await flush();
      });
      if (beforeMount) container = await renderPanel(fixture);
      assert.equal(fixture.calls.filter(({ name }) => name === "openThread").length, 1);
      assert.match(container.textContent, /Thread reply 2/);
      assert.ok(container.querySelector('textarea[aria-label="Reply to thread"]'));
      assert.match(container.textContent, /Unfollow/);
      assert.doesNotMatch(container.textContent, /Preparing thread/);
    });
  }
}

for (const code of ["snapshot_failed", "root_message_unavailable"]) {
  test(`failed ${code} hydration recovery stops at a visible Retry and recovers on request`, async () => {
    const fixture = createFixture();
    const container = await renderPanel(fixture);
    const originalOpen = fixture.client.openThread;
    let attempts = 0;
    fixture.client.openThread = async () => {
      attempts += 1;
      fixture.setOpening({ state: "error", rootMessageId, code, message: "Thread recovery failed." });
    };
    const sibling = structuredClone(seedResolvedCache({ withThread: false }).getState());
    delete sibling.entities.messages[rootMessageId];
    delete sibling.timelines[parentId];
    await act(async () => {
      fixture.cache.hydrateCanonicalState(sibling);
      await flush();
    });
    assert.equal(attempts, 1);
    assert.match(container.textContent, /Thread recovery failed/);
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    assert.ok(retry);
    await act(async () => {
      fixture.cache.hydrateCanonicalState(sibling);
      await flush();
    });
    assert.equal(attempts, 1, "cache updates must not automatically retry failed recovery");
    fixture.client.openThread = originalOpen;
    await act(async () => { retry.click(); await flush(); });
    assert.ok(container.querySelector('textarea[aria-label="Reply to thread"]'));
    assert.doesNotMatch(container.textContent, /Preparing thread|Thread recovery failed/);
  });
}

test("canonical root restoration releases an earlier root-unavailable panel", async () => {
  const fixture = createFixture();
  const canonical = structuredClone(fixture.cache.getState());
  const missing = structuredClone(canonical);
  delete missing.entities.messages[rootMessageId];
  delete missing.entities.conversations[threadId];
  delete missing.timelines[parentId];
  fixture.cache.hydrateCanonicalState(missing);
  fixture.setOpening({ state: "error", rootMessageId, code: "root_message_unavailable", message: "Root unavailable." });
  const container = await renderPanel(fixture);
  assert.match(container.textContent, /Retry/);
  await act(async () => {
    fixture.cache.hydrateCanonicalState(canonical);
    await flush();
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "openThread").length, 1);
  assert.ok(container.querySelector('textarea[aria-label="Reply to thread"]'));
  assert.doesNotMatch(container.textContent, /Root unavailable/);
});

// Real public lifecycle runtime; only snapshot/command transport boundaries are stubbed.
const openLifecycle = (revision = 1) => ({ revision, locked: false });
const closedLifecycle = (revision, locked = false) => ({ revision, locked, closedAt: now, closedByUserId: userId });
const lifecycleAuthority = { canManage: true, canSend: true };
const findButton = (container, text) => [...container.querySelectorAll('button')].find(button => button.textContent === text);
function lifecycleFixture({ supported = true, canonical = openLifecycle(), initialDraft, read, command, following = false } = {}) {
  const fixture = createFixture({ cache: seedResolvedCache({ following }) });
  let current = canonical, serial = 0;
  const writes = [];
  const runtime = createThreadLifecycleRuntime({
    cache: fixture.cache,
    reader: { getConversation: async () => await read?.() ?? { status: 'success', value: detail({ ...threadConversation,
      ...(current === undefined ? {} : { threadLifecycle: current }) }) } },
    dispatch: async (_descriptor, input, options) => {
      writes.push({ input, key: options.idempotencyKey });
      const overridden = await command?.(input);
      if (overridden !== undefined) return overridden;
      const before = current;
      current = input.intent === 'reopen' ? openLifecycle(current.revision + 1)
        : closedLifecycle(current.revision + 1, input.intent === 'lock');
      return { status: 'success', value: { ...input, previousLifecycle: before, threadLifecycle: current, reconciliationStatus: 'applied' } };
    },
    enabledFeatures: () => ({ threadLifecycle: supported }), online: () => true,
    generateIdempotencyKey: () => `panel-lifecycle-${++serial}`,
  });
  fixture.client.threadLifecycle = runtime.api;
  const style = createReplyStyleRuntime({ cache: fixture.cache, reader: {}, dispatch: async () => { throw Error('unexpected style write'); },
    enabledFeatures: () => ({}), online: () => true, generateIdempotencyKey: () => 'unused', configuration: { enforcedOverride: 'current' } });
  fixture.client.replyStyle = style.api;
  if (initialDraft) {
    const draft = { conversationId: threadId, status: 'ready', authoritativeRevision: 1, dirty: false,
      draft: { kind: 'replaced', content: initialDraft } };
    fixture.client.selectConversationDraft = () => draft;
    fixture.client.openConversationDraft = async () => draft;
  }
  fixture.client.sendMessage = async input => { fixture.calls.push({ name: 'sendMessage', args: [input] }); return { status: 'rejected', httpStatus: 422 }; };
  return { ...fixture, runtime, writes,
    async remote(value) {
      current = value;
      await act(async () => {
        runtime.handleCanonicalEvent({ eventId: `lifecycle-${++serial}`, protocolVersion: CHAT_PROTOCOL_VERSION, tenantId,
          streamId: threadId, type: 'thread.lifecycle.updated', occurredAt: now,
          payload: { threadId, parentConversationId: parentId, threadLifecycle: value } });
        await flush();
      });
    },
    async style(value) { await act(async () => { style.api.configure({ enforcedOverride: value }); await flush(); }); },
  };
}
const retainedDraft = { format: 'plain', text: 'Friday with the launch team', attachments: [{ attachmentId: 'launch-file' }],
  replyTo: { messageId: 'thread-reply-2', notifyAuthor: false } };
const deferredLifecycle = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('leaving then sending an inline thread reply keeps lifecycle controls usable after membership refresh', async () => {
  const fixture = lifecycleFixture({ following: true, initialDraft: { format: 'plain', text: 'Friday', attachments: [] } });
  fixture.context.state.enabledFeatures = { inlineReplies: true };
  await fixture.style('discord');
  fixture.client.unfollowThread = async id => {
    const input = { operation: 'set_thread_follow', intent: 'unfollow', target: { type: 'thread', id },
      expectedFollowRevision: 1, idempotencyKey: 'leave-before-inline-send' };
    const value = { ...input, reconciliationStatus: 'applied', followRevision: 2,
      follow: { target: input.target, isFollowing: false, source: 'manual', updatedAt: now } };
    fixture.cache.beginOptimisticThreadFollow(input, now);
    fixture.cache.reconcileCurrentUserThreadFollow(input, value);
    return { status: 'success', value };
  };
  fixture.client.sendMessage = async input => {
    fixture.calls.push({ name: 'sendMessage', args: [input] });
    // Exercise the cache refresh boundary during a successful send, while the
    // same panel/hook stays mounted. Only the transport is substituted.
    fixture.cache.hydrateConversationDetail(detail({ ...threadConversation,
      currentMember: { ...member(threadId), updatedAt: '2031-01-01T00:00:00.000Z' } }));
    fixture.cache.hydrateMessageTimeline(timeline(threadId, [reply(3, { content: input.content })]));
    return { status: 'success' };
  };
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  const panel = container.querySelector('aside');
  await click(findButton(container, 'Leave'));
  assert.ok(findButton(container, 'Join'));
  const replyButton = container.querySelector('[data-message-id="thread-reply-2"] [aria-label="Reply"]');
  assert.equal(replyButton.disabled, false);
  await click(replyButton);
  await click(findButton(container, 'Send'));
  const sends = fixture.calls.filter(c => c.name === 'sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args[0].conversationId, threadId);
  assert.equal(sends[0].args[0].replyTo.messageId, 'thread-reply-2');
  assert.equal(container.querySelector('aside'), panel);
  assert.match(container.textContent, /Friday/);
  assert.doesNotMatch(container.textContent, /Loading thread lifecycle/);
  assert.equal(findButton(container, 'Lock thread').disabled, false);
  await click(findButton(container, 'Lock thread'));
  assert.equal(fixture.runtime.api.getState(threadId).lifecycle.locked, true);
  assert.ok(findButton(container, 'Unlock thread'));
  assert.ok(findButton(container, 'Join'));
});

test('lifecycle dismissal, Escape, unmount and custom close label never mutate shared discussion', async () => {
  const fixture = lifecycleFixture();
  const { container, closeCalls } = await renderThreadHarness(fixture);
  const opener = container.querySelector(`[data-message-id="${rootMessageId}"] [aria-label="Reply"]`);
  opener.focus();
  await click(opener);
  await keyDown(container.querySelector('aside'), 'Escape');
  assert.equal(document.activeElement, opener);
  await click(opener);
  await click(container.querySelector('[aria-label="Close panel"]'));
  assert.equal(closeCalls.length, 2);
  const custom = await renderPanel(fixture, { closeLabel: 'Dismiss discussion panel', onClose() {} });
  await click(custom.querySelector('[aria-label="Dismiss discussion panel"]'));
  await act(async () => { mounted.pop().root.unmount(); });
  assert.deepEqual(fixture.writes, []);
});

for (const [label, supported, authority, expected] of [
  ['supported manager', true, lifecycleAuthority, ['Close thread', 'Lock thread']],
  ['unsupported manager', false, lifecycleAuthority, []],
  ['unknown authority', true, undefined, []],
  ['explicit denial', true, { canManage: false, canSend: false }, []],
  ['send-only authority', true, { canSend: true }, []],
]) {
  test(`lifecycle visibility: ${label}`, async () => {
    const fixture = lifecycleFixture({ supported });
    const container = await renderPanel(fixture, { lifecycleAvailability: authority });
    assert.deepEqual([...container.querySelectorAll('[aria-label="Shared thread lifecycle"] button')].map(b => b.textContent), expected);
    assert.deepEqual(fixture.writes, []);
  });
}

test('lifecycle close, reopen, lock, unlock use canonical transitions; unlock leaves closed', async () => {
  const fixture = lifecycleFixture();
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  await click(findButton(container, 'Close thread'));
  assert.match(container.textContent, /authorized send will reopen/);
  await click(findButton(container, 'Reopen thread'));
  await click(findButton(container, 'Lock thread'));
  assert.equal(findButton(container, 'Reopen thread'), undefined);
  assert.equal(container.querySelector('textarea').disabled, true);
  await click(findButton(container, 'Unlock thread'));
  assert.match(container.textContent, /authorized send will reopen/);
  assert.equal(container.querySelector('textarea').disabled, false);
  assert.equal(fixture.runtime.api.getState(threadId).lifecycle.closedAt, now);
  assert.deepEqual(fixture.writes.map(w => w.input.intent), ['close', 'reopen', 'lock', 'unlock']);
});

test('lifecycle pending actions reject duplicates and transport retry keeps exact command', async () => {
  const pending = deferredLifecycle();
  let attempts = 0;
  const fixture = lifecycleFixture({ command: () => ++attempts === 1 ? pending.promise : undefined });
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  const close = findButton(container, 'Close thread');
  await click(close);
  assert.match(container.textContent, /Updating thread/);
  assert.ok([...container.querySelectorAll('[aria-label="Shared thread lifecycle"] button')].every(b => b.disabled));
  await click(close);
  assert.equal(fixture.writes.length, 1);
  await act(async () => { pending.resolve({ status: 'transport' }); await flush(); });
  assert.match(container.querySelector('[role="alert"]').textContent, /could not be updated/);
  await click(findButton(container, 'Retry lifecycle'));
  assert.deepEqual(fixture.writes[0], fixture.writes[1]);
  assert.match(container.textContent, /Thread closed/);
});

test('lifecycle conflict shows canonical state and retries original revision after remote updates', async () => {
  const fixture = lifecycleFixture({ command: input => ({ status: 'success', value: { ...input,
    previousLifecycle: closedLifecycle(4), threadLifecycle: closedLifecycle(4), reconciliationStatus: 'lifecycle_conflict' } }) });
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  await click(findButton(container, 'Close thread'));
  assert.match(container.textContent, /changed elsewhere/);
  await fixture.remote(closedLifecycle(5, true));
  await click(findButton(container, 'Retry lifecycle'));
  assert.deepEqual(fixture.writes[0], fixture.writes[1]);
  assert.equal(fixture.writes[1].input.expectedLifecycleRevision, 1);
  assert.equal(container.querySelector('textarea').disabled, true);
});

for (const initialStyle of ['current', 'discord']) {
  for (const existing of [false, true]) {
    test(`remote lifecycle retains draft/reply/attachments and blocks keyboard/pointer sends: ${initialStyle}, ${existing ? 'discovery' : 'root'} panel`, async () => {
      const fixture = lifecycleFixture({ initialDraft: retainedDraft });
      if (existing) {
        const existingOpening = Object.freeze({ state: 'ready', threadConversationId: threadId,
          parentConversationId: parentId, rootMessageId, rootContext: 'available' });
        fixture.client.getExistingThreadOpeningState = () => existingOpening;
        fixture.client.subscribeExistingThreadOpening = () => () => {};
      }
      await fixture.style(initialStyle);
      window.innerWidth = 360;
      const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority,
        ...(existing ? { threadConversationId: threadId, parentConversationId: parentId } : {}) });
      const textarea = container.querySelector('textarea');
      assert.equal(textarea.value, retainedDraft.text);
      const draftUI = container.querySelector('[aria-label="Message attachments"]');
      assert.ok(draftUI);
      const attemptBlocked = async () => {
        await click(findButton(container, 'Send'));
        await keyDown(textarea, 'Enter');
        assert.equal(fixture.calls.filter(c => c.name === 'sendMessage').length, 0);
        assert.equal(container.querySelector('textarea'), textarea);
        assert.equal(textarea.value, retainedDraft.text);
        assert.equal(container.querySelector('[aria-label="Message attachments"]'), draftUI);
        assert.equal(container.querySelector('input[type="checkbox"]').checked, false);
      };
      await fixture.remote(closedLifecycle(2, true));
      assert.match(container.textContent, /thread is locked/);
      await attemptBlocked();
      await fixture.style(initialStyle === 'current' ? 'discord' : 'current');
      await attemptBlocked();
      await fixture.remote(closedLifecycle(3));
      assert.equal(textarea.disabled, false);
      for (const archivedConversation of [parentConversation, threadConversation]) {
        for (const intent of ['archive', 'restore']) {
          const revision = intent === 'archive' ? 1 : 2;
          const input = { operation: 'set_conversation_archive', intent, conversationId: archivedConversation.id,
            expectedLifecycleRevision: revision, idempotencyKey: `archive-${revision}` };
          await act(async () => {
            fixture.cache.dispatch({ type: 'conversations/reconcile-archive', logicalKey: `archive:${archivedConversation.id}`, input,
              result: { operation: input.operation, intent, conversationId: input.conversationId, expectedLifecycleRevision: revision, lifecycleRevision: revision + 1, reconciliationStatus: 'applied',
                archiveState: intent === 'archive' ? { status: 'archived', archivedAt: now, archivedByUserId: userId } : { status: 'active' } } });
            await flush();
          });
          if (intent === 'archive') {
            assert.match(container.textContent, /administratively archived/);
            await attemptBlocked();
          } else assert.equal(textarea.disabled, false);
        }
      }
      assert.deepEqual(fixture.writes, []);
      assert.match(container.textContent, /authorized send will reopen/);
      await keyDown(textarea, 'Enter');
      const send = fixture.calls.find(c => c.name === 'sendMessage').args[0];
      assert.equal(send.conversationId, threadId);
      assert.deepEqual(send.replyTo, retainedDraft.replyTo);
      assert.deepEqual(send.content.attachments, retainedDraft.attachments);
      assert.equal(send.content.text, retainedDraft.text);
      assert.deepEqual(fixture.writes, [], 'send never issues explicit reopen');
      await fixture.remote(openLifecycle(4));
      assert.equal(container.querySelector('textarea'), textarea);
      assert.equal(textarea.value, retainedDraft.text);
      window.innerWidth = 1024;
    });
  }
}

test('lifecycle denial retains composer draft while revoked history is removed', async () => {
  const fixture = lifecycleFixture({ initialDraft: retainedDraft, command: () => ({ status: 'rejected', httpStatus: 403 }) });
  fixture.client.openThread = async () => fixture.setOpening({ state: 'error', rootMessageId, code: 'permission_denied', message: 'Thread access denied.' });
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  await click(findButton(container, 'Close thread'));
  assert.match(container.textContent, /lifecycle change denied/);
  assert.equal(container.querySelector('textarea').disabled, true);
  assert.equal(container.querySelector('[aria-label="Thread replies"]'), null);
  assert.equal(findButton(container, 'Retry lifecycle'), undefined);
  await keyDown(container.querySelector('textarea'), 'Enter');
  assert.equal(fixture.calls.some(c => c.name === 'sendMessage'), false);
  // The standard composer temporarily hides its renderer when metadata is
  // purged. A later snapshot must reveal the same local state, not restore anew.
  fixture.client.selectConversationDraft = () => ({ conversationId: threadId, status: 'ready', authoritativeRevision: 0, dirty: false });
  await act(async () => { fixture.cache.hydrateConversationDetail(detail(threadConversation)); await flush(); });
  const textarea = container.querySelector('textarea');
  assert.equal(textarea.value, retainedDraft.text);
  assert.equal(textarea.disabled, true, 'snapshot does not grant access after runtime revocation');
  assert.ok(container.querySelector('[aria-label="Message attachments"]'));
  assert.equal(container.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(fixture.calls.some(c => c.name === 'sendMessage'), false);
});

for (const restriction of [{ readOnly: true }, { composerAvailability: { canSend: false } }, { composerAvailability: { membershipState: 'removed' } }]) {
  test(`eligible unlock never weakens host restriction ${JSON.stringify(restriction)}`, async () => {
    const fixture = lifecycleFixture({ initialDraft: retainedDraft, canonical: closedLifecycle(1, true) });
    const container = await renderPanel(fixture, { ...restriction, lifecycleAvailability: lifecycleAuthority });
    await fixture.remote(closedLifecycle(2));
    const textarea = container.querySelector('textarea');
    assert.ok(textarea.disabled || textarea.readOnly);
    assert.equal(findButton(container, 'Reopen thread'), undefined);
    await keyDown(textarea, 'Enter');
    assert.equal(fixture.calls.some(c => c.name === 'sendMessage'), false);
    assert.equal(textarea.value, retainedDraft.text);
  });
}

test('lifecycle loading and legacy metadata are accessible with no mutation controls', async () => {
  const pending = deferredLifecycle();
  const fixture = lifecycleFixture({ read: () => pending.promise });
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  assert.match(container.textContent, /Loading thread lifecycle/);
  assert.equal(findButton(container, 'Close thread'), undefined);
  await act(async () => { pending.resolve({ status: 'success', value: detail(threadConversation) }); await flush(); });
  assert.match(container.textContent, /lifecycle controls are unavailable/);
  assert.equal(findButton(container, 'Close thread'), undefined);
  assert.equal(container.querySelector('textarea').disabled, false);
});

for (const authority of [undefined, { canManage: true }, { canSend: true }]) {
  test(`explicit reopen requires independent send authority: ${JSON.stringify(authority)}`, async () => {
    const fixture = lifecycleFixture({ canonical: closedLifecycle(1) });
    const container = await renderPanel(fixture, { lifecycleAvailability: authority });
    assert.equal(findButton(container, 'Reopen thread') !== undefined, authority?.canSend === true);
    assert.equal(findButton(container, 'Lock thread') !== undefined, authority?.canManage === true);
    assert.equal(findButton(container, 'Close thread'), undefined);
    assert.deepEqual(fixture.writes, []);
  });
}

test('lifecycle read failure retries hydration without creating a command', async () => {
  let reads = 0;
  const fixture = lifecycleFixture({ read: () => ++reads === 1 ? { status: 'transport' } : undefined });
  const container = await renderPanel(fixture, { lifecycleAvailability: lifecycleAuthority });
  assert.match(container.querySelector('[role="alert"]').textContent, /could not be updated or loaded/);
  await click(findButton(container, 'Retry lifecycle'));
  assert.ok(findButton(container, 'Close thread'));
  assert.equal(reads, 2);
  assert.deepEqual(fixture.writes, []);
});


const notificationTrigger = container => container.querySelector('.handrail-chat__notification-preferences-trigger');
const preferencesDialog = container => container.querySelector('.handrail-chat__notification-preferences-panel');
const submitPreferences = async container => {
  await act(async () => {
    preferencesDialog(container).querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  });
};
const chooseLevel = async (container, value) => {
  await act(async () => {
    const select = preferencesDialog(container).querySelector('select');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  });
};
const setPreference = (fixture, value) => {
  const state = structuredClone(fixture.cache.getState());
  state.currentUser.preferences[threadId] = { ...state.currentUser.preferences[threadId], ...value };
  assert.equal(fixture.cache.hydrateCanonicalState(state), true);
};
const subscriptionFixture = (style = 'discord', following = true) => {
  const fixture = createFixture({ cache: seedResolvedCache({ following }) });
  fixture.client.replyStyle = createReplyStyleRuntime({ cache: fixture.cache, reader: {},
    dispatch: async () => { throw Error('Unexpected style write'); }, enabledFeatures: () => ({}),
    online: () => true, generateIdempotencyKey: () => 'unused', configuration: { enforcedOverride: style } }).api;
  for (const [name, intent] of [['followThread', 'follow'], ['unfollowThread', 'unfollow']]) {
    fixture.client[name] = async id => {
      fixture.calls.push({ name, args: [id] });
      const input = { operation: 'set_thread_follow', intent, target: { type: 'thread', id },
        expectedFollowRevision: fixture.cache.getState().currentUser.threadFollowRevisions[id] ?? 0,
        idempotencyKey: `subscription-${fixture.calls.length}` };
      fixture.cache.beginOptimisticThreadFollow(input, now);
      const value = { ...input, reconciliationStatus: 'applied', followRevision: input.expectedFollowRevision + 1,
        follow: { target: input.target, isFollowing: intent === 'follow', source: 'manual', updatedAt: now } };
      fixture.cache.reconcileCurrentUserThreadFollow(input, value);
      return { status: 'success', value };
    };
  }
  for (const name of ['leaveConversation', 'markRead', 'updateThreadLifecycle', 'updateConversationPreference']) {
    fixture.client[name] = (...args) => { fixture.calls.push({ name, args }); throw Error(`Unexpected ${name}`); };
  }
  return fixture;
};

for (const style of ['current', 'discord']) {
  test(`${style} subscription labels bind to thread APIs and leave retains history, draft, unread and private state`, async () => {
    const fixture = subscriptionFixture(style);
    setPreference(fixture, { notificationPreference: 'mentions', mute: { muted: true }, isStarred: true });
    const draft = { conversationId: threadId, status: 'ready', authoritativeRevision: 1, dirty: false,
      draft: { kind: 'replaced', content: { text: 'Retained thread draft', mentions: [], attachments: [] } } };
    fixture.client.selectConversationDraft = () => draft;
    fixture.client.openConversationDraft = async () => draft;
    let closes = 0;
    const container = await renderPanel(fixture, { onClose: () => closes++ });
    const textarea = container.querySelector('textarea');
    const before = structuredClone(fixture.cache.getState());
    const label = style === 'discord' ? 'Leave' : 'Unfollow';
    const button = findButton(container, label);
    button.focus();
    await click(button);
    assert.equal(document.activeElement, button);
    assert.equal(closes, 0);
    assert.ok(container.querySelector('aside'));
    assert.match(container.textContent, /Immutable parent root/);
    assert.match(container.textContent, /Thread reply 2/);
    assert.match(container.textContent, /2 unread/);
    assert.equal(container.querySelector('textarea'), textarea);
    assert.equal(textarea.value, 'Retained thread draft');
    const after = fixture.cache.getState();
    for (const key of ['readStates', 'preferences', 'memberships']) assert.deepEqual(after.currentUser[key], before.currentUser[key]);
    assert.deepEqual(after.entities.messages, before.entities.messages);
    assert.deepEqual(after.entities.conversations, before.entities.conversations);
    assert.equal(notificationTrigger(container).dataset.notificationLevel, 'mentions');
    assert.equal(notificationTrigger(container).dataset.muteState, 'indefinite');
    await click(findButton(container, style === 'discord' ? 'Join' : 'Follow'));
    assert.deepEqual(fixture.calls.filter(c => !['getMessageTimeline'].includes(c.name)), [
      { name: 'unfollowThread', args: [threadId] }, { name: 'followThread', args: [threadId] },
    ]);
  });
}

test('Discord subscription pending prevents duplicate mutations and explicit retry recovers from rejection', async () => {
  const fixture = subscriptionFixture();
  const savedAction = fixture.client.unfollowThread;
  const pending = deferredLifecycle();
  let attempts = 0;
  fixture.client.unfollowThread = id => ++attempts === 1 ? pending.promise : savedAction(id);
  const container = await renderPanel(fixture);
  const button = findButton(container, 'Leave');
  await act(async () => { button.click(); button.click(); await flush(); });
  assert.equal(attempts, 1);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.disabled, true);
  assert.match(container.textContent, /Saving thread subscription/);
  await act(async () => { pending.resolve({ status: 'transport' }); await flush(); });
  assert.match(container.textContent, /Retry subscription/);
  assert.equal(button.disabled, false);
  await click(findButton(container, 'Retry subscription'));
  assert.equal(attempts, 2);
  assert.ok(findButton(container, 'Join'));
});

test('thread preference pending uses canonical values, prevents duplicates, and owns nested Escape at compact width', async () => {
  window.happyDOM.setWindowSize({ width: 360, height: 640 });
  const fixture = subscriptionFixture();
  setPreference(fixture, { isStarred: true });
  let closes = 0;
  const pending = deferredLifecycle();
  const requests = [];
  fixture.client.updateConversationPreference = async input => {
    requests.push(input);
    const command = { ...input, operation: 'update_conversation_preference', expectedPreferenceRevision: 0, idempotencyKey: 'preference-pending' };
    fixture.cache.beginOptimisticConversationPreference(command, now);
    await pending.promise;
    fixture.cache.rollbackOptimisticConversationPreference(threadId, command.idempotencyKey);
    return { status: 'transport' };
  };
  const container = await renderPanel(fixture, { onClose: () => closes++ });
  const trigger = notificationTrigger(container);
  await click(trigger);
  assert.equal(document.activeElement, preferencesDialog(container).querySelector('select'));
  await chooseLevel(container, 'none');
  await act(async () => { preferencesDialog(container).querySelector('input[value="indefinite"]').click(); await flush(); });
  await submitPreferences(container);
  await submitPreferences(container);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { conversationId: threadId, notificationPreference: 'none', isStarred: true, mute: { muted: true } });
  assert.equal(trigger.dataset.notificationLevel, 'all');
  assert.equal(trigger.dataset.muteState, 'unmuted');
  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { preferencesDialog(container).dispatchEvent(escape); await flush(); });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(closes, 0);
  assert.ok(preferencesDialog(container));
  await act(async () => { pending.resolve(); await flush(); });
  assert.match(preferencesDialog(container).querySelector('[role="alert"]').textContent, /not saved/);
  assert.ok(findButton(container, 'Retry save'));
  assert.equal(preferencesDialog(container).querySelector('select').value, 'none');
  const successRequests = [];
  fixture.client.updateConversationPreference = async input => {
    successRequests.push(input);
    const preference = { ...fixture.cache.getState().currentUser.preferences[threadId], ...input };
    setPreference(fixture, preference);
    return { status: 'success', value: { preference, reconciliationStatus: 'applied' } };
  };
  await submitPreferences(container);
  assert.deepEqual(successRequests, requests);
  assert.equal(trigger.dataset.notificationLevel, 'none');
  assert.equal(trigger.dataset.muteState, 'indefinite');
  await act(async () => {
    preferencesDialog(container).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flush();
  });
  assert.equal(preferencesDialog(container), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(closes, 0);
  window.happyDOM.setWindowSize({ width: 1024, height: 768 });
});

test('thread notification level and timed mute are independent; conflicts load authority and permit explicit retry', async () => {
  const fixture = subscriptionFixture();
  setPreference(fixture, { isStarred: true, notificationPreference: 'mentions', mute: { muted: true } });
  const requests = [];
  fixture.client.updateConversationPreference = async input => {
    requests.push(input);
    const conflict = requests.length === 1;
    const preference = { ...fixture.cache.getState().currentUser.preferences[threadId], ...input,
      ...(conflict ? { notificationPreference: 'all', isStarred: false, mute: { muted: true } } : {}) };
    setPreference(fixture, preference);
    return { status: 'success', value: { preference, reconciliationStatus: conflict ? 'preference_revision_conflict' : 'applied' } };
  };
  const container = await renderPanel(fixture);
  await click(notificationTrigger(container));
  const select = preferencesDialog(container).querySelector('select');
  await chooseLevel(container, 'none');
  await submitPreferences(container);
  assert.deepEqual(requests[0].mute, { muted: true });
  assert.equal(requests[0].isStarred, true);
  assert.match(preferencesDialog(container).querySelector('[role="alert"]').textContent, /Preferences changed elsewhere/);
  assert.equal(select.value, 'all');
  assert.equal(document.activeElement, select);
  assert.ok(findButton(container, 'Retry save'));
  await chooseLevel(container, 'mentions');
  await act(async () => { preferencesDialog(container).querySelector('input[value="until"]').click(); await flush(); });
  await act(async () => {
    const until = preferencesDialog(container).querySelector('input[name="mutedUntil"]');
    until.value = '2040-01-02T03:04';
    until.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  });
  await submitPreferences(container);
  assert.equal(requests[1].notificationPreference, 'mentions');
  assert.equal(requests[1].isStarred, false, 'latest authoritative star survives retry');
  assert.deepEqual(requests[1].mute, { muted: true, mutedUntil: new Date('2040-01-02T03:04').toISOString() });
  await act(async () => { preferencesDialog(container).querySelector('input[value="unmuted"]').click(); await flush(); });
  await submitPreferences(container);
  assert.equal(requests[2].notificationPreference, 'mentions');
  assert.deepEqual(requests[2].mute, { muted: false });
});

test('missing thread preferences load without fabricated defaults and retry an unavailable read', async () => {
  const fixture = subscriptionFixture();
  const state = structuredClone(fixture.cache.getState());
  delete state.currentUser.preferences[threadId];
  assert.equal(fixture.cache.hydrateCanonicalState(state), true);
  const pending = deferredLifecycle();
  const requests = [];
  fixture.client.getConversation = async input => {
    requests.push(input);
    if (requests.length === 1) return pending.promise;
    setPreference(fixture, { ...preference(threadId), isStarred: true, notificationPreference: 'mentions' });
    return { status: 'success' };
  };
  const container = await renderPanel(fixture);
  assert.match(container.textContent, /Loading thread notification preferences/);
  assert.equal(notificationTrigger(container), null);
  assert.equal(findButton(container, 'Retry notification preferences').disabled, true);
  await act(async () => { pending.resolve({ status: 'transport' }); await flush(); });
  assert.match(container.textContent, /notification preferences are unavailable/);
  await click(findButton(container, 'Retry notification preferences'));
  assert.deepEqual(requests, [{ conversationId: threadId }, { conversationId: threadId }]);
  assert.equal(notificationTrigger(container).dataset.notificationLevel, 'mentions');
});

test('Discord follow conflict reconciles authority and explicit subscription retry retains keyboard focus', async () => {
  const fixture = subscriptionFixture();
  const apply = fixture.client.unfollowThread;
  let attempts = 0;
  fixture.client.unfollowThread = async id => {
    if (++attempts > 1) return apply(id);
    const input = { operation: 'set_thread_follow', intent: 'unfollow', target: { type: 'thread', id },
      expectedFollowRevision: 1, idempotencyKey: 'discord-conflict' };
    fixture.cache.beginOptimisticThreadFollow(input, now);
    const value = { ...input, reconciliationStatus: 'follow_revision_conflict', followRevision: 2,
      follow: { target: input.target, isFollowing: true, source: 'manual', updatedAt: now } };
    fixture.cache.reconcileCurrentUserThreadFollow(input, value);
    return { status: 'success', value };
  };
  const container = await renderPanel(fixture);
  await click(findButton(container, 'Leave'));
  assert.match(container.textContent, /follow state changed elsewhere/);
  assert.match(container.textContent, /Select Leave to try again/);
  assert.equal(findButton(container, 'Leave').getAttribute('aria-pressed'), 'true');
  const retry = findButton(container, 'Retry subscription');
  retry.focus();
  await click(retry);
  assert.equal(attempts, 2);
  assert.equal(fixture.cache.getState().currentUser.threadFollowRevisions[threadId], 3);
  assert.equal(document.activeElement, findButton(container, 'Join'));
});

test('pre-existing optimistic subscription and preference writes remain unconfirmed and cannot be duplicated', async () => {
  const fixture = subscriptionFixture();
  const preferenceInput = { operation: 'update_conversation_preference', conversationId: threadId,
    notificationPreference: 'none', isStarred: false, mute: { muted: true },
    expectedPreferenceRevision: 0, idempotencyKey: 'external-preference' };
  const followInput = { operation: 'set_thread_follow', intent: 'unfollow', target: { type: 'thread', id: threadId },
    expectedFollowRevision: 1, idempotencyKey: 'external-follow' };
  fixture.cache.beginOptimisticConversationPreference(preferenceInput, now);
  fixture.cache.beginOptimisticThreadFollow(followInput, now);
  const container = await renderPanel(fixture);
  const leave = findButton(container, 'Leave');
  assert.equal(leave.disabled, true);
  assert.equal(leave.getAttribute('aria-pressed'), 'true');
  assert.equal(notificationTrigger(container).dataset.notificationLevel, 'all');
  assert.equal(notificationTrigger(container).dataset.muteState, 'unmuted');
  await click(notificationTrigger(container));
  assert.equal(preferencesDialog(container).querySelector('select').disabled, true);
  await submitPreferences(container);
  await click(leave);
  assert.deepEqual(fixture.calls, []);
  await act(async () => {
    fixture.cache.rollbackOptimisticConversationPreference(threadId, preferenceInput.idempotencyKey);
    fixture.cache.rollbackOptimisticThreadFollow(threadId, followInput.idempotencyKey);
    await flush();
  });
  assert.equal(leave.disabled, false);
  assert.equal(preferencesDialog(container).querySelector('select').disabled, false);
});
