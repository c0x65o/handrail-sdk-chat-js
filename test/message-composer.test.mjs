import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

const { Window } = await import("happy-dom");
const window = new Window({ url: "https://chat.test/" });
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  File: window.File,
  Blob: window.Blob,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  Node: window.Node,
  PointerEvent: window.PointerEvent,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const textareaScrollHeights = new WeakMap();
Object.defineProperty(window.HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get() {
    const explicit = textareaScrollHeights.get(this);
    if (explicit?.value === this.value) return explicit.height;
    return 40 + Math.max(0, this.value.split("\n").length - 1) * 24;
  },
});
const nativeGetComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(window, "getComputedStyle", {
  configurable: true,
  value(element) {
    const computed = nativeGetComputedStyle(element);
    if (element instanceof window.HTMLTextAreaElement) {
      Object.defineProperty(computed, "maxBlockSize", {
        configurable: true,
        value: "144px",
      });
    }
    return computed;
  },
});

const resizeObservers = [];
class TestResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = new Set();
    this.disconnected = false;
    resizeObservers.push(this);
  }

  observe(element) {
    this.observed.add(element);
  }

  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }

  trigger() {
    this.callback([], this);
  }
}
window.ResizeObserver = TestResizeObserver;

const React = await import("react");
const { act, createElement } = React;
const { createRoot } = await import("react-dom/client");
const buildRoot = process.env.HANDRAIL_COMPOSER_BUILD ?? new URL("../dist/", import.meta.url).href;
const { ChatProvider } = await import(`${buildRoot}react/index.js`);
const { createNormalizedChatCache } = await import(`${buildRoot}client/index.js`);
const { MessageComposer, DefaultMessageComposerRenderer, DefaultMessageRenderer } = await import(`${buildRoot}ui/index.js`);

const conversationId = "conversation-composer";
const tenantId = "tenant-composer";
const userId = "user-composer";
const now = "2035-01-02T03:04:05.000Z";
const safeConversation = Object.freeze({
  id: conversationId,
  type: "channel",
  name: "Composer tests",
  visibility: "public",
  createdAt: now,
  updatedAt: now,
});
const participantUser = (id, displayName) => Object.freeze({
  kind: "active",
  userId: id,
  displayName,
  avatar: Object.freeze({ kind: "none" }),
});
const conversationSnapshotMetadata = Object.freeze({
  packageVersion: "0.1.46",
  protocolVersion: 4,
  schemaVersion: 1,
  enabledFeatures: Object.freeze({}),
  supportedProtocolRange: Object.freeze({ minimumVersion: 4, maximumVersion: 4 }),
  feature: Object.freeze({ name: "conversation_snapshots", version: 1 }),
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const draftContent = (
  text = "Restored draft",
  format = "plain",
  attachments = [],
  mentions,
) => Object.freeze({
  format,
  text,
  ...(mentions === undefined ? {} : { mentions: Object.freeze(mentions) }),
  attachments: Object.freeze(attachments),
});

const createFixture = ({
  initialDraft = draftContent(),
  state = Object.freeze({ state: "ready" }),
  conversation = safeConversation,
  participantUsers,
} = {}) => {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: "session-composer",
  });
  const directory = new Map((participantUsers ?? []).map((user) => [user.userId, user]));
  if (participantUsers !== undefined) {
    const canonicalConversation = {
      ...conversation,
      tenantId,
      visibility: conversation.type === "channel" ? conversation.visibility : "private",
      activityAt: now,
      latestSequence: 0,
      unreadMentionCount: 0,
      activeMemberUserIds: participantUsers.map(({ userId: id }) => id),
      currentMember: {
        tenantId,
        conversationId: conversation.id,
        userId,
        role: "member",
        state: "active",
        joinedAt: now,
        updatedAt: now,
      },
      currentReadState: {
        conversationId: conversation.id,
        userId,
        lastReadSequence: 0,
        updatedAt: now,
      },
      currentPreference: {
        conversationId: conversation.id,
        userId,
        notificationPreference: "all",
        mute: { muted: false },
        updatedAt: now,
      },
    };
    cache.hydrateConversationList({
      kind: "conversation_list",
      scope: { type: "organization" },
      items: [canonicalConversation],
      page: {},
      _meta: conversationSnapshotMetadata,
    });
  }
  const calls = [];
  const draftListeners = new Set();
  const sendResults = [];
  const retryResults = [];
  const uploads = new Map();
  let draft = Object.freeze({
    conversationId,
    status: "ready",
    authoritativeRevision: initialDraft == null ? 0 : 1,
    dirty: false,
    ...(initialDraft == null
      ? {}
      : { draft: Object.freeze({ kind: "replaced", content: initialDraft }) }),
  });
  const publishDraft = (next) => {
    const previous = draft;
    draft = Object.freeze(next);
    for (const listener of draftListeners) listener(draft, previous);
  };
  const clearDraft = () => {
    calls.push({ name: "clearConversationDraft", args: [conversationId] });
    publishDraft({
      conversationId,
      status: "debouncing",
      authoritativeRevision: draft.authoritativeRevision,
      dirty: true,
      draft: Object.freeze({ kind: "clear_tombstone", content: null }),
    });
    return draft;
  };
  const sourceStates = new Map();
  const sourceListeners = new Map();
  const publishSource = (target, state) => {
    const key = JSON.stringify(target);
    sourceStates.set(key, Object.freeze({ ...target, ...state }));
    for (const listener of sourceListeners.get(key) ?? []) listener();
  };
  const sourceSnapshot = (target) => {
    const key = JSON.stringify(target);
    if (!sourceStates.has(key)) sourceStates.set(key, Object.freeze({ ...target, status: "idle" }));
    return sourceStates.get(key);
  };
  const client = {
    messageContext: {
      getState: sourceSnapshot,
      subscribe(target, listener) {
        const key = JSON.stringify(target);
        if (!sourceListeners.has(key)) sourceListeners.set(key, new Set());
        sourceListeners.get(key).add(listener);
        return () => sourceListeners.get(key).delete(listener);
      },
      async resolve(target) {
        calls.push({ name: "resolveSource", args: [target] });
        publishSource(target, { status: "loading" });
        return sourceSnapshot(target);
      },
      async retry(target) {
        calls.push({ name: "retrySource", args: [target] });
        publishSource(target, { status: "loading" });
        return sourceSnapshot(target);
      },
    },
    endpoint: "/chat",
    state,
    cache,
    start: async () => state,
    close() {},
    subscribeLifecycle() {
      return () => {};
    },
    selectDirectoryUser: (id) => directory.get(id),
    async hydrateDirectoryUsers(ids) {
      return {
        status: "success",
        value: { users: ids.flatMap((id) => directory.get(id) ?? []) },
      };
    },
    getConversation: async () => ({
      status: "validation",
      message: "The snapshot query input is invalid.",
    }),
    getMessageTimeline: async () => ({
      status: "validation",
      message: "The snapshot query input is invalid.",
    }),
    selectConversationDraft: () => draft,
    subscribeConversationDraft(_id, listener) {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    openConversationDraft: async () => draft,
    replaceConversationDraft(input) {
      calls.push({ name: "replaceConversationDraft", args: [input] });
      publishDraft({
        conversationId,
        status: "debouncing",
        authoritativeRevision: draft.authoritativeRevision,
        dirty: true,
        draft: Object.freeze({ kind: "replaced", content: input.content }),
      });
      return draft;
    },
    clearConversationDraft: clearDraft,
    flushConversationDraft: async () => ({ status: "success", state: draft }),
    retryConversationDraft: async () => {
      calls.push({ name: "retryConversationDraft", args: [conversationId] });
      publishDraft({ ...draft, status: "ready", dirty: false, message: undefined });
      return { status: "success", state: draft };
    },
    closeConversationDraft: async () => ({ status: "success", state: draft }),
    startTyping(id) {
      calls.push({ name: "startTyping", args: [id] });
      return true;
    },
    stopTyping(id) {
      calls.push({ name: "stopTyping", args: [id] });
    },
    uploadAttachment(input) {
      calls.push({ name: "uploadAttachment", args: [input] });
      const completion = deferred();
      const uploadId = `upload-${uploads.size + 1}`;
      const initial = Object.freeze({
        uploadId,
        conversationId,
        metadata: input.metadata,
        status: "preparing",
        progress: Object.freeze({ uploadedBytes: 0, totalBytes: input.metadata.sizeBytes }),
      });
      cache.setAttachmentUploadState(initial);
      const record = {
        completion,
        input,
        cancel() {
          calls.push({ name: "cancelUpload", args: [uploadId] });
          cache.setAttachmentUploadState({ ...initial, status: "cancelled" });
          completion.resolve({ status: "cancelled" });
        },
        progress(uploadedBytes) {
          const attachment = Object.freeze({
            attachmentId: `attachment-${uploadId}`,
            metadata: input.metadata,
            status: "pending",
            createdAt: now,
            expiresAt: "2035-01-03T03:04:05.000Z",
          });
          cache.setAttachmentUploadState({
            ...initial,
            status: "uploading",
            progress: { uploadedBytes, totalBytes: input.metadata.sizeBytes },
            attachment,
          });
        },
        finalize(attachmentId) {
          const attachment = Object.freeze({
            attachmentId,
            metadata: input.metadata,
            status: "finalized",
            checksum: `sha256:${"a".repeat(64)}`,
            createdAt: now,
            expiresAt: "2035-01-03T03:04:05.000Z",
            finalizedAt: now,
          });
          cache.setAttachmentUploadState({
            ...initial,
            status: "finalized",
            progress: {
              uploadedBytes: input.metadata.sizeBytes,
              totalBytes: input.metadata.sizeBytes,
            },
            attachment,
          });
          completion.resolve({ status: "finalized", attachment });
        },
      };
      uploads.set(uploadId, record);
      return Object.freeze({
        uploadId,
        state: initial,
        completion: completion.promise,
        cancel: () => record.cancel(),
      });
    },
    async sendMessage(input) {
      const beforeDraft = draft.draft;
      calls.push({ name: "sendMessage", args: [input] });
      const pending = sendResults.shift() ?? Promise.resolve({ status: "success", value: {} });
      const clientMessageId = `client-message-${calls.filter(({ name }) => name === "sendMessage").length}`;
      cache.insertOptimisticMessage(Object.freeze({
        id: `optimistic:${clientMessageId}`,
        tenantId,
        conversationId: input.conversationId,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        author: Object.freeze({ type: "user", userId }),
        sequence: 1,
        createdAt: now,
        updatedAt: now,
        revision: Object.freeze({ revision: 1 }),
        content: input.content,
        isThreadRoot: false,
        reactions: Object.freeze([]),
        attachmentMetadata: Object.freeze([]),
        delivery: Object.freeze({
          state: "sending",
          clientMessageId,
          idempotencyKey: `send-${clientMessageId}`,
          retryable: false,
          attempt: 1,
        }),
      }));
      const result = await pending;
      if (result.status === "success") {
        if (draft.draft === beforeDraft) clearDraft();
      }
      else cache.failOptimisticMessage(clientMessageId, result.status, result.status !== "rejected");
      return result;
    },
    async retryMessage(clientMessageId) {
      calls.push({ name: "retryMessage", args: [clientMessageId] });
      const result = await (retryResults.shift() ?? Promise.resolve({ status: "success", value: {} }));
      if (result.status !== "success") {
        cache.failOptimisticMessage(clientMessageId, result.status, result.status !== "rejected");
      }
      return result;
    },
  };
  return {
    cache,
    calls,
    client,
    conversation,
    uploads,
    publishSource,
    getDraft: () => draft.draft,
    queueSend(result) { sendResults.push(result); },
    queueRetry(result) { retryResults.push(result); },
    setDraft(next) { publishDraft(next); },
  };
};

const renderComposer = async (fixture, props = {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let currentProps = props;
  const render = async () => act(async () => {
    root.render(createElement(
      ChatProvider,
      { client: fixture.client },
      createElement(MessageComposer, {
        conversationId,
        conversation: fixture.conversation ?? safeConversation,
        ...currentProps,
      }),
    ));
    await flush();
  });
  await render();
  return {
    container,
    root,
    textarea: () => container.querySelector('textarea[aria-label="Message"]'),
    editor: () => container.querySelector('[role="textbox"][contenteditable]'),
    async rerender(nextProps) {
      currentProps = { ...currentProps, ...nextProps };
      await render();
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

const editorNodeLength = (node) => {
  if (node.nodeType === window.Node.TEXT_NODE) return node.nodeValue.length;
  if (node.nodeType !== window.Node.ELEMENT_NODE) return 0;
  if (node.tagName.toLowerCase() === "br") return 1;
  return [...node.childNodes].reduce((length, child) => length + editorNodeLength(child), 0);
};

const editorBlocks = (editor) => [...editor.childNodes].flatMap((child) =>
  child.nodeType === window.Node.ELEMENT_NODE && ["ol", "ul"].includes(child.tagName.toLowerCase())
    ? [...child.children]
    : [child]);

const editorPointWithin = (node, offset) => {
  if (node.nodeType === window.Node.TEXT_NODE) {
    return [node, Math.max(0, Math.min(offset, node.nodeValue.length))];
  }
  let position = 0;
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes[index];
    const length = editorNodeLength(child);
    if (offset <= position + length) {
      if (child.nodeType === window.Node.ELEMENT_NODE && child.tagName.toLowerCase() === "br") {
        return [node, offset === position ? index : index + 1];
      }
      return editorPointWithin(child, offset - position);
    }
    position += length;
  }
  return [node, node.childNodes.length];
};

const editorPointAt = (editor, offset) => {
  const blocks = editorBlocks(editor);
  let position = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (index > 0) position += 1;
    const length = editorNodeLength(block);
    if (offset <= position + length) return editorPointWithin(block, offset - position);
    position += length;
  }
  return [editor, editor.childNodes.length];
};

const selectEditorText = (editor, start, end = start) => {
  const range = document.createRange();
  range.setStart(...editorPointAt(editor, start));
  range.setEnd(...editorPointAt(editor, end));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  editor.focus();
  editor.dispatchEvent(new window.Event("select", { bubbles: true }));
};

const inputText = async (element, value, scrollHeight) => {
  if (scrollHeight !== undefined) {
    textareaScrollHeights.set(element, { value, height: scrollHeight });
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(element, value);
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
    await flush();
  });
};

const inputRichText = async (editor, value) => {
  await act(async () => {
    editor.textContent = value;
    selectEditorText(editor, value.length);
    editor.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
    await flush();
  });
};

const typeRichTextAtSelection = async (editor, value) => {
  const events = [];
  for (const character of value) {
    await act(async () => {
      editor.dispatchEvent(new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: character,
      }));
      const beforeInput = new window.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: character,
      });
      editor.dispatchEvent(beforeInput);
      events.push({ type: "beforeinput", data: character, prevented: beforeInput.defaultPrevented });
      if (!beforeInput.defaultPrevented) {
        const selection = window.getSelection();
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const text = document.createTextNode(character);
        range.insertNode(text);
        range.setStartAfter(text);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor.dispatchEvent(new window.InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: character,
        }));
        events.push({ type: "input", data: character });
      }
      editor.dispatchEvent(new window.KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: character,
      }));
      await flush();
    });
  }
  return events;
};

