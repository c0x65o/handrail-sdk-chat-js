import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("actor selection hydrates persisted parent replies and keeps the canonical thread", async ({ chatLab, page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const timeline = page.getByRole("region", { name: "Conversation timeline", exact: true });
  const root = timeline.locator(`[data-message-id="${chatLab.rootMessageId}"]`);
  const channel = page.getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: /^Launch planning/ });
  const choose = async (from, to, selectChannel = false) => {
    await page.getByRole("button", { name: `Development fixture identity: ${from}`, exact: true }).click();
    await page.getByRole("option", { name: new RegExp(to) }).click();
    await expect(page.getByRole("button", { name: `Development fixture identity: ${to}`, exact: true })).toBeVisible();
    if (selectChannel) await channel.click();
    await expect(root).toBeVisible();
  };
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=alice`);
  await channel.click();
  await expect(root).toBeVisible();
  // Alice caches the original history before leaving the conversation.
  await choose("Alice", "Bob", true);
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  const composer = page.getByLabel("Conversation composer", { exact: true });
  await composer.getByRole("textbox").fill("Friday");
  await composer.getByRole("button", { name: "Send message", exact: true }).click();
  const friday = timeline.getByRole("article").filter({ hasText: "Friday" });
  await expect(friday).toBeVisible();
  const threads = async () => (await chatLab.harness.pool.query(
    "SELECT id, name, root_message_id FROM chat_conversations WHERE type = 'thread'",
  )).rows;
  expect(await threads()).toEqual([]);

  // Keep Bob's Reply -> Create Thread flow uninterrupted.
  await root.hover();
  await root.getByRole("button", { name: "Create Thread", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Thread", exact: true });
  await dialog.getByLabel("Thread name").fill("Launch date decision");
  await dialog.getByRole("button", { name: "Create Thread", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Launch date decision", exact: true });
  await expect(panel).toBeVisible();
  const canonical = await threads();
  expect(canonical).toEqual([{ id: expect.any(String), name: "Launch date decision", root_message_id: chatLab.rootMessageId }]);
  const checkHistory = async () => {
    await expect(root).toHaveCount(1);
    await expect(root).toBeVisible();
    await expect(friday).toHaveCount(1);
    await expect(friday.getByRole("button", { name: /Jump to original message.*Alice.*Which launch date/ })).toBeVisible();
  };
  await checkHistory();
  expect((await chatLab.harness.pool.query(
    "SELECT conversation_id, reply_to_message_id FROM chat_messages WHERE content->>'text' = 'Friday'",
  )).rows).toEqual([{ conversation_id: chatLab.conversationId, reply_to_message_id: chatLab.rootMessageId }]);

  await choose("Bob", "Alice");
  await checkHistory();
  await root.hover();
  await root.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(panel.locator("[data-thread-conversation-id]"))
    .toHaveAttribute("data-thread-conversation-id", canonical[0].id);
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await channel.click();
  await checkHistory();
  await choose("Alice", "Bob");
  await choose("Bob", "Alice");
  await checkHistory();
  await page.reload();
  await channel.click();
  await checkHistory();
  expect(await threads()).toEqual(canonical);
});
