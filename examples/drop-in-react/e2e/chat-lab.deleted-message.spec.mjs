import { expect, test } from "./chat-lab.fixture.mjs";

const assertDeletedGroupMessage = async ({ chatLab, page }) => {
  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  await expect(workspace).toBeVisible();

  const groupConversation = workspace.locator(
    `button[data-conversation-id=${JSON.stringify(chatLab.conversationIds.groupDirect)}]`,
  );
  await expect(groupConversation).toHaveCount(1);
  await groupConversation.click();
  await expect(groupConversation).toHaveAttribute("aria-current", "page");

  const deletedMessage = workspace.locator(
    `[data-message-id=${JSON.stringify(chatLab.deletedGroupDirectMessage.id)}]`,
  );
  await expect(deletedMessage).toHaveCount(1);
  await expect(
    deletedMessage.getByText("This message was deleted.", { exact: true }),
  ).toBeVisible();
  await expect(deletedMessage).not.toContainText(
    chatLab.deletedGroupDirectMessage.originalText,
  );
  await expect(deletedMessage.locator("[data-delete-state]"))
    .toHaveAttribute("data-delete-state", "idle");

  await deletedMessage.hover();
  await expect(deletedMessage.getByRole("toolbar", { name: "Message actions" }))
    .toHaveCount(0);
  await expect(deletedMessage.getByRole("group", { name: "Reactions" }))
    .toHaveCount(0);
  for (const action of ["Reply", "Add reaction", "Edit", "Delete"]) {
    await expect(deletedMessage.getByRole("button", { name: action, exact: true }))
      .toHaveCount(0);
  }
};

test("hydrates a settled canonical group-message tombstone before and after reload", async ({
  chatLab,
  page,
}) => {
  expect(chatLab.deletedGroupDirectMessage.revision).toBe(2);
  expect(chatLab.deletedGroupDirectMessage.deletedAt).toBeTruthy();
  expect(chatLab.deletedGroupDirectMessage.deletedByUserId)
    .toBe(chatLab.deletedGroupDirectMessage.authorId);

  await page.goto(new URL("/chat-lab.html", chatLab.origin).href);
  await assertDeletedGroupMessage({ chatLab, page });

  await page.reload();
  await assertDeletedGroupMessage({ chatLab, page });
});
