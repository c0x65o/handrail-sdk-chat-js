import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("reload refreshes Alice's cached channel after Bob's confirmed send without reselection", async ({ chatLab, page }, testInfo) => {
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=alice`);
  const timeline = page.getByRole("region", { name: "Conversation timeline", exact: true });
  await expect(timeline.locator(`[data-message-id="${chatLab.rootMessageId}"]`)).toBeVisible();
  await page.getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: /^Launch planning/ }).click();
  await page.getByRole("button", { name: "Development fixture identity: Alice", exact: true }).click();
  await page.getByRole("option", { name: /Bob/ }).click();
  await expect(page.getByRole("button", { name: "Development fixture identity: Bob", exact: true })).toBeVisible();
  const composer = page.getByLabel("Conversation composer", { exact: true });
  await composer.getByRole("textbox").fill("Reload history checkpoint");
  const confirmed = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes("/messages") && response.status() === 201);
  await composer.getByRole("button", { name: "Send message", exact: true }).click();
  await confirmed;
  await expect(composer).toContainText("Message sent");
  expect((await chatLab.harness.pool.query(
    "SELECT conversation_id FROM chat_messages WHERE content->>'text' = 'Reload history checkpoint'",
  )).rows).toEqual([{ conversation_id: chatLab.conversationId }]);

  await page.reload();
  await expect(page.getByRole("button", { name: "Development fixture identity: Alice", exact: true })).toBeVisible();
  await expect(page.locator('.chat-lab__realtime-announcement')).toHaveAttribute("data-realtime-state", "connected");
  // Do not click the already displayed channel: that masked the startup bug.
  const checkpoint = timeline.getByRole("article").filter({ hasText: "Reload history checkpoint" });
  await expect(checkpoint).toHaveCount(1);
  await expect(checkpoint).toBeVisible();
  await expect(timeline.locator(`[data-message-id="${chatLab.rootMessageId}"]`)).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("reloaded-history.png"), fullPage: true });
});
