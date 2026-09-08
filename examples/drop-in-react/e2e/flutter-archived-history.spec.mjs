import { writeFile } from 'node:fs/promises';
import { expect, test } from './chat-lab.fixture.mjs';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';

test.use({ chatLabSeedProfile: 'reply-styles' });

test('Alice retains archived Flutter history after a late realtime denial', async ({ chatLab, page }, info) => {
  const control = await page.request.post(`${chatLab.origin}/__chat-lab/reply-styles`, {
    data: { operation: 'create_archived_thread' },
  });
  expect(control.ok()).toBe(true);
  const fixture = await control.json();
  const detailPath = `/api/chat/conversations/${fixture.threadId}`;
  const responses = [];
  const errors = [];
  let releaseDenial;
  let status;
  const subscriptionDenials = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith(detailPath)) responses.push({
      path, method: response.request().method(), status: response.status(),
    });
  });
  // Hold the real server rejection until authorized HTTP history is rendered.
  // This selects the failing response order without changing access policy.
  await page.routeWebSocket('**/api/chat/**', socket => {
    const server = socket.connectToServer();
    const threadRequests = new Set();
    socket.onMessage(message => {
      const frame = JSON.parse(message.toString());
      if (frame.type === 'chat.subscribe' && frame.streamId === fixture.threadId) {
        threadRequests.add(frame.requestId);
      }
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(message.toString());
      if (frame.type === 'chat.subscription.rejected' && threadRequests.has(frame.requestId)) {
        expect(frame.code).toBe('access_denied');
        subscriptionDenials.push(frame);
        releaseDenial = () => socket.send(message);
      } else socket.send(message);
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(`${chatLab.origin}/__flutter-chat-lab/?actor=alice`);
    await page.waitForFunction(() => typeof window.handrailBackendLab === 'function');
    await page.locator('flt-semantics-placeholder').evaluate(element => element.click());
    const root = page.getByRole('group', { name: /^Message \d+ from alice Archived launch notes$/ });
    await root.getByRole('button', { name: 'Open Thread', exact: true }).click();
    const history = page.getByRole('group', { name: /^Message 1 from alice Retained archived launch history$/ });
    await expect(history).toBeVisible();
    await expect.poll(() => typeof releaseDenial).toBe('function');
    const historyReads = () => responses.filter(response => response.path === `${detailPath}/messages` && response.status === 200).length;
    const readsBeforeDenial = historyReads();
    releaseDenial();
    await expect.poll(historyReads).toBeGreaterThan(readsBeforeDenial);
    // Let automatic cursor writes and their bounded retry settle as well.
    await expect.poll(() => responses.filter(response => response.path.endsWith('/read-cursor') && response.status === 403).length).toBeGreaterThanOrEqual(2);
    await expect(history).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message composer disabled.', exact: true })).toBeDisabled();
    expect(await page.locator('body').ariaSnapshot()).not.toContain('Conversation access revoked');
    status = await page.evaluate(async () => JSON.parse(await window.handrailBackendLab(JSON.stringify({ operation: 'status' }))));
    expect(status.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
    expect(errors).toEqual([]);
  } finally {
    await page.screenshot({ path: info.outputPath('archived-thread-390x844.png') });
    await writeFile(info.outputPath('archived-history.json'), JSON.stringify({
      backendKind: chatLab.harness.backendKind, fixture, responses, subscriptionDenials, errors,
      provenance: status?.provenance,
      semantics: await page.locator('body').ariaSnapshot(),
    }, null, 2));
  }
});
