import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const React = await import("react");
const { act, createElement, useEffect, useState } = React;
const { createRoot } = await import("react-dom/client");
const { ChatProvider } = await import("@handrail/chat/react");
const { ChatWorkspace } = await import("@handrail/chat/ui");
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
} = await import("@handrail/chat/client");
const { CHAT_PROTOCOL_VERSION } = await import("@handrail/chat");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const window = new Window({ url: "https://workspace-search.example.test" });
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  window,
});

const now = "2035-02-03T04:05:06.000Z";
const tenantId = "tenant-workspace-search";
const actorId = "user-workspace-search";
const authorId = "user-workspace-search-author";
const firstId = "conversation-workspace-search-first";
const secondId = "conversation-workspace-search-second";
const firstMessageId = "message-workspace-search-first";
const secondMessageId = "message-workspace-search-second";
const scope = Object.freeze({ type: "organization" });
const identity = Object.freeze({
  tenantId,
  userId: actorId,
  sessionId: "session-workspace-search",
});
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
const readyState = Object.freeze({
  state: "ready",
  clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  metadata,
  enabledFeatures: {},
});

const member = (conversationId) => ({
  tenantId,
  conversationId,
  userId: actorId,
  role: "member",
  state: "active",
  joinedAt: now,
  updatedAt: now,
});
const readState = (conversationId) => ({
  conversationId,
  userId: actorId,
  lastReadSequence: 0,
  updatedAt: now,
});
const conversation = (id, name) => ({
  id,
  tenantId,
  type: "channel",
  name,
  visibility: "public",
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 0,
  unreadMentionCount: 0,
  activeMemberUserIds: [actorId],
  currentMember: member(id),
  currentReadState: readState(id),
  currentPreference: {
    conversationId: id,
    userId: actorId,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: now,
  },
});
const firstConversation = conversation(firstId, "First search channel");
const secondConversation = conversation(secondId, "Second search channel");

const createCache = () => {
  const cache = createNormalizedChatCache(identity);
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope,
    items: [firstConversation, secondConversation],
    page: {},
    _meta: metadata,
  });
  for (const item of [firstConversation, secondConversation]) {
    cache.hydrateConversationDetail({
      kind: "conversation_detail",
      conversation: {
        ...item,
        memberUserIds: [],
        currentPreference: {
          conversationId: item.id,
          userId: actorId,
          notificationPreference: "all",
          mute: { muted: false },
          updatedAt: now,
        },
      },
      _meta: metadata,
    });
  }
  return cache;
};

