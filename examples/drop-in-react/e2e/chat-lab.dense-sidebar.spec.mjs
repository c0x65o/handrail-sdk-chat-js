import {
  CHAT_LAB_DENSE_LONG_CHANNEL_NAME,
  CHAT_LAB_DENSE_LONG_PARTICIPANT_NAME,
} from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.dense-sidebar.fixture.mjs";

const rowFor = (navigation, conversationId) => navigation.locator(
  `.handrail-chat__conversation-button[data-conversation-id="${conversationId}"]`,
);

const stableRect = async (locator) => {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};

test("dense sidebar paginates, scrolls independently, and renders canonical row states", async ({
  denseChatLab,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${denseChatLab.origin}/chat-lab.html`);

  const workspace = page.getByRole("region", { name: "Handrail Chat Lab workspace" });
  const navigation = workspace.getByRole("navigation", { name: "Conversations" });
  const fixture = denseChatLab.denseSidebar;
  const rows = navigation.locator(".handrail-chat__conversation-button[data-conversation-id]");
  await expect(rows).toHaveCount(fixture.pagination.initialConversationIds.length);
  expect(await rows.evaluateAll((elements) => elements.map(
    (element) => element.getAttribute("data-conversation-id"),
  ))).toEqual(fixture.pagination.initialConversationIds);

  const knownLater = rowFor(navigation, fixture.pagination.laterConversationId);
  await expect(knownLater).toHaveCount(0);
  const loadMore = navigation.getByRole("button", { name: "Load more conversations" });
  await expect(loadMore).toBeEnabled();

  const selectedConversation = rowFor(navigation, fixture.states.selected);
  const expectSelectionUnchanged = async () => {
    await expect(selectedConversation).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator(
      '.handrail-chat__conversation-button[aria-current="page"]',
    )).toHaveAttribute("data-conversation-id", fixture.states.selected);
  };
  await expectSelectionUnchanged();

  const paginationScrollTop = await navigation.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(paginationScrollTop).toBeGreaterThan(0);
  await expect(knownLater).toHaveCount(1);
  await expect(rows).toHaveCount(fixture.seededConversationCount);
  await expect.poll(async () => {
    if (await loadMore.count() === 0) return "absent";
    return await loadMore.isDisabled() ? "disabled" : "enabled";
  }).toMatch(/^(?:absent|disabled)$/u);
  expect(Math.abs(
    await navigation.evaluate((element) => element.scrollTop) - paginationScrollTop,
  )).toBeLessThanOrEqual(1);
  await expectSelectionUnchanged();

  const overflow = await navigation.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);

  const visibleRowHeights = await rows.evaluateAll((elements) => {
    const navigationElement = elements[0]?.closest(".handrail-chat__navigation");
    if (navigationElement === null || navigationElement === undefined) return [];
    const navigationRect = navigationElement.getBoundingClientRect();
    return elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > navigationRect.top && rect.top < navigationRect.bottom
        ? [rect.height]
        : [];
    });
  });
  expect(visibleRowHeights.length).toBeGreaterThan(0);
  for (const height of visibleRowHeights) {
    expect(height).toBeGreaterThanOrEqual(30);
    expect(height).toBeLessThanOrEqual(34);
  }

  const longChannel = rowFor(navigation, fixture.states.longChannel);
  await longChannel.scrollIntoViewIfNeeded();
  await expect(longChannel).toHaveAttribute("title", new RegExp(CHAT_LAB_DENSE_LONG_CHANNEL_NAME, "u"));
  const longChannelTruncation = await longChannel.locator(
    ".handrail-chat__conversation-label",
  ).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(longChannelTruncation.scrollWidth).toBeGreaterThan(longChannelTruncation.clientWidth);

  await expect(navigation.locator(
    ".handrail-chat__notification-preferences-trigger",
  )).toHaveCount(0);

  const longParticipant = rowFor(navigation, fixture.states.longParticipantDirect);
  await longParticipant.scrollIntoViewIfNeeded();
  await expect(longParticipant).toHaveAttribute(
    "title",
    new RegExp(CHAT_LAB_DENSE_LONG_PARTICIPANT_NAME, "u"),
  );
  const longParticipantTruncation = await longParticipant.locator(
    ".handrail-chat__conversation-label",
  ).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(longParticipantTruncation.scrollWidth).toBeGreaterThan(
    longParticipantTruncation.clientWidth,
  );

  await expect(rowFor(navigation, fixture.states.unread).locator(
    ".handrail-chat__conversation-unread-badge",
  )).toHaveText("2");
  const mention = rowFor(navigation, fixture.states.mention);
  await expect(mention).toHaveAttribute("data-unread-mention-count", "1");
  await expect(mention.locator(".handrail-chat__conversation-mention-badge")).toHaveText("@1");
  const muted = rowFor(navigation, fixture.states.muted);
  await expect(muted).toHaveAttribute("data-muted", "true");
  await expect(muted).toHaveAccessibleName(
    /Notifications: All messages; Muted indefinitely$/u,
  );
  const mutedIndicator = muted.locator(
    '.handrail-chat__conversation-muted-indicator[data-mute-state="indefinite"]',
  );
  await expect(mutedIndicator).toHaveCount(1);
  await expect(mutedIndicator).toHaveAttribute("title", "Muted indefinitely");
  const mentionsOnly = rowFor(navigation, fixture.states.mentionsOnly);
  await expect(mentionsOnly).toHaveAttribute(
    "data-notification-level",
    "mentions",
  );
  await expect(mentionsOnly).toHaveAccessibleName(
    /Notifications: Mentions only; Unmuted$/u,
  );
  await expect(mentionsOnly.locator(
    ".handrail-chat__conversation-muted-indicator",
  )).toHaveCount(0);
  await expect(rowFor(navigation, fixture.states.onlineDirect).locator(
    '.handrail-chat__conversation-presence[data-availability="online"]',
  )).toHaveCount(1);
  await expect(rowFor(navigation, fixture.states.offlineDirect).locator(
    '.handrail-chat__conversation-presence[data-availability="offline"]',
  )).toHaveCount(1);
  const privateChannel = rowFor(navigation, fixture.states.privateChannel);
  await expect(privateChannel).toHaveAttribute(
    "data-conversation-kind",
    "private-channel",
  );
  await expect(privateChannel.locator(
    ".handrail-chat__conversation-icon--private-channel",
  )).toHaveCount(1);
  const activeHuddle = rowFor(navigation, fixture.states.activeHuddle);
  await expect(activeHuddle).toHaveAttribute("data-huddle-state", "active");
  await expect(activeHuddle.locator(".handrail-chat__conversation-huddle-indicator")).toHaveCount(1);

  const header = workspace.locator(".handrail-chat__header");
  const timeline = workspace.locator(".handrail-chat__timeline-viewport");
  const composer = workspace.locator(".handrail-chat__composer-region");
  const before = {
    header: await stableRect(header),
    timeline: await stableRect(timeline),
    composer: await stableRect(composer),
  };
  await navigation.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => navigation.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await stableRect(header)).toEqual(before.header);
  expect(await stableRect(timeline)).toEqual(before.timeline);
  expect(await stableRect(composer)).toEqual(before.composer);

  const horizontalOverflow = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(horizontalOverflow.scrollWidth).toBeLessThanOrEqual(horizontalOverflow.clientWidth);
  const navigationHorizontalOverflow = await navigation.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(navigationHorizontalOverflow.scrollWidth).toBeLessThanOrEqual(
    navigationHorizontalOverflow.clientWidth,
  );
});

test("dense sidebar retains manual pagination without IntersectionObserver", async ({
  denseChatLab,
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: undefined,
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${denseChatLab.origin}/chat-lab.html`);

  const workspace = page.getByRole("region", { name: "Handrail Chat Lab workspace" });
  const navigation = workspace.getByRole("navigation", { name: "Conversations" });
  const fixture = denseChatLab.denseSidebar;
  const rows = navigation.locator(".handrail-chat__conversation-button[data-conversation-id]");
  const knownLater = rowFor(navigation, fixture.pagination.laterConversationId);
  await expect(rows).toHaveCount(fixture.pagination.initialConversationIds.length);
  await expect(knownLater).toHaveCount(0);

  await navigation.getByRole("button", { name: "Load more conversations" }).click();

  await expect(knownLater).toHaveCount(1);
  await expect(rows).toHaveCount(fixture.seededConversationCount);
});
