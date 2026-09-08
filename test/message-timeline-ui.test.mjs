import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";

import { Window } from "happy-dom";

process.env.NODE_ENV = "test";
const React = await import("react");
const { act, createElement } = React;
const { createRoot } = await import("react-dom/client");

const buildModule = (path) => new URL(path, process.env.HANDRAIL_REPLY_UI_BUILD ?? new URL("../dist/", import.meta.url)).href;
const { CHAT_PROTOCOL_VERSION } = await import(buildModule("contracts/index.js"));
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
  selectConversationUnreadCount,
} = await import(buildModule("client/index.js"));
const { ChatContext } = await import(buildModule("react/index.js"));
const { DefaultMessageRenderer, MessageTimeline } = await import(buildModule("ui/index.js"));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class TimelineIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.thresholds = Array.isArray(options?.threshold)
      ? options.threshold
      : [options?.threshold ?? 0];
    this.targets = new Set();
    this.disconnected = false;
    TimelineIntersectionObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  emit(entries) {
    if (!this.disconnected) this.callback(entries, this);
  }
}

class TimelineResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    this.disconnected = false;
    TimelineResizeObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  emit() {
    if (!this.disconnected) this.callback([], this);
  }
}

const window = new Window({ url: "https://chat.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  FocusEvent: window.FocusEvent,
  HTMLElement: window.HTMLElement,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  PointerEvent: window.PointerEvent,
  IntersectionObserver: TimelineIntersectionObserver,
  ResizeObserver: TimelineResizeObserver,
  window,
});
window.IntersectionObserver = TimelineIntersectionObserver;
window.ResizeObserver = TimelineResizeObserver;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  window.HTMLElement.prototype,
  "scrollHeight",
);
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
  window.HTMLElement.prototype,
  "clientHeight",
);
const inheritedScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  window.Element.prototype,
  "scrollHeight",
);
let timelineViewportMetrics;

let documentFocused = true;
let documentVisible = true;
Object.defineProperties(document, {
  hidden: { configurable: true, get: () => !documentVisible },
  visibilityState: { configurable: true, get: () => documentVisible ? "visible" : "hidden" },
});
document.hasFocus = () => documentFocused;

const setClipboard = (clipboard) => {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
};

const tenantId = "tenant-ui";
const userId = "current-user";
const otherUserId = "other-user";
const conversationId = "direct-ui";
const threadId = "thread-ui";
const now = "2036-01-02T03:04:05.000Z";
const metadata = {
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
};
const snapshotMetadata = {
  ...metadata,
  feature: { name: "conversation_snapshots", version: 1 },
};

const member = (selectedUserId) => ({
  tenantId,
  conversationId,
  userId: selectedUserId,
  role: "member",
  state: "active",
  joinedAt: now,
  updatedAt: now,
});
const readState = (selectedUserId, lastReadSequence, overrides = {}) => ({
  conversationId,
  userId: selectedUserId,
  lastReadSequence,
  updatedAt: now,
  ...overrides,
});
const conversation = {
  id: conversationId,
  tenantId,
  type: "direct",
  visibility: "private",
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 20,
  unreadMentionCount: 0,
  activeMemberUserIds: [userId, otherUserId],
  currentMember: member(userId),
  currentReadState: readState(userId, 10),
  currentPreference: {
    conversationId,
    userId,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: now,
  },
};
const message = (sequence, overrides = {}) => ({
  id: `message-${sequence}`,
  tenantId,
  conversationId,
  author: { type: "user", userId: sequence % 2 === 0 ? userId : otherUserId },
  sequence,
  createdAt: new Date(Date.parse(now) + sequence * 60_000).toISOString(),
  updatedAt: new Date(Date.parse(now) + sequence * 60_000).toISOString(),
  revision: { revision: 1 },
  content: { format: "plain", text: `Message ${sequence}` },
  isThreadRoot: false,
  reactions: [],
  attachmentMetadata: [],
  ...overrides,
});
const savedMessageInput = (selectedMessageId, intent, revision, idempotencyKey) => ({
  operation: "set_saved_message",
  intent,
  messageId: selectedMessageId,
  expectedSavedMessageRevision: revision,
  idempotencyKey,
});
const savedMessageResult = (input, overrides = {}) => ({
  operation: "set_saved_message",
  intent: input.intent,
  reconciliationStatus: "applied",
  messageId: input.messageId,
  expectedSavedMessageRevision: input.expectedSavedMessageRevision,
  idempotencyKey: input.idempotencyKey,
  savedMessageRevision: input.expectedSavedMessageRevision + 1,
  savedMessage: { messageId: input.messageId, isSaved: input.intent === "save" },
  ...overrides,
});
const timeline = (messages, olderAvailable = false, selectedConversationId = conversationId) => ({
  conversationId: selectedConversationId,
  messages,
  pagination: {
    older: olderAvailable ? { available: true, cursor: messages[0].sequence } : { available: false },
    newer: { available: false },
  },
  replay: { resumeFrom: { eventId: `event-${messages[0]?.sequence ?? "empty"}` } },
});
const safeUser = (selectedUserId, displayName) => ({
  kind: "active",
  userId: selectedUserId,
  displayName,
  avatar: { kind: "initials", initials: displayName.slice(0, 1) },
});

const seedCache = (messages, {
  olderAvailable = false,
  currentReadState = conversation.currentReadState,
  conversationOverrides = {},
  hydrateTimeline = true,
} = {}) => {
  const cache = createNormalizedChatCache({ tenantId, userId, sessionId: "session-ui" });
  const seededConversation = { ...conversation, ...conversationOverrides, currentReadState };
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [seededConversation],
    page: {},
    _meta: snapshotMetadata,
  });
  cache.hydrateConversationDetail({
    kind: "conversation_detail",
    conversation: {
      ...seededConversation,
      memberUserIds: [userId, otherUserId],
      currentPreference: {
        conversationId,
        userId,
        notificationPreference: "all",
        mute: { muted: false },
        updatedAt: now,
      },
    },
    _meta: snapshotMetadata,
  });
  if (hydrateTimeline) cache.hydrateMessageTimeline(timeline(messages, olderAvailable));
  return cache;
};

const hydrateCachedConversation = (cache, selectedConversationId, messages, lastReadSequence = 10, conversationOverrides = {}) => {
  const selectedReadState = {
    ...conversation.currentReadState,
    conversationId: selectedConversationId,
    lastReadSequence,
  };
  const selectedPreference = {
    ...conversation.currentPreference,
    conversationId: selectedConversationId,
  };
  const selectedConversation = {
    ...conversation,
    id: selectedConversationId,
    ...conversationOverrides,
    latestSequence: messages.at(-1)?.sequence ?? 0,
    currentMember: {
      ...conversation.currentMember,
      conversationId: selectedConversationId,
    },
    currentReadState: selectedReadState,
    currentPreference: selectedPreference,
  };
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversation, selectedConversation],
    page: {},
    _meta: snapshotMetadata,
  });
  cache.hydrateConversationDetail({
    kind: "conversation_detail",
    conversation: {
      ...selectedConversation,
      memberUserIds: [userId, otherUserId],
    },
    _meta: snapshotMetadata,
  });
  cache.hydrateMessageTimeline(timeline(messages, false, selectedConversationId));
};

const createFixture = ({
  cache,
  olderPage,
  directoryUsers = [
    safeUser(userId, "Current User"),
    safeUser(otherUserId, "Other User"),
  ],
  hydratedDirectoryUsers = [],
} = {}) => {
  const activeCache = cache ?? seedCache([]);
  const calls = [];
  const directory = new Map(directoryUsers.map((user) => [user.userId, user]));
  const openings = new Map();
  const success = (name) => Promise.resolve({ status: "success", name });
  const client = {
    cache: activeCache,
    state: { state: "ready" },
    selectDirectoryUser: (selectedUserId) => directory.get(selectedUserId),
    hydrateDirectoryUsers: async (selectedUserIds) => {
      calls.push({ name: "hydrateDirectoryUsers", userIds: [...selectedUserIds] });
      for (const user of hydratedDirectoryUsers) {
        if (selectedUserIds.includes(user.userId)) directory.set(user.userId, user);
      }
      return { status: "success" };
    },
    getThreadOpeningState: (rootMessageId) => {
      let opening = openings.get(rootMessageId);
      if (opening === undefined) {
        opening = Object.freeze({ state: "idle", rootMessageId });
        openings.set(rootMessageId, opening);
      }
      return opening;
    },
    subscribeThreadOpening: () => () => undefined,
    async getMessageTimeline() {
      calls.push({ name: "loadOlder" });
      if (olderPage !== undefined) activeCache.hydrateMessageTimeline(olderPage);
      return { status: "success" };
    },
    async markUnread(input) {
      calls.push({ name: "markUnread", args: [input] });
      const state = activeCache.getState();
      const current = state.currentUser.readStates[input.conversationId];
      const latestSequence = state.metadata.conversations[input.conversationId]?.latestSequence;
      assert.notEqual(current, undefined);
      assert.notEqual(latestSequence, undefined);
      activeCache.reconcileCurrentUserReadState({
        operation: "mark_unread",
        conversationId: input.conversationId,
        readState: {
          ...current,
          manualUnreadFromSequence: input.fromSequence,
          updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
        },
        latestSequence,
        unreadCount: latestSequence - Math.min(current.lastReadSequence, input.fromSequence - 1),
      });
      return { status: "success" };
    },
    async markRead(input) {
      calls.push({ name: "markRead", args: [input] });
      const state = activeCache.getState();
      const current = state.currentUser.readStates[input.conversationId];
      const latestSequence = state.metadata.conversations[input.conversationId]?.latestSequence;
      assert.notEqual(current, undefined);
      assert.notEqual(latestSequence, undefined);
      const throughSequence = Math.max(current.lastReadSequence, input.throughSequence);
      activeCache.reconcileCurrentUserReadState({
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
      return { status: "success" };
    },
  };
  for (const name of ["retryMessage", "editMessage", "deleteMessage", "setReaction", "openThread", "saveMessage", "unsaveMessage", "retrySavedMessage"]) {
    client[name] = (...args) => {
      calls.push({ name, args });
      return success(name);
    };
  }
  const context = {
    client,
    state: client.state,
    readiness: "ready",
    isReady: true,
    refreshRequired: null,
    error: null,
  };
  return { activeCache, calls, client, context };
};

const mounted = [];
const renderTimeline = async (fixture, props = {}) => {
  const container = document.createElement("div");
  container.className = "handrail-chat";
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => {
    root.render(createElement(
      ChatContext.Provider,
      { value: fixture.context },
      createElement(MessageTimeline, { conversationId, ...props }),
    ));
  });
  return container;
};

const rerenderTimeline = async (container, fixture, props = {}) => {
  const mountedTimeline = mounted.find((value) => value.container === container);
  assert.notEqual(mountedTimeline, undefined);
  await act(async () => {
    mountedTimeline.root.render(createElement(
      ChatContext.Provider,
      { value: fixture.context },
      createElement(MessageTimeline, { conversationId, ...props }),
    ));
  });
};

const unmountTimeline = async (container) => {
  const index = mounted.findIndex((value) => value.container === container);
  assert.notEqual(index, -1);
  const [value] = mounted.splice(index, 1);
  await act(async () => value.root.unmount());
  value.container.remove();
};

const readObserverFor = (container) => {
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  const observer = TimelineIntersectionObserver.instances.findLast(
    (value) => !value.disconnected && value.root === viewport,
  );
  assert.notEqual(observer, undefined);
  assert.deepEqual(observer.thresholds, [0, 0.5, 1]);
  return observer;
};

const resizeObserverFor = (container) => {
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  const observer = TimelineResizeObserver.instances.findLast(
    (value) => !value.disconnected && value.targets.has(viewport),
  );
  assert.notEqual(observer, undefined);
  return observer;
};

const visibleEntry = (target, intersectionRatio = 1) => {
  const height = 80;
  const visibleHeight = height * intersectionRatio;
  const top = intersectionRatio === 1 ? 0 : 400 - visibleHeight;
  return {
    boundingClientRect: {
      bottom: top + height,
      height,
      left: 0,
      right: 320,
      top,
      width: 320,
    },
    intersectionRatio,
    intersectionRect: {
      bottom: 400,
      height: visibleHeight,
      left: 0,
      right: 320,
      top: 400 - visibleHeight,
      width: 320,
    },
    isIntersecting: intersectionRatio > 0,
    rootBounds: {
      bottom: 400,
      height: 400,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
    },
    target,
    time: 0,
  };
};

const settleReadObservation = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
};

const mockTimelineViewportMetrics = (metrics) => {
  timelineViewportMetrics = metrics;
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList?.contains("handrail-chat__timeline-viewport")
          ? timelineViewportMetrics.scrollHeight
          : inheritedScrollHeightDescriptor.get.call(this);
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        return this.classList?.contains("handrail-chat__timeline-viewport")
          ? timelineViewportMetrics.clientHeight
          : originalClientHeightDescriptor.get.call(this);
      },
    },
  });
};

const scrollTimeline = async (viewport, scrollTop) => {
  await act(async () => {
    viewport.scrollTop = scrollTop;
    viewport.dispatchEvent(new window.Event("scroll", { bubbles: false }));
  });
};

