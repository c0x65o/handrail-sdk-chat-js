import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("empty and populated named threads keep Send reachable at compact sizes", async ({ chatLab, page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  await page.getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: /^Launch planning/ }).click();
  const channelDraft = page.getByLabel("Conversation composer", { exact: true }).getByRole("textbox");
  await channelDraft.fill("Unsent channel draft");
  const root = page.getByRole("region", { name: "Conversation timeline", exact: true })
    .getByRole("article").filter({ hasText: "Which launch date?" }).first();
  await root.hover();
  await root.getByRole("button", { name: "Create Thread", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Thread", exact: true });
  await dialog.getByLabel("Thread name").fill("Launch date decision");
  await dialog.getByRole("button", { name: "Create Thread", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Launch date decision", exact: true });
  const input = panel.getByRole("textbox", { name: "Reply to thread" });
  const send = panel.getByRole("button", { name: "Send message", exact: true });
  const threadId = await panel.locator("[data-thread-conversation-id]").getAttribute("data-thread-conversation-id");
  const screenshot = async name => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };

  for (const [width, height] of [[1280, 720], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await input.fill("Keep this discussion history");
    const empty = panel.getByText("Start the conversation when you are ready.", { exact: true });
    await empty.scrollIntoViewIfNeeded();
    await expect(empty).toBeInViewport();
    await expect(send).toBeInViewport();
    await screenshot(`thread-empty-${width}x${height}`);
    await send.click({ trial: true });
  }

  for (const [width, height] of [[1280, 720], [390, 844], [1440, 1000]]) {
    await page.setViewportSize({ width, height });
    const message = width === 1280 ? "Keep this discussion history" : `Thread reply at ${width}×${height}`;
    await input.fill(message);
    await expect(send).toBeEnabled();
    await expect(send).toBeInViewport();
    await screenshot(`thread-draft-${width}x${height}`);
    // A visible button can still be covered by overflowing empty-state text.
    expect(await send.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await send.click();
    await expect(input).toBeEmpty();
    await expect.poll(async () => (await chatLab.harness.pool.query(
      "SELECT conversation_id FROM chat_messages WHERE content->>'text'=$1", [message],
    )).rows).toEqual([{ conversation_id: threadId }]);
    const reply = panel.getByRole("region", { name: "Thread replies", exact: true }).getByText(message, { exact: true });
    await reply.scrollIntoViewIfNeeded();
    await expect(reply).toBeInViewport();
    await expect(send).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(`thread-history-${width}x${height}`);
    const controls = panel.getByRole("group", { name: "Thread controls", exact: true });
    await controls.scrollIntoViewIfNeeded();
    await expect(controls).toBeInViewport();
    await expect(send).toBeInViewport();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.getByLabel("Conversation composer", { exact: true })).toBeVisible();
  await expect(channelDraft).toHaveText("Unsent channel draft");
  await expect(root).toBeVisible();
});
