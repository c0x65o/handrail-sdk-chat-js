import { expect, test } from "./chat-lab.fixture.mjs";

const ATTACHMENT_BASELINE = "chat-lab-attachments-dark-1440x900.png";
const BASELINE_DATE_LABEL = "August 28, 2026";
const BASELINE_MESSAGE_TIME_LABEL = "12:00 PM";
const DESKTOP_VIEWPORT = Object.freeze({ height: 900, width: 1440 });
const VISUAL_DIFF_TOLERANCE = Object.freeze({
  maxDiffPixels: 100,
  threshold: 0.1,
});
const textFile = Object.freeze({
  name: "playwrightattachmentvisualregressionfilecardwrappingmustremainboundedinsidechatlabmessagetimelinewithoutintroducingworkspacehorizontaloverflowduringdesignreview.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Playwright loopback attachment bytes.\n", "utf8"),
});
const imageFile = Object.freeze({
  name: "pasted-layout-preview.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAA8AAAAHgAgMAAAAXi+wXAAAADFBMVEUnR29IcJlnkLXd5u9mDv6qAAABj0lEQVR42u3PQREAIAwDsJnEJCaHAu76b+IgMwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfp4ywsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsHAevmWEhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYXz8JYRFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhaOPaJGLCHz7AtnAAAAAElFTkSuQmCC",
    "base64",
  ),
});

const waitForManagedRealtimeConnection = async (page) => {
  await expect(page.locator('.chat-lab__realtime-announcement[role="status"]'))
    .toHaveAttribute("data-realtime-state", "connected");
};

const selectDarkTheme = async (page) => {
  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  const trigger = workspace.getByRole("button", { name: "Open theme settings" });
  await trigger.click();
  await workspace.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(workspace).toHaveAttribute("data-handrail-theme", "dark");
};

const settleAttachmentBaseline = async (page) => {
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
      if (image.naturalWidth > 0) await image.decode();
    }));
    for (const time of document.querySelectorAll(".handrail-chat__timeline-date time")) {
      time.textContent = dateLabel;
    }
    for (const time of document.querySelectorAll(".handrail-chat__timeline-author time")) {
      time.textContent = messageTimeLabel;
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, {
    dateLabel: BASELINE_DATE_LABEL,
    messageTimeLabel: BASELINE_MESSAGE_TIME_LABEL,
  });
  await page.mouse.move(0, 0);
};

const captureAttachmentGeometry = async (message) => message.evaluate((element) => {
  const required = (root, selector) => {
    const match = root.querySelector(selector);
    if (!(match instanceof HTMLElement)) {
      throw new Error(`Expected attachment layout element: ${selector}`);
    }
    return match;
  };
  const measure = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      clientWidth: node.clientWidth,
      rect: {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      },
      scrollWidth: node.scrollWidth,
    };
  };
  const timelineColumn = required(element, ".handrail-chat__timeline-item-body");
  const imageCard = required(element, '[data-attachment-kind="image"]');
  const imagePreview = required(imageCard, ".handrail-chat__timeline-attachment-preview");
  const image = required(imagePreview, ".handrail-chat__timeline-attachment-image");
  const fileCard = required(element, '[data-attachment-kind="file"]');
  const fileName = required(fileCard, ".handrail-chat__timeline-attachment-name");
  const timelineViewport = element.closest(".handrail-chat__timeline-viewport");
  const workspace = document.querySelector(".handrail-chat--workspace");
  if (!(timelineViewport instanceof HTMLElement)) {
    throw new Error("Expected attachment timeline viewport");
  }
  if (!(workspace instanceof HTMLElement)) throw new Error("Expected Chat Lab workspace");

  return {
    body: measure(document.body),
    document: measure(document.documentElement),
    fileCard: measure(fileCard),
    fileName: {
      ...measure(fileName),
      lineHeight: Number.parseFloat(getComputedStyle(fileName).lineHeight),
    },
    image: {
      ...measure(image),
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
    },
    imageCard: measure(imageCard),
    imagePreview: measure(imagePreview),
    timelineColumn: measure(timelineColumn),
    timelineViewport: measure(timelineViewport),
    workspace: measure(workspace),
  };
});

