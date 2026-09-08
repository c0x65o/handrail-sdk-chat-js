import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const React = await import("react");
const { act, createElement } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { ChatProvider } = await import("@handrail/chat/react");
const { ChatWorkspace } = await import("@handrail/chat/ui");
const {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createNormalizedChatCache,
} = await import("@handrail/chat/client");
const {
  CHAT_PROTOCOL_VERSION,
  encodeConversationSnapshotCursor,
} = await import("@handrail/chat");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const window = new Window({ url: "https://workspace.example.test" });
const activeResizeObservers = new Set();
class TestResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    this.target = undefined;
  }

  observe(target) {
    this.target = target;
    activeResizeObservers.add(this);
  }

  disconnect() {
    this.disconnected = true;
    activeResizeObservers.delete(this);
  }

  notify(width) {
    if (this.disconnected || this.target === undefined) return;
    this.callback([{
      contentRect: { width },
      target: this.target,
    }], this);
  }
}
Object.assign(globalThis, {
  document: window.document,
  Event: window.Event,
  FocusEvent: window.FocusEvent,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  ResizeObserver: TestResizeObserver,
  window,
});
window.ResizeObserver = TestResizeObserver;

const now = "2035-02-03T04:05:06.000Z";
const tenantId = "tenant-workspace";
const actorId = "user-workspace";
const otherUserId = "user-workspace-other";
const secondDirectoryUserId = "user-workspace-directory-second";
const firstId = "conversation-workspace-first";
const secondId = "conversation-workspace-second";
const thirdId = "conversation-workspace-third";
const identity = { tenantId, userId: actorId, sessionId: "session-workspace" };
const organizationScope = Object.freeze({ type: "organization" });
const entityScope = Object.freeze({
  type: "entity",
  entity: Object.freeze({ type: "sales-order", id: "SO-1042" }),
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
const snapshotState = (conversationId) => ({
  activityAt: now,
  latestSequence: 0,
  unreadMentionCount: 0,
  activeMemberUserIds: [otherUserId],
  currentMember: member(conversationId),
  currentReadState: readState(conversationId),
  currentPreference: {
    conversationId,
    userId: actorId,
    notificationPreference: "all",
    mute: { muted: false },
    updatedAt: now,
  },
});
const conversation = (id, name, entity) => ({
  id,
  tenantId,
  type: "channel",
  name,
  visibility: "public",
  ...(entity === undefined ? {} : { entity }),
  createdAt: now,
  updatedAt: now,
  ...snapshotState(id),
});
const directConversation = (id) => ({
  id,
  tenantId,
  type: "direct",
  visibility: "private",
  createdAt: now,
  updatedAt: now,
  ...snapshotState(id),
});
const groupDirectConversation = (id) => ({
  id,
  tenantId,
  type: "group_direct",
  visibility: "private",
  createdAt: now,
  updatedAt: now,
  ...snapshotState(id),
});
const threadConversation = (id, parentConversationId) => ({
  id,
  tenantId,
  type: "thread",
  visibility: "private",
  parentConversationId,
  rootMessageId: `message-root-${id}`,
  createdAt: now,
  updatedAt: now,
  ...snapshotState(id),
});

const firstConversation = conversation(firstId, "Organization chat");
const secondConversation = conversation(secondId, "Entity chat", entityScope.entity);
const thirdConversation = conversation(thirdId, "Older organization chat");
const conversationCursor = encodeConversationSnapshotCursor({
  isStarred: false,
  navigationRank: 1,
  activityAt: now,
  conversationId: secondId,
});

const listSnapshot = (scope, items, nextCursor) => ({
  kind: "conversation_list",
  scope,
  items: items.map((item) => ({ hasActiveHuddle: false, ...item })),
  page: nextCursor === undefined ? {} : { nextCursor },
  _meta: metadata,
});
const detailSnapshot = (item) => ({
  kind: "conversation_detail",
  conversation: {
    ...item,
    memberUserIds: [otherUserId],
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

const createCache = ({
  organization = [firstConversation, secondConversation],
  entity = [secondConversation],
  details = [firstConversation, secondConversation],
  organizationNextCursor,
  seedOrganization = true,
  seedEntity = true,
} = {}) => {
  const cache = createNormalizedChatCache(identity);
  if (seedOrganization) {
    cache.hydrateConversationList(listSnapshot(
      organizationScope,
      organization,
      organizationNextCursor,
    ));
  }
  if (seedEntity) cache.hydrateConversationList(listSnapshot(entityScope, entity));
  for (const item of details) cache.hydrateConversationDetail(detailSnapshot(item));
  return cache;
};

const directoryUser = Object.freeze({
  kind: "active",
  userId: otherUserId,
  displayName: "Avery Example",
  avatar: Object.freeze({ kind: "initials", initials: "AE" }),
});
const secondDirectoryUser = Object.freeze({
  kind: "active",
  userId: secondDirectoryUserId,
  displayName: "Morgan Example",
  avatar: Object.freeze({ kind: "initials", initials: "ME" }),
});
const actorDirectoryUser = Object.freeze({
  kind: "active",
  userId: actorId,
  displayName: "Current User",
  avatar: Object.freeze({ kind: "initials", initials: "CU" }),
});

const canonicalMember = (userId, state = "active", role = "member") => ({
  userId,
  role,
  state,
  joinedAt: now,
  updatedAt: now,
});

const reconcileMembership = (cache, input, result, key = "workspace-membership") => {
  cache.beginConversationOperation({
    logicalKey: key,
    idempotencyKey: input.idempotencyKey,
    family: "membership",
    conversationId: input.conversationId,
  });
  cache.reconcileConversationMembership(key, input, result);
};

const seedMembership = (
  cache,
  revision = 7,
  { actorRole = "member", otherRole = "member" } = {},
) => {
  const input = {
    operation: "mutate_conversation_membership",
    intent: "add_member",
    conversationId: firstId,
    expectedMemberListRevision: revision,
    idempotencyKey: "seed-membership",
    targetUserId: otherUserId,
    requestedRole: otherRole,
  };
  reconcileMembership(cache, input, {
    operation: input.operation,
    intent: input.intent,
    conversationId: firstId,
    expectedMemberListRevision: revision,
    memberListRevision: revision,
    memberUserId: otherUserId,
    targetUserId: otherUserId,
    requestedRole: otherRole,
    reconciliationStatus: "already_requested_state",
    members: [
      canonicalMember(actorId, "active", actorRole),
      canonicalMember(otherUserId, "active", otherRole),
    ],
  }, "seed-membership");
};

const seedMembershipMembers = (cache, members, revision = 7) => {
  const canonicalMembers = [...members].sort((left, right) =>
    left.userId.localeCompare(right.userId));
  const targetUserId = members[0]?.userId ?? otherUserId;
  const input = {
    operation: "mutate_conversation_membership",
    intent: "add_member",
    conversationId: firstId,
    expectedMemberListRevision: revision,
    idempotencyKey: `seed-membership-${members.length}`,
    targetUserId,
    requestedRole: "member",
  };
  reconcileMembership(cache, input, {
    operation: input.operation,
    intent: input.intent,
    conversationId: firstId,
    expectedMemberListRevision: revision,
    memberListRevision: revision,
    memberUserId: targetUserId,
    targetUserId,
    requestedRole: "member",
    reconciliationStatus: "already_requested_state",
    members: canonicalMembers,
  }, input.idempotencyKey);
};

const preferenceDesiredState = (input) => ({
  notificationPreference: input.notificationPreference,
  mute: input.mute,
});

const preferenceResult = (input, {
  reconciliationStatus = "applied",
  preferenceRevision = input.expectedPreferenceRevision + 1,
  preference = preferenceDesiredState(input),
  updatedAt = now,
} = {}) => ({
  operation: "update_conversation_preference",
  reconciliationStatus,
  conversationId: input.conversationId,
  expectedPreferenceRevision: input.expectedPreferenceRevision,
  idempotencyKey: input.idempotencyKey,
  requestedPreference: preferenceDesiredState(input),
  preferenceRevision,
  preference: { ...preference, updatedAt },
});

const seedPreferenceRevision = (
  cache,
  revision,
  preference = { notificationPreference: "all", mute: { muted: false } },
) => {
  for (let expected = 0; expected < revision; expected += 1) {
    const input = {
      operation: "update_conversation_preference",
      conversationId: firstId,
      expectedPreferenceRevision: expected,
      idempotencyKey: `seed-preference-${expected}`,
      ...preference,
    };
    cache.reconcileCurrentUserConversationPreference(
      input,
      preferenceResult(input),
    );
  }
};

const commandResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    return body;
  },
});

const createClient = (cache, state = readyState) => ({
  endpoint: "/chat",
  state,
  cache,
  start: async () => state,
  close() {},
  subscribeLifecycle: () => () => undefined,
  listConversations: async () => ({ status: "success" }),
  getConversation: async () => ({ status: "closed", message: "Chat is closed." }),
  selectDirectoryUser: (userId) => userId === otherUserId ? directoryUser : undefined,
  hydrateDirectoryUsers: async () => ({
    status: "success",
    value: { users: [directoryUser] },
  }),
  searchDirectoryUsers: async () => ({
    status: "success",
    value: { query: "", users: [] },
  }),
  getDirectorySearchState: () => ({ state: "idle" }),
  subscribeDirectorySearch: () => () => undefined,
  cancelDirectorySearch() {},
});

const Timeline = ({ conversation: selected }) => createElement(
  "article",
  { "data-timeline-for": selected.id },
  `Timeline for ${selected.type}`,
);
const EmptyWorkspaceBody = () => null;

const workspace = (client, props = {}) => createElement(
  ChatProvider,
  { client },
  createElement(ChatWorkspace, {
    scope: organizationScope,
    conversationId: firstId,
    renderTimeline: Timeline,
    renderComposer: EmptyWorkspaceBody,
    ...props,
  }),
);

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

const click = async (element) => {
  await act(async () => {
    element.click();
    await flush();
  });
};

const openMemberManagement = async (container) => {
  const trigger = container.querySelector(
    'button[aria-label^="Open conversation members"]',
  );
  assert.ok(trigger, "authorized member management renders a header trigger");
  assert.equal(
    container.querySelector('[role="dialog"] .handrail-chat__member-management'),
    null,
    "member management stays unmounted until its trigger is activated",
  );
  await click(trigger);
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "the members trigger opens the bounded panel");
  const panel = dialog.querySelector('[aria-label="Conversation members"]');
  assert.ok(panel, "the panel contains the existing member-management region");
  return { dialog, panel, trigger };
};

const setWorkspaceWidth = async (container, width) => {
  const workspaceRoot = container.querySelector(".handrail-chat--workspace");
  const observer = [...activeResizeObservers]
    .find((candidate) => candidate.target === workspaceRoot);
  assert.ok(observer, "the workspace observes its own inline size");
  await act(async () => {
    observer.notify(width);
    await flush();
  });
  return observer;
};

const openCreationDialog = async (container, label) => {
  const trigger = container.querySelector('button[aria-label="Add conversation"]');
  assert.ok(trigger, "authorized creation renders the consolidated add trigger");
  await click(trigger);
  const menu = container.querySelector('[role="menu"]');
  assert.ok(menu, "the add trigger opens the creation menu");
  const item = [...menu.querySelectorAll('[role="menuitem"]')]
    .find((candidate) => candidate.textContent === label);
  assert.ok(item, `${label} is available in the creation menu`);
  await click(item);
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, `${label} opens its existing dialog`);
  return { dialog, trigger };
};

const enterText = async (element, value) => {
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

const chooseSelectValue = async (element, value) => {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
};

const waitForTimers = async (milliseconds) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    await flush();
  });
};

