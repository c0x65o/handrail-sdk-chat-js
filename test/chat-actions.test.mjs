import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const React = await import("react");
const { act, createElement } = React;
const { renderToString } = await import("react-dom/server");
const ReactTestRenderer = await import("react-test-renderer");
const { create } = ReactTestRenderer.default;
const {
  ChatContext,
  ChatProvider,
  useChatActions,
  useChatSelector,
} = await import("@handrail/chat/react");
const { createNormalizedChatCache } = await import("@handrail/chat/client");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const actionNames = [
  "sendMessage",
  "retryMessage",
  "forwardMessage",
  "editMessage",
  "deleteMessage",
  "setReaction",
  "createChannel",
  "createDirect",
  "createGroupDirect",
  "archiveConversation",
  "restoreConversation",
  "joinConversation",
  "leaveConversation",
  "addConversationMember",
  "removeConversationMember",
  "changeConversationMemberRole",
  "markRead",
  "markUnread",
  "openThread",
  "openConversationDraft",
  "replaceConversationDraft",
  "clearConversationDraft",
  "flushConversationDraft",
  "retryConversationDraft",
  "closeConversationDraft",
  "updateConversationPreference",
  "setThreadFollow",
  "followThread",
  "unfollowThread",
  "saveMessage",
  "unsaveMessage",
  "retrySavedMessage",
  "setMessageReminder",
  "cancelMessageReminder",
  "retryMessageReminder",
  "uploadAttachment",
  "startTyping",
  "stopTyping",
  "setPresence",
  "notifyActivity",
  "hydrateHuddle",
  "startHuddle",
  "joinHuddle",
  "leaveHuddle",
  "setHuddleScreenShare",
  "clearHuddleScreenShare",
  "endHuddle",
  "retryHuddle",
  "rejoinHuddle",
];

const synchronousActions = new Set([
  "replaceConversationDraft",
  "clearConversationDraft",
  "uploadAttachment",
  "startTyping",
  "stopTyping",
  "setPresence",
  "notifyActivity",
]);

const createClientFixture = () => {
  const cache = createNormalizedChatCache();
  const calls = [];
  const returns = {};
  const client = {
    endpoint: "/chat",
    state: Object.freeze({ state: "idle" }),
    cache,
  };

  for (const name of actionNames) {
    if (name === "startTyping") returns[name] = true;
    else if (name === "stopTyping" || name === "setPresence" || name === "notifyActivity") {
      returns[name] = undefined;
    } else if (name === "uploadAttachment") {
      returns[name] = Object.freeze({
        uploadId: "upload-1",
        state: Object.freeze({ status: "preparing" }),
        completion: Promise.resolve(Object.freeze({ status: "cancelled" })),
        cancel() {},
      });
    } else if (synchronousActions.has(name)) {
      returns[name] = Object.freeze({ method: name, synchronous: true });
    } else {
      returns[name] = Promise.resolve(Object.freeze({ method: name }));
    }
    client[name] = (...args) => {
      calls.push({ name, args });
      return returns[name];
    };
  }

  client.start = () => Promise.resolve(client.state);
  client.subscribeLifecycle = () => () => undefined;
  client.close = () => undefined;
  return { cache, calls, client, returns };
};

const captureActions = async (client, conversationId) => {
  const values = [];
  const Capture = () => {
    values.push(useChatActions(conversationId));
    return null;
  };
  let renderer;
  await act(async () => {
    renderer = create(
      createElement(ChatProvider, { client }, createElement(Capture)),
    );
  });
  return { actions: values.at(-1), renderer, values };
};