const inputValue = async (element, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(element, value);
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
    await flush();
  });
};

const clickElement = async (element) => {
  assert.ok(element);
  await act(async () => {
    element.click();
    await flush();
  });
};

const keyDownElement = async (element, key, options = {}) => {
  assert.ok(element);
  const event = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    ...options,
  });
  await act(async () => {
    element.dispatchEvent(event);
    await flush();
  });
  return event;
};

const pointerDownElement = async (element) => {
  assert.ok(element);
  const event = new window.PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
  });
  await act(async () => {
    element.dispatchEvent(event);
    await flush();
  });
  return event;
};

const pasteItems = async (element, items) => {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: Object.freeze({ items: Object.freeze(items) }),
  });
  await act(async () => {
    element.dispatchEvent(event);
    await flush();
  });
  return event;
};

test("renders one compact editor surface with accessible tools and feedback", async () => {
  const view = await renderComposer(createFixture({ initialDraft: null }));
  const composer = view.container.querySelector("form.handrail-chat__composer");
  const textarea = view.textarea();
  const editor = view.editor();
  const formattingLabels = [
    "Bold",
    "Italic",
    "Strikethrough",
    "Insert link",
    "Ordered list",
    "Bulleted list",
    "Inline code",
    "Code block",
  ];
  const emoji = composer.querySelector('button[aria-label="Choose emoji"]');
  const mention = composer.querySelector('button[aria-label="Mention a participant"]');
  const attachments = composer.querySelector('input[type="file"][aria-label="Attach files"]');
  const toolbar = composer.querySelector('[role="toolbar"][aria-label="Message tools"]');
  const formattingToolbar = composer.querySelector(
    '[role="toolbar"][aria-label="Text formatting"]',
  );
  const send = composer.querySelector('button[type="submit"][aria-label="Send message"]');

  assert.ok(composer);
  assert.equal(composer.querySelector(".handrail-chat__composer"), null);
  assert.equal(Number(textarea.rows), 1);
  assert.equal(textarea.style.height, "40px");
  assert.equal(textarea.style.overflowY, "hidden");
  assert.equal(textarea.hidden, true);
  assert.equal(textarea.getAttribute("aria-hidden"), "true");
  assert.equal(editor.getAttribute("aria-label"), "Message");
  assert.equal(editor.getAttribute("aria-multiline"), "true");
  assert.ok(toolbar);
  assert.ok(formattingToolbar);
  assert.deepEqual(
    [...formattingToolbar.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label")),
    formattingLabels,
  );
  for (const formattingLabel of formattingLabels) {
    const control = formattingToolbar.querySelector(
      `button[aria-label="${formattingLabel}"]`,
    );
    assert.equal(control.type, "button");
    assert.equal(control.title, formattingLabel);
    assert.ok(control.querySelector('svg[aria-hidden="true"]'));
  }
  assert.equal(composer.querySelector('[aria-label="Markdown formatting"]'), null);
  assert.doesNotMatch(formattingToolbar.textContent, /MD/);
  const attachmentAction = attachments.closest("label");
  for (const [action, icon] of [
    [attachmentAction, "attachment"],
    [emoji, "emoji"],
    [mention, "mention"],
  ]) {
    assert.ok(action.classList.contains("handrail-chat__composer-action"));
    const svg = action.querySelector(
      `svg[data-composer-action-icon="${icon}"][aria-hidden="true"]`,
    );
    assert.ok(svg, `missing decorative ${icon} SVG`);
    assert.equal(svg.getAttribute("focusable"), "false");
  }
  assert.doesNotMatch(toolbar.textContent, /[+☺@]/u);
  assert.equal(attachmentAction.title, "Attach files");
  assert.equal(emoji.type, "button");
  assert.equal(emoji.getAttribute("aria-expanded"), "false");
  assert.equal(emoji.getAttribute("aria-haspopup"), "dialog");
  assert.equal(emoji.title, "Choose emoji");
  assert.equal(mention.type, "button");
  assert.equal(mention.getAttribute("aria-expanded"), "false");
  assert.equal(mention.getAttribute("aria-haspopup"), "listbox");
  assert.equal(mention.title, "Mention a participant");
  assert.equal(attachments.multiple, true);
  assert.match(attachments.accept, /image\/png/);
  assert.equal(composer.querySelector('[role="status"][aria-live="polite"]'), null);
  assert.equal(composer.querySelector(".handrail-chat__composer-feedback"), null);
  assert.ok(send);

  await view.unmount();
});

test("opens the emoji picker by pointer and keyboard and inserts at selection or caret", async () => {
  const fixture = createFixture({ initialDraft: draftContent("hello world") });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  const editor = view.editor();
  const emojiTrigger = view.container.querySelector('button[aria-label="Choose emoji"]');

  selectEditorText(editor, 6, 11);
  await clickElement(emojiTrigger);
  let dialog = view.container.querySelector('[role="dialog"][aria-label="Choose emoji"]');
  assert.ok(dialog);
  assert.equal(emojiTrigger.getAttribute("aria-expanded"), "true");
  assert.equal(dialog.querySelector("h2")?.textContent, "Choose emoji");
  assert.ok(dialog.querySelector('input[aria-label="Search emoji"]'));
  assert.ok(dialog.querySelector('nav[aria-label="Emoji categories"]'));
  assert.ok(dialog.querySelector('button[aria-label="All emoji"]'));
  assert.ok(dialog.querySelector('button[aria-label="Close emoji picker"]'));

  const search = dialog.querySelector('input[aria-label="Search emoji"]');
  await inputValue(search, "rocket");
  assert.equal(
    dialog.querySelector('[role="grid"]')?.getAttribute("aria-label"),
    "Emoji search results for rocket",
  );
  await clickElement(dialog.querySelector('button[data-reaction-key="🚀"]'));
  assert.equal(textarea.value, "hello 🚀");
  assert.equal(editor.textContent, "hello 🚀");
  assert.equal(document.activeElement, editor);
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "replaceConversationDraft").at(-1)
      .args[0].content,
    { format: "plain", text: "hello 🚀", attachments: [] },
  );

  selectEditorText(editor, 0);
  emojiTrigger.focus();
  const keyboardOpen = await keyDownElement(emojiTrigger, "Enter");
  assert.equal(keyboardOpen.defaultPrevented, true);
  dialog = view.container.querySelector('[role="dialog"][aria-label="Choose emoji"]');
  assert.ok(dialog);
  await inputValue(dialog.querySelector('input[aria-label="Search emoji"]'), "coffee");
  await clickElement(dialog.querySelector('button[data-reaction-key="☕"]'));
  assert.equal(textarea.value, "☕hello 🚀");
  assert.equal(editor.textContent, "☕hello 🚀");
  assert.equal(document.activeElement, editor);

  await view.unmount();
});