const mounted = [];
const renderWorkspace = async (element) => {
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

test("recent thread navigation reacts to canonical events and detail without changing top-level list IDs", async () => {
  const cache = createCache({ organization: [firstConversation], entity: [], details: [firstConversation] });
  const container = await renderWorkspace(workspace(createClient(cache)));
  const thread = { ...threadConversation("recent-launch-thread", firstId), name: "Launch date decision" };
  const section = container.querySelector('[data-conversation-section="threads"]');
  const count = () => section.querySelector('.handrail-chat__conversation-section-count').textContent;
  assert.equal(count(), "0");
  await act(async () => {
    cache.applyDurableEvent({
      eventId: "recent-launch-created", protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId, streamId: thread.id, type: "thread.created", occurredAt: now,
      payload: { conversation: thread },
    });
    await flush();
  });
  assert.equal(count(), "1");
  assert.match(section.textContent, /Launch date decision/);
  assert.equal(section.querySelector('.handrail-chat__conversation-section-empty'), null);
  await act(async () => {
    cache.hydrateConversationDetail(detailSnapshot(thread));
    cache.hydrateConversationList(listSnapshot(organizationScope, [firstConversation]));
    await flush();
  });
  assert.equal(count(), "1", "detail hydration and a thread-free list refresh keep one canonical entry");
  assert.deepEqual(Object.values(cache.getState().metadata.conversationLists)[0].conversationIds, [firstId]);
  const archivedAt = "2035-02-03T04:05:07.000Z";
  await act(async () => {
    cache.applyDurableEvent({
      eventId: "recent-launch-archived", protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId, streamId: thread.id, type: "conversation.archived", occurredAt: archivedAt,
      payload: { conversation: { ...thread, updatedAt: archivedAt, archivedAt, archivedByUserId: actorId } },
    });
    await flush();
  });
  assert.equal(count(), "0", "administrative archive removes the recent thread");
});

test("recent thread navigation respects parent scope and clears with parent removal or identity reset", async () => {
  const thread = { ...threadConversation("recent-scoped-thread", secondId), name: "Scoped thread" };
  const outsideThread = threadConversation("recent-other-thread", firstId);
  const cache = createCache({ details: [firstConversation, secondConversation, thread, outsideThread] });
  const container = await renderWorkspace(workspace(createClient(cache), { scope: entityScope, conversationId: secondId }));
  const section = container.querySelector('[data-conversation-section="threads"]');
  const ids = () => [...section.querySelectorAll('[data-conversation-id]')].map(row => row.dataset.conversationId);
  assert.deepEqual(ids(), [thread.id]);
  await act(async () => {
    cache.hydrateConversationList(listSnapshot(entityScope, []));
    await flush();
  });
  assert.deepEqual(ids(), [], "retained detail cannot bypass the visible parent scope");
  await act(async () => {
    cache.hydrateConversationList(listSnapshot(entityScope, [secondConversation, thread]));
    await flush();
  });
  assert.deepEqual(ids(), [thread.id], "host-provided list entries do not duplicate cached threads");
  await act(async () => { cache.reset(); await flush(); });
  assert.deepEqual(ids(), []);
});

test("every layout mode renders root-scoped navigation, header, and main landmarks", () => {
  const client = createClient(createCache());
  for (const mode of ["full-screen", "side-panel", "modal", "record"]) {
    const markup = renderToStaticMarkup(workspace(client, {
      mode,
      theme: "dark",
      style: { "--hr-chat-color-accent": "rebeccapurple" },
    }));
    assert.match(markup, new RegExp(`class="handrail-chat handrail-chat--workspace handrail-chat--${mode}"`));
    assert.match(markup, new RegExp(`data-handrail-chat-mode="${mode}"`));
    assert.match(markup, /data-handrail-chat-scope="organization"/);
    assert.match(markup, /data-handrail-compact-layout="false"/);
    assert.doesNotMatch(markup, /data-handrail-compact-pane=/);
    assert.doesNotMatch(markup, /Back to conversations/);
    assert.match(markup, /data-handrail-theme="dark"/);
    assert.match(markup, /style="--hr-chat-color-accent:rebeccapurple"/);
    assert.match(markup, /<nav aria-label="Conversations"/);
    assert.match(markup, /<header class="handrail-chat__header"/);
    assert.match(markup, /<main aria-labelledby=/);
    assert.match(markup, /aria-label="Conversation timeline"/);
  }
});

test("maximum-action headers keep one semantic, ordered, focusable action cluster in wide and compact layouts", async () => {
  const longConversation = conversation(
    firstId,
    "A deliberately long conversation title that must yield space to header actions without overflowing",
  );
  const cache = createCache({
    organization: [longConversation, secondConversation],
    details: [longConversation, secondConversation],
  });
  seedMembership(cache, 4);
  const huddleState = Object.freeze({
    conversationId: firstId,
    hydrationStatus: "ready",
    media: Object.freeze({ state: "idle" }),
    canonicalState: Object.freeze({
      conversationId: firstId,
      status: "inactive",
    }),
  });
  const enabledState = Object.freeze({
    ...readyState,
    enabledFeatures: Object.freeze({ huddles: true }),
  });
  const client = {
    ...createClient(cache, enabledState),
    getHuddleState: () => huddleState,
    subscribeHuddle: () => () => undefined,
    hydrateHuddle: async () => ({ status: "success", operation: "hydrate", state: huddleState.canonicalState }),
    startHuddle: async () => ({ status: "success", operation: "start", state: huddleState.canonicalState }),
  };
  const permissions = Object.freeze({
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
  const container = await renderWorkspace(workspace(client, {
    currentUserId: actorId,
    huddlePermissions: permissions,
    memberManagementAvailability: { canView: true },
  }));
  const header = container.querySelector(".handrail-chat__header");
  const identityRegion = header.querySelector(".handrail-chat__header-identity");
  const actionCluster = header.querySelector(
    '.handrail-chat__header-actions[role="group"][aria-label="Conversation actions"]',
  );
  assert.ok(identityRegion, "the shrinkable identity region owns avatar, user, and title output");
  assert.ok(actionCluster, "authorized header controls share one named semantic cluster");
  assert.equal(
    identityRegion.compareDocumentPosition(actionCluster) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
  );

  const actionButtons = [...actionCluster.querySelectorAll("button")];
  assert.equal(actionButtons.length, 3);
  assert.deepEqual(
    actionButtons.map((button) => button.getAttribute("aria-label") ?? button.textContent.trim()),
    [
      "Start huddle",
      "Open conversation members (2 members)",
      "Notification preferences: All messages; Unmuted",
    ],
  );
  assert.equal(actionButtons[0].title, "Start huddle");
  assert.ok(actionButtons[0].querySelector(".handrail-chat__huddle-header-icon"));
  assert.doesNotMatch(actionCluster.textContent, /Media connection:/);
  assert.equal(actionButtons[1].title, "Open conversation members (2 members)");
  assert.equal(actionButtons[1].textContent, "2");
  assert.ok(actionButtons[1].querySelector(".handrail-chat__member-management-icon"));
  assert.equal(
    actionButtons[1].querySelector(".handrail-chat__member-management-icon")
      .getAttribute("aria-hidden"),
    "true",
  );
  assert.ok(actionCluster.querySelector(
    ".handrail-chat__notification-preferences-icon",
  ));
  assert.equal(
    identityRegion.querySelector(".handrail-chat__channel-title").textContent,
    longConversation.name,
  );
  for (const button of actionButtons) {
    assert.equal(button.disabled, false);
    assert.equal(button.tabIndex, 0);
    button.focus();
    assert.equal(document.activeElement, button);
  }

  const memberTrigger = actionButtons[1];
  assert.equal(memberTrigger.getAttribute("aria-expanded"), "false");
  memberTrigger.focus();
  await click(memberTrigger);
  assert.equal(memberTrigger.getAttribute("aria-expanded"), "true");
  const memberDialog = container.querySelector(".handrail-chat__member-management-panel");
  assert.equal(memberTrigger.getAttribute("aria-controls"), memberDialog.id);
  const escape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => {
    memberDialog.dispatchEvent(escape);
    await flush();
  });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(memberTrigger.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector(".handrail-chat__member-management-panel"), null);
  assert.equal(document.activeElement, memberTrigger);

  await click(memberTrigger);
  await click(container.querySelector(".handrail-chat__member-management-panel-close"));
  assert.equal(memberTrigger.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, memberTrigger);

  const notificationTrigger = actionButtons[2];
  notificationTrigger.focus();
  await click(notificationTrigger);
  const notificationClose = container.querySelector(
    ".handrail-chat__notification-preferences-close",
  );
  notificationClose.focus();
  await click(notificationClose);
  assert.equal(document.activeElement, notificationTrigger);

  await setWorkspaceWidth(container, 420);
  assert.equal(
    container.querySelector(".handrail-chat--workspace")
      .getAttribute("data-handrail-compact-layout"),
    "true",
  );
  const compactActions = [...container.querySelectorAll(
    ".handrail-chat__header-actions button",
  )];
  assert.equal(compactActions.length, 3, "compact observation does not remove an action");
  assert.deepEqual(
    compactActions.map((button) => button.getAttribute("aria-label") ?? button.textContent.trim()),
    [
      "Start huddle",
      "Open conversation members (2 members)",
      "Notification preferences: All messages; Unmuted",
    ],
  );
  assert.equal(
    container.querySelector(".handrail-chat__channel-title").textContent,
    longConversation.name,
  );
  assert.equal(compactActions[1].textContent, "2");
  assert.doesNotMatch(compactActions[1].textContent, /Members/u);
});

test("member trigger renders a compact icon and exact zero, one, and many count labels", async () => {
  const cases = [
    { count: 0, members: [], countLabel: "0 members" },
    {
      count: 1,
      members: [canonicalMember(actorId)],
      countLabel: "1 member",
    },
    {
      count: 3,
      members: [
        canonicalMember(actorId),
        canonicalMember(otherUserId),
        canonicalMember(secondDirectoryUserId),
      ],
      countLabel: "3 members",
    },
  ];

  for (const { count, members, countLabel } of cases) {
    const cache = count === 0
      ? (() => {
          const emptyMemberConversation = {
            ...firstConversation,
            activeMemberUserIds: [],
          };
          const emptyCache = createNormalizedChatCache(identity);
          emptyCache.hydrateConversationList(listSnapshot(
            organizationScope,
            [emptyMemberConversation],
          ));
          emptyCache.hydrateConversationDetail({
            kind: "conversation_detail",
            conversation: {
              ...emptyMemberConversation,
              memberUserIds: [],
              currentPreference: {
                conversationId: firstId,
                userId: actorId,
                notificationPreference: "all",
                mute: { muted: false },
                updatedAt: now,
              },
            },
            _meta: metadata,
          });
          return emptyCache;
        })()
      : createCache();
    if (members.length > 0) seedMembershipMembers(cache, members);
    const container = await renderWorkspace(workspace(createClient(cache), {
      memberManagementAvailability: { canView: true },
    }));
    const trigger = container.querySelector(
      ".handrail-chat__member-management-trigger",
    );
    const expectedLabel = `Open conversation members (${countLabel})`;

    assert.ok(trigger);
    assert.equal(trigger.getAttribute("aria-label"), expectedLabel);
    assert.equal(trigger.title, expectedLabel);
    assert.equal(trigger.textContent, String(count));
    assert.equal(
      trigger.querySelector(".handrail-chat__member-management-count").textContent,
      String(count),
    );
    assert.ok(trigger.querySelector("svg.handrail-chat__member-management-icon"));
    assert.doesNotMatch(trigger.textContent, /Members/u);
  }
});

test("organization and entity scopes render only their scoped navigation rows", () => {
  const client = createClient(createCache());
  const organizationMarkup = renderToStaticMarkup(workspace(client));
  const entityMarkup = renderToStaticMarkup(workspace(client, {
    scope: entityScope,
    conversationId: secondId,
  }));

  assert.match(organizationMarkup, />Organization chat</);
  assert.match(organizationMarkup, />Entity chat</);
  assert.doesNotMatch(entityMarkup, />Organization chat</);
  assert.match(entityMarkup, />Entity chat</);
  assert.match(entityMarkup, /data-handrail-chat-scope="entity"/);
});

test("conversation rows distinguish types and expose only nonzero canonical unread counts", () => {
  const publicChannel = firstConversation;
  const privateChannel = {
    ...secondConversation,
    visibility: "private",
    latestSequence: 3,
  };
  const direct = {
    ...directConversation("conversation-workspace-direct"),
    latestSequence: 1,
    unreadMentionCount: 1,
  };
  const groupDirect = {
    ...groupDirectConversation("conversation-workspace-group-direct"),
    latestSequence: 120,
    unreadMentionCount: 120,
  };
  const conversations = [publicChannel, privateChannel, direct, groupDirect];
  const markup = renderToStaticMarkup(workspace(createClient(createCache({
    organization: conversations,
    details: conversations,
  }))));
  const container = document.createElement("div");
  container.innerHTML = markup;
  const buttons = [...container.querySelectorAll(".handrail-chat__conversation-button")];

  assert.deepEqual(
    buttons.map((button) => button.dataset.conversationKind),
    ["public-channel", "private-channel", "direct", "group-direct"],
  );
  assert.deepEqual(
    buttons.map((button) => button.querySelector(".handrail-chat__conversation-icon")
      ?.getAttribute("aria-hidden")),
    ["true", "true", undefined, undefined],
  );
  assert.deepEqual(
    buttons.map((button) => button.querySelector(".handrail-chat__conversation-icon")
      ?.dataset.conversationKind),
    ["public-channel", "private-channel", undefined, undefined],
  );
  assert.deepEqual(
    buttons.map((button) => button.querySelector(
      ".handrail-chat__conversation-icon [data-navigation-icon]",
    )?.dataset.navigationIcon),
    ["public-channel", "private-channel", undefined, undefined],
  );
  for (const icon of container.querySelectorAll(
    ".handrail-chat__conversation-icon [data-navigation-icon]",
  )) {
    assert.equal(icon.tagName, "svg");
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    assert.equal(icon.getAttribute("focusable"), "false");
    assert.equal(icon.getAttribute("fill"), "none");
    assert.equal(icon.getAttribute("stroke"), "currentColor");
    assert.equal(icon.getAttribute("stroke-width"), "2");
    assert.equal(icon.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(icon.textContent, "");
  }
  assert.deepEqual(
    buttons.map((button) => button.querySelector(".handrail-chat__conversation-label")
      ?.textContent),
    ["Organization chat", "Entity chat", "Avery Example", "Avery Example"],
  );

  assert.equal(buttons[0].getAttribute("aria-current"), "page");
  assert.equal(
    buttons[0].getAttribute("aria-label"),
    "Organization chat, Notifications: All messages; Unmuted",
  );
  assert.equal(buttons[0].classList.contains("handrail-chat__conversation-button--unread"), false);
  assert.equal(buttons[0].querySelector(".handrail-chat__conversation-unread-badge"), null);

  assert.equal(
    buttons[1].getAttribute("aria-label"),
    "Entity chat, 3 unread messages, Notifications: All messages; Unmuted",
  );
  assert.equal(buttons[1].classList.contains("handrail-chat__conversation-button--unread"), true);
  assert.equal(buttons[1].querySelector(".handrail-chat__conversation-unread-badge")?.textContent, "3");
  assert.equal(buttons[1].querySelector(".handrail-chat__conversation-unread-badge")
    ?.getAttribute("aria-hidden"), "true");

  assert.equal(
    buttons[2].getAttribute("aria-label"),
    "Avery Example, 1 unread message, 1 unread mention, Notifications: All messages; Unmuted",
  );
  assert.equal(buttons[2].title, buttons[2].getAttribute("aria-label"));
  assert.equal(buttons[2].querySelectorAll(".handrail-chat__conversation-avatar-wrap").length, 1);
  assert.equal(buttons[2].querySelector(".handrail-chat__conversation-unread-badge"), null);
  assert.equal(buttons[2].querySelector(".handrail-chat__conversation-mention-badge")?.textContent, "@1");
  assert.equal(buttons[2].querySelector(".handrail-chat__conversation-mention-badge")
    ?.getAttribute("aria-hidden"), "true");
  assert.equal(buttons[2].dataset.unreadMentionCount, "1");
  assert.equal(buttons[2].classList.contains("handrail-chat__conversation-button--mentioned"), true);
  assert.equal(
    buttons[3].getAttribute("aria-label"),
    "Avery Example, 120 unread messages, 120 unread mentions, Notifications: All messages; Unmuted",
  );
  assert.equal(buttons[3].querySelectorAll(".handrail-chat__conversation-avatar-wrap").length, 1);
  assert.equal(buttons[3].querySelector(".handrail-chat__conversation-unread-badge"), null);
  assert.equal(buttons[3].querySelector(".handrail-chat__conversation-mention-badge")?.textContent, "@99+");
  assert.equal(buttons[3].title, buttons[3].getAttribute("aria-label"));
  assert.equal(buttons[3].getAttribute("aria-label").match(/120 unread messages/g)?.length, 1);
  assert.equal(buttons[3].getAttribute("aria-label").match(/120 unread mentions/g)?.length, 1);
});

test("direct and group-direct rows use SVG fallbacks only while participant projections are unavailable", () => {
  const direct = {
    ...directConversation("conversation-workspace-direct-fallback"),
    activeMemberUserIds: undefined,
  };
  const groupDirect = {
    ...groupDirectConversation("conversation-workspace-group-fallback"),
    activeMemberUserIds: undefined,
  };
  const markup = renderToStaticMarkup(workspace(createClient(createCache({
    organization: [direct, groupDirect],
    details: [],
  })), { conversationId: null }));
  const container = document.createElement("div");
  container.innerHTML = markup;
  const rows = [...container.querySelectorAll(".handrail-chat__conversation-button")];

  assert.deepEqual(
    rows.map((row) => row.querySelector("[data-navigation-icon]")?.dataset.navigationIcon),
    ["direct", "group-direct"],
  );
  assert.equal(container.querySelector(".handrail-chat__conversation-avatar-wrap"), null);
  assert.equal(container.querySelector(".handrail-chat__conversation-avatar-stack"), null);
  assert.deepEqual(rows.map((row) => row.querySelector(".handrail-chat__conversation-icon")
    ?.getAttribute("aria-hidden")), ["true", "true"]);
  assert.deepEqual(rows.map((row) => row.querySelector(".handrail-chat__conversation-icon")
    ?.textContent), ["", ""]);
});

test("direct-message rows render safe participant identity, presence, bounded groups, and retain roving unread semantics", async () => {
  const onlineId = "user-navigation-online";
  const offlineId = "user-navigation-offline";
  const longNameId = "user-navigation-long-name";
  const redactedId = "user-navigation-redacted";
  const unavailableId = "user-navigation-unavailable";
  const unresolvedId = "user-navigation-unresolved";
  const groupIds = Array.from({ length: 5 }, (_, index) =>
    `user-navigation-group-${index + 1}`);
  const longName = "A participant with a deliberately long display name that must truncate safely";
  const users = new Map([
    [actorId, Object.freeze({
      kind: "active",
      userId: actorId,
      displayName: "Current User",
      avatar: Object.freeze({ kind: "initials", initials: "CU" }),
    })],
    [onlineId, Object.freeze({
      kind: "active",
      userId: onlineId,
      displayName: "Online Avery",
      avatar: Object.freeze({ kind: "initials", initials: "OA" }),
      status: Object.freeze({ availability: "online" }),
    })],
    [offlineId, Object.freeze({
      kind: "active",
      userId: offlineId,
      displayName: "Offline Blake",
      avatar: Object.freeze({ kind: "initials", initials: "OB" }),
      status: Object.freeze({ availability: "offline" }),
    })],
    [longNameId, Object.freeze({
      kind: "active",
      userId: longNameId,
      displayName: longName,
      avatar: Object.freeze({ kind: "none" }),
      status: Object.freeze({ availability: "away" }),
    })],
    [redactedId, Object.freeze({ kind: "redacted", userId: redactedId })],
    [unavailableId, Object.freeze({
      kind: "unavailable",
      userId: unavailableId,
      reason: "temporarily_unavailable",
    })],
    ...groupIds.map((participantId, index) => [participantId, Object.freeze({
      kind: "active",
      userId: participantId,
      displayName: `Group member ${index + 1}`,
      avatar: Object.freeze({ kind: "initials", initials: `G${index + 1}` }),
    })]),
  ]);
  const onlineConversation = {
    ...directConversation("conversation-navigation-online"),
    activeMemberUserIds: [actorId, onlineId],
    latestSequence: 1,
  };
  const offlineConversation = {
    ...directConversation("conversation-navigation-offline"),
    activeMemberUserIds: [offlineId, actorId],
  };
  const smallGroupConversation = {
    ...groupDirectConversation("conversation-navigation-small-group"),
    activeMemberUserIds: [actorId, onlineId, offlineId],
  };
  const largeGroupConversation = {
    ...groupDirectConversation("conversation-navigation-large-group"),
    activeMemberUserIds: [actorId, ...groupIds],
  };
  const longNameConversation = {
    ...directConversation("conversation-navigation-long-name"),
    activeMemberUserIds: [actorId, longNameId],
  };
  const redactedConversation = {
    ...directConversation("conversation-navigation-redacted"),
    activeMemberUserIds: [actorId, redactedId],
  };
  const unavailableConversation = {
    ...directConversation("conversation-navigation-unavailable"),
    activeMemberUserIds: [actorId, unavailableId],
  };
  const unresolvedConversation = {
    ...directConversation("conversation-navigation-unresolved"),
    activeMemberUserIds: [actorId, unresolvedId],
  };
  const conversations = [
    onlineConversation,
    offlineConversation,
    smallGroupConversation,
    largeGroupConversation,
    longNameConversation,
    redactedConversation,
    unavailableConversation,
    unresolvedConversation,
  ];
  const cache = createCache({ organization: conversations, details: [] });
  const baseClient = createClient(cache);
  const client = {
    ...baseClient,
    selectDirectoryUser: (selectedUserId) => users.get(selectedUserId),
    hydrateDirectoryUsers: async () => ({ status: "success", value: { users: [] } }),
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: undefined,
    currentUserId: actorId,
  }));
  const row = (conversationId) => container.querySelector(
    `[data-conversation-id="${conversationId}"]`,
  );
  let onlineRow = row(onlineConversation.id);
  const offlineRow = row(offlineConversation.id);
  const smallGroupRow = row(smallGroupConversation.id);
  const largeGroupRow = row(largeGroupConversation.id);
  const longNameRow = row(longNameConversation.id);
  const redactedRow = row(redactedConversation.id);
  const unavailableRow = row(unavailableConversation.id);
  const unresolvedRow = row(unresolvedConversation.id);

  assert.equal(onlineRow.querySelector(".handrail-chat__conversation-label").textContent, "Online Avery");
  assert.equal(onlineRow.querySelector(".handrail-chat__conversation-presence").dataset.availability, "online");
  assert.equal(
    onlineRow.getAttribute("aria-label"),
    "Online Avery (online), 1 unread message, Notifications: All messages; Unmuted",
  );
  assert.equal(onlineRow.title, onlineRow.getAttribute("aria-label"));
  assert.equal(onlineRow.querySelector(".handrail-chat__conversation-unread-badge").textContent, "1");
  assert.equal(onlineRow.classList.contains("handrail-chat__conversation-button--unread"), true);
  assert.equal(offlineRow.querySelector(".handrail-chat__conversation-label").textContent, "Offline Blake");
  assert.equal(offlineRow.querySelector(".handrail-chat__conversation-presence").dataset.availability, "offline");
  assert.equal(
    offlineRow.getAttribute("aria-label"),
    "Offline Blake (offline), Notifications: All messages; Unmuted",
  );

  assert.equal(
    smallGroupRow.querySelector(".handrail-chat__conversation-label").textContent,
    "Online Avery, Offline Blake",
  );
  assert.equal(smallGroupRow.querySelectorAll(".handrail-chat__conversation-avatar-wrap").length, 2);
  assert.equal(
    smallGroupRow.getAttribute("aria-label"),
    "Online Avery (online), Offline Blake (offline), Notifications: All messages; Unmuted",
  );
  assert.equal(largeGroupRow.querySelectorAll(".handrail-chat__conversation-avatar-wrap").length, 3);
  assert.equal(largeGroupRow.querySelector(".handrail-chat__conversation-avatar-overflow").textContent, "+2");
  assert.equal(
    largeGroupRow.querySelector(".handrail-chat__conversation-avatar-overflow").dataset.overflowCount,
    "2",
  );
  assert.match(largeGroupRow.title, /Group member 1, Group member 2, Group member 3, Group member 4, Group member 5/);

  assert.equal(longNameRow.querySelector(".handrail-chat__conversation-label").textContent, longName);
  assert.equal(
    longNameRow.title,
    `${longName} (away), Notifications: All messages; Unmuted`,
  );
  assert.equal(redactedRow.querySelector(".handrail-chat__conversation-label").textContent, "Hidden user");
  assert.equal(unavailableRow.querySelector(".handrail-chat__conversation-label").textContent, "Unavailable user");
  assert.equal(unresolvedRow.querySelector(".handrail-chat__conversation-label").textContent, "Unknown participant");
  assert.doesNotMatch(redactedRow.textContent + redactedRow.title, /user-navigation-redacted/);
  assert.doesNotMatch(unavailableRow.textContent + unavailableRow.title, /user-navigation-unavailable|temporarily_unavailable/);
  assert.doesNotMatch(unresolvedRow.textContent + unresolvedRow.title, /user-navigation-unresolved/);
  assert.doesNotMatch(container.querySelector(".handrail-chat__conversation-sections").textContent, /Current User/);

  assert.equal(container.querySelectorAll(
    '.handrail-chat__conversation-button[aria-current="page"]',
  ).length, 1);
  assert.equal(container.querySelectorAll(".handrail-chat__conversation-button[tabindex=\"0\"]").length, 1);
  assert.equal(onlineRow.getAttribute("aria-current"), "page");
  onlineRow.focus();
  const arrowDown = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "ArrowDown",
  });
  await act(async () => {
    onlineRow.dispatchEvent(arrowDown);
    await flush();
  });
  onlineRow = row(onlineConversation.id);
  assert.equal(arrowDown.defaultPrevented, true);
  assert.equal(onlineRow.getAttribute("aria-current"), null);
  assert.equal(row(offlineConversation.id).getAttribute("aria-current"), "page");
  assert.equal(document.activeElement, row(offlineConversation.id));
  assert.equal(container.querySelectorAll(
    '.handrail-chat__conversation-button[aria-current="page"]',
  ).length, 1);
  assert.equal(container.querySelectorAll(".handrail-chat__conversation-button[tabindex=\"0\"]").length, 1);
});

test("navigation rows project notification levels and finite or indefinite mute state without weakening unread selection", async () => {
  const finiteUntil = "2042-03-04T05:06:07.000Z";
  const withPreference = (item, notificationPreference, mute) => ({
    ...item,
    currentPreference: {
      conversationId: item.id,
      userId: actorId,
      notificationPreference,
      mute,
      updatedAt: now,
    },
  });
  const finite = withPreference({
    ...conversation("conversation-navigation-finite", "Finite mute"),
    latestSequence: 4,
    unreadMentionCount: 2,
  }, "all", { muted: true, mutedUntil: finiteUntil });
  const indefinite = withPreference(
    conversation("conversation-navigation-indefinite", "Indefinite mute"),
    "all",
    { muted: true },
  );
  const mentions = withPreference(
    conversation("conversation-navigation-mentions", "Mentions"),
    "mentions",
    { muted: false },
  );
  const none = withPreference(
    conversation("conversation-navigation-none", "No notifications"),
    "none",
    { muted: false },
  );
  const unmuted = withPreference(
    conversation("conversation-navigation-unmuted", "All notifications"),
    "all",
    { muted: false },
  );
  const missingPreference = conversation(
    "conversation-navigation-missing-preference",
    "Default preference",
  );
  const conversations = [
    finite,
    indefinite,
    mentions,
    none,
    unmuted,
    missingPreference,
  ];
  const cache = createCache({
    organization: conversations,
    details: [],
  });
  const canonicalState = structuredClone(cache.getState());
  delete canonicalState.currentUser.preferences[missingPreference.id];
  assert.equal(cache.hydrateCanonicalState(canonicalState), true);
  const container = await renderWorkspace(workspace(createClient(cache), {
    conversationId: finite.id,
  }));
  const row = (conversationId) => container.querySelector(
    `[data-conversation-id="${conversationId}"]`,
  );
  const finiteRow = row(finite.id);
  const indefiniteRow = row(indefinite.id);
  const mentionsRow = row(mentions.id);
  const noneRow = row(none.id);
  const unmutedRow = row(unmuted.id);
  const missingRow = row(missingPreference.id);

  assert.deepEqual(
    [finiteRow, indefiniteRow, mentionsRow, noneRow, unmutedRow, missingRow]
      .map(({ dataset }) => [
        dataset.notificationLevel,
        dataset.muteState,
        dataset.muted,
        dataset.mutedUntil,
      ]),
    [
      ["all", "finite", "true", finiteUntil],
      ["all", "indefinite", "true", undefined],
      ["mentions", "unmuted", "false", undefined],
      ["none", "unmuted", "false", undefined],
      ["all", "unmuted", "false", undefined],
      ["all", "unmuted", "false", undefined],
    ],
  );
  assert.equal(finiteRow.getAttribute("aria-current"), "page");
  assert.equal(
    finiteRow.getAttribute("aria-label"),
    `Finite mute, 4 unread messages, 2 unread mentions, Notifications: All messages; Muted until ${finiteUntil}`,
  );
  assert.equal(finiteRow.title, finiteRow.getAttribute("aria-label"));
  assert.equal(
    finiteRow.querySelector(".handrail-chat__conversation-mention-badge").textContent,
    "@2",
  );
  assert.equal(finiteRow.querySelector(".handrail-chat__conversation-unread-badge"), null);
  assert.equal(
    finiteRow.classList.contains("handrail-chat__conversation-button--unread"),
    true,
  );
  assert.equal(
    indefiniteRow.getAttribute("aria-label"),
    "Indefinite mute, Notifications: All messages; Muted indefinitely",
  );
  assert.equal(
    mentionsRow.getAttribute("aria-label"),
    "Mentions, Notifications: Mentions only; Unmuted",
  );
  assert.equal(
    mentionsRow.querySelector(".handrail-chat__conversation-mention-badge"),
    null,
  );
  assert.equal(
    noneRow.getAttribute("aria-label"),
    "No notifications, Notifications: No notifications; Unmuted",
  );
  assert.equal(
    missingRow.getAttribute("aria-label"),
    "Default preference, Notifications: All messages; Unmuted",
  );
  const finiteIndicator = finiteRow.querySelector(
    ".handrail-chat__conversation-muted-indicator",
  );
  const indefiniteIndicator = indefiniteRow.querySelector(
    ".handrail-chat__conversation-muted-indicator",
  );
  assert.ok(finiteIndicator);
  assert.equal(finiteIndicator.dataset.muteState, "finite");
  assert.equal(finiteIndicator.title, `Muted until ${finiteUntil}`);
  assert.ok(finiteIndicator.querySelector("svg"));
  assert.ok(indefiniteIndicator);
  assert.equal(indefiniteIndicator.dataset.muteState, "indefinite");
  assert.equal(indefiniteIndicator.title, "Muted indefinitely");
  for (const currentRow of [mentionsRow, noneRow, unmutedRow, missingRow]) {
    assert.equal(
      currentRow.querySelector(".handrail-chat__conversation-muted-indicator"),
      null,
      "unmuted rows do not render a mute indicator",
    );
  }
  assert.equal(
    container.querySelector(".handrail-chat__conversation-notification-preferences"),
    null,
  );
  assert.equal(container.innerHTML.includes(actorId), false);
  assert.equal(container.innerHTML.includes(otherUserId), false);
});

test("notification preferences are available from the detail header but not navigation rows", async () => {
  const cache = createCache();
  const container = await renderWorkspace(workspace(createClient(cache)));
  const navigation = container.querySelector(".handrail-chat__navigation");
  const header = container.querySelector(".handrail-chat__header");

  assert.equal(
    navigation.querySelector(".handrail-chat__notification-preferences-trigger"),
    null,
  );
  assert.equal(
    navigation.querySelector(".handrail-chat__notification-preferences-panel"),
    null,
  );
  const headerTrigger = header.querySelector(
    ".handrail-chat__notification-preferences-trigger",
  );
  assert.ok(headerTrigger);
  assert.equal(
    headerTrigger.getAttribute("aria-label"),
    "Notification preferences: All messages; Unmuted",
  );
  await click(headerTrigger);
  assert.ok(header.querySelector(".handrail-chat__notification-preferences-panel"));
});

test("navigation rows render active huddle metadata across selected and non-selected state transitions", async () => {
  const activeSelected = {
    ...conversation("conversation-navigation-huddle-selected", "Selected call"),
    hasActiveHuddle: true,
    latestSequence: 4,
    unreadMentionCount: 2,
    currentPreference: {
      conversationId: "conversation-navigation-huddle-selected",
      userId: actorId,
      notificationPreference: "all",
      mute: { muted: true },
      updatedAt: now,
    },
  };
  const inactiveUnselected = {
    ...conversation("conversation-navigation-huddle-unselected", "Other call"),
    hasActiveHuddle: false,
  };
  const cache = createCache({
    organization: [activeSelected, inactiveUnselected],
    details: [],
  });
  const container = await renderWorkspace(workspace(createClient(cache), {
    conversationId: activeSelected.id,
  }));
  assert.equal(
    cache.getState().metadata.conversationListActiveHuddles[activeSelected.id],
    true,
  );
  assert.equal(
    "hasActiveHuddle" in cache.getState().entities.conversations[activeSelected.id],
    false,
  );
  const row = (conversationId) => container.querySelector(
    `[data-conversation-id="${conversationId}"]`,
  );
  const huddleIndicator = (currentRow) => currentRow.querySelector(
    ".handrail-chat__conversation-huddle-indicator",
  );
  let selectedRow = row(activeSelected.id);
  let unselectedRow = row(inactiveUnselected.id);

  assert.equal(selectedRow.getAttribute("aria-current"), "page");
  assert.equal(selectedRow.dataset.huddleState, "active");
  assert.equal(
    selectedRow.getAttribute("aria-label"),
    "Selected call, 4 unread messages, 2 unread mentions, Active huddle, Notifications: All messages; Muted indefinitely",
  );
  assert.equal(selectedRow.title, selectedRow.getAttribute("aria-label"));
  assert.equal(huddleIndicator(selectedRow)?.dataset.huddleState, "active");
  assert.equal(huddleIndicator(selectedRow)?.getAttribute("aria-hidden"), "true");
  assert.equal(huddleIndicator(selectedRow)?.getAttribute("title"), null);
  assert.ok(huddleIndicator(selectedRow)?.querySelector("svg"));
  assert.equal(selectedRow.querySelector(".handrail-chat__conversation-mention-badge")?.textContent, "@2");

  assert.equal(unselectedRow.getAttribute("aria-current"), null);
  assert.equal(unselectedRow.dataset.huddleState, "inactive");
  assert.equal(
    unselectedRow.getAttribute("aria-label"),
    "Other call, Notifications: All messages; Unmuted",
  );
  assert.equal(unselectedRow.title, unselectedRow.getAttribute("aria-label"));
  assert.equal(huddleIndicator(unselectedRow), null);

  for (const currentRow of [selectedRow, unselectedRow]) {
    assert.equal(currentRow.closest("li").querySelectorAll("button").length, 2);
  }

  await act(async () => {
    cache.hydrateConversationList(listSnapshot(organizationScope, [
      { ...activeSelected, hasActiveHuddle: false },
      { ...inactiveUnselected, hasActiveHuddle: true },
    ]));
    await flush();
  });
  selectedRow = row(activeSelected.id);
  unselectedRow = row(inactiveUnselected.id);

  assert.equal(
    cache.getState().metadata.conversationListActiveHuddles[activeSelected.id],
    false,
  );
  assert.equal(
    cache.getState().metadata.conversationListActiveHuddles[inactiveUnselected.id],
    true,
  );
  assert.equal(selectedRow.dataset.huddleState, "inactive");
  assert.doesNotMatch(selectedRow.getAttribute("aria-label"), /huddle/iu);
  assert.doesNotMatch(selectedRow.title, /huddle/iu);
  assert.equal(huddleIndicator(selectedRow), null);
  assert.equal(unselectedRow.dataset.huddleState, "active");
  assert.equal(
    unselectedRow.getAttribute("aria-label"),
    "Other call, Active huddle, Notifications: All messages; Unmuted",
  );
  assert.equal(unselectedRow.title, unselectedRow.getAttribute("aria-label"));
  assert.equal(huddleIndicator(unselectedRow)?.getAttribute("aria-hidden"), "true");
  assert.equal(unselectedRow.closest("li").querySelectorAll("button").length, 2);
});

