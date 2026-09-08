import path from "node:path";

import {
  CHAT_LAB_EMPTY_CHANNEL_NAME,
  CHAT_LAB_PUBLIC_CHANNEL_NAME,
  CHAT_LAB_PUBLIC_LINK_PREVIEW,
  CHAT_LAB_PUBLIC_MESSAGES,
} from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.fixture.mjs";

const CASES = Object.freeze([
  Object.freeze({ theme: "light", viewport: "desktop" }),
  Object.freeze({ theme: "dark", viewport: "desktop" }),
  Object.freeze({ theme: "light", viewport: "desktop-1600x900" }),
  Object.freeze({ theme: "dark", viewport: "desktop-1600x900" }),
  Object.freeze({ theme: "light", viewport: "desktop-1920x1080" }),
  Object.freeze({ theme: "dark", viewport: "desktop-1920x1080" }),
  Object.freeze({ theme: "dark", viewport: "tablet" }),
  Object.freeze({ theme: "light", viewport: "compact" }),
  Object.freeze({ theme: "dark", viewport: "compact" }),
]);
const VIEWPORTS = Object.freeze({
  compact: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 1440, height: 900 }),
  "desktop-1600x900": Object.freeze({ width: 1600, height: 900 }),
  "desktop-1920x1080": Object.freeze({ width: 1920, height: 1080 }),
  tablet: Object.freeze({ width: 768, height: 900 }),
});
const DARK_DESKTOP_BASELINES = Object.freeze({
  desktop: "chat-lab-stage-dark-1440x900.png",
  "desktop-1600x900": "chat-lab-stage-dark-1600x900.png",
  "desktop-1920x1080": "chat-lab-stage-dark-1920x1080.png",
});
const VISUAL_DIFF_TOLERANCE = Object.freeze({
  maxDiffPixels: 100,
  threshold: 0.1,
});
const BASELINE_DATE_LABEL = "August 28, 2026";
const BASELINE_MESSAGE_TIME_LABEL = "12:00 PM";

test.use({ trace: "retain-on-first-failure" });

const waitForManagedRealtimeConnection = async (page) => {
  await expect(page.locator('.chat-lab__realtime-announcement[role="status"]'))
    .toHaveAttribute("data-realtime-state", "connected");
};

const selectChatLabTheme = async ({ theme, workspace }) => {
  const trigger = workspace.getByRole("button", { name: "Open theme settings" });
  await trigger.click();
  const menu = workspace.getByRole("menu", { name: "Theme settings" });
  await menu.getByRole("menuitemradio", {
    name: theme[0].toUpperCase() + theme.slice(1),
  }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute(
    "title",
    `Theme: ${theme[0].toUpperCase() + theme.slice(1)}`,
  );
};

const prepareDarkDesktopBaseline = async ({
  channelName = CHAT_LAB_PUBLIC_CHANNEL_NAME,
  hideLinkPreview = false,
  messages = [CHAT_LAB_PUBLIC_MESSAGES[0], CHAT_LAB_PUBLIC_MESSAGES.at(-1)],
  page,
  workspace,
}) => {
  const publicChannel = workspace.getByRole("button", {
    name: new RegExp(`^${channelName}(?:,|$)`, "u"),
  });
  await expect(publicChannel).toBeVisible();
  await publicChannel.click();

  await expect(workspace.getByRole("heading", {
    exact: true,
    level: 2,
    name: channelName,
  })).toBeVisible();
  for (const fixture of messages) {
    await expect(
      workspace.getByRole("article").filter({ hasText: fixture.text }),
    ).toBeVisible();
  }

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
  if (hideLinkPreview) {
    await page.addStyleTag({
      content: ".handrail-chat__timeline-link-preview { display: none !important; }",
    });
  }
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
    await new Promise((resolve) => requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    }));
  }, {
    dateLabel: BASELINE_DATE_LABEL,
    messageTimeLabel: BASELINE_MESSAGE_TIME_LABEL,
  });
  await page.mouse.move(0, 0);
};

