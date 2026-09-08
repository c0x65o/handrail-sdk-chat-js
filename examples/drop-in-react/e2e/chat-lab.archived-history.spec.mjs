import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("Bob opens and retries retained archived history without creating a thread", async ({ chatLab, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  const selectChannel = () => page.getByRole("navigation", { name: "Conversations" })
    .getByRole("button", { name: /^Launch planning/ }).click();
  await selectChannel();
  const source = page.locator(`[data-message-id="${chatLab.rootMessageId}"]`);
  await source.hover();
  await source.getByRole("button", { name: "Reply", exact: true }).click();
  const composer = page.getByLabel("Conversation composer", { exact: true });
  await composer.getByRole("textbox").fill("Friday");
  await composer.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("region", { name: "Conversation timeline", exact: true }).getByText("Friday", { exact: true })).toBeVisible();
  await expect.poll(async () => (await chatLab.harness.pool.query(
    "SELECT conversation_id, reply_to_message_id FROM chat_messages WHERE content->>'text'='Friday'",
  )).rows).toEqual([{ conversation_id: chatLab.conversationId, reply_to_message_id: chatLab.rootMessageId }]);
  expect((await chatLab.harness.pool.query("SELECT id FROM chat_conversations WHERE type='thread'")).rows).toHaveLength(0);

  const control = await page.request.post(`${chatLab.origin}/__chat-lab/reply-styles`, {
    data: { operation: "create_archived_thread" },
  });
  expect(control.ok()).toBe(true);
  const fixture = await control.json();
  const requests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/chat/")) {
      requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  const open = async () => {
    const root = page.getByRole("region", { name: "Conversation timeline", exact: true })
      .getByText("Archived launch notes", { exact: true }).locator("xpath=ancestor::*[@data-message-id]");
    await root.hover();
    await root.getByRole("button", { name: "Open Thread", exact: true }).click();
  };
  const panel = page.locator(".handrail-chat__thread-panel");
  await open();
  await expect(panel.getByText("Retained archived launch history", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("archived-history-open.png") });

  // A failed read must retry the read, never fall back to create_thread.
  await page.reload();
  await selectChannel();
  const detailPath = `/api/chat/conversations/${fixture.threadId}`;
  await page.route(`**${detailPath}`, route => route.abort("failed"));
  await open();
  await expect(panel.getByText("Thread unavailable", { exact: true })).toBeVisible();
  await page.unroute(`**${detailPath}`);
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.getByText("Retained archived launch history", { exact: true })).toBeVisible();
  expect(requests.filter(request => request.method === "POST" && request.path.endsWith("/thread"))).toEqual([]);
  expect(requests.some(request => request.method === "GET" && request.path === detailPath)).toBe(true);
  expect((await chatLab.harness.pool.query("SELECT id FROM chat_conversations WHERE type='thread'")).rows).toHaveLength(1);
  await expect(panel.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  const evidencePath = info.outputPath("archived-history-requests.json");
  await writeFile(evidencePath, JSON.stringify({ backendKind: chatLab.harness.backendKind, requests }, null, 2));
  await info.attach("archived-history-requests", { path: evidencePath, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("archived-history-retry.png") });
});