test("navigation preference projection stays isolated to each cache actor", async () => {
  const actorCache = (userId, notificationPreference, mute) => {
    const cache = createNormalizedChatCache({ ...identity, userId });
    const item = {
      ...firstConversation,
      currentMember: { ...member(firstId), userId },
      currentReadState: { ...readState(firstId), userId },
      currentPreference: {
        conversationId: firstId,
        userId,
        notificationPreference,
        mute,
        updatedAt: now,
      },
    };
    cache.hydrateConversationList(listSnapshot(organizationScope, [item]));
    return cache;
  };
  const firstActorContainer = await renderWorkspace(workspace(createClient(actorCache(
    actorId,
    "none",
    { muted: false },
  ))));
  const secondActorContainer = await renderWorkspace(workspace(createClient(actorCache(
    otherUserId,
    "mentions",
    { muted: true },
  ))));
  const firstActorRow = firstActorContainer.querySelector(
    `[data-conversation-id="${firstId}"]`,
  );
  const secondActorRow = secondActorContainer.querySelector(
    `[data-conversation-id="${firstId}"]`,
  );

  assert.equal(firstActorRow.dataset.notificationLevel, "none");
  assert.equal(firstActorRow.dataset.muteState, "unmuted");
  assert.match(firstActorRow.getAttribute("aria-label"), /No notifications; Unmuted/u);
  assert.equal(secondActorRow.dataset.notificationLevel, "mentions");
  assert.equal(secondActorRow.dataset.muteState, "indefinite");
  assert.match(
    secondActorRow.getAttribute("aria-label"),
    /Mentions only; Muted indefinitely/u,
  );
  assert.equal(firstActorContainer.innerHTML.includes(actorId), false);
  assert.equal(firstActorContainer.innerHTML.includes(otherUserId), false);
  assert.equal(secondActorContainer.innerHTML.includes(actorId), false);
  assert.equal(secondActorContainer.innerHTML.includes(otherUserId), false);
});

test("fifty direct-message rows use list participant snapshots without detail or per-row hydration", async () => {
  const users = new Map([[actorId, actorDirectoryUser]]);
  const conversations = Array.from({ length: 50 }, (_, index) => {
    const participantCount = index % 2 === 0 ? 1 : 4;
    const participantIds = Array.from({ length: participantCount }, (_, participantIndex) => {
      const participantId = `user-navigation-scale-${index}-${participantIndex}`;
      users.set(participantId, Object.freeze({
        kind: "active",
        userId: participantId,
        displayName: `Person ${index + 1}.${participantIndex + 1}`,
        avatar: Object.freeze({ kind: "initials", initials: "P" }),
      }));
      return participantId;
    });
    const item = index % 2 === 0
      ? directConversation(`conversation-navigation-scale-${index}`)
      : groupDirectConversation(`conversation-navigation-scale-${index}`);
    return { ...item, activeMemberUserIds: [actorId, ...participantIds] };
  });
  const cache = createCache({ organization: conversations, details: [] });
  const baseClient = createClient(cache);
  const calls = { detail: 0, directory: 0 };
  const client = {
    ...baseClient,
    async getConversation(...args) {
      calls.detail += 1;
      return baseClient.getConversation(...args);
    },
    selectDirectoryUser: (selectedUserId) => users.get(selectedUserId),
    async hydrateDirectoryUsers() {
      calls.directory += 1;
      return { status: "success", value: { users: [] } };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: null,
    currentUserId: actorId,
  }));
  const rows = [...container.querySelectorAll(".handrail-chat__conversation-button")];

  assert.equal(rows.length, 50);
  assert.equal(rows.every((button) =>
    !["Direct conversation", "Group conversation"].includes(
      button.querySelector(".handrail-chat__conversation-label").textContent,
    )), true);
  assert.equal(container.querySelectorAll(".handrail-chat__conversation-avatar-stack").length, 25);
  assert.equal([...container.querySelectorAll(".handrail-chat__conversation-avatar-stack")]
    .every((stack) => stack.querySelectorAll(".handrail-chat__conversation-avatar-wrap").length === 3), true);
  assert.equal(container.querySelectorAll(".handrail-chat__conversation-avatar-overflow").length, 25);
  assert.deepEqual(calls, { detail: 0, directory: 0 });
});

test("uncontrolled hydration synchronously exposes exactly one current conversation", () => {
  const unavailableDefaultId = "conversation-no-longer-available";
  const markup = renderToStaticMarkup(workspace(createClient(createCache()), {
    conversationId: undefined,
    defaultConversationId: unavailableDefaultId,
  }));
  const container = document.createElement("div");
  container.innerHTML = markup;

  const currentRows = container.querySelectorAll(
    '.handrail-chat__conversation-button[aria-current="page"]',
  );
  assert.equal(currentRows.length, 1);
  assert.equal(currentRows[0].dataset.conversationId, firstId);
  assert.equal(container.querySelector("article")?.dataset.timelineFor, firstId);
});

test("mixed conversation kinds render Starred first with projection-scoped row identity", () => {
  const publicFirstBase = conversation("conversation-public-first", "Public first");
  const publicFirst = {
    ...publicFirstBase,
    latestSequence: 3,
    unreadMentionCount: 1,
    currentPreference: {
      ...publicFirstBase.currentPreference,
      isStarred: true,
    },
  };
  const publicSecond = conversation("conversation-public-second", "Public second");
  const privateFirst = {
    ...conversation("conversation-private-first", "Private first"),
    visibility: "private",
    latestSequence: 7,
  };
  const privateSecond = {
    ...conversation("conversation-private-second", "Private second"),
    visibility: "private",
  };
  const groupFirst = groupDirectConversation("conversation-group-first");
  const directSecond = {
    ...directConversation("conversation-direct-second"),
    latestSequence: 1,
  };
  const thread = {
    ...threadConversation("conversation-thread-first", publicFirst.id),
    latestSequence: 2,
  };
  const serverOrder = [
    privateFirst,
    groupFirst,
    publicFirst,
    directSecond,
    privateSecond,
    thread,
    publicSecond,
  ];
  const markup = renderToStaticMarkup(workspace(createClient(createCache({
    organization: serverOrder,
    details: [],
  })), { conversationId: directSecond.id }));
  const container = document.createElement("div");
  container.innerHTML = markup;
  const sections = [...container.querySelectorAll(".handrail-chat__conversation-section")];

  assert.deepEqual(
    sections.map((section) => section.querySelector(
      ".handrail-chat__conversation-section-label",
    )?.textContent),
    [
      "Starred",
      "Direct messages",
      "Public channels",
      "Private channels",
      "Group conversations",
      "Recent threads",
    ],
  );
  assert.deepEqual(
    sections.map((section) => section.querySelector(
      ".handrail-chat__conversation-section-count",
    )?.textContent),
    ["1", "1", "2", "2", "1", "1"],
  );
  assert.deepEqual(
    sections.map((section) => [
      section.dataset.conversationSection,
      [...section.querySelectorAll(".handrail-chat__conversation-button")]
        .map((button) => button.dataset.conversationId),
    ]),
    [
      ["starred", [publicFirst.id]],
      ["direct-messages", [directSecond.id]],
      ["public-channels", [publicFirst.id, publicSecond.id]],
      ["private-channels", [privateFirst.id, privateSecond.id]],
      ["group-conversations", [groupFirst.id]],
      ["threads", [thread.id]],
    ],
  );
  for (const section of sections) {
    const heading = section.querySelector("h3");
    const disclosure = heading?.querySelector("button");
    const list = section.querySelector("ul");
    assert.ok(disclosure?.id, "each section disclosure has a stable accessible ID");
    assert.ok(list?.id, "each controlled conversation list has a stable ID");
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.equal(disclosure.getAttribute("aria-controls"), list.id);
    assert.equal(section.getAttribute("aria-labelledby"), disclosure.id);
    assert.equal(list.getAttribute("aria-labelledby"), disclosure.id);
    assert.equal(list.hidden, false);
    assert.equal(
      disclosure.querySelector(
        ".handrail-chat__conversation-section-disclosure-icon",
      )?.getAttribute("aria-hidden"),
      "true",
    );
    const disclosureIcon = disclosure.querySelector(
      ".handrail-chat__conversation-section-disclosure-icon",
    );
    assert.equal(disclosureIcon?.tagName, "svg");
    assert.equal(disclosureIcon?.dataset.navigationIcon, "disclosure");
    assert.equal(disclosureIcon?.getAttribute("focusable"), "false");
    assert.equal(disclosureIcon?.textContent, "");
  }

  const buttons = [...container.querySelectorAll(".handrail-chat__conversation-button")];
  const renderedIds = buttons.map((button) => button.dataset.conversationId);
  assert.equal(renderedIds.length, serverOrder.length + 1);
  assert.equal(new Set(renderedIds).size, serverOrder.length);
  assert.deepEqual(new Set(renderedIds), new Set(serverOrder.map(({ id }) => id)));
  assert.equal(new Set(buttons.map(({ id }) => id)).size, buttons.length);
  assert.equal(
    new Set(buttons.map((button) => button.dataset.navigationRowId)).size,
    buttons.length,
  );
  const projectedPublicRows = buttons.filter(
    (button) => button.dataset.conversationId === publicFirst.id,
  );
  assert.equal(projectedPublicRows.length, 2);
  assert.deepEqual(projectedPublicRows.map((button) => button.getAttribute("aria-current")), [
    null,
    null,
  ]);
  assert.deepEqual(projectedPublicRows.map(({ tabIndex }) => tabIndex), [-1, -1]);
  assert.deepEqual(projectedPublicRows.map((button) => ({
    mentionCount: button.dataset.unreadMentionCount,
    mentionBadge: button.querySelector(
      ".handrail-chat__conversation-mention-badge",
    )?.textContent,
    notificationLevel: button.dataset.notificationLevel,
    unreadLabel: button.getAttribute("aria-label").includes("3 unread messages"),
  })), [
    {
      mentionBadge: "@1",
      mentionCount: "1",
      notificationLevel: "all",
      unreadLabel: true,
    },
    {
      mentionBadge: "@1",
      mentionCount: "1",
      notificationLevel: "all",
      unreadLabel: true,
    },
  ]);
  assert.deepEqual(projectedPublicRows.map((button) => button.closest("li")
    .querySelector(".handrail-chat__conversation-star")?.getAttribute("aria-pressed")), [
    "true",
    "true",
  ]);
  assert.equal(
    container.querySelector(`[data-conversation-id="${privateFirst.id}"]`)
      ?.getAttribute("aria-label"),
    "Private first, 7 unread messages, Notifications: All messages; Unmuted",
  );
  assert.equal(
    container.querySelector(`[data-conversation-id="${directSecond.id}"]`)
      ?.getAttribute("aria-label"),
    "Avery Example, 1 unread message, Notifications: All messages; Unmuted",
  );
  assert.equal(
    container.querySelector(`[data-conversation-id="${thread.id}"]`)
      ?.querySelector(".handrail-chat__conversation-unread-badge")?.textContent,
    "2",
  );
  assert.equal(
    container.querySelector(`[data-conversation-id="${thread.id}"]`)
      ?.querySelector("[data-navigation-icon]")?.dataset.navigationIcon,
    "thread",
  );

  const withoutThreadMarkup = renderToStaticMarkup(workspace(createClient(createCache({
    organization: serverOrder.filter(({ type }) => type !== "thread"),
    details: serverOrder.filter(({ type }) => type !== "thread"),
  }))));
  const withoutThread = document.createElement("div");
  withoutThread.innerHTML = withoutThreadMarkup;
  const emptyThreads = withoutThread.querySelector(
    '[data-conversation-section="threads"]',
  );
  assert.ok(emptyThreads);
  assert.equal(
    emptyThreads.querySelector(".handrail-chat__conversation-section-count")
      .textContent,
    "0",
  );
  assert.equal(
    emptyThreads.querySelector(".handrail-chat__conversation-section-empty")
      .textContent,
    "No recent threads. Browse a channel to find threads.",
  );
});

test("empty navigation sections retain concise copy and collapsible list relationships", async () => {
  const cache = createCache({ organization: [], details: [] });
  const container = await renderWorkspace(workspace(createClient(cache), {
    conversationId: null,
  }));
  const expected = [
    ["direct-messages", "Direct messages", "No direct messages yet."],
    ["public-channels", "Public channels", "No public channels yet."],
    ["private-channels", "Private channels", "No private channels yet."],
    [
      "group-conversations",
      "Group conversations",
      "No group conversations yet.",
    ],
    ["threads", "Recent threads", "No recent threads. Browse a channel to find threads."],
  ];
  const sections = [...container.querySelectorAll(
    ".handrail-chat__conversation-section",
  )];

  assert.equal(sections.length, expected.length);
  for (const [index, [kind, label, emptyCopy]] of expected.entries()) {
    const section = sections[index];
    const disclosure = section.querySelector(
      ".handrail-chat__conversation-section-disclosure",
    );
    const list = section.querySelector("ul");
    assert.equal(section.dataset.conversationSection, kind);
    assert.equal(
      disclosure.querySelector(".handrail-chat__conversation-section-label")
        .textContent,
      label,
    );
    assert.equal(
      disclosure.querySelector(".handrail-chat__conversation-section-count")
        .textContent,
      "0",
    );
    assert.equal(
      list.querySelector(".handrail-chat__conversation-section-empty").textContent,
      emptyCopy,
    );
    assert.equal(disclosure.getAttribute("aria-controls"), list.id);
    assert.equal(section.getAttribute("aria-labelledby"), disclosure.id);
    assert.equal(list.getAttribute("aria-labelledby"), disclosure.id);
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.equal(list.hidden, false);
  }

  const threads = sections.at(-1);
  const threadsDisclosure = threads.querySelector(
    ".handrail-chat__conversation-section-disclosure",
  );
  await click(threadsDisclosure);
  assert.equal(threadsDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(threads.querySelector("ul").hidden, true);
  assert.equal(
    threads.querySelector(".handrail-chat__conversation-section-empty"),
    null,
  );
  await click(threadsDisclosure);
  assert.equal(threadsDisclosure.getAttribute("aria-expanded"), "true");
  assert.equal(
    threads.querySelector(".handrail-chat__conversation-section-empty").textContent,
    "No recent threads. Browse a channel to find threads.",
  );
  assert.equal(
    threads.querySelector(".handrail-chat__conversation-section-action"),
    null,
    "threads never invent a creation action",
  );
});

test("empty section actions open each existing canonical creation dialog", async () => {
  const cache = createCache({ organization: [], details: [] });
  const idleDirectoryState = Object.freeze({ state: "idle" });
  const client = {
    ...createClient(cache),
    getDirectorySearchState: () => idleDirectoryState,
  };
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    conversationId: null,
    currentUserId: actorId,
    directCreationAvailability: { canCreate: true },
    groupDirectCreationAvailability: { canCreate: true },
  }));
  const cases = [
    ["public-channels", "Create public channel", "Create channel", "public"],
    ["private-channels", "Create private channel", "Create channel", "private"],
    ["direct-messages", "Create a direct conversation", "Create direct conversation"],
    [
      "group-conversations",
      "Create a group conversation",
      "Create group conversation",
    ],
  ];

  assert.ok(
    container.querySelector('button[aria-label="Add conversation"]'),
    "the global add affordance remains available",
  );
  for (const [sectionKind, actionLabel, dialogTitle, expectedVisibility] of cases) {
    const section = container.querySelector(
      `[data-conversation-section="${sectionKind}"]`,
    );
    const action = section.querySelector(`button[aria-label="${actionLabel}"]`);
    assert.ok(action, `${actionLabel} is rendered in its matching section`);
    const icon = action.querySelector("[data-navigation-icon]");
    assert.equal(icon?.tagName, "svg");
    assert.equal(
      icon?.dataset.navigationIcon,
      sectionKind === "direct-messages"
        ? "direct"
        : sectionKind === "group-conversations" ? "group-direct" : "add",
    );
    assert.equal(icon?.getAttribute("aria-hidden"), "true");
    assert.equal(icon?.getAttribute("focusable"), "false");
    assert.equal(action.textContent, "");
    assert.equal(action.title, actionLabel);
    await click(action);
    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog, `${actionLabel} opens a dialog`);
    const title = document.getElementById(dialog.getAttribute("aria-labelledby"));
    assert.equal(title?.textContent, dialogTitle);
    if (expectedVisibility !== undefined) {
      assert.equal(
        dialog.querySelector(`input[value="${expectedVisibility}"]`)?.checked,
        true,
        `${actionLabel} preselects ${expectedVisibility} visibility`,
      );
    }
    const cancel = [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel");
    assert.ok(cancel, `${dialogTitle} retains its canonical cancellation control`);
    await click(cancel);
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, action);
  }

  assert.equal(
    container.querySelector(
      '[data-conversation-section="threads"] .handrail-chat__conversation-section-action',
    ),
    null,
  );
});

test("section creation actions fail closed independently and in read-only mode", () => {
  const client = createClient(createCache({ organization: [], details: [] }));
  const renderedActionLabels = (props) => {
    const markup = renderToStaticMarkup(workspace(client, {
      conversationId: null,
      ...props,
    }));
    const container = document.createElement("div");
    container.innerHTML = markup;
    assert.equal(
      container.querySelector(
        '[data-conversation-section="threads"] .handrail-chat__conversation-section-action',
      ),
      null,
    );
    return [...container.querySelectorAll(
      ".handrail-chat__conversation-section-action",
    )].map((button) => button.getAttribute("aria-label"));
  };

  assert.deepEqual(renderedActionLabels({}), []);
  assert.deepEqual(renderedActionLabels({
    channelCreationAvailability: { canCreate: true },
  }), ["Create public channel", "Create private channel"]);
  assert.deepEqual(renderedActionLabels({
    directCreationAvailability: { canCreate: true },
  }), ["Create a direct conversation"]);
  assert.deepEqual(renderedActionLabels({
    groupDirectCreationAvailability: { canCreate: true },
  }), ["Create a group conversation"]);
  assert.deepEqual(renderedActionLabels({
    channelCreationAvailability: { canCreate: false },
    directCreationAvailability: { canCreate: false },
    groupDirectCreationAvailability: { canCreate: false },
  }), []);
  assert.deepEqual(renderedActionLabels({
    channelCreationAvailability: { canCreate: true },
    directCreationAvailability: { canCreate: true },
    groupDirectCreationAvailability: { canCreate: true },
    readOnly: true,
  }), []);
});

test("conversation sections collapse independently without changing the selected detail", async () => {
  const publicFirst = conversation("conversation-collapse-public-first", "Public first");
  const publicSecond = conversation("conversation-collapse-public-second", "Public second");
  const privateChannel = {
    ...conversation("conversation-collapse-private", "Private channel"),
    visibility: "private",
  };
  const direct = directConversation("conversation-collapse-direct");
  const group = groupDirectConversation("conversation-collapse-group");
  const thread = threadConversation("conversation-collapse-thread", publicFirst.id);
  const conversations = [group, direct, publicFirst, thread, privateChannel, publicSecond];
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: conversations,
    details: conversations,
  })), {
    conversationId: undefined,
    defaultConversationId: publicFirst.id,
  }));
  const section = (kind) => container.querySelector(
    `[data-conversation-section="${kind}"]`,
  );
  const disclosure = (kind) => section(kind).querySelector(
    ".handrail-chat__conversation-section-disclosure",
  );
  const visibleConversationIds = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-button",
  )].map((button) => button.dataset.conversationId);
  const press = async (conversationId, key) => {
    const source = container.querySelector(`[data-conversation-id="${conversationId}"]`);
    assert.ok(source, `missing visible keyboard source ${conversationId}`);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    });
    await act(async () => {
      source.dispatchEvent(event);
      await flush();
    });
    assert.equal(event.defaultPrevented, true);
  };

  const publicDisclosure = disclosure("public-channels");
  const privateDisclosure = disclosure("private-channels");
  await click(publicDisclosure);
  assert.equal(publicDisclosure.getAttribute("aria-expanded"), "false");
  assert.equal(section("public-channels").querySelector("ul").hidden, true);
  assert.equal(section("public-channels").querySelectorAll(
    ".handrail-chat__conversation-button",
  ).length, 0);
  assert.equal(privateDisclosure.getAttribute("aria-expanded"), "true");
  assert.equal(container.querySelector("article").dataset.timelineFor, publicFirst.id);
  assert.deepEqual(
    visibleConversationIds(),
    [privateChannel.id, direct.id, group.id, thread.id],
  );
  assert.equal(
    container.querySelector(`[data-conversation-id="${privateChannel.id}"]`).tabIndex,
    0,
  );

  await click(publicDisclosure);
  assert.equal(publicDisclosure.getAttribute("aria-expanded"), "true");
  assert.deepEqual(visibleConversationIds(), [
    publicFirst.id,
    publicSecond.id,
    privateChannel.id,
    direct.id,
    group.id,
    thread.id,
  ]);
  assert.equal(
    container.querySelector(`[data-conversation-id="${publicFirst.id}"]`)
      .getAttribute("aria-current"),
    "page",
  );
  assert.equal(container.querySelector("article").dataset.timelineFor, publicFirst.id);

  await click(publicDisclosure);
  await click(disclosure("direct-messages"));
  assert.equal(privateDisclosure.getAttribute("aria-expanded"), "true");
  assert.equal(
    disclosure("group-conversations").getAttribute("aria-expanded"),
    "true",
  );
  assert.deepEqual(visibleConversationIds(), [privateChannel.id, group.id, thread.id]);
  await click(disclosure("group-conversations"));
  assert.equal(disclosure("direct-messages").getAttribute("aria-expanded"), "false");
  assert.deepEqual(visibleConversationIds(), [privateChannel.id, thread.id]);
  container.querySelector(`[data-conversation-id="${privateChannel.id}"]`).focus();
  await press(privateChannel.id, "ArrowDown");
  assert.equal(document.activeElement.dataset.conversationId, thread.id);
  await press(thread.id, "Home");
  assert.equal(document.activeElement.dataset.conversationId, privateChannel.id);
  await press(privateChannel.id, "End");
  assert.equal(document.activeElement.dataset.conversationId, thread.id);

  await click(disclosure("direct-messages"));
  assert.deepEqual(visibleConversationIds(), [privateChannel.id, direct.id, thread.id]);
  container.querySelector(`[data-conversation-id="${privateChannel.id}"]`).focus();
  await press(privateChannel.id, "ArrowDown");
  assert.equal(document.activeElement.dataset.conversationId, direct.id);

  await click(disclosure("group-conversations"));
  assert.deepEqual(
    visibleConversationIds(),
    [privateChannel.id, direct.id, group.id, thread.id],
  );
  await press(direct.id, "ArrowDown");
  assert.equal(document.activeElement.dataset.conversationId, group.id);
});

