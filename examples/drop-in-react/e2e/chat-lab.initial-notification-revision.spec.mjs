import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ chatLabSeedProfile: "reply-styles" });

test("Bob's first named-thread notification save uses the authoritative initial revision", async ({ chatLab, page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const preferenceRequests = [];
  page.on("request", request => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname.endsWith("/preference")) {
      preferenceRequests.push(request.postDataJSON());
    }
  });
  const rootText = `First notification save ${testInfo.testId}`;
  const root = page.getByRole("region", { name: "Conversation timeline", exact: true })
    .getByRole("article").filter({ hasText: rootText }).first();
  const openLaunch = async () => {
    await page.getByRole("navigation", { name: "Conversations" })
      .getByRole("button", { name: /^Launch planning/ }).click();
  };

  await page.goto(`${chatLab.origin}/chat-lab.html?actor=bob`);
  await openLaunch();
  // Use a fresh root so other tests sharing this worker cannot pre-create its thread.
  const composer = page.getByLabel("Conversation composer", { exact: true });
  await composer.getByRole("textbox").fill(rootText);
  await composer.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer.getByRole("textbox")).toBeEmpty();
  await root.hover();
  await root.getByRole("button", { name: "Create Thread", exact: true }).click();
  const creation = page.getByRole("dialog", { name: "Create Thread", exact: true });
  await creation.getByLabel("Thread name").fill("First notification save");
  const createdResponse = page.waitForResponse(response => response.request().method() === "POST" &&
    response.request().postDataJSON()?.operation === "create_thread");
  await creation.getByRole("button", { name: "Create Thread", exact: true }).click();
  const created = await (await createdResponse).json();
  const initialPreference = created.conversation.conversation.currentPreference;
  expect(initialPreference.preferenceRevision).toBe(1);

  const thread = page.getByRole("complementary", { name: "First notification save", exact: true });
  const trigger = thread.getByRole("button", { name: /^Thread notification preferences:/ });
  const dialog = thread.getByRole("dialog", { name: "Notification preferences", exact: true });
  await trigger.click();
  await dialog.getByRole("combobox").selectOption("mentions");
  await dialog.getByRole("radio", { name: "Muted indefinitely", exact: true }).check();
  const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/preference") &&
    response.request().method() === "PATCH");
  await dialog.getByRole("button", { name: "Save preferences", exact: true }).click();
  const response = await savedResponse;
  const saved = await response.json();
  expect(response.status()).toBe(200);
  expect(preferenceRequests).toHaveLength(1);
  expect(preferenceRequests[0]).toMatchObject({
    expectedPreferenceRevision: initialPreference.preferenceRevision,
    notificationPreference: "mentions", mute: { muted: true },
  });
  expect(preferenceRequests[0].mute.mutedUntil).toBeUndefined();
  expect(saved.reconciliationStatus).toBe("applied");
  expect(saved.preferenceRevision).toBe(2);
  await expect(dialog.getByRole("status")).toContainText("Notification preferences saved");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("first-save.png") });

  // Reload from the real backend to prove both choices persisted.
  await page.reload();
  await openLaunch();
  await root.hover();
  await root.getByRole("button", { name: "Open Thread", exact: true }).click();
  await trigger.click();
  await expect(dialog.getByRole("combobox")).toHaveValue("mentions");
  await expect(dialog.getByRole("radio", { name: "Muted indefinitely", exact: true })).toBeChecked();
  expect(preferenceRequests).toHaveLength(1);
  const evidencePath = testInfo.outputPath("first-save.json");
  await writeFile(evidencePath, JSON.stringify({ initialPreference, request: preferenceRequests[0],
    status: response.status(), saved, persistedAfterReload: true }, null, 2));
  await testInfo.attach("first notification save", { path: evidencePath, contentType: "application/json" });
});