const captureLayout = async (page) => page.evaluate(() => {
  const requiredElement = (selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Expected Chat Lab element: ${selector}`);
    }
    return element;
  };
  const round = (value) => Math.round(value * 100) / 100;
  const measure = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      hidden: element.hidden,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      rect: {
        bottom: round(rect.bottom),
        height: round(rect.height),
        left: round(rect.left),
        right: round(rect.right),
        top: round(rect.top),
        width: round(rect.width),
      },
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      visible:
        !element.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0,
    };
  };

  const shell = requiredElement(".chat-lab");
  const stage = requiredElement(".chat-lab__stage");
  const workspaceHost = requiredElement(".chat-lab__workspace");
  const workspace = requiredElement(".handrail-chat--workspace");
  const navigation = requiredElement(".handrail-chat__navigation");
  const detail = requiredElement(".handrail-chat__detail");
  const conversation = requiredElement(".handrail-chat__conversation");
  const header = requiredElement(".handrail-chat__header");
  const main = requiredElement(".handrail-chat__main");
  const conversationBody = requiredElement(".handrail-chat__conversation-body");
  const timeline = requiredElement(".handrail-chat__timeline");
  const timelineViewport = requiredElement(".handrail-chat__timeline-viewport");
  const composer = requiredElement(".handrail-chat__composer-region");

  const conversationRegions = {
    composer,
    conversation,
    conversationBody,
    detail,
    main,
    timeline,
    timelineViewport,
  };
  const conversationScrollOwners = Object.entries(conversationRegions)
    .filter(([, element]) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY))
    .map(([name]) => name);

  return {
    compactLayout: workspace.getAttribute("data-handrail-compact-layout"),
    compactPane: workspace.getAttribute("data-handrail-compact-pane"),
    conversationScrollOwners,
    document: {
      body: measure(document.body),
      documentElement: measure(document.documentElement),
    },
    regions: {
      composer: measure(composer),
      header: measure(header),
      shell: measure(shell),
      stage: measure(stage),
      timelineViewport: measure(timelineViewport),
      workspace: measure(workspace),
      workspaceHost: measure(workspaceHost),
    },
    viewport: { height: window.innerHeight, width: window.innerWidth },
  };
});

const captureCompactPanes = async (page) => page.evaluate(() => {
  const workspace = document.querySelector(".handrail-chat--workspace");
  const navigation = document.querySelector(".handrail-chat__navigation");
  const detail = document.querySelector(".handrail-chat__detail");
  if (!(workspace instanceof HTMLElement) ||
      !(navigation instanceof HTMLElement) ||
      !(detail instanceof HTMLElement)) {
    throw new Error("Expected compact Chat Lab workspace panes");
  }
  const pane = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      hidden: element.hidden,
      rect: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      },
      visible:
        !element.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0,
    };
  };
  const panes = { detail: pane(detail), navigation: pane(navigation) };
  const overlapWidth = Math.max(
    0,
    Math.min(panes.detail.rect.right, panes.navigation.rect.right) -
      Math.max(panes.detail.rect.left, panes.navigation.rect.left),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(panes.detail.rect.bottom, panes.navigation.rect.bottom) -
      Math.max(panes.detail.rect.top, panes.navigation.rect.top),
  );
  return {
    activePane: workspace.getAttribute("data-handrail-compact-pane"),
    compactLayout: workspace.getAttribute("data-handrail-compact-layout"),
    overlapArea: overlapWidth * overlapHeight,
    panes,
  };
});

const expectBounded = (region, viewport, label) => {
  const diagnostic = `${label} measurements: ${JSON.stringify({ region, viewport })}`;
  expect(region.visible, diagnostic).toBe(true);
  expect(region.rect.left, diagnostic).toBeGreaterThanOrEqual(-1);
  expect(region.rect.top, diagnostic).toBeGreaterThanOrEqual(-1);
  expect(region.rect.right, diagnostic).toBeLessThanOrEqual(viewport.width + 1);
  expect(region.rect.bottom, diagnostic).toBeLessThanOrEqual(viewport.height + 1);
};

const expectNoHorizontalOverflow = (measurement, label) => {
  const diagnostic = `${label} horizontal overflow measurements: ${JSON.stringify(measurement)}`;
  expect(measurement.scrollWidth, diagnostic).toBeLessThanOrEqual(
    measurement.clientWidth + 1,
  );
};

const expectNoVerticalOverflow = (measurement, label) => {
  const diagnostic = `${label} vertical overflow measurements: ${JSON.stringify(measurement)}`;
  expect(measurement.scrollHeight, diagnostic).toBeLessThanOrEqual(
    measurement.clientHeight + 1,
  );
};

const captureLinkPreviewLayout = async (preview) => preview.evaluate((element) => {
  const requiredElement = (value, label) => {
    if (!(value instanceof HTMLElement)) {
      throw new Error(`Expected link-preview ${label}`);
    }
    return value;
  };
  const round = (value) => Math.round(value * 100) / 100;
  const measure = (value) => {
    const target = requiredElement(value, "measurement target");
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    return {
      clientHeight: target.clientHeight,
      clientWidth: target.clientWidth,
      overflowX: style.overflowX,
      rect: {
        bottom: round(rect.bottom),
        height: round(rect.height),
        left: round(rect.left),
        right: round(rect.right),
        top: round(rect.top),
        width: round(rect.width),
      },
      scrollHeight: target.scrollHeight,
      scrollWidth: target.scrollWidth,
      visible:
        !target.hidden &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0,
    };
  };

  const card = requiredElement(element, "card");
  const message = requiredElement(card.closest(".handrail-chat__timeline-item"), "message");
  const timeline = requiredElement(card.closest(".handrail-chat__timeline"), "timeline");
  const timelineViewport = requiredElement(
    card.closest(".handrail-chat__timeline-viewport"),
    "timeline viewport",
  );
  const workspace = requiredElement(card.closest(".handrail-chat--workspace"), "workspace");
  const workspaceHost = requiredElement(card.closest(".chat-lab__workspace"), "workspace host");
  const link = requiredElement(card.querySelector("a"), "link");

  return {
    body: measure(document.body),
    card: measure(card),
    document: measure(document.documentElement),
    link: measure(link),
    message: measure(message),
    timeline: measure(timeline),
    timelineViewport: measure(timelineViewport),
    viewport: { height: window.innerHeight, width: window.innerWidth },
    workspace: measure(workspace),
    workspaceHost: measure(workspaceHost),
  };
});

const expectContained = (inner, outer, label) => {
  const diagnostic = `${label} containment measurements: ${JSON.stringify({ inner, outer })}`;
  expect(inner.rect.left, diagnostic).toBeGreaterThanOrEqual(outer.rect.left - 1);
  expect(inner.rect.right, diagnostic).toBeLessThanOrEqual(outer.rect.right + 1);
  expect(inner.rect.top, diagnostic).toBeGreaterThanOrEqual(outer.rect.top - 1);
  expect(inner.rect.bottom, diagnostic).toBeLessThanOrEqual(outer.rect.bottom + 1);
};

const expectActorChooserBounded = async ({ page, workspace }) => {
  const trigger = workspace.getByRole("button", {
    name: /Development fixture identity:/u,
  });
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = workspace.getByRole("listbox", {
    name: "Development fixture identities",
  });
  await expect(menu).toBeVisible();
  const layout = await page.evaluate(() => {
    const required = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Expected open actor chooser element: ${selector}`);
      }
      return element;
    };
    const measure = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        rect: { left: rect.left, right: rect.right, width: rect.width },
        scrollWidth: element.scrollWidth,
      };
    };
    return {
      body: measure(document.body),
      document: measure(document.documentElement),
      menu: measure(required(".chat-lab__identity-menu")),
      navigation: measure(required(".handrail-chat__navigation")),
      workspace: measure(required(".handrail-chat--workspace")),
    };
  });
  const diagnostic = `Open actor chooser measurements: ${JSON.stringify(layout)}`;
  for (const [label, measurement] of Object.entries({
    body: layout.body,
    document: layout.document,
    navigation: layout.navigation,
    workspace: layout.workspace,
  })) {
    expectNoHorizontalOverflow(measurement, `${label}; ${diagnostic}`);
  }
  expect(layout.menu.rect.left, diagnostic)
    .toBeGreaterThanOrEqual(layout.navigation.rect.left - 1);
  expect(layout.menu.rect.right, diagnostic)
    .toBeLessThanOrEqual(layout.navigation.rect.right + 1);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
};