afterEach(async () => {
  while (mounted.length > 0) {
    const value = mounted.pop();
    await act(async () => value.root.unmount());
    value.container.remove();
  }
  if (originalClipboardDescriptor === undefined) {
    delete globalThis.navigator.clipboard;
  } else {
    Object.defineProperty(globalThis.navigator, "clipboard", originalClipboardDescriptor);
  }
  TimelineIntersectionObserver.instances.length = 0;
  TimelineResizeObserver.instances.length = 0;
  globalThis.ResizeObserver = TimelineResizeObserver;
  window.ResizeObserver = TimelineResizeObserver;
  timelineViewportMetrics = undefined;
  if (originalScrollHeightDescriptor === undefined) {
    delete window.HTMLElement.prototype.scrollHeight;
  } else {
    Object.defineProperty(
      window.HTMLElement.prototype,
      "scrollHeight",
      originalScrollHeightDescriptor,
    );
  }
  Object.defineProperty(
    window.HTMLElement.prototype,
    "clientHeight",
    originalClientHeightDescriptor,
  );
  documentFocused = true;
  documentVisible = true;
  document.body.hidden = false;
});

const click = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
};

const keyDown = async (element, key) => {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key }));
    await Promise.resolve();
    await Promise.resolve();
  });
};

const keyboardActivate = async (element, key = "Enter") => {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key }));
    element.click();
    element.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true, key }));
    await Promise.resolve();
    await Promise.resolve();
  });
};

const assertDecorativeSvgControl = (control, iconName) => {
  assert.ok(control);
  assert.equal(control.textContent, "");
  const icon = control.querySelector(`svg[data-timeline-action-icon="${iconName}"]`);
  assert.ok(icon);
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(icon.getAttribute("focusable"), "false");
};

const pointerDown = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "mouse",
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
};

test("keeps plain message content literal and in the existing paragraph", async () => {
  const literal = "<strong>literal HTML</strong>\n**literal Markdown**";
  const container = await renderTimeline(createFixture({
    cache: seedCache([message(11, { content: { format: "plain", text: literal } })]),
  }));

  const content = container.querySelector('[data-message-id="message-11"] .handrail-chat__timeline-text');
  assert.equal(content.tagName, "P");
  assert.equal(content.className, "handrail-chat__timeline-text");
  assert.equal(content.textContent, literal);
  assert.equal(content.querySelector("strong"), null);
});

test("renders the supported Markdown subset as semantic React elements", async () => {
  const markdown = [
    "**Bold** and *italic* and ~~removed~~ with [docs](https://example.test/docs) and `inline code`",
    "ordinary newline",
    "",
    "- first bullet",
    "- second bullet",
    "",
    "3. third item",
    "4. fourth item",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");
  const container = await renderTimeline(createFixture({
    cache: seedCache([message(11, { content: { format: "markdown", text: markdown } })]),
  }));
  const content = container.querySelector('[data-message-id="message-11"] .handrail-chat__timeline-markdown');

  assert.equal(content.querySelector("strong").textContent, "Bold");
  assert.equal(content.querySelector("em").textContent, "italic");
  assert.equal(content.querySelector("del").textContent, "removed");
  assert.equal(content.querySelector('a[href="https://example.test/docs"]').textContent, "docs");
  assert.equal(content.querySelector("p > code").textContent, "inline code");
  assert.deepEqual([...content.querySelectorAll("ul > li")].map(({ textContent }) => textContent), [
    "first bullet",
    "second bullet",
  ]);
  assert.equal(content.querySelector("ol").getAttribute("start"), "3");
  assert.deepEqual([...content.querySelectorAll("ol > li")].map(({ textContent }) => textContent), [
    "third item",
    "fourth item",
  ]);
  assert.equal(content.querySelector("pre > code").textContent, "const answer = 42;");
  assert.match(content.querySelector("p").textContent, /inline code\nordinary newline/);
});

test("keeps unsafe Markdown HTML and URL payloads inert", async () => {
  const markdown = [
    '<script data-unsafe="true">window.pwned = true</script>',
    '<img src="x" onerror="window.pwned = true">',
    "[script URL](javascript:alert(1))",
    "[data URL](data:text/html,<script>alert(1)</script>)",
  ].join("\n");
  const container = await renderTimeline(createFixture({
    cache: seedCache([message(11, { content: { format: "markdown", text: markdown } })]),
  }));
  const content = container.querySelector('[data-message-id="message-11"] .handrail-chat__timeline-markdown');

  assert.equal(content.querySelector("script"), null);
  assert.equal(content.querySelector("img"), null);
  assert.equal(content.querySelector("a"), null);
  assert.equal(content.querySelectorAll(".handrail-chat__timeline-markdown-unsafe-link").length, 2);
  assert.match(content.textContent, /<script data-unsafe="true">window\.pwned = true<\/script>/);
  assert.match(content.textContent, /<img src="x" onerror="window\.pwned = true">/);
  assert.equal(globalThis.window.pwned, undefined);
});

test("bounds long Markdown code blocks and list content within the message column", async () => {
  const longContent = "x".repeat(4_096);
  const markdown = `- ${longContent}\n\n\`\`\`\n${longContent}\n\`\`\``;
  const container = await renderTimeline(createFixture({
    cache: seedCache([message(11, { content: { format: "markdown", text: markdown } })]),
  }));
  const content = container.querySelector('[data-message-id="message-11"] .handrail-chat__timeline-markdown');
  const styles = await readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");

  assert.equal(content.querySelector("ul > li").textContent.length, longContent.length);
  assert.equal(content.querySelector("pre > code").textContent.length, longContent.length);
  assert.match(
    styles,
    /\.handrail-chat \.handrail-chat__timeline-markdown :is\(ol, ul\)\s*\{[^}]*max-inline-size:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(
    styles,
    /\.handrail-chat \.handrail-chat__timeline-markdown-code-block\s*\{[^}]*max-inline-size:\s*100%;[^}]*overflow:\s*auto;/s,
  );
});

test("hydrates unique timeline authors in one stable batch", async () => {
  const activeAuthorId = "active-author";
  const redactedAuthorId = "redacted-author";
  const unavailableAuthorId = "unavailable-author";
  const pageMessages = [
    message(11, { author: { type: "user", userId: activeAuthorId } }),
    message(12, { author: { type: "user", userId: redactedAuthorId } }),
    message(13, { author: { type: "user", userId: activeAuthorId } }),
    message(14, { author: { type: "user", userId: unavailableAuthorId } }),
    message(15, { author: { type: "user", userId: redactedAuthorId } }),
  ];
  const fixture = createFixture({
    cache: seedCache(pageMessages),
    directoryUsers: [],
    hydratedDirectoryUsers: [
      safeUser(activeAuthorId, "Hydrated User"),
      { kind: "redacted", userId: redactedAuthorId },
      { kind: "unavailable", userId: unavailableAuthorId, reason: "missing" },
    ],
  });

  const container = await renderTimeline(fixture);

  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "hydrateDirectoryUsers"),
    [{
      name: "hydrateDirectoryUsers",
      userIds: [activeAuthorId, redactedAuthorId, unavailableAuthorId],
    }],
  );
  assert.equal(container.querySelectorAll('[aria-label="Message from Hydrated User"]').length, 2);
  assert.equal(container.querySelectorAll('[aria-label="Message from Hidden user"]').length, 2);
  assert.equal(container.querySelectorAll('[aria-label="Message from Unknown user"]').length, 1);

  await rerenderTimeline(container, fixture);

  assert.equal(fixture.calls.filter(({ name }) => name === "hydrateDirectoryUsers").length, 1);
});

test("coalesces meaningfully visible canonical rows through the highest unread sequence after scrolling settles", async () => {
  const fixture = createFixture({
    cache: seedCache([message(11), message(12), message(13), message(14)], {
      currentReadState: readState(userId, 10),
    }),
  });
  const container = await renderTimeline(fixture);
  const observer = readObserverFor(container);
  const row = (sequence) => container.querySelector(`[data-message-id="message-${sequence}"]`);

  observer.emit([
    visibleEntry(row(11), 1),
    visibleEntry(row(12), 0.5),
    visibleEntry(row(13), 0.75),
    visibleEntry(row(14), 0.49),
  ]);
  container.querySelector(".handrail-chat__timeline-viewport")
    .dispatchEvent(new window.Event("scroll"));
  await settleReadObservation();
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), []);

  await settleReadObservation();
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "markRead"),
    [{ name: "markRead", args: [{ conversationId, throughSequence: 13 }] }],
  );

  const currentObserver = readObserverFor(container);
  currentObserver.emit([visibleEntry(row(11)), visibleEntry(row(13))]);
  await settleReadObservation();
  assert.equal(fixture.calls.filter(({ name }) => name === "markRead").length, 1);
});

test("manual unread survives idle visibility and layout changes until intentional reading", async () => {
  const fixture = createFixture({
    cache: seedCache([message(11), message(12), message(13)], {
      currentReadState: readState(userId, 13),
      conversationOverrides: { latestSequence: 13 },
    }),
  });
  const container = await renderTimeline(fixture);
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  const row = () => container.querySelector('[data-message-id="message-13"]');
  await click(row().querySelector('button[aria-label="More message actions"]'));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Include an already scheduled observation and the fresh observation caused
    // by inserting the unread divider. Neither represents a new user action.
    readObserverFor(container).emit([visibleEntry(row())]);
    await click(row().querySelector('button[aria-label="Mark unread"]'));
    readObserverFor(container).emit([visibleEntry(row())]);
    await act(async () => viewport.dispatchEvent(new window.Event("scroll")));
    await settleReadObservation();
    await settleReadObservation();
    assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), []);
    const state = fixture.activeCache.getState();
    assert.equal(selectConversationUnreadCount(state, conversationId), 1);
    assert.equal(state.currentUser.readStates[conversationId].manualUnreadFromSequence, 13);
    assert.equal(state.currentUser.readStates[conversationId].lastReadSequence, 13);
    assert.notEqual(container.querySelector('[aria-label="Unread messages"]'), null);
  }

  // Wheel input resumes reading even when all rows are already visible.
  viewport.dispatchEvent(new window.Event("wheel"));
  await settleReadObservation();
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), [
    { name: "markRead", args: [{ conversationId, throughSequence: 13 }] },
  ]);
  const state = fixture.activeCache.getState();
  assert.equal(selectConversationUnreadCount(state, conversationId), 0);
  assert.equal(state.currentUser.readStates[conversationId].manualUnreadFromSequence, undefined);
  assert.equal(state.currentUser.readStates[conversationId].lastReadSequence, 13);
});

test("manual unread resumes on keyboard reading, window return, and conversation return", async () => {
  const fixture = createFixture({
    cache: seedCache([message(20)], {
      currentReadState: readState(userId, 20),
      conversationOverrides: { latestSequence: 20 },
    }),
  });
  const container = await renderTimeline(fixture);
  const row = () => container.querySelector('[data-message-id="message-20"]');
  for (const activity of ["keyboard", "window", "conversation"]) {
    await click(row().querySelector('button[aria-label="More message actions"]'));
    await click(row().querySelector('button[aria-label="Mark unread"]'));
    readObserverFor(container).emit([visibleEntry(row())]);
    await settleReadObservation();
    assert.equal(selectConversationUnreadCount(fixture.activeCache.getState(), conversationId), 1);

    if (activity === "keyboard") {
      await act(async () => row().dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "End", bubbles: true,
      })));
    } else if (activity === "window") {
      documentFocused = false;
      window.dispatchEvent(new window.Event("blur"));
      documentFocused = true;
      window.dispatchEvent(new window.Event("focus"));
    } else {
      const secondConversationId = "second-conversation";
      await act(async () => hydrateCachedConversation(fixture.activeCache, secondConversationId, []));
      await rerenderTimeline(container, fixture, { conversationId: secondConversationId });
      await rerenderTimeline(container, fixture);
    }
    readObserverFor(container).emit([visibleEntry(row())]);
    await settleReadObservation();
    const state = fixture.activeCache.getState();
    assert.equal(selectConversationUnreadCount(state, conversationId), 0, activity);
    assert.equal(state.currentUser.readStates[conversationId].lastReadSequence, 20, activity);
    if (activity !== "conversation") {
      await click(row().querySelector('button[aria-label="More message actions"]'));
    }
  }
});

test("manual unread suppresses queued reads while pending and releases them after failure", async () => {
  const fixture = createFixture({
    cache: seedCache([message(13)], {
      currentReadState: readState(userId, 10),
      conversationOverrides: { latestSequence: 13 },
    }),
  });
  let finishUnread;
  fixture.client.markUnread = () => new Promise((resolve) => { finishUnread = resolve; });
  const container = await renderTimeline(fixture);
  const row = container.querySelector('[data-message-id="message-13"]');
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  await click(row.querySelector('button[aria-label="More message actions"]'));
  readObserverFor(container).emit([visibleEntry(row)]);
  await click(row.querySelector('button[aria-label="Mark unread"]'));
  viewport.dispatchEvent(new window.Event("wheel"));
  await settleReadObservation();
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), []);

  await act(async () => finishUnread({ status: "error" }));
  await settleReadObservation();
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), [
    { name: "markRead", args: [{ conversationId, throughSequence: 13 }] },
  ]);
});

