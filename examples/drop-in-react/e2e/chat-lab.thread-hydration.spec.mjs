import { CHAT_LAB_PUBLIC_THREAD_REPLY_TEXT } from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.fixture.mjs";

if (process.env.CHAT_LAB_RECOVERY_ORIGIN) {
  test.use({ chatLabOrigin: process.env.CHAT_LAB_RECOVERY_ORIGIN });
}

for (let attempt = 1; attempt <= 3; attempt += 1) {
  test(`two-tab Ada thread recovery survives reload (${attempt})`, async ({ context, page: a, chatLabOrigin }) => {
    test.setTimeout(120_000);
    const b = await context.newPage();
    const panel = (page) => page.locator(".handrail-chat__thread-panel");
    const follow = (page, following) => panel(page).getByRole("button", { name: following ? "Unfollow" : "Follow", exact: true });
    const open = async (page, name) => {
      await page.getByRole("button", { name }).filter({ hasNotText: "Margaret Hamilton" }).click();
      await page.getByRole("button", { name: "Open thread with 1 reply", exact: true }).click();
      await expect(panel(page).getByRole("textbox", { name: "Reply to thread" })).toBeVisible();
    };
    await a.goto(new URL("/chat-lab.html", chatLabOrigin).href);
    await b.goto(new URL("/chat-lab.html", chatLabOrigin).href);
    await open(a, /^Grace Hopper(?:,|$| \()/);
    await open(b, /^Grace Hopper(?:,|$| \()/);
    if (await follow(a, false).isVisible()) await follow(a, false).click();
    await expect(follow(b, true)).toBeVisible();
    await follow(a, true).click();
    await expect(follow(b, false)).toBeVisible();
    await follow(b, false).click();
    await expect(follow(a, true)).toBeVisible();
    await open(a, /^Chat Lab General(?:,|$)/);
    const generalFollowing = await follow(a, true).isVisible();
    await follow(b, true).click();
    await expect(follow(b, false)).toBeVisible();
    await a.reload();
    await open(a, /^Chat Lab General(?:,|$)/);
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1000) {
      await expect(panel(a).getByRole("textbox", { name: "Reply to thread" })).toBeVisible();
      await expect(panel(a).getByText(CHAT_LAB_PUBLIC_THREAD_REPLY_TEXT, { exact: true })).toBeVisible();
      await expect(follow(a, generalFollowing)).toBeVisible();
      await expect(follow(b, false)).toBeVisible();
      await a.waitForTimeout(1000);
    }
  });
}
