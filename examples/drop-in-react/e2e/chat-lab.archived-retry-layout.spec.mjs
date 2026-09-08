import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("archived Retry receives pointer clicks after real unauthorized reads at compact sizes", async ({ chatLab, page }, info) => {
  const setup = await page.request.post(`${chatLab.origin}/__chat-lab/reply-styles`, {
    data: { operation: "create_archived_thread" },
  });
  expect(setup.ok()).toBe(true);
  const { threadId } = await setup.json();
  const detailPath = `/api/chat/conversations/${threadId}`;
  const messagesPath = `${detailPath}/messages`;
  const reads = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() === "GET" && [detailPath, messagesPath].includes(path)) {
      reads.push({ path, status: response.status() });
    }
  });
  let denyReads = false;
  await page.route("**/api/chat/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (denyReads && request.method() === "GET" && [detailPath, messagesPath].includes(path)) {
      const headers = { ...request.headers() };
      delete headers.authorization;
      await route.continue({ headers });
    } else {
      await route.continue();
    }
  });
  const panel = page.locator(".handrail-chat__thread-panel");
  const open = () => page.getByRole("button", { name: /^Open thread.* with 1 reply$/ }).click();
  for (const [width, height] of [[1280, 720], [1440, 1000], [390, 844]]) {
    // Select the channel with desktop navigation before exercising each size.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
    await page.getByRole("navigation", { name: "Conversations" })
      .getByRole("button", { name: /^Launch planning/ }).click();
    await page.setViewportSize({ width, height });
    await open();
    await expect(panel.getByText("Retained archived launch history", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();
    const deniedStart = reads.length;
    denyReads = true;
    await open();
    await expect(panel.locator(".handrail-chat__thread-state[role=alert]")).toContainText("The thread could not be loaded.");
    await expect(panel.getByText("Retained archived launch history", { exact: true })).toHaveCount(0);
    await expect.poll(() => reads.slice(deniedStart).some(read => read.status === 401)).toBe(true);
    const retry = panel.getByRole("button", { name: "Retry", exact: true });
    await retry.scrollIntoViewIfNeeded();
    const probe = await retry.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      const alert = button.closest('[role="alert"]').getBoundingClientRect();
      const controls = button.closest("aside").querySelector('[aria-label="Thread controls"]')?.getBoundingClientRect();
      return { receivesClick: button.contains(hit), hit: hit?.className,
        alertBottom: alert.bottom, controlsTop: controls?.top };
    });
    await info.attach(`retry-${width}x${height}`, {
      body: JSON.stringify({ backendKind: chatLab.harness.backendKind, probe, reads }, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: info.outputPath(`retry-${width}x${height}.png`) });
    expect(probe.receivesClick).toBe(true);
    expect(probe.controlsTop).toBeGreaterThanOrEqual(probe.alertBottom);
    denyReads = false;
    const retryStart = reads.length;
    await retry.click();
    for (const path of [detailPath, messagesPath]) {
      await expect.poll(() => reads.slice(retryStart).some(read => read.path === path && read.status === 200)).toBe(true);
    }
    await expect(panel.locator(".handrail-chat__thread-state[role=alert]")).toHaveCount(0);
    await expect(panel.getByText("Retained archived launch history", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    const evidencePath = info.outputPath(`retry-reads-${width}x${height}.json`);
    await writeFile(evidencePath, JSON.stringify({ backendKind: chatLab.harness.backendKind,
      viewport: { width, height }, probe, deniedReads: reads.slice(deniedStart, retryStart),
      retryReads: reads.slice(retryStart) }, null, 2));
    await info.attach(`retry-reads-${width}x${height}`, {
      path: evidencePath,
      contentType: "application/json",
    });
  }
});
