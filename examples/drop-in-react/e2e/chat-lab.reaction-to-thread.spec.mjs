import path from "node:path";

import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ hasTouch: true, trace: "on" });

const ROOT_MESSAGE = "Welcome to the real-stack Handrail Chat Lab.";
const REACTION_KEY = "🚀";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

const createReactionBarrier = async ({
  messageId,
  operation,
  page,
  reactionKey,
}) => {
  const requestSeen = deferred();
  const releaseRequest = deferred();
  const responseSeen = deferred();

  await page.route("**/api/chat/messages/*/reactions/*", async (route) => {
    try {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const payload = request.postDataJSON();
      requestSeen.resolve({
        method: request.method(),
        pathname: requestUrl.pathname,
        payload,
      });

      await releaseRequest.promise;
      const response = await route.fetch();
      const responsePayload = await response.json();
      await route.fulfill({ response });
      responseSeen.resolve({
        payload: responsePayload,
        status: response.status(),
      });
    } catch (error) {
      requestSeen.reject(error);
      responseSeen.reject(error);
      await route.abort("failed");
    }
  }, { times: 1 });

  return Object.freeze({
    async expectRequest() {
      const observed = await requestSeen.promise;
      expect(observed.method).toBe("PATCH");
      expect(observed.pathname).toBe(
        `/api/chat/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionKey)}`,
      );
      expect(observed.payload).toEqual({
        operation,
        messageId,
        reactionKey,
        idempotencyKey: expect.any(String),
      });
      expect(observed.payload.idempotencyKey.length).toBeGreaterThan(0);
    },
    release() {
      releaseRequest.resolve();
    },
    response: responseSeen.promise,
  });
};

