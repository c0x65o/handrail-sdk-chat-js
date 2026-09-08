import {
  CHAT_LAB_PUBLIC_CHANNEL_NAME,
} from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.fixture.mjs";

const selectEditedPublicMessage = async ({ chatLab, page }) => {
  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", {
    name: new RegExp(`^${CHAT_LAB_PUBLIC_CHANNEL_NAME}(?:,|$)`, "u"),
  }).click();

  const editedMessage = workspace.locator(
    `[data-message-id=${JSON.stringify(chatLab.editedPublicMessage.id)}]`,
  );
  await expect(editedMessage).toHaveCount(1);
  await expect(editedMessage).toContainText(chatLab.editedPublicMessage.text);
  await expect(editedMessage.getByText("Edited", { exact: true })).toBeVisible();
  await expect(editedMessage.locator("[data-edit-state]"))
    .toHaveAttribute("data-edit-state", "idle");
};

test("hydrates the canonical edited public message before and after reload", async ({
  chatLab,
  page,
}) => {
  expect(chatLab.editedPublicMessage.revision).toBe(2);
  await page.goto(new URL("/chat-lab.html", chatLab.origin).href);
  await selectEditedPublicMessage({ chatLab, page });

  await page.reload();
  await selectEditedPublicMessage({ chatLab, page });
});
