import { randomUUID } from "node:crypto";
import path from "node:path";

import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ trace: "on" });

const activeConversationRows = (navigation) => navigation.locator(
  '.handrail-chat__conversation-button[aria-current="page"]',
);

const expectEmptyPublicChannel = async (timeline, channelName) => {
  await expect(timeline.getByRole("heading", {
    level: 2,
    name: `#${channelName}`,
  })).toBeVisible();
  await expect(timeline.getByText(
    "A public channel anyone in the workspace can find and join.",
    { exact: true },
  )).toBeVisible();
  await expect(timeline.getByText(
    "Send the first message when you’re ready.",
    { exact: true },
  )).toBeVisible();
  await expect(timeline.getByRole("article")).toHaveCount(0);
};

const observeRealtimeRecovery = async (page) => {
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
    window.__chatLabCreationRecoveryStates = observedStates;
  });
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

test("creates a channel, preserves its selection through realtime recovery, and sends a canonical message", async ({
  chatLabOrigin,
  context,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);

  const realtimeAnnouncement = page.locator(
    '.chat-lab__realtime-announcement[role="status"]',
  );
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");
  await expect(realtimeAnnouncement).toHaveText("Managed realtime connected");

  const identityMenuButton = page.getByRole("button", {
    name: "Development fixture identity: Ada Lovelace",
  });
  await identityMenuButton.click();
  const identityMenu = page.getByRole("listbox", {
    name: "Development fixture identities",
  });
  await expect(identityMenu).toBeVisible();
  await identityMenu.getByRole("option", { name: "Grace Hopper Engineering" }).click();
  await expect(identityMenu).toBeHidden();
  await expect(page.getByRole("button", {
    name: "Development fixture identity: Grace Hopper",
  })).toBeVisible();
  await expect(page.getByText("Current actor: Grace Hopper", { exact: true })).toBeAttached();
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const navigation = page.getByRole("navigation", { name: "Conversations" });
  const existingDestination = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]',
  );
  await expect(existingDestination).toHaveCount(1);
  await expect(existingDestination).toBeVisible();
  const existingConversationId = await existingDestination.getAttribute(
    "data-conversation-id",
  );
  expect(existingConversationId).not.toBeNull();
  await expect(existingDestination.locator(
    ".handrail-chat__conversation-label",
  )).toHaveText("Ada Lovelace");
  await existingDestination.click();
  await expect(existingDestination).toHaveAttribute("aria-current", "page");
  await expect(existingDestination).toHaveAttribute(
    "data-conversation-id",
    existingConversationId,
  );
  await expect(activeConversationRows(navigation)).toHaveCount(1);

  const runToken = `${testInfo.workerIndex}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const channelName = `Playwright channel ${runToken}`;
  const messageText = `Canonical Playwright message ${runToken}`;
  const existingRowBoxBefore = await existingDestination.boundingBox();
  expect(existingRowBoxBefore).not.toBeNull();
  const addConversation = navigation.getByRole("button", { name: "Add conversation" });

  await addConversation.click();
  const creationMenu = navigation.getByRole("menu", { name: "Create conversation" });
  await expect(creationMenu).toBeVisible();
  await creationMenu.getByRole("menuitem", { name: "Create channel" }).click();

  const creationDialog = page.getByRole("dialog", { name: "Create channel" });
  await expect(creationDialog).toBeVisible();
  const channelNameInput = creationDialog.getByRole("textbox", { name: "Channel name" });
  await expect(channelNameInput).toBeFocused();
  const [workspaceBox, dialogBox, existingRowBoxWhileOpen] = await Promise.all([
    workspace.boundingBox(),
    creationDialog.boundingBox(),
    existingDestination.boundingBox(),
  ]);
  expect(workspaceBox).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(existingRowBoxWhileOpen).not.toBeNull();
  expect(Math.abs(
    dialogBox.x + dialogBox.width / 2 - (workspaceBox.x + workspaceBox.width / 2),
  )).toBeLessThanOrEqual(1);
  expect(Math.abs(
    dialogBox.y + dialogBox.height / 2 - (workspaceBox.y + workspaceBox.height / 2),
  )).toBeLessThanOrEqual(1);
  expect(existingRowBoxWhileOpen.x).toBe(existingRowBoxBefore.x);
  expect(existingRowBoxWhileOpen.y).toBe(existingRowBoxBefore.y);
  const modalLayers = await creationDialog.evaluate((dialog) => {
    const overlay = dialog.parentElement;
    const root = dialog.closest(".handrail-chat");
    if (!(overlay instanceof HTMLElement) || !(root instanceof HTMLElement)) {
      throw new Error("Channel creation modal is not contained by ChatWorkspace");
    }
    const rootStyles = getComputedStyle(root);
    return {
      overlay: Number(getComputedStyle(overlay).zIndex),
      overlayToken: Number(rootStyles.getPropertyValue("--hr-chat-layer-overlay")),
      dropdownToken: Number(rootStyles.getPropertyValue("--hr-chat-layer-dropdown")),
      workspaceContained: overlay.parentElement === root,
    };
  });
  expect(modalLayers.workspaceContained).toBe(true);
  expect(modalLayers.overlay).toBe(modalLayers.overlayToken);
  expect(modalLayers.overlay).toBeGreaterThan(modalLayers.dropdownToken);
  const publicChoice = creationDialog.getByRole("radio", { name: "Public" });
  const privateChoice = creationDialog.getByRole("radio", { name: "Private" });
  await expect(publicChoice).not.toBeChecked();
  await expect(privateChoice).not.toBeChecked();

  await page.keyboard.press("Escape");
  await expect(creationDialog).toBeHidden();
  await expect(addConversation).toBeFocused();

  await addConversation.click();
  await expect(creationMenu).toBeVisible();
  await creationMenu.getByRole("menuitem", { name: "Create channel" }).click();
  await expect(creationDialog).toBeVisible();
  await page.locator(".handrail-chat__channel-creation").click({
    position: { x: 5, y: 5 },
  });
  await expect(creationDialog).toBeHidden();
  await expect(addConversation).toBeFocused();

  const publicSectionTrigger = navigation.getByRole("button", {
    name: "Create public channel",
  });
  await publicSectionTrigger.click();
  await expect(creationDialog).toBeVisible();
  await expect(publicChoice).toBeChecked();
  await expect(privateChoice).not.toBeChecked();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() =>
    document.activeElement?.getAttribute("aria-label")
  )).toBe("Create public channel");
  await expect(creationDialog).toBeHidden();
  await expect(publicSectionTrigger).toBeFocused();

  const privateSectionTrigger = navigation.getByRole("button", {
    name: "Create private channel",
  });
  const privateSectionTriggerElement = await privateSectionTrigger.elementHandle();
  expect(privateSectionTriggerElement).not.toBeNull();
  await privateSectionTrigger.click();
  await expect(creationDialog).toBeVisible();
  await expect(publicChoice).not.toBeChecked();
  await expect(privateChoice).toBeChecked();
  await creationDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(creationDialog).toBeHidden();
  await expect(privateSectionTrigger).toBeFocused();
  expect(await privateSectionTriggerElement.evaluate((trigger) =>
    document.activeElement === trigger
  )).toBe(true);

  await addConversation.click();
  await expect(creationMenu).toBeVisible();
  await creationMenu.getByRole("menuitem", { name: "Create channel" }).click();
  await expect(creationDialog).toBeVisible();
  await expect(channelNameInput).toBeFocused();
  await expect(publicChoice).not.toBeChecked();
  await expect(privateChoice).not.toBeChecked();
  await channelNameInput.fill(channelName);
  await publicChoice.check();

  const creationResponsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/conversations";
  });
  await creationDialog.getByRole("button", { name: "Create", exact: true }).click();
  const creationResponse = await creationResponsePromise;
  expect(creationResponse.ok()).toBe(true);
  const creationResult = await creationResponse.json();
  const createdConversationId = creationResult.conversation?.conversation?.id;
  expect(typeof createdConversationId).toBe("string");
  expect(createdConversationId.length).toBeGreaterThan(0);

  await expect(creationDialog).toBeHidden();
  await expect(creationMenu).toBeHidden();
  const createdChannelRow = navigation.locator(
    `.handrail-chat__conversation-button[data-conversation-id="${createdConversationId}"]`,
  );

  const createdConversation = workspace.locator(
    `.handrail-chat__conversation[data-conversation-id="${createdConversationId}"]`,
  );
  await expect(createdConversation).toBeVisible();
  await expect(createdConversation.getByRole("heading", {
    exact: true,
    level: 2,
    name: channelName,
  })).toBeVisible();
  const conversationMain = createdConversation.getByRole("main", { name: channelName });
  await expect(conversationMain).toBeVisible();
  const timeline = createdConversation.getByRole("region", {
    name: "Conversation timeline",
  });
  await expect(timeline).toBeVisible();
  await expectEmptyPublicChannel(timeline, channelName);

  const composerRegion = createdConversation.getByLabel("Conversation composer");
  const composerLabel = `Message #${channelName}`;
  const composer = composerRegion.getByRole("textbox", { name: composerLabel });
  const sendButton = composerRegion.getByRole("button", { name: "Send message" });
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveAttribute("placeholder", composerLabel);
  await expect(sendButton).toBeVisible();

  // Remount the actor-owned provider through the real fixture controls so its
  // server-backed conversation list reconciles while Grace's selection persists.
  await page.getByRole("button", {
    name: "Development fixture identity: Grace Hopper",
  }).click();
  await identityMenu.getByRole("option", { name: "Ada Lovelace Product" }).click();
  await expect(page.getByRole("button", {
    name: "Development fixture identity: Ada Lovelace",
  })).toBeVisible();
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");

  await page.getByRole("button", {
    name: "Development fixture identity: Ada Lovelace",
  }).click();
  await identityMenu.getByRole("option", { name: "Grace Hopper Engineering" }).click();
  await expect(page.getByRole("button", {
    name: "Development fixture identity: Grace Hopper",
  })).toBeVisible();
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");
  await expect(activeConversationRows(navigation)).toHaveCount(1);
  await expect(createdChannelRow).toBeVisible();
  await expect(createdChannelRow).toHaveAttribute("aria-current", "page");
  await expect(createdChannelRow).toHaveAttribute(
    "data-conversation-id",
    createdConversationId,
  );
  await expect(createdConversation).toBeVisible();
  await expect(conversationMain).toBeVisible();
  await expectEmptyPublicChannel(timeline, channelName);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();

  await context.setOffline(true);
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "offline");
  await expect(realtimeAnnouncement).toHaveText("Managed realtime offline");
  await observeRealtimeRecovery(page);
  await context.setOffline(false);
  await expect(realtimeAnnouncement).toHaveAttribute("data-realtime-state", "connected");
  await expect(realtimeAnnouncement).toHaveText("Managed realtime connected");
  const recoveryStates = await page.evaluate(
    () => window.__chatLabCreationRecoveryStates ?? [],
  );
  expect(
    recoveryStates.some((state) => [
      "connecting",
      "reconnecting",
      "hydrating_snapshot",
    ].includes(state)),
    `Expected a managed recovery state before Connected; observed ${recoveryStates.join(", ")}`,
  ).toBe(true);
  expect(recoveryStates.at(-1)).toBe("connected");

  await expect(activeConversationRows(navigation)).toHaveCount(1);
  await expect(createdChannelRow).toBeVisible();
  await expect(createdChannelRow).toHaveAttribute("aria-current", "page");
  await expect(createdChannelRow).toHaveAttribute(
    "data-conversation-id",
    createdConversationId,
  );
  await expect(createdConversation).toBeVisible();
  await expect(conversationMain).toBeVisible();
  await expectEmptyPublicChannel(timeline, channelName);
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();

  await composer.fill(messageText);
  await expect(sendButton).toBeEnabled();
  const sendResponsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/chat/conversations/${createdConversationId}/messages`;
  });
  await sendButton.click();
  const sendResponse = await sendResponsePromise;
  expect(sendResponse.ok()).toBe(true);
  const sendResult = await sendResponse.json();
  const serverMessageId = sendResult.message?.id;
  expect(typeof serverMessageId).toBe("string");
  expect(serverMessageId.length).toBeGreaterThan(0);
  expect(serverMessageId.startsWith("optimistic:")).toBe(false);

  const canonicalMessage = timeline.getByRole("article").filter({ hasText: messageText });
  await expect(canonicalMessage).toHaveCount(1);
  await expect(canonicalMessage).toHaveAttribute("data-message-id", serverMessageId);
  await expect(canonicalMessage.locator(".handrail-chat__timeline-text")).toHaveText(
    messageText,
  );
  await expect(canonicalMessage.locator('[data-delivery-state="sent"]')).toHaveCount(1);
  await expect(timeline.locator('[data-message-id^="optimistic:"]')).toHaveCount(0);

  await expect(composer).toHaveValue("");
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeDisabled();
  await expect(composerRegion.getByRole("status").filter({
    hasText: /^Message sent\.$/u,
  })).toHaveText("Message sent.");
  await expect(activeConversationRows(navigation)).toHaveCount(1);
  await expect(createdChannelRow).toHaveAttribute("aria-current", "page");

  await attachScreenshot(page, testInfo, "chat-lab-creation-to-canonical-send");
});
