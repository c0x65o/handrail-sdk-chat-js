import { expect, test } from "./chat-lab.fixture.mjs";

const FORMATTED_TEXT = "ItaQ7";
const PLAIN_TEXT = "-PlainZ9";
const MESSAGE_TEXT = `${FORMATTED_TEXT}${PLAIN_TEXT}`;

test("keeps native keyboard input plain after deactivating Italic", async ({
  chatLabOrigin,
  page,
}) => {
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);

  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  await workspace.getByRole("button", {
    name: /^Grace Hopper, (?:\d+ unread messages, )?Notifications:/u,
  }).click();

  const composerRegion = workspace.getByLabel("Conversation composer");
  const editor = composerRegion.getByRole("textbox", { name: "Message" });
  const italic = composerRegion.getByRole("button", { name: "Italic" });
  const canonical = composerRegion.locator("textarea.handrail-chat__composer-input-shadow");
  await expect(editor).toBeVisible();
  await editor.focus();

  await editor.evaluate((element) => {
    window.__composerInputLifecycle = [];
    for (const type of ["keydown", "beforeinput", "input"]) {
      element.addEventListener(type, (event) => {
        window.__composerInputLifecycle.push({
          type,
          data: event instanceof InputEvent ? event.data : undefined,
          key: event instanceof KeyboardEvent ? event.key : undefined,
        });
      });
    }
  });

  await italic.click();
  await page.keyboard.type(FORMATTED_TEXT);
  await italic.click();
  await page.keyboard.type(PLAIN_TEXT);

  await expect(editor).toHaveText(MESSAGE_TEXT);
  await expect(canonical).toHaveValue(`*${FORMATTED_TEXT}*${PLAIN_TEXT}`);
  await expect(editor.locator("em, i")).toHaveText(FORMATTED_TEXT);
  await expect(editor.locator("em, i")).toHaveCount(1);
  await expect(editor.locator("[data-composer-caret-boundary]")).toHaveCount(0);
  await expect(editor).not.toContainText(/[\u200B\uE000]/u);

  const lifecycle = await page.evaluate(() => window.__composerInputLifecycle);
  expect(lifecycle.filter(({ type }) => type === "keydown").map(({ key }) => key))
    .toEqual([...MESSAGE_TEXT]);
  expect(lifecycle.filter(({ type }) => type === "beforeinput").map(({ data }) => data))
    .toEqual([...MESSAGE_TEXT]);
  expect(lifecycle.filter(({ type }) => type === "input").map(({ data }) => data))
    .toEqual([...MESSAGE_TEXT]);

  const messageResponses = [];
  page.on("response", (response) => {
    if (response.request().method() === "POST" && /\/messages(?:\?|$)/u.test(response.url())) {
      messageResponses.push(response.status());
    }
  });
  await composerRegion.getByRole("button", { name: "Send message" }).click();

  const message = workspace.getByRole("article", { name: "Message from Ada Lovelace" })
    .filter({ hasText: MESSAGE_TEXT });
  await expect(message).toHaveCount(1);
  const messageText = message.locator(".handrail-chat__timeline-text");
  await expect(messageText).toHaveText(MESSAGE_TEXT);
  await expect(messageText.locator("em, i")).toHaveText(FORMATTED_TEXT);
  await expect(messageText.locator("em, i")).toHaveCount(1);
  await expect.poll(() => [...messageResponses]).toEqual([201]);
});