test("keeps the entry unread separator until the conversation changes", async () => {
  const fixture = createFixture({
    cache: seedCache([message(11), message(12), message(13)], {
      currentReadState: readState(userId, 10),
      conversationOverrides: { latestSequence: 13 },
    }),
  });
  const container = await renderTimeline(fixture);
  const separator = () => container.querySelector(
    '[role="separator"][aria-label="Unread messages"]',
  );
  const initialSeparator = separator();
  assert.notEqual(initialSeparator, null);
  assert.equal(initialSeparator.nextElementSibling?.dataset.messageId, "message-11");

  const observer = readObserverFor(container);
  observer.emit([
    visibleEntry(container.querySelector('[data-message-id="message-11"]')),
    visibleEntry(container.querySelector('[data-message-id="message-12"]')),
    visibleEntry(container.querySelector('[data-message-id="message-13"]')),
  ]);
  await settleReadObservation();

  assert.equal(
    fixture.activeCache.getState().currentUser.readStates[conversationId].lastReadSequence,
    13,
  );
  assert.equal(separator()?.nextElementSibling?.dataset.messageId, "message-11");

  const secondConversationId = "second-conversation";
  hydrateCachedConversation(fixture.activeCache, secondConversationId, [
    message(11, {
      conversationId: secondConversationId,
      id: "second-message-11",
    }),
  ]);
  await rerenderTimeline(container, fixture, { conversationId: secondConversationId });
  await act(async () => {
    await fixture.client.markRead({ conversationId, throughSequence: 13 });
  });
  await rerenderTimeline(container, fixture);

  assert.equal(separator(), null);
});

test("ignores insufficiently visible and optimistic message rows", async () => {
  const cache = seedCache([message(11)], { currentReadState: readState(userId, 10) });
  cache.insertOptimisticMessage({
    ...message(12, { id: "optimistic-visible", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-visible",
      idempotencyKey: "send-visible",
      retryable: true,
      attempt: 1,
    },
  });
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture);
  const observer = readObserverFor(container);
  const canonical = container.querySelector('[data-message-id="message-11"]');
  const optimistic = container.querySelector('[data-message-id="optimistic-visible"]');

  assert.equal(canonical.dataset.messageSequence, "11");
  assert.equal(optimistic.hasAttribute("data-message-sequence"), false);
  assert.equal(observer.targets.has(canonical), true);
  assert.equal(observer.targets.has(optimistic), false);
  observer.emit([visibleEntry(canonical, 0.49), visibleEntry(optimistic, 1)]);
  await settleReadObservation();

  assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), []);
});

test("does not advance hidden, background, or inactive timelines", async () => {
  for (const inactiveState of ["hidden", "background", "unfocused"]) {
    const fixture = createFixture({
      cache: seedCache([message(11)], { currentReadState: readState(userId, 10) }),
    });
    const container = await renderTimeline(fixture);
    const observer = readObserverFor(container);
    if (inactiveState === "hidden") container.hidden = true;
    if (inactiveState === "background") documentVisible = false;
    if (inactiveState === "unfocused") documentFocused = false;

    observer.emit([visibleEntry(container.querySelector('[data-message-id="message-11"]'))]);
    await settleReadObservation();
    assert.deepEqual(
      fixture.calls.filter(({ name }) => name === "markRead"),
      [],
      inactiveState,
    );

    await unmountTimeline(container);
    documentVisible = true;
    documentFocused = true;
  }
});

for (const warm of [false, true]) {
  test(`opens ${warm ? "warm" : "cold"} unread chats at the divider and keeps the reading position`, async () => {
    mockTimelineViewportMetrics({ scrollHeight: 4_000, clientHeight: 220 });
    const pageMessages = Array.from({ length: 40 }, (_, index) => message(index + 1));
    const cache = seedCache(warm ? pageMessages : [], {
      hydrateTimeline: warm,
      currentReadState: readState(userId, 17),
      conversationOverrides: { latestSequence: 40 },
    });
    const fixture = createFixture({ cache, olderPage: timeline(pageMessages) });
    const container = await renderTimeline(fixture);
    const viewport = container.querySelector(".handrail-chat__timeline-viewport");
    const separator = container.querySelector('[role="separator"][aria-label="Unread messages"]');
    assert.notEqual(separator, null);
    assert.equal(separator.nextElementSibling?.dataset.messageId, "message-18");
    assert.ok(viewport.scrollTop > 0 && viewport.scrollTop < 3_000);
    assert.equal(viewport.dataset.bottomPinned, "false");
    const offset = viewport.scrollTop;
    await act(async () => cache.hydrateMessageTimeline(timeline([message(41)])));
    assert.equal(viewport.scrollTop, offset, "arrival preserves the unread reading position");
    resizeObserverFor(container).emit();
    assert.equal(viewport.scrollTop, offset, "resize does not override the unread target");
    await scrollTimeline(viewport, 80);
    await rerenderTimeline(container, fixture);
    assert.equal(viewport.scrollTop, 80, "ordinary rebuild does not repeat entry positioning");
  });
}

test("opens cold and warm fully read timelines at the newest message and reinitializes on conversation changes", async () => {
  const metrics = { scrollHeight: 1_000, clientHeight: 220 };
  mockTimelineViewportMetrics(metrics);
  const coldFixture = createFixture({
    cache: seedCache([], { hydrateTimeline: false, currentReadState: readState(userId, 12) }),
    olderPage: timeline([message(11), message(12)]),
  });
  const coldContainer = await renderTimeline(coldFixture);
  const coldViewport = coldContainer.querySelector(".handrail-chat__timeline-viewport");

  assert.equal(coldViewport.scrollTop, 780);
  assert.equal(
    coldContainer.querySelector(".handrail-chat__timeline-jump-latest"),
    null,
    "initial hydration does not create a new-message count",
  );

  await unmountTimeline(coldContainer);
  const secondConversationId = "second-conversation";
  const cache = seedCache([message(11), message(12)], { currentReadState: readState(userId, 12) });
  hydrateCachedConversation(cache, secondConversationId, [
    message(11, { conversationId: secondConversationId, id: "second-message-11" }),
    message(12, { conversationId: secondConversationId, id: "second-message-12" }),
  ], 12);
  const warmFixture = createFixture({ cache });
  const warmContainer = await renderTimeline(warmFixture);
  const warmViewport = warmContainer.querySelector(".handrail-chat__timeline-viewport");

  assert.equal(warmViewport.scrollTop, 780);
  await scrollTimeline(warmViewport, 41);
  assert.equal(warmViewport.dataset.bottomPinned, "false");
  metrics.scrollHeight = 860;
  metrics.clientHeight = 200;
  await rerenderTimeline(warmContainer, warmFixture, {
    conversationId: secondConversationId,
  });
  assert.equal(warmViewport.scrollTop, 660);
  assert.equal(warmViewport.dataset.bottomPinned, "true");

  warmViewport.scrollTop = 53;
  metrics.scrollHeight = 1_000;
  metrics.clientHeight = 220;
  await rerenderTimeline(warmContainer, warmFixture);
  assert.equal(warmViewport.scrollTop, 780);

  warmViewport.scrollTop = 67;
  await rerenderTimeline(warmContainer, warmFixture);
  assert.equal(warmViewport.scrollTop, 67);
});

test("bounds 5,000 mixed-height messages and reveals offscreen search, Home, and End targets before focus", async () => {
  const metrics = { scrollHeight: 500_000, clientHeight: 600 };
  mockTimelineViewportMetrics(metrics);
  const pageMessages = Array.from({ length: 5_000 }, (_, index) => message(index + 1, {
    content: {
      format: "plain",
      text: Array.from({ length: 1 + index % 8 }, () => `Variable line ${index + 1}`).join("\n"),
    },
  }));
  const fixture = createFixture({
    cache: seedCache(pageMessages, { currentReadState: readState(userId, 0) }),
  });
  const controller = React.createRef();
  const container = await renderTimeline(fixture, { editControllerRef: controller });
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  const mountedMessages = () => [...container.querySelectorAll("[data-message-id]")];

  assert.ok(viewport.scrollTop < 100, "initial unread position");
  assert.ok(mountedMessages().length < 40, "mounted message rows stay bounded");
  assert.notEqual(container.querySelector('[data-message-id="message-1"]'), null);
  assert.equal(container.querySelector('[data-message-id="message-5000"]'), null);
  await act(async () => {
    assert.equal(controller.current.revealMessage("message-5000"), true);
  });

  const last = container.querySelector('[data-message-id="message-5000"]');
  last.focus();
  await keyDown(last, "Home");
  const first = container.querySelector('[data-message-id="message-1"]');
  assert.notEqual(first, null);
  assert.equal(document.activeElement, first);
  assert.ok(mountedMessages().length < 40, "Home keeps the mounted range bounded");

  await keyDown(first, "End");
  const remountedLast = container.querySelector('[data-message-id="message-5000"]');
  assert.notEqual(remountedLast, null);
  assert.equal(document.activeElement, remountedLast);

  await act(async () => {
    assert.equal(controller.current.revealMessage("message-2500"), true);
  });
  const searchTarget = container.querySelector('[data-message-id="message-2500"]');
  assert.notEqual(searchTarget, null, "offscreen search target is mounted first");
  searchTarget.focus({ preventScroll: true });
  assert.equal(document.activeElement, searchTarget);
  assert.ok(mountedMessages().length < 40, "search reveal keeps the mounted range bounded");

  const observer = readObserverFor(container);
  const disconnected = document.createElement("li");
  disconnected.dataset.messageSequence = "4999";
  observer.emit([visibleEntry(searchTarget), visibleEntry(disconnected)]);
  await settleReadObservation();
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "markRead").map(({ args }) => args[0].throughSequence),
    [2500],
    "only the visible mounted row advances read state",
  );
});

test("keeps a pinned timeline at the exact bottom through viewport, content, and message changes", async () => {
  const metrics = { scrollHeight: 1_000, clientHeight: 220 };
  mockTimelineViewportMetrics(metrics);
  const cache = seedCache([message(11), message(12)], { currentReadState: readState(userId, 12) });
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture);
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  let resizeObserver = resizeObserverFor(container);

  assert.equal(viewport.scrollTop, 780);
  assert.equal(viewport.dataset.bottomPinned, "true");
  assert.equal(resizeObserver.targets.has(viewport), true);
  assert.equal(
    resizeObserver.targets.has(container.querySelector(".handrail-chat__timeline-feed")),
    true,
  );

  metrics.clientHeight = 160;
  resizeObserver.emit();
  assert.equal(viewport.scrollTop, 840, "viewport shrink");
  metrics.clientHeight = 260;
  resizeObserver.emit();
  assert.equal(viewport.scrollTop, 740, "viewport growth");
  metrics.scrollHeight = 1_120;
  resizeObserver.emit();
  assert.equal(viewport.scrollTop, 860, "rendered attachment or status content resize");

  const optimistic = {
    ...message(13, { id: "optimistic-bottom-13", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-bottom-13",
      idempotencyKey: "send-bottom-13",
      retryable: true,
      attempt: 1,
    },
  };
  metrics.scrollHeight = 1_240;
  await act(async () => cache.insertOptimisticMessage(optimistic));
  assert.equal(viewport.scrollTop, 980, "optimistic append");
  assert.equal(resizeObserver.disconnected, true);

  const {
    attachmentMetadata: _attachmentMetadata,
    isThreadRoot: _isThreadRoot,
    reactions: _reactions,
    ...canonical
  } = message(13, { id: "canonical-bottom-13", author: { type: "user", userId } });
  metrics.scrollHeight = 1_260;
  await act(async () => cache.reconcileOptimisticMessage({
    operation: "send",
    reconciliationStatus: "applied",
    clientMessageId: "client-bottom-13",
    message: canonical,
    canonicalRevision: 1,
  }));
  assert.equal(viewport.scrollTop, 1_000, "canonical replacement");

  metrics.scrollHeight = 1_380;
  await act(async () => cache.hydrateMessageTimeline(timeline([message(14)])));
  assert.equal(viewport.scrollTop, 1_120, "incoming canonical append");

  resizeObserver = resizeObserverFor(container);
  await unmountTimeline(container);
  assert.equal(resizeObserver.disconnected, true);
});

test("preserves an unpinned timeline through viewport, content, and message changes", async () => {
  const metrics = { scrollHeight: 1_000, clientHeight: 220 };
  mockTimelineViewportMetrics(metrics);
  const cache = seedCache([message(11), message(12)]);
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture);
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");

  await scrollTimeline(viewport, 300);
  assert.equal(viewport.dataset.bottomPinned, "false");
  assert.equal(viewport.dataset.latestAvailable, "true");
  let jumpToLatest = container.querySelector(".handrail-chat__timeline-jump-latest");
  assert.equal(jumpToLatest.textContent, "Jump to latest");
  assert.equal(jumpToLatest.type, "button");
  assert.equal(container.querySelector('[role="feed"]').contains(jumpToLatest), false);

  metrics.clientHeight = 180;
  resizeObserverFor(container).emit();
  assert.equal(viewport.scrollTop, 300, "viewport resize");
  metrics.scrollHeight = 1_120;
  resizeObserverFor(container).emit();
  assert.equal(viewport.scrollTop, 300, "rendered content resize");

  metrics.scrollHeight = 1_240;
  await act(async () => cache.insertOptimisticMessage({
    ...message(13, { id: "optimistic-history-13", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-history-13",
      idempotencyKey: "send-history-13",
      retryable: true,
      attempt: 1,
    },
  }));
  assert.equal(viewport.scrollTop, 300, "optimistic append");
  jumpToLatest = container.querySelector(".handrail-chat__timeline-jump-latest");
  assert.equal(jumpToLatest.textContent, "Jump to latest (1 new message)");

  const {
    attachmentMetadata: _attachmentMetadata,
    isThreadRoot: _isThreadRoot,
    reactions: _reactions,
    ...canonical
  } = message(13, { id: "canonical-history-13", author: { type: "user", userId } });
  metrics.scrollHeight = 1_260;
  await act(async () => cache.reconcileOptimisticMessage({
    operation: "send",
    reconciliationStatus: "applied",
    clientMessageId: "client-history-13",
    message: canonical,
    canonicalRevision: 1,
  }));
  assert.equal(viewport.scrollTop, 300, "canonical replacement");
  assert.equal(
    container.querySelector(".handrail-chat__timeline-jump-latest").textContent,
    "Jump to latest (1 new message)",
    "optimistic reconciliation does not count twice",
  );

  metrics.scrollHeight = 1_380;
  await act(async () => cache.hydrateMessageTimeline(timeline([message(14)])));
  assert.equal(viewport.scrollTop, 300, "incoming canonical append");
  jumpToLatest = container.querySelector(".handrail-chat__timeline-jump-latest");
  assert.equal(jumpToLatest.textContent, "Jump to latest (2 new messages)");

  await keyboardActivate(jumpToLatest);
  assert.equal(viewport.scrollTop, 1_200, "jump reaches the exact maximum");
  assert.equal(viewport.dataset.bottomPinned, "true");
  assert.equal(viewport.hasAttribute("data-latest-available"), false);
  assert.equal(container.querySelector(".handrail-chat__timeline-jump-latest"), null);
});