const expectInside = (child, parent, label) => {
  const diagnostic = `${label} geometry: ${JSON.stringify({ child, parent })}`;
  expect(child.rect.left, diagnostic).toBeGreaterThanOrEqual(parent.rect.left - 1);
  expect(child.rect.right, diagnostic).toBeLessThanOrEqual(parent.rect.right + 1);
};

const expectVisibleInside = (child, parent, label) => {
  expectInside(child, parent, label);
  const diagnostic = `${label} viewport geometry: ${JSON.stringify({ child, parent })}`;
  expect(child.rect.top, diagnostic).toBeGreaterThanOrEqual(parent.rect.top - 1);
  expect(child.rect.bottom, diagnostic).toBeLessThanOrEqual(parent.rect.bottom + 1);
};

const expectNoHorizontalOverflow = (measurement, label) => {
  const diagnostic = `${label} overflow: ${JSON.stringify(measurement)}`;
  expect(measurement.scrollWidth, diagnostic).toBeLessThanOrEqual(
    measurement.clientWidth + 1,
  );
};

test("selects and pastes attachments through canonical upload, send, reload, and download", async ({
  chatLabOrigin,
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const observed = [];
  page.on("response", (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (
      url.pathname.startsWith("/api/chat/") ||
      url.pathname.startsWith("/__chat-lab/storage/")
    ) {
      observed.push({
        method: request.method(),
        path: url.pathname,
        status: response.status(),
      });
    }
  });

  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  await waitForManagedRealtimeConnection(page);
  await selectDarkTheme(page);
  const navigation = page.getByRole("navigation", { name: "Conversations" });
  const direct = navigation.locator(
    '.handrail-chat__conversation-button[data-conversation-kind="direct"]' +
      '[data-conversation-id]',
  );
  await expect(direct).toHaveCount(1);
  await expect(direct.locator(".handrail-chat__conversation-label"))
    .toHaveText("Grace Hopper");
  const directConversationId = await direct.getAttribute("data-conversation-id");
  expect(directConversationId).not.toBeNull();
  await direct.click();

  const conversation = page.locator(
    `.handrail-chat__conversation[data-conversation-id="${directConversationId}"]`,
  );
  const composerRegion = conversation.getByLabel("Conversation composer");
  const composer = composerRegion.getByRole("textbox", { name: "Message" });
  const attachments = composerRegion.getByRole("list", { name: "Message attachments" });
  const attachFiles = composerRegion.getByLabel("Attach files");
  await expect(composer).toBeEnabled();
  await expect(attachFiles).toBeEnabled();

  await attachFiles.setInputFiles(textFile);
  await expect(attachments.getByRole("listitem").filter({ hasText: textFile.name }))
    .toContainText("finalized");

  await composer.evaluate((textarea, file) => {
    const binary = atob(file.base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.type }));
    textarea.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, {
    base64: imageFile.buffer.toString("base64"),
    name: imageFile.name,
    type: imageFile.mimeType,
  });
  await expect(attachments.getByRole("listitem").filter({ hasText: imageFile.name }))
    .toContainText("finalized");

  const messageText = "Message with selected text and pasted image attachments.";
  await composer.fill(messageText);
  await composerRegion.getByRole("button", { name: "Send message" }).click();

  const timeline = conversation.getByRole("region", { name: "Conversation timeline" });
  const sentMessage = timeline.getByRole("article").filter({ hasText: messageText });
  await expect(sentMessage).toHaveCount(1);
  await expect(sentMessage.getByText(textFile.name, { exact: true })).toBeVisible();
  await expect(sentMessage.getByRole("img", { name: imageFile.name })).toBeVisible();

  await expect.poll(() => observed.filter(({ method, path, status }) =>
    method === "POST" &&
    /\/api\/chat\/conversations\/[^/]+\/attachments$/u.test(path) &&
    status === 200).length).toBe(2);
  await expect.poll(() => observed.filter(({ method, path, status }) =>
    method === "PUT" && path === "/__chat-lab/storage/upload" && status === 204).length)
    .toBe(2);
  await expect.poll(() => observed.filter(({ method, path, status }) =>
    method === "PATCH" &&
    /\/api\/chat\/attachments\/[^/]+\/lifecycle$/u.test(path) &&
    status === 200).length).toBe(2);
  await expect.poll(() => observed.some(({ method, path, status }) =>
    method === "POST" &&
    /\/api\/chat\/conversations\/[^/]+\/messages$/u.test(path) &&
    status === 201)).toBe(true);

  await page.reload();
  await waitForManagedRealtimeConnection(page);
  await expect(page.getByLabel("Handrail Chat Lab workspace"))
    .toHaveAttribute("data-handrail-theme", "dark");
  const reloadedNavigation = page.getByRole("navigation", { name: "Conversations" });
  const reloadedDirect = reloadedNavigation.locator(
    `.handrail-chat__conversation-button[data-conversation-kind="direct"]` +
      `[data-conversation-id="${directConversationId}"]`,
  );
  await expect(reloadedDirect).toHaveCount(1);
  await expect(reloadedDirect.locator(".handrail-chat__conversation-label"))
    .toHaveText("Grace Hopper");
  await reloadedDirect.click();
  const reloadedConversation = page.locator(
    `.handrail-chat__conversation[data-conversation-id="${directConversationId}"]`,
  );
  const reloadedTimeline = reloadedConversation.getByRole("region", {
    name: "Conversation timeline",
  });
  const reloadedMessage = reloadedTimeline.getByRole("article").filter({
    hasText: messageText,
  });
  await expect(reloadedMessage).toHaveCount(1);
  const image = reloadedMessage.getByRole("img", { name: imageFile.name });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => ({
    height: element.naturalHeight,
    width: element.naturalWidth,
  }))).toEqual({ height: 480, width: 960 });

  const textAttachment = reloadedMessage.locator('[data-attachment-kind="file"]').filter({
    hasText: textFile.name,
  });
  const imageAttachment = reloadedMessage.locator('[data-attachment-kind="image"]').filter({
    hasText: imageFile.name,
  });
  await expect(textAttachment).toBeVisible();
  await expect(imageAttachment).toBeVisible();
  await expect(textAttachment.locator(".handrail-chat__muted"))
    .toHaveText(`Plain text · ${textFile.buffer.length} bytes`);
  await expect(imageAttachment.locator(".handrail-chat__muted"))
    .toHaveText(`PNG image · ${imageFile.buffer.length} bytes`);
  const downloadLink = textAttachment.getByRole("link", { name: "Download" });
  await expect(downloadLink).toBeVisible();
  await expect(downloadLink).toHaveAttribute(
    "href",
    /\/__chat-lab\/storage\/download\?.*\btoken=/u,
  );

  await reloadedMessage.evaluate((element) => {
    element.scrollIntoView({ block: "start", inline: "nearest" });
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  });
  await settleAttachmentBaseline(page);
  const geometry = await captureAttachmentGeometry(reloadedMessage);
  for (const [label, measurement] of Object.entries({
    body: geometry.body,
    document: geometry.document,
    workspace: geometry.workspace,
  })) {
    expectNoHorizontalOverflow(measurement, label);
  }
  for (const [label, measurement] of Object.entries({
    "file attachment card": geometry.fileCard,
    "image attachment card": geometry.imageCard,
    "image preview": geometry.imagePreview,
  })) {
    expectInside(measurement, geometry.timelineColumn, label);
  }
  for (const [label, measurement] of Object.entries({
    "visible file attachment card": geometry.fileCard,
    "visible image attachment card": geometry.imageCard,
  })) {
    expectVisibleInside(measurement, geometry.timelineViewport, label);
  }
  expect(geometry.image.naturalWidth).toBeGreaterThan(geometry.image.rect.width + 1);
  expect(geometry.imagePreview.rect.width).toBeLessThanOrEqual(513);
  expect(geometry.fileName.rect.height).toBeGreaterThan(geometry.fileName.lineHeight * 1.5);

  await expect(page.locator(".chat-lab__stage")).toHaveScreenshot(
    ATTACHMENT_BASELINE,
    {
      animations: "disabled",
      caret: "hide",
      ...VISUAL_DIFF_TOLERANCE,
    },
  );

  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(textFile.name);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(textFile.buffer);
});
