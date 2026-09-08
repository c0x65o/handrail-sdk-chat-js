import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Window } from "happy-dom";
process.env.NODE_ENV = "test";
const window = new Window({ url: "https://reply-style.example.test" });
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useEffect, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const compiled = process.env.HANDRAIL_REPLY_STYLE_BUILD;
assert.ok(compiled, "Run node scripts/test-react-reply-style.mjs");
const { ChatContext, ChatProvider, useReplyStyle, useReplyStyleActions } = await import(`${compiled}/react/index.js`);
const { ReplyStyleSettings } = await import(`${compiled}/ui/index.js`);
const { createReplyStyleRuntime } = await import(`${compiled}/client/reply-style-runtime.js`);
const { createChatClient, createNormalizedChatCache, createApplicationChatStorage, CHAT_CLIENT_PACKAGE_VERSION } = await import(`${compiled}/client/index.js`);
const { CHAT_PROTOCOL_VERSION } = await import(`${compiled}/contracts/realtime.js`);
const identity = { tenantId: "tenant", userId: "alice", sessionId: "session" };
const absent = { state: "absent", revision: 0 };
const saved = (revision, style = "discord") => ({ state: "saved", revision, style });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const result = (input, preference = saved(input.baseRevision + 1, input.style), reconciliationStatus = "applied") => ({
  operation: input.operation, baseRevision: input.baseRevision, idempotencyKey: input.idempotencyKey,
  requestedStyle: input.style, preference, reconciliationStatus,
});
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const mounted = [];
async function mount(element) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  await act(async () => { root.render(element); await flush(); });
  return { container, root, render: async value => { await act(async () => { root.render(value); await flush(); }); } };
}
afterEach(async () => { for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); } });
async function choose(container, value) {
  const select = container.querySelector("select"); assert.ok(!select.disabled);
  await act(async () => { select.value = value; select.dispatchEvent(new window.Event("change", { bubbles: true })); await flush(); });
}
async function retry(container) {
  const button = container.querySelector("button"); assert.ok(button && !button.disabled);
  await act(async () => { button.click(); await flush(); });
}
function harness({ preference = absent, configuration, features = { reply_style_preference_v1: true }, read, dispatch } = {}) {
  let canonical = preference, online = true, key = 0;
  const calls = [];
  const runtime = createReplyStyleRuntime({ cache: createNormalizedChatCache(identity), configuration,
    enabledFeatures: () => features === null ? undefined : features, online: () => online, generateIdempotencyKey: () => `key-${++key}`,
    reader: { getReplyStylePreference: async () => { calls.push("read"); return await read?.() ?? { status: "success", value: canonical }; } },
    dispatch: async (_command, input) => { calls.push(input); return await dispatch?.(input) ?? { status: "success", value: result(input) }; },
  });
  const context = { client: { replyStyle: runtime.api }, isReady: true };
  return { runtime, api: runtime.api, context, calls,
    view: child => createElement(ChatContext.Provider, { value: context }, child ?? createElement(ReplyStyleSettings)),
    canonical: value => { canonical = value; },
    online: value => { online = value; runtime.connectionChanged(value); },
  };
}
for (const [configuration, preference, style, origin] of [
  [{}, absent, "Current", "SDK default"],
  [{ hostDefault: "discord" }, absent, "Discord-style", "app default"],
  [{ hostDefault: "discord" }, saved(1, "current"), "Current", "saved preference"],
  [{ enforcedOverride: "current" }, saved(1), "Current", "enforced by this app"],
  [{ hostDefault: "discord" }, saved(1, "future"), "Current", "saved preference"],
]) test(`renders runtime precedence ${JSON.stringify(configuration)} ${preference.style ?? "absent"}`, async () => {
  const h = harness({ configuration, preference }); const { container } = await mount(h.view());
  assert.ok(container.textContent.includes(`Effective style: ${style} — ${origin}.`));
  assert.equal(container.querySelector("select").disabled, configuration.enforcedOverride !== undefined);
  assert.equal(container.textContent.includes("No saved choice."), preference.state === "absent");
  if (configuration.enforcedOverride) assert.match(container.textContent, /Saved choice: Discord-style/);
  if (preference.style === "future") assert.match(container.textContent, /unsupported style value/);
  const select = container.querySelector("select"), label = container.querySelector("label");
  assert.equal(label.htmlFor, select.id); assert.equal(label.textContent, "Reply and thread style");
  for (const id of select.getAttribute("aria-describedby").split(" ")) assert.ok(document.getElementById(id));
  assert.deepEqual([...select.options].map(o => o.textContent), ["Current", "Discord-style"]);
  assert.ok(container.querySelector('[role="status"][aria-live="polite"]'));
});