test("every action delegates exact arguments once and preserves its client result", async () => {
  const fixture = createClientFixture();
  const conversationId = "conversation-bound";
  const { actions, renderer } = await captureActions(fixture.client, conversationId);
  const content = { format: "plain_text", text: "hello", attachments: [] };
  const source = new ArrayBuffer(4);
  const metadata = { fileName: "proof.txt", mediaType: "text/plain", size: 4 };
  const cases = [
    ["sendMessage", [{ content }], [{ conversationId, content }]],
    ["retryMessage", ["client-message-1"], ["client-message-1"]],
    ["forwardMessage", ["source-message-elsewhere"], [{
      sourceMessageId: "source-message-elsewhere",
      destinationConversationId: conversationId,
    }]],
    ["editMessage", [{ messageId: "message-1", expectedRevision: 2, content }]],
    ["deleteMessage", [{ messageId: "message-1", expectedRevision: 3 }]],
    ["setReaction", [{ messageId: "message-1", reactionKey: "thumbs_up", reacted: true }]],
    ["createChannel", [{ name: "General", visibility: "public" }]],
    ["createDirect", [{ participantUserId: "user-2" }]],
    ["createGroupDirect", [{ participantUserIds: ["user-2", "user-3"] }]],
    ["archiveConversation", [{ expectedLifecycleRevision: 4 }], [{ conversationId, expectedLifecycleRevision: 4 }]],
    ["restoreConversation", [{ expectedLifecycleRevision: 5 }], [{ conversationId, expectedLifecycleRevision: 5 }]],
    ["joinConversation", [{ expectedMemberListRevision: 6 }], [{ conversationId, expectedMemberListRevision: 6 }]],
    ["leaveConversation", [{ expectedMemberListRevision: 7 }], [{ conversationId, expectedMemberListRevision: 7 }]],
    ["addConversationMember", [{ expectedMemberListRevision: 8, targetUserId: "user-2", requestedRole: "member" }], [{ conversationId, expectedMemberListRevision: 8, targetUserId: "user-2", requestedRole: "member" }]],
    ["removeConversationMember", [{ expectedMemberListRevision: 9, targetUserId: "user-2" }], [{ conversationId, expectedMemberListRevision: 9, targetUserId: "user-2" }]],
    ["changeConversationMemberRole", [{ expectedMemberListRevision: 10, targetUserId: "user-2", requestedRole: "moderator" }], [{ conversationId, expectedMemberListRevision: 10, targetUserId: "user-2", requestedRole: "moderator" }]],
    ["markRead", [{ throughSequence: 11 }], [{ conversationId, throughSequence: 11 }]],
    ["markUnread", [{ fromSequence: 12 }], [{ conversationId, fromSequence: 12 }]],
    ["openThread", ["root-message-1"]],
    ["openConversationDraft", [], [conversationId]],
    ["replaceConversationDraft", [{ content }], [{ conversationId, content }]],
    ["clearConversationDraft", [], [conversationId]],
    ["flushConversationDraft", [], [conversationId]],
    ["retryConversationDraft", [], [conversationId]],
    ["closeConversationDraft", [{ policy: "abort" }], [conversationId, { policy: "abort" }]],
    ["updateConversationPreference", [{ notificationPreference: "mentions", mute: { state: "unmuted" } }], [{ conversationId, notificationPreference: "mentions", mute: { state: "unmuted" } }]],
    ["setThreadFollow", [{ intent: "follow" }], [{ threadId: conversationId, intent: "follow" }]],
    ["followThread", [], [conversationId]],
    ["unfollowThread", [], [conversationId]],
    ["saveMessage", [{ messageId: "message-1", privateNote: "Later" }]],
    ["unsaveMessage", [{ messageId: "message-1" }]],
    ["retrySavedMessage", ["message-1"]],
    ["setMessageReminder", [{ messageId: "message-1", dueAt: "2099-01-02T12:00:00.000Z" }], [{ conversationId, messageId: "message-1", dueAt: "2099-01-02T12:00:00.000Z" }]],
    ["cancelMessageReminder", ["message-1"], [{ conversationId, messageId: "message-1" }]],
    ["retryMessageReminder", ["message-1"]],
    ["uploadAttachment", [{ metadata, source }], [{ conversationId, metadata, source }]],
    ["startTyping", ["private"], [conversationId, "private"]],
    ["stopTyping", [], [conversationId]],
    ["setPresence", ["away"]],
    ["notifyActivity", []],
    ["hydrateHuddle", [], [conversationId]],
    ["startHuddle", [], [conversationId]],
    ["joinHuddle", [], [conversationId]],
    ["leaveHuddle", [], [conversationId]],
    ["setHuddleScreenShare", [], [conversationId]],
    ["clearHuddleScreenShare", [], [conversationId]],
    ["endHuddle", [], [conversationId]],
    ["retryHuddle", [], [conversationId]],
    ["rejoinHuddle", [], [conversationId]],
  ];

  assert.deepEqual(Object.keys(actions), actionNames);
  for (const [name, args, expectedArgs = args] of cases) {
    const before = fixture.calls.length;
    const result = actions[name](...args);
    assert.equal(result, fixture.returns[name], `${name} must preserve its return value`);
    assert.equal(fixture.calls.length, before + 1, `${name} must delegate once`);
    assert.deepEqual(fixture.calls.at(-1), { name, args: expectedArgs });
  }
  assert.deepEqual(cases.map(([name]) => name), actionNames);

  await act(async () => renderer.unmount());
});