const expectThemeSettingsBounded = async ({ page, workspace }) => {
  const trigger = workspace.getByRole("button", { name: "Open theme settings" });
  await expect(trigger).toHaveCount(1);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = workspace.getByRole("menu", { name: "Theme settings" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  const layout = await page.evaluate(() => {
    const required = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error(`Expected open theme settings element: ${selector}`);
      }
      return element;
    };
    const measure = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        rect: { left: rect.left, right: rect.right, width: rect.width },
        scrollWidth: element.scrollWidth,
      };
    };
    return {
      body: measure(document.body),
      document: measure(document.documentElement),
      menu: measure(required(".chat-lab__theme-settings-menu")),
      navigation: measure(required(".handrail-chat__navigation")),
      workspace: measure(required(".handrail-chat--workspace")),
    };
  });
  const diagnostic = `Open theme settings measurements: ${JSON.stringify(layout)}`;
  for (const [label, measurement] of Object.entries({
    body: layout.body,
    document: layout.document,
    navigation: layout.navigation,
    workspace: layout.workspace,
  })) {
    expectNoHorizontalOverflow(measurement, `${label}; ${diagnostic}`);
  }
  expect(layout.menu.rect.left, diagnostic)
    .toBeGreaterThanOrEqual(layout.navigation.rect.left - 1);
  expect(layout.menu.rect.right, diagnostic)
    .toBeLessThanOrEqual(layout.navigation.rect.right + 1);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
};