const mergeHits = (base, page) => {
  const seen = new Set(base.map((hit) => hit.type === "message"
    ? `message:${hit.messageId}`
    : `conversation:${hit.conversationId}`));
  return [...base, ...page.filter((hit) => {
    const key = hit.type === "message"
      ? `message:${hit.messageId}`
      : `conversation:${hit.conversationId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })];
};

const createClient = (handleSearch, debounceMs = 30) => {
  const cache = createCache();
  const listeners = new Set();
  const requests = [];
  let state = Object.freeze({ state: "idle" });
  let timer;
  let generation = 0;
  const setState = (next) => {
    const previous = state;
    state = Object.freeze(next);
    for (const listener of listeners) listener(state, previous);
  };
  const cancel = () => {
    generation += 1;
    window.clearTimeout(timer);
    if (state.state !== "idle") setState({ state: "idle" });
  };
  const client = {
    endpoint: "/chat",
    state: readyState,
    cache,
    start: async () => readyState,
    close() {},
    subscribeLifecycle: () => () => undefined,
    listConversations: async () => ({ status: "closed", message: "Chat is closed." }),
    getConversation: async () => ({ status: "closed", message: "Chat is closed." }),
    selectDirectoryUser: () => undefined,
    hydrateDirectoryUsers: async () => ({ status: "success", value: { users: [] } }),
    searchDirectoryUsers: async () => ({ status: "success", value: { query: "", users: [] } }),
    getDirectorySearchState: () => ({ state: "idle" }),
    subscribeDirectorySearch: () => () => undefined,
    cancelDirectorySearch() {},
    getMessageSearchState: () => state,
    subscribeMessageSearch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelMessageSearch: cancel,
    searchMessages(input, options = {}) {
      generation += 1;
      const currentGeneration = generation;
      window.clearTimeout(timer);
      const previous = state;
      const accumulating = input.cursor !== undefined && previous.state !== "idle" &&
        previous.nextCursor === input.cursor;
      const baseHits = accumulating ? previous.hits : [];
      const baseNextCursor = accumulating ? previous.nextCursor : undefined;
      setState({
        state: "scheduled",
        query: input.query,
        ...(input.filters === undefined ? {} : { filters: input.filters }),
        pageSize: input.pageSize,
        hits: baseHits,
        ...(baseNextCursor === undefined ? {} : { nextCursor: baseNextCursor }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return new Promise((resolve) => {
        const abort = () => {
          if (generation !== currentGeneration) return;
          cancel();
          resolve({ status: "aborted", message: "The message search request was aborted." });
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = window.setTimeout(async () => {
          if (generation !== currentGeneration) return;
          setState({
            state: "loading",
            query: input.query,
            ...(input.filters === undefined ? {} : { filters: input.filters }),
            pageSize: input.pageSize,
            hits: baseHits,
            ...(baseNextCursor === undefined ? {} : { nextCursor: baseNextCursor }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          });
          requests.push(input);
          let response;
          try {
            response = await handleSearch(input, requests.length);
          } catch {
            response = {
              status: "transport",
              message: "The message search request could not be completed.",
            };
          }
          if (generation !== currentGeneration) return;
          options.signal?.removeEventListener("abort", abort);
          if (response.status !== "success") {
            setState({
              state: "error",
              query: input.query,
              ...(input.filters === undefined ? {} : { filters: input.filters }),
              pageSize: input.pageSize,
              hits: baseHits,
              ...(baseNextCursor === undefined ? {} : { nextCursor: baseNextCursor }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              failure: response,
            });
            resolve(response);
            return;
          }
          const hits = mergeHits(baseHits, response.hits);
          const value = {
            query: input.query,
            ...(input.filters === undefined ? {} : { filters: input.filters }),
            pageSize: input.pageSize,
            hits,
            ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
          };
          setState({ state: "success", ...value });
          resolve({ status: "success", value });
        }, input.cursor === undefined ? debounceMs : 0);
      });
    },
  };
  return { client, requests };
};

const messageHit = (overrides = {}) => ({
  type: "message",
  conversationId: secondId,
  messageId: secondMessageId,
  title: "Second search channel",
  snippet: "A matching message",
  authorUserId: authorId,
  authorDisplayName: "Search Author",
  sentAt: now,
  ...overrides,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
const wait = async (milliseconds) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    await flush();
  });
};
const enterText = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      .set.call(input, value);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    await flush();
  });
};
const changeValue = async (control, value) => {
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
};
const click = async (element) => {
  await act(async () => {
    element.click();
    await flush();
  });
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

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
});

const BasicTimeline = ({ conversation }) => createElement(
  "article",
  { "data-timeline-for": conversation.id },
  `Timeline for ${conversation.id}`,
);

const workspace = (client, props = {}) => createElement(
  ChatProvider,
  { client },
  createElement(ChatWorkspace, {
    scope,
    defaultConversationId: firstId,
    renderTimeline: ({ conversation: selected }) =>
      createElement(BasicTimeline, { conversation: selected }),
    renderComposer: () => null,
    ...props,
  }),
);

const openMessageSearch = async (container) => {
  const trigger = container.querySelector(".handrail-chat__message-search-trigger");
  assert.ok(trigger);
  await click(trigger);
  const query = container.querySelector('input[name="messageSearchQuery"]');
  assert.ok(query);
  return { query, trigger };
};

test("message search starts collapsed and restores trigger focus on close and Escape", async () => {
  const { client } = createClient(async () => ({ status: "success", hits: [] }));
  const container = await mount(workspace(client));
  const triggers = container.querySelectorAll(".handrail-chat__message-search-trigger");
  assert.equal(triggers.length, 1);
  const trigger = triggers[0];
  assert.ok(trigger);
  assert.equal(trigger.closest(".handrail-chat__header-actions") !== null, true);
  assert.equal(trigger.closest(".handrail-chat__navigation-actions"), null);
  assert.equal(trigger.getAttribute("aria-label"), "Search messages");
  assert.equal(trigger.getAttribute("title"), "Search messages");
  assert.equal(trigger.textContent, "");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector(".handrail-chat__message-search"), null);
  assert.equal(container.querySelector('input[name="messageSearchQuery"]'), null);
  assert.match(container.textContent, /First search channel/);

  const opened = await openMessageSearch(container);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, opened.query);
  assert.equal(opened.query.closest(".handrail-chat__conversation") !== null, true);
  assert.equal(opened.query.closest(".handrail-chat__navigation"), null);

  const close = container.querySelector('button[aria-label="Close message search"]');
  assert.ok(close);
  const closeIcon = close?.querySelector('svg[data-pane-control-icon="close"]');
  assert.equal(closeIcon?.tagName, "svg");
  assert.equal(closeIcon?.getAttribute("aria-hidden"), "true");
  assert.equal(closeIcon?.getAttribute("focusable"), "false");
  assert.equal(closeIcon?.getAttribute("stroke"), "currentColor");
  assert.equal(close?.textContent, "");
  assert.doesNotMatch(close?.textContent ?? "", /[←×]/u);

  await click(close);
  assert.equal(container.querySelector(".handrail-chat__message-search"), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, trigger);

  const reopened = await openMessageSearch(container);
  const escape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => {
    reopened.query.dispatchEvent(escape);
    await flush();
  });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(container.querySelector(".handrail-chat__message-search"), null);
  assert.equal(document.activeElement, trigger);
});

test("message search renders no trigger when the client capability is absent", async () => {
  const { client } = createClient(async () => ({ status: "success", hits: [] }));
  const clientWithoutSearch = { ...client };
  delete clientWithoutSearch.searchMessages;
  delete clientWithoutSearch.getMessageSearchState;
  delete clientWithoutSearch.subscribeMessageSearch;
  delete clientWithoutSearch.cancelMessageSearch;
  const container = await mount(workspace(clientWithoutSearch));
  assert.equal(container.querySelector(".handrail-chat__message-search-trigger"), null);
  assert.equal(container.querySelector(".handrail-chat__message-search"), null);
  assert.match(container.textContent, /First search channel/);
});

test("message search renders no trigger without a selected conversation", async () => {
  const { client } = createClient(async () => ({ status: "success", hits: [] }));
  const container = await mount(workspace(client, { conversationId: null }));
  assert.equal(container.querySelector(".handrail-chat__message-search-trigger"), null);
  assert.equal(container.querySelector(".handrail-chat__message-search"), null);
});

test("message search defaults to the current conversation and refreshes that default", async () => {
  const { client, requests } = createClient(async () => ({ status: "success", hits: [] }));
  const Host = () => {
    const [conversationId, setConversationId] = useState(firstId);
    return createElement(ChatProvider, { client }, createElement(ChatWorkspace, {
      scope,
      conversationId,
      onConversationChange: setConversationId,
      renderTimeline: ({ conversation: selected }) =>
        createElement(BasicTimeline, { conversation: selected }),
      renderComposer: () => null,
    }));
  };
  const container = await mount(createElement(Host));
  await openMessageSearch(container);
  const scopeControl = container.querySelector(
    'select[name="messageSearchConversation"]',
  );
  assert.equal(scopeControl.value, firstId);
  assert.equal(scopeControl.options[0].value, "");
  assert.equal(scopeControl.options[0].textContent, "All conversations");

  await changeValue(scopeControl, "");
  await enterText(
    container.querySelector('input[name="messageSearchQuery"]'),
    "across conversations",
  );
  await wait(45);
  assert.equal(requests.at(-1).filters, undefined);

  await click(container.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${secondId}"]`,
  ));
  assert.equal(scopeControl.value, secondId);

  await click(container.querySelector(".handrail-chat__message-search-close"));
  await click(container.querySelector(
    `.handrail-chat__conversation-button[data-conversation-id="${firstId}"]`,
  ));
  await openMessageSearch(container);
  assert.equal(
    container.querySelector('select[name="messageSearchConversation"]').value,
    firstId,
  );
});