test("updates bottom affinity when user scrolling crosses the logical-pixel threshold", async () => {
  const metrics = { scrollHeight: 1_000, clientHeight: 220 };
  mockTimelineViewportMetrics(metrics);
  const cache = seedCache([message(11)]);
  const container = await renderTimeline(createFixture({ cache }));
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");

  await scrollTimeline(viewport, 755);
  assert.equal(viewport.dataset.bottomPinned, "false", "25 pixels from bottom");
  assert.equal(viewport.dataset.latestAvailable, "true");
  assert.equal(
    container.querySelector(".handrail-chat__timeline-jump-latest").textContent,
    "Jump to latest",
  );

  metrics.scrollHeight = 1_120;
  await act(async () => cache.hydrateMessageTimeline(timeline([message(12)])));
  assert.equal(
    container.querySelector(".handrail-chat__timeline-jump-latest").textContent,
    "Jump to latest (1 new message)",
  );
  await scrollTimeline(viewport, 876);
  assert.equal(viewport.dataset.bottomPinned, "true", "24 pixels from bottom");
  assert.equal(viewport.hasAttribute("data-latest-available"), false);
  assert.equal(container.querySelector(".handrail-chat__timeline-jump-latest"), null);

  await scrollTimeline(viewport, 875);
  assert.equal(viewport.dataset.bottomPinned, "false", "25 pixels from new bottom");
  assert.equal(
    container.querySelector(".handrail-chat__timeline-jump-latest").textContent,
    "Jump to latest",
    "manual return clears the pending count",
  );
});

test("falls back without ResizeObserver and cleans up its resize listener", async () => {
  globalThis.ResizeObserver = undefined;
  window.ResizeObserver = undefined;
  const metrics = { scrollHeight: 1_000, clientHeight: 220 };
  mockTimelineViewportMetrics(metrics);
  const cache = seedCache([message(11)], { currentReadState: readState(userId, 11) });
  const container = await renderTimeline(createFixture({ cache }));
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");

  assert.equal(viewport.scrollTop, 780);
  metrics.clientHeight = 180;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(viewport.scrollTop, 820);

  metrics.scrollHeight = 1_120;
  await act(async () => cache.hydrateMessageTimeline(timeline([message(12)])));
  assert.equal(viewport.scrollTop, 940);

  await unmountTimeline(container);
  viewport.scrollTop = 17;
  metrics.clientHeight = 160;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(viewport.scrollTop, 17);
});

test("loads older pages, preserves the scroll anchor, and restores focus", async () => {
  const initial = [message(11), message(12)];
  const cache = seedCache(initial, { olderAvailable: true });
  const fixture = createFixture({ cache, olderPage: timeline([message(9), message(10)], false) });
  const container = await renderTimeline(fixture);
  const viewport = container.querySelector(".handrail-chat__timeline-viewport");
  assert.equal(container.querySelector(".handrail-chat__timeline-jump-latest"), null);
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => container.querySelectorAll("[data-message-id]").length * 100,
  });
  viewport.scrollTop = 40;

  await click(container.querySelector(".handrail-chat__timeline-load-older"));

  assert.deepEqual([...container.querySelectorAll("[data-message-id]")].map((node) => node.dataset.messageId), [
    "message-9", "message-10", "message-11", "message-12",
  ]);
  assert.equal(viewport.scrollTop, 224, "the original row keeps its estimated-layout offset");
  assert.equal(viewport.dataset.bottomPinned, "false");
  assert.equal(
    container.querySelector(".handrail-chat__timeline-jump-latest").textContent,
    "Jump to latest",
    "older-page prepends do not create a new-message count",
  );
  assert.equal(document.activeElement.dataset.messageId, "message-11");
  assert.match(container.querySelector('[role="status"]').textContent, /Older messages loaded/);
});

test("does not advance read state when observing rows inserted by older-page pagination", async () => {
  const cache = seedCache([message(11), message(12)], {
    olderAvailable: true,
    currentReadState: readState(userId, 0),
  });
  const fixture = createFixture({
    cache,
    olderPage: timeline([message(9), message(10)], false),
  });
  const container = await renderTimeline(fixture);

  await click(container.querySelector(".handrail-chat__timeline-load-older"));
  const observer = readObserverFor(container);
  observer.emit([...observer.targets].map((row) => visibleEntry(row)));
  await settleReadObservation();

  assert.deepEqual(fixture.calls.filter(({ name }) => name === "markRead"), []);
});

test("cancels pending read observations on conversation change and unmount", async () => {
  const changedFixture = createFixture({
    cache: seedCache([message(11)], { currentReadState: readState(userId, 10) }),
  });
  const changedContainer = await renderTimeline(changedFixture);
  const oldObserver = readObserverFor(changedContainer);
  oldObserver.emit([visibleEntry(changedContainer.querySelector('[data-message-id="message-11"]'))]);
  await rerenderTimeline(changedContainer, changedFixture, {
    conversationId: "replacement-conversation",
  });
  assert.equal(oldObserver.disconnected, true);
  await settleReadObservation();
  assert.deepEqual(changedFixture.calls.filter(({ name }) => name === "markRead"), []);

  const unmountedFixture = createFixture({
    cache: seedCache([message(11)], { currentReadState: readState(userId, 10) }),
  });
  const unmountedContainer = await renderTimeline(unmountedFixture);
  const unmountedObserver = readObserverFor(unmountedContainer);
  unmountedObserver.emit([
    visibleEntry(unmountedContainer.querySelector('[data-message-id="message-11"]')),
  ]);
  await unmountTimeline(unmountedContainer);
  assert.equal(unmountedObserver.disconnected, true);
  await settleReadObservation();
  assert.deepEqual(unmountedFixture.calls.filter(({ name }) => name === "markRead"), []);
});

test("copies only the exact visible message text and announces completion", async () => {
  const writes = [];
  setClipboard({
    writeText: async (text) => {
      writes.push(text);
    },
  });
  const copyable = message(11, {
    content: {
      format: "plain",
      text: "Visible message text",
      blocks: [{ type: "system_event", data: { summary: "Internal block text" } }],
    },
    attachmentMetadata: [{
      attachmentId: "attachment-copy",
      fileName: "private-notes.txt",
      contentType: "text/plain",
      sizeBytes: 99,
      downloadUrl: "/files/private-notes.txt",
    }],
  });
  const container = await renderTimeline(createFixture({ cache: seedCache([copyable]) }));

  await click(container.querySelector('button[aria-label="Copy"]'));

  assert.deepEqual(writes, ["Visible message text"]);
  assert.match(container.querySelector('[role="status"]').textContent, /Copying message complete/);
});

test("exposes direct and overflow message actions by accessible name and keeps focused controls usable", async () => {
  const writes = [];
  setClipboard({
    writeText: async (text) => {
      writes.push(text);
    },
  });
  const cache = seedCache([message(12)]);
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture, { currentUserId: userId });
  const row = container.querySelector('[data-message-id="message-12"]');
  const toolbar = row.querySelector('[role="toolbar"][aria-label="Message actions"]');
  const reply = toolbar.querySelector('button[aria-label="Reply"]');
  const save = toolbar.querySelector('button[aria-label="Save"]');
  const copy = toolbar.querySelector('button[aria-label="Copy"]');
  const more = toolbar.querySelector('button[aria-label="More message actions"]');

  assert.equal(toolbar.dataset.actionsExpanded, "false");
  assert.equal(reply.title, "Reply to message");
  assert.equal(save.title, "Save message");
  assert.equal(copy.title, "Copy message text");
  assert.equal(more.title, "More message actions");
  assertDecorativeSvgControl(reply, "reply");
  assertDecorativeSvgControl(save, "save");
  assertDecorativeSvgControl(copy, "copy");
  assertDecorativeSvgControl(more, "more");

  reply.focus();
  assert.equal(document.activeElement, reply);
  assert.equal(row.contains(document.activeElement), true);
  await click(reply);
  await click(copy);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "openThread").args, ["message-12"]);
  assert.deepEqual(writes, ["Message 12"]);

  await click(more);
  const overflow = toolbar.querySelector('[role="group"][aria-label="More message actions"]');
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(more.getAttribute("aria-controls"), overflow.id);
  assert.equal(toolbar.dataset.actionsExpanded, "true");
  assert.equal(overflow.hidden, false);
  assert.match(overflow.textContent, /Mark unread/);
  assert.equal(overflow.querySelector('button[aria-label="Save"]'), null);

  await click(more);
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal(overflow.hidden, true);
  await keyboardActivate(more);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(overflow.hidden, false);

  const markUnread = overflow.querySelector('button[aria-label="Mark unread"]');
  assert.equal(markUnread.title, "Mark unread from this message");
  await click(markUnread);
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "markUnread"),
    [{ name: "markUnread", args: [{ conversationId, fromSequence: 12 }] }],
  );
});

test("announces failure when the Clipboard API is unavailable", async () => {
  setClipboard(undefined);
  const container = await renderTimeline(createFixture({ cache: seedCache([message(11)]) }));

  await click(container.querySelector('button[aria-label="Copy"]'));

  assert.match(container.querySelector('[role="status"]').textContent, /Copying message failed/);
});

test("handles rejected clipboard writes and announces failure", async () => {
  setClipboard({ writeText: async () => Promise.reject(new Error("permission denied")) });
  const container = await renderTimeline(createFixture({ cache: seedCache([message(11)]) }));

  await click(container.querySelector('button[aria-label="Copy"]'));

  assert.match(container.querySelector('[role="status"]').textContent, /Copying message failed/);
});

test("does not expose Copy for deleted messages", async () => {
  const deleted = message(11, {
    content: null,
    deletedAt: now,
    deletedByUserId: otherUserId,
  });
  const container = await renderTimeline(createFixture({ cache: seedCache([deleted]) }));

  assert.equal(container.querySelector('button[aria-label="Copy"]'), null);
});

test("marks a canonical message unread through the bound action and moves the unread separator", async () => {
  const cache = seedCache([message(11), message(12), message(13), message(14)], {
    currentReadState: readState(userId, 13),
  });
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture);
  const initialSeparator = container.querySelector('[role="separator"][aria-label="Unread messages"]');
  assert.equal(initialSeparator.nextElementSibling.dataset.messageId, "message-14");

  const markUnreadButton = [...container.querySelectorAll('[data-message-id="message-12"] button')]
    .find(({ textContent }) => textContent === "Mark unread");
  markUnreadButton.focus();
  await click(markUnreadButton);

  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "markUnread"),
    [{ name: "markUnread", args: [{ conversationId, fromSequence: 12 }] }],
  );
  assert.equal(document.activeElement, markUnreadButton);
  assert.match(container.querySelector('[role="status"]').textContent, /Marking message unread complete/);
  const movedSeparator = container.querySelector('[role="separator"][aria-label="Unread messages"]');
  assert.equal(movedSeparator.nextElementSibling.dataset.messageId, "message-12");
});

