import assert from "node:assert/strict";
import test from "node:test";

// Registered with the existing workspace fixture; discovery itself uses the real runtime.
export function registerDiscoveryTests(h) {
  const { createFixture, withReplyRouting, mount, workspace, click, keyDown, input, act, flush,
    publicId, privateId, threadId, rootMessageId, publicConversation, privateConversation,
    threadConversation, detail, timeline, message, now, userId, createElement, ChatWorkspace, ChatProvider, mounted } = h;
  const button = (container, text) => [...container.querySelectorAll("button")].find(b => b.textContent === text);
  const trigger = c => c.querySelector('[aria-label="Browse channel threads"]');
  const rowButton = (c, id = threadId) => c.querySelector(`[data-thread-id="${id}"]`);
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  async function setup({ rows, rootContext = "unavailable", style = "discord", response, ...props } = {}) {
    const { createThreadListRuntime } = await import("../dist/client/thread-list.js");
    const fixture = createFixture({ listedConversations: [publicConversation, privateConversation, { ...threadConversation, name: "Launch dates" }],
      messageRows: new Map([[publicId, []], [threadId, []]]) });
    const switchStyle = await withReplyRouting(fixture, { style });
    const item = (id = threadId, name = "Launch dates", following = false, read = 0) => ({
      thread: { ...threadConversation, id, ...(name === undefined ? {} : { name }), latestSequence: 4,
        currentMember: { ...threadConversation.currentMember, conversationId: id, state: "left" },
        currentReadState: { ...threadConversation.currentReadState, conversationId: id, lastReadSequence: read },
        currentPreference: { ...threadConversation.currentPreference, conversationId: id } },
      currentThreadFollow: { followRevision: 1, follow: { target: { type: "thread", id }, isFollowing: following, source: "manual", updatedAt: now } },
      lastActivityAt: now, hideAt: null,
    });
    const initial = rows?.(item) ?? [item()];
    const requests = [];
    let reply = response ?? (query => ({ status: "success", value: page(initial, { view: query.view }) }));
    function page(items = initial, extra = {}) { return { parentConversationId: publicId, view: "active", evaluatedAt: now, lifecycleSupported: false, items, ...extra }; }
    const runtime = createThreadListRuntime({ cache: fixture.cache, online: () => true,
      reader: { listThreads: async query => { requests.push(query); return reply(query); } } });
    fixture.client.threadList = runtime.api;
    let opening = { state: "idle", threadConversationId: threadId };
    const listeners = new Set();
    const publish = next => { opening = next; for (const listener of listeners) listener(next); };
    let openReply = async id => {
      const selected = initial.find(row => row.thread.id === id);
      fixture.cache.hydrateConversationDetail(detail(selected.thread));
      fixture.cache.hydrateMessageTimeline(timeline(id, []));
      if (rootContext === "deleted") fixture.cache.hydrateMessageTimeline(timeline(publicId, [message(rootMessageId, publicId, "", { content: null, deletedAt: now })]));
      const result = { state: "ready", threadConversationId: id, parentConversationId: publicId, rootMessageId, rootContext };
      publish(result); return result;
    };
    fixture.client.getExistingThreadOpeningState = () => opening;
    fixture.client.subscribeExistingThreadOpening = (_id, listener) => { listeners.add(listener); return () => listeners.delete(listener); };
    fixture.client.openExistingThread = async id => { fixture.calls.push({ name: "openExistingThread", args: [id] }); return openReply(id); };
    const container = await mount(workspace(fixture, { conversationId: publicId, ...props }));
    return { fixture, container, switchStyle, item, page, requests, runtime, publish,
      reply: fn => { reply = fn; }, openReply: fn => { openReply = fn; },
      async refresh() { await act(async () => { await runtime.api.refresh({ parentConversationId: publicId }); await flush(); }); },
      async browse() { await click(trigger(container)); },
      async settle(fn) { await act(async () => { fn(); await flush(); }); },
    };
  }
  const noWrites = fixture => assert.equal(fixture.calls.some(c => ["openThread", "createThread", "followThread", "unfollowThread", "markRead"].includes(c.name)), false);

  test("channel discovery opens authorized unfollowed canonical history without root or private writes", async () => {
    const h = await setup(); const { container, fixture } = h;
    const before = structuredClone(fixture.cache.getState().currentUser.readStates);
    await input(container.querySelector('[aria-label="Conversation composer"] textarea'), "parent draft");
    await h.browse();
    assert.match(rowButton(container).textContent, /Launch datesNot following4 unread/);
    assert.equal(button(container, "All threads"), undefined);
    noWrites(fixture);
    await click(rowButton(container));
    const panel = container.querySelector('[data-handrail-thread-panel]');
    assert.equal(panel.querySelector("h2").textContent, "Launch dates");
    assert.match(panel.textContent, /In Public channel · Root message unavailable/);
    assert.ok(panel.querySelector('[data-thread-conversation-id="conversation-thread"]'));
    assert.equal(container.querySelector('[aria-label="Conversation composer"] textarea').value, "parent draft");
    noWrites(fixture); assert.deepEqual(fixture.cache.getState().currentUser.readStates, before);
  });

  test("channel discovery legacy fallback and follow/read indicators remain independent", async () => {
    const h = await setup({ rows: item => [item("a", undefined, true, 4), item("b", "Unread followed", true, 0), item("c", "Read unfollowed", false, 4)] });
    // Explicitly omit legacy names (undefined invokes the helper's default argument).
    const legacy = h.item("a"); delete legacy.thread.name;
    h.reply(() => ({ status: "success", value: h.page([legacy, h.item("b", "Unread followed", true), h.item("c", "Read unfollowed", false, 4)]) }));
    await h.browse();
    assert.match(rowButton(h.container, "a").textContent, /Unnamed threadNot following4 unread/);
    assert.match(rowButton(h.container, "b").textContent, /Following4 unread/);
    assert.match(rowButton(h.container, "c").textContent, /Not following0 unread/);
    noWrites(h.fixture);
  });

  test("channel discovery pagination failure retains rows and retries the same page without duplicates", async () => {
    const { encodeThreadListCursor } = await import("../dist/contracts/thread-list.js");
    const h = await setup();
    const rows = Array.from({ length: 50 }, (_, i) => h.item(`thread-${String(i).padStart(2, "0")}`));
    const cursor = encodeThreadListCursor({ parentConversationId: publicId, view: "active", createdAt: now, threadId: "thread-49" });
    let failed = false;
    const nextPage = deferred();
    h.reply(query => query.cursor ? failed ? { status: "success", value: h.page([h.item("thread-50")]) } : nextPage.promise
      : { status: "success", value: h.page(rows, { nextCursor: cursor }) });
    await h.browse(); await click(button(h.container, "Load more threads"));
    assert.equal(h.container.querySelectorAll('[data-thread-id]').length, 50);
    assert.match(h.container.textContent, /Loading more threads/);
    await h.settle(() => nextPage.resolve({ status: "transport" }));
    assert.equal(h.container.querySelectorAll('[data-thread-id]').length, 50);
    assert.ok(button(h.container, "Retry threads")); failed = true;
    await click(button(h.container, "Retry threads"));
    assert.equal(h.container.querySelectorAll('[data-thread-id]').length, 51);
    assert.deepEqual(h.requests.slice(-2).map(r => r.cursor), [cursor, cursor]); noWrites(h.fixture);
  });

  test("channel discovery loading, error retry, empty refresh and unavailable states", async () => {
    const pending = deferred(); const h = await setup({ response: () => pending.promise }); await h.browse();
    assert.match(h.container.textContent, /Loading threads/);
    await h.settle(() => pending.resolve({ status: "transport", message: "SECRET" }));
    assert.ok(button(h.container, "Retry threads")); assert.doesNotMatch(h.container.textContent, /SECRET/);
    h.reply(() => ({ status: "success", value: h.page([]) })); await click(button(h.container, "Retry threads"));
    assert.match(h.container.textContent, /No threads yet/);
    h.reply(() => ({ status: "success", value: h.page([h.item()]) })); await click(button(h.container, "Refresh threads"));
    assert.ok(rowButton(h.container));
    await h.settle(() => h.runtime.revoke(publicId));
    assert.equal(rowButton(h.container), null); assert.match(h.container.textContent, /Channel threads are unavailable/);
  });

  for (const capability of ["lifecycle", "inactivity"]) test(`channel discovery capability-gated active/all uses server ${capability}`, async () => {
    const h = await setup();
    h.reply(query => ({ status: "success", value: h.page([], { view: query.view,
      ...(capability === "lifecycle" ? { lifecycleSupported: true } : { inactivityPolicy: { hideAfterMs: 1000 } }) }) }));
    await h.browse(); assert.ok(button(h.container, "Active threads"));
    await click(button(h.container, "All threads"));
    assert.equal(h.requests.at(-1).view, "all"); noWrites(h.fixture);
  });

  test("channel discovery Current compatibility, style switch and compact keyboard parent return", async t => {
    const previousObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      constructor(callback) { this.callback = callback; }
      observe(target) { if (target.classList.contains("handrail-chat--workspace")) this.callback([{ contentRect: { width: 320 } }]); }
      disconnect() {} unobserve() {}
    };
    t.after(() => { window.ResizeObserver = previousObserver; });
    const h = await setup({ style: "current", rows: item => [item("a"), item("b", "Second")] });
    assert.equal(h.container.querySelector(".handrail-chat--workspace").dataset.handrailCompactLayout, "true");
    assert.equal(trigger(h.container), null); await h.switchStyle("discord"); await h.browse();
    const a = rowButton(h.container, "a"), b = rowButton(h.container, "b");
    await h.settle(() => a.focus()); await keyDown(a, "ArrowDown"); assert.equal(document.activeElement, b);
    await keyDown(b, "Home"); assert.equal(document.activeElement, a);
    await keyDown(a, "End"); assert.equal(document.activeElement, b);
    await click(b);
    const threadComposer = h.container.querySelector('[data-handrail-thread-panel] textarea');
    await input(threadComposer, "thread draft");
    await h.switchStyle("current");
    assert.equal(h.container.querySelector('[data-handrail-thread-panel] textarea'), threadComposer);
    assert.equal(threadComposer.value, "thread draft");
    assert.ok(h.container.querySelector('[data-thread-conversation-id="b"]'));
    await keyDown(h.container.querySelector('[data-handrail-thread-panel]'), "Escape");
    assert.equal(document.activeElement, b);
    await keyDown(b, "Escape");
    assert.equal(h.container.querySelector('.handrail-chat__thread-list'), null);
    assert.equal(document.activeElement, h.container.querySelector("main"));
    noWrites(h.fixture);
  });

  test("channel discovery restores trigger on parent return and preserves custom thread renderer", async () => {
    const h = await setup(); await h.browse(); await click(button(h.container, "Back to Public channel"));
    assert.equal(document.activeElement, trigger(h.container));
    const custom = await setup({ renderThread: () => createElement("div", null, "Host thread") });
    assert.equal(trigger(custom.container), null); assert.match(custom.container.textContent, /Host thread/);
  });

  for (const change of ["back", "revoke", "wrong-parent", "wrong-root", "wrong-thread", "navigate", "identity", "client"]) test(`channel discovery rejects stale or unauthorized opening: ${change}`, async () => {
    const h = await setup(); const pending = deferred(); h.openReply(() => pending.promise); await h.browse();
    await click(rowButton(h.container));
    if (change === "back") await click(button(h.container, "Back to Public channel"));
    if (change === "revoke") await h.settle(() => h.runtime.revoke(publicId));
    if (change === "navigate" || change === "client") {
      const entry = mounted.find(entry => entry.container === h.container);
      await h.settle(() => entry.root.render(workspace(change === "client" ? createFixture() : h.fixture, { conversationId: privateId })));
    }
    if (change === "identity") await h.settle(() => h.fixture.cache.setIdentity({ tenantId: "new-tenant", userId: "new-user", sessionId: "new-session" }));
    await h.settle(() => pending.resolve({ state: "ready", threadConversationId: change === "wrong-thread" ? "other-thread" : threadId,
      parentConversationId: change === "wrong-parent" ? privateId : publicId,
      rootMessageId: change === "wrong-root" ? "other-root" : rootMessageId, rootContext: "unavailable" }));
    assert.equal(h.container.querySelector('[data-handrail-thread-panel]'), null); noWrites(h.fixture);
  });


  test("channel discovery denied refresh removes a selected cached history", async () => {
    const h = await setup(); await h.browse(); await click(rowButton(h.container));
    assert.ok(h.container.querySelector('[data-thread-conversation-id]'));
    h.reply(() => ({ status: "transport", httpStatus: 403 }));
    await h.refresh();
    assert.equal(h.container.querySelector('[data-handrail-thread-panel]'), null);
    assert.equal(rowButton(h.container), null);
    assert.match(h.container.textContent, /Channel threads are unavailable/);
    noWrites(h.fixture);
  });

  test("channel discovery deleted root, canonical retry and revoked history avoid creation reconciliation", async () => {
    const h = await setup({ rootContext: "deleted" }); await h.browse(); await click(rowButton(h.container));
    assert.match(h.container.querySelector('[data-handrail-thread-panel]').textContent, /This message was deleted/);
    await h.settle(() => h.publish({ state: "error", threadConversationId: threadId, code: "snapshot_failed", message: "unavailable" }));
    await click(button(h.container.querySelector('[data-handrail-thread-panel]'), "Retry"));
    assert.equal(h.fixture.calls.filter(c => c.name === "openExistingThread").length, 2);
    await h.settle(() => h.fixture.cache.dispatch({ type: "threads/discard-history", threadId }));
    assert.equal(h.container.querySelector('[data-thread-conversation-id]'), null);
    assert.doesNotMatch(h.container.querySelector('[data-handrail-thread-panel]').textContent, /Launch dates/); noWrites(h.fixture);
  });
}
