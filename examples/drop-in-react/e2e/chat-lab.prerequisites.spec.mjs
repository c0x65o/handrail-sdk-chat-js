import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("absent preference actor and group participants are available in the lab UI", async ({ chatLab, page }, info) => {
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=carol`);
  await expect(page.getByRole("button", { name: "Development fixture identity: Carol", exact: true })).toBeVisible();
  await page.locator(".chat-lab__reply-settings summary").click();
  await expect(page.locator(".chat-lab__reply-settings")).toContainText("Effective style: Current — SDK default");
  await page.screenshot({ path: info.outputPath("carol-absent-preference.png") });
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  await page.getByRole("button", { name: "Create a group conversation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create group conversation" });
  await dialog.getByRole("searchbox", { name: "Find people" }).fill("a");
  await dialog.getByRole("checkbox", { name: "Alice", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Carol", exact: true }).check();
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("group-prerequisites.png") });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await chatLab.harness.pool.query(
    "SELECT user_id FROM chat_conversation_members JOIN chat_conversations ON conversation_id=id WHERE type='group_direct' ORDER BY user_id",
  )).rows.map(row => row.user_id)).toEqual(["alice", "bob", "carol"]);
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=dave`);
  await expect(page.getByRole("button", { name: "Development fixture identity: Dave", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a group conversation", exact: true })).toHaveCount(0);
});