test("dismisses the composer emoji picker without leaking across conversations", async () => {
  const fixture = createFixture({ initialDraft: draftContent("keep") });
  const view = await renderComposer(fixture);
  const editor = view.editor();
  const open = async () => clickElement(
    view.container.querySelector('button[aria-label="Choose emoji"]'),
  );

  await open();
  await keyDownElement(
    view.container.querySelector('input[aria-label="Search emoji"]'),
    "Escape",
  );
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, editor);

  await open();
  await clickElement(view.container.querySelector('button[aria-label="Close emoji picker"]'));
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, editor);

  await open();
  await pointerDownElement(view.container.querySelector('button[type="submit"]'));
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, editor);

  await open();
  const staleEmojiButton = view.container.querySelector('button[data-reaction-key="😀"]');
  const replacementCount = fixture.calls.filter(
    ({ name }) => name === "replaceConversationDraft",
  ).length;
  const nextConversationId = "conversation-composer-next";
  await view.rerender({
    conversationId: nextConversationId,
    conversation: { ...safeConversation, id: nextConversationId, name: "Next conversation" },
  });
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  await clickElement(staleEmojiButton);
  assert.equal(view.textarea().value, "keep");
  assert.equal(
    fixture.calls.filter(({ name }) => name === "replaceConversationDraft").length,
    replacementCount,
  );

  await view.unmount();
});

test("keeps the emoji picker inert for disabled and read-only composers", async () => {
  for (const props of [{ disabled: true }, { readOnly: true }]) {
    const fixture = createFixture({ initialDraft: draftContent("unchanged") });
    const view = await renderComposer(fixture, props);
    const trigger = view.container.querySelector('button[aria-label="Choose emoji"]');
    assert.equal(trigger.disabled, true);
    await clickElement(trigger);
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(view.textarea().value, "unchanged");
    assert.equal(
      fixture.calls.some(({ name }) => name === "replaceConversationDraft"),
      false,
    );
    await view.unmount();
  }
});

test("projects channel, direct, and group participants without exposing membership identities", async () => {
  for (const type of ["channel", "direct", "group_direct"]) {
    const conversation = Object.freeze({
      id: conversationId,
      type,
      ...(type === "channel" ? { name: "Mention room", visibility: "public" } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const participants = [
      participantUser(`participant-${type}-alice`, "Alice Nguyen"),
      Object.freeze({ kind: "redacted", userId: `participant-${type}-hidden` }),
      Object.freeze({
        kind: "unavailable",
        userId: `participant-${type}-missing`,
        reason: "temporarily_unavailable",
      }),
    ];
    let slotProps;
    const fixture = createFixture({
      initialDraft: null,
      conversation,
      participantUsers: participants,
    });
    const view = await renderComposer(fixture, {
      components: {
        Composer(props) {
          slotProps = props;
          return createElement("div", { "data-participants": true });
        },
      },
    });
    assert.deepEqual(
      slotProps.state.mentionParticipants.map(({ label, state, selectable }) => ({
        label,
        state,
        selectable,
      })),
      [
        { label: "Alice Nguyen", state: "active", selectable: true },
        { label: "Hidden user", state: "redacted", selectable: false },
        { label: "Unavailable user", state: "unavailable", selectable: false },
      ],
    );
    const serialized = JSON.stringify(slotProps.state);
    assert.doesNotMatch(serialized, new RegExp(`participant-${type}`));
    assert.doesNotMatch(serialized, /tenantId|roles|permissions|credentials|email/);
    assert.equal(typeof slotProps.controls.insertMention, "function");
    await view.unmount();
  }
});

test("filters safe participants and inserts a pointer-selected mention over the visual selection", async () => {
  const aliceId = "participant-alice";
  const fixture = createFixture({
    initialDraft: draftContent("Hello team"),
    participantUsers: [
      participantUser(aliceId, "Alice Nguyen"),
      Object.freeze({ kind: "redacted", userId: "participant-hidden" }),
      Object.freeze({
        kind: "unavailable",
        userId: "participant-unavailable",
        reason: "missing",
      }),
    ],
  });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  const editor = view.editor();
  selectEditorText(editor, 6, 10);
  await clickElement(view.container.querySelector('button[aria-label="Mention a participant"]'));

  const dialog = view.container.querySelector(
    '[role="dialog"][aria-label="Mention a participant"]',
  );
  const filter = dialog.querySelector('input[aria-label="Filter participants"]');
  assert.equal(document.activeElement, filter);
  assert.equal(dialog.querySelector('[role="listbox"]').getAttribute("aria-label"),
    "Conversation participants");
  const options = [...dialog.querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map((option) => option.textContent), [
    "Alice Nguyen",
    "Hidden userUnavailable",
    "Unavailable userUnavailable",
  ]);
  assert.equal(options[1].disabled, true);
  assert.equal(options[1].getAttribute("aria-disabled"), "true");
  assert.equal(options[2].disabled, true);

  await inputValue(filter, "alice");
  assert.deepEqual(
    [...dialog.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ["Alice Nguyen"],
  );
  await clickElement(dialog.querySelector('[role="option"]'));
  assert.equal(textarea.value, "Hello @Alice Nguyen ");
  assert.equal(editor.textContent, "Hello @Alice Nguyen ");
  assert.equal(document.activeElement, editor);
  assert.equal(view.container.querySelector('[aria-label="Filter participants"]'), null);
  const synchronized = fixture.calls
    .filter(({ name }) => name === "replaceConversationDraft")
    .at(-1).args[0].content;
  assert.deepEqual(synchronized.mentions, [{ type: "user", userId: aliceId }]);

  await inputText(textarea, "Hello Alice Nguyen ");
  const reconciled = fixture.calls
    .filter(({ name }) => name === "replaceConversationDraft")
    .at(-1).args[0].content;
  assert.equal(Object.hasOwn(reconciled, "mentions"), false);
  await view.unmount();
});

test("supports keyboard mention navigation, filtering, selection, and Escape focus restoration", async () => {
  const fixture = createFixture({
    initialDraft: draftContent("Start"),
    participantUsers: [
      participantUser("participant-alice", "Alice Nguyen"),
      participantUser("participant-bob", "Bob Stone"),
      participantUser("participant-bobby", "Bobby Tables"),
    ],
  });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  const editor = view.editor();
  selectEditorText(editor, 5);
  const trigger = view.container.querySelector('button[aria-label="Mention a participant"]');
  await clickElement(trigger);
  let filter = view.container.querySelector('input[aria-label="Filter participants"]');
  await inputValue(filter, "bob");
  assert.match(filter.getAttribute("aria-activedescendant"), /participant-1$/);
  assert.equal((await keyDownElement(filter, "ArrowDown")).defaultPrevented, true);
  assert.match(filter.getAttribute("aria-activedescendant"), /participant-2$/);
  assert.equal((await keyDownElement(filter, "Enter")).defaultPrevented, true);
  assert.equal(textarea.value, "Start @Bobby Tables ");
  assert.equal(document.activeElement, editor);

  selectEditorText(editor, 0);
  await clickElement(trigger);
  filter = view.container.querySelector('input[aria-label="Filter participants"]');
  assert.equal((await keyDownElement(filter, "Escape")).defaultPrevented, true);
  assert.equal(view.container.querySelector('[aria-label="Filter participants"]'), null);
  assert.equal(document.activeElement, editor);
  await view.unmount();
});

test("opens participant typeahead from typed @ and sends the selected user mention", async () => {
  const graceId = "participant-grace";
  const fixture = createFixture({
    initialDraft: null,
    participantUsers: [
      participantUser("participant-alex", "Alex"),
      participantUser(graceId, "Grace"),
    ],
  });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  const editor = view.editor();
  await inputRichText(editor, "Hello @gr");

  const dialog = view.container.querySelector(
    '[role="dialog"][aria-label="Mention a participant"]',
  );
  const listbox = dialog.querySelector('[role="listbox"]');
  const filter = dialog.querySelector('input[aria-label="Filter participants"]');
  const option = dialog.querySelector('[role="option"]');
  assert.equal(document.activeElement, editor);
  assert.equal(filter.value, "gr");
  assert.deepEqual(
    [...dialog.querySelectorAll('[role="option"]')].map(({ textContent }) => textContent),
    ["Grace"],
  );
  assert.equal(editor.getAttribute("aria-autocomplete"), "list");
  assert.equal(editor.getAttribute("aria-controls"), listbox.id);
  assert.equal(editor.getAttribute("aria-activedescendant"), option.id);
  assert.equal(option.getAttribute("aria-selected"), "true");
  assert.equal((await keyDownElement(editor, "ArrowDown")).defaultPrevented, true);
  assert.equal((await keyDownElement(editor, "Enter")).defaultPrevented, true);
  assert.equal(textarea.value, "Hello @Grace ");
  assert.equal(editor.textContent, "Hello @Grace ");
  assert.equal(document.activeElement, editor);
  assert.equal(view.container.querySelector('[aria-label="Filter participants"]'), null);
  const mentionStatus = view.container.querySelector('[role="status"]');
  assert.match(mentionStatus.textContent, /Grace mentioned/i);
  assert.equal(mentionStatus.getAttribute("aria-live"), "polite");
  assert.equal(mentionStatus.getAttribute("aria-atomic"), "true");

  await clickElement(view.container.querySelector('button[type="submit"]'));
  const sent = fixture.calls.find(({ name }) => name === "sendMessage").args[0].content;
  assert.deepEqual(sent, {
    format: "plain",
    text: "Hello @Grace ",
    mentions: [{ type: "user", userId: graceId }],
  });
  await view.unmount();
});

test("maps a visual mention selection through canonical Markdown delimiters", async () => {
  const graceId = "participant-grace-marked";
  const fixture = createFixture({
    initialDraft: draftContent("**Hello @gr**", "markdown"),
    participantUsers: [participantUser(graceId, "Grace")],
  });
  const view = await renderComposer(fixture);
  const editor = view.editor();
  selectEditorText(editor, editor.textContent.length);
  await act(async () => {
    editor.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: null,
    }));
    await flush();
  });

  assert.ok(view.container.querySelector('[role="dialog"][aria-label="Mention a participant"]'));
  await keyDownElement(editor, "Enter");
  assert.equal(view.textarea().value, "**Hello @Grace **");
  assert.equal(editor.querySelector("strong").textContent, "Hello @Grace ");
  const synchronized = fixture.calls
    .filter(({ name }) => name === "replaceConversationDraft")
    .at(-1).args[0].content;
  assert.deepEqual(synchronized.mentions, [{ type: "user", userId: graceId }]);
  await view.unmount();
});

test("dismisses inline mentions without changing text and ignores invalid @ boundaries", async () => {
  const view = await renderComposer(createFixture({
    initialDraft: null,
    participantUsers: [participantUser("participant-grace-boundary", "Grace")],
  }));
  const textarea = view.textarea();
  textarea.focus();

  for (const text of ["grace@example.com", "hello@gr", "Привет@gr", "\\@gr"]) {
    await inputText(textarea, text);
    assert.equal(
      view.container.querySelector('[role="dialog"][aria-label="Mention a participant"]'),
      null,
      `unexpected typeahead for ${text}`,
    );
  }

  const text = "Keep @gr";
  await inputText(textarea, text);
  assert.ok(view.container.querySelector('[role="dialog"][aria-label="Mention a participant"]'));
  assert.equal((await keyDownElement(textarea, "Escape")).defaultPrevented, true);
  assert.equal(textarea.value, text);
  assert.equal(document.activeElement, textarea);
  assert.equal(view.container.querySelector('[aria-label="Filter participants"]'), null);
  await view.unmount();
});

test("does not trigger or select inline mentions during IME composition", async () => {
  const fixture = createFixture({
    initialDraft: null,
    participantUsers: [participantUser("participant-grace-composition", "Grace")],
  });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  const editor = view.editor();
  editor.focus();
  await act(async () => {
    editor.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    editor.textContent = "@gr";
    selectEditorText(editor, 3);
    editor.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      inputType: "insertCompositionText",
      data: "@gr",
      isComposing: true,
    }));
    await flush();
  });
  assert.equal(textarea.value, "@gr");
  assert.equal(view.container.querySelector('[aria-label="Filter participants"]'), null);
  assert.equal((await keyDownElement(editor, "Enter", { isComposing: true })).defaultPrevented,
    false);
  assert.equal(fixture.calls.some(({ name }) => name === "sendMessage"), false);
  await act(async () => {
    editor.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
    await flush();
  });
  assert.equal(view.container.querySelector('[aria-label="Filter participants"]'), null);
  const synchronized = fixture.calls
    .filter(({ name }) => name === "replaceConversationDraft")
    .at(-1).args[0].content;
  assert.equal(Object.hasOwn(synchronized, "mentions"), false);
  await view.unmount();
});

