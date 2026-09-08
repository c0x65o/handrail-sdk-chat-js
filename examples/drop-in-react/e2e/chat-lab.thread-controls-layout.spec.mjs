import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("closed thread controls receive clicks beside a retained inline channel draft", async ({ chatLab, page }, testInfo) => {
  page.on("pageerror", error => console.error(error));
  // Use a separate real message so other tests can still create the seed's thread.
  const alice = chatLab.harness.createClient("chat-lab-alice");
  let rootId;
  try {
    await alice.start();
    const sent = await alice.sendMessage({
      conversationId: chatLab.conversationId,
      content: { format: "plain", text: "Which launch date?" },
    });
    expect(sent.status).toBe("success");
    rootId = sent.value.message.id;
  } finally {
    alice.close();
  }
  // Prepare the closed thread at the campaign's known working size.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  await page.getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: /^Launch planning/ }).click();
  const settings = page.locator(".chat-lab__reply-settings");
  await settings.locator("summary").click();
  await settings.getByRole("combobox", { name: "Reply and thread style", exact: true }).selectOption("discord");
  await expect(settings).toContainText("Effective style: Discord-style");
  await settings.locator("summary").click();

  const root = page.getByRole("region", { name: "Conversation timeline", exact: true })
    .locator(`[data-message-id="${rootId}"]`);
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  const composer = page.getByLabel("Conversation composer", { exact: true });
  const draft = composer.getByRole("textbox");
  await draft.fill("QA retained channel draft");
  await expect(composer).toContainText("Replying to Alice: Which launch date?");
  await root.hover();
  await root.getByRole("button", { name: "Create Thread", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "Create Thread", exact: true });
  const name = "QA 298e20b4 Launch date decision";
  await creation.getByLabel("Thread name").fill(name);
  await creation.getByRole("button", { name: "Create Thread", exact: true }).click();
  const panel = page.getByRole("complementary", { name, exact: true });
  const threadId = await panel.locator("[data-thread-conversation-id]").getAttribute("data-thread-conversation-id");
  const closedAt = async () => (await chatLab.harness.pool.query(
    "SELECT closed_at FROM chat_conversations WHERE id=$1", [threadId],
  )).rows[0].closed_at;
  await panel.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect.poll(closedAt).not.toBeNull();
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();

  for (const [width, height] of [[1280, 720], [1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "Browse channel threads", exact: true }).click();
    const discovery = page.getByRole("region", { name: "Threads in Launch planning" });
    await discovery.getByRole("button", { name: "All threads", exact: true }).click();
    await discovery.locator(`[data-thread-id="${threadId}"]`).click();
    const reopen = panel.getByRole("button", { name: "Reopen thread", exact: true });
    await expect(reopen).toBeEnabled();
    await reopen.scrollIntoViewIfNeeded();
    const probe = await reopen.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { button: bounds.toJSON(), hit: hit?.outerHTML, receivesClick: button.contains(hit) };
    });
    const probePath = testInfo.outputPath(`reopen-hit-test-${width}x${height}.json`);
    await writeFile(probePath, JSON.stringify(probe, null, 2));
    await testInfo.attach(`reopen-hit-test-${width}x${height}`, { path: probePath, contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`closed-thread-${width}x${height}.png`) });
    await expect(reopen).toBeInViewport();
    expect(probe.receivesClick).toBe(true);
    if (width >= 1024) {
      await expect(draft).toBeInViewport();
      await expect(composer).toContainText("Replying to Alice: Which launch date?");
    }
    await reopen.click();
    await expect.poll(closedAt).toBeNull();
    await panel.getByRole("button", { name: "Leave", exact: true }).click();
    await panel.getByRole("button", { name: "Join", exact: true }).click();
    await panel.getByRole("button", { name: "Close thread", exact: true }).click();
    await expect.poll(closedAt).not.toBeNull();
    await panel.getByRole("button", { name: "Back to channel threads", exact: true }).click();
    await page.getByRole("button", { name: "Back to Launch planning", exact: true }).click();
    await expect(draft).toHaveText("QA retained channel draft");
    await expect(composer).toContainText("Replying to Alice: Which launch date?");
  }
  // The worker-scoped lab is reused; leave the next scenario a clean composer.
  await composer.getByRole("button", { name: "Cancel reply", exact: true }).click();
  await draft.clear();
  await expect(draft).toBeEmpty();
  await expect.poll(async () => (await chatLab.harness.pool.query(
    "SELECT content FROM chat_drafts WHERE conversation_id=$1 AND user_id='bob'", [chatLab.conversationId],
  )).rows).toEqual([{ content: null }]);
});
