import {
  CHAT_LAB_PUBLIC_CHANNEL_NAME,
  CHAT_LAB_PUBLIC_MESSAGES,
} from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.fixture.mjs";

const DESKTOP_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const CHAT_LAB_WORKSPACE_NAME = "Development workspace";
const EMBEDDED_LONG_CHANNEL_NAME =
  "desktop-experience-navigation-reliability-and-launch-coordination";
const LONG_DRAFT = [
  "First line keeps the embedded composer useful.",
  "Second line verifies that the editor grows inside its host.",
  "Third line remains visible without moving the conversation header.",
  "Fourth line makes the timeline retain independent scrolling.",
  "Fifth line covers a deliberately long multiline draft at compact width.",
  "Sixth line leaves the send controls available and in bounds.",
].join("\n");

const conversationRow = (navigation, conversationId) => navigation.locator(
  `.handrail-chat__conversation-button[data-conversation-id="${conversationId}"]`,
);

const seedEmbeddedNavigation = async (chatLab) => {
  const client = chatLab.harness.createClient("chat-lab-ada");
  try {
    expect((await client.start()).state).toBe("ready");
    let longChannelId;
    for (let index = 0; index < 24; index += 1) {
      const result = await client.createChannel({
        name: index === 0
          ? EMBEDDED_LONG_CHANNEL_NAME
          : `embedded-scroll-${String(index).padStart(2, "0")}`,
        visibility: "public",
      });
      expect(result.status, JSON.stringify(result)).toBe("success");
      if (index === 0 && result.status === "success") {
        longChannelId = result.value.conversation.conversation.id;
      }
    }
    expect(longChannelId).toBeDefined();
    return longChannelId;
  } finally {
    client.close();
  }
};

const setHostWidth = async ({ fixture, host, page, width, workspace }) => {
  await fixture.getByRole("button", { name: `${width}px`, exact: true }).click();
  await expect(host).toHaveAttribute("data-embedded-workspace-width", String(width));
  await expect.poll(() => host.evaluate((element) => element.getBoundingClientRect().width))
    .toBeCloseTo(width, 0);
  await expect.poll(() => page.viewportSize()).toEqual(DESKTOP_VIEWPORT);
  await expect(workspace).toHaveAttribute(
    "data-handrail-compact-layout",
    width <= 640 ? "true" : "false",
  );
};

const paneState = async (workspace) => workspace.evaluate((root) => {
  const measure = (selector) => {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing pane: ${selector}`);
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      hidden: element.hidden,
      visible: !element.hidden && style.display !== "none" &&
        style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
    };
  };
  return {
    active: root.getAttribute("data-handrail-compact-pane"),
    compact: root.getAttribute("data-handrail-compact-layout"),
    detail: measure(".handrail-chat__detail"),
    navigation: measure(".handrail-chat__navigation"),
  };
});

const expectCompactPane = async (workspace, active) => {
  const state = await paneState(workspace);
  const diagnostic = `compact pane state: ${JSON.stringify(state)}`;
  expect(state.compact, diagnostic).toBe("true");
  expect(state.active, diagnostic).toBe(active);
  expect([state.detail, state.navigation].filter(({ visible }) => visible), diagnostic)
    .toHaveLength(1);
  expect(active === "detail" ? state.detail.visible : state.navigation.visible, diagnostic)
    .toBe(true);
};

const expectDesktopComposition = async (workspace) => {
  const state = await paneState(workspace);
  const diagnostic = `desktop pane state: ${JSON.stringify(state)}`;
  expect(state.compact, diagnostic).toBe("false");
  expect(state.active, diagnostic).toBeNull();
  expect(state.detail.visible, diagnostic).toBe(true);
  expect(state.navigation.visible, diagnostic).toBe(true);
};

const layoutState = async ({ host, page, workspace }) => page.evaluate((elements) => {
  const { host, workspace } = elements;
  const required = (selector) => {
    const element = workspace.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing layout region: ${selector}`);
    return element;
  };
  const measure = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      overflowY: style.overflowY,
      rect: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      },
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    };
  };
  return {
    document: measure(document.documentElement),
    host: measure(host),
    workspace: measure(workspace),
    header: measure(required(".handrail-chat__header")),
    composer: measure(required(".handrail-chat__composer-region")),
    timeline: measure(required(".handrail-chat__timeline-viewport")),
    viewport: { height: innerHeight, width: innerWidth },
  };
}, { host: await host.elementHandle(), workspace: await workspace.elementHandle() });