test("does not expose Mark unread for deleted, sending, or failed messages", async () => {
  const cache = seedCache([message(11, {
    content: null,
    deletedAt: now,
    deletedByUserId: otherUserId,
  })]);
  cache.insertOptimisticMessage({
    ...message(12, { id: "optimistic-sending", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-sending",
      idempotencyKey: "send-sending",
      retryable: true,
      attempt: 1,
    },
  });
  cache.insertOptimisticMessage({
    ...message(13, { id: "optimistic-failed", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-failed",
      idempotencyKey: "send-failed",
      retryable: true,
      attempt: 1,
    },
  });
  cache.failOptimisticMessage("client-failed", "transport", true);
  const container = await renderTimeline(createFixture({ cache }));

  for (const messageId of ["message-11", "optimistic-sending", "optimistic-failed"]) {
    assert.equal(
      [...container.querySelectorAll(`[data-message-id="${messageId}"] button`)]
        .some(({ textContent }) => textContent === "Mark unread"),
      false,
    );
  }
});

test("renders only canonical aggregates, keeps unknown keys toggleable, and gates the picker trigger", async () => {
  const sentId = "canonical-sent";
  const sendingId = "optimistic-sending-reaction";
  const failedId = "optimistic-failed-reaction";
  const deletedId = "canonical-deleted-reaction";
  const cache = seedCache([
    message(11, {
      id: sentId,
      reactions: [{
        reactionKey: "custom:party-parrot",
        count: 4,
        reactedByCurrentUser: true,
      }],
    }),
    message(14, {
      id: deletedId,
      content: null,
      deletedAt: now,
      deletedByUserId: otherUserId,
    }),
  ]);
  cache.insertOptimisticMessage({
    ...message(12, { id: sendingId, author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-sending-reaction",
      idempotencyKey: "send-sending-reaction",
      retryable: true,
      attempt: 1,
    },
  });
  cache.insertOptimisticMessage({
    ...message(13, { id: failedId, author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-failed-reaction",
      idempotencyKey: "send-failed-reaction",
      retryable: true,
      attempt: 1,
    },
  });
  cache.failOptimisticMessage("client-failed-reaction", "transport", true);
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture, { reactionKeys: ["👍", "👀", "👍"] });

  const reactionButtons = (messageId) =>
    container.querySelectorAll(`[data-message-id="${messageId}"] .handrail-chat__timeline-reaction`);
  assert.equal(reactionButtons(sentId).length, 1);
  assert.equal(container.querySelector(`[data-message-id="${sentId}"] [aria-label="Add 👍 reaction"]`), null);
  assert.equal(container.querySelector(`[data-message-id="${sentId}"] [aria-label="Add 👀 reaction"]`), null);
  const unknownAggregate = container.querySelector(
    `[data-message-id="${sentId}"] [aria-label="Remove custom:party-parrot reaction"]`,
  );
  assert.equal(unknownAggregate.getAttribute("aria-pressed"), "true");
  assert.match(unknownAggregate.textContent, /4/u);
  assert.notEqual(
    container.querySelector(`[data-message-id="${sentId}"] button[aria-label="Add reaction"]`),
    null,
  );
  assert.equal(
    container.querySelector(`[data-message-id="${sentId}"]`)
      .classList.contains("handrail-chat__timeline-item--reaction-eligible"),
    true,
  );
  for (const messageId of [sendingId, failedId, deletedId]) {
    assert.equal(reactionButtons(messageId).length, 0);
    assert.equal(
      container.querySelector(`[data-message-id="${messageId}"] button[aria-label="Add reaction"]`),
      null,
    );
    assert.equal(
      container.querySelector(`[data-message-id="${messageId}"]`)
        .classList.contains("handrail-chat__timeline-item--reaction-eligible"),
      false,
    );
  }

  await click(unknownAggregate);
  const reactionCalls = fixture.calls.filter(({ name }) => name === "setReaction");
  assert.deepEqual(reactionCalls, [{
    name: "setReaction",
    args: [{ messageId: sentId, reactionKey: "custom:party-parrot", reacted: false }],
  }]);
  for (const messageId of [sendingId, failedId, deletedId]) {
    assert.equal(reactionCalls.some(({ args }) => args[0].messageId === messageId), false);
  }
});

test("picker selections emit exact add/remove mutations and reconcile aggregate state", async () => {
  const sentId = "canonical-picker";
  const baseMessage = message(11, {
    id: sentId,
    reactions: [{ reactionKey: "👍", count: 2, reactedByCurrentUser: false }],
  });
  const cache = seedCache([baseMessage]);
  const fixture = createFixture({ cache });
  fixture.client.setReaction = async (input) => {
    fixture.calls.push({ name: "setReaction", args: [input] });
    const idempotencyKey = `picker-reaction-${fixture.calls.length}`;
    const operation = input.reacted ? "add_reaction" : "remove_reaction";
    cache.beginOptimisticReaction({
      idempotencyKey,
      messageId: input.messageId,
      operation,
      reactionKey: input.reactionKey,
    });
    cache.reconcileOptimisticReaction(idempotencyKey, {
      count: input.reacted ? 3 : 2,
      messageId: input.messageId,
      operation,
      reactedByCurrentUser: input.reacted,
      reactionKey: input.reactionKey,
      reconciliationStatus: "applied",
    });
    return { status: "success" };
  };
  const container = await renderTimeline(fixture);
  const row = container.querySelector(`[data-message-id="${sentId}"]`);
  const trigger = row.querySelector('button[aria-label="Add reaction"]');
  assert.ok(trigger.querySelector('svg.handrail-chat__timeline-reaction-picker-icon[aria-hidden="true"]'));
  assert.doesNotMatch(trigger.textContent, /☺\+/u);

  await click(trigger);
  const picker = row.querySelector('.handrail-chat__reaction-picker');
  assert.equal(picker.getAttribute("popover"), "manual");
  assert.equal(picker.style.position, "fixed");
  assert.equal(document.activeElement, row.querySelector('input[aria-label="Search reactions"]'));
  await click(row.querySelector('button[data-reaction-key="👍"]'));
  assert.equal(document.activeElement, trigger);
  let aggregate = row.querySelector('button[aria-label="Remove 👍 reaction"]');
  assert.notEqual(aggregate, null);
  assert.equal(aggregate.getAttribute("aria-pressed"), "true");
  assert.match(aggregate.textContent, /3/u);

  await click(trigger);
  await click(row.querySelector('button[data-reaction-key="👍"]'));
  assert.equal(document.activeElement, trigger);
  aggregate = row.querySelector('button[aria-label="Add 👍 reaction"]');
  assert.notEqual(aggregate, null);
  assert.equal(aggregate.getAttribute("aria-pressed"), "false");
  assert.match(aggregate.textContent, /2/u);
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "setReaction"), [
    { name: "setReaction", args: [{ messageId: sentId, reactionKey: "👍", reacted: true }] },
    { name: "setReaction", args: [{ messageId: sentId, reactionKey: "👍", reacted: false }] },
  ]);
});

test("picker dismissals restore trigger focus and failed mutations are announced", async () => {
  const sentId = "canonical-picker-dismiss";
  const fixture = createFixture({ cache: seedCache([message(11, { id: sentId })]) });
  fixture.client.setReaction = (input) => {
    fixture.calls.push({ name: "setReaction", args: [input] });
    return Promise.resolve({ status: "error" });
  };
  const container = await renderTimeline(fixture);
  const row = container.querySelector(`[data-message-id="${sentId}"]`);
  const trigger = row.querySelector('button[aria-label="Add reaction"]');

  await click(trigger);
  await click(row.querySelector('button[aria-label="Close reaction picker"]'));
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  await keyDown(row.querySelector('input[aria-label="Search reactions"]'), "Escape");
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  await pointerDown(container.querySelector(`[data-message-id="${sentId}"] .handrail-chat__timeline-text`));
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  await click(row.querySelector('button[data-reaction-key="🚀"]'));
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(fixture.calls.filter(({ name }) => name === "setReaction"), [{
    name: "setReaction",
    args: [{ messageId: sentId, reactionKey: "🚀", reacted: true }],
  }]);
  assert.match(container.querySelector('[role="status"]').textContent, /Updating reaction failed/u);
});

test("projects pending, failed, edited, deleting, and deleted states and dispatches actions", async () => {
  const canonical = [
    message(11),
    message(12),
    message(13),
    message(14, {
      content: null,
      deletedAt: now,
      deletedByUserId: otherUserId,
    }),
  ];
  const cache = seedCache(canonical);
  cache.beginOptimisticMessageEdit({
    operation: "edit",
    messageId: "message-11",
    expectedRevision: 1,
    content: { format: "plain", text: "Pending edit" },
    idempotencyKey: "edit-11",
  });
  cache.beginOptimisticMessageDelete({
    operation: "delete",
    messageId: "message-12",
    expectedRevision: 1,
    idempotencyKey: "delete-12",
  });
  cache.beginOptimisticMessageEdit({
    operation: "edit",
    messageId: "message-13",
    expectedRevision: 1,
    content: { format: "plain", text: "Conflicting edit" },
    idempotencyKey: "edit-13",
  });
  const conflictMessage = message(13, { revision: { revision: 2 } });
  const {
    reactions: _reactions,
    attachmentMetadata: _attachmentMetadata,
    isThreadRoot: _isThreadRoot,
    threadSummary: _threadSummary,
    ...canonicalConflictMessage
  } = conflictMessage;
  cache.reconcileOptimisticMessageEdit("edit-13", {
    operation: "edit",
    reconciliationStatus: "revision_conflict",
    expectedRevision: 1,
    message: canonicalConflictMessage,
    canonicalRevision: 2,
  });
  cache.insertOptimisticMessage({
    ...message(15, { id: "optimistic-15", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-15",
      idempotencyKey: "send-15",
      retryable: true,
      attempt: 1,
    },
  });
  cache.insertOptimisticMessage({
    ...message(16, { id: "optimistic-16", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-16",
      idempotencyKey: "send-16",
      retryable: true,
      attempt: 1,
    },
  });
  cache.failOptimisticMessage("client-16", "transport", true);
  const fixture = createFixture({ cache });
  const container = await renderTimeline(fixture, { currentUserId: otherUserId });

  assert.equal(container.querySelector('[data-message-id="message-11"] [data-edit-state="pending"]') !== null, true);
  assert.match(container.querySelector('[data-message-id="message-12"]').textContent, /Deleting message/);
  assert.match(container.querySelector('[data-message-id="message-13"]').textContent, /Edit conflict/);
  assert.match(container.querySelector('[data-message-id="message-14"]').textContent, /message was deleted/);
  assert.match(container.querySelector('[data-message-id="optimistic-15"]').textContent, /Sending/);
  assert.match(container.querySelector('[data-message-id="optimistic-16"]').textContent, /Send failed/);

  const retryButton = container.querySelector('[data-message-id="optimistic-16"] button[aria-label="Retry"]');
  assert.equal(retryButton.title, "Retry sending message");
  assertDecorativeSvgControl(retryButton, "retry");
  await click(retryButton);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "retryMessage").args, ["client-16"]);

  const deleteButton = [...container.querySelectorAll('[data-message-id="message-13"] button')]
    .find((button) => button.textContent === "Delete");
  deleteButton.focus();
  await click(deleteButton);
  assert.equal(document.activeElement, deleteButton);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "deleteMessage").args, [{ messageId: "message-13", expectedRevision: 2 }]);
  assert.match(container.querySelector('[role="status"]').textContent, /Deleting message complete/);
});

