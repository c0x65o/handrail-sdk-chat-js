import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

const timeline = page => page.getByRole("region", { name: "Conversation timeline", exact: true });
const composer = page => page.getByLabel("Conversation composer", { exact: true });
const connected = page => expect(page.locator(".chat-lab__realtime-announcement"))
  .toHaveAttribute("data-realtime-state", "connected");
const flutterCall = (page, operation) => page.evaluate(async operation =>
  JSON.parse(await window.handrailBackendLab(JSON.stringify({ operation }))), operation);

test("React retains Alice's root across actor switching, Flutter named creation and reconnect", async ({ chatLab, browser, page }, info) => {
  const flutterContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const flutter = await flutterContext.newPage();
  const root = () => timeline(page).locator(`[data-message-id="${chatLab.rootMessageId}"]`);
  const checkpoints = [];
  const frames = [];
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload));
      if (["thread.created", "message.thread_summary.updated"].includes(frame.type)) frames.push(frame);
    } catch { /* Vite also uses a websocket. */ }
  }));
  // Control only the transport boundary; all HTTP/SQL/event handling is real.
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.rootRegressionSockets = [];
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes("/api/chat")) window.rootRegressionSockets.push(this);
      }
    };
  });
  const assertRoot = async checkpoint => {
    await connected(page);
    await expect(root()).toHaveCount(1);
    await expect(root()).toBeVisible();
    await expect(root()).toContainText("Which launch date?");
    await expect(root().getByRole("button", { name: /0 replies/ })).toBeVisible();
    checkpoints.push(checkpoint);
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
    await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: /^Launch planning/ }).click();
    await connected(page);
    const settings = page.locator(".chat-lab__reply-settings");
    await settings.locator("summary").click();
    await settings.getByRole("combobox", { name: "Reply and thread style", exact: true }).selectOption("discord");
    await expect(settings).toContainText("Effective style: Discord-style");
    await settings.locator("summary").click();
    await root().hover();
    await root().getByRole("button", { name: "Reply", exact: true }).click();
    await composer(page).getByRole("textbox").fill("Friday");
    await composer(page).getByRole("button", { name: "Send message", exact: true }).click();
    await expect(timeline(page).getByRole("article").filter({ hasText: "Friday" })).toHaveCount(1);
    await root().hover();
    await root().getByRole("button", { name: "Create Thread", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create Thread", exact: true });
    await dialog.getByLabel("Thread name").fill("Launch date decision");
    await dialog.getByRole("button", { name: "Create Thread", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Launch date decision", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    await assertRoot("React Bob created the first named thread");

    await flutter.goto(`${chatLab.origin}/__flutter-chat-lab/?actor=bob`);
    await flutter.waitForFunction(() => typeof window.handrailBackendLab === "function");
    await flutter.locator("flt-semantics-placeholder").evaluate(e => e.click());
    await expect.poll(async () => (await flutterCall(flutter, "status")).realtime).toBe("connected");
    const flutterRoot = flutter.getByRole("group", { name: /^Message 1 from alice Which launch date/ });
    await flutterRoot.getByRole("button", { name: "Reply", exact: true }).click();
    const flutterInput = flutter.getByRole("textbox", { name: "Write a message", exact: true }).last();
    await flutterInput.fill("Friday");
    await flutter.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(timeline(page).getByRole("article").filter({ hasText: "Friday" })).toHaveCount(2);
    await flutter.getByRole("group", { name: /^Message \d+ from bob Friday/ }).last()
      .getByRole("button", { name: "Create Thread", exact: true }).click();
    await flutter.getByRole("textbox", { name: "Thread name", exact: true }).fill("Flutter second discussion");

    await page.getByRole("button", { name: "Development fixture identity: Bob", exact: true }).click();
    await Promise.all([
      page.locator('[data-actor-id="alice"]').click(),
      flutter.getByRole("button", { name: "Create Thread", exact: true }).last().click(),
    ]);
    await expect(flutter.getByRole("banner", { name: "Flutter second discussion", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Development fixture identity: Alice", exact: true })).toBeVisible();
    await assertRoot("Alice retained the root while Flutter created a second named thread");
    await expect(timeline(page).getByRole("article").filter({ hasText: "Friday" })).toHaveCount(2);
    await expect.poll(() => frames.filter(f => f.type === "message.thread_summary.updated").length).toBeGreaterThan(0);

    // Allow inline previews to resolve, then reproduce the isolated eviction boundary.
    await expect(timeline(page).getByRole("button", { name: /Jump to original message.*Alice.*Which launch date/ })).toHaveCount(2);
    await page.evaluate(id => {
      window.rootRegressionMissing = false;
      new MutationObserver(() => {
        if (!document.querySelector(`[data-message-id="${id}"]`)) window.rootRegressionMissing = true;
      }).observe(document.body, { subtree: true, childList: true });
      const sockets = window.rootRegressionSockets.filter(socket => socket.readyState === WebSocket.OPEN);
      if (!sockets.length) throw new Error("Expected an open SDK websocket");
      for (const socket of sockets) socket.close();
    }, chatLab.rootMessageId);
    await expect.poll(() => page.evaluate(() => window.rootRegressionSockets.filter(s => s.readyState === WebSocket.OPEN).length)).toBeGreaterThan(0);
    await assertRoot("Reconnect retained the root without jump-to-original or reload");
    expect(await page.evaluate(() => window.rootRegressionMissing)).toBe(false);
    await root().hover();
    await root().getByRole("button", { name: "Reply", exact: true }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    // The initial URL explicitly selected Bob; reload with Alice's route.
    await page.goto(`${chatLab.origin}/chat-lab.html?actor=alice`);
    await page.reload();
    await expect(page.getByRole("button", { name: "Development fixture identity: Alice", exact: true })).toBeVisible();
    await assertRoot("Reload and the source entry point retain the canonical named thread");
    const rows = (await chatLab.harness.pool.query(
      "SELECT id, name, root_message_id FROM chat_conversations WHERE type='thread' ORDER BY name",
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.name === "Launch date decision").root_message_id).toBe(chatLab.rootMessageId);
    await info.attach("root-retention-evidence", { contentType: "application/json", body: JSON.stringify({
      campaign: "298e20b4-4faf-4283-949d-3801cf437aa8", checkpoints, frames, threads: rows,
      rootMessageId: chatLab.rootMessageId, schema: chatLab.harness.schema, backend: chatLab.harness.backendKind,
      flutter: await flutterCall(flutter, "status"),
    }, null, 2) });
    await info.attach("react-root-retained", { contentType: "image/png", body: await page.screenshot() });
  } finally { await flutterContext.close(); }
});