const expectShellLayout = (layout, viewportClass) => {
  const diagnostic = `Chat Lab shell measurements: ${JSON.stringify(layout)}`;
  expect(layout.regions.shell.rect.width, diagnostic).toBeGreaterThanOrEqual(
    layout.viewport.width - 1,
  );
  expect(layout.regions.shell.rect.height, diagnostic).toBeGreaterThanOrEqual(
    layout.viewport.height - 1,
  );
  expect(layout.regions.workspace.rect.width, diagnostic).toBeGreaterThanOrEqual(
    layout.regions.stage.clientWidth - 1,
  );
  expect(layout.regions.workspace.rect.height, diagnostic).toBeGreaterThanOrEqual(
    layout.regions.stage.clientHeight - 1,
  );

  for (const [label, measurement] of Object.entries({
    body: layout.document.body,
    composer: layout.regions.composer,
    document: layout.document.documentElement,
    header: layout.regions.header,
    workspace: layout.regions.workspace,
    workspaceHost: layout.regions.workspaceHost,
  })) {
    expectNoHorizontalOverflow(measurement, label);
  }

  for (const [label, measurement] of Object.entries({
    body: layout.document.body,
    document: layout.document.documentElement,
    shell: layout.regions.shell,
    stage: layout.regions.stage,
    workspace: layout.regions.workspace,
    workspaceHost: layout.regions.workspaceHost,
  })) {
    expectNoVerticalOverflow(measurement, label);
  }

  expectBounded(layout.regions.header, layout.viewport, "active conversation header");
  expectBounded(layout.regions.composer, layout.viewport, "conversation composer");
  expectBounded(layout.regions.timelineViewport, layout.viewport, "timeline viewport");

  const timelineDiagnostic = `Conversation scroll measurements: ${JSON.stringify({
    owners: layout.conversationScrollOwners,
    timelineViewport: layout.regions.timelineViewport,
  })}`;
  expect(layout.regions.timelineViewport.overflowY, timelineDiagnostic).toBe("auto");
  expect(layout.conversationScrollOwners, timelineDiagnostic).toEqual(["timelineViewport"]);

  const compactDiagnostic = `Responsive workspace measurements: ${JSON.stringify({
    compactLayout: layout.compactLayout,
    compactPane: layout.compactPane,
    viewport: layout.viewport,
  })}`;
  expect(layout.compactLayout, compactDiagnostic).toBe(
    viewportClass === "compact" ? "true" : "false",
  );
  expect(layout.compactPane, compactDiagnostic).toBe(
    viewportClass === "compact" ? "detail" : null,
  );
};

const expectCompactPanes = (layout, expectedActivePane, stateLabel) => {
  const diagnostic = `${stateLabel} pane measurements: ${JSON.stringify(layout)}`;
  expect(layout.compactLayout, diagnostic).toBe("true");
  expect(layout.activePane, diagnostic).toBe(expectedActivePane);
  expect(
    Object.values(layout.panes).filter((pane) => pane.visible).length,
    diagnostic,
  ).toBe(1);
  const activePane = expectedActivePane === "list" ? "navigation" : "detail";
  expect(layout.panes[activePane].visible, diagnostic).toBe(true);

  const inactivePane = activePane === "detail" ? "navigation" : "detail";
  const inactive = layout.panes[inactivePane];
  expect(
    inactive.hidden || inactive.rect.width === 0 || inactive.rect.height === 0,
    diagnostic,
  ).toBe(true);
  expect(layout.overlapArea, diagnostic).toBe(0);
};