test("conversation filtering reveals matches without replacing collapsed preferences", async () => {
  const publicChannel = conversation("conversation-filter-collapse-public", "Public match");
  const privateChannel = {
    ...conversation("conversation-filter-collapse-private", "Private channel"),
    visibility: "private",
  };
  const direct = directConversation("conversation-filter-collapse-direct");
  const group = groupDirectConversation("conversation-filter-collapse-group");
  const conversations = [group, direct, privateChannel, publicChannel];
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: conversations,
    details: conversations,
  })), { conversationId: undefined }));
  const section = (kind) => container.querySelector(
    `[data-conversation-section="${kind}"]`,
  );
  const disclosure = (kind) => section(kind).querySelector(
    ".handrail-chat__conversation-section-disclosure",
  );
  const filter = container.querySelector('input[name="conversationFilter"]');

  await click(disclosure("public-channels"));
  await click(disclosure("direct-messages"));
  await click(disclosure("group-conversations"));
  assert.equal(disclosure("public-channels").getAttribute("aria-expanded"), "false");
  assert.equal(disclosure("direct-messages").getAttribute("aria-expanded"), "false");
  assert.equal(
    disclosure("group-conversations").getAttribute("aria-expanded"),
    "false",
  );

  await enterText(filter, "public match");
  const filteredDisclosure = disclosure("public-channels");
  assert.equal(filteredDisclosure.getAttribute("aria-expanded"), "true");
  assert.equal(filteredDisclosure.disabled, true);
  assert.equal(section("public-channels").querySelector("ul").hidden, false);
  assert.deepEqual(
    [...container.querySelectorAll(".handrail-chat__conversation-button")]
      .map((button) => button.dataset.conversationId),
    [publicChannel.id],
  );

  await enterText(filter, "direct conversation");
  assert.deepEqual(
    [...container.querySelectorAll(".handrail-chat__conversation-button")]
      .map((button) => button.dataset.conversationId),
    [direct.id],
  );

  await enterText(filter, "group conversation");
  assert.equal(
    disclosure("group-conversations").getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(disclosure("group-conversations").disabled, true);
  assert.deepEqual(
    [...container.querySelectorAll(".handrail-chat__conversation-button")]
      .map((button) => button.dataset.conversationId),
    [group.id],
  );

  await enterText(filter, "");
  assert.equal(disclosure("public-channels").getAttribute("aria-expanded"), "false");
  assert.equal(disclosure("direct-messages").getAttribute("aria-expanded"), "false");
  assert.equal(
    disclosure("group-conversations").getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(section("public-channels").querySelector("ul").hidden, true);
  assert.equal(section("direct-messages").querySelector("ul").hidden, true);
  assert.equal(section("group-conversations").querySelector("ul").hidden, true);
  assert.deepEqual(
    [...container.querySelectorAll(".handrail-chat__conversation-button")]
      .map((button) => button.dataset.conversationId),
    [privateChannel.id],
  );

  await click(disclosure("public-channels"));
  assert.deepEqual(
    [...container.querySelectorAll(".handrail-chat__conversation-button")]
      .map((button) => button.dataset.conversationId),
    [publicChannel.id, privateChannel.id],
  );
});

test("conversation filter matches every current label case-insensitively and preserves sections", async () => {
  const publicChannel = conversation(
    "conversation-filter-public",
    "Public Label Alpha",
  );
  const privateChannel = {
    ...conversation("conversation-filter-private", "Private LABEL Beta"),
    visibility: "private",
  };
  const direct = directConversation("conversation-filter-direct");
  const group = groupDirectConversation("conversation-filter-group");
  const thread = threadConversation("conversation-filter-thread", publicChannel.id);
  const conversations = [privateChannel, direct, publicChannel, thread, group];
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: conversations,
    details: conversations,
  })), { conversationId: undefined }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  const visibleLabels = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-label",
  )].map((label) => label.textContent);
  const visibleSections = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-section",
  )].map((section) => section.dataset.conversationSection);

  assert.ok(filter);
  assert.equal(filter.type, "search");
  const filterLabel = [...filter.labels].find((label) =>
    label.textContent === "Search conversations");
  assert.ok(filterLabel);
  const filterIcon = filterLabel.querySelector(
    '.handrail-chat__conversation-filter-icon[data-navigation-icon="search"]',
  );
  assert.equal(filterIcon?.tagName, "svg");
  assert.equal(filterIcon?.getAttribute("aria-hidden"), "true");
  assert.equal(filterIcon?.getAttribute("focusable"), "false");
  assert.equal(filterIcon?.getAttribute("fill"), "none");
  assert.equal(filterIcon?.getAttribute("stroke"), "currentColor");
  assert.equal(filterIcon?.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(filterIcon?.textContent, "");
  assert.equal(filterIcon?.querySelector("title"), null);
  assert.equal(filterIcon?.hasAttribute("tabindex"), false);
  const shortcutHintId = filter.getAttribute("aria-describedby");
  assert.ok(shortcutHintId, "the filter names its shortcut description");
  const shortcutHint = container.querySelector(`#${shortcutHintId}`);
  assert.equal(shortcutHint?.tagName, "KBD");
  assert.equal(
    shortcutHint?.classList.contains("handrail-chat__conversation-filter-shortcut"),
    true,
  );
  assert.equal(shortcutHint?.textContent, "Keyboard shortcut: /");
  assert.equal(shortcutHint?.closest("label"), null);

  await enterText(filter, "pUbLiC lAbEl");
  assert.deepEqual(visibleLabels(), ["Public Label Alpha"]);
  assert.deepEqual(visibleSections(), ["public-channels"]);

  await enterText(filter, "PRIVATE label");
  assert.deepEqual(visibleLabels(), ["Private LABEL Beta"]);
  assert.deepEqual(visibleSections(), ["private-channels"]);

  await enterText(filter, "label");
  assert.deepEqual(visibleLabels(), ["Public Label Alpha", "Private LABEL Beta"]);
  assert.deepEqual(visibleSections(), ["public-channels", "private-channels"]);

  await enterText(filter, "DIRECT CONVERSATION");
  assert.deepEqual(visibleLabels(), ["Avery Example"]);
  assert.deepEqual(visibleSections(), ["direct-messages"]);

  await enterText(filter, "gRoUp CoNvErSaTiOn");
  assert.deepEqual(visibleLabels(), ["Avery Example"]);
  assert.deepEqual(visibleSections(), ["group-conversations"]);

  await enterText(filter, "tHrEaD");
  assert.deepEqual(visibleLabels(), ["Thread"]);
  assert.deepEqual(visibleSections(), ["threads"]);
});

test("conversation filter matches participant display names in direct and group conversations", async () => {
  const graceUserId = "user-conversation-filter-grace";
  const margaretUserId = "user-conversation-filter-margaret";
  const grace = Object.freeze({
    kind: "active",
    userId: graceUserId,
    displayName: "Grace Hopper",
    avatar: Object.freeze({ kind: "initials", initials: "GH" }),
  });
  const margaret = Object.freeze({
    kind: "active",
    userId: margaretUserId,
    displayName: "Margaret Hamilton",
    avatar: Object.freeze({ kind: "initials", initials: "MH" }),
  });
  const direct = {
    ...directConversation("conversation-filter-grace-direct"),
    activeMemberUserIds: [actorId, graceUserId],
  };
  const group = {
    ...groupDirectConversation("conversation-filter-grace-group"),
    activeMemberUserIds: [actorId, graceUserId, margaretUserId],
  };
  const cache = createCache({
    organization: [direct, group],
    details: [],
  });
  const directoryUsers = new Map([
    [graceUserId, grace],
    [margaretUserId, margaret],
  ]);
  const client = {
    ...createClient(cache),
    selectDirectoryUser: (userId) => directoryUsers.get(userId),
    hydrateDirectoryUsers: async (userIds) => ({
      status: "success",
      value: {
        users: userIds.flatMap((userId) => {
          const user = directoryUsers.get(userId);
          return user === undefined ? [] : [user];
        }),
      },
    }),
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: undefined,
    currentUserId: actorId,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  const visibleLabels = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-label",
  )].map((label) => label.textContent);
  const visibleSections = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-section",
  )].map((section) => section.dataset.conversationSection);

  await enterText(filter, "gRaCe");
  assert.deepEqual(visibleLabels(), [
    "Grace Hopper",
    "Grace Hopper, Margaret Hamilton",
  ]);
  assert.deepEqual(visibleSections(), ["direct-messages", "group-conversations"]);
  assert.equal(container.querySelector(".handrail-chat__conversation-filter-empty"), null);

  await enterText(filter, "MARGARET");
  assert.deepEqual(visibleLabels(), ["Grace Hopper, Margaret Hamilton"]);
  assert.deepEqual(visibleSections(), ["group-conversations"]);
});

test("unmodified slash focuses the filter from BODY, navigation, and timeline controls and selects its preserved query", async () => {
  const ShortcutTimeline = ({ conversation: selected }) => createElement(
    "article",
    { "data-timeline-for": selected.id },
    createElement("button", { type: "button" }, "Timeline shortcut source"),
  );
  const container = await renderWorkspace(workspace(createClient(createCache()), {
    conversationId: undefined,
    renderTimeline: ShortcutTimeline,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  await enterText(filter, "Entity");

  const pressSlash = async (source, modifiers = {}) => {
    source.focus();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
      ...modifiers,
    });
    await act(async () => {
      source.dispatchEvent(event);
      await flush();
    });
    return event;
  };

  const navigationSource = container.querySelector(
    ".handrail-chat__conversation-button",
  );

  filter.blur();
  assert.equal(document.activeElement, document.body);
  for (const modifiers of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ]) {
    const modifiedBodyEvent = await pressSlash(document.body, modifiers);
    assert.equal(modifiedBodyEvent.defaultPrevented, false);
    assert.equal(document.activeElement, document.body);
    assert.equal(filter.value, "Entity");
  }

  const composingBodyEvent = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    isComposing: true,
    key: "/",
  });
  await act(async () => {
    document.body.dispatchEvent(composingBodyEvent);
    await flush();
  });
  assert.equal(composingBodyEvent.defaultPrevented, false);
  assert.equal(document.activeElement, document.body);

  const bodyEvent = await pressSlash(document.body);
  assert.equal(bodyEvent.defaultPrevented, true);
  assert.equal(document.activeElement, filter);
  assert.equal(filter.value, "Entity");
  assert.equal(filter.selectionStart, 0);
  assert.equal(filter.selectionEnd, filter.value.length);

  const navigationEvent = await pressSlash(navigationSource);
  assert.equal(navigationEvent.defaultPrevented, true);
  assert.equal(document.activeElement, filter);
  assert.equal(filter.value, "Entity");
  assert.equal(filter.selectionStart, 0);
  assert.equal(filter.selectionEnd, filter.value.length);

  filter.setSelectionRange(2, 2);
  const timelineSource = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Timeline shortcut source");
  const timelineEvent = await pressSlash(timelineSource);
  assert.equal(timelineEvent.defaultPrevented, true);
  assert.equal(document.activeElement, filter);
  assert.equal(filter.value, "Entity");
  assert.equal(filter.selectionStart, 0);
  assert.equal(filter.selectionEnd, filter.value.length);

  for (const modifiers of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ]) {
    const modifiedEvent = await pressSlash(timelineSource, modifiers);
    assert.equal(modifiedEvent.defaultPrevented, false);
    assert.equal(document.activeElement, timelineSource);
    assert.equal(filter.value, "Entity");
  }

  const outside = document.createElement("button");
  outside.textContent = "Outside workspace";
  document.body.append(outside);
  try {
    const outsideEvent = await pressSlash(outside);
    assert.equal(outsideEvent.defaultPrevented, false);
    assert.equal(document.activeElement, outside);
    assert.equal(filter.value, "Entity");
  } finally {
    outside.remove();
  }
});

test("conversation-filter slash ignores editable, composer, search, creation, menu, dialog, and WorkspaceHeader boundaries", async () => {
  const cache = createCache();
  const messageSearchListeners = new Set();
  let messageSearchState = Object.freeze({ state: "idle" });
  const client = {
    ...createClient(cache),
    getMessageSearchState: () => messageSearchState,
    subscribeMessageSearch(listener) {
      messageSearchListeners.add(listener);
      return () => messageSearchListeners.delete(listener);
    },
    cancelMessageSearch() {
      const previous = messageSearchState;
      messageSearchState = Object.freeze({ state: "idle" });
      for (const listener of messageSearchListeners) {
        listener(messageSearchState, previous);
      }
    },
    searchMessages(input) {
      const previous = messageSearchState;
      messageSearchState = Object.freeze({
        state: "success",
        query: input.query,
        hits: [],
      });
      for (const listener of messageSearchListeners) {
        listener(messageSearchState, previous);
      }
      return Promise.resolve({ status: "success", value: { hits: [] } });
    },
  };
  const WorkspaceHeader = ({ controls, hostProps }) => createElement(
    "div",
    { ...hostProps, className: "custom-shortcut-workspace-header" },
    createElement("button", { type: "button" }, "Host header control"),
    controls.createConversation,
  );
  const BoundaryTimeline = ({ conversation: selected }) => createElement(
    "article",
    { "data-timeline-for": selected.id },
    createElement("input", { "aria-label": "Timeline editable control" }),
    createElement(
      "div",
      { contentEditable: true, suppressContentEditableWarning: true, tabIndex: 0 },
      "Editable timeline surface",
    ),
  );
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    components: { WorkspaceHeader },
    renderComposer: () => createElement(
      "button",
      { type: "button" },
      "Composer control",
    ),
    renderTimeline: BoundaryTimeline,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  await enterText(filter, "Organization");

  const expectRejected = async (source) => {
    source.focus();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
    });
    await act(async () => {
      source.dispatchEvent(event);
      await flush();
    });
    assert.equal(event.defaultPrevented, false);
    assert.equal(document.activeElement, source);
    assert.equal(filter.value, "Organization");
  };

  const hostHeader = container.querySelector(".custom-shortcut-workspace-header");
  assert.equal(
    hostHeader.dataset.handrailConversationFilterShortcutBoundary,
    "workspace-header",
  );
  await expectRejected([...hostHeader.querySelectorAll("button")]
    .find((button) => button.textContent === "Host header control"));
  await expectRejected([...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Composer control"));
  await expectRejected(container.querySelector('input[aria-label="Timeline editable control"]'));
  await expectRejected(container.querySelector('[contenteditable="true"]'));

  await click(container.querySelector(".handrail-chat__message-search-trigger"));
  const messageSearchInput = container.querySelector(
    '.handrail-chat__message-search input[name="messageSearchQuery"]',
  );
  await expectRejected(messageSearchInput);
  await click(container.querySelector(".handrail-chat__message-search-close"));

  await click(container.querySelector('button[aria-label="Add conversation"]'));
  const menuItem = container.querySelector('[role="menuitem"]');
  await expectRejected(menuItem);
  await click(menuItem);
  const dialog = container.querySelector('[role="dialog"]');
  const dialogCancel = [...dialog.querySelectorAll("button")]
    .find((button) => button.textContent === "Cancel");
  await expectRejected(dialogCancel);

  dialogCancel.blur();
  assert.equal(document.activeElement, document.body);
  const bodyEvent = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "/",
  });
  document.body.dispatchEvent(bodyEvent);
  assert.equal(bodyEvent.defaultPrevented, false);
  assert.equal(document.activeElement, document.body);
});

test("filtered keyboard navigation uses contiguous visual order across sections", async () => {
  const publicChannel = conversation("conversation-filter-keyboard-public", "River");
  const hiddenPublicChannel = conversation(
    "conversation-filter-keyboard-hidden",
    "Sky",
  );
  const privateChannel = {
    ...conversation("conversation-filter-keyboard-private", "Room"),
    visibility: "private",
  };
  const direct = directConversation("conversation-filter-keyboard-direct");
  const group = groupDirectConversation("conversation-filter-keyboard-group");
  const thread = threadConversation(
    "conversation-filter-keyboard-thread",
    publicChannel.id,
  );
  const conversations = [
    privateChannel,
    hiddenPublicChannel,
    direct,
    thread,
    publicChannel,
    group,
  ];
  const expectedOrder = [
    publicChannel.id,
    privateChannel.id,
    direct.id,
    group.id,
    thread.id,
  ];
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: conversations,
    details: conversations,
  })), {
    conversationId: undefined,
    defaultConversationId: publicChannel.id,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  await enterText(filter, "r");

  const buttons = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-button",
  )];
  const press = async (conversationId, key) => {
    const source = buttons().find((button) =>
      button.dataset.conversationId === conversationId);
    assert.ok(source, `missing filtered keyboard source ${conversationId}`);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    });
    await act(async () => {
      source.dispatchEvent(event);
      await flush();
    });
    assert.equal(event.defaultPrevented, true);
  };
  const assertCurrent = (conversationId) => {
    const current = buttons().filter((button) =>
      button.getAttribute("aria-current") === "page");
    assert.equal(current.length, 1);
    assert.equal(current[0].dataset.conversationId, conversationId);
    assert.equal(current[0].tabIndex, 0);
    assert.equal(document.activeElement, current[0]);
  };

  assert.deepEqual(
    buttons().map((button) => button.dataset.conversationId),
    expectedOrder,
  );
  buttons()[0].focus();
  assertCurrent(publicChannel.id);
  await press(publicChannel.id, "ArrowRight");
  assertCurrent(privateChannel.id);
  await press(privateChannel.id, "ArrowDown");
  assertCurrent(direct.id);
  await press(direct.id, "ArrowDown");
  assertCurrent(group.id);
  await press(group.id, "End");
  assertCurrent(thread.id);
  await press(thread.id, "Home");
  assertCurrent(publicChannel.id);
  await press(publicChannel.id, "ArrowLeft");
  assertCurrent(thread.id);
});

test("conversation filter Escape is focus-scoped and preserves hidden selection", async () => {
  const container = await renderWorkspace(workspace(createClient(createCache()), {
    conversationId: undefined,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  await enterText(filter, "Entity");

  let buttons = [...container.querySelectorAll(
    ".handrail-chat__conversation-button",
  )];
  assert.deepEqual(buttons.map((button) => button.dataset.conversationId), [secondId]);
  assert.equal(buttons[0].hasAttribute("aria-current"), false);
  assert.equal(buttons[0].tabIndex, 0);
  assert.equal(container.querySelector("article").dataset.timelineFor, firstId);

  filter.focus();
  const clearEvent = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => {
    filter.dispatchEvent(clearEvent);
    await flush();
  });
  assert.equal(clearEvent.defaultPrevented, true);
  assert.equal(filter.value, "");
  assert.equal(document.activeElement, filter);

  buttons = [...container.querySelectorAll(".handrail-chat__conversation-button")];
  assert.equal(buttons[0].dataset.conversationId, firstId);
  assert.equal(buttons[0].getAttribute("aria-current"), "page");
  assert.equal(buttons[0].tabIndex, 0);
  assert.equal(container.querySelector("article").dataset.timelineFor, firstId);

  await enterText(filter, "Organization");
  buttons = [...container.querySelectorAll(".handrail-chat__conversation-button")];
  buttons[0].focus();
  const unrelatedEscape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => {
    buttons[0].dispatchEvent(unrelatedEscape);
    await flush();
  });
  assert.equal(unrelatedEscape.defaultPrevented, false);
  assert.equal(filter.value, "Organization");
});

test("conversation filter shows a scoped no-match status and retains pagination", async () => {
  const cache = createCache({ organizationNextCursor: conversationCursor });
  const requests = [];
  const client = {
    ...createClient(cache),
    async listConversations(input) {
      if (input.cursor !== undefined) requests.push(input);
      return { status: "success" };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: undefined,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  await enterText(filter, "not in the loaded snapshot");

  const noMatch = container.querySelector(
    '.handrail-chat__conversation-filter-empty[role="status"]',
  );
  assert.equal(noMatch.textContent, "No conversations match your search.");
  assert.equal(noMatch.getAttribute("aria-live"), "polite");
  assert.equal(container.querySelector(".handrail-chat__conversation-sections"), null);
  assert.equal(container.querySelector(".handrail-chat__conversation-section-empty"), null);
  assert.equal(container.querySelector('[data-state-kind="no-conversation"]'), null);
  assert.equal(container.querySelector("article").dataset.timelineFor, firstId);

  const loadMore = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Load more conversations");
  assert.ok(loadMore);
  await click(loadMore);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].cursor, conversationCursor);
  assert.equal(filter.value, "not in the loaded snapshot");
  assert.ok(container.querySelector(".handrail-chat__conversation-filter-empty"));
});

test("visual-order keyboard navigation crosses section boundaries and keeps one current row", async () => {
  const publicFirst = conversation("conversation-keyboard-public-first", "Public first");
  const publicSecond = conversation("conversation-keyboard-public-second", "Public second");
  const privateChannel = {
    ...conversation("conversation-keyboard-private", "Private"),
    visibility: "private",
  };
  const direct = directConversation("conversation-keyboard-direct");
  const group = groupDirectConversation("conversation-keyboard-group");
  const thread = threadConversation("conversation-keyboard-thread", publicFirst.id);
  const serverOrder = [privateChannel, direct, publicFirst, thread, group, publicSecond];
  const visualOrder = [publicFirst.id, publicSecond.id, privateChannel.id, direct.id, group.id, thread.id];
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: serverOrder,
    details: serverOrder,
  })), { conversationId: undefined }));

  const buttons = () => [...container.querySelectorAll(".handrail-chat__conversation-button")];
  const assertCurrent = (conversationId) => {
    const rows = buttons();
    const currentRows = rows.filter((button) => button.getAttribute("aria-current") === "page");
    assert.equal(currentRows.length, 1);
    assert.equal(currentRows[0].dataset.conversationId, conversationId);
    assert.equal(currentRows[0].tabIndex, 0);
    assert.equal(document.activeElement, currentRows[0]);
    for (const row of rows.filter((button) => button !== currentRows[0])) {
      assert.equal(row.hasAttribute("aria-current"), false);
      assert.equal(row.tabIndex, -1);
    }
  };
  const press = async (conversationId, key) => {
    const source = buttons().find((button) => button.dataset.conversationId === conversationId);
    assert.ok(source, `missing keyboard source ${conversationId}`);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
    await act(async () => {
      source.dispatchEvent(event);
      await flush();
    });
    assert.equal(event.defaultPrevented, true);
  };

  assert.deepEqual(buttons().map((button) => button.dataset.conversationId), visualOrder);
  buttons()[0].focus();
  assertCurrent(publicFirst.id);
  await press(publicFirst.id, "ArrowDown");
  assertCurrent(publicSecond.id);
  await press(publicSecond.id, "ArrowRight");
  assertCurrent(privateChannel.id);
  await press(privateChannel.id, "ArrowLeft");
  assertCurrent(publicSecond.id);
  await press(publicSecond.id, "ArrowUp");
  assertCurrent(publicFirst.id);
  await press(publicFirst.id, "ArrowUp");
  assertCurrent(thread.id);
  await press(thread.id, "ArrowDown");
  assertCurrent(publicFirst.id);
  await press(publicFirst.id, "End");
  assertCurrent(thread.id);
  await press(thread.id, "Home");
  assertCurrent(publicFirst.id);
});

