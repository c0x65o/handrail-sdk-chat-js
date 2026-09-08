import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ launchOptions: { args: [
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
] } });

test("direct-message huddle connects before Unmute requests microphone capture", async ({ page, chatLabOrigin }) => {
  await page.addInitScript(() => {
    window.__microphoneRequests = 0;
    window.__microphoneTracks = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      window.__microphoneRequests++;
      const stream = await capture(...args);
      window.__microphoneTracks.push(...stream.getAudioTracks());
      return stream;
    };
  });
  await page.goto(`${chatLabOrigin}/chat-lab.html?actor=ada`);
  await expect(page.locator('.chat-lab__realtime-announcement')).toHaveAttribute("data-realtime-state", "connected");
  await page.locator('.handrail-chat__conversation-button[data-conversation-kind="direct"]').click();
  await expect(page.getByRole("heading", { name: "Grace Hopper" })).toBeVisible();
  await page.getByRole("button", { name: "Start huddle", exact: true }).click();
  await page.getByRole("button", { name: "Join huddle", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unmute microphone", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__microphoneRequests)).toBe(0);
  await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__microphoneRequests)).toBe(1);
  expect(await page.evaluate(() => window.__microphoneTracks.some(track => track.readyState === "live" && track.enabled))).toBe(true);
  await page.getByRole("button", { name: "Leave huddle", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__microphoneTracks.every(track => track.readyState === "ended"))).toBe(true);
});