test("keeps unavailable inline mention options from creating mention metadata", async () => {
  const fixture = createFixture({
    initialDraft: null,
    participantUsers: [Object.freeze({
      kind: "unavailable",
      userId: "participant-unavailable-inline",
      reason: "missing",
    })],
  });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  textarea.focus();
  await inputText(textarea, "@un");

  const option = view.container.querySelector('[role="option"]');
  assert.ok(option);
  assert.equal(option.disabled, true);
  assert.equal(textarea.getAttribute("aria-activedescendant"), null);
  assert.equal((await keyDownElement(textarea, "Enter")).defaultPrevented, true);
  assert.equal((await keyDownElement(textarea, "Tab")).defaultPrevented, true);
  assert.equal(textarea.value, "@un");
  assert.equal(fixture.calls.some(({ name }) => name === "sendMessage"), false);
  const synchronized = fixture.calls
    .filter(({ name }) => name === "replaceConversationDraft")
    .at(-1).args[0].content;
  assert.equal(Object.hasOwn(synchronized, "mentions"), false);
  await view.unmount();
});

test("restores and round-trips mentions, sends exact references, retries matching failures, and clears on success", async () => {
  const aliceId = "participant-alice-lifecycle";
  const content = draftContent(
    "Hi @Alice Nguyen",
    "plain",
    [],
    [{ type: "user", userId: aliceId }],
  );
  const fixture = createFixture({
    initialDraft: content,
    participantUsers: [participantUser(aliceId, "Alice Nguyen")],
  });
  fixture.queueSend(Promise.resolve({ status: "transport", message: "ignored" }));
  fixture.queueRetry(Promise.resolve({ status: "success", value: {} }));
  const view = await renderComposer(fixture);
  assert.equal(view.textarea().value, content.text);
  await inputText(view.textarea(), `Well ${content.text}`);
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "replaceConversationDraft").at(-1)
      .args[0].content.mentions,
    [{ type: "user", userId: aliceId }],
  );

  await clickElement(view.container.querySelector('button[type="submit"]'));
  const sent = fixture.calls.find(({ name }) => name === "sendMessage").args[0].content;
  assert.deepEqual(sent, {
    format: "plain",
    text: `Well ${content.text}`,
    mentions: [{ type: "user", userId: aliceId }],
  });
  const retry = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent === "Retry send");
  assert.ok(retry, "failed-payload matching includes canonical mentions");
  await clickElement(retry);
  assert.deepEqual(
    fixture.calls.find(({ name }) => name === "retryMessage").args,
    ["client-message-1"],
  );
  assert.equal(view.textarea().value, "");
  assert.equal(
    fixture.calls.filter(({ name }) => name === "clearConversationDraft").length >= 1,
    true,
  );
  await view.unmount();
});

test("resets mention interaction on conversation changes and disables it for guarded composers", async () => {
  const fixture = createFixture({
    initialDraft: null,
    participantUsers: [participantUser("participant-reset", "Reset Person")],
  });
  const view = await renderComposer(fixture);
  await clickElement(view.container.querySelector('button[aria-label="Mention a participant"]'));
  assert.ok(view.container.querySelector('input[aria-label="Filter participants"]'));
  await view.rerender({
    conversationId: "conversation-other",
    conversation: { ...safeConversation, id: "conversation-other" },
  });
  assert.equal(view.container.querySelector('input[aria-label="Filter participants"]'), null);
  await view.unmount();

  for (const props of [{ disabled: true }, { readOnly: true }]) {
    const guarded = await renderComposer(createFixture({
      initialDraft: null,
      participantUsers: [participantUser("participant-guarded", "Guarded Person")],
    }), props);
    const trigger = guarded.container.querySelector(
      'button[aria-label="Mention a participant"]',
    );
    assert.equal(trigger.disabled, true);
    await clickElement(trigger);
    assert.equal(guarded.container.querySelector('[aria-label="Filter participants"]'), null);
    await guarded.unmount();
  }
});

test("disables Send for empty or whitespace-only content and enables sendable text", async () => {
  const view = await renderComposer(createFixture({ initialDraft: null }));
  const send = view.container.querySelector(
    'button[type="submit"][aria-label="Send message"]',
  );

  assert.equal(send.disabled, true);
  await inputText(view.textarea(), " \n\t ");
  assert.equal(send.disabled, true);
  await inputText(view.textarea(), "Sendable text");
  assert.equal(send.disabled, false);

  await view.unmount();
});

test("autosizes one-line and multiline text, caps overflow, and resets after send", async () => {
  const fixture = createFixture({ initialDraft: null });
  const view = await renderComposer(fixture);
  const textarea = view.textarea();

  await inputText(textarea, "One line", 40);
  assert.equal(textarea.style.height, "40px");
  assert.equal(textarea.style.overflowY, "hidden");

  await inputText(textarea, "First\nsecond\nthird", 88);
  assert.equal(textarea.style.height, "88px");
  assert.equal(textarea.style.overflowY, "hidden");

  await inputText(textarea, "A draft taller than the composer cap", 240);
  assert.equal(textarea.style.height, "144px");
  assert.equal(textarea.style.overflowY, "auto");

  await act(async () => {
    view.container.querySelector('button[type="submit"]').click();
    await flush();
  });
  assert.equal(textarea.value, "");
  assert.equal(textarea.style.height, "40px");
  assert.equal(textarea.style.overflowY, "hidden");

  await view.unmount();
});

test("autosizes restored drafts and resynchronizes observed container changes", async () => {
  const fixture = createFixture({
    initialDraft: draftContent("Restored\nmultiline\ndraft"),
  });
  const observerStart = resizeObservers.length;
  const view = await renderComposer(fixture);
  const textarea = view.textarea();
  const observer = resizeObservers[observerStart];

  assert.equal(textarea.value, "Restored\nmultiline\ndraft");
  assert.equal(textarea.style.height, "88px");
  assert.ok(observer.observed.has(textarea.parentElement));

  textareaScrollHeights.set(textarea, { value: textarea.value, height: 112 });
  await act(async () => {
    observer.trigger();
    await flush();
  });
  assert.equal(textarea.style.height, "112px");

  await view.unmount();
  assert.equal(observer.disconnected, true);
});

test("restores drafts, updates them through debounced public actions, and retries safe draft errors", async () => {
  const fixture = createFixture();
  const view = await renderComposer(fixture);
  assert.equal(view.textarea().value, "Restored draft");

  await inputText(view.textarea(), "Edited draft");
  const replacement = fixture.calls.find(({ name }) => name === "replaceConversationDraft");
  assert.equal(replacement.args[0].conversationId, conversationId);
  assert.deepEqual(replacement.args[0].content, {
    format: "plain",
    text: "Edited draft",
    attachments: [],
  });
  assert.equal(fixture.calls.some(({ name }) => name === "flushConversationDraft"), false);

  await act(async () => {
    fixture.setDraft({
      conversationId,
      status: "retryable",
      authoritativeRevision: 1,
      dirty: true,
      draft: { kind: "replaced", content: draftContent("Edited draft") },
      message: "The draft could not be synchronized.",
    });
    await flush();
  });
  const alerts = view.container.querySelectorAll('[role="alert"]');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].textContent, /draft could not be synchronized/i);
  assert.equal(view.container.querySelector('[role="status"][aria-live="polite"]'), null);
  assert.equal(
    [...view.container.querySelectorAll("button")]
      .filter((button) => button.textContent === "Retry draft").length,
    1,
  );
  await act(async () => {
    view.container.querySelector("button").ownerDocument.defaultView;
    [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry draft").click();
    await flush();
  });
  assert.equal(fixture.calls.some(({ name }) => name === "retryConversationDraft"), true);
  await view.unmount();
});

