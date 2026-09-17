import { chromium } from '@playwright/test';
import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Capture is synthetic; signaling, SQL, outbox, ICE/DTLS/SRTP are real. No
// unload callback or injected canonical/provider state is used to cause loss.
const captureArgs = [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen',
];
test.use({ chatLabDiscoveryAcceptance: true, channel: 'chromium', launchOptions: { args: captureArgs } });
const stats = page => page.evaluate(async () => Promise.all(window.__media.pcs
  .filter(pc => pc.connectionState === 'connected').map(async pc => [...(await pc.getStats()).values()]
    .filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((n, s) => n + (s.bytesReceived || 0), 0))));
const stopped = page => page.evaluate(() => window.__media.pcs.every(pc => pc.connectionState === 'closed') &&
  window.__media.tracks.every(track => track.readyState === 'ended'));

test('active-share disappearance converges canonically without evicting surviving media', async ({ browser, chatLab, chatLabOrigin }, info) => {
  const contexts = [], pages = [], ownedBrowsers = [], joinRequests = new WeakMap(), observations = [], sql = [], events = [], errors = [], screenshots = [];
  const output = process.env.CHAT_LAB_RECOVERY_ACCEPTANCE_DIR;
  let instance;
  const snapshot = async label => {
    const sessions = (await chatLab.harness.pool.query('SELECT id, status, active_screen_share_owner_user_id AS owner FROM chat_huddle_sessions ORDER BY id')).rows;
    const participants = (await chatLab.harness.pool.query('SELECT user_id, joined_at::text, left_at::text, leave_reason FROM chat_huddle_participants ORDER BY user_id')).rows;
    const outbox = (await chatLab.harness.pool.query("SELECT event_id, type, published_at::text, payload FROM chat_outbox_events WHERE type LIKE 'huddle.%' ORDER BY occurred_at,event_id")).rows;
    const value = { label, sessions, participants, outbox }; sql.push(value); return value;
  };
  const open = async (actor, ownerBrowser = browser) => {
    const context = await ownerBrowser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } });
    contexts.push(context);
    await context.addInitScript(() => {
      window.__media = { pcs: [], tracks: [], sockets: [] };
      for (const method of ['getUserMedia', 'getDisplayMedia']) {
        const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
        navigator.mediaDevices[method] = async (...args) => { const stream = await original(...args); window.__media.tracks.push(...stream.getTracks()); return stream; };
      }
      const Peer = window.RTCPeerConnection, Socket = window.WebSocket;
      window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.__media.pcs.push(this); } };
      window.WebSocket = class extends Socket { constructor(...args) { super(...args); if (String(args[0]).includes('/__chat-lab/media')) window.__media.sockets.push(this); } };
    });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push({ actor, message: error.message }));
    page.on('request', request => { if (/\/huddles\/[^/]+\/join$/.test(new URL(request.url()).pathname)) joinRequests.set(page, request.postDataJSON()); });
    page.on('websocket', socket => {
      if (!socket.url().includes('/api/chat/_realtime')) return;
      socket.on('framereceived', frame => { try { const value = JSON.parse(String(frame.payload)); if (value.type === 'huddle.updated') events.push({ actor, value }); } catch {} });
    });
    await page.goto(`${chatLabOrigin}/chat-lab.html?actor=${actor}`);
    await expect(page.locator('.chat-lab__realtime-announcement')).toHaveAttribute('data-realtime-state', 'connected');
    await page.getByRole('button', { name: /Chat Lab General/ }).first().click();
    return page;
  };
  const join = async page => { await page.getByRole('button', { name: 'Join huddle', exact: true }).click(); await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click(); };
  const details = async page => { if (!(await page.getByRole('button', { name: 'Start screen sharing', exact: true }).count())) await page.getByRole('button', { name: 'Open huddle details', exact: true }).click(); };
  const share = async (page, owner) => { await details(page); await page.getByRole('button', { name: 'Start screen sharing', exact: true }).click(); await expect.poll(async () => (await snapshot(`sharing-${owner}`)).sessions[0]?.owner).toBe(owner); };
  const shot = async (page, name) => { const file = path.join(output, name); await page.screenshot({ path: file }); screenshots.push(file); };
  try {
    const ada = await open('ada'), margaret = await open('margaret'); let grace = await open('grace');
    instance = await (await ada.request.get(`${chatLabOrigin}/__chat-lab/instance`)).json();
    await ada.getByRole('button', { name: 'Start huddle', exact: true }).click();
    for (const page of [ada, margaret, grace]) await join(page);
    for (const page of [ada, margaret, grace]) await expect.poll(async () => (await stats(page)).filter(n => n > 1000).length).toBe(2);
    observations.push({ label: 'three-client-audio', inboundBytes: await Promise.all([ada, margaret, grace].map(stats)) });
    // A chat-only connection for the same user must not own media cleanup.
    const unrelated = await open('grace'); await unrelated.close();
    await share(grace, 'grace');
    await expect(ada.getByLabel('Grace Hopper shared screen', { exact: true })).toBeVisible();
    await expect.poll(() => ada.getByLabel('Grace Hopper shared screen', { exact: true }).evaluate(e => e.videoWidth > 0 && e.currentTime > 0)).toBe(true);
    await shot(ada, 'lifecycle-three-clients-sharing.png');
    const cases = ['tab-termination', 'browser-process-kill', 'signaling-loss', 'active-share-account-navigation'];
    for (const label of cases) {
      let processOwner;
      if (label !== cases[0]) {
        let ownerBrowser = browser;
        if (label === 'browser-process-kill') {
          processOwner = await chromium.launchServer({ channel: 'chromium', headless: true, args: captureArgs });
          ownedBrowsers.push(processOwner); ownerBrowser = await chromium.connect(processOwner.wsEndpoint());
        }
        grace = await open('grace', ownerBrowser); await join(grace); await share(grace, 'grace');
      }
      const before = await snapshot(`before-${label}`), began = Date.now(), eventOffset = events.length;
      if (label === 'tab-termination') await grace.context().close();
      else if (label === 'browser-process-kill') { const exit = new Promise(resolve => processOwner.process().once('exit', (code, signal) => resolve({ code, signal }))); processOwner.process().kill('SIGKILL'); observations.push({ label: 'owned-browser-exit', ...(await exit) }); }
      else if (label === 'signaling-loss') await grace.evaluate(() => { const socket = window.__media.sockets.at(-1); socket.close(); socket.close(); });
      else await grace.goto(`${chatLabOrigin}/chat-lab.html?actor=ada`);
      // Soft assertions preserve all three original cross-product failures in
      // one run. Remedial cleanup below is recorded and cannot turn it green.
      await expect.soft.poll(async () => {
        const value = await snapshot(label);
        return value.sessions[0]?.owner === null && value.participants.find(p => p.user_id === 'grace')?.left_at !== null;
      }, { timeout: 18_000, message: `${label}: canonical participation/share must expire` }).toBe(true);
      const after = await snapshot(`after-${label}`);
      const converged = after.sessions[0]?.owner === null && after.participants.find(p => p.user_id === 'grace')?.left_at !== null;
      observations.push({ label, converged, elapsedMs: Date.now() - began, mechanism: label === 'tab-termination' ? 'browser context closed; no explicit leave' : label === 'browser-process-kill' ? 'SIGKILL dedicated owned Chromium process while sharing' : label === 'signaling-loss' ? 'actual signaling WebSocket close twice' : 'full document actor navigation while sharing' });
      if (converged) {
        await expect.poll(() => events.slice(eventOffset).filter(e => e.actor === 'ada' && e.value.payload?.state?.screenShareOwnerUserId === null && e.value.payload?.participant?.userId === 'grace' && e.value.payload?.participant?.status === 'left').length).toBeGreaterThan(0);
        expect(after.outbox.filter(row => row.payload?.operation === 'leave_huddle').length - before.outbox.filter(row => row.payload?.operation === 'leave_huddle').length).toBe(1);
        await expect.poll(async () => (await snapshot(`${label}-published`)).outbox.filter(row => row.payload?.operation === 'leave_huddle' && row.published_at === null).length).toBe(0);
        expect(after.participants.filter(p => ['ada', 'margaret'].includes(p.user_id)).every(p => p.left_at === null)).toBe(true);
        await expect.poll(async () => (await stats(ada)).filter(n => n > 1000).length).toBe(1);
        const received = (await stats(ada))[0]; await expect.poll(async () => (await stats(ada))[0]).toBeGreaterThan(received);
        if (label === 'signaling-loss') await expect.poll(() => stopped(grace)).toBe(true);
        await share(ada, 'ada');
        await expect(margaret.getByLabel('Ada Lovelace shared screen', { exact: true })).toBeVisible();
        if (label === 'tab-termination') {
          // Renew a real, private admission through the original idempotent
          // Join. The extra same-user signaling connection owns no client
          // claims; the existing sharing peer must retain its canonical state.
          const input = joinRequests.get(ada), credential = chatLab.actors.find(actor => actor.id === 'ada').credential;
          const response = await ada.request.post(`${chatLabOrigin}/api/chat/huddles/${input.huddleSessionId}/join`, {
            headers: { authorization: `Bearer ${credential}`, 'idempotency-key': input.idempotencyKey }, data: input,
          });
          expect(response.status()).toBe(200);
          const descriptor = (await response.json()).mediaJoin.descriptor;
          const owned = await snapshot('same-user-sharing-survivor-before');
          await ada.evaluate(async descriptor => {
            const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/__chat-lab/media`);
            await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Extra admission timed out')), 5000);
              socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token: JSON.parse(descriptor).token }));
              socket.onmessage = event => { if (JSON.parse(event.data).type === 'welcome') { clearTimeout(timer); resolve(); } };
              socket.onerror = () => { clearTimeout(timer); reject(new Error('Extra admission failed')); };
            });
            socket.close(); socket.close();
          }, descriptor);
          // Wait beyond normal last-peer cleanup bound to detect an erroneous
          // delayed eviction; actual RTP and decoded video must keep advancing.
          const received = (await stats(margaret))[0], beforeTime = await margaret.getByLabel('Ada Lovelace shared screen', { exact: true }).evaluate(video => video.currentTime);
          await ada.waitForTimeout(6500);
          const retained = await snapshot('same-user-sharing-survivor-after');
          expect(retained.sessions[0].owner).toBe('ada');
          expect(retained.participants.find(p => p.user_id === 'ada')).toEqual(owned.participants.find(p => p.user_id === 'ada'));
          expect((await stats(margaret))[0]).toBeGreaterThan(received);
          expect(await margaret.getByLabel('Ada Lovelace shared screen', { exact: true }).evaluate(video => video.currentTime)).toBeGreaterThan(beforeTime);
          observations.push({ label: 'same-user-sharing-survivor', duplicateSameUserSocketClosed: true, canonicalOwner: 'ada', continuedDecodedVideo: true, inboundBytes: await stats(margaret) });
        }
        await ada.getByRole('button', { name: 'Stop screen sharing', exact: true }).click();
        await ada.keyboard.press('Escape');
      } else {
        const credential = chatLab.actors.find(actor => actor.id === 'grace').credential;
        const id = after.sessions[0].id, key = `qa-remedial-${label}`;
        const response = await ada.request.post(`${chatLabOrigin}/api/chat/huddles/${id}/leave`, { headers: { authorization: `Bearer ${credential}`, 'idempotency-key': key }, data: { operation: 'leave_huddle', huddleSessionId: id, idempotencyKey: key } });
        expect(response.status()).toBe(200); observations.push({ label: `${label}-remedial-cleanup`, acceptance: false, status: response.status() });
      }
      if (!grace.isClosed()) await grace.context().close().catch(() => {});
    }
    // Canonical permission revocation while actively sharing uses the owned
    // schema, not an injected authorizer decision. Remaining users keep RTP.
    grace = await open('grace'); await join(grace); await share(grace, 'grace');
    const session = (await chatLab.harness.pool.query("SELECT tenant_id,conversation_id FROM chat_huddle_sessions WHERE status='active'")).rows[0];
    await chatLab.harness.pool.query("UPDATE chat_conversation_members SET state='removed', updated_at=clock_timestamp() WHERE tenant_id=$1 AND conversation_id=$2 AND user_id='grace'", [session.tenant_id, session.conversation_id]);
    await expect.poll(() => stopped(grace), { timeout: 18_000 }).toBe(true);
    await expect.soft.poll(async () => { const value = await snapshot('permission-revocation'); return value.sessions[0].owner === null && value.participants.find(p => p.user_id === 'grace').left_at !== null; }, { timeout: 18_000 }).toBe(true);
    const id = (await snapshot('revoked-final')).sessions[0].id;
    const credential = chatLab.actors.find(actor => actor.id === 'grace').credential;
    const denied = await ada.request.post(`${chatLabOrigin}/api/chat/huddles/${id}/join`, { headers: { authorization: `Bearer ${credential}`, 'idempotency-key': 'qa-revoked-rejoin' }, data: { operation: 'join_huddle', huddleSessionId: id, idempotencyKey: 'qa-revoked-rejoin' } });
    expect(denied.status()).toBe(403);
    observations.push({ label: 'canonical-permission-revocation', boundary: 'isolated PostgreSQL member removal', captureStopped: true, deniedRejoinStatus: denied.status() });
    if ((await snapshot('revoked-share-availability')).sessions[0].owner === null) {
      await share(ada, 'ada'); await expect(margaret.getByLabel('Ada Lovelace shared screen', { exact: true })).toBeVisible();
      const received = (await stats(margaret))[0]; await expect.poll(async () => (await stats(margaret))[0]).toBeGreaterThan(received);
      await ada.getByRole('button', { name: 'Stop screen sharing', exact: true }).click(); await ada.keyboard.press('Escape');
    }
    await shot(ada, 'lifecycle-after-cleanup.png');
    await details(ada); await ada.getByRole('button', { name: 'End huddle', exact: true }).click();
    for (const page of [ada, margaret, grace]) await expect.poll(() => stopped(page)).toBe(true);
    await snapshot('ended');
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    for (const owned of ownedBrowsers) await owned.close().catch(() => {});
    await writeFile(path.join(output, 'lifecycle.json'), JSON.stringify({ instance, observations, sql, events, errors, screenshots, status: info.status, capture: 'synthetic Chromium media; real transport; no native/TURN acceptance' }, null, 2));
  }
});