test("controlled selection reports requests without overriding the controlled value", async () => {
  const selected = [];
  const container = await renderWorkspace(workspace(createClient(createCache()), {
    onConversationChange: (conversationId) => selected.push(conversationId),
  }));
  const buttons = container.querySelectorAll(".handrail-chat__conversation-button");

  await act(async () => buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));

  assert.deepEqual(selected, [secondId]);
  assert.equal(buttons[0].getAttribute("aria-current"), "page");
  assert.equal(buttons[1].hasAttribute("aria-current"), false);
  assert.equal(container.querySelector("article").dataset.timelineFor, firstId);
});

test("uncontrolled selection supports click and ArrowUp, ArrowDown, Home, and End activation", async () => {
  const selected = [];
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: [firstConversation, secondConversation, thirdConversation],
    details: [firstConversation, secondConversation, thirdConversation],
  })), {
    conversationId: undefined,
    onConversationChange: (conversationId) => selected.push(conversationId),
  }));
  let buttons = container.querySelectorAll(".handrail-chat__conversation-button");
  assert.equal(buttons[0].getAttribute("aria-current"), "page");

  const keyEvent = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "ArrowDown",
  });
  await act(async () => buttons[0].dispatchEvent(keyEvent));
  buttons = container.querySelectorAll(".handrail-chat__conversation-button");
  assert.equal(keyEvent.defaultPrevented, true);
  assert.equal(buttons[1].getAttribute("aria-current"), "page");
  assert.equal(document.activeElement, buttons[1]);
  assert.equal(container.querySelector("article").dataset.timelineFor, secondId);

  for (const [fromIndex, key, expectedIndex] of [
    [1, "ArrowUp", 0],
    [0, "End", 2],
    [2, "Home", 0],
  ]) {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    });
    await act(async () => buttons[fromIndex].dispatchEvent(event));
    buttons = container.querySelectorAll(".handrail-chat__conversation-button");
    assert.equal(event.defaultPrevented, true);
    assert.equal(buttons[expectedIndex].getAttribute("aria-current"), "page");
    assert.equal(document.activeElement, buttons[expectedIndex]);
  }

  await act(async () => buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
  assert.equal(container.querySelector("article").dataset.timelineFor, secondId);
  assert.deepEqual(selected, [secondId, firstId, thirdId, firstId, secondId]);
});

test("compact navigation moves list to detail and back with focus and roving state restored", async () => {
  const client = createClient(createCache());
  const ControlledWorkspace = () => {
    const [conversationId, setConversationId] = React.useState(null);
    return workspace(client, {
      conversationId,
      onConversationChange: setConversationId,
    });
  };
  const container = await renderWorkspace(createElement(ControlledWorkspace));
  await setWorkspaceWidth(container, 480);

  const root = container.querySelector(".handrail-chat--workspace");
  const navigation = container.querySelector(".handrail-chat__navigation");
  const detail = container.querySelector(".handrail-chat__detail");
  let buttons = container.querySelectorAll(".handrail-chat__conversation-button");
  assert.equal(root.dataset.handrailCompactLayout, "true");
  assert.equal(root.dataset.handrailCompactPane, "list");
  assert.equal(navigation.hidden, false);
  assert.equal(detail.hidden, true);

  await click(buttons[1]);
  const back = container.querySelector('button[aria-label="Back to conversations"]');
  assert.ok(back, "compact detail exposes an accessible back control");
  const backIcon = back.querySelector('svg[data-pane-control-icon="back"]');
  assert.equal(backIcon?.tagName, "svg");
  assert.equal(backIcon?.getAttribute("aria-hidden"), "true");
  assert.equal(backIcon?.getAttribute("focusable"), "false");
  assert.equal(backIcon?.getAttribute("stroke"), "currentColor");
  assert.equal(back.textContent, "Back to conversations");
  assert.doesNotMatch(back.textContent, /[←×]/u);
  assert.equal(root.dataset.handrailCompactPane, "detail");
  assert.equal(navigation.hidden, true);
  assert.equal(detail.hidden, false);
  assert.equal(container.querySelector("article").dataset.timelineFor, secondId);

  await click(back);
  buttons = container.querySelectorAll(".handrail-chat__conversation-button");
  assert.equal(root.dataset.handrailCompactPane, "list");
  assert.equal(navigation.hidden, false);
  assert.equal(detail.hidden, true);
  assert.equal(buttons[1].getAttribute("aria-current"), "page");
  assert.equal(buttons[1].tabIndex, 0);
  assert.equal(document.activeElement, buttons[1]);

  const arrowDown = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "ArrowDown",
  });
  await act(async () => {
    buttons[1].dispatchEvent(arrowDown);
    await flush();
  });
  buttons = container.querySelectorAll(".handrail-chat__conversation-button");
  assert.equal(arrowDown.defaultPrevented, true);
  assert.equal(root.dataset.handrailCompactPane, "list");
  assert.equal(buttons[0].getAttribute("aria-current"), "page");
  assert.equal(buttons[0].tabIndex, 0);
  assert.equal(buttons[1].tabIndex, -1);
  assert.equal(document.activeElement, buttons[0]);

  await click(buttons[0]);
  assert.equal(root.dataset.handrailCompactPane, "detail");
  assert.equal(container.querySelector("article").dataset.timelineFor, firstId);
});

test("conversation-filter slash reveals compact navigation before focusing and selecting the preserved query", async () => {
  const CompactTimeline = ({ conversation: selected }) => createElement(
    "article",
    { "data-timeline-for": selected.id },
    createElement("button", { type: "button" }, "Compact timeline control"),
  );
  const container = await renderWorkspace(workspace(createClient(createCache()), {
    renderTimeline: CompactTimeline,
  }));
  const filter = container.querySelector('input[name="conversationFilter"]');
  await enterText(filter, "Organization");
  await setWorkspaceWidth(container, 480);

  const root = container.querySelector(".handrail-chat--workspace");
  const navigation = container.querySelector(".handrail-chat__navigation");
  const detail = container.querySelector(".handrail-chat__detail");
  assert.equal(root.dataset.handrailCompactPane, "detail");
  assert.equal(navigation.hidden, true);
  assert.equal(detail.hidden, false);

  const source = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Compact timeline control");
  source.focus();
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "/",
  });
  await act(async () => {
    source.dispatchEvent(event);
    await flush();
  });

  assert.equal(event.defaultPrevented, true);
  assert.equal(root.dataset.handrailCompactPane, "list");
  assert.equal(navigation.hidden, false);
  assert.equal(detail.hidden, true);
  assert.equal(document.activeElement, filter);
  assert.equal(filter.value, "Organization");
  assert.equal(filter.selectionStart, 0);
  assert.equal(filter.selectionEnd, filter.value.length);
});

test("wide layout keeps both panes and breakpoint changes do not refetch chat data", async () => {
  const baseClient = createClient(createCache());
  const calls = { conversations: 0, detail: 0, directory: 0 };
  const client = {
    ...baseClient,
    async getConversation(...args) {
      calls.detail += 1;
      return baseClient.getConversation(...args);
    },
    async hydrateDirectoryUsers(...args) {
      calls.directory += 1;
      return baseClient.hydrateDirectoryUsers(...args);
    },
    async listConversations(...args) {
      calls.conversations += 1;
      return baseClient.listConversations(...args);
    },
  };
  const container = await renderWorkspace(workspace(client));
  const root = container.querySelector(".handrail-chat--workspace");
  const navigation = container.querySelector(".handrail-chat__navigation");
  const detail = container.querySelector(".handrail-chat__detail");
  const initialCalls = { ...calls };

  await setWorkspaceWidth(container, 960);
  assert.equal(root.dataset.handrailCompactLayout, "false");
  assert.equal(navigation.hidden, false);
  assert.equal(detail.hidden, false);
  assert.equal(container.querySelector('[aria-label="Back to conversations"]'), null);

  await setWorkspaceWidth(container, 640);
  assert.equal(root.dataset.handrailCompactLayout, "true");
  assert.equal(navigation.hidden, true);
  assert.equal(detail.hidden, false);
  assert.ok(container.querySelector('[aria-label="Back to conversations"]'));

  await setWorkspaceWidth(container, 641);
  assert.equal(root.dataset.handrailCompactLayout, "false");
  assert.equal(navigation.hidden, false);
  assert.equal(detail.hidden, false);
  assert.equal(container.querySelector('[aria-label="Back to conversations"]'), null);
  assert.deepEqual(calls, initialCalls);
});

test("compact layout observation disconnects when the workspace unmounts", async () => {
  const container = await renderWorkspace(workspace(createClient(createCache())));
  const observer = await setWorkspaceWidth(container, 480);
  const entry = mounted.pop();
  await act(async () => entry.root.unmount());
  entry.container.remove();

  assert.equal(observer.disconnected, true);
  assert.equal(activeResizeObservers.has(observer), false);
});

test("conversation-filter shortcut shares one document listener, scopes BODY to the active workspace, and cleans up", async () => {
  const documentAddEventListener = document.addEventListener;
  const documentRemoveEventListener = document.removeEventListener;
  const windowAddEventListener = window.addEventListener;
  let documentKeydownAdds = 0;
  let documentKeydownRemoves = 0;
  let windowKeydownAdds = 0;
  document.addEventListener = function (type, ...args) {
    if (type === "keydown") documentKeydownAdds += 1;
    return documentAddEventListener.call(this, type, ...args);
  };
  document.removeEventListener = function (type, ...args) {
    if (type === "keydown") documentKeydownRemoves += 1;
    return documentRemoveEventListener.call(this, type, ...args);
  };
  window.addEventListener = function (type, ...args) {
    if (type === "keydown") windowKeydownAdds += 1;
    return windowAddEventListener.call(this, type, ...args);
  };

  try {
    const firstContainer = await renderWorkspace(workspace(createClient(createCache())));
    const secondContainer = await renderWorkspace(workspace(createClient(createCache())));
    assert.equal(documentKeydownAdds, 1);
    assert.equal(documentKeydownRemoves, 0);
    assert.equal(windowKeydownAdds, 0);

    const firstFilter = firstContainer.querySelector('input[name="conversationFilter"]');
    const secondFilter = secondContainer.querySelector('input[name="conversationFilter"]');
    const ambiguousEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
    });
    document.body.dispatchEvent(ambiguousEvent);
    assert.equal(ambiguousEvent.defaultPrevented, false);
    assert.equal(document.activeElement, document.body);

    secondFilter.focus();
    secondFilter.blur();
    assert.equal(document.activeElement, document.body);
    const activeWorkspaceEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
    });
    document.body.dispatchEvent(activeWorkspaceEvent);
    assert.equal(activeWorkspaceEvent.defaultPrevented, true);
    assert.equal(document.activeElement, secondFilter);

    let entry = mounted.pop();
    await act(async () => entry.root.unmount());
    entry.container.remove();
    assert.equal(documentKeydownRemoves, 0);

    secondFilter.blur();
    assert.equal(document.activeElement, document.body);
    const soleWorkspaceEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
    });
    document.body.dispatchEvent(soleWorkspaceEvent);
    assert.equal(soleWorkspaceEvent.defaultPrevented, true);
    assert.equal(document.activeElement, firstFilter);

    entry = mounted.pop();
    await act(async () => entry.root.unmount());
    entry.container.remove();
    assert.equal(documentKeydownRemoves, 1);

    const outside = document.createElement("button");
    document.body.append(outside);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "/",
    });
    outside.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(documentKeydownAdds, 1);
    assert.equal(documentKeydownRemoves, 1);
    assert.equal(windowKeydownAdds, 0);
    outside.remove();
  } finally {
    document.addEventListener = documentAddEventListener;
    document.removeEventListener = documentRemoveEventListener;
    window.addEventListener = windowAddEventListener;
  }
});

test("authorized channel creation normalizes public and private names and selects authoritative results", async () => {
  const cache = createCache();
  const calls = [];
  const selected = [];
  const ids = ["conversation-created-public", "conversation-created-private"];
  const client = {
    ...createClient(cache),
    async createChannel(input) {
      calls.push(input);
      const item = Object.freeze({
        ...conversation(ids[calls.length - 1], input.name),
        visibility: input.visibility,
      });
      const snapshot = detailSnapshot(item);
      cache.hydrateConversationDetail(snapshot);
      return {
        status: "success",
        value: {
          operation: "create_conversation",
          type: "channel",
          reconciliationStatus: "created",
          clientRequestId: `request-${calls.length}`,
          conversation: snapshot,
        },
      };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    conversationId: undefined,
    onConversationChange: (conversationId) => selected.push(conversationId),
  }));

  for (const [rawName, visibility, expectedName, expectedId] of [
    ["  Product e\u0301  ", "public", "Product é", ids[0]],
    ["  Leadership  ", "private", "Leadership", ids[1]],
  ]) {
    const { dialog, trigger } = await openCreationDialog(container, "Create channel");
    const nameInput = dialog.querySelector('input[name="channelName"]');
    assert.equal(nameInput.value, "");
    assert.equal(dialog.querySelector('input[value="public"]').checked, false);
    assert.equal(dialog.querySelector('input[value="private"]').checked, false);
    await enterText(nameInput, rawName);
    assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
    await click(dialog.querySelector(`input[value="${visibility}"]`));
    await act(async () => {
      dialog.querySelector("form").dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
      await flush();
    });

    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelector("article").dataset.timelineFor, expectedId);
    assert.equal(calls.at(-1).name, expectedName);
    assert.equal(document.activeElement, trigger);
  }

  assert.deepEqual(calls, [
    { name: "Product é", visibility: "public" },
    { name: "Leadership", visibility: "private" },
  ]);
  assert.deepEqual(selected.slice(-2), ids);
});

test("channel dialog dismissal restores focus to each originating trigger after closure", async () => {
  const container = await renderWorkspace(workspace(createClient(createCache({
    organization: [],
    details: [],
  })), {
    channelCreationAvailability: { canCreate: true },
    conversationId: null,
  }));
  const globalTrigger = container.querySelector('button[aria-label="Add conversation"]');
  assert.ok(globalTrigger);

  const openGlobalDialog = async () => {
    await click(globalTrigger);
    const channelItem = [...container.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent === "Create channel");
    assert.ok(channelItem);
    await click(channelItem);
    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    return dialog;
  };
  const openSectionDialog = async (label) => {
    const trigger = container.querySelector(`button[aria-label="${label}"]`);
    assert.ok(trigger);
    await click(trigger);
    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    return { dialog, trigger };
  };
  const expectPostCloseFocus = async (trigger, dismiss) => {
    let dialogWasPresentWhenFocusReturned;
    trigger.addEventListener("focus", () => {
      dialogWasPresentWhenFocusReturned =
        container.querySelector('[role="dialog"]') !== null;
    }, { once: true });
    await dismiss();
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(dialogWasPresentWhenFocusReturned, false);
    assert.equal(document.activeElement, trigger);
    assert.notEqual(document.activeElement, document.body);
  };
  const pressEscape = async (dialog) => {
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }));
      await flush();
    });
  };

  let dialog = await openGlobalDialog();
  await expectPostCloseFocus(globalTrigger, () => pressEscape(dialog));

  dialog = await openGlobalDialog();
  await expectPostCloseFocus(globalTrigger, () => click(
    [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel"),
  ));

  dialog = await openGlobalDialog();
  const backdrop = container.querySelector(".handrail-chat__channel-creation");
  assert.ok(backdrop);
  await expectPostCloseFocus(globalTrigger, () => click(backdrop));

  let sectionLaunch = await openSectionDialog("Create public channel");
  await expectPostCloseFocus(
    sectionLaunch.trigger,
    () => pressEscape(sectionLaunch.dialog),
  );

  sectionLaunch = await openSectionDialog("Create private channel");
  await expectPostCloseFocus(sectionLaunch.trigger, () => click(
    [...sectionLaunch.dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel"),
  ));
});

test("created conversation is immediately listed and selection survives prepended and reordered snapshots", async () => {
  const createdId = "conversation-created-before-list-hydration";
  const createdConversation = conversation(createdId, "Created before hydration");
  const cache = createCache({
    organization: [firstConversation, secondConversation],
    details: [firstConversation, secondConversation, thirdConversation],
  });
  const client = {
    ...createClient(cache),
    async createChannel() {
      const snapshot = detailSnapshot(createdConversation);
      cache.hydrateConversationDetail(snapshot);
      return {
        status: "success",
        value: {
          operation: "create_conversation",
          type: "channel",
          reconciliationStatus: "created",
          clientRequestId: "created-before-list-hydration",
          conversation: snapshot,
        },
      };
    },
  };
  const ChannelHeader = ({ conversation: selected, hostProps }) => createElement(
    "div",
    { ...hostProps, "data-header-for": selected.id },
    selected.id,
  );
  const Composer = ({ conversation: selected }) => createElement(
    "form",
    { "data-composer-for": selected.id },
  );
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    components: { ChannelHeader },
    conversationId: undefined,
    renderComposer: Composer,
  }));

  const { dialog } = await openCreationDialog(container, "Create channel");
  await enterText(dialog.querySelector('input[name="channelName"]'), "Created before hydration");
  await click(dialog.querySelector('input[value="public"]'));
  await act(async () => {
    dialog.querySelector("form").dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });

  const assertCreatedTarget = (expectedActiveRows) => {
    assert.equal(container.querySelector('[data-header-for]')?.dataset.headerFor, createdId);
    assert.equal(container.querySelector("article")?.dataset.timelineFor, createdId);
    assert.equal(container.querySelector('[data-composer-for]')?.dataset.composerFor, createdId);
    const activeRows = container.querySelectorAll(
      '.handrail-chat__conversation-button[aria-current="page"]',
    );
    assert.equal(activeRows.length, expectedActiveRows);
    if (expectedActiveRows === 1) {
      assert.equal(activeRows[0].dataset.conversationId, createdId);
      assert.match(activeRows[0].textContent, /Created before hydration/);
    }
  };

  assert.equal(container.querySelector('[role="dialog"]'), null);
  assertCreatedTarget(1);

  await act(async () => {
    cache.hydrateConversationList(listSnapshot(
      organizationScope,
      [thirdConversation, firstConversation, secondConversation],
    ));
    await flush();
  });
  assertCreatedTarget(1);

  await act(async () => {
    cache.hydrateConversationList(listSnapshot(
      organizationScope,
      [thirdConversation, createdConversation, firstConversation, secondConversation],
    ));
    await flush();
  });
  assertCreatedTarget(1);

  await act(async () => {
    cache.hydrateConversationList(listSnapshot(
      organizationScope,
      [secondConversation, firstConversation, createdConversation, thirdConversation],
    ));
    await flush();
  });
  assertCreatedTarget(1);
});

test("a definitively unavailable created conversation falls back to the first current row", async () => {
  const createdId = "conversation-created-unavailable";
  const createdConversation = conversation(createdId, "Unavailable creation");
  const cache = createCache({
    details: [firstConversation, secondConversation, thirdConversation],
  });
  const client = {
    ...createClient(cache),
    createChannel: async () => ({
      status: "success",
      value: {
        operation: "create_conversation",
        type: "channel",
        reconciliationStatus: "created",
        clientRequestId: "created-unavailable",
        conversation: detailSnapshot(createdConversation),
      },
    }),
    getConversation: async () => new Promise(() => undefined),
  };
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    conversationId: undefined,
  }));

  const { dialog } = await openCreationDialog(container, "Create channel");
  await enterText(dialog.querySelector('input[name="channelName"]'), "Unavailable creation");
  await click(dialog.querySelector('input[value="public"]'));
  await act(async () => {
    dialog.querySelector("form").dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await flush();
    cache.hydrateConversationList(listSnapshot(
      organizationScope,
      [thirdConversation, firstConversation, secondConversation],
    ));
    await flush();
  });
  assert.match(container.querySelector('[data-state-kind="conversation-loading"]')?.textContent, /Loading conversation/);

  const unavailableState = structuredClone(cache.getState());
  unavailableState.metadata.conversationDetails[createdId] = metadata;
  await act(async () => {
    assert.equal(cache.hydrateCanonicalState(unavailableState), true);
    await flush();
  });

  const activeRows = container.querySelectorAll(
    '.handrail-chat__conversation-button[aria-current="page"]',
  );
  assert.equal(activeRows.length, 1);
  assert.match(activeRows[0].textContent, /Older organization chat/);
  assert.equal(container.querySelector("article")?.dataset.timelineFor, thirdId);
});

test("controlled creation reports the authoritative ID without changing controlled selection", async () => {
  const createdId = "conversation-created-controlled";
  const createdConversation = conversation(createdId, "Controlled creation");
  const cache = createCache();
  const selected = [];
  const client = {
    ...createClient(cache),
    async createChannel() {
      const snapshot = detailSnapshot(createdConversation);
      cache.hydrateConversationDetail(snapshot);
      return {
        status: "success",
        value: {
          operation: "create_conversation",
          type: "channel",
          reconciliationStatus: "created",
          clientRequestId: "created-controlled",
          conversation: snapshot,
        },
      };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    onConversationChange: (conversationId) => selected.push(conversationId),
  }));

  const { dialog } = await openCreationDialog(container, "Create channel");
  await enterText(dialog.querySelector('input[name="channelName"]'), "Controlled creation");
  await click(dialog.querySelector('input[value="public"]'));
  await act(async () => {
    dialog.querySelector("form").dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));
    await flush();
    cache.hydrateConversationList(listSnapshot(
      organizationScope,
      [createdConversation, secondConversation, firstConversation],
    ));
    await flush();
  });

  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.deepEqual(selected, [createdId]);
  assert.equal(container.querySelector("article")?.dataset.timelineFor, firstId);
  const activeRows = container.querySelectorAll(
    '.handrail-chat__conversation-button[aria-current="page"]',
  );
  assert.equal(activeRows.length, 1);
  assert.match(activeRows[0].textContent, /Organization chat/);
});

test("channel creation blocks duplicate pending submissions and keeps actionable failures open", async () => {
  let resolveCreation;
  const calls = [];
  const client = {
    ...createClient(createCache()),
    createChannel(input) {
      calls.push(input);
      return new Promise((resolve) => {
        resolveCreation = resolve;
      });
    },
  };
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    conversationId: secondId,
    scope: entityScope,
  }));

  const { dialog } = await openCreationDialog(container, "Create channel");
  await enterText(dialog.querySelector('input[name="channelName"]'), "  Operations  ");
  await click(dialog.querySelector('input[value="public"]'));
  assert.equal(dialog.querySelector('input[name="channelName"]').value, "  Operations  ");
  assert.equal(dialog.querySelector('input[value="public"]').checked, true);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, false);
  await act(async () => {
    const form = dialog.querySelector("form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });

  assert.deepEqual(calls, [{
    name: "Operations",
    visibility: "public",
    entity: entityScope.entity,
  }]);
  assert.equal(dialog.querySelector('[role="status"]').textContent, "Creating channel…");
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);

  await act(async () => {
    resolveCreation({
      status: "rejected",
      message: "The chat server rejected the command.",
      httpStatus: 403,
    });
    await flush();
  });

  assert.ok(container.querySelector('[role="dialog"]'));
  assert.match(container.querySelector('[role="alert"]').textContent, /try again/i);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, false);
  assert.equal(dialog.querySelector('input[name="channelName"]').value, "  Operations  ");
  assert.equal(dialog.querySelector('input[value="public"]').checked, true);
});

