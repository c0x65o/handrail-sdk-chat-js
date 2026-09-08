import { expect, test } from "@playwright/test";
import { startChatLab } from "../scripts/chat-lab.mjs";
import { CHAT_LAB_PUBLIC_MESSAGES } from "../scripts/chat-lab-backend.mjs";

// An explicit origin validates the supervised runtime; otherwise own an isolated
// schema using the existing Chat Lab PostgreSQL harness.
let lab;
let origin;
test.beforeAll(async () => {
  origin = process.env.CHAT_LAB_REMINDER_CHECK_ORIGIN;
  if (!origin) {
    lab = await startChatLab({ port: 0, flutterReady: Promise.resolve() });
    origin = lab.origin;
  }
});
test.afterAll(async () => { await lab?.close(); });

test("hydrates cancellation authority on reload and actor return without retries", async ({ page, request }) => {
  const writes = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/reminder")) writes.push(request.postDataJSON());
  });
  const failures = [];
  page.on("response", (response) => {
    if (response.url().includes("reminder") && response.status() >= 400) failures.push(response.status());
  });
  const snapshot = async (actor = "ada", inclusion = "true") => {
    const response = await request.get(`${origin}/api/chat/message-reminders?limit=100${inclusion === undefined ? "" : `&includeCancelled=${inclusion}`}`, {
      headers: { authorization: `Bearer chat-lab-${actor}` },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).items;
  };
  const selectGeneral = () => page.getByRole("button", { name: /^Chat Lab General(?:,|$)/ }).click();
  const row = (index) => page.locator("[data-message-id]").filter({ hasText: CHAT_LAB_PUBLIC_MESSAGES[index].text });
  const openReminder = async (message) => {
    await message.hover();
    const more = message.getByRole("button", { name: "More message actions", exact: true });
    if (await more.getAttribute("aria-expanded") !== "true") await more.click();
    const remind = message.getByRole("button", { name: "Remind me", exact: true });
    if (await remind.getAttribute("aria-expanded") !== "true") await remind.click();
  };
  const mutate = async (message, label, expectedRevision) => {
    const count = writes.length;
    await openReminder(message);
    const response = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/reminder"));
    await message.getByRole("button", { name: label, exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    expect(writes).toHaveLength(count + 1);
    expect(writes.at(-1).expectedReminderRevision).toBe(expectedRevision);
    return result.json();
  };
  const waitHydration = () => page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("message-reminders?") && response.status() === 200);
  let hydrated = waitHydration();
  await page.goto(`${origin}/chat-lab.html`);
  await hydrated;
  await selectGeneral();
  const a = row(0);
  const b = row(1);
  const aId = await a.getAttribute("data-message-id");
  const bId = await b.getAttribute("data-message-id");
  await mutate(a, "In 20 minutes", 0);
  await mutate(a, "In 1 hour", 1);
  await mutate(a, "Cancel reminder", 2);
  const scheduledB = await mutate(b, "Tomorrow", 0);
  const authority = (await snapshot()).find(({ messageId }) => messageId === aId);
  expect(authority.reminderRevision).toBe(3);
  expect(authority.reminder.state).toBe("cancelled");
  expect(authority.lastScheduledDueAt).toBeTruthy();
  expect((await snapshot("ada", "false")).some(({ messageId }) => messageId === aId)).toBe(false);

  const verifyB = async () => {
    await expect(b.getByText("Reminder:", { exact: false })).toBeVisible();
    const stored = (await snapshot()).find(({ messageId }) => messageId === bId);
    expect(stored.reminderRevision).toBe(1);
    expect(new Date(stored.reminder.dueAt).toISOString()).toBe(scheduledB.reminder.dueAt);
  };
  hydrated = waitHydration();
  await page.reload();
  await hydrated;
  await selectGeneral();
  await verifyB();
  expect(writes).toHaveLength(4);
  await mutate(a, "In 1 hour", 3);
  await mutate(a, "Cancel reminder", 4);

  for (const [actor, name] of [["grace", "Grace Hopper"], ["ada", "Ada Lovelace"]]) {
    hydrated = waitHydration();
    await page.getByRole("button", { name: /^Development fixture identity:/ }).click();
    await page.getByRole("option", { name: new RegExp(name) }).click();
    await hydrated;
    await selectGeneral();
    expect(writes).toHaveLength(6);
    if (actor === "grace") {
      expect(await snapshot("grace")).toEqual([]);
      await expect(b.getByText("Reminder:", { exact: false })).toHaveCount(0);
    }
  }
  await verifyB();
  await mutate(a, "In 1 hour", 5);
  expect(writes).toHaveLength(7);
  expect(failures).toEqual([]);
});