test("gates Edit and Delete by trusted ownership with fail-closed defaults and independent host overrides", async () => {
  const cache = seedCache([message(11), message(12)]);
  const fixture = createFixture({ cache });
  const ownedContainer = await renderTimeline(fixture, { currentUserId: userId });
  const otherRow = ownedContainer.querySelector('[data-message-id="message-11"]');
  const ownedRow = ownedContainer.querySelector('[data-message-id="message-12"]');

  assert.equal([...otherRow.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit"), false);
  assert.equal([...otherRow.querySelectorAll("button")].some(({ textContent }) => textContent === "Delete"), false);
  assert.equal([...ownedRow.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit"), true);
  assert.equal([...ownedRow.querySelectorAll("button")].some(({ textContent }) => textContent === "Delete"), true);

  const missingIdentityContainer = await renderTimeline(fixture);
  assert.equal([...missingIdentityContainer.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit"), false);
  assert.equal([...missingIdentityContainer.querySelectorAll("button")].some(({ textContent }) => textContent === "Delete"), false);

  const moderatorContainer = await renderTimeline(fixture, {
    resolveMessageMutationAvailability: ({ id }) => id === "message-11"
      ? { canEdit: false, canDelete: true }
      : { canEdit: false, canDelete: false },
  });
  const moderatedRow = moderatorContainer.querySelector('[data-message-id="message-11"]');
  assert.equal([...moderatedRow.querySelectorAll("button")].some(({ textContent }) => textContent === "Edit"), false);
  assert.equal([...moderatedRow.querySelectorAll("button")].some(({ textContent }) => textContent === "Delete"), true);
});

test("the edit controller opens the latest eligible owned sent row with a stable caret and restores focus on Escape", async () => {
  const fixture = createFixture({ cache: seedCache([message(10), message(12)]) });
  const editControllerRef = React.createRef();
  const container = await renderTimeline(fixture, {
    currentUserId: userId,
    editControllerRef,
  });
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();

  let handled = false;
  await act(async () => {
    handled = editControllerRef.current.requestLatestMessageEdit(composer);
    await Promise.resolve();
  });

  assert.equal(handled, true);
  const editor = container.querySelector('textarea[id="edit-message-12"]');
  assert.notEqual(editor, null);
  assert.equal(document.activeElement, editor);
  assert.equal(editor.selectionStart, editor.value.length);
  assert.equal(editor.selectionEnd, editor.value.length);

  await keyDown(editor, "Escape");
  assert.equal(container.querySelector('textarea[id="edit-message-12"]'), null);
  assert.equal(document.activeElement, composer);
  composer.remove();
});

test("the edit controller skips every later ineligible state and leaves custom message renderers untouched", async () => {
  const cache = seedCache([
    message(10),
    message(11),
    message(12),
    message(13, {
      author: { type: "user", userId },
      content: null,
      deletedAt: now,
      deletedByUserId: userId,
    }),
  ]);
  cache.insertOptimisticMessage({
    ...message(14, { id: "optimistic-edit-sending", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-edit-sending",
      idempotencyKey: "send-edit-sending",
      retryable: true,
      attempt: 1,
    },
  });
  cache.insertOptimisticMessage({
    ...message(15, { id: "optimistic-edit-failed", author: { type: "user", userId } }),
    delivery: {
      state: "sending",
      clientMessageId: "client-edit-failed",
      idempotencyKey: "send-edit-failed",
      retryable: true,
      attempt: 1,
    },
  });
  cache.failOptimisticMessage("client-edit-failed", "transport", true);
  const fixture = createFixture({ cache });
  const editControllerRef = React.createRef();
  const resolverTargets = [];
  const props = {
    currentUserId: userId,
    editControllerRef,
    resolveMessageMutationAvailability: (target) => {
      resolverTargets.push(target);
      return {
        canEdit: target.id !== "message-12",
        canDelete: false,
      };
    },
  };
  const container = await renderTimeline(fixture, props);

  let handled = false;
  await act(async () => {
    handled = editControllerRef.current.requestLatestMessageEdit(null);
    await Promise.resolve();
  });
  assert.equal(handled, true);
  assert.notEqual(container.querySelector('textarea[id="edit-message-10"]'), null);
  assert.equal(container.querySelector('textarea[id="edit-message-11"]'), null);
  assert.equal(container.querySelector('textarea[id="edit-message-12"]'), null);
  assert.equal(container.querySelector('textarea[id="edit-message-13"]'), null);
  assert.equal(container.querySelector('textarea[id="edit-optimistic-edit-sending"]'), null);
  assert.equal(container.querySelector('textarea[id="edit-optimistic-edit-failed"]'), null);
  assert.equal(
    resolverTargets.some(({ id, authorUserId }) =>
      id === "message-11" && authorUserId === otherUserId),
    true,
  );

  const customControllerRef = React.createRef();
  await rerenderTimeline(container, fixture, {
    ...props,
    editControllerRef: customControllerRef,
    slots: {
      Message: ({ message: value, hostProps }) => createElement(
        "div",
        { ...hostProps, "data-custom-message": value.id },
        value.content?.text,
      ),
    },
  });
  assert.equal(customControllerRef.current.requestLatestMessageEdit(null), false);
  assert.equal(container.querySelector("textarea[id^=edit-]"), null);
});

test("shortcut-opened edits retain canonical revision-conflict reconciliation", async () => {
  const editable = message(12, {
    content: { format: "plain", text: "Original text" },
    revision: { revision: 1 },
  });
  const cache = seedCache([editable]);
  const fixture = createFixture({ cache });
  let editKey = 0;
  fixture.client.editMessage = async (input) => {
    fixture.calls.push({ name: "editMessage", args: [input] });
    const idempotencyKey = `shortcut-conflict-${++editKey}`;
    cache.beginOptimisticMessageEdit({
      operation: "edit",
      messageId: input.messageId,
      expectedRevision: input.expectedRevision,
      content: input.content,
      idempotencyKey,
    });
    const conflictMessage = message(12, {
      content: { format: "plain", text: `Canonical revision ${input.expectedRevision + 1}` },
      revision: { revision: input.expectedRevision + 1 },
    });
    const {
      reactions: _reactions,
      attachmentMetadata: _attachmentMetadata,
      isThreadRoot: _isThreadRoot,
      threadSummary: _threadSummary,
      ...canonicalMessage
    } = conflictMessage;
    cache.reconcileOptimisticMessageEdit(idempotencyKey, {
      operation: "edit",
      reconciliationStatus: "revision_conflict",
      expectedRevision: input.expectedRevision,
      message: canonicalMessage,
      canonicalRevision: input.expectedRevision + 1,
    });
    return {
      status: "success",
      value: {
        reconciliationStatus: "revision_conflict",
        expectedRevision: input.expectedRevision,
        canonicalRevision: input.expectedRevision + 1,
      },
    };
  };
  const editControllerRef = React.createRef();
  const container = await renderTimeline(fixture, {
    currentUserId: userId,
    editControllerRef,
  });

  await act(async () => {
    assert.equal(editControllerRef.current.requestLatestMessageEdit(null), true);
    await Promise.resolve();
  });
  let editor = container.querySelector('textarea[id="edit-message-12"]');
  await act(async () => {
    editor.closest("form").dispatchEvent(new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "editMessage")[0].args[0].expectedRevision, 1);
  assert.match(container.querySelector('[data-message-id="message-12"]').textContent, /Edit conflict/);
  assert.match(container.querySelector('[data-message-id="message-12"]').textContent, /Canonical revision 2/);

  await click([...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Edit"));
  editor = container.querySelector('textarea[id="edit-message-12"]');
  await act(async () => {
    editor.closest("form").dispatchEvent(new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "editMessage")[1].args[0].expectedRevision, 2);
});

test("projects only renderer-safe mutation booleans and preserves Edit and Delete action inputs", async () => {
  const editable = message(12, {
    revision: { revision: 3 },
    content: { format: "plain", text: "Original text" },
  });
  const cache = seedCache([editable]);
  cache.beginOptimisticSavedMessage({
    ...savedMessageInput(editable.id, "save", 0, "private-renderer-boundary"),
    privateNote: "must never reach a message renderer",
  });
  const fixture = createFixture({ cache });
  const seen = [];
  const resolver = () => ({
    canEdit: true,
    canDelete: true,
    capabilityNames: ["message.edit", "message.delete"],
    actorContext: { private: true },
  });
  const container = await renderTimeline(fixture, {
    resolveMessageMutationAvailability: resolver,
    slots: {
      Message: (props) => {
        seen.push(props.message);
        return createElement(DefaultMessageRenderer, props);
      },
    },
  });

  const viewModel = seen.at(-1);
  assert.equal(typeof viewModel.canEdit, "boolean");
  assert.equal(typeof viewModel.canDelete, "boolean");
  assert.equal("capabilityNames" in viewModel, false);
  assert.equal("actorContext" in viewModel, false);
  assert.equal("currentUserId" in viewModel, false);
  assert.deepEqual(Object.keys(viewModel.saved).sort(), [
    "authoritativeRevision",
    "available",
    "conflict",
    "isSaved",
    "mutationState",
    "retryable",
  ]);
  assert.equal(viewModel.saved.isSaved, true);
  assert.equal(viewModel.saved.mutationState, "pending");
  assert.equal(JSON.stringify(viewModel).includes("must never reach"), false);
  assert.equal(JSON.stringify(viewModel).includes("private-renderer-boundary"), false);

  await click([...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Edit"));
  const editor = container.querySelector('textarea[id="edit-message-12"]');
  await act(async () => {
    editor.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(fixture.calls.find(({ name }) => name === "editMessage").args, [{
    messageId: "message-12",
    expectedRevision: 3,
    content: { format: "plain", text: "Original text" },
  }]);

  await click([...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Delete"));
  assert.deepEqual(fixture.calls.find(({ name }) => name === "deleteMessage").args, [{
    messageId: "message-12",
    expectedRevision: 3,
  }]);
});

test("saves an eligible message once, gates pending input, restores focus, and removes the canonical saved item", async () => {
  const selected = message(12);
  const fixture = createFixture({ cache: seedCache([selected]) });
  let completeSave;
  let key = 0;
  fixture.client.saveMessage = ({ messageId: selectedMessageId }) => {
    fixture.calls.push({ name: "saveMessage", args: [{ messageId: selectedMessageId }] });
    const revision = fixture.activeCache.getState().currentUser.savedMessageRevisions[selectedMessageId] ?? 0;
    const input = savedMessageInput(selectedMessageId, "save", revision, `saved-ui-${++key}`);
    fixture.activeCache.beginOptimisticSavedMessage(input);
    return new Promise((resolve) => {
      completeSave = () => {
        const result = savedMessageResult(input);
        fixture.activeCache.reconcileCurrentUserSavedMessage(input, result);
        resolve({ status: "success", value: result });
      };
    });
  };
  fixture.client.unsaveMessage = async ({ messageId: selectedMessageId }) => {
    fixture.calls.push({ name: "unsaveMessage", args: [{ messageId: selectedMessageId }] });
    const revision = fixture.activeCache.getState().currentUser.savedMessageRevisions[selectedMessageId] ?? 0;
    const input = savedMessageInput(selectedMessageId, "unsave", revision, `saved-ui-${++key}`);
    fixture.activeCache.beginOptimisticSavedMessage(input);
    const result = savedMessageResult(input);
    fixture.activeCache.reconcileCurrentUserSavedMessage(input, result);
    return { status: "success", value: result };
  };

  const container = await renderTimeline(fixture);
  const saveButton = container.querySelector('button[aria-label="Save"]');
  assert.equal(container.querySelectorAll('button[aria-label="Save"]').length, 1);
  assertDecorativeSvgControl(saveButton, "save");
  saveButton.focus();
  await click(saveButton);

  const pendingButton = container.querySelector('button[aria-label="Remove from saved"]');
  assert.equal(container.querySelectorAll('button[aria-label="Remove from saved"]').length, 1);
  assertDecorativeSvgControl(pendingButton, "unsave");
  assert.equal(pendingButton.disabled, true);
  assert.match(container.querySelector('[data-message-id="message-12"]').textContent, /Updating saved status/);
  await click(pendingButton);
  assert.equal(fixture.calls.filter(({ name }) => name === "saveMessage").length, 1);

  await act(async () => {
    completeSave();
    await Promise.resolve();
    await Promise.resolve();
  });
  const removeButton = container.querySelector('button[aria-label="Remove from saved"]');
  assert.equal(removeButton.disabled, false);
  assert.equal(document.activeElement, removeButton);
  assertDecorativeSvgControl(removeButton, "unsave");

  await click(removeButton);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "unsaveMessage").args, [{
    messageId: selected.id,
  }]);
  assert.notEqual(container.querySelector('button[aria-label="Save"]'), null);
});

test("offers a renderer-safe retry after failure and reports authoritative save conflicts", async () => {
  const selected = message(12);
  const retryFixture = createFixture({ cache: seedCache([selected]) });
  let failedInput;
  retryFixture.client.saveMessage = async ({ messageId: selectedMessageId }) => {
    retryFixture.calls.push({ name: "saveMessage", args: [{ messageId: selectedMessageId }] });
    failedInput = savedMessageInput(selectedMessageId, "save", 0, "saved-ui-retry");
    retryFixture.activeCache.beginOptimisticSavedMessage(failedInput);
    retryFixture.activeCache.failOptimisticSavedMessage(selectedMessageId, failedInput.idempotencyKey, "transport");
    return { status: "transport" };
  };
  retryFixture.client.retrySavedMessage = async (selectedMessageId) => {
    retryFixture.calls.push({ name: "retrySavedMessage", args: [selectedMessageId] });
    retryFixture.activeCache.retryOptimisticSavedMessage(selectedMessageId, failedInput.idempotencyKey);
    const result = savedMessageResult(failedInput);
    retryFixture.activeCache.reconcileCurrentUserSavedMessage(failedInput, result);
    return { status: "success", value: result };
  };

  const retryContainer = await renderTimeline(retryFixture);
  await click(retryContainer.querySelector('button[aria-label="Save"]'));
  assert.match(retryContainer.querySelector('[data-message-id="message-12"]').textContent, /Retry is available/);
  const retrySavedButton = retryContainer.querySelector('button[aria-label="Retry saved-message update"]');
  assert.equal(retryContainer.querySelectorAll('button[aria-label="Retry saved-message update"]').length, 1);
  assertDecorativeSvgControl(retrySavedButton, "retry");
  await click(retrySavedButton);
  assert.deepEqual(retryFixture.calls.find(({ name }) => name === "retrySavedMessage").args, [selected.id]);
  assert.notEqual(retryContainer.querySelector('button[aria-label="Remove from saved"]'), null);

  const conflictFixture = createFixture({ cache: seedCache([selected]) });
  conflictFixture.client.saveMessage = async ({ messageId: selectedMessageId }) => {
    conflictFixture.calls.push({ name: "saveMessage", args: [{ messageId: selectedMessageId }] });
    const input = savedMessageInput(selectedMessageId, "save", 0, "saved-ui-conflict");
    conflictFixture.activeCache.beginOptimisticSavedMessage(input);
    const result = savedMessageResult(input, {
      reconciliationStatus: "saved_message_revision_conflict",
      savedMessageRevision: 4,
      savedMessage: { messageId: selectedMessageId, isSaved: false },
    });
    conflictFixture.activeCache.reconcileCurrentUserSavedMessage(input, result);
    return { status: "success", value: result };
  };
  const conflictContainer = await renderTimeline(conflictFixture);
  await click(conflictContainer.querySelector('button[aria-label="Save"]'));
  assert.match(conflictContainer.querySelector('[data-message-id="message-12"]').textContent, /Saved status changed elsewhere/);
  assert.notEqual(conflictContainer.querySelector('button[aria-label="Save"]'), null);
});

test("omits saved-message controls for deleted, unsent, and inaccessible messages", async () => {
  const available = message(14);
  const container = await renderTimeline(createFixture({
    cache: seedCache([
      message(11, { content: null, deletedAt: now, deletedByUserId: userId }),
      message(12, { delivery: { state: "sending", clientMessageId: "client-unsent", retryable: false } }),
      available,
    ]),
  }));
  assert.equal(container.querySelector('[data-message-id="message-11"] button[aria-label="Save"]'), null);
  assert.equal(container.querySelector('[data-message-id="message-12"] button[aria-label="Save"]'), null);
  assert.notEqual(container.querySelector('[data-message-id="message-14"] button[aria-label="Save"]'), null);

  const inaccessibleContainer = await renderTimeline(createFixture({
    cache: seedCache([message(16)], { conversationOverrides: { archivedAt: now } }),
  }));
  assert.equal(inaccessibleContainer.querySelector('[data-message-id="message-16"] button[aria-label="Save"]'), null);
});

test("closes an edit form when host edit availability is revoked", async () => {
  const fixture = createFixture({ cache: seedCache([message(12)]) });
  const container = await renderTimeline(fixture, {
    resolveMessageMutationAvailability: () => ({ canEdit: true, canDelete: false }),
  });

  await click([...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Edit"));
  assert.notEqual(container.querySelector('textarea[id="edit-message-12"]'), null);

  await rerenderTimeline(container, fixture, {
    resolveMessageMutationAvailability: () => ({ canEdit: false, canDelete: false }),
  });
  assert.equal(container.querySelector('textarea[id="edit-message-12"]'), null);
  assert.match(container.textContent, /Message 12/);
});

test("renders every link-preview metadata combination with safe external link and image semantics", async () => {
  const blocks = Array.from({ length: 8 }, (_, mask) => ({
    type: "link_preview",
    data: {
      url: `${mask % 2 === 0 ? "https" : "http"}://example.test/articles/${mask}`,
      title: `Preview ${mask}`,
      ...(mask & 1 ? { description: `Description ${mask}` } : {}),
      ...(mask & 2 ? { siteName: `Site ${mask}` } : {}),
      ...(mask & 4 ? { imageUrl: `${mask % 2 === 0 ? "https" : "http"}://images.example.test/${mask}.png` } : {}),
    },
  }));
  const container = await renderTimeline(createFixture({
    cache: seedCache([message(11, {
      content: { format: "plain", text: "Preview combinations", blocks },
    })]),
  }));

  const cards = [...container.querySelectorAll(".handrail-chat__timeline-link-preview")];
  assert.equal(cards.length, 8);
  assert.equal(container.querySelectorAll(".handrail-chat__timeline-link-preview-description").length, 4);
  assert.equal(container.querySelectorAll(".handrail-chat__timeline-link-preview-site").length, 4);
  assert.equal(container.querySelectorAll(".handrail-chat__timeline-link-preview-image").length, 4);
  for (const [index, card] of cards.entries()) {
    const anchor = card.querySelector("a");
    assert.equal(anchor.href, `${index % 2 === 0 ? "https" : "http"}://example.test/articles/${index}`);
    assert.equal(anchor.target, "_blank");
    assert.deepEqual(new Set(anchor.rel.split(/\s+/)), new Set(["noopener", "noreferrer"]));
    const image = card.querySelector("img");
    if (index & 4) {
      assert.equal(image.loading, "lazy");
      assert.equal(image.decoding, "async");
      assert.equal(image.referrerPolicy, "no-referrer");
    } else {
      assert.equal(image, null);
    }
  }
});

test("keeps malformed, non-HTTP, unsafe, and invalid optional link-preview payloads inert", async () => {
  const rejected = [
    { url: "javascript:alert(1)", title: "JavaScript destination" },
    { url: "data:text/html,<script>alert(1)</script>", title: "Data destination" },
    { url: "not a url", title: "Malformed destination" },
    { url: "ftp://example.test/file", title: "Non-HTTP destination" },
    { url: "https://example.test/path\nheader", title: "Control character destination" },
    { url: "https://example.test/js-image", title: "JavaScript image", imageUrl: "javascript:alert(1)" },
    { url: "https://example.test/data-image", title: "Data image", imageUrl: "data:image/png;base64,AAAA" },
    { url: "https://example.test/bad-image", title: "Malformed image", imageUrl: "not an image URL" },
    { url: "https://example.test/empty-image", title: "Empty image", imageUrl: "  " },
    { url: "https://example.test/empty-description", title: "Empty optional text", description: "" },
  ].map((data) => ({ type: "link_preview", data }));
  const rawHtmlTitle = '<img src="x" onerror="globalThis.linkPreviewExecuted=true">';
  const blocks = [
    ...rejected,
    { type: "link.preview", data: { url: "https://example.test/alias", title: "Alias" } },
    { type: "link_preview", data: { url: "https://example.test/safe", title: rawHtmlTitle } },
  ];
  globalThis.linkPreviewExecuted = false;
  const container = await renderTimeline(createFixture({
    cache: seedCache([message(11, {
      content: { format: "plain", text: "Unsafe previews", blocks },
    })]),
  }));

  assert.equal(container.querySelectorAll(".handrail-chat__timeline-unknown-block").length, rejected.length + 1);
  assert.equal(container.querySelectorAll(".handrail-chat__timeline-link-preview").length, 1);
  assert.equal(container.querySelector(".handrail-chat__timeline-link-preview img"), null);
  assert.equal(container.querySelector("script, [onerror]"), null);
  assert.equal(globalThis.linkPreviewExecuted, false);
  assert.match(container.textContent, /<img src="x" onerror=/);
  delete globalThis.linkPreviewExecuted;
});

test("renders unread and DM receipt state, reactions, renderers, safe fallback, and root thread summaries", async () => {
  const rich = message(11, {
    author: { type: "user", userId },
    content: {
      format: "plain",
      text: "Rich message",
      blocks: [
        { type: "system_event", data: { kind: "member_joined", summary: "Other User joined" } },
        { type: "link_preview", data: {
          url: " HTTPS://Example.TEST:443/release ",
          title: " Release notes ",
          description: " What changed ",
          siteName: " Handrail ",
          imageUrl: " https://images.example.test/release.png ",
          providerDescriptor: { private: true },
        } },
        { type: "entity_reference", data: { entity: { type: "invoice", id: "42" }, label: "Invoice 42" } },
        { type: "future.widget", data: { html: "<img onerror=alert(1)>" } },
      ],
    },
    reactions: [{ reactionKey: "👍", count: 2, reactedByCurrentUser: false }],
    attachmentMetadata: [{
      attachmentId: "attachment-1",
      fileName: "proof.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      downloadUrl: "/files/proof.txt",
    }],
    isThreadRoot: true,
    threadSummary: {
      threadId,
      replyCount: 2,
      participantIds: [otherUserId],
      unreadCount: 1,
      lastReplyAt: now,
    },
  });
  const cache = seedCache([rich, message(12)], {
    currentReadState: readState(userId, 10, { manualUnreadFromSequence: 11 }),
  });
  const fixture = createFixture({ cache });
  const threadConversation = {
    id: threadId,
    tenantId,
    type: "thread",
    visibility: "private",
    parentConversationId: conversationId,
    rootMessageId: "message-11",
    createdAt: now,
    updatedAt: now,
    activityAt: now,
    latestSequence: 1,
    unreadMentionCount: 0,
    activeMemberUserIds: [userId, otherUserId],
    currentMember: { ...member(userId), conversationId: threadId },
    currentReadState: { ...readState(userId, 0), conversationId: threadId },
    currentPreference: {
      ...conversation.currentPreference,
      conversationId: threadId,
    },
  };
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope: { type: "organization" },
    items: [conversation, threadConversation],
    page: {},
    _meta: snapshotMetadata,
  });
  cache.hydrateMessageTimeline({
    conversationId: threadId,
    messages: [{
      ...message(1, {
        id: "thread-reply-1",
        conversationId: threadId,
        content: { format: "plain", text: "thread reply body" },
      }),
    }],
    pagination: { older: { available: false }, newer: { available: false } },
    replay: { resumeFrom: { eventId: "thread-event-1" } },
  });
  const seen = [];
  const slot = (name) => (props) => {
    seen.push({ name, props });
    return createElement("div", { [`data-slot-${name}`]: "true", ...props.hostProps }, name);
  };
  const container = await renderTimeline(fixture, {
    otherMemberReadState: readState(otherUserId, 11),
    slots: {
      Attachment: slot("attachment"),
      LinkPreview: slot("link-preview"),
      SystemEvent: slot("system"),
      EntityReference: slot("entity"),
    },
  });

  assert.match(container.textContent, /Unread messages/);
  assert.equal(container.querySelector('[aria-label="Read by recipient"]') !== null, true);
  assert.equal(container.querySelector('[data-slot-attachment="true"]') !== null, true);
  assert.equal(container.querySelector('[data-slot-link-preview="true"]') !== null, true);
  assert.equal(container.querySelector('[data-slot-system="true"]') !== null, true);
  assert.equal(container.querySelector('[data-slot-entity="true"]') !== null, true);
  assert.match(container.textContent, /Unsupported message content: future.widget/);
  assert.equal(container.innerHTML.includes("onerror"), false);
  assert.equal(seen.find(({ name }) => name === "attachment").props.attachment.attachment.fileName, "proof.txt");
  const linkPreviewProps = seen.find(({ name }) => name === "link-preview").props;
  assert.deepEqual(linkPreviewProps.linkPreview, {
    url: "https://example.test/release",
    title: "Release notes",
    description: "What changed",
    siteName: "Handrail",
    imageUrl: "https://images.example.test/release.png",
  });
  assert.equal(Object.isFrozen(linkPreviewProps.linkPreview), true);
  assert.equal("providerDescriptor" in linkPreviewProps.linkPreview, false);
  assert.equal(linkPreviewProps.hostProps["aria-label"], "Link preview for Release notes");
  assert.equal("tenantId" in seen.find(({ name }) => name === "system").props.event, false);

  await click(container.querySelector('[aria-label="Add 👍 reaction"]'));
  assert.deepEqual(fixture.calls.find(({ name }) => name === "setReaction").args, [{ messageId: "message-11", reactionKey: "👍", reacted: true }]);
  await click(container.querySelector('[aria-label^="Open thread"]'));
  assert.deepEqual(fixture.calls.find(({ name }) => name === "openThread").args, ["message-11"]);
  assert.equal(container.textContent.includes("thread reply body"), false);
});

test("renders compact author times and one local-date separator per day without changing grouping or navigation", async () => {
  const firstDay = new Date(2036, 0, 2, 23, 58);
  const firstDayFollowup = new Date(2036, 0, 2, 23, 59);
  const secondDay = new Date(2036, 0, 3, 0, 0);
  const sameAuthor = { type: "user", userId: otherUserId };
  const localDateKey = (date) => [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
  const pageMessages = [
    message(11, { author: sameAuthor, createdAt: firstDay.toISOString(), updatedAt: firstDay.toISOString() }),
    message(12, { author: sameAuthor, createdAt: firstDayFollowup.toISOString(), updatedAt: firstDayFollowup.toISOString() }),
    message(13, { author: sameAuthor, createdAt: secondDay.toISOString(), updatedAt: secondDay.toISOString() }),
  ];
  const fixture = createFixture({
    cache: seedCache(pageMessages, { currentReadState: readState(userId, 12) }),
  });
  const container = await renderTimeline(fixture);
  const separators = [...container.querySelectorAll('.handrail-chat__timeline-date[role="separator"]')];
  const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
  const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "medium" });
  const expectedLabels = [dateFormatter.format(firstDay), dateFormatter.format(secondDay)];

  assert.equal(separators.length, 2);
  assert.deepEqual(separators.map((separator) => separator.getAttribute("aria-label")), expectedLabels);
  assert.deepEqual(
    separators.map((separator) => ({
      dateTime: separator.querySelector("time").dateTime,
      label: separator.querySelector("time").textContent,
    })),
    [firstDay, secondDay].map((date, index) => ({
      dateTime: localDateKey(date),
      label: expectedLabels[index],
    })),
  );

  const articles = [...container.querySelectorAll('[role="article"][data-message-id]')];
  assert.equal(articles[0].querySelector(".handrail-chat__timeline-author") !== null, true);
  assert.equal(articles[1].querySelector(".handrail-chat__timeline-author"), null);
  assert.equal(articles[2].querySelector(".handrail-chat__timeline-author") !== null, true);
  const authorTimes = [articles[0], articles[2]].map((article) =>
    article.querySelector(".handrail-chat__timeline-author time"));
  assert.deepEqual(
    authorTimes.map((time) => ({
      accessibleLabel: time.getAttribute("aria-label"),
      dateTime: time.dateTime,
      label: time.textContent,
      title: time.title,
    })),
    [firstDay, secondDay].map((date) => ({
      accessibleLabel: dateTimeFormatter.format(date),
      dateTime: date.toISOString(),
      label: timeFormatter.format(date),
      title: dateTimeFormatter.format(date),
    })),
  );
  assert.deepEqual(
    articles.map((article) => [article.getAttribute("aria-posinset"), article.getAttribute("aria-setsize")]),
    [["1", "3"], ["2", "3"], ["3", "3"]],
  );

  const unreadSeparator = container.querySelector('.handrail-chat__timeline-unread[role="separator"]');
  assert.equal(separators[1].nextElementSibling, unreadSeparator);
  assert.equal(unreadSeparator.nextElementSibling, articles[2]);
  assert.equal(separators.every((separator) => !separator.hasAttribute("data-message-id")), true);

  articles[0].focus();
  await keyDown(articles[0], "ArrowDown");
  assert.equal(document.activeElement, articles[1]);
  await keyDown(articles[1], "End");
  assert.equal(document.activeElement, articles[2]);
  await keyDown(articles[2], "ArrowUp");
  assert.equal(document.activeElement, articles[1]);
  await keyDown(articles[1], "Home");
  assert.equal(document.activeElement, articles[0]);
});

test("labels the current local-day separator as Today while retaining its full accessible date", async () => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const fixture = createFixture({
    cache: seedCache([message(11, {
      createdAt: today.toISOString(),
      updatedAt: today.toISOString(),
    })]),
  });
  const container = await renderTimeline(fixture);
  const separator = container.querySelector(
    '.handrail-chat__timeline-date[role="separator"]',
  );
  const fullDateLabel = new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
  }).format(today);
  const expectedDayKey = [
    today.getFullYear().toString().padStart(4, "0"),
    (today.getMonth() + 1).toString().padStart(2, "0"),
    today.getDate().toString().padStart(2, "0"),
  ].join("-");

  assert.ok(separator);
  assert.equal(separator.getAttribute("aria-label"), `Today, ${fullDateLabel}`);
  assert.equal(separator.querySelector("time").textContent, "Today");
  assert.equal(separator.querySelector("time").dateTime, expectedDayKey);
});

test("supports keyboard feed navigation plus loading, empty, error, and Message slot overrides", async () => {
  const fixture = createFixture({ cache: seedCache([message(11), message(12)]) });
  const calls = [];
  const container = await renderTimeline(fixture, {
    slots: {
      Message: ({ message: value, hostProps }) => {
        calls.push(value);
        return createElement("div", { ...hostProps, "data-custom-message": value.id }, value.content?.text);
      },
    },
  });
  const items = container.querySelectorAll("[data-message-id]");
  items[0].focus();
  await act(async () => items[0].dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  assert.equal(document.activeElement, items[1]);
  assert.deepEqual(new Set(calls.map(({ id }) => id)), new Set(["message-11", "message-12"]));

  const emptyFixture = createFixture({ cache: seedCache([]) });
  const emptyContainer = await renderTimeline(emptyFixture);
  assert.match(emptyContainer.textContent, /No messages yet/);

  const loadingFixture = createFixture({ cache: createNormalizedChatCache({ tenantId, userId, sessionId: "loading" }) });
  const loadingContainer = await renderTimeline(loadingFixture);
  assert.match(loadingContainer.textContent, /Loading messages/);

  const errorFixture = createFixture({ cache: seedCache([]) });
  errorFixture.context = {
    ...errorFixture.context,
    isReady: false,
    readiness: "error",
    error: { code: "offline", message: "Network unavailable" },
  };
  const errorContainer = await renderTimeline(errorFixture);
  assert.match(errorContainer.textContent, /Messages unavailable/);
  assert.match(errorContainer.textContent, /Network unavailable/);
});

// Real source runtime; only its snapshot-reader boundary is controlled here.
const { createMessageContextRuntime } = await import(buildModule("client/message-context.js"));
const canonicalSource = (row) => {
  const { isThreadRoot, reactions, attachmentMetadata, ...canonical } = row;
  return canonical;
};
const deferredReply = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const replyFixture = ({ source = message(1), rows = [message(11, { replyTo: { messageId: source.id, ping: false } })], lookup, pages } = {}) => {
  const fixture = createFixture({ cache: seedCache(rows) });
  let currentSource = canonicalSource(source);
  const requests = [];
  const result = () => ({ conversationId: source.conversationId, messageId: source.id,
    status: currentSource.deletedAt === undefined ? "available" : "deleted", sequence: source.sequence, message: currentSource });
  const runtime = createMessageContextRuntime({ cache: fixture.activeCache, online: () => true,
    reader: {
      getMessageContext: async target => {
        requests.push({ kind: "context", ...target });
        return lookup ? lookup(target, result) : { status: "success", value: result() };
      },
      getMessageTimeline: async query => {
        requests.push({ kind: "page", ...query });
        return pages ? pages(query) : { status: "success", value: timeline([], false, query.conversationId) };
      },
    },
  });
  fixture.client.messageContext = runtime.api;
  const update = (row) => {
    currentSource = canonicalSource(row);
    runtime.handleCanonicalEvent({ type: row.deletedAt === undefined ? "message.updated" : "message.deleted",
      eventId: `reply-event-${row.revision.revision}`, protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId, streamId: source.conversationId, occurredAt: now, payload: { message: currentSource } });
  };
  return { ...fixture, runtime, requests, update, result };
};
const reference = container => container.querySelector('.handrail-chat__reply-reference');

test("reply references render immediate bounded text, escape markup, and preserve legacy thread Reply", async () => {
  const source = message(1, { content: { format: "plain", text: '<img src=x onerror=alert(1)>' + 'x'.repeat(600) },
    replyTo: { messageId: "grandparent-secret", ping: false } });
  const fixture = replyFixture({ source, rows: [message(11, { replyTo: { messageId: source.id, ping: false } }), message(12)] });
  const container = await renderTimeline(fixture);
  const ref = reference(container);
  assert.equal(ref.dataset.replyStatus, "available");
  assert.match(ref.textContent, /Reply to Other User: <img/);
  assert.ok(ref.textContent.length < 340);
  assert.equal(ref.querySelector('img'), null);
  assert.deepEqual(fixture.requests.map(request => request.messageId), [source.id]);
  assert.equal(container.querySelector('[data-message-id="message-12"] .handrail-chat__reply-reference'), null);
  await click(container.querySelector('button[aria-label="Reply"]'));
  assert.ok(fixture.calls.some(call => call.name === "openThread"));
  const styles = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.handrail-chat__reply-reference button\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
});

test("default and custom reply slots refresh on edits, reconnect, deletion and revocation without stale disclosure", async () => {
  for (const custom of [false, true]) {
    let context;
    const fixture = replyFixture();
    const slots = custom ? { Message: props => {
      context = props.message.replyContext;
      return createElement('div', { 'data-custom-reply': context?.status },
        context?.status === 'available' ? `${context.authorLabel}: ${context.preview}` : context?.status);
    } } : undefined;
    const container = await renderTimeline(fixture, slots ? { slots } : {});
    assert.match(container.textContent, /Other User/);
    if (custom) {
      assert.ok(Object.isFrozen(context));
      assert.deepEqual(Object.keys(context).sort(), ['authorLabel', 'conversationId', 'jump', 'messageId', 'preview', 'status']);
    }
    await act(async () => fixture.update(message(1, { revision: { revision: 2 }, content: { format: 'plain', text: 'Edited immediate source' } })));
    assert.match(container.textContent, /Edited immediate source/);
    await act(async () => fixture.runtime.connectionChanged(false));
    assert.doesNotMatch(container.textContent, /Edited immediate source/);
    if (custom) { assert.equal(context.status, 'error'); assert.equal(context.preview, undefined); assert.equal(context.jump, undefined); }
    await act(async () => fixture.runtime.connectionChanged(true));
    assert.match(container.textContent, /Edited immediate source/);
    await act(async () => fixture.update(message(1, { revision: { revision: 3 }, content: null, deletedAt: now, deletedByUserId: otherUserId })));
    assert.doesNotMatch(container.textContent, /Edited immediate source/);
    if (custom) { assert.equal(context.status, 'deleted'); assert.equal(context.authorLabel, undefined); assert.equal(context.jump, undefined); }
    else { assert.equal(reference(container).dataset.replyStatus, 'deleted'); assert.equal(reference(container).querySelector('button').disabled, true); }
    await act(async () => fixture.runtime.revoke(conversationId));
    if (custom) { assert.equal(context.status, 'unavailable'); assert.equal(context.retry, undefined); }
    else { assert.match(reference(container).textContent, /unavailable/); assert.equal(reference(container).querySelector('button').disabled, true); }
    await unmountTimeline(container);
  }
});

test("reply loading and retryable errors are explicit and never disclose failed response data", async () => {
  const gate = deferredReply();
  let attempts = 0;
  const fixture = replyFixture({ lookup: async (_target, result) => ++attempts === 1 ? gate.promise : { status: 'success', value: result() } });
  const container = await renderTimeline(fixture);
  assert.equal(reference(container).dataset.replyStatus, 'loading');
  assert.equal(reference(container).querySelector('button').disabled, true);
  await act(async () => gate.resolve({ status: 'transport_error', error: 'private diagnostics' }));
  assert.equal(reference(container).dataset.replyStatus, 'error');
  assert.doesNotMatch(container.textContent, /private diagnostics/);
  await click([...reference(container).querySelectorAll('button')].find(button => button.textContent === 'Retry original message'));
  assert.equal(reference(container).dataset.replyStatus, 'available');
});

test("unavailable lookup and late revoked lookup leave no author, preview or jump", async () => {
  for (const revoke of [false, true]) {
    const gate = deferredReply();
    const fixture = replyFixture({ lookup: () => gate.promise });
    const container = await renderTimeline(fixture);
    if (revoke) await act(async () => fixture.runtime.revoke(conversationId));
    await act(async () => gate.resolve({ status: 'success', value: revoke ? fixture.result() :
      { conversationId, messageId: 'message-1', status: 'unavailable' } }));
    assert.equal(reference(container).dataset.replyStatus, 'unavailable');
    assert.equal(reference(container).querySelector('button').disabled, true);
    assert.doesNotMatch(reference(container).textContent, /Other User|Message 1/);
    await unmountTimeline(container);
  }
});

test("old source jump hydrates bounded pages then reveals and focuses its virtual row", async () => {
  mockTimelineViewportMetrics({ scrollHeight: 100_000, clientHeight: 400 });
  const source = message(50);
  const fixture = replyFixture({ source, pages: async query => ({ status: 'success', value: timeline(
    Array.from({ length: 25 }, (_, i) => message(query.direction === 'backward' ? 25 + i : 51 + i))) }) });
  const container = await renderTimeline(fixture);
  const trigger = reference(container).querySelector('button');
  trigger.focus();
  await click(trigger);
  const sourceRow = container.querySelector('[data-message-id="message-50"]');
  assert.ok(sourceRow);
  assert.equal(document.activeElement, sourceRow);
  assert.ok(container.querySelectorAll('[data-message-id]').length < 51);
  assert.deepEqual(fixture.requests.filter(request => request.kind === 'page').map(({ direction, limit, conversationId: id }) => [direction, limit, id]),
    [['backward', 25, conversationId], ['forward', 25, conversationId]]);
});

test("reply jump failures and cancellation restore focus and late navigation cannot focus another conversation", async () => {
  for (const outcome of ['failure', 'cancel', 'switch']) {
    const gate = deferredReply();
    const fixture = replyFixture({ pages: () => gate.promise });
    const container = await renderTimeline(fixture);
    const trigger = reference(container).querySelector('button');
    trigger.focus();
    await click(trigger);
    assert.equal(reference(container).dataset.replyStatus, 'loading_window');
    if (outcome === 'cancel') await keyDown(trigger, 'Escape');
    if (outcome === 'switch') {
      await act(async () => hydrateCachedConversation(fixture.activeCache, 'other-conversation', [message(99, { conversationId: 'other-conversation' })]));
      await rerenderTimeline(container, fixture, { conversationId: 'other-conversation' });
      container.querySelector('[data-message-id]').focus();
    }
    await act(async () => gate.resolve({ status: 'error' }));
    if (outcome === 'switch') assert.equal(document.activeElement.dataset.messageId, 'message-99');
    else assert.equal(document.activeElement.closest('[data-message-id]')?.dataset.messageId, 'message-11');
    assert.notEqual(document.activeElement.dataset.messageId, 'message-1');
  }
});

test("custom reply actions stay inside an existing thread and retained callbacks cannot navigate a later scope", async () => {
  const source = message(1, { conversationId: threadId });
  const reply = message(11, { conversationId: threadId, replyTo: { messageId: source.id, ping: false } });
  const fixture = replyFixture({ source, rows: [] });
  hydrateCachedConversation(fixture.activeCache, threadId, [reply], 10, { type: "thread", parentConversationId: conversationId, rootMessageId: "parent-root" });
  let jump;
  const slots = { Message: props => {
    if (props.message.replyContext?.status === 'available') jump = props.message.replyContext.jump;
    return createElement(DefaultMessageRenderer, props);
  } };
  const container = await renderTimeline(fixture, { conversationId: threadId, slots });
  const retained = jump;
  let result;
  await act(async () => { result = retained(); });
  assert.equal(await result, true);
  assert.equal(document.activeElement.dataset.messageId, source.id);
  assert.ok(fixture.requests.every(request => request.conversationId === threadId));
  assert.equal(fixture.calls.some(call => call.name === 'openThread'), false);
  await act(async () => hydrateCachedConversation(fixture.activeCache, 'later-scope', [message(99, { conversationId: 'later-scope' })]));
  await rerenderTimeline(container, fixture, { conversationId: 'later-scope', slots });
  const row = container.querySelector('[data-message-id="message-99"]');
  row.focus();
  const before = fixture.requests.length;
  assert.equal(await retained(), false);
  assert.equal(fixture.requests.length, before);
  assert.equal(document.activeElement, row);
});

test("cancelled successful window hydration retains timeline focus without focusing the source", async () => {
  const gate = deferredReply();
  const fixture = replyFixture({ pages: () => gate.promise });
  const container = await renderTimeline(fixture);
  const trigger = reference(container).querySelector('button');
  trigger.focus();
  await click(trigger);
  await keyDown(trigger, 'Escape');
  assert.equal(document.activeElement.closest('[data-message-id]')?.dataset.messageId, 'message-11');
  await act(async () => gate.resolve({ status: 'success', value: timeline([]) }));
  assert.notEqual(document.activeElement.dataset.messageId, 'message-1');
  assert.equal(document.activeElement, container.querySelector('.handrail-chat__timeline-viewport'));
});

test("host Current and Discord-style slot configurations render identical accessible references", async () => {
  const fixture = replyFixture();
  fixture.client.selectDirectoryUser = id => safeUser(id, '<script>untrusted author</script>' + 'a'.repeat(200));
  let style = 'Current';
  let latest;
  const slots = { Message: props => {
    latest = props.message.replyContext;
    return createElement('div', { 'data-host-reply-style': style }, createElement(DefaultMessageRenderer, props));
  } };
  const container = await renderTimeline(fixture, { slots });
  const originalText = reference(container).textContent;
  assert.equal(latest.authorLabel.length, 80);
  assert.equal(reference(container).querySelector('script'), null);
  assert.equal(container.querySelector('[data-host-reply-style]').dataset.hostReplyStyle, 'Current');
  style = 'Discord-style';
  await rerenderTimeline(container, fixture, { slots });
  assert.equal(container.querySelector('[data-host-reply-style]').dataset.hostReplyStyle, 'Discord-style');
  assert.equal(reference(container).textContent, originalText);
  assert.equal(latest.status, 'available');
  assert.equal(fixture.requests.length, 1, 'host preference changes do not change or refetch the reply source');
});