test("keeps repeated routine draft synchronization silent while preserving public draft status", async () => {
  const fixture = createFixture();
  const view = await renderComposer(fixture);
  assert.equal(view.textarea().value, "Restored draft");

  const assertRoutineDraftIsSilent = () => {
    assert.doesNotMatch(view.container.textContent, /saving draft/i);
    assert.equal(view.container.querySelector('[role="status"][aria-live="polite"]'), null);
    assert.equal(view.container.querySelector(".handrail-chat__composer-feedback"), null);
  };
  assertRoutineDraftIsSilent();

  for (const text of ["Edited draft", "Edited draft again"]) {
    await inputText(view.textarea(), text);
    const replacement = fixture.calls
      .filter(({ name }) => name === "replaceConversationDraft")
      .at(-1);
    assert.equal(replacement.args[0].conversationId, conversationId);
    assert.deepEqual(replacement.args[0].content, {
      format: "plain",
      text,
      attachments: [],
    });
    assertRoutineDraftIsSilent();

    await act(async () => {
      fixture.setDraft({
        conversationId,
        status: "saving",
        authoritativeRevision: 1,
        dirty: true,
        draft: { kind: "replaced", content: draftContent(text) },
      });
      await flush();
    });
    assert.equal(view.textarea().value, text);
    assertRoutineDraftIsSilent();
  }
  assert.equal(
    fixture.calls.filter(({ name }) => name === "replaceConversationDraft").length,
    2,
  );
  assert.equal(fixture.calls.some(({ name }) => name === "flushConversationDraft"), false);
  await view.unmount();

  const customFixture = createFixture({ initialDraft: null });
  let customStatus;
  const custom = await renderComposer(customFixture, {
    components: {
      Composer: ({ state }) => {
        customStatus = state.status;
        return createElement("div", { "data-custom-composer": true });
      },
    },
  });
  for (const status of ["debouncing", "saving"]) {
    await act(async () => {
      customFixture.setDraft({
        conversationId,
        status,
        authoritativeRevision: 0,
        dirty: true,
        draft: { kind: "replaced", content: draftContent("Custom draft") },
      });
      await flush();
    });
    assert.deepEqual(customStatus, { kind: "draft", message: "Saving draft…" });
  }
  await custom.unmount();
});

test("visually formats selections, stores canonical Markdown, and restores focus", async () => {
  const cases = [
    {
      label: "Bold",
      text: "alpha beta",
      selection: [6, 10],
      expected: "alpha **beta**",
      selector: "strong",
      activation: "pointer",
    },
    {
      label: "Italic",
      text: "alpha beta",
      selection: [6, 10],
      expected: "alpha *beta*",
      selector: "em",
      activation: "keyboard",
    },
    {
      label: "Strikethrough",
      text: "alpha beta",
      selection: [6, 10],
      expected: "alpha ~~beta~~",
      selector: "s",
    },
    {
      label: "Insert link",
      text: "alpha beta",
      selection: [6, 10],
      expected: "alpha [beta](https://docs.example.test/guide)",
      selector: "a[href=\"https://docs.example.test/guide\"]",
    },
    {
      label: "Ordered list",
      text: "one\ntwo",
      selection: [0, 7],
      expected: "1. one\n2. two",
      selector: "ol > li",
    },
    {
      label: "Bulleted list",
      text: "one\ntwo",
      selection: [0, 7],
      expected: "- one\n- two",
      selector: "ul > li",
    },
    {
      label: "Inline code",
      text: "run command",
      selection: [4, 11],
      expected: "run `command`",
      selector: "code",
    },
    {
      label: "Code block",
      text: "const answer = 42;",
      selection: [0, 18],
      expected: "```\nconst answer = 42;\n```",
      selector: "pre > code",
    },
  ];

  for (const entry of cases) {
    const fixture = createFixture({ initialDraft: draftContent(entry.text) });
    const view = await renderComposer(fixture);
    const textarea = view.textarea();
    const editor = view.editor();
    const control = view.container.querySelector(`button[aria-label="${entry.label}"]`);
    selectEditorText(editor, ...entry.selection);
    const originalPrompt = window.prompt;
    if (entry.label === "Insert link") {
      window.prompt = () => "https://docs.example.test/guide";
    }

    if (entry.activation === "pointer") {
      const pointerEvent = await pointerDownElement(control);
      assert.equal(pointerEvent.defaultPrevented, true);
      await clickElement(control);
    } else if (entry.activation === "keyboard") {
      control.focus();
      const keyboardEvent = await keyDownElement(control, " ");
      assert.equal(keyboardEvent.defaultPrevented, true);
    } else {
      await clickElement(control);
    }

    window.prompt = originalPrompt;
    assert.equal(textarea.value, entry.expected);
    assert.equal(document.activeElement, editor);
    assert.equal(editor.querySelector(entry.selector).textContent,
      entry.label.includes("list") ? entry.text.split("\n")[0] :
        entry.label === "Code block" ? entry.text : entry.text.slice(...entry.selection));
    assert.doesNotMatch(editor.textContent, /\*\*|~~|```|\]\(https?:/);
    assert.deepEqual(
      fixture.calls.filter(({ name }) => name === "replaceConversationDraft").at(-1)
        .args[0].content,
      { format: "markdown", text: entry.expected, attachments: [] },
    );
    await view.unmount();
  }
});

test("inserts visual placeholders at a collapsed caret", async () => {
  const cases = [
    ["Insert link", "Say ", 4, "Say [link text](https://docs.example.test/)", "a"],
    ["Ordered list", "", 0, "1. list item", "ol > li"],
    ["Bulleted list", "", 0, "- list item", "ul > li"],
    ["Inline code", "", 0, "`code`", "code"],
    ["Code block", "", 0, "```\ncode\n```", "pre > code"],
  ];

  for (const [label, text, caret, expected, selector] of cases) {
    const fixture = createFixture({ initialDraft: draftContent(text) });
    const view = await renderComposer(fixture);
    const textarea = view.textarea();
    const editor = view.editor();
    selectEditorText(editor, caret);
    const originalPrompt = window.prompt;
    if (label === "Insert link") window.prompt = () => "https://docs.example.test/";
    await clickElement(view.container.querySelector(`button[aria-label="${label}"]`));
    window.prompt = originalPrompt;

    assert.equal(textarea.value, expected);
    assert.ok(editor.querySelector(selector));
    assert.equal(document.activeElement, editor);
    await view.unmount();
  }
});

test("keeps keyboard input ordered and plain after deactivating Italic at the caret", async () => {
  const fixture = createFixture({ initialDraft: draftContent("") });
  const view = await renderComposer(fixture);
  const editor = view.editor();
  const italic = view.container.querySelector('button[aria-label="Italic"]');

  selectEditorText(editor, 0);
  await clickElement(italic);
  assert.equal(window.getSelection().toString(), "italic text");
  const italicEvents = await typeRichTextAtSelection(editor, "ItaQ7");
  await clickElement(italic);
  assert.equal(view.textarea().value, "*ItaQ7*");
  assert.equal(editor.textContent, "ItaQ7\u200B");
  const boundary = editor.querySelector("[data-composer-caret-boundary]");
  assert.notEqual(boundary, null);
  assert.equal(boundary.textContent, "\u200B");
  assert.doesNotMatch(editor.textContent, /\uE000|italic text/);
  const plainCaret = window.getSelection().getRangeAt(0);
  assert.equal(plainCaret.collapsed, true);
  assert.equal(plainCaret.startContainer, boundary.firstChild);
  assert.equal(plainCaret.startOffset, 1);

  const plainEvents = await typeRichTextAtSelection(editor, "-PlainZ9");

  assert.equal(view.textarea().value, "*ItaQ7*-PlainZ9");
  assert.equal(editor.textContent, "ItaQ7-PlainZ9");
  assert.doesNotMatch(editor.innerHTML, /data-composer-caret-boundary|[\u200B\uE000]|italic text/);
  assert.equal(editor.querySelector("em").textContent, "ItaQ7");
  for (const [events, count] of [[italicEvents, 5], [plainEvents, 8]]) {
    assert.equal(events.filter(({ type }) => type === "beforeinput").length, count);
    assert.equal(events.some(({ prevented }) => prevented), false);
    assert.equal(events.filter(({ type }) => type === "input").length, count);
  }
  assert.deepEqual(
    fixture.calls.filter(({ name }) => name === "replaceConversationDraft").at(-1)
      .args[0].content,
    { format: "markdown", text: "*ItaQ7*-PlainZ9", attachments: [] },
  );

  await clickElement(view.container.querySelector('button[type="submit"]'));
  const sendCalls = fixture.calls.filter(({ name }) => name === "sendMessage");
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(
    sendCalls[0].args[0].content,
    { format: "markdown", text: "*ItaQ7*-PlainZ9" },
  );
  assert.doesNotMatch(JSON.stringify(fixture.calls), /[\u200B\uE000]/);
  await view.unmount();
});

test("rehydrates canonical Markdown visually and rejects unsafe link actions", async () => {
  const markdown = [
    "**bold** and *italic* with [docs](https://docs.example.test/guide) and `inline`",
    "",
    "1. first",
    "2. second",
    "",
    "- bullet",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");
  const fixture = createFixture({ initialDraft: draftContent(markdown, "markdown") });
  const view = await renderComposer(fixture);
  const editor = view.editor();

  assert.equal(editor.querySelector("strong").textContent, "bold");
  assert.equal(editor.querySelector("em").textContent, "italic");
  assert.equal(editor.querySelector('a[href="https://docs.example.test/guide"]').textContent,
    "docs");
  assert.equal(editor.querySelector("code:not(pre code)").textContent, "inline");
  assert.deepEqual([...editor.querySelectorAll("ol > li")].map(({ textContent }) => textContent),
    ["first", "second"]);
  assert.equal(editor.querySelector("ul > li").textContent, "bullet");
  assert.equal(editor.querySelector("pre > code").textContent, "const answer = 42;");
  assert.doesNotMatch(editor.textContent, /\*\*|```|\]\(https?:/);

  selectEditorText(editor, 0, 4);
  const originalPrompt = window.prompt;
  window.prompt = () => "javascript:alert(1)";
  await clickElement(view.container.querySelector('button[aria-label="Insert link"]'));
  window.prompt = originalPrompt;
  assert.equal(editor.querySelectorAll("a").length, 1);
  assert.equal(view.textarea().value, markdown);
  assert.equal(document.activeElement, editor);
  await view.unmount();
});

test("falls back to the plain textarea without an enabled formatting toolbar", async () => {
  const originalCreateRange = document.createRange;
  Object.defineProperty(document, "createRange", { configurable: true, value: undefined });
  const view = await renderComposer(createFixture({ initialDraft: draftContent("Fallback") }));
  Object.defineProperty(document, "createRange", {
    configurable: true,
    value: originalCreateRange,
  });

  assert.equal(view.editor(), null);
  assert.equal(view.container.querySelector('[aria-label="Text formatting"]'), null);
  assert.equal(view.textarea().hidden, false);
  assert.equal(view.textarea().value, "Fallback");
  assert.equal(view.textarea().labels.length, 1);
  await view.unmount();
});

test("sends the transformed composer text as a Markdown payload", async () => {
  const fixture = createFixture({ initialDraft: draftContent("Ship this") });
  const view = await renderComposer(fixture);
  selectEditorText(view.editor(), 5, 9);
  await clickElement(view.container.querySelector('button[aria-label="Bold"]'));
  await clickElement(view.container.querySelector('button[type="submit"]'));

  assert.deepEqual(
    fixture.calls.find(({ name }) => name === "sendMessage").args[0].content,
    { format: "markdown", text: "Ship **this**" },
  );
  await view.unmount();
});

test("bounds typing and implements Enter, Shift+Enter, IME, blur, and duplicate-send semantics", async () => {
  const fixture = createFixture({ initialDraft: null });
  const pendingSend = deferred();
  fixture.queueSend(pendingSend.promise);
  const view = await renderComposer(fixture);
  const editor = view.editor();

  await inputText(view.textarea(), "Hello");
  assert.equal(fixture.calls.filter(({ name }) => name === "startTyping").length, 1);
  const shiftEnter = new window.KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    editor.dispatchEvent(shiftEnter);
    editor.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  assert.equal(shiftEnter.defaultPrevented, false);
  assert.equal(fixture.calls.filter(({ name }) => name === "sendMessage").length, 0);
  await inputText(view.textarea(), "Hello\nworld");

  await act(async () => {
    for (let index = 0; index < 2; index += 1) {
      editor.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    }
    await flush();
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "sendMessage").length, 1);
  assert.equal(
    fixture.calls.find(({ name }) => name === "sendMessage").args[0].content.text,
    "Hello\nworld",
  );
  assert.equal(fixture.calls.filter(({ name }) => name === "stopTyping").length, 1);
  assert.equal(view.textarea().disabled, true);
  assert.equal(editor.getAttribute("contenteditable"), "false");

  await act(async () => {
    pendingSend.resolve({ status: "success", value: {} });
    await pendingSend.promise;
    await flush();
  });
  assert.equal(view.textarea().value, "");
  const sentStatus = view.container.querySelector('[role="status"]');
  assert.match(sentStatus.textContent, /message sent/i);
  assert.equal(sentStatus.getAttribute("aria-live"), "polite");
  assert.equal(sentStatus.getAttribute("aria-atomic"), "true");

  await inputText(view.textarea(), "Again");
  await act(async () => {
    view.textarea().dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    await flush();
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "stopTyping").length, 2);
  await inputText(view.textarea(), "Cleanup on unmount");
  await view.unmount();
  assert.equal(fixture.calls.filter(({ name }) => name === "stopTyping").length, 3);
});

test("ArrowUp requests the latest edit only for a truly empty, unmodified default composer", async () => {
  const requests = [];
  const dispatchArrowUp = async (view, init = {}) => {
    const event = new window.KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      view.textarea().dispatchEvent(event);
      await flush();
    });
    return event;
  };
  const onEditLatestMessage = (target) => {
    requests.push(target);
    return true;
  };

  const empty = await renderComposer(createFixture({ initialDraft: null }), {
    onEditLatestMessage,
  });
  const handled = await dispatchArrowUp(empty);
  assert.equal(handled.defaultPrevented, true);
  assert.deepEqual(requests, [empty.textarea()]);
  await empty.unmount();

  const unavailable = await renderComposer(createFixture({ initialDraft: null }), {
    onEditLatestMessage: () => false,
  });
  assert.equal((await dispatchArrowUp(unavailable)).defaultPrevented, false);
  await unavailable.unmount();

  for (const init of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ]) {
    const guarded = await renderComposer(createFixture({ initialDraft: null }), {
      onEditLatestMessage,
    });
    const before = requests.length;
    assert.equal((await dispatchArrowUp(guarded, init)).defaultPrevented, false);
    assert.equal(requests.length, before);
    await guarded.unmount();
  }

  const nonempty = await renderComposer(createFixture({ initialDraft: null }), {
    onEditLatestMessage,
  });
  await inputText(nonempty.textarea(), "Existing draft");
  assert.equal((await dispatchArrowUp(nonempty)).defaultPrevented, false);
  await nonempty.unmount();

  const attachment = await renderComposer(createFixture({
    initialDraft: draftContent("", "plain", [{ attachmentId: "attachment-restored" }]),
  }), { onEditLatestMessage });
  assert.equal((await dispatchArrowUp(attachment)).defaultPrevented, false);
  await attachment.unmount();

  const upload = await renderComposer(createFixture({ initialDraft: null }), {
    onEditLatestMessage,
  });
  const fileInput = upload.container.querySelector('input[type="file"]');
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [new window.File(["upload"], "upload.txt", { type: "text/plain" })],
  });
  await act(async () => {
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
  });
  assert.equal((await dispatchArrowUp(upload)).defaultPrevented, false);
  await upload.unmount();

  const readOnly = await renderComposer(createFixture({ initialDraft: null }), {
    onEditLatestMessage,
    readOnly: true,
  });
  assert.equal((await dispatchArrowUp(readOnly)).defaultPrevented, false);
  await readOnly.unmount();
});

