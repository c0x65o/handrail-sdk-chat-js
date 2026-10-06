import { expect, test } from "./chat-lab.fixture.mjs";
import { writeFile } from "node:fs/promises";
import { candidate } from "../scripts/candidate-binding.mjs";

// Real PostgreSQL, shipped ChatWorkspace, two independent clients for one actor.
// This measures SDK traffic; the lab does not implement Preview's API limiter.
test("populated and hidden retained workspaces have bounded read-state traffic", async ({ browser, chatLab }, testInfo) => {
  const creator = chatLab.harness.createClient("chat-lab-ada");
  const contexts = [];
  const requests = [];
  const snapshots = [];
  const state = ["visible", "visible"];
  try {
    expect((await creator.start()).state).toBe("ready");
    for (let i = 0; i < 24; i++) {
      const created = await creator.createChannel({ name: `Polling private ${i}`, visibility: "private" });
      expect(created.status).toBe("success");
    }
    creator.close();
    const pages = [];
    for (let client = 0; client < 2; client++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      const page = await context.newPage(); pages.push(page);
      // Configure the existing host fixture, without changing SDK or UI bytes.
      await page.route("**/src/chat-lab-config.ts*", async route => {
        const response = await route.fetch();
        const body = await response.text();
        expect(body).toContain('endpoint: "/api/chat"');
        await route.fulfill({ response, body: body.replace('endpoint: "/api/chat"', 'features: { realtime: false }, endpoint: "/api/chat"') });
      });
      page.on("request", request => {
        const endpoint = new URL(request.url()).pathname;
        if (request.method() === "GET" && /^\/api\/chat\/conversations(?:\/[^/]+)?$/.test(endpoint)) {
          requests.push({ client, endpoint, state: state[client], at: Date.now() });
        }
      });
      await page.goto(`${chatLab.origin}/chat-lab.html?actor=ada`);
      await expect.poll(() => page.locator("button[data-conversation-id]").count()).toBeGreaterThan(20);
    }
    const selection = pages[1].locator('button[data-conversation-id][aria-current="page"]');
    const selectedId = await selection.getAttribute("data-conversation-id");
    const composer = pages[1].getByLabel("Conversation composer", { exact: true }).getByRole("textbox").first();
    await composer.fill("Unsent polling regression draft");
    const start = Date.now();
    await pages[0].waitForTimeout(6000);
    state[1] = "hidden-retained";
    await pages[1].locator(".handrail-chat").first().evaluate(element => { element.style.display = "none"; });
    await expect.poll(() => pages[1].locator("button[data-conversation-id]").count()).toBeGreaterThan(10);
    await pages[0].waitForTimeout(11000);
    for (const [client, page] of pages.entries()) snapshots.push({ client, state: state[client], rows: await page.locator("button[data-conversation-id]").evaluateAll(rows => rows.map(row => ({ id: row.dataset.conversationId, visible: row.getClientRects().length > 0 }))) });
    const measured = requests.filter(request => request.at >= start);
    for (let client = 0; client < 2; client++) {
      // Three/four ticks plus scheduling margin, independent of the 30 rows.
      expect(measured.filter(request => request.client === client).length).toBeLessThanOrEqual(10);
      expect(measured.some(request => request.client === client && request.endpoint === "/api/chat/conversations")).toBe(true);
    }
    expect(snapshots[1].rows.every(row => !row.visible)).toBe(true);
    expect(measured.filter(request => request.state === "hidden-retained" && request.endpoint !== "/api/chat/conversations")).toHaveLength(0);
    state[1] = "visible-return";
    await pages[1].locator(".handrail-chat").first().evaluate(element => { element.style.display = ""; });
    await expect(selection).toHaveAttribute("data-conversation-id", selectedId);
    await expect(composer).toHaveText("Unsent polling regression draft");
  } finally {
    creator.close();
    await Promise.all(contexts.map(context => context.close()));
    const path = testInfo.outputPath("read-state-polling.json");
    await writeFile(path, JSON.stringify({ candidate: { source: candidate.source.sha256, package: candidate.package.sha256 }, requests, snapshots, actualConsumerDatabaseWindows: null }, null, 2));
    await testInfo.attach("read-state-polling", { path, contentType: "application/json" });
  }
});
