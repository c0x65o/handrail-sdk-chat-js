import { expect, test } from "./chat-lab.fixture.mjs";

const expectWorkspaceFitsViewport = async (page) => {
  const layout = await page.evaluate(() => {
    const measure = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Missing Chat Lab layout element: ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      };
    };
    return {
      composer: measure(".handrail-chat__composer-region"),
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      header: measure(".handrail-chat__header"),
      viewport: { height: innerHeight, width: innerWidth },
    };
  });
  const diagnostic = JSON.stringify(layout);
  expect(layout.documentScrollWidth, diagnostic)
    .toBeLessThanOrEqual(layout.documentClientWidth + 1);
  for (const [name, rect] of Object.entries({
    composer: layout.composer,
    header: layout.header,
  })) {
    expect(rect.left, `${name} left bound: ${diagnostic}`).toBeGreaterThanOrEqual(-1);
    expect(rect.right, `${name} right bound: ${diagnostic}`)
      .toBeLessThanOrEqual(layout.viewport.width + 1);
    expect(rect.top, `${name} top bound: ${diagnostic}`).toBeGreaterThanOrEqual(-1);
    expect(rect.bottom, `${name} bottom bound: ${diagnostic}`)
      .toBeLessThanOrEqual(layout.viewport.height + 1);
  }
};

const setFixtureConnectionStatus = (page, status) => page.evaluate((nextStatus) => {
  const fixture = window.__handrailChatLabHuddleFixture;
  if (fixture === undefined) {
    throw new Error("The opt-in Chat Lab huddle fixture bridge is unavailable");
  }
  return fixture.setConnectionStatus(nextStatus);
}, status);

test("configures real huddle media during an ordinary Chat Lab visit", async ({
  chatLabOrigin,
  page,
}) => {
  const response = await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  expect(response?.ok()).toBe(true);

  await page.getByText("About").click();
  await expect(page.getByText(
    "Huddle media is configured for this Chat Lab session. Availability depends on the supplied adapter.",
  )).toBeVisible();
  expect(await page.evaluate(() => window.__handrailChatLabHuddleFixture))
    .toBeUndefined();
  await page.getByText("About").click();

  const workspace = page.getByRole("region", { name: "Handrail Chat Lab workspace" });
  const navigation = workspace.getByRole("navigation", { name: "Conversations" });
  await expect(page.locator('.chat-lab__realtime-announcement[role="status"]'))
    .toHaveAttribute("data-realtime-state", "connected");
  await navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  ).click();
  await expect(workspace.getByRole("heading", { name: "Grace Hopper" }))
    .toBeVisible();
  await expect(workspace.getByRole("button", { name: "Start huddle" })).toBeEnabled();
  await expect(workspace.getByRole("button", { name: "Join huddle" })).toHaveCount(0);
  await expect(workspace.getByRole("region", { name: "Huddle controls" })).toHaveCount(0);
});

test("renders and recovers the canonical huddle reconnecting state", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const url = new URL("/chat-lab.html", chatLabOrigin);
  url.searchParams.set("chatLabHuddleFixture", "enabled");
  const response = await page.goto(url.href);
  expect(response?.ok()).toBe(true);

  const workspace = page.getByRole("region", { name: "Handrail Chat Lab workspace" });
  const navigation = workspace.getByRole("navigation", { name: "Conversations" });
  await expect(page.locator('.chat-lab__realtime-announcement[role="status"]'))
    .toHaveAttribute("data-realtime-state", "connected");
  await navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  ).click();

  const huddle = workspace.getByRole("region", { name: "Huddle controls" });
  await huddle.getByRole("button", { name: "Start huddle" }).click();
  await huddle.getByRole("button", { name: "Join huddle" }).click();
  await expect(huddle.getByText("Huddle is active.")).toBeVisible();
  await expect(huddle.getByText("Media connection: Connected.")).toBeVisible();

  expect(await setFixtureConnectionStatus(page, "reconnecting")).toBe(true);
  await expect(huddle.getByText("Media connection: Reconnecting.")).toBeVisible();
  await expect(huddle.getByRole("button", { name: "Leave huddle" })).toBeEnabled();
  await expect(huddle.getByRole("button", { name: "Unmute microphone" })).toBeDisabled();
  await huddle.getByRole("button", { name: "Open huddle details" }).click();
  const details = huddle.getByRole("dialog", { name: "Huddle details" });
  await expect(details).toBeVisible();
  await expect(details.getByRole("list", { name: "Huddle participants" }))
    .toContainText("ada");
  await expect(details.getByText("Microphone muted.")).toBeVisible();
  await expectWorkspaceFitsViewport(page);

  expect(await setFixtureConnectionStatus(page, "connected")).toBe(true);
  await expect(huddle.getByText("Media connection: Connected.")).toBeVisible();
  const microphone = huddle.getByRole("button", { name: "Unmute microphone" });
  await expect(microphone).toBeEnabled();
  await microphone.click();
  await expect(details.getByText("Microphone unmuted.")).toBeVisible();
  await huddle.getByRole("button", { name: "Leave huddle" }).click();
  await expect(details.getByText(/ada \(left\)/u)).toBeVisible();
});
