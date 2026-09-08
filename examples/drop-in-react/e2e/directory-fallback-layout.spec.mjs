import { readFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

// An explicit origin allows the same regression to verify a running dev service.
if (process.env.CHAT_LAB_DIRECTORY_CHECK_ORIGIN) {
  test.use({ chatLabOrigin: process.env.CHAT_LAB_DIRECTORY_CHECK_ORIGIN });
}

// Isolate the shared timeline's grid from backend availability. Both the parent
// and thread render this markup, including omitting unresolved author avatars.
test("directory fallback keeps parent and thread message bodies readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const css = await readFile(new URL("../../../dist/ui/styles.css", import.meta.url), "utf8");
  expect(css, "published CSS must match source; run npm run build at the SDK root").toBe(
    await readFile(new URL("../../../src/ui/styles.css", import.meta.url), "utf8"),
  );
  const timeline = (width) => `<section class="handrail-chat" style="width:${width}px">
    <ol class="handrail-chat__timeline-feed">
      ${["unknown", "known", "grouped"].map((kind) => `
        <li class="handrail-chat__timeline-item ${kind === "grouped" ? "handrail-chat__timeline-item--grouped" : ""}" data-kind="${kind}">
          ${kind === "known" ? '<span class="handrail-chat__timeline-avatar">AL</span>' : ""}
          <div class="handrail-chat__timeline-item-body">
            <header class="handrail-chat__timeline-author"><strong>${kind === "unknown" ? "Unknown user" : "Ada Lovelace"}</strong></header>
            <div class="handrail-chat__timeline-message">Thread replies stay attached to their canonical root message.</div>
          </div>
        </li>`).join("")}
    </ol>
  </section>`;
  await page.setContent(`<main style="display:flex;gap:20px">${timeline(521)}${timeline(400)}</main>`);
  await page.addStyleTag({ content: css });
  for (const panel of await page.locator("section").all()) {
    const bodies = panel.locator(".handrail-chat__timeline-item-body");
    const known = await bodies.nth(1).boundingBox();
    for (const body of await bodies.all()) {
      const box = await body.boundingBox();
      expect(box.width).toBeGreaterThan(280);
      expect(box.width).toBeCloseTo(known.width, 1);
      expect(box.x).toBeCloseTo(known.x, 1);
      expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  }
});

test("served parent and thread recover from directory 429 without losing thread state", async ({ chatLabOrigin, page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  let unavailable = true;
  let rejectedRequests = 0;
  await page.route("**/api/chat/directory/**", async (route) => {
    if (!unavailable) return route.continue();
    rejectedRequests += 1;
    await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited" }) });
  });
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  await page.getByRole("button", { name: "Open thread with 1 reply", exact: true }).click();
  const panel = page.locator(".handrail-chat__thread-panel");
  await expect(panel).toBeVisible();
  const bodies = page.locator(".handrail-chat__timeline-item-body");
  await expect(bodies).toHaveCount(3);
  expect(rejectedRequests).toBeGreaterThan(0);
  await expect(page.getByText("Unknown user", { exact: true }).first()).toBeVisible();
  const measure = async () => {
    for (const body of await bodies.all()) {
      expect(await body.evaluate((element) => getComputedStyle(element).gridColumnStart)).toBe("2");
      expect((await body.boundingBox()).width).toBeGreaterThan(250);
      expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  };
  await measure();
  const follow = panel.getByRole("button", { name: /^(Follow|Unfollow)$/ });
  const followState = await follow.textContent();
  unavailable = false;
  await expect(page.getByText("Unknown user", { exact: true })).toHaveCount(0, { timeout: 75_000 });
  await expect(bodies.getByText("Ada Lovelace", { exact: true }).first()).toBeVisible();
  await expect(bodies.getByText("Grace Hopper", { exact: true }).first()).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(bodies).toHaveCount(3);
  await expect(follow).toHaveText(followState);
  await measure();
});