test("requested selection stays saving until confirmation; reload and reconnect update authority", async () => {
  const gate = deferred(); const h = harness({ dispatch: () => gate.promise });
  const { container } = await mount(h.view()); await choose(container, "discord");
  assert.match(container.textContent, /Saving: Discord-style/);
  assert.match(container.textContent, /Effective style: Current/);
  assert.doesNotMatch(container.textContent, /save confirmed/);
  assert.equal(container.querySelector("select").disabled, true);
  await act(async () => { gate.resolve({ status: "success", value: result(h.calls.at(-1)) }); await flush(); });
  assert.match(container.textContent, /Effective style: Discord-style/);
  assert.match(container.textContent, /save confirmed/);
  h.canonical(saved(2, "current")); await act(async () => { await h.api.load(); });
  assert.match(container.textContent, /Effective style: Current/);
  await act(async () => h.online(false)); assert.match(container.textContent, /offline, reconnect/);
  h.canonical(saved(3)); await act(async () => { h.online(true); await flush(); });
  assert.match(container.textContent, /Effective style: Discord-style/);
});

test("unresolved loading is not absence; failed read is safe and explicitly retryable", async () => {
  const gate = deferred(); let fail = true;
  const h = harness({ configuration: { hostDefault: "discord" }, read: () => fail ? gate.promise : undefined });
  const { container } = await mount(h.view());
  assert.match(container.textContent, /Loading your saved reply style/);
  assert.match(container.textContent, /not yet confirmed/); assert.doesNotMatch(container.textContent, /No saved choice/);
  await act(async () => { gate.resolve({ status: "transport", error: "PRIVATE DATA" }); await flush(); });
  assert.match(container.querySelector('[role="alert"]').textContent, /Could not load/);
  assert.doesNotMatch(container.textContent, /PRIVATE DATA/); assert.equal(container.querySelector("select").disabled, true);
  fail = false; await retry(container); assert.match(container.textContent, /No saved choice/);
  assert.match(container.textContent, /Effective style: Discord-style — app default/);
});

test("failed uncertain save uses reconciliation-aware retry and retains confirmed style", async () => {
  let fail = true; const h = harness({ dispatch: () => fail ? { status: "transport", error: "PRIVATE DATA" } : undefined });
  const { container } = await mount(h.view()); await choose(container, "discord");
  assert.match(container.textContent, /Requested choice \(unconfirmed\): Discord-style/);
  assert.match(container.textContent, /Effective style: Current/);
  assert.ok(container.querySelector('[role="alert"]')); assert.doesNotMatch(container.textContent, /PRIVATE DATA|save confirmed/);
  const original = h.calls.at(-1); fail = false; await retry(container);
  assert.equal(h.calls.at(-2), "read"); assert.deepEqual(h.calls.at(-1), original);
  assert.match(container.textContent, /Effective style: Discord-style/); assert.equal(container.querySelector('[role="alert"]'), null);
});

test("conflict shows authoritative choice and explicit retry creates a new mutation", async () => {
  let fail = true;
  const h = harness({ dispatch: input => fail ? { status: "success", value: result(input, saved(4, "current"), "preference_revision_conflict") } : undefined });
  const { container } = await mount(h.view()); await choose(container, "discord");
  assert.match(container.textContent, /changed elsewhere/); assert.match(container.textContent, /Effective style: Current/);
  fail = false; await retry(container); assert.equal(h.calls.at(-1).baseRevision, 4);
  assert.match(container.textContent, /save confirmed/);
});

for (const features of [null, {}, { inlineReplies: true, namedThreads: true }]) test(`persistence gating is independent ${JSON.stringify(features)}`, async () => {
  const h = harness({ features }); const { container } = await mount(h.view());
  assert.equal(container.querySelector("select").disabled, true);
  assert.match(container.textContent, features === null ? /Checking whether this server/ : /Saving reply style is unavailable/); assert.equal(h.calls.length, 0);
});

test("offline read explains recovery without claiming absence or saving", async () => {
  const h = harness(); h.online(false); const { container } = await mount(h.view());
  assert.match(container.textContent, /offline/); assert.doesNotMatch(container.textContent, /No saved choice/);
  assert.equal(container.querySelector("select").disabled, true);
  assert.equal(container.querySelector("button").disabled, true);
  await act(async () => { h.online(true); await flush(); });
  assert.equal(container.querySelector("select").disabled, false);
});