test("channel creation is fail-closed for absent, denied, and read-only availability", () => {
  const client = createClient(createCache());
  const cases = [
    {},
    { channelCreationAvailability: { canCreate: false } },
    { channelCreationAvailability: { canCreate: true }, readOnly: true },
  ];

  for (const props of cases) {
    const markup = renderToStaticMarkup(workspace(client, props));
    assert.doesNotMatch(markup, /aria-label="Add conversation"/);
  }
});

test("creation add menu exposes exactly every host-authorized availability combination", async () => {
  const labels = [
    "Create channel",
    "Create direct conversation",
    "Create group conversation",
  ];
  for (let mask = 0; mask < 8; mask += 1) {
    const allowed = labels.filter((_, index) => (mask & (1 << index)) !== 0);
    const container = await renderWorkspace(workspace(createClient(createCache()), {
      channelCreationAvailability: { canCreate: (mask & 1) !== 0 },
      directCreationAvailability: { canCreate: (mask & 2) !== 0 },
      groupDirectCreationAvailability: { canCreate: (mask & 4) !== 0 },
    }));
    const trigger = container.querySelector('button[aria-label="Add conversation"]');
    assert.equal(trigger !== null, allowed.length > 0, `availability mask ${mask}`);
    if (trigger === null) continue;
    await click(trigger);
    assert.deepEqual(
      [...container.querySelectorAll('[role="menuitem"]')]
        .map((item) => item.textContent),
      allowed,
      `availability mask ${mask}`,
    );
  }

  for (const props of [
    {},
    {
      channelCreationAvailability: { canCreate: true },
      directCreationAvailability: { canCreate: true },
      groupDirectCreationAvailability: { canCreate: true },
      readOnly: true,
    },
  ]) {
    const markup = renderToStaticMarkup(workspace(createClient(createCache()), props));
    assert.doesNotMatch(markup, /aria-label="Add conversation"/);
  }
});

test("creation add menu supports keyboard navigation, activation, dismissal, and focus restoration", async () => {
  const idleDirectoryState = Object.freeze({ state: "idle" });
  const client = {
    ...createClient(createCache()),
    getDirectorySearchState: () => idleDirectoryState,
  };
  const container = await renderWorkspace(workspace(client, {
    channelCreationAvailability: { canCreate: true },
    directCreationAvailability: { canCreate: true },
    groupDirectCreationAvailability: { canCreate: true },
  }));
  const trigger = container.querySelector('button[aria-label="Add conversation"]');
  const press = async (element, key) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
    await act(async () => {
      element.dispatchEvent(event);
      await flush();
    });
    return event;
  };

  trigger.focus();
  assert.equal((await press(trigger, "ArrowDown")).defaultPrevented, true);
  let items = [...container.querySelectorAll('[role="menuitem"]')];
  assert.equal(document.activeElement, items[0], "opening focuses the first authorized item");
  await press(items[0], "ArrowDown");
  assert.equal(document.activeElement, items[1]);
  await press(items[1], "Home");
  assert.equal(document.activeElement, items[0]);
  await press(items[0], "End");
  assert.equal(document.activeElement, items[2]);
  await press(items[2], "ArrowUp");
  assert.equal(document.activeElement, items[1]);
  await press(items[1], "Escape");
  assert.equal(container.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
  });
  assert.equal(container.querySelector('[role="menu"]'), null);
  assert.equal(document.activeElement, trigger, "outside dismissal restores add-trigger focus");

  await click(trigger);
  items = [...container.querySelectorAll('[role="menuitem"]')];
  await press(items[0], "ArrowDown");
  await press(items[1], "Enter");
  let dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Create direct conversation/);
  await press(dialog, "Escape");
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);

  await click(trigger);
  items = [...container.querySelectorAll('[role="menuitem"]')];
  await press(items[0], "End");
  await press(items[2], " ");
  dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Create group conversation/);
  await press(dialog, "Escape");
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
});

test("direct creation is a root workspace modal with stable navigation, contained focus, and exact focus restoration", async () => {
  const idleDirectoryState = Object.freeze({ state: "idle" });
  const client = {
    ...createClient(createCache()),
    getDirectorySearchState: () => idleDirectoryState,
  };
  const container = await renderWorkspace(workspace(client, {
    directCreationAvailability: { canCreate: true },
  }));
  const root = container.querySelector(".handrail-chat");
  const navigation = root.querySelector('nav[aria-label="Conversations"]');
  const globalTrigger = navigation.querySelector('button[aria-label="Add conversation"]');
  const sectionTrigger = navigation.querySelector(
    'button[aria-label="Create a direct conversation"]',
  );
  const rowsBefore = [...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )];
  const geometryBefore = rowsBefore.map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      id: row.dataset.conversationId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
  const press = async (element, key, init = {}) => {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        ...init,
      }));
      await flush();
    });
  };

  assert.equal(navigation.querySelector(".handrail-chat__direct-creation"), null);
  let { dialog } = await openCreationDialog(container, "Create direct conversation");
  let overlay = root.querySelector(".handrail-chat__direct-creation--modal");
  const workspaceContent = [...root.children]
    .filter((element) => element.classList.contains("handrail-chat__workspace-content"));
  const queryInput = dialog.querySelector('input[name="directoryQuery"]');
  const cancel = dialog.querySelector(".handrail-chat__direct-creation-cancel");

  assert.equal(overlay.parentElement, root);
  assert.equal(navigation.contains(overlay), false);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(
    document.getElementById(dialog.getAttribute("aria-labelledby")).textContent,
    "Create direct conversation",
  );
  assert.equal(document.activeElement, queryInput);
  assert.ok(workspaceContent.length >= 2);
  assert.ok(workspaceContent.every((region) => region.hasAttribute("inert")));
  assert.deepEqual(
    [...navigation.querySelectorAll(
      ".handrail-chat__conversation-button[data-conversation-id]",
    )],
    rowsBefore,
  );
  assert.deepEqual(rowsBefore.map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      id: row.dataset.conversationId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }), geometryBefore);

  await press(queryInput, "Tab", { shiftKey: true });
  assert.equal(document.activeElement, cancel);
  await press(cancel, "Tab");
  assert.equal(document.activeElement, queryInput);
  await click(dialog);
  assert.equal(root.querySelector(".handrail-chat__direct-creation--modal"), overlay);
  await click(cancel);
  assert.equal(root.querySelector(".handrail-chat__direct-creation--modal"), null);
  assert.ok(workspaceContent.every((region) => !region.hasAttribute("inert")));
  assert.equal(document.activeElement, globalTrigger);

  ({ dialog } = await openCreationDialog(container, "Create direct conversation"));
  await press(dialog, "Escape");
  assert.equal(root.querySelector(".handrail-chat__direct-creation--modal"), null);
  assert.equal(document.activeElement, globalTrigger);

  await click(sectionTrigger);
  overlay = root.querySelector(".handrail-chat__direct-creation--modal");
  assert.ok(overlay);
  await click(overlay);
  assert.equal(root.querySelector(".handrail-chat__direct-creation--modal"), null);
  assert.equal(document.activeElement, sectionTrigger);
});

test("pending direct creation blocks Escape, Cancel, and backdrop dismissal", async () => {
  const listeners = new Set();
  let directoryState = Object.freeze({ state: "idle" });
  const setDirectoryState = (next) => {
    const previous = directoryState;
    directoryState = Object.freeze(next);
    for (const listener of listeners) listener(directoryState, previous);
  };
  const client = {
    ...createClient(createCache()),
    getDirectorySearchState: () => directoryState,
    subscribeDirectorySearch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelDirectorySearch() {
      if (directoryState.state !== "idle") setDirectoryState({ state: "idle" });
    },
    async searchDirectoryUsers(input) {
      const users = [directoryUser];
      setDirectoryState({ state: "success", query: input.query, users });
      return { status: "success", value: { query: input.query, users } };
    },
    createDirect: () => new Promise(() => undefined),
  };
  const container = await renderWorkspace(workspace(client, {
    directCreationAvailability: { canCreate: true },
  }));
  const { dialog } = await openCreationDialog(container, "Create direct conversation");
  const overlay = dialog.parentElement;
  await enterText(dialog.querySelector('input[name="directoryQuery"]'), "avery");
  await waitForTimers(325);
  await click(dialog.querySelector('input[name="directParticipant"]'));
  await click(dialog.querySelector(".handrail-chat__direct-creation-submit"));

  const cancel = dialog.querySelector(".handrail-chat__direct-creation-cancel");
  assert.equal(cancel.disabled, true);
  assert.equal(dialog.querySelector(".handrail-chat__direct-creation-submit").disabled, true);
  assert.equal(
    dialog.querySelector(".handrail-chat__direct-creation-submit").getAttribute("aria-busy"),
    "true",
  );
  assert.match(dialog.textContent, /Creating direct conversation/);

  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }));
    await flush();
  });
  await click(cancel);
  await click(overlay);
  assert.equal(container.querySelector(".handrail-chat__direct-creation--modal"), overlay);
  assert.equal(container.querySelector(".handrail-chat__workspace-content").hasAttribute("inert"), true);
});

test("direct creation debounces directory search, selects one user, and reconciles authoritative conversations", async () => {
  const existingDirectId = "conversation-direct-existing";
  const existingDirect = directConversation(existingDirectId);
  const cache = createCache({
    organization: [existingDirect, firstConversation, secondConversation],
    details: [existingDirect, firstConversation, secondConversation],
  });
  const searchRequests = [];
  const creationCalls = [];
  const selected = [];
  const directIds = ["conversation-direct-created", existingDirectId];
  const listeners = new Set();
  let directoryState = Object.freeze({ state: "idle" });
  const setDirectoryState = (next) => {
    const previous = directoryState;
    directoryState = Object.freeze(next);
    for (const listener of listeners) listener(directoryState, previous);
  };
  const client = {
    ...createClient(cache),
    getDirectorySearchState: () => directoryState,
    subscribeDirectorySearch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelDirectorySearch() {
      if (directoryState.state !== "idle") setDirectoryState({ state: "idle" });
    },
    async searchDirectoryUsers(input) {
      searchRequests.push(input);
      const users = [directoryUser, secondDirectoryUser];
      setDirectoryState({ state: "success", query: input.query, users });
      return { status: "success", value: { query: input.query, users } };
    },
    async createDirect(input) {
      creationCalls.push(input);
      const index = creationCalls.length - 1;
      const snapshot = detailSnapshot(directConversation(directIds[index]));
      cache.hydrateConversationDetail(snapshot);
      return {
        status: "success",
        value: {
          operation: "create_conversation",
          type: "direct",
          reconciliationStatus: index === 0 ? "created" : "existing_equivalent",
          clientRequestId: `direct-request-${index + 1}`,
          conversation: snapshot,
        },
      };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: undefined,
    directCreationAvailability: { canCreate: true },
    onConversationChange: (conversationId) => selected.push(conversationId),
  }));
  const trigger = container.querySelector('button[aria-label="Add conversation"]');
  const directSection = () => [...container.querySelectorAll(
    ".handrail-chat__conversation-section",
  )].find((section) => section.querySelector(
    ".handrail-chat__conversation-section-label",
  )?.textContent === "Direct messages");

  assert.equal(directSection()?.querySelector(
    ".handrail-chat__conversation-section-count",
  )?.textContent, "1");
  assert.equal(directSection()?.querySelectorAll(
    ".handrail-chat__conversation-button",
  ).length, 1);

  let { dialog } = await openCreationDialog(container, "Create direct conversation");
  await enterText(dialog.querySelector('input[name="directoryQuery"]'), "cancelled");
  await click([...dialog.querySelectorAll("button")]
    .find((button) => button.textContent === "Cancel"));
  await waitForTimers(325);
  assert.deepEqual(searchRequests, []);
  assert.equal(document.activeElement, trigger);

  for (let index = 0; index < directIds.length; index += 1) {
    ({ dialog } = await openCreationDialog(container, "Create direct conversation"));
    const queryInput = dialog.querySelector('input[name="directoryQuery"]');
    await enterText(queryInput, "av");
    await waitForTimers(100);
    await enterText(queryInput, "  avery  ");
    await waitForTimers(225);
    assert.equal(searchRequests.length, index);
    await waitForTimers(100);

    assert.deepEqual(searchRequests.at(-1), { query: "avery", limit: 25 });
    const choices = dialog.querySelectorAll('input[name="directParticipant"]');
    assert.equal(choices.length, 2);
    await click(choices[0]);
    await click(choices[1]);
    assert.equal(choices[0].checked, false);
    assert.equal(choices[1].checked, true);

    await act(async () => {
      const form = dialog.querySelector("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelector("article").dataset.timelineFor, directIds[index]);
    assert.equal(document.activeElement, trigger);

    const directRows = directSection()?.querySelectorAll(
      ".handrail-chat__conversation-button",
    );
    assert.equal(directSection()?.querySelector(
      ".handrail-chat__conversation-section-count",
    )?.textContent, "2");
    assert.equal(directRows?.length, 2);
    const returnedRow = directSection()?.querySelector(
      `[data-conversation-id="${directIds[index]}"]`,
    );
    assert.ok(returnedRow);
    assert.equal(returnedRow.getAttribute("aria-current"), "page");
    assert.equal(container.querySelectorAll(
      '.handrail-chat__conversation-button[aria-current="page"]',
    ).length, 1);

    if (index === 0) {
      await act(async () => {
        cache.hydrateConversationList(listSnapshot(
          organizationScope,
          [directConversation(directIds[0]), existingDirect, firstConversation, secondConversation],
        ));
        await flush();
      });
      assert.equal(directSection()?.querySelector(
        ".handrail-chat__conversation-section-count",
      )?.textContent, "2");
      const reconciledRows = directSection()?.querySelectorAll(
        `[data-conversation-id="${directIds[0]}"]`,
      );
      assert.equal(reconciledRows?.length, 1);
      assert.equal(reconciledRows?.[0]?.getAttribute("aria-current"), "page");
    }
  }

  assert.deepEqual(creationCalls, [
    { intendedMemberUserIds: [secondDirectoryUserId] },
    { intendedMemberUserIds: [secondDirectoryUserId] },
  ]);
  assert.deepEqual(selected.slice(-2), directIds);
});

test("direct creation is fail-closed for absent, denied, and read-only availability", () => {
  const client = createClient(createCache());
  const cases = [
    {},
    { directCreationAvailability: { canCreate: false } },
    { directCreationAvailability: { canCreate: true }, readOnly: true },
  ];

  for (const props of cases) {
    const markup = renderToStaticMarkup(workspace(client, props));
    assert.doesNotMatch(markup, /aria-label="Add conversation"/);
  }
});

test("group-direct creation is a bounded root modal with stable navigation and exact focus restoration", async () => {
  const listeners = new Set();
  const directoryUsers = Array.from({ length: 25 }, (_, index) => Object.freeze({
    kind: "active",
    userId: `user-group-modal-${String(index + 1).padStart(2, "0")}`,
    displayName: `Group participant ${String(index + 1).padStart(2, "0")}`,
    avatar: Object.freeze({ kind: "initials", initials: `G${index + 1}` }),
  }));
  let directoryState = Object.freeze({ state: "idle" });
  const setDirectoryState = (next) => {
    const previous = directoryState;
    directoryState = Object.freeze(next);
    for (const listener of listeners) listener(directoryState, previous);
  };
  const client = {
    ...createClient(createCache()),
    getDirectorySearchState: () => directoryState,
    subscribeDirectorySearch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelDirectorySearch() {
      if (directoryState.state !== "idle") setDirectoryState({ state: "idle" });
    },
    async searchDirectoryUsers(input) {
      setDirectoryState({ state: "success", query: input.query, users: directoryUsers });
      return { status: "success", value: { query: input.query, users: directoryUsers } };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    currentUserId: actorId,
    groupDirectCreationAvailability: { canCreate: true },
  }));
  const root = container.querySelector(".handrail-chat");
  const navigation = root.querySelector('nav[aria-label="Conversations"]');
  const globalTrigger = navigation.querySelector('button[aria-label="Add conversation"]');
  const sectionTrigger = navigation.querySelector(
    'button[aria-label="Create a group conversation"]',
  );
  const rowsBefore = [...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )];
  const rowGeometry = () => rowsBefore.map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      id: row.dataset.conversationId,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
  const geometryBefore = rowGeometry();
  const press = async (element, key, init = {}) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      ...init,
    });
    await act(async () => {
      element.dispatchEvent(event);
      await flush();
    });
    return event;
  };
  const activateCheckboxFromKeyboard = async (checkbox) => {
    checkbox.focus();
    const event = await press(checkbox, " ");
    if (!event.defaultPrevented) await click(checkbox);
  };

  assert.equal(navigation.querySelector(".handrail-chat__group-direct-creation"), null);
  let { dialog } = await openCreationDialog(container, "Create group conversation");
  let overlay = root.querySelector(".handrail-chat__group-direct-creation--modal");
  const workspaceContent = [...root.children]
    .filter((element) => element.classList.contains("handrail-chat__workspace-content"));
  let queryInput = dialog.querySelector('input[name="groupDirectoryQuery"]');
  let cancel = dialog.querySelector(".handrail-chat__group-direct-creation-cancel");

  assert.equal(overlay.parentElement, root);
  assert.equal(navigation.contains(overlay), false);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(document.activeElement, queryInput);
  assert.ok(workspaceContent.length >= 2);
  assert.ok(workspaceContent.every((region) => region.hasAttribute("inert")));
  assert.deepEqual([...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )], rowsBefore);
  assert.deepEqual(rowGeometry(), geometryBefore);

  await press(queryInput, "Tab", { shiftKey: true });
  assert.equal(document.activeElement, cancel);
  await press(cancel, "Tab");
  assert.equal(document.activeElement, queryInput);

  await enterText(queryInput, "group");
  await waitForTimers(325);
  const choices = [...dialog.querySelectorAll('input[name="groupDirectParticipant"]')];
  assert.equal(choices.length, 25, "the maximum directory fixture stays in the result list");
  await activateCheckboxFromKeyboard(choices[0]);
  await act(async () => {
    for (const choice of choices.slice(1)) choice.click();
    await flush();
  });
  assert.equal(
    dialog.querySelectorAll(".handrail-chat__group-direct-creation-selected-item").length,
    25,
    "the long selected fixture stays in its dedicated list",
  );
  await click(dialog.querySelector(
    '[aria-label="Remove Group participant 01 from group conversation"]',
  ));
  assert.equal(
    dialog.querySelectorAll(".handrail-chat__group-direct-creation-selected-item").length,
    24,
  );
  assert.deepEqual([...navigation.querySelectorAll(
    ".handrail-chat__conversation-button[data-conversation-id]",
  )], rowsBefore);
  assert.deepEqual(rowGeometry(), geometryBefore);

  await click(cancel);
  assert.equal(root.querySelector(".handrail-chat__group-direct-creation--modal"), null);
  assert.ok(workspaceContent.every((region) => !region.hasAttribute("inert")));
  assert.equal(document.activeElement, globalTrigger);

  ({ dialog } = await openCreationDialog(container, "Create group conversation"));
  await press(dialog, "Escape");
  assert.equal(root.querySelector(".handrail-chat__group-direct-creation--modal"), null);
  assert.equal(document.activeElement, globalTrigger);

  await click(sectionTrigger);
  overlay = root.querySelector(".handrail-chat__group-direct-creation--modal");
  assert.ok(overlay);
  dialog = overlay.querySelector('[role="dialog"]');
  queryInput = dialog.querySelector('input[name="groupDirectoryQuery"]');
  assert.equal(document.activeElement, queryInput);
  await click(dialog);
  assert.equal(root.querySelector(".handrail-chat__group-direct-creation--modal"), overlay);
  await click(overlay);
  assert.equal(root.querySelector(".handrail-chat__group-direct-creation--modal"), null);
  assert.equal(document.activeElement, sectionTrigger);
});

test("group-direct creation preserves unique selections and reconciles canonical authoritative results", async () => {
  const cache = createCache();
  const creationCalls = [];
  const selected = [];
  const groupIds = ["conversation-group-created", "conversation-group-existing"];
  const listeners = new Set();
  let directoryState = Object.freeze({ state: "idle" });
  const setDirectoryState = (next) => {
    const previous = directoryState;
    directoryState = Object.freeze(next);
    for (const listener of listeners) listener(directoryState, previous);
  };
  const client = {
    ...createClient(cache),
    getDirectorySearchState: () => directoryState,
    subscribeDirectorySearch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelDirectorySearch() {
      if (directoryState.state !== "idle") setDirectoryState({ state: "idle" });
    },
    async searchDirectoryUsers(input) {
      const users = [
        directoryUser,
        actorDirectoryUser,
        directoryUser,
        secondDirectoryUser,
      ];
      setDirectoryState({ state: "success", query: input.query, users });
      return { status: "success", value: { query: input.query, users } };
    },
    async createGroupDirect(input) {
      creationCalls.push(input);
      const index = creationCalls.length - 1;
      const snapshot = detailSnapshot(groupDirectConversation(groupIds[index]));
      cache.hydrateConversationDetail(snapshot);
      return {
        status: "success",
        value: {
          operation: "create_conversation",
          type: "group_direct",
          reconciliationStatus: index === 0 ? "created" : "existing_equivalent",
          clientRequestId: `group-request-${index + 1}`,
          conversation: snapshot,
        },
      };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: undefined,
    currentUserId: actorId,
    groupDirectCreationAvailability: { canCreate: true },
    onConversationChange: (conversationId) => selected.push(conversationId),
  }));
  const trigger = container.querySelector('button[aria-label="Add conversation"]');

  for (let index = 0; index < groupIds.length; index += 1) {
    let { dialog } = await openCreationDialog(container, "Create group conversation");
    const submit = dialog.querySelector('button[type="submit"]');
    assert.equal(submit.disabled, true);

    await enterText(
      dialog.querySelector('input[name="groupDirectoryQuery"]'),
      index === 0 ? "people" : "team",
    );
    await waitForTimers(325);

    let choices = dialog.querySelectorAll('input[name="groupDirectParticipant"]');
    assert.equal(choices.length, 2, "duplicate IDs and the trusted actor are omitted");
    await click(choices[0]);
    assert.equal(submit.disabled, true);
    await click(choices[1]);
    assert.equal(submit.disabled, false);
    assert.equal(
      dialog.querySelectorAll(".handrail-chat__group-direct-creation-selected-item").length,
      2,
    );

    const removeAvery = dialog.querySelector(
      '[aria-label="Remove Avery Example from group conversation"]',
    );
    await click(removeAvery);
    assert.equal(submit.disabled, true);
    assert.equal(
      dialog.querySelectorAll(".handrail-chat__group-direct-creation-selected-item").length,
      1,
    );

    await enterText(
      dialog.querySelector('input[name="groupDirectoryQuery"]'),
      "another search",
    );
    await waitForTimers(325);
    dialog = container.querySelector('[role="dialog"]');
    assert.equal(
      dialog.querySelectorAll(".handrail-chat__group-direct-creation-selected-item").length,
      1,
      "selection is retained across searches",
    );
    choices = dialog.querySelectorAll('input[name="groupDirectParticipant"]');
    assert.equal(choices[1].checked, true);
    await click(choices[0]);

    await act(async () => {
      const form = dialog.querySelector("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelector("article").dataset.timelineFor, groupIds[index]);
    assert.equal(document.activeElement, trigger);
  }

  assert.deepEqual(creationCalls, [
    { intendedMemberUserIds: [secondDirectoryUserId, otherUserId] },
    { intendedMemberUserIds: [secondDirectoryUserId, otherUserId] },
  ]);
  assert.deepEqual(selected.slice(-2), groupIds);
});

test("group-direct creation blocks pending duplicates and retains selections after errors", async () => {
  const cache = createCache();
  const calls = [];
  const listeners = new Set();
  let resolveCreation;
  let directoryState = Object.freeze({ state: "idle" });
  const setDirectoryState = (next) => {
    const previous = directoryState;
    directoryState = Object.freeze(next);
    for (const listener of listeners) listener(directoryState, previous);
  };
  const client = {
    ...createClient(cache),
    getDirectorySearchState: () => directoryState,
    subscribeDirectorySearch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelDirectorySearch() {
      if (directoryState.state !== "idle") setDirectoryState({ state: "idle" });
    },
    async searchDirectoryUsers(input) {
      const users = [directoryUser, secondDirectoryUser];
      setDirectoryState({ state: "success", query: input.query, users });
      return { status: "success", value: { query: input.query, users } };
    },
    createGroupDirect(input) {
      calls.push(input);
      return new Promise((resolve) => {
        resolveCreation = resolve;
      });
    },
  };
  const container = await renderWorkspace(workspace(client, {
    currentUserId: actorId,
    groupDirectCreationAvailability: { canCreate: true },
  }));
  const { dialog } = await openCreationDialog(container, "Create group conversation");
  await enterText(dialog.querySelector('input[name="groupDirectoryQuery"]'), "people");
  await waitForTimers(325);
  const choices = dialog.querySelectorAll('input[name="groupDirectParticipant"]');
  await click(choices[0]);
  await click(choices[1]);

  await act(async () => {
    const form = dialog.querySelector("form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });

  assert.equal(calls.length, 1);
  assert.equal(
    dialog.querySelector('[role="status"]').textContent,
    "Creating group conversation…",
  );
  const overlay = dialog.parentElement;
  const cancel = dialog.querySelector(".handrail-chat__group-direct-creation-cancel");
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
  assert.equal(cancel.disabled, true);
  assert.equal(dialog.querySelector('input[name="groupDirectoryQuery"]').disabled, true);
  assert.equal(dialog.querySelector("fieldset").disabled, true);
  assert.ok([...dialog.querySelectorAll(".handrail-chat__group-direct-creation-remove")]
    .every((button) => button.disabled));

  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    }));
    await flush();
  });
  await click(cancel);
  await click(overlay);
  assert.equal(
    container.querySelector(".handrail-chat__group-direct-creation--modal"),
    overlay,
  );
  assert.equal(container.querySelector(".handrail-chat__workspace-content").hasAttribute("inert"), true);

  await act(async () => {
    resolveCreation({
      status: "rejected",
      message: "The chat server rejected the command.",
      httpStatus: 403,
    });
    await flush();
  });

  assert.match(dialog.querySelector('[role="alert"]').textContent, /try again/i);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, false);
  assert.equal(
    dialog.querySelectorAll(".handrail-chat__group-direct-creation-selected-item").length,
    2,
  );
  assert.equal(choices[0].checked, true);
  assert.equal(choices[1].checked, true);
});