const expectEmbeddedLayout = (layout, label) => {
  const diagnostic = `${label}: ${JSON.stringify(layout)}`;
  expect(layout.viewport, diagnostic).toEqual(DESKTOP_VIEWPORT);
  for (const [name, measurement] of Object.entries({
    document: layout.document,
    host: layout.host,
    workspace: layout.workspace,
  })) {
    expect(
      measurement.scrollWidth,
      `${name} horizontal overflow; ${diagnostic}`,
    ).toBeLessThanOrEqual(measurement.clientWidth + 1);
  }
  for (const [name, measurement] of Object.entries({
    header: layout.header,
    composer: layout.composer,
    timeline: layout.timeline,
  })) {
    expect(measurement.rect.left, `${name} left bound; ${diagnostic}`)
      .toBeGreaterThanOrEqual(layout.host.rect.left - 1);
    expect(measurement.rect.right, `${name} right bound; ${diagnostic}`)
      .toBeLessThanOrEqual(layout.host.rect.right + 1);
    expect(measurement.rect.top, `${name} top bound; ${diagnostic}`)
      .toBeGreaterThanOrEqual(layout.host.rect.top - 1);
    expect(measurement.rect.bottom, `${name} bottom bound; ${diagnostic}`)
      .toBeLessThanOrEqual(layout.host.rect.bottom + 1);
  }
  expect(layout.timeline.overflowY, diagnostic).toBe("auto");
};

const expectActorChooserWithinHost = async ({ host, page, workspace, label }) => {
  const trigger = workspace.getByRole("button", {
    name: /Development fixture identity:/u,
  });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const menu = workspace.getByRole("listbox", {
    name: "Development fixture identities",
  });
  await expect(menu).toBeVisible();

  const layout = await page.evaluate((elements) => {
    const measure = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        rect: { left: rect.left, right: rect.right },
        scrollWidth: element.scrollWidth,
      };
    };
    const menu = elements.workspace.querySelector(".chat-lab__identity-menu");
    const navigation = elements.workspace.querySelector(".handrail-chat__navigation");
    if (!(menu instanceof HTMLElement) || !(navigation instanceof HTMLElement)) {
      throw new Error("Expected open embedded actor chooser");
    }
    return {
      document: measure(document.documentElement),
      host: measure(elements.host),
      menu: measure(menu),
      navigation: measure(navigation),
      workspace: measure(elements.workspace),
    };
  }, {
    host: await host.elementHandle(),
    workspace: await workspace.elementHandle(),
  });
  const diagnostic = `${label}: ${JSON.stringify(layout)}`;
  for (const [name, measurement] of Object.entries({
    document: layout.document,
    host: layout.host,
    navigation: layout.navigation,
    workspace: layout.workspace,
  })) {
    expect(measurement.scrollWidth, `${name} horizontal overflow; ${diagnostic}`)
      .toBeLessThanOrEqual(measurement.clientWidth + 1);
  }
  expect(layout.menu.rect.left, diagnostic)
    .toBeGreaterThanOrEqual(layout.host.rect.left - 1);
  expect(layout.menu.rect.right, diagnostic)
    .toBeLessThanOrEqual(layout.host.rect.right + 1);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
};

