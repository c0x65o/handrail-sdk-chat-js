import { randomUUID } from "node:crypto";

import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ trace: "retain-on-failure" });

test("keeps a failed send recoverable until a manual retry becomes canonical", async ({
  chatLabOrigin,
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const requestUrl = typeof input === "string" || input instanceof URL
        ? new URL(input, globalThis.location.href).href
        : input.url;
      const requestMethod = init?.method ??
        (input instanceof Request ? input.method : "GET");
      if (
        globalThis.__chatLabRejectFailedSendRetries === true &&
        requestMethod === "POST" &&
        requestUrl === globalThis.__chatLabFailedSendEndpoint
      ) {
        return Promise.reject(new TypeError("Injected failed-send retry transport error"));
      }
      return nativeFetch(input, init);
    };
  });
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);
  await expect(page.locator('.chat-lab__realtime-announcement[role="status"]'))
    .toHaveAttribute("data-realtime-state", "connected");

  const navigation = page.getByRole("navigation", { name: "Conversations" });
  const selectedConversationRow = navigation.locator(
    '.handrail-chat__conversation-button[aria-current="page"][data-conversation-id]',
  );
  await expect(selectedConversationRow).toHaveCount(1);
  await expect(selectedConversationRow).toBeVisible();
  const conversationId = await selectedConversationRow.getAttribute("data-conversation-id");
  expect(conversationId).not.toBeNull();

  const conversation = page.locator(
    `.handrail-chat__conversation[data-conversation-id="${conversationId}"]`,
  );
  await expect(conversation).toBeVisible();
  const timeline = conversation.getByRole("region", { name: "Conversation timeline" });
  const composerRegion = conversation.getByLabel("Conversation composer");
  const composer = composerRegion.getByRole("textbox");
  const sendButton = composerRegion.getByRole("button", { name: "Send message" });
  await expect(timeline).toBeVisible();
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeEditable();

  const runToken = `${testInfo.workerIndex}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const messageText = `Failed-send recovery Playwright message ${runToken}`;
  const messageEndpoint = new URL(
    `/api/chat/conversations/${conversationId}/messages`,
    chatLabOrigin,
  ).href;
  await page.evaluate((endpoint) => {
    globalThis.__chatLabFailedSendEndpoint = endpoint;
    globalThis.__chatLabRejectFailedSendRetries = false;
  }, messageEndpoint);
  const exactEndpointPosts = [];
  const recordExactEndpointPost = (request) => {
    if (request.method() === "POST" && request.url() === messageEndpoint) {
      exactEndpointPosts.push(request);
    }
  };
  page.on("request", recordExactEndpointPost);

  let releaseInitialRequest;
  const initialRequestBarrier = new Promise((resolve) => {
    releaseInitialRequest = resolve;
  });
  let confirmInitialRequestHeld;
  const initialRequestHeld = new Promise((resolve) => {
    confirmInitialRequestHeld = resolve;
  });
  let confirmInitialRequestAborted;
  const initialRequestAborted = new Promise((resolve) => {
    confirmInitialRequestAborted = resolve;
  });
  let interceptedInitialAttempts = 0;
  const holdThenAbortInitialPost = async (route) => {
    interceptedInitialAttempts += 1;
    if (interceptedInitialAttempts !== 1) {
      await route.continue();
      return;
    }
    confirmInitialRequestHeld(route.request());
    await initialRequestBarrier;
    await route.abort("failed");
    confirmInitialRequestAborted();
  };
  await page.route(messageEndpoint, holdThenAbortInitialPost);

  await composer.fill(messageText);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  const heldRequest = await initialRequestHeld;
  expect(heldRequest.method()).toBe("POST");
  expect(heldRequest.url()).toBe(messageEndpoint);
  expect(heldRequest.postData()).toContain(messageText);
  expect(exactEndpointPosts).toHaveLength(1);

  const optimisticMessage = timeline.getByRole("article").filter({
    hasText: messageText,
  });
  await expect(optimisticMessage).toHaveCount(1);
  const optimisticMessageId = await optimisticMessage.getAttribute("data-message-id");
  expect(optimisticMessageId).toMatch(/^optimistic:/u);
  await expect(optimisticMessage.locator(".handrail-chat__timeline-text"))
    .toHaveText(messageText);
  await expect(optimisticMessage.locator('[data-delivery-state="sending"]'))
    .toHaveCount(1);
  await expect(optimisticMessage.getByText("Sending", { exact: true })).toBeVisible();
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue(messageText);

  await page.evaluate(() => {
    globalThis.__chatLabRejectFailedSendRetries = true;
  });
  releaseInitialRequest();
  await initialRequestAborted;
  await page.unroute(messageEndpoint, holdThenAbortInitialPost);
  expect(interceptedInitialAttempts).toBe(1);
  expect(exactEndpointPosts).toHaveLength(1);

  await expect(optimisticMessage).toHaveCount(1);
  await expect(optimisticMessage).toHaveAttribute("data-message-id", optimisticMessageId);
  await expect(optimisticMessage.locator(".handrail-chat__timeline-text"))
    .toHaveText(messageText);
  await expect(optimisticMessage.locator('[data-delivery-state="failed"]'))
    .toHaveCount(1);
  await expect(optimisticMessage.getByText("Send failed", { exact: true })).toBeVisible();
  const timelineRetry = optimisticMessage.getByRole("button", {
    name: "Retry",
    exact: true,
  });
  await expect(timelineRetry).toBeVisible();
  await expect(timelineRetry).toBeEnabled();
  await expect(timelineRetry).toHaveAttribute("title", "Retry sending message");
  const composerRetry = composerRegion.getByRole("button", { name: "Retry send" });
  await expect(composerRetry).toBeVisible();
  await expect(composerRetry).toBeEnabled();
  await expect(composerRegion).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue(messageText);

  await page.evaluate(() => {
    globalThis.__chatLabRejectFailedSendRetries = false;
  });
  const retryResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url() === messageEndpoint &&
    response.ok(),
  );
  await composerRetry.click();
  const retryResponse = await retryResponsePromise;
  expect(retryResponse.ok()).toBe(true);
  const retryResult = await retryResponse.json();
  const serverMessageId = retryResult.message?.id;
  expect(typeof serverMessageId).toBe("string");
  expect(serverMessageId.length).toBeGreaterThan(0);
  expect(serverMessageId.startsWith("optimistic:")).toBe(false);

  expect(exactEndpointPosts.length).toBeGreaterThanOrEqual(2);
  expect(exactEndpointPosts.at(-1)).toBe(retryResponse.request());
  for (const retryPost of exactEndpointPosts.slice(1)) {
    expect(retryPost.postData()).toBe(exactEndpointPosts[0].postData());
  }
  const canonicalMessage = timeline.getByRole("article").filter({
    hasText: messageText,
  });
  await expect(canonicalMessage).toHaveCount(1);
  await expect(canonicalMessage).toHaveAttribute("data-message-id", serverMessageId);
  await expect(canonicalMessage.locator(".handrail-chat__timeline-text"))
    .toHaveText(messageText);
  await expect(canonicalMessage.locator('[data-delivery-state="sent"]')).toHaveCount(1);
  await expect(timeline.locator(`[data-message-id="${optimisticMessageId}"]`)).toHaveCount(0);
  await expect(timeline.locator('[data-message-id^="optimistic:"]')).toHaveCount(0);

  await expect(composerRetry).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeEditable();
  await composer.fill("Composer remains usable after retry");
  await expect(composer).toHaveValue("Composer remains usable after retry");
  await composer.fill("");

  page.off("request", recordExactEndpointPost);
});
