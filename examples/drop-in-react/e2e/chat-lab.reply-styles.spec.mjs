import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles", trace: "on" });

const QUESTION = "Which launch date?";
const THREAD = "Launch date decision";
const timeline = page => page.getByRole("region", { name: "Conversation timeline", exact: true });
const root = page => timeline(page).getByRole("article").filter({ hasText: QUESTION }).first();
const composer = page => page.getByLabel("Conversation composer", { exact: true }).getByRole("textbox");
const panel = page => page.getByRole("complementary", { name: THREAD, exact: true });
const threadIdentity = page => panel(page).locator("[data-thread-conversation-id]");
const settings = async page => {
  const details = page.locator(".chat-lab__reply-settings");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  return details.getByRole("combobox", { name: "Reply and thread style", exact: true });
};
const style = async (page, value) => {
  const select = await settings(page);
  await expect(select).toBeEnabled();
  if (value !== undefined) await select.selectOption(value);
  await expect(select).toHaveValue(value ?? "discord");
  await expect(page.locator(".chat-lab__reply-settings")).toContainText(`Effective style: ${value === "current" ? "Current" : "Discord-style"}`);
  await page.locator(".chat-lab__reply-settings summary").click();
};
const showChannel = async (page, origin, actor) => {
  await page.goto(`${origin}/chat-lab.html?actor=${actor}`);
  await expect(page.getByLabel("Mixed reply styles scenario")).toContainText("Switching style does not convert history");
  await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: /^Launch planning/ }).click();
  await expect(root(page)).toContainText(QUESTION);
  await expect(page.locator(".chat-lab__realtime-announcement")).toHaveAttribute("data-realtime-state", "connected");
};

