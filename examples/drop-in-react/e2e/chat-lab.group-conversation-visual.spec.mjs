import {
  CHAT_LAB_GROUP_DIRECT_MESSAGES,
} from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.fixture.mjs";

const DESKTOP_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const GROUP_PARTICIPANT_NAMES = Object.freeze([
  "Grace Hopper",
  "Margaret Hamilton",
]);
const CURRENT_PARTICIPANT_NAME = "Ada Lovelace";
const DISPLAY_NAME_BY_ACTOR = Object.freeze({
  ada: CURRENT_PARTICIPANT_NAME,
  grace: GROUP_PARTICIPANT_NAMES[0],
  margaret: GROUP_PARTICIPANT_NAMES[1],
});
const BASELINE_DATE_LABEL = "August 28, 2026";
const BASELINE_MESSAGE_TIME_LABEL = "12:00 PM";
const GROUP_CONVERSATION_BASELINE =
  "chat-lab-stage-dark-group-conversation-1440x900.png";

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

const captureLayout = async (page) => page.evaluate(() => {
  const requiredElement = (selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Expected Chat Lab element: ${selector}`);
    }
    return element;
  };
  const measure = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      rect: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      },
      scrollWidth: element.scrollWidth,
      visible:
        !element.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0,
    };
  };

  return {
    document: {
      body: measure(document.body),
      documentElement: measure(document.documentElement),
    },
    regions: {
      composer: measure(requiredElement(".handrail-chat__composer-region")),
      conversation: measure(requiredElement(".handrail-chat__conversation")),
      header: measure(requiredElement(".handrail-chat__header")),
      navigation: measure(requiredElement(".handrail-chat__navigation")),
      stage: measure(requiredElement(".chat-lab__stage")),
      timeline: measure(requiredElement(".handrail-chat__timeline-viewport")),
      workspace: measure(requiredElement(".handrail-chat--workspace")),
    },
    viewport: { height: window.innerHeight, width: window.innerWidth },
  };
});

const expectGroupLayoutBounded = (layout) => {
  const diagnostic = `Group conversation layout: ${JSON.stringify(layout)}`;
  expect(layout.regions.stage.rect.left, diagnostic).toBeGreaterThanOrEqual(-1);
  expect(layout.regions.stage.rect.top, diagnostic).toBeGreaterThanOrEqual(-1);
  expect(layout.regions.stage.rect.right, diagnostic)
    .toBeLessThanOrEqual(layout.viewport.width + 1);
  expect(layout.regions.stage.rect.bottom, diagnostic)
    .toBeLessThanOrEqual(layout.viewport.height + 1);

  for (const [label, measurement] of Object.entries({
    navigation: layout.regions.navigation,
    conversation: layout.regions.conversation,
    header: layout.regions.header,
    timeline: layout.regions.timeline,
    composer: layout.regions.composer,
  })) {
    expect(measurement.visible, `${label}; ${diagnostic}`).toBe(true);
    expect(measurement.rect.left, `${label}; ${diagnostic}`)
      .toBeGreaterThanOrEqual(layout.regions.stage.rect.left - 1);
    expect(measurement.rect.top, `${label}; ${diagnostic}`)
      .toBeGreaterThanOrEqual(layout.regions.stage.rect.top - 1);
    expect(measurement.rect.right, `${label}; ${diagnostic}`)
      .toBeLessThanOrEqual(layout.regions.stage.rect.right + 1);
    expect(measurement.rect.bottom, `${label}; ${diagnostic}`)
      .toBeLessThanOrEqual(layout.regions.stage.rect.bottom + 1);
  }

  for (const [label, measurement] of Object.entries({
    body: layout.document.body,
    document: layout.document.documentElement,
    workspace: layout.regions.workspace,
  })) {
    expect(
      measurement.scrollWidth,
      `${label} horizontal overflow; ${diagnostic}`,
    ).toBeLessThanOrEqual(measurement.clientWidth + 1);
  }
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

test("captures the populated dark group conversation", async ({
  chatLab,
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  expect(page.viewportSize()).toEqual(DESKTOP_VIEWPORT);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.goto(new URL("/chat-lab.html", chatLab.origin).href);
  if (response === null || !response.ok()) {
    throw new Error(`Chat Lab navigation failed: ${response?.status() ?? "no response"}`);
  }

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const navigation = page.getByRole("navigation", { name: "Conversations" });
  await expect(workspace).toBeVisible();
  await waitForManagedRealtimeConnection(page);
  await selectDarkTheme(workspace);

  const groupRow = navigation.locator(
    `button[data-conversation-id=${JSON.stringify(chatLab.conversationIds.groupDirect)}]`,
  );
  await expect(groupRow).toHaveCount(1);
  await expect(groupRow).toHaveAttribute("data-conversation-kind", "group-direct");
  const groupLabel = (await groupRow.locator(
    ".handrail-chat__conversation-label",
  ).textContent())?.trim();
  expect(groupLabel).toBe(GROUP_PARTICIPANT_NAMES.join(", "));
  await expect(groupRow.locator(".handrail-chat__conversation-avatar-stack"))
    .toBeVisible();
  await groupRow.click();
  await expect(groupRow).toHaveAttribute("aria-current", "page");

  const conversation = workspace.locator(
    `.handrail-chat__conversation[data-conversation-id=${JSON.stringify(
      chatLab.conversationIds.groupDirect,
    )}]`,
  );
  const header = conversation.locator(".handrail-chat__header");
  await expect(header.locator(".handrail-chat__header-identity--member"))
    .toHaveCount(1);
  await expect(header.locator(".handrail-chat__header-identity--channel"))
    .toHaveCount(0);
  await expect(header.locator(".handrail-chat__group-direct-avatar-stack"))
    .toBeVisible();
  const groupHeading = header.getByRole("heading", {
    exact: true,
    level: 2,
    name: groupLabel,
  });
  await expect(groupHeading).toBeVisible();
  for (const participantName of GROUP_PARTICIPANT_NAMES) {
    await expect(groupHeading).toContainText(participantName);
  }
  await expect(groupHeading).not.toContainText(CURRENT_PARTICIPANT_NAME);

  const feed = conversation.getByRole("feed", { name: "Message timeline" });
  await expect(feed).toBeVisible();
  const normalMessages = [];
  for (const [index, fixture] of CHAT_LAB_GROUP_DIRECT_MESSAGES.entries()) {
    const message = feed.locator(
      `[data-message-id=${JSON.stringify(chatLab.groupDirectMessageIds[index])}]`,
    );
    normalMessages.push(message);
    await expect(message).toBeVisible();
    await expect(message).toContainText(fixture.text);
    await expect(message.locator(".handrail-chat__timeline-author"))
      .toContainText(DISPLAY_NAME_BY_ACTOR[fixture.authorId]);
    const groupedWithPrevious = index > 0 &&
      fixture.authorId === CHAT_LAB_GROUP_DIRECT_MESSAGES[index - 1].authorId;
    if (groupedWithPrevious) {
      await expect(message).toHaveClass(/handrail-chat__timeline-item--grouped/u);
    } else {
      await expect(message).not.toHaveClass(/handrail-chat__timeline-item--grouped/u);
    }
  }
  expect(normalMessages).toHaveLength(3);

  const deletedMessage = feed.locator(
    `[data-message-id=${JSON.stringify(chatLab.deletedGroupDirectMessage.id)}]`,
  );
  await expect(deletedMessage).toBeVisible();
  await expect(
    deletedMessage.getByText("This message was deleted.", { exact: true }),
  ).toBeVisible();
  await expect(deletedMessage).not.toContainText(
    chatLab.deletedGroupDirectMessage.originalText,
  );

  const composer = conversation.getByLabel("Conversation composer")
    .getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", `Message ${groupLabel}`);

  expectGroupLayoutBounded(await captureLayout(page));
  await prepareBaseline(page);
  await expect(page.locator(".chat-lab__stage")).toHaveScreenshot(
    GROUP_CONVERSATION_BASELINE,
    {
      animations: "disabled",
      caret: "hide",
      maxDiffPixels: 100,
      threshold: 0.1,
    },
  );
});