test("message search debounces, maps every filter, and renders snippets as text", async () => {
  const { client, requests } = createClient(async () => ({
    status: "success",
    hits: [
      messageHit({ snippet: "<img src=x onerror=alert(1)> plain text" }),
      messageHit({
        conversationId: firstId,
        messageId: firstMessageId,
        title: "First search channel",
        snippet: "Second result",
      }),
    ],
  }));
  const container = await mount(workspace(client));
  const { query } = await openMessageSearch(container);
  assert.match(container.textContent, /Enter a search term/);
  await enterText(query, "  matching   text  ");
  assert.equal(requests.length, 0);
  assert.match(container.textContent, /Searching messages/);
  await wait(45);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query, "matching text");
  assert.deepEqual(requests[0].filters, { conversationIds: [firstId] });
  assert.equal(container.querySelector(".handrail-chat__message-search-snippet").textContent,
    "<img src=x onerror=alert(1)> plain text");
  assert.equal(container.querySelector("img"), null);

  await changeValue(
    container.querySelector('select[name="messageSearchConversation"]'),
    secondId,
  );
  await wait(45);
  assert.deepEqual(requests.at(-1).filters, { conversationIds: [secondId] });

  await changeValue(
    container.querySelector('select[name="messageSearchConversation"]'),
    "",
  );
  await enterText(container.querySelector('input[name="messageSearchAuthor"]'), `  ${authorId}  `);
  await wait(45);
  assert.deepEqual(requests.at(-1).filters, { authorUserIds: [authorId] });

  await enterText(container.querySelector('input[name="messageSearchAuthor"]'), "");
  const afterValue = "2035-01-02T03:04";
  await enterText(container.querySelector('input[name="messageSearchSentAfter"]'), afterValue);
  await wait(45);
  assert.deepEqual(requests.at(-1).filters, {
    sentAfter: new Date(afterValue).toISOString(),
  });

  await enterText(container.querySelector('input[name="messageSearchSentAfter"]'), "");
  const beforeValue = "2035-05-06T07:08";
  await enterText(container.querySelector('input[name="messageSearchSentBefore"]'), beforeValue);
  await wait(45);
  assert.deepEqual(requests.at(-1).filters, {
    sentBefore: new Date(beforeValue).toISOString(),
  });
});

