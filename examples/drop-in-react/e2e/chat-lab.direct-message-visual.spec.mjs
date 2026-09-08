import { expect, test } from "./chat-lab.direct-message-visual.fixture.mjs";

const DESKTOP_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const DIRECT_PARTICIPANT_NAME = "Grace Hopper";
const FIRST_DIRECT_MESSAGE = "Welcome to the real-stack Handrail Chat Lab.";
const LAST_DIRECT_MESSAGE =
  "Switch personas above to verify live delivery and read state.";
const BASELINE_DATE_LABEL = "August 28, 2026";
const BASELINE_MESSAGE_TIME_LABEL = "12:00 PM";
const DIRECT_MESSAGE_BASELINE =
  "chat-lab-stage-dark-direct-message-1440x900.png";
const RESOLVED_AVAILABILITY = /^(?:online|away|busy|offline)$/u;
const NAVIGATION_SECTION_LABELS = Object.freeze([
  "Public channels",
  "Private channels",
  "Direct messages",
  "Group conversations",
  "Threads",
]);

test.use({ trace: "retain-on-first-failure" });

const waitForManagedRealtimeConnection = async (page) => {
  await expect(page.locator('.chat-lab__realtime-announcement[role="status"]'))
    .toHaveAttribute("data-realtime-state", "connected");
};

const selectDarkTheme = async (workspace) => {
  const trigger = workspace.getByRole("button", { name: "Open theme settings" });
  await trigger.click();
  const menu = workspace.getByRole("menu", { name: "Theme settings" });
  await menu.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute("title", "Theme: Dark");
  await expect(workspace).toHaveAttribute("data-handrail-theme", "dark");
};