test("group-direct creation is fail-closed for absent, denied, and read-only availability", () => {
  const client = createClient(createCache());
  const cases = [
    {},
    { groupDirectCreationAvailability: { canCreate: false } },
    { groupDirectCreationAvailability: { canCreate: true }, readOnly: true },
  ];

  for (const props of cases) {
    const markup = renderToStaticMarkup(workspace(client, props));
    assert.doesNotMatch(markup, /aria-label="Add conversation"/);
  }
});

test("member management searches the authorized directory and uses each latest canonical revision", async () => {
  const cache = createCache();
  seedMembership(cache, 7);
  const addCalls = [];
  const removeCalls = [];
  const searchCalls = [];
  const directoryListeners = new Set();
  let directoryState = Object.freeze({ state: "idle" });
  const setDirectoryState = (next) => {
    const previous = directoryState;
    directoryState = Object.freeze(next);
    for (const listener of directoryListeners) listener(directoryState, previous);
  };
  const users = new Map([
    [actorId, actorDirectoryUser],
    [otherUserId, directoryUser],
    [secondDirectoryUserId, secondDirectoryUser],
  ]);
  const client = {
    ...createClient(cache),
    selectDirectoryUser: (userId) => users.get(userId),
    hydrateDirectoryUsers: async (userIds) => ({
      status: "success",
      value: { users: userIds.flatMap((userId) => users.get(userId) ?? []) },
    }),
    getDirectorySearchState: () => directoryState,
    subscribeDirectorySearch(listener) {
      directoryListeners.add(listener);
      return () => directoryListeners.delete(listener);
    },
    cancelDirectorySearch() {
      if (directoryState.state !== "idle") setDirectoryState({ state: "idle" });
    },
    async searchDirectoryUsers(input) {
      searchCalls.push(input);
      const results = [directoryUser, secondDirectoryUser];
      setDirectoryState({ state: "success", query: input.query, users: results });
      return { status: "success", value: { query: input.query, users: results } };
    },
    async addConversationMember(input) {
      addCalls.push(input);
      const authored = {
        ...input,
        operation: "mutate_conversation_membership",
        intent: "add_member",
        idempotencyKey: "add-member",
      };
      const value = {
        operation: authored.operation,
        intent: authored.intent,
        conversationId: firstId,
        expectedMemberListRevision: input.expectedMemberListRevision,
        memberListRevision: 8,
        memberUserId: secondDirectoryUserId,
        targetUserId: secondDirectoryUserId,
        requestedRole: "member",
        reconciliationStatus: "applied",
        members: [
          canonicalMember(actorId),
          canonicalMember(secondDirectoryUserId),
          canonicalMember(otherUserId),
        ],
      };
      reconcileMembership(cache, authored, value, "add-member");
      return { status: "success", value };
    },
    async removeConversationMember(input) {
      removeCalls.push(input);
      const authored = {
        ...input,
        operation: "mutate_conversation_membership",
        intent: "remove_member",
        idempotencyKey: "remove-member",
      };
      const value = {
        operation: authored.operation,
        intent: authored.intent,
        conversationId: firstId,
        expectedMemberListRevision: input.expectedMemberListRevision,
        memberListRevision: 9,
        memberUserId: otherUserId,
        targetUserId: otherUserId,
        reconciliationStatus: "applied",
        members: [
          canonicalMember(actorId),
          canonicalMember(secondDirectoryUserId),
          canonicalMember(otherUserId, "removed"),
        ],
      };
      reconcileMembership(cache, authored, value, "remove-member");
      return { status: "success", value };
    },
  };
  const availability = {
    canView: true,
    canAddMember: (user) => user.userId === secondDirectoryUserId,
    canRemoveMember: (member) => member.userId === otherUserId,
  };
  const container = await renderWorkspace(workspace(client, {
    memberManagementAvailability: availability,
  }));
  assert.deepEqual(searchCalls, [], "opening the panel does not search the directory");
  const { panel } = await openMemberManagement(container);
  assert.deepEqual(searchCalls, [], "directory search remains idle before a query");
  assert.match(panel.textContent, /Current User/);
  assert.match(panel.textContent, /Avery Example/);
  assert.equal(
    panel.querySelector('[role="status"]').textContent,
    "Search the directory to add a member.",
  );

  await enterText(panel.querySelector('input[name="memberDirectoryQuery"]'), "  team  ");
  assert.equal(
    panel.querySelector('[role="status"]').textContent,
    "Searching directory…",
  );
  await waitForTimers(325);
  assert.deepEqual(searchCalls, [{ query: "team", limit: 25 }]);
  const choices = panel.querySelectorAll('input[name="memberDirectoryUser"]');
  assert.equal(choices.length, 1, "active and host-ineligible directory users are not add controls");
  assert.equal(choices[0].value, secondDirectoryUserId);
  await click(choices[0]);
  await act(async () => {
    const form = panel.querySelector("form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });

  assert.deepEqual(addCalls, [{
    conversationId: firstId,
    expectedMemberListRevision: 7,
    targetUserId: secondDirectoryUserId,
    requestedRole: "member",
  }]);
  assert.match(panel.textContent, /Morgan Example/);
  assert.match(
    [...panel.querySelectorAll('[role="status"]')].map(({ textContent }) => textContent).join(" "),
    /was added/i,
  );

  const remove = panel.querySelector('[aria-label="Remove Avery Example from conversation"]');
  await click(remove);
  assert.deepEqual(removeCalls, [{
    conversationId: firstId,
    expectedMemberListRevision: 8,
    targetUserId: otherUserId,
  }]);
  assert.doesNotMatch(
    panel.querySelector(".handrail-chat__member-management-list").textContent,
    /Avery Example/,
  );
  assert.match(
    [...panel.querySelectorAll('[role="status"]')].map(({ textContent }) => textContent).join(" "),
    /was removed/i,
  );
});

test("member management announces pending, conflict, safety, and transport outcomes accessibly", async () => {
  const cache = createCache();
  seedMembership(cache, 11);
  const outcomes = [];
  let resolveRemoval;
  const client = {
    ...createClient(cache),
    removeConversationMember(input) {
      outcomes.push(input);
      if (outcomes.length === 1) {
        return new Promise((resolve) => {
          resolveRemoval = resolve;
        });
      }
      if (outcomes.length === 2) {
        return Promise.resolve({
          status: "success",
          value: {
            reconciliationStatus: "safety_rejected",
            safetyError: { code: "last_owner", message: "Server safety message" },
          },
        });
      }
      return Promise.resolve({
        status: "transport",
        message: "The chat command could not be completed.",
      });
    },
  };
  const container = await renderWorkspace(workspace(client, {
    memberManagementAvailability: {
      canView: true,
      canRemoveMember: (member) => member.userId === otherUserId,
    },
  }));
  const { panel } = await openMemberManagement(container);
  const remove = panel.querySelector('[aria-label="Remove Avery Example from conversation"]');

  await act(async () => {
    remove.click();
    remove.click();
    await flush();
  });
  assert.equal(outcomes.length, 1, "pending removal blocks duplicate activation");
  assert.equal(panel.getAttribute("aria-busy"), "true");
  assert.equal(panel.querySelector('[role="status"]').textContent, "Removing member…");

  await act(async () => {
    resolveRemoval({
      status: "success",
      value: { reconciliationStatus: "member_list_conflict" },
    });
    await flush();
  });
  assert.match(panel.querySelector('[role="alert"]').textContent, /member list changed/i);

  await click(remove);
  assert.match(panel.querySelector('[role="alert"]').textContent, /last owner/i);

  await click(remove);
  assert.match(panel.querySelector('[role="alert"]').textContent, /not removed/i);
  assert.deepEqual(outcomes.map(({ expectedMemberListRevision }) => expectedMemberListRevision), [11, 11, 11]);
});

test("member role selection reconciles conflicts and authors exact canonical roles with latest revisions", async () => {
  const cache = createCache();
  seedMembership(cache, 7, { actorRole: "owner" });
  const roleCalls = [];
  const removeCalls = [];
  let releaseConflict;
  const client = {
    ...createClient(cache),
    removeConversationMember(input) {
      removeCalls.push(input);
      return Promise.resolve({ status: "transport", message: "Unexpected removal." });
    },
    changeConversationMemberRole(input) {
      roleCalls.push(input);
      const callNumber = roleCalls.length;
      const authored = {
        ...input,
        operation: "mutate_conversation_membership",
        intent: "change_member_role",
        idempotencyKey: `role-change-${callNumber}`,
      };
      const reconciliationStatus = callNumber === 1
        ? "member_list_conflict"
        : "applied";
      const memberListRevision = callNumber === 1 ? 8 : callNumber === 2 ? 9 : 10;
      const canonicalRole = callNumber === 2 ? "moderator" : "member";
      const value = {
        operation: authored.operation,
        intent: authored.intent,
        conversationId: firstId,
        expectedMemberListRevision: input.expectedMemberListRevision,
        memberListRevision,
        memberUserId: otherUserId,
        targetUserId: otherUserId,
        requestedRole: input.requestedRole,
        reconciliationStatus,
        members: [
          canonicalMember(actorId, "active", "owner"),
          canonicalMember(otherUserId, "active", canonicalRole),
        ],
      };
      if (callNumber === 1) {
        return new Promise((resolve) => {
          releaseConflict = () => {
            reconcileMembership(cache, authored, value, authored.idempotencyKey);
            const refreshInput = {
              operation: "mutate_conversation_membership",
              intent: "add_member",
              conversationId: firstId,
              expectedMemberListRevision: 7,
              idempotencyKey: "role-conflict-refresh",
              targetUserId: otherUserId,
              requestedRole: "member",
            };
            reconcileMembership(cache, refreshInput, {
              operation: refreshInput.operation,
              intent: refreshInput.intent,
              conversationId: firstId,
              expectedMemberListRevision: 7,
              memberListRevision: 8,
              memberUserId: otherUserId,
              targetUserId: otherUserId,
              requestedRole: "member",
              reconciliationStatus: "applied",
              members: [
                canonicalMember(actorId, "active", "owner"),
                canonicalMember(otherUserId),
              ],
            }, refreshInput.idempotencyKey);
            resolve({ status: "success", value });
          };
        });
      }
      reconcileMembership(cache, authored, value, authored.idempotencyKey);
      return Promise.resolve({ status: "success", value });
    },
  };
  const container = await renderWorkspace(workspace(client, {
    memberManagementAvailability: {
      canView: true,
      canRemoveMember: (member) => member.userId === otherUserId,
      canChangeMemberRole: (member, requestedRole) =>
        member.userId === otherUserId && requestedRole !== "owner",
    },
  }));
  const { panel } = await openMemberManagement(container);
  let selector = panel.querySelector('[aria-label="Role for Avery Example"]');
  const ownerOption = selector.querySelector('option[value="owner"]');
  assert.equal(selector.value, "member");
  assert.equal(ownerOption.disabled, true, "host-unsupported target roles are disabled");

  await act(async () => {
    selector.value = "moderator";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    selector.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
  assert.equal(roleCalls.length, 1, "the shared pending guard blocks duplicate role changes");
  assert.equal(selector.disabled, true);
  assert.equal(
    panel.querySelector('[role="status"]').textContent,
    "Changing member role…",
  );
  const remove = panel.querySelector('[aria-label="Remove Avery Example from conversation"]');
  assert.equal(remove.disabled, true, "pending role changes disable overlapping removal");
  await click(remove);
  assert.equal(removeCalls.length, 0);

  await act(async () => {
    releaseConflict();
    await flush();
  });
  assert.match(panel.querySelector('[role="alert"]').textContent, /refreshed/i);
  selector = panel.querySelector('[aria-label="Role for Avery Example"]');
  assert.equal(selector.value, "member", "conflict applies the complete canonical member list");

  await chooseSelectValue(selector, "moderator");
  selector = panel.querySelector('[aria-label="Role for Avery Example"]');
  assert.equal(selector.value, "moderator");
  assert.match(panel.querySelector('[role="status"]').textContent, /now a Moderator/i);

  await chooseSelectValue(selector, "member");
  selector = panel.querySelector('[aria-label="Role for Avery Example"]');
  assert.equal(selector.value, "member");
  assert.match(panel.querySelector('[role="status"]').textContent, /now a Member/i);
  assert.deepEqual(roleCalls, [
    {
      conversationId: firstId,
      expectedMemberListRevision: 7,
      requestedRole: "moderator",
      targetUserId: otherUserId,
    },
    {
      conversationId: firstId,
      expectedMemberListRevision: 8,
      requestedRole: "moderator",
      targetUserId: otherUserId,
    },
    {
      conversationId: firstId,
      expectedMemberListRevision: 9,
      requestedRole: "member",
      targetUserId: otherUserId,
    },
  ]);
});

test("member role selection preserves last-owner safety and announces transport failures", async () => {
  const cache = createCache();
  seedMembership(cache, 4, { actorRole: "owner" });
  const roleCalls = [];
  const client = {
    ...createClient(cache),
    changeConversationMemberRole(input) {
      roleCalls.push(input);
      if (roleCalls.length > 1) {
        return Promise.resolve({
          status: "transport",
          message: "The chat command could not be completed.",
        });
      }
      const authored = {
        ...input,
        operation: "mutate_conversation_membership",
        intent: "change_member_role",
        idempotencyKey: "last-owner-role-change",
      };
      const value = {
        operation: authored.operation,
        intent: authored.intent,
        conversationId: firstId,
        expectedMemberListRevision: 4,
        memberListRevision: 4,
        memberUserId: actorId,
        targetUserId: actorId,
        requestedRole: "member",
        reconciliationStatus: "safety_rejected",
        safetyError: { code: "last_owner", message: "Server last-owner safety response." },
        members: [
          canonicalMember(actorId, "active", "owner"),
          canonicalMember(otherUserId),
        ],
      };
      reconcileMembership(cache, authored, value, authored.idempotencyKey);
      return Promise.resolve({ status: "success", value });
    },
  };
  const container = await renderWorkspace(workspace(client, {
    memberManagementAvailability: {
      canView: true,
      canChangeMemberRole: (member, requestedRole) =>
        member.userId === actorId && requestedRole === "member",
    },
  }));
  const { panel } = await openMemberManagement(container);
  let selector = panel.querySelector('[aria-label="Role for Unknown user"]');
  await chooseSelectValue(selector, "member");
  assert.match(panel.querySelector('[role="alert"]').textContent, /last owner/i);
  selector = panel.querySelector('[aria-label="Role for Unknown user"]');
  assert.equal(selector.value, "owner", "safety rejection retains the canonical owner role");

  await chooseSelectValue(selector, "member");
  assert.match(panel.querySelector('[role="alert"]').textContent, /role was not changed/i);
  assert.deepEqual(roleCalls, [
    {
      conversationId: firstId,
      expectedMemberListRevision: 4,
      requestedRole: "member",
      targetUserId: actorId,
    },
    {
      conversationId: firstId,
      expectedMemberListRevision: 4,
      requestedRole: "member",
      targetUserId: actorId,
    },
  ]);
});

test("member management is fail-closed when unavailable and hides mutations when denied or read-only", async () => {
  const cache = createCache();
  seedMembership(cache, 3);
  const client = createClient(cache);
  const resolver = () => true;

  for (const props of [{}, { memberManagementAvailability: { canView: false } }]) {
    const markup = renderToStaticMarkup(workspace(client, props));
    assert.doesNotMatch(markup, /Open conversation members/);
    assert.doesNotMatch(markup, /handrail-chat__member-management-trigger/);
    assert.doesNotMatch(markup, /aria-label="Conversation members"/);
  }

  for (const props of [
    { memberManagementAvailability: { canView: true } },
    {
      memberManagementAvailability: {
        canView: true,
        canChangeMemberRole: () => false,
      },
    },
    {
      memberManagementAvailability: {
        canView: true,
        canAddMember: resolver,
        canRemoveMember: resolver,
        canChangeMemberRole: resolver,
      },
      readOnly: true,
    },
  ]) {
    const container = await renderWorkspace(workspace(client, props));
    const { panel } = await openMemberManagement(container);
    assert.equal(panel.querySelector('input[name="memberDirectoryQuery"]'), null);
    assert.equal(panel.querySelector('select[name="conversationMemberRole"]'), null);
    assert.equal(
      [...panel.querySelectorAll("button")].some(({ textContent }) => textContent === "Remove"),
      false,
    );
    assert.equal(
      [...panel.querySelectorAll("button")].some(({ textContent }) => textContent === "Add member"),
      false,
    );
  }
});

test("notification preferences author every level and mute shape with authoritative SDK revisions", async () => {
  const cache = createCache();
  seedPreferenceRevision(cache, 7, {
    notificationPreference: "mentions",
    mute: { muted: true },
  });
  const requests = [];
  let idempotencyKeys = 0;
  const sdkClient = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "workspace-preference-token",
    commands: { retry: { maxAttempts: 1 } },
    conversationPreferences: {
      generateIdempotencyKey: () => `workspace-preference-${++idempotencyKeys}`,
      now: () => Date.parse(now),
    },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      requests.push(input);
      return commandResponse(preferenceResult(input));
    },
  });
  const client = {
    ...createClient(cache),
    updateConversationPreference: (input) =>
      sdkClient.updateConversationPreference(input),
  };
  const container = await renderWorkspace(workspace(client));
  const navigationRow = () => container.querySelector(
    `[data-conversation-id="${firstId}"]`,
  );
  assert.equal(navigationRow().dataset.notificationLevel, "mentions");
  assert.equal(navigationRow().dataset.muteState, "indefinite");
  const trigger = container.querySelector(
    ".handrail-chat__notification-preferences-trigger",
  );
  await click(trigger);
  const panel = container.querySelector(
    ".handrail-chat__notification-preferences-panel",
  );

  assert.ok(panel);
  assert.match(panel.textContent, /Current preference: Mentions only; Muted indefinitely/);
  assert.equal(container.innerHTML.includes(actorId), false);
  assert.equal(container.innerHTML.includes(otherUserId), false);

  const boundedLocal = "2042-03-04T05:06";
  const boundedCanonical = new Date(boundedLocal).toISOString();
  const authoredStates = [
    ["all", "unmuted"],
    ["mentions", "indefinite"],
    ["none", "until", boundedLocal],
  ];
  for (const [notificationPreference, mute, until] of authoredStates) {
    await chooseSelectValue(
      panel.querySelector('select[name="notificationPreference"]'),
      notificationPreference,
    );
    await click(panel.querySelector(`input[name="conversationMute"][value="${mute}"]`));
    if (until !== undefined) {
      await enterText(panel.querySelector('input[name="mutedUntil"]'), until);
    }
    await act(async () => {
      panel.querySelector("form").dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
      await flush();
    });
    assert.match(panel.querySelector('[role="status"]').textContent, /saved/i);
    assert.equal(
      navigationRow().dataset.notificationLevel,
      notificationPreference,
    );
    assert.equal(
      navigationRow().dataset.muteState,
      mute === "until" ? "finite" : mute,
    );
    assert.equal(
      navigationRow().dataset.mutedUntil,
      mute === "until" ? boundedCanonical : undefined,
    );
    assert.match(
      navigationRow().getAttribute("aria-label"),
      notificationPreference === "all"
        ? /Notifications: All messages/u
        : notificationPreference === "mentions"
          ? /Notifications: Mentions only/u
          : /Notifications: No notifications/u,
    );
  }

  assert.deepEqual(requests.map(({
    operation,
    conversationId,
    expectedPreferenceRevision,
    notificationPreference,
    mute,
  }) => ({
    operation,
    conversationId,
    expectedPreferenceRevision,
    notificationPreference,
    mute,
  })), [
    {
      operation: "update_conversation_preference",
      conversationId: firstId,
      expectedPreferenceRevision: 7,
      notificationPreference: "all",
      mute: { muted: false },
    },
    {
      operation: "update_conversation_preference",
      conversationId: firstId,
      expectedPreferenceRevision: 8,
      notificationPreference: "mentions",
      mute: { muted: true },
    },
    {
      operation: "update_conversation_preference",
      conversationId: firstId,
      expectedPreferenceRevision: 9,
      notificationPreference: "none",
      mute: { muted: true, mutedUntil: boundedCanonical },
    },
  ]);
  assert.equal(
    panel.querySelector('select[name="notificationPreference"]').value,
    "none",
  );
  assert.equal(
    panel.querySelector('input[name="conversationMute"][value="until"]').checked,
    true,
  );
  assert.match(panel.textContent, new RegExp(`Muted until ${boundedCanonical}`));
});

test("notification preference pending and conflict states reconcile canonical choices before an explicit retry", async () => {
  const cache = createCache();
  seedPreferenceRevision(cache, 11);
  const requests = [];
  let releaseFirst;
  let idempotencyKeys = 0;
  const sdkClient = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "workspace-preference-token",
    commands: { retry: { maxAttempts: 1 } },
    conversationPreferences: {
      generateIdempotencyKey: () => `workspace-conflict-${++idempotencyKeys}`,
      now: () => Date.parse(now),
    },
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      requests.push(input);
      if (requests.length === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(commandResponse(preferenceResult(input, {
            reconciliationStatus: "preference_revision_conflict",
            preferenceRevision: 14,
            preference: {
              notificationPreference: "mentions",
              mute: { muted: true },
            },
          }), 409));
        });
      }
      return commandResponse(preferenceResult(input));
    },
  });
  const client = {
    ...createClient(cache),
    updateConversationPreference: (input) =>
      sdkClient.updateConversationPreference(input),
  };
  const container = await renderWorkspace(workspace(client));
  await click(container.querySelector(
    ".handrail-chat__notification-preferences-trigger",
  ));
  const panel = container.querySelector(
    ".handrail-chat__notification-preferences-panel",
  );
  await chooseSelectValue(
    panel.querySelector('select[name="notificationPreference"]'),
    "none",
  );
  const form = panel.querySelector("form");

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.equal(requests.length, 1, "pending submission blocks duplicate transport work");
  assert.equal(panel.querySelector('button[type="submit"]').disabled, true);
  assert.equal(panel.querySelector('button[type="submit"]').getAttribute("aria-busy"), "true");
  assert.equal(
    panel.querySelector('[role="status"]').textContent,
    "Saving notification preferences…",
  );

  await act(async () => {
    releaseFirst();
    await flush();
  });
  assert.match(panel.querySelector('[role="alert"]').textContent, /changed elsewhere/i);
  assert.match(panel.querySelector('[role="alert"]').textContent, /Authoritative preference loaded: Mentions only; Muted indefinitely/i);
  assert.equal(
    panel.querySelector('select[name="notificationPreference"]').value,
    "mentions",
  );
  assert.equal(
    panel.querySelector('input[name="conversationMute"][value="indefinite"]').checked,
    true,
  );

  await chooseSelectValue(
    panel.querySelector('select[name="notificationPreference"]'),
    "all",
  );
  await click(panel.querySelector('input[name="conversationMute"][value="unmuted"]'));
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.deepEqual(requests.map(({
    expectedPreferenceRevision,
    notificationPreference,
    mute,
  }) => ({ expectedPreferenceRevision, notificationPreference, mute })), [
    {
      expectedPreferenceRevision: 11,
      notificationPreference: "none",
      mute: { muted: false },
    },
    {
      expectedPreferenceRevision: 14,
      notificationPreference: "all",
      mute: { muted: false },
    },
  ]);
  assert.match(panel.querySelector('[role="status"]').textContent, /saved/i);
});

