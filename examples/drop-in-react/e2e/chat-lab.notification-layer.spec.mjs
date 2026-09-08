import { expect, test } from "./chat-lab.dense-sidebar.fixture.mjs";

test("header notification preferences own dropdown hit-testing below modal overlays", async ({
  denseChatLab,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${denseChatLab.origin}/chat-lab.html`);

  const workspace = page.getByRole("region", {
    name: "Handrail Chat Lab workspace",
  });
  const navigation = workspace.getByRole("navigation", {
    name: "Conversations",
  });
  await expect(navigation.locator(
    ".handrail-chat__notification-preferences-trigger",
  )).toHaveCount(0);
  const header = workspace.locator(".handrail-chat__header");
  const preferences = header.locator(".handrail-chat__notification-preferences");
  const trigger = preferences.getByRole("button", {
    name: /^Notification preferences:/u,
  });

  await trigger.click();
  const dialog = preferences.getByRole("dialog", {
    name: "Notification preferences",
  });
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  const dropdownProbe = await dialog.evaluate((panel) => {
    const chat = panel.closest(".handrail-chat[data-handrail-chat-mode]");
    const competingItem = [...(chat?.querySelectorAll(
      ".handrail-chat__conversation-item",
    ) ?? [])][0];
    if (!(competingItem instanceof HTMLElement)) return null;

    const panelRect = panel.getBoundingClientRect();
    competingItem.dataset.layerOverlapProbe = "true";
    Object.assign(competingItem.style, {
      blockSize: "2rem",
      inlineSize: `${panelRect.width}px`,
      insetBlockStart: `${panelRect.top}px`,
      insetInlineStart: `${panelRect.left}px`,
      position: "fixed",
      zIndex: "50",
    });
    const hit = document.elementFromPoint(
      panelRect.left + panelRect.width / 2,
      panelRect.top + 16,
    );
    return {
      hitWithinDialog: hit !== null && panel.contains(hit),
      positionedSurface: getComputedStyle(competingItem).position,
      panelLayer: getComputedStyle(panel).zIndex,
      competingLayer: getComputedStyle(competingItem).zIndex,
    };
  });
  expect(dropdownProbe).toEqual({
    hitWithinDialog: true,
    positionedSurface: "fixed",
    panelLayer: "100",
    competingLayer: "50",
  });

  const modalProbe = await dialog.evaluate((panel) => {
    const chat = panel.closest(".handrail-chat[data-handrail-chat-mode]");
    if (!(chat instanceof HTMLElement)) return null;

    const panelRect = panel.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.className = "handrail-chat__forward-dialog";
    overlay.dataset.layerOverlayProbe = "true";
    chat.append(overlay);
    const hit = document.elementFromPoint(
      panelRect.left + panelRect.width / 2,
      panelRect.top + panelRect.height / 2,
    );
    return {
      hitOverlay: hit !== null && overlay.contains(hit),
      panelLayer: getComputedStyle(panel).zIndex,
      overlayLayer: getComputedStyle(overlay).zIndex,
    };
  });
  expect(modalProbe).toEqual({
    hitOverlay: true,
    panelLayer: "100",
    overlayLayer: "200",
  });

  await page.locator('[data-layer-overlay-probe="true"]').evaluate((element) => {
    element.remove();
  });
  await page.locator('[data-layer-overlap-probe="true"]').evaluate((element) => {
    element.removeAttribute("style");
    delete element.dataset.layerOverlapProbe;
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