test("hooks replace subscriptions and actions with the context client and clean up on unmount", async () => {
  const first = harness(), second = harness({ preference: saved(2) });
  let subscriptions = 0, cleanups = 0, actions, observed;
  for (const h of [first, second]) {
    h.context.client = { replyStyle: { ...h.api, subscribe(listener) {
      subscriptions++; const stop = h.api.subscribe(listener); return () => { cleanups++; stop(); };
    } } };
  }
  function Probe() { observed = useReplyStyle(); actions = useReplyStyleActions(); return null; }
  const m = await mount(first.view(createElement(Probe))); const firstActions = actions;
  await m.render(second.view(createElement(Probe)));
  assert.equal(observed.effectiveStyle, "discord"); assert.notEqual(actions, firstActions);
  assert.equal(subscriptions, 2); assert.equal(cleanups, 1);
  await act(async () => { first.api.configure({ enforcedOverride: "current" }); await actions.update("current"); });
  assert.equal(observed.effectiveStyle, "current"); assert.equal(second.calls.at(-1).style, "current");
  await m.render(null); assert.equal(cleanups, 2);
});

const metadata = () => ({ packageVersion: CHAT_CLIENT_PACKAGE_VERSION, protocolVersion: CHAT_PROTOCOL_VERSION, schemaVersion: 1,
  enabledFeatures: { reply_style_preference_v1: true }, supportedProtocolRange: { minimumVersion: CHAT_PROTOCOL_VERSION, maximumVersion: CHAT_PROTOCOL_VERSION } });
test("settings selection and retry preserve a mounted composer, populated draft, open thread and queued destination", async () => {
  const { readFile } = await import("node:fs/promises");
  const item = JSON.parse(await readFile(new URL("fixtures/thread-list.json", import.meta.url), "utf8")).base.items[0];
  const actor = { tenantId: item.thread.tenantId, userId: item.thread.currentMember.userId, sessionId: "session" };
  item.thread.currentMember.state = "active";
  const cache = createNormalizedChatCache(actor), rows = new Map(), requests = [];
  const storage = createApplicationChatStorage({ read: async (_id, kind) => rows.get(kind) ?? null,
    replace: async (_id, kind, value) => { rows.set(kind, value); }, remove: async (_id, kind) => rows.delete(kind), clearForLogout: async () => rows.clear() });
  let writes = 0;
  const client = createChatClient({ endpoint: "/chat", cache, getAccessToken: () => "token",
    normalizedCachePersistence: { storage, resolveIdentity: () => ({ tenantId: actor.tenantId, userId: actor.userId, deviceId: "device" }) },
    drafts: { timer: { schedule: () => 1, cancel() {} } }, commands: { retry: { maxAttempts: 1 } },
    optimisticMessages: { generateClientMessageId: () => "queued", generateIdempotencyKey: () => "queued-key" },
    fetch: async (url, init) => {
      requests.push({ url, method: init.method });
      if (url.endsWith("/_meta")) return response(metadata());
      if (url.endsWith("/preferences/reply-style")) {
        if (init.method === "GET") return response(absent);
        const input = JSON.parse(init.body);
        return ++writes === 1 ? response(result(input, saved(3, "current"), "preference_revision_conflict"), 409) : response(result(input));
      }
      if (url.endsWith(`/conversations/${item.thread.id}`)) return response({ kind: "conversation_detail",
        _meta: { ...metadata(), feature: { name: "conversation_snapshots", version: 1 } },
        conversation: { ...item.thread, memberUserIds: [], currentThreadFollow: item.currentThreadFollow } });
      if (url.includes("/messages?")) return response({ conversationId: url.includes(`/${item.thread.id}/`) ? item.thread.id : item.thread.parentConversationId,
        messages: [], pagination: { older: { available: false }, newer: { available: false } }, replay: { resumeFrom: { eventId: "snapshot" } } });
      throw new Error("offline send");
    },
  });
  try {
    await client.start(); await client.replyStyle.load();
    assert.equal((await client.openExistingThread(item.thread.id)).state, "ready");
    const content = { format: "plain", text: "keep", attachments: [{ attachmentId: "retained-upload" }], replyTo: { messageId: "source", notifyAuthor: false } };
    client.replaceConversationDraft({ conversationId: item.thread.id, content });
    await client.sendMessage({ conversationId: item.thread.id, content: { format: "plain", text: "pending" }, replyTo: { messageId: "source", notifyAuthor: false } });
    const draft = client.selectConversationDraft(item.thread.id).draft;
    const queue = client.getSendMessageQueueState().intents;
    const opening = client.getExistingThreadOpeningState(item.thread.id);
    const messages = cache.getState().entities.messages;
    assert.equal(queue.length, 1);
    assert.deepEqual(draft.content.replyTo, { messageId: "source", notifyAuthor: false });
    assert.deepEqual(queue[0].request.replyTo, { messageId: "source", notifyAuthor: false });
    assert.equal(queue[0].request.conversationId, item.thread.id);
    let mounts = 0, unmounts = 0;
    function ComposerSentinel() {
      useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
      return createElement("textarea", { defaultValue: draft.content.text });
    }
    const { container } = await mount(createElement(ChatProvider, { client },
      createElement(ComposerSentinel), createElement(ReplyStyleSettings)));
    const composer = container.querySelector("textarea");
    const count = requests.length;
    await choose(container, "discord");
    assert.equal(client.replyStyle.getState().saveStatus, "conflict");
    await retry(container);
    assert.equal(client.replyStyle.getState().saveStatus, "saved");
    await act(async () => {
      client.replyStyle.configure({ enforcedOverride: "current" }); client.replyStyle.configure({});
      await client.replyStyle.load();
    });
    assert.equal(container.querySelector("textarea"), composer);
    assert.equal(composer.value, "keep");
    assert.equal(mounts, 1); assert.equal(unmounts, 0);
    assert.deepEqual(client.selectConversationDraft(item.thread.id).draft, draft);
    assert.deepEqual(client.getSendMessageQueueState().intents, queue);
    assert.deepEqual(client.getExistingThreadOpeningState(item.thread.id), opening);
    assert.deepEqual(cache.getState().entities.messages, messages);
    assert.ok(requests.slice(count).every(r => r.url.endsWith("/preferences/reply-style")));
  } finally { await act(async () => client.close()); }
});