const measureCompactThreadGeometry = async (page) => page.evaluate(() => {
  const requireElement = (selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Expected compact thread element: ${selector}`);
    }
    return element;
  };
  const rectangle = (element) => {
    const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
    return Object.freeze({ bottom, height, left, right, top, width });
  };
  const isScrollable = (element) => {
    const style = getComputedStyle(element);
    return (style.overflowY === "auto" || style.overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight + 1;
  };

  const thread = requireElement(".handrail-chat__thread-panel");
  const close = requireElement('.handrail-chat__thread-close[aria-label="Close thread"]');
  const composer = requireElement('textarea[aria-label="Reply to thread"]');
  const threadSection = requireElement(".handrail-chat__thread");
  const threadTimeline = requireElement(
    ".handrail-chat__thread-panel .handrail-chat__timeline-viewport",
  );
  const documentElement = document.documentElement;
  const body = document.body;
  const overflowContributors = [...document.querySelectorAll("body *")]
    .filter((element) => element instanceof HTMLElement)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        className: element.className,
        clientHeight: element.clientHeight,
        overflowY: style.overflowY,
        rect: rectangle(element),
        role: element.getAttribute("role"),
        scrollHeight: element.scrollHeight,
        tagName: element.tagName.toLowerCase(),
      };
    })
    .filter((item) =>
      item.rect.bottom > window.innerHeight + 1 ||
      (item.scrollHeight > item.clientHeight + 1 && item.overflowY === "visible")
    )
    .sort((left, right) => right.rect.bottom - left.rect.bottom)
    .slice(0, 12);

  return Object.freeze({
    viewport: Object.freeze({ height: window.innerHeight, width: window.innerWidth }),
    document: Object.freeze({
      clientHeight: documentElement.clientHeight,
      clientWidth: documentElement.clientWidth,
      scrollHeight: documentElement.scrollHeight,
      scrollWidth: documentElement.scrollWidth,
    }),
    body: Object.freeze({
      clientHeight: body.clientHeight,
      clientWidth: body.clientWidth,
      scrollHeight: body.scrollHeight,
      scrollWidth: body.scrollWidth,
    }),
    rectangles: Object.freeze({
      close: rectangle(close),
      composer: rectangle(composer),
      thread: rectangle(thread),
    }),
    overflowContributors: Object.freeze(overflowContributors),
    verticalScrollOwners: Object.freeze([
      ["document", documentElement.scrollHeight > documentElement.clientHeight + 1],
      ["body", body.scrollHeight > body.clientHeight + 1],
      ["thread-section", isScrollable(threadSection)],
      ["thread-timeline", isScrollable(threadTimeline)],
    ].filter(([, scrollable]) => scrollable).map(([name]) => name)),
  });
});

test("keeps tablet reaction navigation inside the picker and restores trigger focus", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  await workspace.getByRole("button", { name: "Open theme settings" }).click();
  await workspace.getByRole("menuitemradio", { name: "Dark" }).click();
  await page.getByRole("button", {
    name: "Development fixture identity: Ada Lovelace",
  }).click();
  const identityMenu = page.getByRole("listbox", {
    name: "Development fixture identities",
  });
  await identityMenu.getByRole("option", { name: "Grace Hopper Engineering" }).click();
  await expect(page.getByRole("button", {
    name: "Development fixture identity: Grace Hopper",
  })).toBeVisible();

  const navigation = page.getByRole("navigation", { name: "Conversations" });
  const directConversation = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  );
  await expect(directConversation).toHaveCount(1);
  await expect(directConversation).toHaveAccessibleName(
    /^Ada Lovelace(?: \((?:online|away|busy|offline)\))?(?:, .+)*$/u,
  );
  await directConversation.click();

  const timeline = workspace.getByRole("region", { name: "Conversation timeline" });
  const message = timeline.getByRole("article").filter({ hasText: ROOT_MESSAGE });
  await expect(message).toHaveCount(1);
  await message.hover();

  const trigger = message.getByRole("button", { name: "Add reaction", exact: true });
  await trigger.click();
  const picker = message.getByRole("dialog", {
    name: /^Choose a reaction for message from /u,
  });
  const search = picker.getByRole("searchbox", { name: "Search reactions" });
  await expect(search).toBeFocused();

  await search.press("ArrowDown");
  const firstReaction = picker.getByRole("button", {
    name: "Grinning face",
    exact: true,
  });
  await expect(firstReaction).toBeFocused();

  await search.focus();
  await search.press("ArrowUp");
  const lastReaction = picker.getByRole("button", {
    name: "Popcorn",
    exact: true,
  });
  await expect(lastReaction).toBeFocused();

  await search.focus();
  await search.press("ArrowDown");

  await firstReaction.press("ArrowDown");
  const nextRowReaction = picker.getByRole("button", {
    name: "Smiling face with sunglasses",
    exact: true,
  });
  await expect(nextRowReaction).toBeFocused();
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press(index % 2 === 0 ? "ArrowUp" : "ArrowDown");
    await expect(message).not.toBeFocused();
    await expect(picker.locator("button:focus")).toHaveCount(1);
  }
  await nextRowReaction.press("ArrowUp");
  await expect(firstReaction).toBeFocused();

  await message.locator(".handrail-chat__timeline-text").click();
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  const reopenedPicker = message.getByRole("dialog", {
    name: /^Choose a reaction for message from /u,
  });
  await expect(reopenedPicker.getByRole("searchbox", {
    name: "Search reactions",
  })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(reopenedPicker).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("adds and removes a catalog reaction before opening a focused compact thread", async ({
  chatLabOrigin,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const themeSettingsTrigger = workspace.getByRole("button", {
    name: "Open theme settings",
  });
  await themeSettingsTrigger.click();
  await workspace.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(themeSettingsTrigger).toHaveAttribute("title", "Theme: Dark");
  await expect(workspace).toHaveAttribute("data-handrail-theme", "dark");

  const navigation = page.getByRole("navigation", { name: "Conversations" });
  const directConversation = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  );
  await expect(directConversation).toHaveCount(1);
  await expect(directConversation).toHaveAccessibleName(
    /^Grace Hopper(?: \((?:online|away|busy|offline)\))?(?:, .+)*$/u,
  );
  await directConversation.click();

  const timeline = workspace.getByRole("region", { name: "Conversation timeline" });
  await expect(timeline).toBeVisible();
  const message = timeline.getByRole("article").filter({ hasText: ROOT_MESSAGE });
  await expect(message).toHaveCount(1);
  const messageId = await message.getAttribute("data-message-id");
  expect(messageId).not.toBeNull();

  const addReaction = message.getByRole("button", { name: "Add reaction", exact: true });
  await addReaction.click();
  const picker = message.getByRole("dialog", {
    name: /^Choose a reaction for message from /u,
  });
  const search = picker.getByRole("searchbox", { name: "Search reactions" });
  await expect(picker).toBeVisible();
  await expect(search).toBeFocused();
  await attachScreenshot(page, testInfo, "chat-lab-dark-compact-reaction-picker-open");

  await search.press("Escape");
  await expect(picker).toBeHidden();
  await expect(addReaction).toBeFocused();

  const addBarrier = await createReactionBarrier({
    messageId,
    operation: "add_reaction",
    page,
    reactionKey: REACTION_KEY,
  });
  await addReaction.click();
  const addSearch = message.getByRole("searchbox", { name: "Search reactions" });
  await expect(addSearch).toBeFocused();
  await addSearch.fill("rocket");
  const searchResults = message.getByRole("grid", {
    name: "Reaction search results for rocket",
  });
  const rocket = searchResults.getByRole("button", { name: "Rocket", exact: true });
  const pickerGeometry = await rocket.evaluate((element) => {
    const dialog = element.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) throw new Error("Reaction picker dialog is missing");
    const rectangle = (target) => {
      const { bottom, left, right, top } = target.getBoundingClientRect();
      return { bottom, left, right, top };
    };
    return {
      picker: rectangle(dialog),
      rocket: rectangle(element),
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  });
  console.log(`chat-lab-compact-picker-geometry: ${JSON.stringify(pickerGeometry)}`);
  expect(pickerGeometry.picker.left).toBeGreaterThanOrEqual(0);
  expect(pickerGeometry.picker.right).toBeLessThanOrEqual(pickerGeometry.viewport.width);
  expect(pickerGeometry.rocket.left).toBeGreaterThanOrEqual(0);
  expect(pickerGeometry.rocket.right).toBeLessThanOrEqual(pickerGeometry.viewport.width);
  expect(pickerGeometry.rocket.top).toBeGreaterThanOrEqual(0);
  expect(pickerGeometry.rocket.bottom).toBeLessThanOrEqual(pickerGeometry.viewport.height);
  await rocket.click();
  await addBarrier.expectRequest();

  const aggregate = message.getByRole("button", {
    name: `Remove ${REACTION_KEY} reaction`,
    exact: true,
  });
  await expect(aggregate).toBeVisible();
  await expect(aggregate).toHaveAttribute("aria-pressed", "true");
  await expect(aggregate.getByLabel("1 reactions")).toHaveText("1");

  addBarrier.release();
  const addResponse = await addBarrier.response;
  expect(addResponse.status).toBe(200);
  expect(addResponse.payload).toEqual({
    operation: "add_reaction",
    reconciliationStatus: "applied",
    messageId,
    reactionKey: REACTION_KEY,
    count: 1,
    reactedByCurrentUser: true,
  });
  await expect(aggregate).toHaveAttribute("aria-pressed", "true");
  await expect(aggregate.getByLabel("1 reactions")).toHaveText("1");

  const removeBarrier = await createReactionBarrier({
    messageId,
    operation: "remove_reaction",
    page,
    reactionKey: REACTION_KEY,
  });
  await aggregate.click();
  await removeBarrier.expectRequest();
  await expect(message.getByRole("button", {
    name: `Remove ${REACTION_KEY} reaction`,
    exact: true,
  })).toHaveCount(0);

  removeBarrier.release();
  const removeResponse = await removeBarrier.response;
  expect(removeResponse.status).toBe(200);
  expect(removeResponse.payload).toEqual({
    operation: "remove_reaction",
    reconciliationStatus: "applied",
    messageId,
    reactionKey: REACTION_KEY,
    count: 0,
    reactedByCurrentUser: false,
  });
  await expect(message.getByRole("button", {
    name: `Remove ${REACTION_KEY} reaction`,
    exact: true,
  })).toHaveCount(0);

  const openThread = message.getByRole("button", {
    name: "Open thread with 1 reply",
    exact: true,
  });
  await openThread.click();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await expect(thread).toBeVisible();
  await expect(thread).toBeFocused();
  await expect(thread.getByRole("button", { name: "Close thread" })).toBeVisible();
  await expect(thread.getByRole("textbox", { name: "Reply to thread" })).toBeVisible();

  const geometry = await measureCompactThreadGeometry(page);
  await testInfo.attach("chat-lab-compact-thread-overflow-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
  console.log(`chat-lab-compact-thread-overflow-geometry: ${JSON.stringify(geometry)}`);
  expect(geometry.document.scrollWidth).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.document.scrollHeight).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.body.scrollWidth).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.rectangles.thread.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.rectangles.thread.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.rectangles.thread.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.rectangles.thread.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.rectangles.close.top).toBeGreaterThanOrEqual(geometry.rectangles.thread.top - 1);
  expect(geometry.rectangles.close.bottom).toBeLessThanOrEqual(geometry.rectangles.thread.bottom + 1);
  expect(geometry.rectangles.composer.top).toBeGreaterThanOrEqual(geometry.rectangles.thread.top - 1);
  expect(geometry.rectangles.composer.bottom).toBeLessThanOrEqual(geometry.rectangles.thread.bottom + 1);
  expect(geometry.verticalScrollOwners).not.toContain("document");
  expect(geometry.verticalScrollOwners).not.toContain("body");
  expect(geometry.verticalScrollOwners).not.toContain("thread-section");
  expect(geometry.verticalScrollOwners).toContain("thread-timeline");
  await attachScreenshot(page, testInfo, "chat-lab-dark-compact-thread-open");

  await thread.press("Escape");
  await expect(thread).toBeHidden();
  await expect(openThread).toBeFocused();
});