const attachScreenshot = async (page, testInfo, name) => {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });

  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath });
  await testInfo.attach(name, {
    contentType: "image/png",
    path: screenshotPath,
  });
  console.log(`${name}: ${path.relative(process.cwd(), screenshotPath)}`);
};

for (const fixtureCase of CASES) {
  test(`Chat Lab shell uses ${fixtureCase.theme} theme at ${fixtureCase.viewport} size`, async ({
    chatLabOrigin,
    page,
  }, testInfo) => {
    const viewport = VIEWPORTS[fixtureCase.viewport];
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const response = await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
    if (response === null || !response.ok()) {
      throw new Error(`Chat Lab navigation failed: ${response?.status() ?? "no response"}`);
    }

    const interactiveLab = page.getByRole("region", { name: "Interactive chat lab" });
    const workspace = page.getByLabel("Handrail Chat Lab workspace");
    const navigation = page.getByRole("navigation", { name: "Conversations" });
    const timeline = workspace.getByRole("region", { name: "Conversation timeline" });
    const composer = workspace.getByLabel("Conversation composer");
    const activeConversation = workspace.locator(".handrail-chat__conversation");
    const conversationHeader = activeConversation.locator(".handrail-chat__header");
    const conversationHeading = conversationHeader.getByRole("heading", { level: 2 }).first();

    await interactiveLab.waitFor({ state: "visible" });
    await workspace.waitFor({ state: "visible" });
    await waitForManagedRealtimeConnection(page);

    await selectChatLabTheme({ theme: fixtureCase.theme, workspace });
    const themeState = await page.evaluate(() => {
      const shell = document.querySelector(".chat-lab");
      const workspaceRoot = document.querySelector(".handrail-chat--workspace");
      return {
        effective: shell?.getAttribute("data-chat-lab-effective-theme") ?? null,
        shellPreference: shell?.getAttribute("data-chat-lab-theme") ?? null,
        shellTheme: shell?.getAttribute("data-handrail-theme") ?? null,
        workspaceTheme: workspaceRoot?.getAttribute("data-handrail-theme") ?? null,
      };
    });
    const themeDiagnostic = `Theme state: ${JSON.stringify(themeState)}`;
    expect(themeState.shellPreference, themeDiagnostic).toBe(fixtureCase.theme);
    expect(themeState.effective, themeDiagnostic).toBe(fixtureCase.theme);
    expect(themeState.shellTheme, themeDiagnostic).toBe(fixtureCase.theme);
    expect(themeState.workspaceTheme, themeDiagnostic).toBe(fixtureCase.theme);

    await expectActorChooserBounded({ page, workspace });
    await expectThemeSettingsBounded({ page, workspace });

    if (fixtureCase.viewport === "compact") {
      expectCompactPanes(
        await captureCompactPanes(page),
        "list",
        "initial compact conversation list",
      );

      const destination = navigation.locator(
        '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
      );
      await expect(destination).toHaveCount(1);
      await expect(destination.locator(".handrail-chat__conversation-label"))
        .toHaveText("Grace Hopper");
      await destination.click();
      await timeline.waitFor({ state: "visible" });
      await composer.waitFor({ state: "visible" });
      await conversationHeading.waitFor({ state: "visible" });
      expectCompactPanes(
        await captureCompactPanes(page),
        "detail",
        "selected compact detail",
      );

      const backButton = activeConversation.getByRole("button", {
        name: "Back to conversations",
      });
      await backButton.click();
      await workspace.waitFor({ state: "visible" });
      await navigation.waitFor({ state: "visible" });
      expectCompactPanes(
        await captureCompactPanes(page),
        "list",
        "returned compact conversation list",
      );

      await destination.click();
      await timeline.waitFor({ state: "visible" });
      await composer.waitFor({ state: "visible" });
      await conversationHeading.waitFor({ state: "visible" });
      expectCompactPanes(
        await captureCompactPanes(page),
        "detail",
        "restored compact detail",
      );
    } else {
      await timeline.waitFor({ state: "visible" });
      await composer.waitFor({ state: "visible" });
      await conversationHeading.waitFor({ state: "visible" });
    }

    expectShellLayout(await captureLayout(page), fixtureCase.viewport);

    const baselineName = fixtureCase.theme === "dark"
      ? DARK_DESKTOP_BASELINES[fixtureCase.viewport]
      : undefined;
    if (baselineName !== undefined) {
      await prepareDarkDesktopBaseline({ hideLinkPreview: true, page, workspace });
      await expect(page.locator(".chat-lab__stage")).toHaveScreenshot(
        baselineName,
        {
          animations: "disabled",
          caret: "hide",
          ...VISUAL_DIFF_TOLERANCE,
        },
      );
    }

    const screenshotName = [
      "chat-lab-shell",
      fixtureCase.theme,
      fixtureCase.viewport,
    ].join("-");
    await attachScreenshot(page, testInfo, screenshotName);
  });
}

