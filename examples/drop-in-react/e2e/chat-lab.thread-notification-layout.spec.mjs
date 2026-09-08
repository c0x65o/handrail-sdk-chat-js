import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("thread notification preferences stay within the thread and Close receives clicks", async ({ chatLab, page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  await page.getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: /^Launch planning/ }).click();
  const root = page.getByRole("region", { name: "Conversation timeline", exact: true })
    .getByRole("article").filter({ hasText: "Which launch date?" }).first();
  await root.hover();
  // The worker-scoped lab may already contain the layout suite's named thread.
  const openThread = root.getByRole("button", { name: "Open Thread", exact: true });
  if (await openThread.isVisible()) {
    await openThread.click();
  } else {
    await root.getByRole("button", { name: "Create Thread", exact: true }).click();
    const creation = page.getByRole("dialog", { name: "Create Thread", exact: true });
    await creation.getByLabel("Thread name").fill("Launch date decision");
    await creation.getByRole("button", { name: "Create Thread", exact: true }).click();
  }
  const thread = page.getByRole("complementary", { name: "Launch date decision", exact: true });
  const trigger = thread.getByRole("button", { name: /^Thread notification preferences:/ });
  const dialog = thread.getByRole("dialog", { name: "Notification preferences", exact: true });
  const close = dialog.getByRole("button", { name: "Close", exact: true });

  for (const [width, height, conflict] of [[1440, 1000, false], [1440, 1000, true], [1280, 720, false], [390, 844, false]]) {
    await page.setViewportSize({ width, height });
    await trigger.click();
    await expect(dialog).toBeVisible();
    if (conflict) {
      // Apply a competing preference through the real API before this save.
      await page.route("**/conversations/*/preference", async route => {
        const input = route.request().postDataJSON();
        const idempotencyKey = `${input.idempotencyKey}-competing`;
        const competing = await route.fetch({ headers: {
          ...route.request().headers(), "idempotency-key": idempotencyKey,
        }, postData: {
          ...input, idempotencyKey,
          notificationPreference: "none",
        } });
        // An already-stale first preference also produces the target conflict.
        expect([200, 409], await competing.text()).toContain(competing.status());
        await route.continue();
      }, { times: 1 });
      await dialog.getByRole("combobox").selectOption("mentions");
      await dialog.getByRole("button", { name: "Save preferences", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("Preferences changed elsewhere");
      await expect(dialog.getByRole("button", { name: "Retry save", exact: true })).toBeEnabled();
    }
    // Reveal the whole dialog where it fits; compact threads scroll to Close.
    if (width === 1440) await dialog.scrollIntoViewIfNeeded();
    else await close.scrollIntoViewIfNeeded();
    const probe = await dialog.evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      const threadBounds = panel.closest(".handrail-chat__thread-panel").getBoundingClientRect();
      const closeButton = panel.querySelector(".handrail-chat__notification-preferences-close");
      const closeBounds = closeButton.getBoundingClientRect();
      const hit = document.elementFromPoint(closeBounds.x + closeBounds.width / 2, closeBounds.y + closeBounds.height / 2);
      return {
        panel: bounds.toJSON(), thread: threadBounds.toJSON(),
        close: closeBounds.toJSON(), hit: hit?.outerHTML,
        closeReceivesClick: closeButton.contains(hit),
        withinThread: bounds.left >= threadBounds.left && bounds.right <= threadBounds.right,
      };
    });
    const name = `${width}x${height}${conflict ? "-conflict" : ""}`;
    const probePath = testInfo.outputPath(`hit-test-${name}.json`);
    await writeFile(probePath, JSON.stringify(probe, null, 2));
    await testInfo.attach(`hit-test-${name}`, { path: probePath, contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`preferences-${name}.png`) });
    expect(probe.withinThread).toBe(true);
    expect(probe.closeReceivesClick).toBe(true);
    if (width === 1440) {
      await expect(dialog).toBeInViewport({ ratio: 1 });
    }
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(thread).toBeVisible();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});