test("message search renders preserved forwarded attribution and unresolved-author fallback", async () => {
  const { client } = createClient(async () => ({
    status: "success",
    hits: [
      messageHit({
        authorDisplayName: "Ada Lovelace",
        snippet: "Forwarded analytical engine",
      }),
      messageHit({
        authorDisplayName: undefined,
        conversationId: firstId,
        messageId: firstMessageId,
        snippet: "Ordinary unresolved message",
      }),
    ],
  }));
  const container = await mount(workspace(client));
  await openMessageSearch(container);
  await enterText(
    container.querySelector('input[name="messageSearchQuery"]'),
    "attribution",
  );
  await wait(45);

  const results = container.querySelectorAll('[role="option"]');
  assert.equal(results.length, 2);
  assert.match(results[0].textContent, /Ada Lovelace/);
  assert.doesNotMatch(results[0].textContent, /Unknown author/);
  assert.match(results[1].textContent, /Unknown author/);
});

test("search results support roving keyboard focus", async () => {
  const { client } = createClient(async () => ({
    status: "success",
    hits: [
      messageHit(),
      messageHit({ conversationId: firstId, messageId: firstMessageId, snippet: "Other" }),
    ],
  }));
  const container = await mount(workspace(client));
  await openMessageSearch(container);
  await changeValue(
    container.querySelector('select[name="messageSearchConversation"]'),
    "",
  );
  await enterText(container.querySelector('input[name="messageSearchQuery"]'), "keyboard");
  await wait(45);
  const results = container.querySelectorAll('[role="option"]');
  results[0].focus();
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "ArrowDown",
  });
  await act(async () => results[0].dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement, results[1]);
  assert.equal(results[0].tabIndex, -1);
  assert.equal(results[1].tabIndex, 0);
});

test("a completed search with no authorized hits announces no results", async () => {
  const { client } = createClient(async () => ({ status: "success", hits: [] }));
  const container = await mount(workspace(client));
  await openMessageSearch(container);
  await enterText(container.querySelector('input[name="messageSearchQuery"]'), "nothing here");
  await wait(45);
  assert.match(container.querySelector('[role="status"]').textContent, /No messages found/);
  assert.equal(container.querySelector('[role="option"]'), null);
});