test("canonical subscription and host override updates stay visible without persistence side effects", async () => {
  const h = harness(); const { container } = await mount(h.view());
  const event = { eventId: "style-event", protocolVersion: CHAT_PROTOCOL_VERSION, tenantId: identity.tenantId,
    streamId: `user:${identity.userId}`, type: "reply.style.updated", occurredAt: "2030-01-01T00:00:00.000Z",
    payload: { actorUserId: identity.userId, preference: saved(3), updatedAt: "2030-01-01T00:00:00.000Z" } };
  await act(async () => h.runtime.handleCanonicalEvent(event));
  assert.match(container.textContent, /Effective style: Discord-style — saved preference/);
  assert.doesNotMatch(container.textContent, /save confirmed/);
  await act(async () => h.api.configure({ enforcedOverride: "current" }));
  assert.match(container.textContent, /Effective style: Current — enforced by this app/);
  assert.match(container.textContent, /Saved choice: Discord-style/);
  await act(async () => h.api.configure({}));
  assert.match(container.textContent, /Effective style: Discord-style/);
  assert.deepEqual(h.calls, ["read"]);
});

test("enabled native choice stays keyboard accessible inside a StrictMode dialog", async () => {
  const { ReplyStyleSettingsDialog } = await import(`${compiled}/ui/reply-style-settings.js`);
  const h = harness(); let closed = 0;
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  const m = await mount(h.view(createElement(StrictMode, null, createElement(ReplyStyleSettingsDialog, { onClose: () => closed++ }))));
  const { container } = m; const dialog = container.querySelector('[role="dialog"]');
  assert.equal(document.activeElement, dialog);
  async function key(target, name, shiftKey = false) {
    const event = new window.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event)); return event;
  }
  await key(dialog, "Tab"); const select = container.querySelector("select");
  assert.equal(document.activeElement, select);
  // happy-dom does not implement native select key defaults. Verify the key is
  // left to the browser, then dispatch the native change it would produce.
  assert.equal((await key(select, "ArrowDown")).defaultPrevented, false);
  await choose(container, "discord"); assert.match(container.textContent, /Effective style: Discord-style/);
  await key(select, "Tab", true); const close = container.querySelector("button");
  assert.equal(document.activeElement, close); await key(close, "Tab"); assert.equal(document.activeElement, select);
  await key(select, "Escape"); assert.equal(closed, 1);
  await m.render(null); await flush(); assert.equal(document.activeElement, trigger); trigger.remove();
});