const expectHorizontallyContained = async (container, target) => {
  const [containerBox, targetBox, isClipped] = await Promise.all([
    container.boundingBox(),
    target.boundingBox(),
    target.evaluate((element) => element.scrollWidth > element.clientWidth),
  ]);
  expect(containerBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(targetBox.x).toBeGreaterThanOrEqual(containerBox.x - 0.5);
  expect(targetBox.x + targetBox.width)
    .toBeLessThanOrEqual(containerBox.x + containerBox.width + 0.5);
  expect(isClipped).toBe(false);
};

const prepareBaseline = async (page) => {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition: none !important;
      }
    `,
  });
  await page.evaluate(async ({ dateLabel, messageTimeLabel }) => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, async (image) => {
      if (!image.complete) {
        await new Promise((resolve) => {
          image.addEventListener("error", resolve, { once: true });
          image.addEventListener("load", resolve, { once: true });
        });
      }
      if (image.naturalWidth > 0) {
        await image.decode();
      }
    }));
    for (const time of document.querySelectorAll(".handrail-chat__timeline-date time")) {
      time.textContent = dateLabel;
    }
    for (const time of document.querySelectorAll(".handrail-chat__timeline-author time")) {
      time.textContent = messageTimeLabel;
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, {
    dateLabel: BASELINE_DATE_LABEL,
    messageTimeLabel: BASELINE_MESSAGE_TIME_LABEL,
  });
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    requestAnimationFrame(resolve);
  })));
};

test("captures the seeded dark direct-message conversation", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  expect(page.viewportSize()).toEqual(DESKTOP_VIEWPORT);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const target = new URL("/chat-lab.html", chatLabOrigin);
  target.searchParams.set("chatLabDirectMessageVisual", "true");
  const response = await page.goto(target.href);
  if (response === null || !response.ok()) {
    throw new Error(`Chat Lab navigation failed: ${response?.status() ?? "no response"}`);
  }

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const navigation = page.getByRole("navigation", { name: "Conversations" });
  await expect(workspace).toBeVisible();
  await waitForManagedRealtimeConnection(page);
  await selectDarkTheme(workspace);

  const workspaceTitle = navigation.getByRole("heading", {
    exact: true,
    level: 2,
    name: "Development workspace",
  });
  const conversationSearch = navigation.locator(
    ".handrail-chat__conversation-filter-input",
  );
  await expect(navigation).toBeVisible();
  await expect(workspaceTitle).toBeVisible();
  await expect(conversationSearch).toBeVisible();
  await expect(conversationSearch).toHaveAttribute(
    "placeholder",
    "Search conversations",
  );
  await expectHorizontallyContained(navigation, workspaceTitle);
  await expectHorizontallyContained(navigation, conversationSearch);
  for (const sectionLabel of NAVIGATION_SECTION_LABELS) {
    const label = navigation.locator(".handrail-chat__conversation-section-label", {
      hasText: sectionLabel,
    });
    await expect(label).toHaveText(sectionLabel);
    await expect(label).toBeVisible();
    await expectHorizontallyContained(navigation, label);
  }

  const directRows = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  );
  await expect(directRows).toHaveCount(1);
  const directRow = directRows.filter({
    has: page.locator(".handrail-chat__conversation-label", {
      hasText: DIRECT_PARTICIPANT_NAME,
    }),
  });
  await expect(directRow).toHaveCount(1);
  await expect(directRow.locator(".handrail-chat__conversation-label"))
    .toHaveText(DIRECT_PARTICIPANT_NAME);
  await expect(directRow.locator(".handrail-chat__conversation-label"))
    .toBeVisible();
  await expectHorizontallyContained(
    navigation,
    directRow.locator(".handrail-chat__conversation-label"),
  );
  await directRow.click();

  const selectedDirectRows = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]' +
      '[aria-current="page"]',
  );
  await expect(selectedDirectRows).toHaveCount(1);
  await expect(selectedDirectRows.locator(".handrail-chat__conversation-avatar-wrap"))
    .toBeVisible();
  await expect(selectedDirectRows.locator(".handrail-chat__conversation-avatar"))
    .toBeVisible();
  const navigationPresence = selectedDirectRows.locator(
    ".handrail-chat__conversation-presence",
  );
  await expect(navigationPresence).toBeVisible();
  await expect(navigationPresence).toHaveAttribute(
    "data-availability",
    RESOLVED_AVAILABILITY,
  );

  const conversation = workspace.locator(".handrail-chat__conversation");
  const [stageBox, navigationBox, conversationBox] = await Promise.all([
    page.locator(".chat-lab__stage").boundingBox(),
    navigation.boundingBox(),
    conversation.boundingBox(),
  ]);
  expect(stageBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(conversationBox).not.toBeNull();
  expect(navigationBox.width).toBeGreaterThanOrEqual(367);
  expect(navigationBox.x).toBeGreaterThanOrEqual(stageBox.x - 0.5);
  expect(navigationBox.x + navigationBox.width)
    .toBeLessThanOrEqual(conversationBox.x + 0.5);
  expect(conversationBox.x + conversationBox.width)
    .toBeLessThanOrEqual(stageBox.x + stageBox.width + 0.5);
  const header = conversation.locator(".handrail-chat__header");
  await expect(header.locator(".handrail-chat__header-identity--member"))
    .toHaveCount(1);
  await expect(header.locator(".handrail-chat__header-identity--channel"))
    .toHaveCount(0);
  await expect(header.locator(".handrail-chat__direct-participant")).toHaveCount(1);
  const participantHeading = header.getByRole("heading", {
    exact: true,
    level: 2,
    name: DIRECT_PARTICIPANT_NAME,
  });
  await expect(header.getByRole("heading", { level: 2 })).toHaveCount(1);
  await expect(participantHeading).toBeVisible();
  await expect(header.locator(".handrail-chat__direct-participant-title"))
    .toHaveText(DIRECT_PARTICIPANT_NAME);
  const participantAvailability = header.locator(
    ".handrail-chat__direct-participant-availability",
  );
  await expect(participantAvailability).toBeVisible();
  await expect(participantAvailability).toHaveAttribute(
    "data-availability",
    RESOLVED_AVAILABILITY,
  );
  await expect(participantAvailability).toHaveAttribute(
    "aria-label",
    /^(?:online|away|busy|offline) availability$/u,
  );

  const timeline = conversation.getByRole("region", {
    name: "Conversation timeline",
  });
  const feed = timeline.getByRole("feed", { name: "Message timeline" });
  await expect(feed).toBeVisible();
  const messageRows = feed.locator(".handrail-chat__timeline-item");
  await expect(messageRows).toHaveCount(2);
  const firstMessage = messageRows.nth(0);
  const lastMessage = messageRows.nth(1);
  await expect(firstMessage).toContainText(FIRST_DIRECT_MESSAGE);
  await expect(lastMessage).toContainText(LAST_DIRECT_MESSAGE);
  await expect(firstMessage).not.toHaveClass(/handrail-chat__timeline-item--grouped/u);
  await expect(lastMessage).not.toHaveClass(/handrail-chat__timeline-item--grouped/u);
  await expect(firstMessage.locator(".handrail-chat__timeline-author"))
    .toContainText("Ada Lovelace");
  await expect(lastMessage.locator(".handrail-chat__timeline-author"))
    .toContainText(DIRECT_PARTICIPANT_NAME);
  await expect(firstMessage.getByLabel("Read by recipient")).toBeVisible();
  await expect(lastMessage.getByLabel("Read by recipient")).toHaveCount(0);

  const composer = conversation.getByLabel("Conversation composer")
    .getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute(
    "placeholder",
    `Message ${DIRECT_PARTICIPANT_NAME}`,
  );

  await prepareBaseline(page);
  await expect(page.locator(".chat-lab__stage")).toHaveScreenshot(
    DIRECT_MESSAGE_BASELINE,
    {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 100,
      threshold: 0.1,
    },
  );
});