test("initial and pagination failures retain actionable retry paths", async () => {
  let attempt = 0;
  const { client, requests } = createClient(async (input) => {
    attempt += 1;
    if (attempt === 1 || attempt === 3) {
      if (attempt === 3) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return {
        status: "transport",
        message: "The message search request could not be completed.",
      };
    }
    if (input.cursor === undefined) {
      return { status: "success", hits: [messageHit()], nextCursor: "next-page" };
    }
    return {
      status: "success",
      hits: [messageHit({ conversationId: firstId, messageId: firstMessageId })],
    };
  });
  const container = await mount(workspace(client));
  await openMessageSearch(container);
  await changeValue(
    container.querySelector('select[name="messageSearchConversation"]'),
    "",
  );
  await enterText(container.querySelector('input[name="messageSearchQuery"]'), "retry");
  await wait(45);
  assert.match(container.querySelector('[role="alert"]').textContent, /could not be completed/);
  await click([...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Retry search"));
  assert.match(container.textContent, /Searching messages/);
  await wait(45);
  assert.equal(container.querySelectorAll('[role="option"]').length, 1);

  await click([...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Load more results"));
  assert.match(container.textContent, /Loading more results/);
  assert.equal(container.querySelector(".handrail-chat__message-search-load-more").disabled, true);
  await wait(35);
  assert.equal(container.querySelectorAll('[role="option"]').length, 1);
  assert.match(container.querySelector('[role="alert"]').textContent, /More results could not be loaded/);
  await click([...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Retry loading more"));
  await wait(15);
  assert.equal(container.querySelectorAll('[role="option"]').length, 2);
  assert.deepEqual(requests.map(({ cursor }) => cursor), [undefined, undefined, "next-page", "next-page"]);
});

const HydratingTimeline = ({ conversation, onScroll }) => {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(false);
    if (conversation.id !== secondId) return;
    const timer = window.setTimeout(() => setHydrated(true), 35);
    return () => window.clearTimeout(timer);
  }, [conversation.id]);
  return createElement(
    "article",
    { "data-timeline-for": conversation.id },
    hydrated && conversation.id === secondId
      ? createElement(
          "div",
          {
            "data-message-id": secondMessageId,
            ref: (element) => {
              if (element !== null) element.scrollIntoView = (...args) => onScroll(...args);
            },
            tabIndex: -1,
          },
          "Hydrated target message",
        )
      : "Hydrating timeline",
  );
};

for (const controlled of [false, true]) {
  test(`result activation selects, scrolls, and focuses after hydration in ${controlled ? "controlled" : "uncontrolled"} mode`, async () => {
    const { client } = createClient(async () => ({ status: "success", hits: [messageHit()] }));
    const selected = [];
    const scrollCalls = [];
    const Host = () => {
      const [conversationId, setConversationId] = useState(firstId);
      return createElement(ChatProvider, { client }, createElement(ChatWorkspace, {
        scope,
        ...(controlled ? { conversationId } : { defaultConversationId: firstId }),
        onConversationChange: (next) => {
          selected.push(next);
          if (controlled) setConversationId(next);
        },
        renderTimeline: ({ conversation: current }) => createElement(HydratingTimeline, {
          conversation: current,
          onScroll: (...args) => scrollCalls.push(args),
        }),
        renderComposer: () => null,
      }));
    };
    const container = await mount(createElement(Host));
    await openMessageSearch(container);
    await changeValue(
      container.querySelector('select[name="messageSearchConversation"]'),
      "",
    );
    await enterText(container.querySelector('input[name="messageSearchQuery"]'), "hydrate");
    await wait(45);
    await click(container.querySelector('[role="option"]'));
    await wait(60);
    const target = container.querySelector(`[data-message-id="${secondMessageId}"]`);
    assert.deepEqual(selected, [secondId]);
    assert.equal(container.querySelector("article").dataset.timelineFor, secondId);
    assert.equal(document.activeElement, target);
    assert.equal(scrollCalls.length, 1);
    assert.deepEqual(scrollCalls[0], [{ block: "center", inline: "nearest" }]);
    assert.match(container.textContent, /Search result opened/);
  });
}

test("an unavailable result stops at an accessible bounded fallback", async () => {
  const { client } = createClient(async () => ({ status: "success", hits: [messageHit()] }));
  const container = await mount(workspace(client));
  await openMessageSearch(container);
  await changeValue(
    container.querySelector('select[name="messageSearchConversation"]'),
    "",
  );
  await enterText(container.querySelector('input[name="messageSearchQuery"]'), "deleted");
  await wait(45);
  await click(container.querySelector('[role="option"]'));
  await wait(1_525);
  const alerts = [...container.querySelectorAll('[role="alert"]')];
  assert.ok(alerts.some((alert) => /deleted or is not available yet/.test(alert.textContent)));
  assert.ok([...container.querySelectorAll("button")]
    .some((button) => button.textContent === "Try opening result again"));
});

test("a host activation callback overrides default routing without removing the result", async () => {
  const { client } = createClient(async () => ({ status: "success", hits: [messageHit()] }));
  const navigations = [];
  const selections = [];
  const container = await mount(workspace(client, {
    conversationId: firstId,
    onConversationChange: (next) => selections.push(next),
    onMessageSearchResultActivate: (navigation) => navigations.push(navigation),
  }));
  await openMessageSearch(container);
  await changeValue(
    container.querySelector('select[name="messageSearchConversation"]'),
    "",
  );
  await enterText(container.querySelector('input[name="messageSearchQuery"]'), "custom route");
  await wait(45);
  await click(container.querySelector('[role="option"]'));
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].result.messageId, secondMessageId);
  assert.equal(typeof navigations[0].navigateDefault, "function");
  assert.deepEqual(selections, []);
  assert.equal(container.querySelectorAll('[role="option"]').length, 1);
});