test("notification preference failures are actionable and read-only workspaces cannot submit", async () => {
  const cache = createCache();
  seedPreferenceRevision(cache, 3);
  const requests = [];
  const sdkClient = createChatClient({
    endpoint: "/chat",
    cache,
    getAccessToken: () => "workspace-preference-token",
    commands: { retry: { maxAttempts: 1 } },
    async fetch(_url, init) {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) {
        return commandResponse({
          error: { code: "CHAT_AUTHENTICATION_REQUIRED", message: "denied" },
        }, 401);
      }
      throw new Error("offline");
    },
  });
  const client = {
    ...createClient(cache),
    updateConversationPreference: (input) =>
      sdkClient.updateConversationPreference(input),
  };
  const container = await renderWorkspace(workspace(client));
  await click(container.querySelector(
    ".handrail-chat__notification-preferences-trigger",
  ));
  const panel = container.querySelector(
    ".handrail-chat__notification-preferences-panel",
  );
  await chooseSelectValue(
    panel.querySelector('select[name="notificationPreference"]'),
    "none",
  );
  const form = panel.querySelector("form");

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.match(panel.querySelector('[role="alert"]').textContent, /Sign in again/i);

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.match(panel.querySelector('[role="alert"]').textContent, /Check your connection/i);
  assert.deepEqual(
    requests.map(({ expectedPreferenceRevision }) => expectedPreferenceRevision),
    [3, 3],
  );

  const readOnlyContainer = await renderWorkspace(workspace(createClient(createCache()), {
    readOnly: true,
  }));
  await click(readOnlyContainer.querySelector(
    ".handrail-chat__notification-preferences-trigger",
  ));
  const readOnlyPanel = readOnlyContainer.querySelector(
    ".handrail-chat__notification-preferences-panel",
  );
  assert.match(readOnlyPanel.textContent, /read-only/i);
  assert.equal(
    readOnlyPanel.querySelector('select[name="notificationPreference"]').disabled,
    true,
  );
  assert.equal(
    readOnlyPanel.querySelector('button[type="submit"]'),
    null,
  );
});

test("conversation pagination control is absent without a next cursor", () => {
  const markup = renderToStaticMarkup(workspace(createClient(createCache())));

  assert.doesNotMatch(markup, /Load more conversations/);
});

test("conversation pagination invokes one load per activation and announces in-flight work", async () => {
  const cache = createCache({ organizationNextCursor: conversationCursor });
  let resolveRequest;
  const requests = [];
  const client = {
    ...createClient(cache),
    listConversations(input) {
      if (input.cursor === undefined) return Promise.resolve({ status: "success" });
      requests.push(input);
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    },
  };
  const container = await renderWorkspace(workspace(client));
  const loadMore = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Load more conversations");

  assert.ok(loadMore);
  await act(async () => {
    loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].cursor, conversationCursor);
  assert.equal(loadMore.disabled, true);
  assert.equal(loadMore.getAttribute("aria-busy"), "true");
  assert.equal(container.querySelector('[role="status"]').textContent, "Loading more conversations…");

  await act(async () => {
    resolveRequest({ status: "success" });
    await flush();
  });
});

test("appended conversations preserve the selected and focused conversation button", async () => {
  const cache = createCache({ organizationNextCursor: conversationCursor });
  const client = {
    ...createClient(cache),
    async listConversations(input) {
      if (input.cursor === undefined) return { status: "success" };
      cache.hydrateConversationList(
        listSnapshot(organizationScope, [thirdConversation]),
        { requestCursor: input.cursor },
      );
      return { status: "success" };
    },
  };
  const container = await renderWorkspace(workspace(client, {
    conversationId: undefined,
  }));
  let conversationButtons = container.querySelectorAll(".handrail-chat__conversation-button");
  await act(async () => {
    conversationButtons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    conversationButtons[1].focus();
  });
  const focusedButton = conversationButtons[1];
  const loadMore = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Load more conversations");

  await act(async () => {
    loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
  });

  conversationButtons = container.querySelectorAll(".handrail-chat__conversation-button");
  assert.equal(conversationButtons.length, 3);
  assert.equal(conversationButtons[1].getAttribute("aria-current"), "page");
  assert.equal(document.activeElement, focusedButton);
  assert.equal(document.activeElement, conversationButtons[1]);
  assert.equal(container.querySelector("article").dataset.timelineFor, secondId);
});

test("a failed conversation page remains visible and retryable", async () => {
  const cache = createCache({ organizationNextCursor: conversationCursor });
  let attempts = 0;
  const client = {
    ...createClient(cache),
    async listConversations(input) {
      if (input.cursor === undefined) return { status: "success" };
      attempts += 1;
      return attempts === 1
        ? { status: "transport", message: "Older conversations could not be loaded." }
        : { status: "success" };
    },
  };
  const container = await renderWorkspace(workspace(client));
  let loadMore = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Load more conversations");

  await act(async () => {
    loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
  });

  assert.equal(container.querySelector('[role="alert"]').textContent, "Older conversations could not be loaded.");
  assert.match(container.textContent, /Organization chat/);
  loadMore = [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Load more conversations");
  assert.ok(loadMore);
  assert.equal(loadMore.disabled, false);

  await act(async () => {
    loadMore.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
  });
  assert.equal(attempts, 2);
});

test("loading, error, and empty results expose live status, alert, and empty regions", () => {
  const loadingClient = createClient(createCache({
    seedOrganization: false,
    seedEntity: false,
    details: [],
  }));
  const loadingMarkup = renderToStaticMarkup(workspace(loadingClient, {
    conversationId: null,
  }));
  assert.match(loadingMarkup, /role="status"/);
  assert.match(loadingMarkup, /Loading conversations/);
  assert.match(loadingMarkup, /aria-busy="true"/);

  const errorState = Object.freeze({
    state: "error",
    diagnostic: Object.freeze({
      code: "startup_failed",
      message: "Chat is temporarily unavailable.",
    }),
  });
  const errorMarkup = renderToStaticMarkup(workspace(
    createClient(createCache({ seedOrganization: false, details: [] }), errorState),
    { conversationId: null },
  ));
  assert.match(errorMarkup, /role="alert"/);
  assert.match(errorMarkup, /Chat is temporarily unavailable/);

  const emptyMarkup = renderToStaticMarkup(workspace(createClient(createCache({
    organization: [],
    details: [],
  })), { conversationId: null }));
  assert.match(emptyMarkup, />No conversations</);
  assert.match(emptyMarkup, /There are no conversations in this chat scope/);
});

test("wide workspace identity and body replacements retain public slot output", () => {
  const Avatar = ({ user, hostProps }) => createElement(
    "span",
    { ...hostProps, "data-custom-avatar": user.displayName },
  );
  const User = ({ user, hostProps }) => createElement(
    "span",
    { ...hostProps, "data-custom-user": user.displayName },
  );
  const ChannelHeader = ({ conversation: selected, hostProps }) => createElement(
    "h2",
    { ...hostProps, "data-custom-header": selected.id },
    selected.type,
  );
  const EmptyState = ({ kind, hostProps }) => createElement(
    "div",
    { ...hostProps, "data-custom-empty": kind },
  );
  const components = { Avatar, ChannelHeader, EmptyState, User };
  const markup = renderToStaticMarkup(workspace(createClient(createCache()), {
    components,
    renderHuddle: ({ conversation: selected }) => createElement(
      "div",
      { "data-custom-huddle": selected.id },
      "Custom huddle status",
    ),
  }));
  const emptyMarkup = renderToStaticMarkup(workspace(createClient(createCache({
    organization: [],
    details: [],
  })), {
    components,
    conversationId: null,
  }));
  const eligibleDirectId = "conversation-workspace-eligible-direct";
  const eligibleDirect = directConversation(eligibleDirectId);
  const directCache = createCache({
    organization: [eligibleDirect],
    details: [eligibleDirect],
  });
  directCache.hydrateConversationDetail({
    ...detailSnapshot(eligibleDirect),
    conversation: {
      ...detailSnapshot(eligibleDirect).conversation,
      memberUserIds: [actorId, otherUserId],
    },
  });
  const directClient = {
    ...createClient(directCache),
    selectDirectoryUser: (userId) => userId === actorId
      ? actorDirectoryUser
      : userId === otherUserId
        ? directoryUser
        : undefined,
    hydrateDirectoryUsers: async () => ({
      status: "success",
      value: { users: [actorDirectoryUser, directoryUser] },
    }),
  };
  const directMarkup = renderToStaticMarkup(workspace(directClient, {
    components,
    conversationId: eligibleDirectId,
    currentUserId: actorId,
  }));
  const rendered = document.createElement("div");
  rendered.innerHTML = markup;
  const directRendered = document.createElement("div");
  directRendered.innerHTML = directMarkup;
  const customChannelHeader = rendered.querySelector("[data-custom-header]");
  const directHeader = directRendered.querySelector(".handrail-chat__header");
  const main = rendered.querySelector("main");

  assert.doesNotMatch(markup, /data-custom-avatar=/);
  assert.doesNotMatch(markup, /data-custom-user=/);
  assert.match(markup, new RegExp(`data-custom-header="${firstId}"`));
  assert.equal(customChannelHeader.dataset.customHeader, firstId);
  assert.equal(main.getAttribute("aria-labelledby"), customChannelHeader.id);
  assert.match(markup, new RegExp(`data-custom-huddle="${firstId}"`));
  assert.match(markup, /data-handrail-compact-layout="false"/);
  assert.match(directMarkup, /data-custom-avatar="Avery Example"/);
  assert.match(directMarkup, /data-custom-user="Avery Example"/);
  assert.doesNotMatch(directMarkup, /data-custom-avatar="Current User"/);
  assert.doesNotMatch(directMarkup, /data-custom-user="Current User"/);
  assert.doesNotMatch(directMarkup, /data-custom-header=/);
  assert.doesNotMatch(directHeader.textContent, /Direct conversation/);
  assert.match(emptyMarkup, /data-custom-empty="no_conversation"/);
  assert.doesNotMatch(markup, /tenant-workspace/);
});

test("default workspace timeline forwards normalized link previews and outer host props", () => {
  const cache = createCache();
  cache.hydrateMessageTimeline({
    conversationId: firstId,
    messages: [{
      id: "message-link-preview",
      tenantId,
      conversationId: firstId,
      author: { type: "user", userId: otherUserId },
      sequence: 1,
      createdAt: now,
      updatedAt: now,
      revision: { revision: 1 },
      content: {
        format: "plain",
        text: "Workspace preview",
        blocks: [{
          type: "link_preview",
          data: {
            url: " https://example.test/workspace ",
            title: " Workspace docs ",
            siteName: " Example ",
            privateToken: "never-forward",
          },
        }],
      },
      isThreadRoot: false,
      reactions: [],
      attachmentMetadata: [],
    }],
    pagination: { older: { available: false }, newer: { available: false } },
    replay: { resumeFrom: { eventId: "workspace-preview-event" } },
  });
  const seen = [];
  const LinkPreview = (props) => {
    seen.push(props);
    return createElement(
      "article",
      { ...props.hostProps, "data-workspace-link-preview": props.linkPreview.url },
      props.linkPreview.title,
    );
  };
  const client = {
    ...createClient(cache),
    getThreadOpeningState: (selectedRootMessageId) => ({
      state: "idle",
      rootMessageId: selectedRootMessageId,
    }),
    subscribeThreadOpening: () => () => undefined,
  };
  const markup = renderToStaticMarkup(workspace(client, {
    components: { LinkPreview },
    renderComposer: () => null,
    renderTimeline: undefined,
  }));

  assert.match(markup, /data-workspace-link-preview="https:\/\/example\.test\/workspace"/);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].linkPreview, {
    url: "https://example.test/workspace",
    title: "Workspace docs",
    siteName: "Example",
  });
  assert.equal(Object.isFrozen(seen[0].linkPreview), true);
  assert.equal("privateToken" in seen[0].linkPreview, false);
  assert.equal(seen[0].hostProps["aria-label"], "Link preview for Workspace docs");
});

test("timeline, composer, thread, and huddle remain explicit replaceable body surfaces", () => {
  const observed = [];
  const LinkPreview = () => null;
  const renderBody = (name) => (props) => {
    observed.push({ name, props });
    return createElement("div", { [`data-${name}`]: props.conversation.id });
  };
  const markup = renderToStaticMarkup(workspace(createClient(createCache()), {
    components: { LinkPreview },
    renderTimeline: renderBody("timeline"),
    renderComposer: renderBody("composer"),
    renderThread: renderBody("thread"),
    renderHuddle: renderBody("huddle"),
  }));

  for (const name of ["timeline", "composer", "thread", "huddle"]) {
    assert.match(markup, new RegExp(`data-${name}="${firstId}"`));
  }
  assert.deepEqual(observed.map(({ name }) => name).sort(), [
    "composer",
    "huddle",
    "thread",
    "timeline",
  ]);
  assert.equal(observed.every(({ props }) => !("tenantId" in props.conversation)), true);
  assert.equal(observed.every(({ props }) => typeof props.actions.sendMessage === "function"), true);
  assert.equal(observed.every(({ props }) => props.slots.LinkPreview === LinkPreview), true);
});

test("modal mode owns one root-local dialog and never creates an external portal", () => {
  const markup = renderToStaticMarkup(workspace(createClient(createCache()), {
    mode: "modal",
  }));
  assert.match(markup, /^<section /);
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /tabindex="-1"/);
  assert.equal(markup.match(/class="handrail-chat /g)?.length, 1);
  assert.doesNotMatch(markup, /<(?:html|body)/);
  assert.match(markup, /<nav[\s\S]*<main[\s\S]*<\/section>$/);
});

test("modal mode moves focus inside and wraps forward, backward, outside, and empty Tab attempts", async () => {
  const opener = document.createElement("button");
  opener.textContent = "Open chat";
  document.body.append(opener);
  opener.focus();

  const container = await renderWorkspace(workspace(createClient(createCache()), {
    mode: "modal",
  }));
  const root = container.querySelector('.handrail-chat--workspace[role="dialog"]');
  const initial = root.querySelector('input[name="conversationFilter"]');
  assert.equal(document.activeElement, initial);

  const focusable = [...root.querySelectorAll(
    "a[href], button, input:not([type='hidden']), select, textarea, [contenteditable], [tabindex]",
  )].filter((element) =>
    element !== root &&
    element.tabIndex >= 0 &&
    !element.matches(":disabled") &&
    element.closest("fieldset[disabled], [hidden], [inert], [aria-hidden='true']") === null
  );
  const first = focusable[0];
  const last = focusable.at(-1);
  assert.ok(first);
  assert.ok(last);

  last.focus();
  const forward = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
  });
  await act(async () => last.dispatchEvent(forward));
  assert.equal(forward.defaultPrevented, true);
  assert.equal(document.activeElement, first);

  const backward = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
    shiftKey: true,
  });
  await act(async () => first.dispatchEvent(backward));
  assert.equal(backward.defaultPrevented, true);
  assert.equal(document.activeElement, last);

  opener.focus();
  const outsideAttempt = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
  });
  await act(async () => root.dispatchEvent(outsideAttempt));
  assert.equal(outsideAttempt.defaultPrevented, true);
  assert.equal(document.activeElement, first);

  for (const element of focusable) {
    if ("disabled" in element) element.disabled = true;
    else element.setAttribute("tabindex", "-1");
  }
  opener.focus();
  const emptyAttempt = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
    shiftKey: true,
  });
  await act(async () => root.dispatchEvent(emptyAttempt));
  assert.equal(emptyAttempt.defaultPrevented, true);
  assert.equal(document.activeElement, root);

  opener.remove();
});

test("nested workspace dialogs keep Escape, focus containment, and restoration priority", async () => {
  let modalCloseRequests = 0;
  const container = await renderWorkspace(workspace(createClient(createCache()), {
    channelCreationAvailability: { canCreate: true },
    mode: "modal",
    onModalCloseRequest: () => { modalCloseRequests += 1; },
  }));
  const root = container.querySelector('.handrail-chat--workspace[role="dialog"]');
  const trigger = root.querySelector('button[aria-label="Add conversation"]');
  await click(trigger);
  const menuItem = [...root.querySelectorAll('[role="menuitem"]')]
    .find((candidate) => candidate.textContent === "Create channel");
  await click(menuItem);

  const dialog = root.querySelector(".handrail-chat__channel-creation-dialog");
  const nameInput = dialog.querySelector('input[name="channelName"]');
  const cancel = dialog.querySelector(".handrail-chat__channel-creation-cancel");
  assert.equal(document.activeElement, nameInput);

  const nestedBackward = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
    shiftKey: true,
  });
  await act(async () => nameInput.dispatchEvent(nestedBackward));
  assert.equal(nestedBackward.defaultPrevented, true);
  assert.equal(document.activeElement, cancel);

  const nestedEscape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => {
    dialog.dispatchEvent(nestedEscape);
    await flush();
  });
  assert.equal(nestedEscape.defaultPrevented, true);
  assert.equal(modalCloseRequests, 0);
  assert.equal(root.querySelector(".handrail-chat__channel-creation-dialog"), null);
  assert.equal(document.activeElement, trigger);

  const workspaceEscape = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Escape",
  });
  await act(async () => trigger.dispatchEvent(workspaceEscape));
  assert.equal(workspaceEscape.defaultPrevented, true);
  assert.equal(modalCloseRequests, 1);
});

test("modal focus returns when the host transitions to a non-modal mode", async () => {
  const client = createClient(createCache());
  const opener = document.createElement("button");
  opener.textContent = "Open modal chat";
  document.body.append(opener);
  opener.focus();

  const container = await renderWorkspace(workspace(client, { mode: "modal" }));
  const entry = mounted.find((candidate) => candidate.container === container);
  assert.notEqual(document.activeElement, opener);
  await act(async () => {
    entry.root.render(workspace(client, { mode: "side-panel" }));
    await flush();
  });
  assert.equal(document.activeElement, opener);

  opener.remove();
});

test("modal transition does not override focus intentionally moved outside", async () => {
  const client = createClient(createCache());
  const opener = document.createElement("button");
  const outside = document.createElement("button");
  document.body.append(opener, outside);
  opener.focus();

  const container = await renderWorkspace(workspace(client, { mode: "modal" }));
  const entry = mounted.find((candidate) => candidate.container === container);
  outside.focus();
  await act(async () => {
    entry.root.render(workspace(client, { mode: "record" }));
    await flush();
  });
  assert.equal(document.activeElement, outside);

  opener.remove();
  outside.remove();
});

test("modal focus returns when the host unmounts the workspace", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();

  const container = await renderWorkspace(workspace(createClient(createCache()), {
    mode: "modal",
  }));
  const entry = mounted.find((candidate) => candidate.container === container);
  await act(async () => entry.root.unmount());
  assert.equal(document.activeElement, opener);
  mounted.splice(mounted.indexOf(entry), 1);
  container.remove();
  opener.remove();
});

test("modal focus restoration safely ignores a disconnected opener", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const container = await renderWorkspace(workspace(createClient(createCache()), {
    mode: "modal",
  }));
  const entry = mounted.find((candidate) => candidate.container === container);
  opener.remove();
  await act(async () => entry.root.unmount());
  assert.equal(opener.isConnected, false);
  assert.notEqual(document.activeElement, opener);
  mounted.splice(mounted.indexOf(entry), 1);
  container.remove();
});

test("non-modal modes leave host focus and keyboard ownership unchanged", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  let closeRequests = 0;

  for (const mode of ["full-screen", "side-panel", "record"]) {
    opener.focus();
    const container = await renderWorkspace(workspace(createClient(createCache()), {
      mode,
      onModalCloseRequest: () => { closeRequests += 1; },
    }));
    const root = container.querySelector(".handrail-chat--workspace");
    assert.equal(document.activeElement, opener);
    assert.equal(root.hasAttribute("tabindex"), false);
    assert.equal(root.hasAttribute("role"), false);
    assert.equal(root.hasAttribute("aria-modal"), false);

    const filter = root.querySelector('input[name="conversationFilter"]');
    const tab = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });
    const escape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    await act(async () => {
      filter.dispatchEvent(tab);
      filter.dispatchEvent(escape);
    });
    assert.equal(tab.defaultPrevented, false);
    assert.equal(escape.defaultPrevented, false);
  }
  assert.equal(closeRequests, 0);
  opener.remove();
});