// All persistence assertions below query the fixture's real, isolated PostgreSQL schema.
// The single POST barrier controls timing only; releasing it dispatches to the real server.
test("mixed styles preserve channel replies, canonical threads, drafts, queued destinations and retained history", async ({ chatLab, browser, page }, testInfo) => {
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const alice = await aliceContext.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const db = chatLab.harness.pool;
  const threads = async () => (await db.query("SELECT id, name, root_message_id, closed_at FROM chat_conversations WHERE type = 'thread'")).rows;
  const messages = async text => (await db.query("SELECT id, conversation_id, reply_to_message_id FROM chat_messages WHERE content->>'text' = $1", [text])).rows;
  const preferences = async () => (await db.query("SELECT user_id, style FROM chat_user_reply_style_preferences ORDER BY user_id")).rows;
  const completedCheckpoints = [];
  const lifecycleRows = [];
  const detailResponses = [];
  page.on("response", async response => {
    if (response.request().method() !== "GET" || !/\/api\/chat\/conversations\/[^/?]+$/.test(response.url())) return;
    const body = await response.json().catch(() => undefined);
    if (body?.conversation?.type === "thread") detailResponses.push(body.conversation);
  });
  const assertParentRoot = async viewer => {
    const row = timeline(viewer).locator(`[data-message-id="${chatLab.rootMessageId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    await expect(row).toContainText(QUESTION);
  };
  let releaseSend;
  try {
    await showChannel(page, chatLab.origin, "bob");
    await style(page, "discord");
    await showChannel(alice, chatLab.origin, "alice");
    await style(alice, "current");
    expect(await preferences()).toEqual([{ user_id: "alice", style: "current" }, { user_id: "bob", style: "discord" }]);

    await root(page).hover();
    await root(page).getByRole("button", { name: "Reply", exact: true }).click();
    await composer(page).fill("Friday");
    await page.getByLabel("Conversation composer", { exact: true }).getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => messages("Friday")).toHaveLength(1);
    for (const viewer of [page, alice]) {
      const friday = timeline(viewer).getByRole("article").filter({ hasText: "Friday" });
      await expect(friday).toContainText("Friday");
      await expect(friday.getByRole("button", { name: /Jump to original message.*Alice.*Which launch date/ })).toBeVisible();
    }
    await expect.poll(() => messages("Friday")).toEqual([{ id: expect.any(String), conversation_id: chatLab.conversationId, reply_to_message_id: chatLab.rootMessageId }]);
    expect(await threads()).toEqual([]);
    completedCheckpoints.push("Live mixed-style Friday rendering; SQL channel destination/source; zero threads");

    // A style change retains the existing draft and source, and never converts history.
    await root(page).hover();
    await root(page).getByRole("button", { name: "Reply", exact: true }).click();
    await composer(page).fill("Queued launch confirmation");
    await style(page, "current");
    await expect(composer(page)).toHaveText("Queued launch confirmation");
    await expect(page.getByLabel("Conversation composer", { exact: true })).toContainText(QUESTION);

    const endpoint = `${chatLab.origin}/api/chat/conversations/${chatLab.conversationId}/messages`;
    let heldRequest;
    const held = new Promise(resolve => { heldRequest = resolve; });
    const barrier = new Promise(resolve => { releaseSend = resolve; });
    await page.route(endpoint, async route => {
      if (route.request().method() !== "POST") return route.continue();
      heldRequest(route.request().postDataJSON());
      await barrier;
      await route.continue();
    });
    await page.getByLabel("Conversation composer", { exact: true }).getByRole("button", { name: "Send message", exact: true }).click();
    const request = await held;
    const queued = await page.evaluate(() => Object.entries(sessionStorage)
      .filter(([key]) => key.endsWith(":queued_send_message_intents"))
      .map(([, value]) => JSON.parse(value)));
    const queuedIntents = queued.flatMap(record => record.payload.intents);
    const { operation: _operation, ...wireRequest } = request;
    expect(queuedIntents).toEqual([expect.objectContaining(wireRequest)]);
    expect(await messages("Queued launch confirmation")).toEqual([]);
    await style(page, "discord");
    releaseSend();
    await expect.poll(() => messages("Queued launch confirmation")).toEqual([{ id: expect.any(String), conversation_id: chatLab.conversationId, reply_to_message_id: chatLab.rootMessageId }]);
    expect(request).toMatchObject({ conversationId: chatLab.conversationId, replyTo: { messageId: chatLab.rootMessageId } });
    expect(await threads()).toEqual([]);
    expect(await preferences()).toEqual([{ user_id: "alice", style: "current" }, { user_id: "bob", style: "discord" }]);
    await page.reload();
    await style(page, "discord");
    await expect(root(page)).toBeVisible();
    completedCheckpoints.push("Retained draft/source during style switch; durable queued send kept channel/source; Bob preference reload");
    await testInfo.attach("mixed-replies-before-named-thread", {
      body: await page.screenshot({ fullPage: true }), contentType: "image/png",
    });

    await root(page).hover();
    await root(page).getByRole("button", { name: "Create Thread", exact: true }).click();
    const creation = page.getByRole("dialog", { name: "Create Thread", exact: true });
    await creation.getByLabel("Thread name").fill(THREAD);
    await creation.getByRole("button", { name: "Create Thread", exact: true }).click();
    await expect.poll(threads).toEqual([{ id: expect.any(String), name: THREAD, root_message_id: chatLab.rootMessageId, closed_at: null }]);
    const threadId = (await threads())[0].id;
    completedCheckpoints.push("SQL explicit named creation: exactly one thread for Alice's root");
    await expect(panel(page)).toBeVisible();
    await expect(threadIdentity(page)).toHaveAttribute("data-thread-conversation-id", threadId);
    await expect.poll(() => detailResponses.find(value => value.id === threadId)).toMatchObject({
      id: threadId, name: THREAD, rootMessageId: chatLab.rootMessageId,
      parentConversationId: chatLab.conversationId, threadLifecycle: { revision: expect.any(Number), locked: false },
    });
    await assertParentRoot(page);
    completedCheckpoints.push("Named panel and HTTP detail retain canonical ID, name/lifecycle and one visible parent root");
    await panel(page).getByRole("textbox", { name: "Reply to thread" }).fill("Keep this discussion history");
    await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => messages("Keep this discussion history")).toEqual([{ id: expect.any(String), conversation_id: threadId, reply_to_message_id: null }]);

    // Current Reply opens the same discussion; the other user's setting is untouched.
    await root(alice).hover();
    await root(alice).getByRole("button", { name: "Reply", exact: true }).click();
    await expect(threadIdentity(alice)).toHaveAttribute("data-thread-conversation-id", threadId);
    await expect(panel(alice)).toContainText("Keep this discussion history");
    await assertParentRoot(alice);
    completedCheckpoints.push("Current Reply opens the same canonical named discussion and history");
    await panel(alice).getByRole("button", { name: "Close panel", exact: true }).click();

    await panel(page).getByRole("button", { name: "Close thread", exact: true }).click();
    await expect.poll(async () => (await threads())[0].closed_at !== null).toBe(true);
    lifecycleRows.push({ phase: "closed", rows: await threads() });
    // Shared lifecycle is visible to Alice despite her different presentation setting.
    await root(alice).hover();
    await root(alice).getByRole("button", { name: "Reply", exact: true }).click();
    await expect(panel(alice).getByRole("button", { name: "Reopen thread", exact: true })).toBeVisible();
    await panel(alice).getByRole("button", { name: "Reopen thread", exact: true }).click();
    await expect.poll(async () => (await threads())[0].closed_at).toBeNull();
    lifecycleRows.push({ phase: "reopened", rows: await threads() });
    await expect(panel(page).getByRole("button", { name: "Close thread", exact: true })).toBeVisible();
    await panel(page).getByRole("button", { name: "Leave", exact: true }).click();
    await expect(panel(page).getByRole("button", { name: "Join", exact: true })).toBeVisible();
    await expect(panel(page)).toContainText("Keep this discussion history");
    await expect.poll(async () => (await db.query("SELECT is_following FROM chat_thread_follows WHERE conversation_id=$1 AND user_id='bob'", [threadId])).rows).toEqual([{ is_following: false }]);
    expect((await messages("Keep this discussion history"))[0].conversation_id).toBe(threadId);
    await panel(page).getByRole("button", { name: "Close panel", exact: true }).click();

    // Channel discovery and the source both resolve the one canonical thread ID.
    await page.getByRole("button", { name: "Browse channel threads", exact: true }).click();
    const discovery = page.getByRole("region", { name: "Threads in Launch planning" });
    await discovery.locator(`[data-thread-id="${threadId}"]`).click();
    await expect(threadIdentity(page)).toHaveAttribute("data-thread-conversation-id", threadId);
    await expect(panel(page)).toContainText("Keep this discussion history");
    await panel(page).getByRole("button", { name: "Back to channel threads", exact: true }).click();
    await page.getByRole("button", { name: "Back to Launch planning", exact: true }).click();
    await assertParentRoot(page);
    expect(await threads()).toEqual([{ id: threadId, name: THREAD, root_message_id: chatLab.rootMessageId, closed_at: null }]);
    await testInfo.attach("named-thread-retained-history", { body: await alice.screenshot({ fullPage: true }), contentType: "image/png" });

    completedCheckpoints.push("Canonical root/discovery opening, shared reopen, retained Leave history");
  } finally {
    releaseSend?.();
    await testInfo.attach("browser-proof", {
      body: JSON.stringify({ completedCheckpoints, detailResponses }, null, 2), contentType: "application/json",
    });
    await testInfo.attach("postgres-proof", {
      body: JSON.stringify({ backend: chatLab.harness.backendKind, lifecycleRows,
        schema: chatLab.harness.schema, threads: await threads(), friday: await messages("Friday"),
        queued: await messages("Queued launch confirmation"), history: await messages("Keep this discussion history"),
        follows: (await db.query("SELECT conversation_id, user_id, is_following FROM chat_thread_follows ORDER BY conversation_id, user_id")).rows,
        preferences: await preferences() }, null, 2),
      contentType: "application/json",
    });
    await aliceContext.close();
  }
});