test("seeded public-channel link preview is accessible and bounded at dark desktop size", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  if (response === null || !response.ok()) {
    throw new Error(`Chat Lab navigation failed: ${response?.status() ?? "no response"}`);
  }

  const previewFixture = CHAT_LAB_PUBLIC_MESSAGES.find(({ blocks }) =>
    blocks?.some(({ type }) => type === "link_preview"));
  if (previewFixture === undefined) {
    throw new Error("Expected one seeded public-channel link preview fixture");
  }

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const stage = page.locator(".chat-lab__stage");
  await expect(workspace).toBeVisible();
  await waitForManagedRealtimeConnection(page);
  await selectChatLabTheme({ theme: "dark", workspace });
  await expect(workspace).toHaveAttribute("data-handrail-theme", "dark");
  await prepareDarkDesktopBaseline({
    messages: [previewFixture],
    page,
    workspace,
  });

  const seededMessage = workspace.locator(".handrail-chat__timeline-item")
    .filter({ hasText: previewFixture.text });
  await expect(seededMessage).toHaveCount(1);
  const preview = seededMessage.locator(".handrail-chat__timeline-link-preview");
  await expect(preview).toHaveCount(1);
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute(
    "aria-label",
    `Link preview for ${CHAT_LAB_PUBLIC_LINK_PREVIEW.title}`,
  );

  const previewLink = preview.getByRole("link");
  await expect(previewLink).toHaveCount(1);
  await expect(previewLink).toHaveAccessibleName(
    new RegExp(CHAT_LAB_PUBLIC_LINK_PREVIEW.title, "u"),
  );
  await expect(previewLink).toHaveAttribute("href", CHAT_LAB_PUBLIC_LINK_PREVIEW.url);
  await expect(preview.locator(".handrail-chat__timeline-link-preview-title"))
    .toHaveText(CHAT_LAB_PUBLIC_LINK_PREVIEW.title);
  await expect(preview.locator(".handrail-chat__timeline-link-preview-site"))
    .toHaveText(CHAT_LAB_PUBLIC_LINK_PREVIEW.siteName);
  await expect(preview.locator(".handrail-chat__timeline-link-preview-description"))
    .toHaveText(CHAT_LAB_PUBLIC_LINK_PREVIEW.description);
  await expect(preview.locator(".handrail-chat__timeline-link-preview-url"))
    .toHaveText(CHAT_LAB_PUBLIC_LINK_PREVIEW.url);
  await expect(preview.locator("img")).toHaveCount(0);

  await preview.scrollIntoViewIfNeeded();
  const layout = await captureLinkPreviewLayout(preview);
  expectContained(layout.card, layout.message, "link preview within seeded message");
  expectContained(layout.card, layout.timelineViewport, "link preview within timeline viewport");
  expectContained(layout.card, layout.timeline, "link preview within timeline");
  expectContained(layout.card, layout.workspace, "link preview within workspace");
  expectBounded(layout.card, layout.viewport, "link preview card");
  for (const [label, measurement] of Object.entries({
    body: layout.body,
    card: layout.card,
    document: layout.document,
    link: layout.link,
    message: layout.message,
    timeline: layout.timeline,
    timelineViewport: layout.timelineViewport,
    workspace: layout.workspace,
    workspaceHost: layout.workspaceHost,
  })) {
    expectNoHorizontalOverflow(measurement, `link preview ${label}`);
  }

  await expect(stage).toHaveScreenshot(
    "chat-lab-link-preview-dark-1440x900.png",
    {
      animations: "disabled",
      caret: "hide",
      ...VISUAL_DIFF_TOLERANCE,
    },
  );
});

