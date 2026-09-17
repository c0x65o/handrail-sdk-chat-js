import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles", trace: "on" });

test("saved reply style restores before writes and after a real socket reconnect", async ({ page, chatLab }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Observe actual browser sockets; close the transport, never synthesize SDK state.
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__restorationSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.__restorationSockets.push(this); }
    };
  });
  const writes = [];
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url().includes("reply-style")) writes.push(request.postDataJSON());
  });
  const db = chatLab.harness.pool;
  const preferences = async () => (await db.query("SELECT user_id, style FROM chat_user_reply_style_preferences ORDER BY user_id")).rows;
  const initialPreferences = await preferences();
  expect(initialPreferences).toEqual([{user_id:"alice",style:"current"},{user_id:"bob",style:"discord"}]);
  const settings = page.locator(".chat-lab__reply-settings");
  const select = settings.getByRole("combobox", { name: "Reply and thread style", exact: true });
  const measurements = [];
  const measure = async phase => {
    measurements.push({ phase, ...await page.getByRole("navigation", {name:"Conversations"}).evaluate(nav => {
      const bounds = element => { const r=element.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; };
      return {scrollLeft:nav.scrollLeft,clientWidth:nav.clientWidth,scrollWidth:nav.scrollWidth,bounds:bounds(nav),children:[...nav.querySelectorAll(".handrail-chat__navigation-header, .handrail-chat__navigation-actions, .chat-lab__reply-settings, .chat-lab__reply-settings select")].filter(element=>element.getClientRects().length).map(element=>({class:element.className,...bounds(element)}))};
    }) });
  };
  const readChoice = async phase => {
    await measure(`${phase}:before`);
    await settings.locator("summary").click();
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue("discord");
    await expect(settings).toContainText("Effective style: Discord-style");
    await measure(`${phase}:open`);
    if (phase === "reconnect") await testInfo.attach("saved-choice-after-reconnect", {
      body: await page.screenshot({ fullPage: false }), contentType: "image/png",
    });
    await settings.locator("summary").click();
    await measure(`${phase}:closed`);
  };
  try {
    await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
    await expect(page.locator(".chat-lab__realtime-announcement")).toHaveAttribute("data-realtime-state", "connected");
    await readChoice("initial");
    await page.reload();
    await readChoice("reload"); // Deliberately no selection/write before this assertion.
    expect(writes).toEqual([]);
    expect(await preferences()).toEqual(initialPreferences);
    await expect(page.locator(".chat-lab__realtime-announcement")).toHaveAttribute("data-realtime-state", "connected");
    const before = await page.evaluate(() => window.__restorationSockets.length);
    await page.evaluate(() => window.__restorationSockets.filter(socket => new URL(socket.url).pathname.startsWith("/api/chat")).forEach(socket => socket.close(4000, "QA transport disconnect")));
    await expect.poll(() => page.evaluate(() => window.__restorationSockets.length)).toBeGreaterThan(before);
    await expect(page.locator(".chat-lab__realtime-announcement")).toHaveAttribute("data-realtime-state", "connected");
    await readChoice("reconnect");
    expect(writes).toEqual([]);
    expect(await preferences()).toEqual(initialPreferences);

    const timeline = page.getByRole("region", {name:"Conversation timeline",exact:true});
    const source = timeline.locator(`[data-message-id="${chatLab.rootMessageId}"]`);
    await expect(source).toBeVisible();
    await source.hover();
    await source.getByRole("button", {name:"Reply",exact:true}).click();
    const composer = page.getByLabel("Conversation composer",{exact:true});
    await composer.getByRole("textbox").fill("Restored routing after reconnect");
    await composer.getByRole("button",{name:"Send message",exact:true}).click();
    await expect.poll(async () => (await db.query("SELECT conversation_id, reply_to_message_id FROM chat_messages WHERE content->>'text'=$1", ["Restored routing after reconnect"])).rows).toEqual([{conversation_id:chatLab.conversationId,reply_to_message_id:chatLab.rootMessageId}]);
    expect((await db.query("SELECT id FROM chat_conversations WHERE type='thread'")).rows).toEqual([]);
    const reply = timeline.getByRole("article").filter({hasText:"Restored routing after reconnect"});
    await reply.getByRole("button",{name:/Jump to original message/}).click();
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute("data-message-id", chatLab.rootMessageId);
    await expect(source).toBeFocused();
    expect(await preferences()).toEqual(initialPreferences);
    await testInfo.attach("restored-replies",{body:await page.screenshot({fullPage:false}),contentType:"image/png"});
    for (const measurement of measurements) {
      expect(measurement.scrollLeft, measurement.phase).toBe(0);
      for (const child of measurement.children) {
        expect(child.left, measurement.phase).toBeGreaterThanOrEqual(measurement.bounds.left);
        expect(child.right, measurement.phase).toBeLessThanOrEqual(measurement.bounds.right);
      }
    }
  } finally {
    await testInfo.attach("restoration-proof",{body:JSON.stringify({measurements,writes,initialPreferences,preferences:await preferences()},null,2),contentType:"application/json"});
  }
});