test("renders safe upload progress, cancellation, finalization, and finalized-id-only sending", async () => {
  const fixture = createFixture({ initialDraft: null });
  const view = await renderComposer(fixture);
  const fileInput = view.container.querySelector('input[type="file"]');
  const unsafeFile = new window.File(["proof"], 'proof<script>.txt', { type: "text/plain" });
  Object.defineProperty(fileInput, "files", { configurable: true, value: [unsafeFile] });
  await act(async () => {
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
  });
  const uploadCall = fixture.calls.find(({ name }) => name === "uploadAttachment");
  assert.equal(uploadCall.args[0].metadata.fileName, "proof_script_.txt");
  assert.equal(Object.hasOwn(uploadCall.args[0], "providerDescriptor"), false);
  assert.equal(fileInput.value, "");

  await act(async () => {
    fixture.uploads.get("upload-1").progress(2);
    await flush();
  });
  assert.match(view.container.textContent, /40%/);
  const progress = view.container.querySelector('[role="progressbar"]');
  assert.equal(progress.getAttribute("aria-label"), "proof_script_.txt upload progress");
  assert.equal(progress.getAttribute("aria-valuenow"), "40");
  await act(async () => {
    view.container.querySelector('[aria-label^="Cancel upload"]').click();
    await flush();
  });
  assert.equal(fixture.calls.some(({ name }) => name === "cancelUpload"), true);

  const secondFile = new window.File(["four"], "image.png", { type: "image/png" });
  Object.defineProperty(fileInput, "files", { configurable: true, value: [secondFile] });
  await act(async () => {
    fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
    fixture.uploads.get("upload-2").finalize("attachment-final");
    await flush();
  });
  assert.ok(view.container.querySelector('[aria-label="Message attachments"]'));
  assert.ok(view.container.querySelector('[aria-label="Remove attachment image.png"]'));
  await inputText(view.textarea(), "With attachment");
  await act(async () => {
    view.container.querySelector('button[type="submit"]').click();
    await flush();
  });
  const send = fixture.calls.find(({ name }) => name === "sendMessage");
  assert.deepEqual(send.args[0].content.attachments, [{ attachmentId: "attachment-final" }]);
  assert.equal(JSON.stringify(send.args[0]).includes("proof"), false);
  await view.unmount();
});

test("uploads a pasted image once, preserves mixed text paste, and gates Enter until finalization", async () => {
  const fixture = createFixture({ initialDraft: null });
  const view = await renderComposer(fixture);
  await inputText(view.textarea(), "Keep this caption");
  const image = new window.File(["image"], "pasted.png", { type: "image/png" });
  const paste = await pasteItems(view.editor(), [
    { kind: "string", type: "text/plain", getAsFile: () => null },
    { kind: "file", type: image.type, getAsFile: () => image },
  ]);

  assert.equal(paste.defaultPrevented, false);
  assert.equal(view.textarea().value, "Keep this caption");
  const uploadCalls = fixture.calls.filter(({ name }) => name === "uploadAttachment");
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].args[0].source, image);
  const uploadStatus = view.container.querySelector('[role="status"]');
  assert.match(uploadStatus.textContent, /uploading attachment/i);
  assert.equal(uploadStatus.getAttribute("aria-live"), "polite");
  assert.equal(uploadStatus.getAttribute("aria-atomic"), "true");

  await act(async () => {
    fixture.uploads.get("upload-1").progress(3);
    await flush();
  });
  const progress = view.container.querySelector('[role="progressbar"]');
  assert.equal(progress.getAttribute("aria-label"), "pasted.png upload progress");
  assert.equal(progress.getAttribute("aria-valuenow"), "60");

  await act(async () => {
    view.editor().dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  assert.equal(fixture.calls.filter(({ name }) => name === "sendMessage").length, 0);

  await act(async () => {
    fixture.uploads.get("upload-1").finalize("attachment-pasted-image");
    await flush();
    view.editor().dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }));
    await flush();
  });
  const send = fixture.calls.find(({ name }) => name === "sendMessage");
  assert.equal(fixture.calls.filter(({ name }) => name === "sendMessage").length, 1);
  assert.deepEqual(send.args[0].content.attachments, [
    { attachmentId: "attachment-pasted-image" },
  ]);
  await view.unmount();
});

test("uploads supported pasted documents once and ignores non-file and null clipboard items", async () => {
  const fixture = createFixture({ initialDraft: null });
  const view = await renderComposer(fixture);
  const document = new window.File(["document"], "notes.pdf", {
    type: "application/pdf",
  });
  const paste = await pasteItems(view.textarea(), [
    { kind: "string", type: "text/html", getAsFile: () => null },
    { kind: "file", type: "", getAsFile: () => null },
    { kind: "file", type: document.type, getAsFile: () => document },
  ]);

  assert.equal(paste.defaultPrevented, false);
  const uploadCalls = fixture.calls.filter(({ name }) => name === "uploadAttachment");
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].args[0].source, document);
  assert.equal(uploadCalls[0].args[0].metadata.contentType, "application/pdf");
  await view.unmount();
});

test("rejects unsupported pasted files canonically and ignores paste while disabled or read-only", async () => {
  const unsupportedFixture = createFixture({ initialDraft: null });
  const unsupportedView = await renderComposer(unsupportedFixture);
  const archive = new window.File(["archive"], "archive.zip", {
    type: "application/zip",
  });
  const unsupportedPaste = await pasteItems(unsupportedView.textarea(), [
    { kind: "file", type: archive.type, getAsFile: () => archive },
  ]);
  assert.equal(unsupportedPaste.defaultPrevented, false);
  assert.equal(
    unsupportedFixture.calls.some(({ name }) => name === "uploadAttachment"),
    false,
  );
  assert.match(
    unsupportedView.container.querySelector('[role="alert"]').textContent,
    /attachment type is not supported/i,
  );
  await unsupportedView.unmount();

  for (const props of [{ disabled: true }, { readOnly: true }]) {
    const fixture = createFixture({ initialDraft: null });
    const view = await renderComposer(fixture, props);
    const file = new window.File(["safe"], "safe.txt", { type: "text/plain" });
    const paste = await pasteItems(view.textarea(), [
      { kind: "file", type: file.type, getAsFile: () => file },
    ]);
    assert.equal(paste.defaultPrevented, false);
    assert.equal(fixture.calls.some(({ name }) => name === "uploadAttachment"), false);
    await view.unmount();
  }
});