test("Chat Lab empty public channel uses dark theme at desktop size", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  if (response === null || !response.ok()) {
    throw new Error(`Chat Lab navigation failed: ${response?.status() ?? "no response"}`);
  }

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const stage = page.locator(".chat-lab__stage");
  const timeline = workspace.getByRole("region", { name: "Conversation timeline" });
  const emptyChannel = workspace.getByRole("button", {
    name: new RegExp(`^${CHAT_LAB_EMPTY_CHANNEL_NAME}(?:,|$)`, "u"),
  });

  await expect(workspace).toBeVisible();
  await waitForManagedRealtimeConnection(page);
  await selectChatLabTheme({ theme: "dark", workspace });
  await expect(workspace).toHaveAttribute("data-handrail-theme", "dark");

  await expect(emptyChannel).toBeVisible();
  await emptyChannel.click();
  await expect(emptyChannel).toHaveAttribute("aria-current", "page");
  await expect(workspace.getByRole("heading", {
    level: 2,
    name: `#${CHAT_LAB_EMPTY_CHANNEL_NAME}`,
  })).toBeVisible();

  const introduction = timeline.locator(
    '[data-conversation-introduction="channel"]',
  );
  await expect(introduction).toHaveCount(1);
  await expect(introduction).toHaveAttribute(
    "data-conversation-visibility",
    "public",
  );
  await expect(introduction.locator(
    ".handrail-chat__timeline-introduction-title",
  )).toHaveText(`#${CHAT_LAB_EMPTY_CHANNEL_NAME}`);
  await expect(introduction.locator(
    ".handrail-chat__timeline-introduction-visibility",
  )).toHaveText("Public channel");
  await expect(introduction.locator(
    ".handrail-chat__timeline-introduction-context",
  )).toHaveText("A public channel anyone in the workspace can find and join.");
  await expect(introduction.locator(
    ".handrail-chat__timeline-introduction-prompt",
  )).toHaveText("Send the first message when you’re ready.");
  await expect(timeline.getByRole("article")).toHaveCount(0);

  await prepareDarkDesktopBaseline({
    channelName: CHAT_LAB_EMPTY_CHANNEL_NAME,
    messages: [],
    page,
    workspace,
  });
  await expect(stage).toHaveScreenshot(
    "chat-lab-empty-channel-dark-1440x900.png",
    {
      animations: "disabled",
      caret: "hide",
      ...VISUAL_DIFF_TOLERANCE,
    },
  );
});

test("disabled and enabled Send styles remain distinct in explicit themes", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  if (response === null || !response.ok()) {
    throw new Error(`Chat Lab navigation failed: ${response?.status() ?? "no response"}`);
  }

  await waitForManagedRealtimeConnection(page);

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const composerRegion = workspace.getByLabel("Conversation composer");
  const composer = composerRegion.getByRole("textbox", { name: "Message" });
  const send = composerRegion.getByRole("button", { name: "Send message" });
  const captureSendStyle = () => send.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      color: style.color,
      cursor: style.cursor,
      opacity: style.opacity,
    };
  });

  await expect(composerRegion).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await selectChatLabTheme({ theme, workspace });
    await expect(workspace).toHaveAttribute("data-handrail-theme", theme);

    await composer.fill("   ");
    await expect(send).toBeDisabled();
    await send.hover();
    const disabledStyle = await captureSendStyle();

    await composer.fill("Sendable text");
    await expect(send).toBeEnabled();
    const enabledStyle = await captureSendStyle();
    const diagnostic = `${theme} Send styles: ${JSON.stringify({
      disabledStyle,
      enabledStyle,
    })}`;

    expect(disabledStyle.cursor, diagnostic).toBe("not-allowed");
    expect(disabledStyle.boxShadow, diagnostic).toBe("none");
    expect(Number(disabledStyle.opacity), diagnostic).toBeLessThan(1);
    expect(enabledStyle.cursor, diagnostic).toBe("pointer");
    expect(enabledStyle.opacity, diagnostic).toBe("1");
    expect(disabledStyle.backgroundColor, diagnostic).not.toBe(
      enabledStyle.backgroundColor,
    );
    expect(disabledStyle.borderColor, diagnostic).not.toBe(
      enabledStyle.borderColor,
    );
    expect(disabledStyle.color, diagnostic).not.toBe(enabledStyle.color);
  }
});
