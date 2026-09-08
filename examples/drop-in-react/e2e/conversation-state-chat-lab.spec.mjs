import path from "node:path";

import { expect, test } from "./conversation-state-chat-lab.fixture.mjs";

const THEME_STORAGE_KEY = "handrail-chat-lab:theme";
const VIEWPORTS = Object.freeze({
  compact: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
});
const STATES = Object.freeze([
  Object.freeze({
    busy: "true",
    kind: "conversation-loading",
    role: "status",
    state: "loading",
    title: "Loading conversation…",
    live: "polite",
  }),
  Object.freeze({
    busy: null,
    kind: "conversation-unavailable",
    role: "status",
    state: "unavailable",
    title: "Conversation unavailable",
    live: "polite",
  }),
  Object.freeze({
    busy: null,
    kind: "conversation-error",
    role: "alert",
    state: "error",
    title: "Unable to load conversation",
    live: "assertive",
  }),
  Object.freeze({
    busy: "true",
    kind: "conversation-selecting",
    role: "status",
    state: "no-selection",
    title: "Selecting a conversation…",
    live: "polite",
  }),
  Object.freeze({
    busy: null,
    kind: "no-conversation",
    role: "status",
    state: "empty",
    title: "No conversations",
    live: "polite",
  }),
]);

const CASES = Object.freeze(STATES.flatMap((state, stateIndex) =>
  (["light", "dark"]).map((theme, themeIndex) => Object.freeze({
    ...state,
    theme,
    viewportClass: (stateIndex + themeIndex) % 2 === 0 ? "desktop" : "compact",
  })),
));

test.use({ trace: "retain-on-failure" });