test("inline reply source-only drafts survive replacement, ping edits, remount and cancellation", async () => {
  const fixture = createFixture({ initialDraft: null });
  const controlsRef = React.createRef();
  let editRequests = 0;
  let view = await renderComposer(fixture, { controlsRef, onEditLatestMessage: () => { editRequests++; return true; } });
  const source = (messageId) => ({ conversationId, messageId });
  await act(async () => controlsRef.current.selectReply(source("source-a")));
  assert.deepEqual(fixture.getDraft().content, { format: "plain", text: "", attachments: [],
    replyTo: { messageId: "source-a", notifyAuthor: true } });
  assert.equal(view.container.querySelector('button[type="submit"]').disabled, true);
  assert.match(view.container.textContent, /Loading original message/);
  await act(async () => controlsRef.current.setReplyNotifyAuthor(false));
  assert.equal(fixture.getDraft().content.replyTo.notifyAuthor, false);
  await act(async () => controlsRef.current.selectReply(source("source-b")));
  assert.deepEqual(fixture.getDraft().content.replyTo, { messageId: "source-b", notifyAuthor: true });
  await act(async () => controlsRef.current.setReplyNotifyAuthor(false));
  assert.throws(() => controlsRef.current.selectReply({ conversationId: "parent-channel", messageId: "root" }), /current conversation/);
  await act(async () => view.textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  assert.equal(editRequests, 0, "source-only drafts never enter edit-message mode");
  await view.unmount();
  view = await renderComposer(fixture, { controlsRef });
  assert.equal(view.container.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(fixture.getDraft().content.replyTo.messageId, "source-b");
  await clickElement([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel reply"));
  assert.equal(fixture.getDraft().kind, "clear_tombstone");
  assert.ok(document.activeElement === (view.editor() ?? view.textarea()));
  assert.equal(fixture.calls.filter(({ name }) => name === "replaceConversationDraft").length, 4);
  await view.unmount();
});

test("cancel reply preserves text and attachments and restores the rich editor focus", async () => {
  const fixture = createFixture({ initialDraft: { ...draftContent("Friday", "markdown", [{ attachmentId: "schedule" }]),
    replyTo: { messageId: "source-a", notifyAuthor: false } } });
  const controlsRef = React.createRef();
  const view = await renderComposer(fixture, { controlsRef });
  await clickElement([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel reply"));
  assert.deepEqual(fixture.getDraft().content, draftContent("Friday", "markdown", [{ attachmentId: "schedule" }]));
  assert.equal(view.editor().textContent, "Friday");
  assert.equal(document.activeElement, view.editor());
  await view.unmount();
});

for (const type of ["channel", "thread"]) {
  test(`inline reply submission stays in the current ${type} across style rerenders and source rejection`, async () => {
    const id = type === "thread" ? "thread-composer" : conversationId;
    const conversation = type === "thread" ? { ...safeConversation, id, type, parentConversationId: conversationId, rootMessageId: "parent-root" } : safeConversation;
    const fixture = createFixture({ initialDraft: draftContent("Friday", "plain", [{ attachmentId: "schedule" }]), conversation });
    const controlsRef = React.createRef();
    const view = await renderComposer(fixture, { conversationId: id, controlsRef, hostProps: { "data-reply-style": "discord" } });
    await act(async () => {
      controlsRef.current.selectReply({ conversationId: id, messageId: "source-a" });
      controlsRef.current.setReplyNotifyAuthor(false);
    });
    const draft = fixture.getDraft().content;
    await view.rerender({ hostProps: { "data-reply-style": "current" } });
    assert.deepEqual(fixture.getDraft().content, draft);
    assert.equal(view.container.querySelector('input[type="checkbox"]').checked, false);
    fixture.queueSend(Promise.resolve({ status: "rejected", httpStatus: 422 }));
    await act(async () => controlsRef.current.send());
    assert.equal(view.textarea().value, "Friday");
    assert.deepEqual(fixture.getDraft().content, draft);
    assert.match(view.container.textContent, /not accepted/);
    await act(async () => controlsRef.current.selectReply({ conversationId: id, messageId: "source-b" }));
    await act(async () => controlsRef.current.send());
    const sends = fixture.calls.filter(({ name }) => name === "sendMessage").map(({ args }) => args[0]);
    assert.deepEqual(sends.map(({ conversationId, replyTo }) => ({ conversationId, replyTo })), [
      { conversationId: id, replyTo: { messageId: "source-a", notifyAuthor: false } },
      { conversationId: id, replyTo: { messageId: "source-b", notifyAuthor: true } },
    ]);
    assert.deepEqual(sends[0].content.attachments, [{ attachmentId: "schedule" }]);
    assert.equal(sends[0].content.replyTo, undefined);
    assert.equal(view.textarea().value, "");
    assert.equal(view.container.querySelector('input[type="checkbox"]'), null);
    await view.unmount();
  });
}

test("reply source errors recover and access loss removes source content from DOM and slots", async () => {
  const fixture = createFixture({ initialDraft: { ...draftContent("Friday"), replyTo: { messageId: "source-a", notifyAuthor: true } },
    participantUsers: [participantUser("source-author", "Alice")] });
  let slot;
  const Composer = (props) => { slot = props; return createElement(DefaultMessageComposerRenderer, props); };
  const view = await renderComposer(fixture, { components: { Composer } });
  const target = { conversationId, messageId: "source-a" };
  await act(async () => fixture.publishSource(target, { status: "error", error: "transport" }));
  await clickElement([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Retry original message"));
  assert.deepEqual(fixture.calls.find(({ name }) => name === "retrySource").args, [target]);
  await act(async () => fixture.publishSource(target, { status: "available", result: { status: "available", message: {
    author: { userId: "source-author" }, content: { text: "Which launch date?" },
  } } }));
  assert.match(view.container.textContent, /Replying to Alice: Which launch date/);
  assert.equal(slot.state.replyContext.preview, "Which launch date?");
  for (const state of [{ status: "deleted" }, { status: "unavailable" }, { status: "error", error: "access_revoked" }]) {
    await act(async () => fixture.publishSource(target, state));
    assert.doesNotMatch(view.container.textContent, /Alice|Which launch date/);
    assert.equal(slot.state.replyContext.preview, undefined);
    assert.equal(slot.state.replyContext.authorLabel, undefined);
    assert.equal(slot.state.text, "Friday");
    assert.equal(slot.state.replyTo.messageId, "source-a");
  }
  assert.equal(slot.state.replyContext.status, "unavailable");
  assert.equal([...view.container.querySelectorAll("button")].some((b) => b.textContent === "Retry original message"), false);
  await view.unmount();
});

test("retry matches source and ping and retains its original intent after composer reply changes", async () => {
  const fixture = createFixture({ initialDraft: draftContent("Friday") });
  const controlsRef = React.createRef();
  let slot;
  const Composer = (props) => { slot = props; return createElement(DefaultMessageComposerRenderer, props); };
  const view = await renderComposer(fixture, { controlsRef, components: { Composer } });
  await act(async () => controlsRef.current.selectReply({ conversationId, messageId: "source-a" }));
  const failure = deferred();
  fixture.queueSend(failure.promise);
  let sending;
  await act(async () => { sending = controlsRef.current.send(); await flush(); });
  const original = fixture.cache.getState().entities.messages["optimistic:client-message-1"];
  // Newer failed rows with equal content must not be selected for this retry.
  for (const [id, replyTo] of [["other-source", { messageId: "source-b", notifyAuthor: true }], ["other-ping", { messageId: "source-a", notifyAuthor: false }]]) {
    await act(async () => {
      fixture.cache.insertOptimisticMessage({ ...original, id: `optimistic:${id}`, replyTo,
        delivery: { ...original.delivery, clientMessageId: id, state: "failed", retryable: true } });
    });
  }
  await act(async () => { failure.resolve({ status: "transport" }); await sending; });
  assert.equal(slot.state.failedClientMessageId, "client-message-1");
  await act(async () => {
    controlsRef.current.selectReply({ conversationId, messageId: "source-b" });
    controlsRef.current.setReplyNotifyAuthor(false);
  });
  await act(async () => controlsRef.current.retrySend());
  assert.deepEqual(fixture.calls.find(({ name }) => name === "retryMessage").args, ["client-message-1"]);
  assert.equal(fixture.calls.filter(({ name }) => name === "sendMessage").length, 1);
  assert.deepEqual(fixture.getDraft().content.replyTo, { messageId: "source-b", notifyAuthor: false });
  assert.equal(view.textarea().value, "Friday");
  assert.deepEqual(original.replyTo, { messageId: "source-a", notifyAuthor: true });
  await view.unmount();
});

for (const retry of [false, true]) {
  test(`late ${retry ? "retry" : "send"} success preserves newer draft edits`, async () => {
    const fixture = createFixture({ initialDraft: draftContent("Friday") });
    const controlsRef = React.createRef();
    const view = await renderComposer(fixture, { controlsRef });
    await act(async () => controlsRef.current.selectReply({ conversationId, messageId: "source-a" }));
    if (retry) {
      fixture.queueSend(Promise.resolve({ status: "transport" }));
      await act(async () => controlsRef.current.send());
    }
    const pending = deferred();
    retry ? fixture.queueRetry(pending.promise) : fixture.queueSend(pending.promise);
    let completion;
    await act(async () => { completion = retry ? controlsRef.current.retrySend() : controlsRef.current.send(); await flush(); });
    await act(async () => {
      controlsRef.current.setText("New draft");
      controlsRef.current.selectReply({ conversationId, messageId: "source-b" });
      controlsRef.current.setReplyNotifyAuthor(false);
    });
    await act(async () => { pending.resolve({ status: "success", value: {} }); await completion; });
    assert.equal(view.textarea().value, "New draft");
    assert.equal(fixture.getDraft().content.text, "New draft");
    assert.deepEqual(fixture.getDraft().content.replyTo, { messageId: "source-b", notifyAuthor: false });
    await view.unmount();
  });
}

test("a retry completing after a conversation switch cannot clear the newly opened draft", async () => {
  const fixture = createFixture({ initialDraft: { ...draftContent("Friday"), replyTo: { messageId: "source-a", notifyAuthor: false } } });
  const controlsRef = React.createRef();
  const view = await renderComposer(fixture, { controlsRef });
  fixture.queueSend(Promise.resolve({ status: "transport" }));
  await act(async () => controlsRef.current.send());
  const pending = deferred();
  fixture.queueRetry(pending.promise);
  let completion;
  await act(async () => { completion = controlsRef.current.retrySend(); await flush(); });
  const otherId = "other-conversation";
  const newer = { ...draftContent("Other draft"), replyTo: { messageId: "other-source", notifyAuthor: false } };
  await act(async () => fixture.setDraft({ conversationId: otherId, status: "ready", dirty: true,
    authoritativeRevision: 1, draft: { kind: "replaced", content: newer } }));
  await view.rerender({ conversationId: otherId, conversation: { ...safeConversation, id: otherId } });
  await act(async () => { pending.resolve({ status: "success", value: {} }); await completion; });
  assert.equal(view.textarea().value, "Other draft");
  assert.deepEqual(fixture.getDraft().content, newer);
  assert.equal(fixture.calls.filter(({ name }) => name === "clearConversationDraft").length, 0);
  assert.deepEqual(fixture.calls.find(({ name }) => name === "sendMessage").args[0].replyTo,
    { messageId: "source-a", notifyAuthor: false });
  assert.equal(fixture.calls.find(({ name }) => name === "sendMessage").args[0].conversationId, conversationId);
  await view.unmount();
});

test("editing a sent message never submits composer reply context or changes its ancestry", async () => {
  const fixture = createFixture({ initialDraft: { ...draftContent("Unsent reply"),
    replyTo: { messageId: "draft-source", notifyAuthor: false } } });
  const edits = [];
  const sent = Object.freeze({
    id: "sent-reply", conversationId, sequence: 1, createdAt: now, updatedAt: now,
    revision: { revision: 1 }, content: Object.freeze({ format: "plain", text: "Sent reply" }),
    replyTo: Object.freeze({ messageId: "immutable-source", notifyAuthor: true }),
    replyContext: { conversationId, messageId: "immutable-source", status: "unavailable" },
    reactions: [], attachmentMetadata: [], isThreadRoot: false,
    delivery: { state: "sent" }, editState: "idle", deleteState: "idle", canEdit: true, canDelete: false,
    saved: { available: false, isSaved: false, mutationState: "idle", retryable: false, conflict: false },
    reminder: { available: false, state: "absent", mutationState: "idle", retryable: false, conflict: false },
  });
  const Composer = (props) => createElement(React.Fragment, null,
    createElement(DefaultMessageRenderer, { message: sent, hostProps: {},
      actions: { editMessage: async (input) => { edits.push(input); return { status: "success" }; } } }),
    createElement(DefaultMessageComposerRenderer, props));
  const controlsRef = React.createRef();
  const view = await renderComposer(fixture, { components: { Composer }, controlsRef });
  await clickElement([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Edit"));
  await act(async () => controlsRef.current.selectReply({ conversationId, messageId: "replacement-source" }));
  const editor = view.container.querySelector('textarea[id="edit-sent-reply"]');
  assert.ok(editor);
  await inputText(editor, "Edited reply");
  await act(async () => {
    editor.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
  assert.deepEqual(edits, [{ messageId: "sent-reply", expectedRevision: 1, content: { format: "plain", text: "Edited reply" } }]);
  assert.deepEqual(sent.replyTo, { messageId: "immutable-source", notifyAuthor: true });
  assert.equal(fixture.getDraft().content.text, "Unsent reply");
  assert.equal(fixture.getDraft().content.replyTo.messageId, "replacement-source");
  await view.unmount();
});

test("preserves failed content, exposes the public optimistic id, and retries without fabricating transport state", async () => {
  const fixture = createFixture({ initialDraft: null });
  fixture.queueSend(Promise.resolve({ status: "transport", message: "unsafe ignored" }));
  fixture.queueRetry(Promise.resolve({ status: "success", value: {} }));
  const view = await renderComposer(fixture);
  await inputText(view.textarea(), "Keep <strong>this</strong>", 240);
  assert.equal(view.textarea().style.height, "144px");
  assert.equal(view.textarea().style.overflowY, "auto");
  await act(async () => {
    view.container.querySelector('button[type="submit"]').click();
    await flush();
  });
  assert.equal(view.textarea().value, "Keep <strong>this</strong>");
  assert.equal(view.container.querySelector("strong"), null);
  assert.match(view.container.querySelector('[role="alert"]').textContent, /could not be sent/i);
  const retry = [...view.container.querySelectorAll("button")]
    .find((button) => button.textContent === "Retry send");
  assert.ok(retry);
  await act(async () => {
    retry.click();
    await flush();
  });
  assert.deepEqual(
    fixture.calls.find(({ name }) => name === "retryMessage").args,
    ["client-message-1"],
  );
  assert.equal(view.textarea().value, "");
  assert.equal(view.textarea().style.height, "40px");
  assert.equal(view.textarea().style.overflowY, "hidden");
  await view.unmount();
});

test("permission failures preserve content, explain membership, and do not offer an ineffective retry", async () => {
  const permissionFailure = { status: "rejected", httpStatus: 403 };
  for (const failOnRetry of [false, true]) {
    const fixture = createFixture({ initialDraft: null });
    fixture.queueSend(Promise.resolve(failOnRetry ? { status: "transport" } : permissionFailure));
    fixture.queueRetry(Promise.resolve(permissionFailure));
    const view = await renderComposer(fixture);
    await inputText(view.textarea(), "Keep my Empty Room message");
    await clickElement(view.container.querySelector('button[type="submit"]'));
    if (failOnRetry) {
      const retry = [...view.container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry send");
      assert.ok(retry);
      await clickElement(retry);
    }
    const alert = view.container.querySelector('[role="alert"]').textContent;
    assert.match(alert, /do not have permission/i);
    assert.match(alert, /ask a channel owner or moderator to add you/i);
    assert.doesNotMatch(alert, /authentication/i);
    assert.equal(view.textarea().value, "Keep my Empty Room message");
    assert.equal([...view.container.querySelectorAll("button")]
      .some((button) => button.textContent === "Retry send"), false);
    await view.unmount();
  }
});

test("authentication failures retain their own explanation", async () => {
  const fixture = createFixture({ initialDraft: null });
  fixture.queueSend(Promise.resolve({ status: "authentication", httpStatus: 401 }));
  const view = await renderComposer(fixture);
  await inputText(view.textarea(), "Keep my draft");
  await clickElement(view.container.querySelector('button[type="submit"]'));
  assert.match(view.container.querySelector('[role="alert"]').textContent, /authentication failed/i);
  assert.equal(view.textarea().value, "Keep my draft");
  await view.unmount();
});

test("passes renderer-safe normalized state to Composer overrides and covers disabled/a11y/raw-input states", async () => {
  const fixture = createFixture();
  let slotProps;
  const Composer = (props) => {
    slotProps = props;
    return createElement("div", { "data-custom-composer": true }, props.state.text);
  };
  const custom = await renderComposer(fixture, {
    components: { Composer },
    onEditLatestMessage: () => true,
  });
  assert.equal(custom.container.textContent, "Restored draft");
  assert.equal(slotProps.conversation.tenantId, undefined);
  assert.equal(slotProps.state.text, "Restored draft");
  assert.equal(typeof slotProps.controls.send, "function");
  assert.equal(Object.hasOwn(slotProps, "onEditLatestMessage"), false);
  assert.equal(Object.hasOwn(slotProps.controls, "requestEditLatestMessage"), false);
  for (const privateKey of ["client", "transport", "token", "credentials", "providerDescriptor"]) {
    assert.equal(Object.hasOwn(slotProps, privateKey), false);
    assert.equal(Object.hasOwn(slotProps.state, privateKey), false);
  }
  await custom.unmount();

  for (const [props, reason] of [
    [{ disabled: true }, "disabled"],
    [{ readOnly: true }, "read-only"],
    [{ availability: { membershipState: "left" } }, "not an active"],
    [{ availability: { canSend: false } }, "permission"],
    [{ conversation: { ...safeConversation, archivedAt: now, archivedByUserId: userId } }, "archived"],
  ]) {
    const disabledFixture = createFixture();
    const disabledView = await renderComposer(disabledFixture, props);
    const disabledComposer = disabledView.container.querySelector("form.handrail-chat__composer");
    const disabledStatus = disabledView.container.querySelector('[role="status"]');
    assert.equal(disabledView.container.querySelector('button[type="submit"]').disabled, true);
    const formattingControls = disabledView.container.querySelectorAll(
      '[role="toolbar"][aria-label="Text formatting"] button',
    );
    assert.equal(formattingControls.length, 8);
    assert.equal([...formattingControls].every((control) => control.disabled), true);
    const originalText = disabledView.textarea().value;
    await clickElement(formattingControls[0]);
    assert.equal(disabledView.textarea().value, originalText);
    assert.equal(
      disabledFixture.calls.some(({ name }) => name === "replaceConversationDraft"),
      false,
    );
    assert.equal(disabledComposer.getAttribute("aria-disabled"), "true");
    assert.match(disabledStatus.textContent, new RegExp(reason, "i"));
    assert.match(disabledComposer.getAttribute("aria-describedby"), new RegExp(disabledStatus.id));
    if (props.readOnly === true) {
      assert.equal(disabledView.textarea().readOnly, true);
      assert.equal(disabledView.textarea().disabled, false);
      assert.equal(disabledComposer.getAttribute("data-read-only"), "true");
    }
    await disabledView.unmount();
  }

  const notReady = createFixture({ state: Object.freeze({ state: "idle" }) });
  const providerView = await renderComposer(notReady);
  assert.equal(providerView.textarea().disabled, true);
  assert.match(providerView.container.querySelector('[role="status"]').textContent, /chat unavailable/i);
  await providerView.unmount();

  const safety = await renderComposer(createFixture({ initialDraft: null }));
  await inputText(safety.textarea(), '<img src=x onerror="secret()"> bold');
  assert.equal(safety.container.querySelector("img"), null);
  const boldStart = safety.editor().textContent.indexOf("bold");
  selectEditorText(safety.editor(), boldStart, boldStart + "bold".length);
  await clickElement(safety.container.querySelector('[aria-label="Bold"]'));
  assert.equal(safety.textarea().value, '<img src=x onerror="secret()"> **bold**');
  assert.equal(safety.editor().querySelector("strong").textContent, "bold");
  assert.equal(safety.container.querySelector("img"), null);
  assert.equal(fixture.calls.some(({ name }) => name === "dangerouslySetInnerHTML"), false);
  await safety.unmount();
});