test("resizes a real ChatWorkspace host without resizing the desktop viewport", async ({
  chatLab,
  page,
}) => {
  const longChannelId = await seedEmbeddedNavigation(chatLab);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const response = await page.goto(`${chatLab.origin}/embedded-chat-lab.html`);
  expect(response?.ok()).toBe(true);

  const fixture = page.getByRole("region", {
    name: "Resizable embedded ChatWorkspace fixture",
  });
  const host = fixture.locator(".chat-lab__embedded-host");
  const workspace = page.getByRole("region", { name: "Handrail Chat Lab workspace" });
  const navigation = workspace.getByRole("navigation", { name: "Conversations" });
  const workspaceIdentity = navigation.getByRole("heading", {
    exact: true,
    level: 2,
    name: CHAT_LAB_WORKSPACE_NAME,
  });
  await expect(fixture).toBeVisible();
  await expect(workspace).toBeVisible();
  await page.waitForFunction(() =>
    document.querySelector('.chat-lab__realtime-announcement[role="status"]')
      ?.getAttribute("data-realtime-state") === "connected"
  );

  await setHostWidth({ fixture, host, page, width: 960, workspace });
  await expectDesktopComposition(workspace);
  await expect(workspaceIdentity).toBeVisible();
  await expect(workspaceIdentity).toHaveAttribute("title", CHAT_LAB_WORKSPACE_NAME);
  await expect(navigation.locator(".handrail-chat__navigation-header"))
    .toHaveAttribute("data-workspace-id", "chat-lab-development");
  await expect(navigation.getByRole("heading", {
    exact: true,
    level: 2,
    name: "Conversations",
  })).toHaveCount(0);
  await expectActorChooserWithinHost({
    host,
    label: "wide embedded actor chooser",
    page,
    workspace,
  });

  const longChannel = conversationRow(navigation, longChannelId);
  await longChannel.scrollIntoViewIfNeeded();
  await expect(longChannel).toHaveAttribute(
    "title",
    new RegExp(EMBEDDED_LONG_CHANNEL_NAME, "u"),
  );
  await longChannel.click();
  const longTitle = workspace.locator(".handrail-chat__header").getByRole("heading", {
    exact: true,
    level: 2,
    name: EMBEDDED_LONG_CHANNEL_NAME,
  });
  await expect(longTitle).toBeVisible();
  expectEmbeddedLayout(
    await layoutState({ host, page, workspace }),
    "wide embedded workspace with a long conversation title",
  );

  await setHostWidth({ fixture, host, page, width: 480, workspace });
  await expectCompactPane(workspace, "detail");
  await expect(longTitle).toBeVisible();
  const longTitleSizing = await longTitle.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(longTitleSizing.scrollWidth).toBeGreaterThan(longTitleSizing.clientWidth);

  const back = workspace.getByRole("button", { name: "Back to conversations" });
  await expect(back).toBeVisible();
  await back.click();
  await expectCompactPane(workspace, "list");
  await expect(navigation).toBeVisible();
  await expect(workspaceIdentity).toBeVisible();
  await expectActorChooserWithinHost({
    host,
    label: "compact embedded actor chooser",
    page,
    workspace,
  });

  const identityLayout = await navigation.evaluate((element) => {
    const measure = (target) => {
      const rect = target.getBoundingClientRect();
      return {
        clientWidth: target.clientWidth,
        rect: { left: rect.left, right: rect.right },
        scrollWidth: target.scrollWidth,
      };
    };
    const required = (selector) => {
      const target = element.querySelector(selector);
      if (!(target instanceof HTMLElement)) {
        throw new Error(`Missing workspace identity element: ${selector}`);
      }
      return target;
    };
    return {
      header: measure(required(".handrail-chat__navigation-header")),
      identity: measure(required(".handrail-chat__workspace-identity")),
      navigation: measure(element),
      title: measure(required(".handrail-chat__navigation-title")),
    };
  });
  const identityDiagnostic = `workspace identity layout: ${JSON.stringify(identityLayout)}`;
  for (const [name, measurement] of Object.entries(identityLayout)) {
    expect(
      measurement.scrollWidth,
      `${name} horizontal overflow; ${identityDiagnostic}`,
    ).toBeLessThanOrEqual(measurement.clientWidth + 1);
    expect(measurement.rect.left, `${name} left bound; ${identityDiagnostic}`)
      .toBeGreaterThanOrEqual(identityLayout.navigation.rect.left - 1);
    expect(measurement.rect.right, `${name} right bound; ${identityDiagnostic}`)
      .toBeLessThanOrEqual(identityLayout.navigation.rect.right + 1);
  }

  const navigationScroll = await navigation.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(navigationScroll.overflowY).toBe("auto");
  expect(navigationScroll.scrollHeight).toBeGreaterThan(navigationScroll.clientHeight);
  await navigation.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => navigation.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  const publicChannel = conversationRow(
    navigation,
    chatLab.conversationIds.publicChannel,
  );
  await publicChannel.scrollIntoViewIfNeeded();
  await publicChannel.click();
  await expectCompactPane(workspace, "detail");
  await expect(workspace.getByRole("heading", {
    level: 2,
    name: CHAT_LAB_PUBLIC_CHANNEL_NAME,
  })).toBeVisible();

  const composerInput = workspace.getByRole("textbox", {
    name: `Message #${CHAT_LAB_PUBLIC_CHANNEL_NAME}`,
  });
  const initialComposerHeight = await composerInput.evaluate((element) => element.clientHeight);
  await composerInput.fill(LONG_DRAFT);
  await expect(composerInput).toHaveValue(LONG_DRAFT);
  await expect(composerInput).toBeFocused();
  await expect.poll(() => composerInput.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(initialComposerHeight);

  const timeline = workspace.getByRole("region", { name: "Conversation timeline" });
  const timelineViewport = timeline.locator(".handrail-chat__timeline-viewport");
  const header = workspace.locator(".handrail-chat__header");
  const composer = workspace.getByLabel("Conversation composer");
  const stableRegions = {
    composer: await composer.boundingBox(),
    header: await header.boundingBox(),
  };
  const timelineScroll = await timelineViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(timelineScroll.scrollHeight).toBeGreaterThan(timelineScroll.clientHeight);
  await timelineViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => timelineViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await composer.boundingBox()).toEqual(stableRegions.composer);
  expect(await header.boundingBox()).toEqual(stableRegions.header);
  expectEmbeddedLayout(
    await layoutState({ host, page, workspace }),
    "compact workspace with a multiline draft",
  );

  const searchTrigger = workspace.getByRole("button", { name: "Search messages" });
  await searchTrigger.click();
  const searchPanel = workspace.getByRole("region", { name: "Message search" });
  const searchInput = searchPanel.getByRole("searchbox", { name: "Search messages" });
  await expect(searchPanel).toBeVisible();
  await expect(searchInput).toBeFocused();
  await expect(searchInput).toBeInViewport();
  expectEmbeddedLayout(
    await layoutState({ host, page, workspace }),
    "compact workspace with header search open",
  );
  await searchInput.press("Escape");
  await expect(searchPanel).toBeHidden();
  await expect(searchTrigger).toBeFocused();

  const rootMessage = timeline.getByRole("article").filter({
    hasText: CHAT_LAB_PUBLIC_MESSAGES[0].text,
  });
  await rootMessage.scrollIntoViewIfNeeded();
  await rootMessage.getByRole("button", { name: "Open thread with 1 reply" }).click();
  const thread = workspace.getByRole("complementary", { name: "Thread" });
  await expect(thread).toBeVisible();
  await expect(thread).toBeFocused();
  await expect(thread.getByRole("textbox", { name: "Reply to thread" })).toBeVisible();
  await expect(thread.getByRole("button", { name: "Close thread" })).toBeVisible();
  expectEmbeddedLayout(
    await layoutState({ host, page, workspace }),
    "compact workspace with thread open",
  );
  await thread.getByRole("button", { name: "Close thread" }).click();
  await expect(thread).toBeHidden();

  await setHostWidth({ fixture, host, page, width: 720, workspace });
  await expectDesktopComposition(workspace);
  await expect(navigation).toBeVisible();
  await expect(composer).toBeVisible();
  expectEmbeddedLayout(
    await layoutState({ host, page, workspace }),
    "restored desktop composition at 720 pixels",
  );

  await setHostWidth({ fixture, host, page, width: 960, workspace });
  await expectDesktopComposition(workspace);
  expectEmbeddedLayout(
    await layoutState({ host, page, workspace }),
    "restored wide desktop composition",
  );
});
