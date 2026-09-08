import path from "node:path";

import {
  CHAT_LAB_EMPTY_CHANNEL_NAME,
  CHAT_LAB_GROUP_DIRECT_MESSAGES,
  CHAT_LAB_PUBLIC_CHANNEL_NAME,
  CHAT_LAB_PUBLIC_MESSAGES,
} from "../scripts/chat-lab-backend.mjs";
import { expect, test } from "./chat-lab.fixture.mjs";

test("opens the full-screen Chat Lab workspace", async ({ chatLabOrigin, page }, testInfo) => {
  await page.goto(new URL("/chat-lab.html", chatLabOrigin).href);

  const interactiveLab = page.getByRole("region", { name: "Interactive chat lab" });
  const workspace = page.getByLabel("Handrail Chat Lab workspace");
  await expect(interactiveLab).toBeVisible();
  await expect(workspace).toBeVisible();

  const publicChannel = workspace.getByRole("button", {
    name: new RegExp(`^${CHAT_LAB_PUBLIC_CHANNEL_NAME}(?:,|$)`, "u"),
  });
  await publicChannel.click();
  const publicRoot = workspace
    .getByRole("article", { name: "Message from Ada Lovelace" })
    .filter({ hasText: CHAT_LAB_PUBLIC_MESSAGES[0].text });
  await expect(publicRoot).toBeVisible();
  await expect(
    workspace
      .getByRole("article", { name: "Message from Margaret Hamilton" })
      .filter({ hasText: CHAT_LAB_PUBLIC_MESSAGES[3].text }),
  ).toBeVisible();
  await expect(
    publicRoot.getByRole("button", { name: "Open thread with 1 reply" }),
  ).toBeVisible();

  await workspace.getByRole("button", {
    name: /Grace Hopper.*Margaret Hamilton/u,
  }).click();
  const displayNameByActor = {
    ada: "Ada Lovelace",
    grace: "Grace Hopper",
    margaret: "Margaret Hamilton",
  };
  for (const fixture of CHAT_LAB_GROUP_DIRECT_MESSAGES) {
    await expect(
      workspace
        .getByRole("article", {
          name: `Message from ${displayNameByActor[fixture.authorId]}`,
        })
        .filter({ hasText: fixture.text }),
    ).toBeVisible();
  }

  await workspace.getByRole("button", {
    name: new RegExp(`^${CHAT_LAB_EMPTY_CHANNEL_NAME}(?:,|$)`, "u"),
  }).click();
  await expect(workspace.getByRole("heading", {
    level: 2,
    name: `#${CHAT_LAB_EMPTY_CHANNEL_NAME}`,
  })).toBeVisible();
  await expect(workspace.getByText(
    "A public channel anyone in the workspace can find and join.",
  )).toBeVisible();
  await expect(workspace.getByText("Send the first message when you’re ready.")).toBeVisible();
  await expect(workspace.getByRole("article")).toHaveCount(0);

  await publicChannel.click();
  await expect(publicRoot).toBeVisible();

  const screenshotPath = testInfo.outputPath("chat-lab-workspace-smoke.png");
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach("chat-lab-workspace-smoke", {
    path: screenshotPath,
    contentType: "image/png",
  });
  console.log(`Chat Lab screenshot: ${path.relative(process.cwd(), screenshotPath)}`);
});
