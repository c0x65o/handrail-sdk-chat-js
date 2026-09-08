import path from "node:path";

import { expect, test } from "./chat-lab.fixture.mjs";

const SEEDED_TIMELINE = Object.freeze([
  "Welcome to the real-stack Handrail Chat Lab.",
  "Switch personas above to verify live delivery and read state.",
]);

test.use({ trace: "retain-on-failure" });

const captureWorkspaceState = async (page) => page.evaluate(() => {
  const requiredElement = (selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Expected Chat Lab element: ${selector}`);
    }
    return element;
  };
  const rectangle = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return Object.freeze({
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      width: Math.round(width * 100) / 100,
      height: Math.round(height * 100) / 100,
    });
  };

  const shell = requiredElement(".chat-lab");
  const workspace = requiredElement(".handrail-chat--workspace");
  const navigation = requiredElement(".handrail-chat__navigation");
  const conversation = requiredElement(".handrail-chat__conversation");
  const header = requiredElement(".handrail-chat__header");
  const main = requiredElement(".handrail-chat__main");
  const body = requiredElement(".handrail-chat__conversation-body");
  const timelineViewport = requiredElement(".handrail-chat__timeline-viewport");
  const composer = requiredElement(".handrail-chat__composer-region");
  const conversationLayout = [conversation, main, body, timelineViewport, composer];
  const scrollOwners = conversationLayout
    .filter((element) => {
      const overflowY = getComputedStyle(element).overflowY;
      return overflowY === "auto" || overflowY === "scroll";
    })
    .map((element) => `.${element.className.trim().split(/\s+/u).join(".")}`);

  return Object.freeze({
    documentFitsViewport:
      document.documentElement.scrollHeight <= window.innerHeight + 1 &&
      document.documentElement.scrollWidth <= window.innerWidth + 1,
    rectangles: Object.freeze({
      shell: rectangle(shell),
      workspace: rectangle(workspace),
      navigation: rectangle(navigation),
      conversation: rectangle(conversation),
      header: rectangle(header),
      main: rectangle(main),
      timelineViewport: rectangle(timelineViewport),
      composer: rectangle(composer),
    }),
    scrollOwners,
  });
});

const expectStableGeometry = (actual, baseline) => {
  expect(actual.documentFitsViewport).toBe(true);
  expect(actual.scrollOwners).toEqual([".handrail-chat__timeline-viewport"]);
  for (const [region, expectedRectangle] of Object.entries(baseline.rectangles)) {
    const actualRectangle = actual.rectangles[region];
    for (const dimension of ["x", "y", "width", "height"]) {
      expect(
        Math.abs(actualRectangle[dimension] - expectedRectangle[dimension]),
        `${region} ${dimension} changed during managed realtime recovery`,
      ).toBeLessThanOrEqual(1);
    }
  }
};

const attachScreenshot = async (page, testInfo, name) => {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
  console.log(`${name}: ${path.relative(process.cwd(), screenshotPath)}`);
};

test("keeps the selected Chat Lab conversation stable while offline and after recovery", async ({
  chatLabOrigin,
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);

  const realtimeAnnouncement = page.locator('.chat-lab__realtime-announcement[role="status"]');
  const realtimeNotice = page.locator(".chat-lab__realtime-status");
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");
  await expect(realtimeAnnouncement).toHaveText("Managed realtime connected");
  await expect(realtimeNotice).toHaveCount(0);

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const navigation = page.getByRole("navigation", { name: "Conversations" });
  const directConversation = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  );
  await expect(directConversation).toHaveCount(1);
  await directConversation.click();
  await expect(directConversation).toHaveAttribute("aria-current", "page");

  const activeRows = navigation.locator(
    '.handrail-chat__conversation-button[aria-current="page"]',
  );
  await expect(activeRows).toHaveCount(1);
  const conversationId = await directConversation.getAttribute("data-conversation-id");
  expect(conversationId).not.toBeNull();
  const conversationLabel = await directConversation
    .locator(".handrail-chat__conversation-label")
    .innerText();
  const conversationHeader = workspace.getByRole("heading", {
    exact: true,
    level: 2,
    name: conversationLabel,
  });
  await expect(conversationHeader).toHaveText(conversationLabel);

  const timelineMessages = workspace.locator(
    ".handrail-chat__timeline-feed > .handrail-chat__timeline-item .handrail-chat__timeline-text",
  );
  await expect(timelineMessages).toHaveText([...SEEDED_TIMELINE]);
  const messageIds = await workspace
    .locator(".handrail-chat__timeline-feed > [data-message-id]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id")));
  expect(messageIds).toHaveLength(SEEDED_TIMELINE.length);
  expect(new Set(messageIds).size).toBe(messageIds.length);

  const composerRegion = workspace.getByLabel("Conversation composer");
  const composer = composerRegion.getByRole("textbox");
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();

  const themeSettingsTrigger = workspace.getByRole("button", {
    name: "Open theme settings",
  });
  await themeSettingsTrigger.click();
  await workspace.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(themeSettingsTrigger).toHaveAttribute("title", "Theme: Dark");
  await expect(page.locator(".chat-lab")).toHaveAttribute(
    "data-chat-lab-effective-theme",
    "dark",
  );
  await expect(workspace).toHaveAttribute("data-handrail-theme", "dark");

  const baselineGeometry = await captureWorkspaceState(page);
  expectStableGeometry(baselineGeometry, baselineGeometry);

  await context.setOffline(true);
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "offline");
  await expect(realtimeAnnouncement).toHaveText("Managed realtime offline");
  await expect(realtimeNotice).toHaveAttribute("data-realtime-state", "offline");
  await expect(realtimeNotice).toHaveText("Offline");
  await expect(realtimeNotice).toBeVisible();

  await expect(activeRows).toHaveCount(1);
  await expect(directConversation).toHaveAttribute("aria-current", "page");
  await expect(directConversation).toHaveAttribute("data-conversation-id", conversationId);
  await expect(conversationHeader).toHaveText(conversationLabel);
  await expect(timelineMessages).toHaveText([...SEEDED_TIMELINE]);
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeEnabled();
  expect(
    await workspace.locator(".handrail-chat__timeline-feed > [data-message-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
  ).toEqual(messageIds);
  expectStableGeometry(await captureWorkspaceState(page), baselineGeometry);
  await attachScreenshot(page, testInfo, "chat-lab-dark-theme-offline");

  await page.evaluate(() => {
    const announcement = document.querySelector(
      ".chat-lab__realtime-announcement[role=status]",
    );
    if (!(announcement instanceof HTMLElement)) {
      throw new Error("Managed realtime announcement is missing");
    }
    const observedStates = [];
    const observer = new MutationObserver((records) => {
      const transition = [
        ...records.map((record) => record.oldValue),
        announcement.getAttribute("data-realtime-state"),
      ];
      for (const state of transition.slice(1)) {
        if (state !== null && observedStates.at(-1) !== state) observedStates.push(state);
      }
      if (observedStates.at(-1) === "connected") observer.disconnect();
    });
    observer.observe(announcement, {
      attributeFilter: ["data-realtime-state"],
      attributeOldValue: true,
    });
    window.__chatLabRecoveryStates = observedStates;
  });

  const visibleRecoveryNotice = page.waitForFunction(() => {
    const notice = document.querySelector(".chat-lab__realtime-status");
    if (!(notice instanceof HTMLElement)) return false;
    const state = notice.getAttribute("data-realtime-state");
    const bounds = notice.getBoundingClientRect();
    return ["connecting", "reconnecting", "hydrating_snapshot"].includes(state ?? "") &&
      getComputedStyle(notice).display !== "none" && bounds.width > 0 && bounds.height > 0
      ? state
      : false;
  });
  await context.setOffline(false);
  const visibleRecoveryStateHandle = await visibleRecoveryNotice;
  const visibleRecoveryState = await visibleRecoveryStateHandle.jsonValue();
  await visibleRecoveryStateHandle.dispose();
  expect(["connecting", "reconnecting", "hydrating_snapshot"]).toContain(
    visibleRecoveryState,
  );
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");
  await expect(realtimeAnnouncement).toHaveText("Managed realtime connected");
  await expect(realtimeNotice).toHaveCount(0);
  const recoveryStates = await page.evaluate(() => window.__chatLabRecoveryStates ?? []);
  expect(
    recoveryStates.some((state) => [
      "connecting",
      "reconnecting",
      "hydrating_snapshot",
    ].includes(state)),
    `Expected a managed recovery state before Connected; observed ${recoveryStates.join(", ")}`,
  ).toBe(true);
  expect(recoveryStates.at(-1)).toBe("connected");

  await expect(activeRows).toHaveCount(1);
  await expect(directConversation).toHaveAttribute("aria-current", "page");
  await expect(directConversation).toHaveAttribute("data-conversation-id", conversationId);
  await expect(conversationHeader).toHaveText(conversationLabel);
  await expect(timelineMessages).toHaveText([...SEEDED_TIMELINE]);
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeEnabled();
  const recoveredMessageIds = await workspace
    .locator(".handrail-chat__timeline-feed > [data-message-id]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id")));
  expect(recoveredMessageIds).toEqual(messageIds);
  expect(new Set(recoveredMessageIds).size).toBe(recoveredMessageIds.length);
  expectStableGeometry(await captureWorkspaceState(page), baselineGeometry);
  await attachScreenshot(page, testInfo, "chat-lab-dark-theme-recovered");
});