const captureLayout = async (page) => page.evaluate(() => {
  const requiredElement = (selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Expected conversation-state element: ${selector}`);
    }
    return element;
  };
  const rectangle = (element) => {
    const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
    return { x, y, width, height, right, bottom };
  };
  const region = (selector) => {
    const element = requiredElement(selector);
    const rect = rectangle(element);
    return {
      hidden: element.hidden || rect.width === 0 || rect.height === 0,
      rect,
    };
  };

  const root = requiredElement(".handrail-chat--workspace");
  return {
    bodyFitsViewport:
      document.body.scrollHeight <= window.innerHeight + 1 &&
      document.body.scrollWidth <= window.innerWidth + 1,
    compactLayout: root.getAttribute("data-handrail-compact-layout"),
    compactPane: root.getAttribute("data-handrail-compact-pane"),
    documentFitsViewport:
      document.documentElement.scrollHeight <= window.innerHeight + 1 &&
      document.documentElement.scrollWidth <= window.innerWidth + 1,
    regions: {
      detail: region(".handrail-chat__detail"),
      navigation: region(".handrail-chat__navigation"),
      panel: region(".handrail-chat__state-panel"),
      shell: region(".chat-lab"),
      stage: region(".chat-lab__stage"),
      workspace: region(".handrail-chat--workspace"),
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
});

const expectBoundedRegion = (region, viewport, label) => {
  expect(region.hidden, `${label} should be visible`).toBe(false);
  expect(region.rect.width, `${label} should have usable width`).toBeGreaterThan(1);
  expect(region.rect.height, `${label} should have usable height`).toBeGreaterThan(1);
  expect(region.rect.x, `${label} should start inside the viewport`).toBeGreaterThanOrEqual(-1);
  expect(region.rect.y, `${label} should start inside the viewport`).toBeGreaterThanOrEqual(-1);
  expect(region.rect.right, `${label} should end inside the viewport`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
  expect(region.rect.bottom, `${label} should end inside the viewport`).toBeLessThanOrEqual(
    viewport.height + 1,
  );
};

const expectStableHierarchy = (layout, viewportClass, selectedConversation) => {
  const { regions, viewport } = layout;
  expect(layout.documentFitsViewport).toBe(true);
  expect(layout.bodyFitsViewport).toBe(true);
  expectBoundedRegion(regions.shell, viewport, "fixture shell");
  expectBoundedRegion(regions.stage, viewport, "fixture stage");
  expectBoundedRegion(regions.workspace, viewport, "workspace");
  expect(Math.abs(regions.shell.rect.height - viewport.height)).toBeLessThanOrEqual(1);
  expect(regions.stage.rect.height).toBeGreaterThanOrEqual(viewport.height * 0.55);
  expect(regions.workspace.rect.width).toBeGreaterThanOrEqual(regions.stage.rect.width - 4);
  expect(regions.workspace.rect.height).toBeGreaterThanOrEqual(regions.stage.rect.height - 4);

  if (viewportClass === "desktop") {
    expect(layout.compactLayout).toBe("false");
    expect(layout.compactPane).toBeNull();
    expectBoundedRegion(regions.navigation, viewport, "conversation navigation");
    expectBoundedRegion(regions.detail, viewport, "conversation detail");
    expectBoundedRegion(regions.panel, viewport, "state panel");
    expect(regions.navigation.rect.width).toBeGreaterThanOrEqual(190);
    expect(regions.detail.rect.width).toBeGreaterThanOrEqual(480);
    expect(regions.navigation.rect.height).toBeGreaterThanOrEqual(
      regions.workspace.rect.height - 4,
    );
    expect(regions.detail.rect.height).toBeGreaterThanOrEqual(
      regions.workspace.rect.height - 4,
    );
    return;
  }

  expect(layout.compactLayout).toBe("true");
  const visiblePane = selectedConversation ? regions.detail : regions.navigation;
  const hiddenPane = selectedConversation ? regions.navigation : regions.detail;
  expect(layout.compactPane).toBe(selectedConversation ? "detail" : "list");
  expectBoundedRegion(visiblePane, viewport, "compact active pane");
  expect(visiblePane.rect.width).toBeGreaterThanOrEqual(regions.workspace.rect.width - 4);
  expect(visiblePane.rect.height).toBeGreaterThanOrEqual(regions.workspace.rect.height - 4);
  expect(hiddenPane.hidden, "compact inactive pane should be hidden").toBe(true);
  expect(hiddenPane.rect.width).toBe(0);
  expect(hiddenPane.rect.height).toBe(0);
  expect(regions.panel.hidden).toBe(!selectedConversation);
  if (selectedConversation) expectBoundedRegion(regions.panel, viewport, "compact state panel");
};

const attachScreenshot = async (page, testInfo, name) => {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath });
  await testInfo.attach(name, {
    contentType: "image/png",
    path: screenshotPath,
  });
  console.log(`${name}: ${path.relative(process.cwd(), screenshotPath)}`);
};

for (const fixtureCase of CASES) {
  test(`${fixtureCase.state} panel uses ${fixtureCase.theme} theme at ${fixtureCase.viewportClass} size`, async ({
    conversationStateOrigin,
    page,
  }, testInfo) => {
    const viewport = VIEWPORTS[fixtureCase.viewportClass];
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(
      ({ key, theme }) => localStorage.setItem(key, theme),
      { key: THEME_STORAGE_KEY, theme: fixtureCase.theme },
    );

    const apiRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) {
        apiRequests.push(request.url());
      }
    });

    const fixtureUrl = new URL("/conversation-state-chat-lab.html", conversationStateOrigin);
    fixtureUrl.searchParams.set("state", fixtureCase.state);
    const response = await page.goto(fixtureUrl.href);
    expect(response?.ok()).toBe(true);

    const workspace = page.locator(".handrail-chat--workspace");
    const panel = workspace.locator(`[data-state-kind="${fixtureCase.kind}"]`);
    await expect(workspace).toHaveAttribute(
      "data-handrail-compact-layout",
      fixtureCase.viewportClass === "compact" ? "true" : "false",
    );
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("role", fixtureCase.role);
    await expect(panel).toHaveAttribute("aria-live", fixtureCase.live);
    expect(await panel.getAttribute("aria-busy")).toBe(fixtureCase.busy);
    await expect(panel).toContainText(fixtureCase.title);

    const currentUrl = new URL(page.url());
    expect(currentUrl.pathname).toBe("/conversation-state-chat-lab.html");
    expect(currentUrl.search).toBe(`?state=${fixtureCase.state}`);
    await expect(page.locator(".chat-lab")).toHaveAttribute(
      "data-conversation-state-fixture",
      fixtureCase.state,
    );
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue(
      fixtureCase.theme,
    );
    await expect(page.locator(".chat-lab")).toHaveAttribute(
      "data-chat-lab-effective-theme",
      fixtureCase.theme,
    );
    await expect(page.locator(".chat-lab")).toHaveAttribute(
      "data-handrail-theme",
      fixtureCase.theme,
    );
    await expect(workspace).toHaveAttribute("data-handrail-theme", fixtureCase.theme);

    const fixtureNavigation = page.getByRole("navigation", {
      name: "Conversation fixture state",
    });
    await expect(fixtureNavigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(fixtureNavigation.locator('[aria-current="page"]')).toHaveAttribute(
      "href",
      `?state=${fixtureCase.state}`,
    );
    await expect(workspace.locator(".handrail-chat__navigation")).toHaveCount(1);
    await expect(workspace.locator(".handrail-chat__detail")).toHaveCount(1);
    await expect(workspace.locator(".handrail-chat__timeline")).toHaveCount(0);
    await expect(workspace.locator('[aria-label="Message timeline"]')).toHaveCount(0);
    await expect(workspace.locator(".handrail-chat__composer-region")).toHaveCount(0);
    await expect(workspace.locator('[aria-label="Conversation composer"]')).toHaveCount(0);
    expect(apiRequests).toEqual([]);

    const selectedConversation = !["no-selection", "empty"].includes(fixtureCase.state);
    expectStableHierarchy(
      await captureLayout(page),
      fixtureCase.viewportClass,
      selectedConversation,
    );

    const screenshotName = [
      "conversation-state",
      fixtureCase.state,
      fixtureCase.theme,
      fixtureCase.viewportClass,
    ].join("-");
    await attachScreenshot(page, testInfo, screenshotName);
  });
}
