import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { screenDenialAndConflict, canonicalRevocation, flutterAccountRoundTrip } from './huddle-media-checks.mjs';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';

// Synthetic microphone/capture sources, actual browser WebRTC/ICE/RTP. This is
// not physical-device, native Flutter, TURN or external-provider acceptance.
test.use({ chatLabFlutterAcceptance: true, channel: 'chromium', launchOptions: { args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen',
] } });
const status = page => page.evaluate(async () => JSON.parse(await window.handrailBackendLab('{"operation":"status"}')));
const stats = page => page.evaluate(async () => Promise.all(window.__media.pcs
  .filter(pc => pc.connectionState === 'connected').map(async pc => [...(await pc.getStats()).values()]
    .filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((n, s) => n + (s.bytesReceived || 0), 0))));
const stopped = page => page.evaluate(() => window.__media.pcs.every(pc => pc.connectionState === 'closed') &&
  window.__media.tracks.every(track => track.readyState === 'ended'));

test('React and Flutter exchange media with canonical ownership, recovery and cleanup', async ({ browser, chatLab, chatLabOrigin }, info) => {
  const contexts = [], pages = [], observations = [], sql = [], errors = [], screenshots = [], events = [], http = [];
  let provenance, instance;
  const checkpoint = async label => {
    const sessions = (await chatLab.harness.pool.query('SELECT status, active_screen_share_owner_user_id AS screen_share_owner_user_id FROM chat_huddle_sessions')).rows;
    const participants = (await chatLab.harness.pool.query('SELECT user_id, left_at IS NULL AS joined FROM chat_huddle_participants ORDER BY user_id')).rows;
    sql.push({ label, sessions, participants });
    return { sessions, participants };
  };
  try {
    for (const [index, actor] of ['ada', 'grace', 'margaret'].entries()) {
      const context = await browser.newContext({ permissions: ['microphone'], viewport: index === 1 ? { width: 430, height: 932 } : { width: 1280, height: 900 } });
      contexts.push(context);
      await context.addInitScript(() => {
        window.__media = { pcs: [], tracks: [], sockets: [] };
        for (const method of ['getUserMedia', 'getDisplayMedia']) {
          const original = navigator.mediaDevices[method].bind(navigator.mediaDevices);
          navigator.mediaDevices[method] = async (...args) => {
            const stream = await original(...args); window.__media.tracks.push(...stream.getTracks()); return stream;
          };
        }
        const Peer = window.RTCPeerConnection, Socket = window.WebSocket;
        window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.__media.pcs.push(this); } };
        window.WebSocket = class extends Socket { constructor(...args) { super(...args); if (String(args[0]).includes('/__chat-lab/media')) window.__media.sockets.push(this); } };
      });
      const page = await context.newPage(); pages.push(page);
      page.on('response', response => {
        const pathname = new URL(response.url()).pathname;
        if (pathname.includes('chat-lab-flutter-media') || /\/api\/chat\/(?:conversations\/[^/]+\/huddle|huddles\/[^/]+\/(?:join|leave|screen-share|end))$/.test(pathname))
          http.push({ actor, path: pathname, method: response.request().method(), status: response.status() });
        if (actor === 'grace' && /\/huddles\/[^/]+\/join$/.test(pathname)) {
          void response.json().then(value => http.push({ actor, kind: 'public-join-result', state: value.state, outcome: value.outcome, reconciliationStatus: value.reconciliationStatus })).catch(() => {});
        }
      });
      page.on('pageerror', error => errors.push({ actor, message: error.message }));
      page.on('websocket', socket => {
        if (!socket.url().includes('/api/chat/_realtime')) return;
        socket.on('framereceived', frame => {
          try { const value = JSON.parse(String(frame.payload)); if (value.type === 'huddle.updated') events.push({ actor, value }); } catch {}
        });
      });
      await page.goto(index === 1 ? `${chatLabOrigin}/__flutter-chat-lab/?actor=${actor}` : `${chatLabOrigin}/chat-lab.html?actor=${actor}`);
      if (index === 1) {
        await page.waitForFunction(() => typeof window.handrailBackendLab === 'function');
        await page.locator('flt-semantics-placeholder').evaluate(e => e.click());
        await expect.poll(async () => (await status(page)).realtime).toBe('connected');
        await expect.poll(async () => { const value = await status(page); return value.huddle?.hydration === 'ready' && value.hydratedTimelineIds.includes(value.selectedConversationId) && value.realtime === 'connected'; }).toBe(true);
        provenance = (await status(page)).provenance;
        expect(provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
        await page.getByRole('button', { name: /Huddle · Chat Lab General/ }).click();
      } else {
        await expect(page.locator('.chat-lab__realtime-announcement')).toHaveAttribute('data-realtime-state', 'connected');
        await page.getByRole('button', { name: /Chat Lab General/ }).first().click();
      }
    }
    const [react, flutter, third] = pages;
    instance = await (await react.request.get(`${chatLabOrigin}/__chat-lab/instance`)).json();
    expect(instance.instanceId).toBe(chatLab.instanceId);
    await react.getByRole('button', { name: 'Start huddle', exact: true }).click();
    for (const [index, page] of pages.entries()) { observations.push({ label: 'joining', client: index }); await page.getByRole('button', { name: 'Join huddle', exact: true }).click(); await expect(page.getByRole('button', { name: 'Leave huddle', exact: true })).toBeVisible(); }
    // Boundary-injected denial; later operations use real browser capture.
    await flutter.evaluate(() => {
      window.__media.getUserMedia = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => { window.__media.deniedCalls = (window.__media.deniedCalls || 0) + 1; throw new DOMException('Denied', 'NotAllowedError'); };
    });
    await flutter.getByLabel('Unmute microphone', { exact: true }).click();
    await expect(flutter.getByLabel('Dialog', { exact: true }).getByText(/Microphone permission was denied/)).toBeVisible();
    observations.push({ label: 'microphone-denied', captureCalls: await flutter.evaluate(() => window.__media.deniedCalls), uiMessageVisible: true, permission: 'boundary-injected NotAllowedError' });
    await flutter.evaluate(() => { navigator.mediaDevices.getUserMedia = window.__media.getUserMedia; });
    for (const page of pages) await page.getByLabel('Unmute microphone', { exact: true }).click();
    for (const page of pages) await expect.poll(async () => { const values = await stats(page); return values.length === 2 && values.every(n => n > 1000); }).toBe(true);
    observations.push({ label: 'three-client-audio', inboundBytes: await Promise.all(pages.map(stats)), capture: 'synthetic browser devices', transport: 'real ICE/DTLS/SRTP peer connections' });
    expect((await checkpoint('joined')).participants).toEqual(['ada', 'grace', 'margaret'].map(user_id => ({ user_id, joined: true })));
    for (const [index, page] of pages.slice(0, 2).entries()) {
      const file = info.outputPath(index ? 'flutter-media-430x932.png' : 'react-media-1280x900.png');
      await page.screenshot({ path: file }); screenshots.push(file);
    }
    await screenDenialAndConflict({ flutter, react, checkpoint, expect, observations });
    // Browser capture is prepared before canonical ownership and transported.
    await flutter.getByLabel('Start screen sharing', { exact: true }).click();
    await expect(react.getByLabel('Grace Hopper shared screen', { exact: true })).toBeVisible();
    await expect.poll(() => react.getByLabel('Grace Hopper shared screen', { exact: true }).evaluate(e => e.videoWidth > 0 && e.currentTime > 0)).toBe(true);
    expect((await checkpoint('flutter-sharing')).sessions[0].screen_share_owner_user_id).toBe('grace');
    // Real track with an injected ended event models browser revocation. stop()
    // alone deliberately does not fire ended in the browser specification.
    await flutter.evaluate(() => { const track = window.__media.tracks.filter(t => t.kind === 'video' && t.readyState === 'live').at(-1); track.stop(); track.dispatchEvent(new Event('ended')); });
    await expect.poll(async () => (await checkpoint('share-ended')).sessions[0].screen_share_owner_user_id).toBeNull();
    await expect(react.getByLabel('Grace Hopper shared screen', { exact: true })).toHaveCount(0);
    observations.push({ label: 'flutter-screen-transport-and-release', remoteVideoDecoded: true, canonicalOwnerReleased: true, revocation: 'real track.stop plus injected ended event' });
    await flutter.getByLabel('Mute microphone', { exact: true }).click();
    await expect.poll(() => flutter.evaluate(() => window.__media.tracks.filter(t => t.kind === 'audio' && t.readyState === 'live').every(t => !t.enabled))).toBe(true);
    await flutter.getByLabel('Unmute microphone', { exact: true }).click();
    await flutter.evaluate(() => { const track = window.__media.tracks.filter(t => t.kind === 'audio' && t.readyState === 'live').at(-1); track.stop(); track.dispatchEvent(new Event('ended')); });
    await expect(flutter.getByLabel('Unmute microphone', { exact: true })).toBeEnabled();
    await flutter.getByLabel('Unmute microphone', { exact: true }).click();
    observations.push({ label: 'microphone-mute-revoke-recapture', capture: 'real synthetic-device track', revocation: 'track.stop plus injected ended event' });
    await flutter.evaluate(() => window.__media.sockets.at(-1).close());
    await expect.poll(() => stopped(flutter)).toBe(true);
    await flutter.getByRole('button', { name: 'Leave huddle', exact: true }).click();
    await expect.poll(async () => (await checkpoint('left')).participants.find(p => p.user_id === 'grace').joined).toBe(false);
    await flutter.getByRole('button', { name: 'Join huddle', exact: true }).click();
    await flutter.getByLabel('Unmute microphone', { exact: true }).click();
    await expect.poll(async () => { const values = await stats(flutter); return values.length === 2 && values.every(n => n > 1000); }).toBe(true);
    observations.push({ label: 'rejoined-after-signaling-close', inboundBytes: await stats(flutter) });
    await flutterAccountRoundTrip({ flutter, react, status, stats, checkpoint, expect, observations });
    await canonicalRevocation({ flutter, react, chatLab, chatLabOrigin, checkpoint, stopped, expect, observations });
    await react.getByRole('button', { name: 'Open huddle details', exact: true }).click();
    await react.getByRole('button', { name: 'End huddle', exact: true }).click();
    for (const page of pages) await expect.poll(() => stopped(page)).toBe(true);
    await expect.poll(async () => (await checkpoint('ended')).sessions[0].status).toBe('ended');
    const file = info.outputPath('flutter-ended-430x932.png'); await flutter.screenshot({ path: file }); screenshots.push(file);
    expect(errors).toEqual([]);
  } finally {
    const mediaPhase = pages[1] ? await pages[1].locator('[data-media-phase]').evaluate(e => ({ phase: e.getAttribute('data-media-phase'), session: e.getAttribute('data-session-status'), controller: e.getAttribute('data-controller-media'), failure: e.getAttribute('data-session-failure') }), undefined, { timeout: 1000 }).catch(() => null) : null;
    const feedbackSemantics = pages[1] ? await pages[1].locator('[aria-label]').evaluateAll(nodes => nodes.map(e => e.getAttribute('aria-label')).filter(label => /permission.*denied/i.test(label))).catch(() => []) : [];
    const evidence = { feedbackSemantics, mediaPhase, instance, provenance, observations, sql, errors, screenshots, events, http,
      finalFlutterState: pages[1] ? await Promise.race([status(pages[1]).catch(() => null), new Promise(resolve => setTimeout(() => resolve({ unavailable: 'page evaluation timed out' }), 2000))]) : null,
      limitations: ['synthetic capture, not physical microphones', 'injected denial/ended notifications', 'no native devices, TURN or external provider delivery'] };
    await writeFile(path.join(process.env.CHAT_LAB_RECOVERY_ACCEPTANCE_DIR, 'media.json'), JSON.stringify(evidence, null, 2));
    for (const context of contexts) await context.close();
  }
});
