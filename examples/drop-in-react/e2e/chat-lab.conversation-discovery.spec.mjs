import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("Bob rediscovers persisted DMs and groups after actor return and reload", async ({ chatLab, page }, info) => {
  const requests = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/chat/conversations") {
      requests.push({ method: request.method(), path: url.pathname + url.search });
    }
  });
  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  const navigation = page.getByRole("navigation", { name: "Conversations" });
  await expect(navigation.getByRole("button", { name: /^Launch planning/ })).toBeVisible();
  const created = [];
  for (const group of [false, true]) {
    await page.getByRole("button", {
      name: group ? "Create a group conversation" : "Create a direct conversation", exact: true,
    }).click();
    const dialog = page.getByRole("dialog", {
      name: group ? "Create group conversation" : "Create direct conversation",
    });
    await dialog.getByRole("searchbox").fill("a");
    await dialog.getByRole(group ? "checkbox" : "radio", { name: "Alice", exact: true }).check();
    if (group) await dialog.getByRole("checkbox", { name: "Carol", exact: true }).check();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const rows = (await chatLab.harness.pool.query("SELECT id FROM chat_conversations WHERE type=$1", [group ? "group_direct" : "direct"])).rows;
    expect(rows).toHaveLength(1);
    const id = rows[0].id;
    created.push(id);
    const composer = page.getByLabel("Conversation composer", { exact: true });
    const sourceText = group ? "Discovery group source" : "Discovery DM source";
    await composer.getByRole("textbox").fill(sourceText);
    await composer.getByRole("button", { name: "Send message", exact: true }).click();
    const timeline = page.getByRole("region", { name: "Conversation timeline", exact: true });
    const source = timeline.getByRole("article").filter({ hasText: sourceText });
    await expect(source).toBeVisible();
    await source.hover();
    await source.getByRole("button", { name: "Reply", exact: true }).click();
    await composer.getByRole("textbox").fill(`${sourceText} reply`);
    await composer.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(timeline.getByText(`${sourceText} reply`, { exact: true })).toBeVisible();
  }

  // Confirm discovery and history through the real server independently of React.
  const listed = await page.request.get(`${chatLab.origin}/api/chat/conversations?scope=organization&limit=50`, {
    headers: { authorization: "Bearer chat-lab-bob" },
  });
  expect(listed.status()).toBe(200);
  expect((await listed.json()).items.map(item => item.id)).toEqual(expect.arrayContaining(created));
  await expect.poll(async () => (await chatLab.harness.pool.query(
    "SELECT conversation_id, count(*)::int AS count FROM chat_messages WHERE conversation_id = ANY($1) GROUP BY conversation_id ORDER BY conversation_id",
    [created],
  )).rows).toEqual([...created].sort().map(id => ({ conversation_id: id, count: 2 })));

  const switchTo = async name => {
    await page.getByRole("button", { name: /^Development fixture identity:/ }).click();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await expect(page.getByRole("button", { name: `Development fixture identity: ${name}`, exact: true })).toBeVisible();
  };
  const verifyDiscovery = async label => {
    const search = navigation.getByRole("searchbox", { name: "Search conversations" });
    await search.fill("Alice");
    await expect(navigation.getByRole("button", { name: /^Alice, Carol/ })).toBeVisible();
    await expect(navigation.getByRole("button", { name: /^Alice(?:, \d|, Notifications|$)/ })).toBeVisible();
    for (const [index, id] of created.entries()) {
      await navigation.getByRole("button", { name: index === 0 ? /^Alice(?:, \d|, Notifications|$)/ : /^Alice, Carol/ }).click();
      await expect(page.locator(`.handrail-chat__conversation[data-conversation-id="${id}"]`)).toBeVisible();
      await expect(page.getByRole("region", { name: "Conversation timeline", exact: true })
        .getByText(index === 0 ? "Discovery DM source reply" : "Discovery group source reply", { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath(`${label}.png`) });
    await search.clear();
  };
  await switchTo("Dave");
  await expect(navigation.getByRole("button", { name: /^Alice/ })).toHaveCount(0);
  await switchTo("Bob");
  await verifyDiscovery("actor-return");
  await page.reload();
  await verifyDiscovery("reload");
  await writeFile(info.outputPath("discovery-requests.json"), JSON.stringify({
    backendKind: chatLab.harness.backendKind, created, requests,
  }, null, 2));
});
