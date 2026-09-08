import { expect, test } from "./chat-lab.fixture.mjs";

// Synthetic microphone input, real browser capture, signaling, ICE and RTP.
// This is not proof of manual cross-browser or physical microphone quality.
test.use({ launchOptions: { args: [
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--auto-select-desktop-capture-source=Entire screen",
] } });

test("three independent sessions exchange audio and release media on leave/end", async ({ browser, chatLabOrigin, chatLab }) => {
  const contexts = [];
  const pages = [];
  try {
    for (const actor of ["ada", "grace", "margaret"]) {
      const context = await browser.newContext({ permissions: ["microphone"] });
      contexts.push(context);
      await context.addInitScript(() => {
        window.__mediaTestConnections = [];
        window.__mediaTestCaptures = [];
        const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = async (...args) => {
          const stream = await capture(...args);
          window.__mediaTestCaptures.push(stream);
          return stream;
        };
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(...args) { super(...args); window.__mediaTestConnections.push(this); }
        };
      });
      const page = await context.newPage();
      pages.push(page);
      page.on("response", async response => {
        if (response.url().includes("huddle") && response.status() >= 400) console.log(actor, response.status(), await response.text().catch(() => "closed"));
      });
      await page.goto(`${chatLabOrigin}/chat-lab.html?actor=${actor}`);
      await expect(page.locator('.chat-lab__realtime-announcement')).toHaveAttribute("data-realtime-state", "connected");
      await page.getByRole('button', { name: /Chat Lab General/ }).first().click();
    }
    const controls = pages;
    await controls[0].getByRole("button", { name: "Start huddle", exact: true }).click();
    for (const control of controls) {
      await control.getByRole("button", { name: "Join huddle", exact: true }).click();
      await control.getByRole("button", { name: "Unmute microphone", exact: true }).click();
    }
    for (const page of pages) {
      await expect(page.locator('[data-media-connection="connected"]')).toHaveCount(2);
      await expect.poll(() => page.evaluate(async () => {
        const totals = [];
        for (const pc of window.__mediaTestConnections.filter(pc => pc.connectionState === "connected")) {
          const stats = await pc.getStats();
          totals.push([...stats.values()].filter(s => s.type === "inbound-rtp" && s.kind === "audio")
            .reduce((sum, s) => sum + (s.bytesReceived || 0), 0));
        }
        return totals.length === 2 && totals.every(bytes => bytes > 1000);
      })).toBe(true);
    }
    await controls[0].getByRole("button", { name: "Open huddle details", exact: true }).click();
    // Inject permission denial only for this error-path assertion. The next
    // share uses the browser's real capture API and real video transport.
    await pages[0].evaluate(() => {
      window.__captureForTest = navigator.mediaDevices.getDisplayMedia;
      navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); };
    });
    await controls[0].getByRole("button", { name: "Start screen sharing", exact: true }).click();
    await expect(pages[0].getByText("The required media permission was not granted.")).toBeVisible();
    await pages[0].evaluate(() => { navigator.mediaDevices.getDisplayMedia = window.__captureForTest; });
    await controls[0].getByRole("button", { name: "Start screen sharing", exact: true }).click();
    for (const page of pages.slice(1)) {
      const video = page.getByLabel("Ada Lovelace shared screen", { exact: true });
      await expect(video).toBeVisible();
      await expect.poll(() => video.evaluate(element => element.videoWidth > 0 && element.currentTime > 0)).toBe(true);
    }
    await controls[0].getByRole("button", { name: "Stop screen sharing", exact: true }).click();
    for (const page of pages.slice(1)) await expect(page.getByLabel("Ada Lovelace shared screen", { exact: true })).toHaveCount(0);
    await expect.poll(() => pages[0].evaluate(() => window.__mediaTestCaptures.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    // Exercise the browser-ended callback with a real captured track. Dispatch
    // the ended notification explicitly because programmatic stop does not emit it.
    await controls[0].getByRole("button", { name: "Start screen sharing", exact: true }).click();
    await expect(pages[1].getByLabel("Ada Lovelace shared screen", { exact: true })).toBeVisible();
    await pages[0].evaluate(() => {
      const track = window.__mediaTestCaptures.at(-1).getVideoTracks()[0];
      track.stop(); track.dispatchEvent(new Event("ended"));
    });
    await expect(pages[1].getByLabel("Ada Lovelace shared screen", { exact: true })).toHaveCount(0);
    await expect(controls[0].getByText("No one is sharing their screen.")).toBeVisible();
    await controls[0].keyboard.press("Escape");
    await controls[1].getByRole("button", { name: "Mute microphone", exact: true }).click();
    await expect(controls[1].getByRole("button", { name: "Unmute microphone", exact: true })).toBeEnabled();
    await controls[1].getByRole("button", { name: "Open huddle details", exact: true }).click();
    await controls[1].getByRole("button", { name: "Start screen sharing", exact: true }).click();
    await expect(pages[0].getByLabel("Grace Hopper shared screen", { exact: true })).toBeVisible();
    await controls[1].getByRole("button", { name: "Leave huddle", exact: true }).click();
    await expect(pages[0].getByLabel("Grace Hopper shared screen", { exact: true })).toHaveCount(0);
    await expect.poll(() => pages[1].evaluate(() => window.__mediaTestCaptures.every(stream => stream.getTracks().every(track => track.readyState === "ended")))).toBe(true);
    await expect(pages[0].locator('[data-media-connection="connected"]')).toHaveCount(1);
    await controls[1].getByRole("button", { name: "Join huddle", exact: true }).click();
    await expect(pages[0].locator('[data-media-connection="connected"]')).toHaveCount(2);
    await controls[0].getByRole("button", { name: "Open huddle details", exact: true }).click();
    const visits = await chatLab.harness.pool.query(`SELECT user_id FROM "${chatLab.harness.schema}".chat_huddle_participant_visits`);
    expect(visits.rows).toEqual([{ user_id: "grace" }]);
    await controls[0].getByRole("button", { name: "End huddle", exact: true }).click();
    for (const page of pages) {
      await expect.poll(() => page.evaluate(() => window.__mediaTestConnections.every(pc =>
        pc.connectionState === "closed" && pc.getSenders().every(sender => !sender.track || sender.track.readyState === "ended")
      ))).toBe(true);
    }
  } catch (error) {
    console.log((await chatLab.harness.pool.query(`SELECT type, published_at, expires_at FROM "${chatLab.harness.schema}".chat_outbox_events WHERE type LIKE 'huddle.%'`)).rows);
    for (const page of pages) console.log(await page.evaluate(() => window.__mediaTestConnections.map(pc => ({connection:pc.connectionState, ice:pc.iceConnectionState, signaling:pc.signalingState}))));
    throw error;
  } finally { for (const context of contexts) await context.close(); }
});