test("missing provider and bound conversation failures are synchronous and safe", async () => {
  const Outside = () => {
    useChatActions();
    return null;
  };
  assert.throws(
    () => renderToString(createElement(Outside)),
    /useChatActions must be used inside ChatProvider/,
  );

  const fixture = createClientFixture();
  const { actions, renderer } = await captureActions(fixture.client);
  const boundActions = [
    "sendMessage", "forwardMessage", "archiveConversation", "restoreConversation",
    "joinConversation", "leaveConversation", "addConversationMember",
    "removeConversationMember", "changeConversationMemberRole", "markRead",
    "markUnread", "openConversationDraft", "replaceConversationDraft",
    "clearConversationDraft", "flushConversationDraft", "retryConversationDraft",
    "closeConversationDraft", "updateConversationPreference", "setThreadFollow",
    "followThread", "unfollowThread", "setMessageReminder", "cancelMessageReminder",
    "uploadAttachment", "startTyping",
    "stopTyping", "hydrateHuddle", "startHuddle", "joinHuddle", "leaveHuddle",
    "setHuddleScreenShare", "clearHuddleScreenShare", "endHuddle",
    "retryHuddle", "rejoinHuddle",
  ];

  for (const name of boundActions) {
    assert.throws(
      () => actions[name]({}),
      new RegExp(`useChatActions\\.${name} requires a conversationId`),
    );
  }
  assert.equal(fixture.calls.length, 0);

  await act(async () => renderer.unmount());
});

test("action objects and callbacks stay stable across provider and cache rerenders", async () => {
  const fixture = createClientFixture();
  const values = [];
  const selectIdentity = (state) => state.identity;
  const Capture = ({ conversationId }) => {
    useChatSelector(selectIdentity);
    values.push(useChatActions(conversationId));
    return null;
  };
  let renderer;

  await act(async () => {
    renderer = create(createElement(
      ChatProvider,
      { client: fixture.client },
      createElement(Capture, { conversationId: "conversation-1" }),
    ));
  });
  const initial = values.at(-1);
  assert.equal(Object.isFrozen(initial), true);

  await act(async () => {
    fixture.cache.setIdentity({ tenantId: "tenant-1", userId: "user-1", sessionId: "session-1" });
  });
  assert.equal(values.at(-1), initial);
  for (const name of actionNames) assert.equal(values.at(-1)[name], initial[name]);

  await act(async () => {
    renderer.update(createElement(
      ChatProvider,
      { client: fixture.client },
      createElement(Capture, { conversationId: "conversation-1" }),
    ));
  });
  assert.equal(values.at(-1), initial);

  await act(async () => {
    renderer.update(createElement(
      ChatProvider,
      { client: fixture.client },
      createElement(Capture, { conversationId: "conversation-2" }),
    ));
  });
  const rebound = values.at(-1);
  assert.notEqual(rebound, initial);
  for (const name of actionNames) assert.notEqual(rebound[name], initial[name]);

  await act(async () => renderer.unmount());

  const secondFixture = createClientFixture();
  const clientValues = [];
  const ClientCapture = () => {
    clientValues.push(useChatActions("conversation-1"));
    return null;
  };
  const contextValue = (client) => ({
    client,
    state: client.state,
    readiness: "not_ready",
    isReady: false,
    refreshRequired: null,
    error: null,
  });
  await act(async () => {
    renderer = create(createElement(
      ChatContext.Provider,
      { value: contextValue(fixture.client) },
      createElement(ClientCapture),
    ));
  });
  const firstClientActions = clientValues.at(-1);
  await act(async () => {
    renderer.update(createElement(
      ChatContext.Provider,
      { value: contextValue(secondFixture.client) },
      createElement(ClientCapture),
    ));
  });
  const secondClientActions = clientValues.at(-1);
  assert.notEqual(secondClientActions, firstClientActions);
  for (const name of actionNames) {
    assert.notEqual(secondClientActions[name], firstClientActions[name]);
  }
  await act(async () => renderer.unmount());
});

test("omitted optional callback arguments are not synthesized", async () => {
  const fixture = createClientFixture();
  const { actions, renderer } = await captureActions(fixture.client, "conversation-1");

  actions.startTyping();
  actions.closeConversationDraft();
  assert.deepEqual(fixture.calls.slice(-2), [
    { name: "startTyping", args: ["conversation-1"] },
    { name: "closeConversationDraft", args: ["conversation-1"] },
  ]);

  await act(async () => renderer.unmount());
});
