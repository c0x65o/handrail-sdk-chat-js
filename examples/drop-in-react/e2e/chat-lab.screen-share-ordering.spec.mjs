import { writeFile } from "node:fs/promises";
import { expect, test } from "./chat-lab.fixture.mjs";

test.use({ launchOptions: { args: [
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--auto-select-desktop-capture-source=Entire screen",
] } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

for (const intent of ["set", "clear", "after-response"]) {
  test(`queued ownership echo during ${intent} reconciles capture and permits the next owner`, async ({ browser, chatLab, chatLabOrigin }, testInfo) => {
    const contexts = [];
    const pages = [];
    const held = deferred();
    const allowEcho = deferred();
    const echoDelivered = deferred();
    let socket;
    let heldEvent;
    let holding = true;
    const subsequent = [];
    const requests = [];
    const delivered = [];
    try {
      for (const actor of ["ada", "grace"]) {
        const context = await browser.newContext({ permissions: ["microphone"] });
        contexts.push(context);
        await context.addInitScript(() => {
          window.__captures = [];
          window.__ownershipEvents = [];
          const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getDisplayMedia = async (...args) => {
            const stream = await capture(...args); window.__captures.push(stream); return stream;
          };
          const Original = window.WebSocket;
          window.WebSocket = class extends Original {
            constructor(...args) {
              super(...args);
              this.addEventListener("message", event => {
                try { const value = JSON.parse(event.data); if (value.type === "huddle.updated") { window.__ownershipEvents.push(value.eventId); window.__lastHuddle = value.payload.state; } } catch {}
              });
            }
          };
        });
        const page = await context.newPage(); pages.push(page);
        if (actor === "ada") {
          await page.routeWebSocket("**/_realtime*", route => {
            socket = route;
            const server = route.connectToServer();
            server.onMessage(message => {
              const event = JSON.parse(String(message));
              const isShare = event.type === "huddle.updated" && event.payload.operation === "set_huddle_screen_share";
              const previousIntent = intent === "clear" ? "set" : "clear";
              if (holding && isShare && (heldEvent || event.payload.intent === previousIntent)) {
                if (!heldEvent) { heldEvent = { message, event }; held.resolve(); }
                else subsequent.push(message);
              } else { delivered.push(event); route.send(message); }
            });
          });
          let sets = 0;
          await page.route("**/api/chat/huddles/*/screen-share", async route => {
            const input = route.request().postDataJSON();
            if (input.intent === "set") sets++;
            const forceOrder = intent === "clear" ? input.intent === "clear" : input.intent === "set" && sets === 2;
            const response = await route.fetch();
            requests.push({ input, response: await response.json() });
            if (forceOrder && holding) {
              await held.promise;
              if (intent === "after-response") {
                await route.fulfill({ response });
                await allowEcho.promise;
              }
              // The transaction has committed. Deliver the preceding command's
              // real durable event before this command's HTTP response.
              delivered.push(heldEvent.event); socket.send(heldEvent.message);
              await page.waitForFunction(id => window.__ownershipEvents.includes(id), heldEvent.event.eventId);
              echoDelivered.resolve();
              if (intent === "after-response") return;
            }
            await route.fulfill({ response });
          });
        }
        await page.goto(`${chatLabOrigin}/chat-lab.html?actor=${actor}`);
        await expect(page.locator('.chat-lab__realtime-announcement')).toHaveAttribute("data-realtime-state", "connected");
        await page.getByRole("button", { name: /Chat Lab General/ }).first().click();
      }
      const [ada, grace] = pages;
      await ada.getByRole("button", { name: "Start huddle", exact: true }).click();
      for (const page of pages) await page.getByRole("button", { name: "Join huddle", exact: true }).click();
      for (const page of pages) await page.waitForFunction(() => window.__lastHuddle?.participants.filter(p => p.status === "joined").length === 2);
      const sessionId = (await chatLab.harness.pool.query(`SELECT id FROM "${chatLab.harness.schema}".chat_huddle_sessions WHERE status IN ('starting','active')`)).rows[0].id;
      await ada.getByRole("button", { name: "Open huddle details", exact: true }).click();
      await ada.getByRole("button", { name: "Start screen sharing", exact: true }).click();
      await expect(grace.getByLabel("Ada Lovelace shared screen", { exact: true })).toBeVisible();
      if (intent !== "clear") {
        await ada.waitForFunction(() => window.__lastHuddle?.screenShareOwnerUserId === "ada");
        await ada.getByRole("button", { name: "Stop screen sharing", exact: true }).click();
        await expect(grace.getByLabel("Ada Lovelace shared screen", { exact: true })).toHaveCount(0);
        await held.promise;
        await ada.getByRole("button", { name: "Start screen sharing", exact: true }).click();
        await expect(grace.getByLabel("Ada Lovelace shared screen", { exact: true })).toBeVisible();
        if (intent === "after-response") { allowEcho.resolve(); await echoDelivered.promise; }
      } else await held.promise;
      // End real captured media, as in the original suite: stop() itself does
      // not dispatch the browser's ended notification.
      await ada.evaluate(() => {
        const track = window.__captures.at(-1).getVideoTracks()[0];
        track.stop(); track.dispatchEvent(new Event("ended"));
      });
      await expect(ada.getByText("No one is sharing their screen.")).toBeVisible();
      holding = false;
      for (const message of subsequent) socket.send(message);
      const owners = () => chatLab.harness.pool.query(`SELECT active_screen_share_owner_user_id AS owner FROM "${chatLab.harness.schema}".chat_huddle_sessions WHERE id=$1`, [sessionId]);
      await expect.poll(async () => (await owners()).rows[0].owner).toBeNull();
      await grace.getByRole("button", { name: "Open huddle details", exact: true }).click();
      await grace.getByRole("button", { name: "Start screen sharing", exact: true }).click();
      await expect(ada.getByLabel("Grace Hopper shared screen", { exact: true })).toBeVisible();
      await expect.poll(async () => (await owners()).rows[0].owner).toBe("grace");
      await grace.getByRole("button", { name: "Leave huddle", exact: true }).click();
      await expect.poll(async () => (await owners()).rows[0].owner).toBeNull();
      await expect.poll(() => grace.evaluate(() => window.__captures.every(s => s.getTracks().every(t => t.readyState === "ended")))).toBe(true);
      await ada.getByRole("button", { name: "End huddle", exact: true }).click();
      await expect.poll(async () => (await chatLab.harness.pool.query(`SELECT status FROM "${chatLab.harness.schema}".chat_huddle_sessions WHERE id=$1`, [sessionId])).rows[0].status).toBe("ended");
    } finally {
      try {
        const evidence = JSON.stringify({ intent, requests, delivered, heldEvent: heldEvent?.event,
        clients: await Promise.all(pages.map(async page => ({ text: await page.locator("body").innerText(), events: await page.evaluate(() => window.__ownershipEvents) }))),
        owners: (await chatLab.harness.pool.query(`SELECT id,status,active_screen_share_owner_user_id FROM "${chatLab.harness.schema}".chat_huddle_sessions`)).rows,
        outbox: (await chatLab.harness.pool.query(`SELECT event_id,replay_position,occurred_at,published_at,payload FROM "${chatLab.harness.schema}".chat_outbox_events WHERE type='huddle.updated' ORDER BY replay_position`)).rows,
      }, null, 2);
        const path = testInfo.outputPath("ownership-ordering.json");
        await writeFile(path, evidence);
        await testInfo.attach("ownership-ordering", { contentType: "application/json", path });
      } finally {
        await Promise.all(contexts.map(context => context.close()));
      }
    }
  });
}
