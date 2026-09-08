import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';

const origin = process.env.FLUTTER_CHAT_LAB_ORIGIN;
test.skip(!origin, 'Requires the accepted reply-styles campaign backend');
if (origin) test.use({ chatLabOrigin: origin });
const call = (page, operation) => page.evaluate(async (operation) => JSON.parse(
  await window.handrailBackendLab(JSON.stringify({ operation })),
), operation);
const ready = (page) => expect.poll(async () => {
  const state = await call(page, 'status');
  return state.realtime === 'connected' && state.hydratedTimelineIds.includes(state.selectedConversationId);
}).toBe(true);
const name = 'QA 298e20b4 Launch date decision';

for (const actor of ['alice', 'bob']) {
  test(`Flutter ${actor} opens canonical named thread from root, discovery and reconnect`, async ({ page, chatLabOrigin }, info) => {
    await page.setViewportSize(actor === 'bob' ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    const reads = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (r) => {
      if (r.url().includes('/conversations/e35ac80a-52f1-472a-b8f0-f35aa7eb9ef6')) reads.push({ url: r.url(), status: r.status() });
    });
    const assertThread = async () => {
      await expect(page.getByRole('banner', { name, exact: true })).toBeVisible();
      await expect(page.getByRole('group', { name: /^Message 1 from bob QA 298e20b4 retained thread history/ })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Write a message', exact: true }).last()).toBeEnabled();
      await page.getByRole('button', { name: 'Thread subscriptions', exact: true }).click();
      const retry = page.getByRole('menuitem', { name: 'Retry loading subscriptions', exact: true });
      if (await retry.count()) {
        await retry.click();
        await expect(page.getByRole('menu', { name: 'Popup menu' })).toBeHidden();
        await expect.poll(async () => page.locator('body').ariaSnapshot()).not.toContain('Thread preferences unavailable.');
        await page.getByRole('button', { name: 'Thread subscriptions', exact: true }).click();
      }
      await expect(page.getByRole('menuitem', { name: /^(Join|Leave|Follow|Unfollow)$/ })).toBeEnabled();
      await expect(page.getByRole('menuitem', { name: 'Notifications: all', exact: true })).toBeEnabled();
      await page.mouse.click(16, 24);
      await expect(page.getByRole('menu', { name: 'Popup menu' })).toBeHidden();
      await expect.poll(async () => (await call(page, 'status')).realtime).toBe('connected');
      await expect.poll(async () => page.locator('body').ariaSnapshot()).not.toMatch(/access denied|could not be loaded|preferences unavailable|controls are unavailable/);
    };
    try {
      await page.goto(new URL(`/__flutter-chat-lab/?actor=${actor}`, chatLabOrigin).href);
      await page.waitForFunction(() => typeof window.handrailBackendLab === 'function');
      await page.locator('flt-semantics-placeholder').evaluate((e) => e.click());
      await expect.poll(async () => (await call(page, 'status')).realtime).toBe('connected');
      await ready(page);
      await expect.poll(async () => {
        if (await page.getByRole('group', { name: /^Message 1 from alice Which launch date/ }).count()) return true;
        await page.mouse.move(page.viewportSize().width > 640 ? 450 : 150, 350);
        await page.mouse.wheel(0, -600);
        return false;
      }).toBe(true);
      await page.getByRole('group', { name: /^Message 1 from alice Which launch date/ }).getByRole('button', { name: 'Open Thread', exact: true }).click();
      await assertThread();
      await page.getByRole('button', { name: 'Close panel', exact: true }).last().click();
      await page.getByRole('button', { name: 'Browse channel threads', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await assertThread();
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await expect.poll(async () => (await call(page, 'status')).realtime).toBe('connected');
      await ready(page);
      if (!(await page.getByRole('banner', { name, exact: true }).count())) {
        await expect.poll(async () => {
          if (await page.getByRole('group', { name: /^Message 1 from alice Which launch date/ }).count()) return true;
          await page.mouse.move(page.viewportSize().width > 640 ? 450 : 150, 350);
          await page.mouse.wheel(0, -600);
          return false;
        }).toBe(true);
        await page.getByRole('group', { name: /^Message 1 from alice Which launch date/ }).getByRole('button', { name: 'Open Thread', exact: true }).click();
      }
      await assertThread();
      const state = await call(page, 'status');
      expect(state.diagnostics).not.toContain('conversation.detail:response_malformed');
      expect(state.diagnostics).not.toContain('snapshot_hydration_failed');
      expect(state.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
      expect(reads.some((r) => r.status === 200 && new URL(r.url).pathname.endsWith('/messages'))).toBe(true);
    } finally {
      const path = info.outputPath('named-thread-evidence.json');
      await writeFile(path, JSON.stringify({ actor, reads, errors, semantics: await page.locator('body').ariaSnapshot(), exported: await call(page, 'export').catch((error) => ({ error: error.message })) }, null, 2));
      await info.attach('named-thread-evidence', { path, contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath('named-thread.png') });
    }
  });
}

test('Flutter Bob creates a named thread and can compose, follow and manage it', async ({ page, chatLabOrigin }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = `Flutter named-thread regression ${Date.now()}`;
  const writes = [];
  const events = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    try { const frame = JSON.parse(String(payload)); if (frame.type === 'thread.created') events.push(frame); } catch {}
  }));
  page.on('response', async (response) => {
    if (response.request().method() !== 'GET' && response.url().includes('/api/chat/')) {
      writes.push({ path: new URL(response.url()).pathname, status: response.status(), request: response.request().postDataJSON(), response: await response.json().catch(() => null) });
    }
  });
  try {
    await page.goto(new URL('/__flutter-chat-lab/?actor=bob', chatLabOrigin).href);
    await page.waitForFunction(() => typeof window.handrailBackendLab === 'function');
    await page.locator('flt-semantics-placeholder').evaluate((e) => e.click());
    await expect.poll(async () => (await call(page, 'status')).realtime).toBe('connected');
    await ready(page);
    const input = () => page.getByRole('textbox', { name: 'Write a message', exact: true }).last();
    // Keep the campaign's existing roots/history intact; create one clearly
    // labelled QA root through the actual composer for this creation regression.
    await input().click();
    await input().fill('');
    await input().pressSequentially(title);
    await expect(input()).toHaveValue(title);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const root = page.getByRole('group', { name: new RegExp(`^Message \\d+ from bob ${title}`) });
    await root.getByRole('button', { name: 'Create Thread', exact: true }).click();
    await page.getByRole('textbox', { name: 'Thread name', exact: true }).fill(title);
    await page.getByRole('button', { name: 'Create Thread', exact: true }).last().click();
    await expect(page.getByRole('banner', { name: title, exact: true })).toBeVisible();
    await expect(input()).toBeEnabled();
    await input().click();
    await input().fill('');
    await input().pressSequentially('Friday');
    await expect(input()).toHaveValue('Friday');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('group', { name: /^Message 1 from bob Friday/ })).toBeVisible();
    const subscription = async (label) => {
      await page.getByRole('button', { name: 'Thread subscriptions', exact: true }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await expect(page.getByRole('menu', { name: 'Popup menu' })).toBeHidden();
      await expect.poll(async () => page.locator('body').ariaSnapshot()).toContain('Thread subscription saved.');
    };
    // Posting auto-follows; manually leave and rejoin using hydrated revisions.
    await subscription('Leave');
    await subscription('Join');
    const lifecycle = async (label) => {
      await page.getByRole('button', { name: 'Shared thread controls', exact: true }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await expect(page.getByRole('menu', { name: 'Popup menu' })).toBeHidden();
    };
    await lifecycle('Close shared thread');
    await expect.poll(async () => page.locator('body').ariaSnapshot()).toContain('Thread closed.');
    await lifecycle('Reopen thread');
    await expect.poll(async () => page.locator('body').ariaSnapshot()).not.toContain('Thread closed.');
    await expect(input()).toBeEnabled();
    await lifecycle('Lock and close thread');
    await expect.poll(async () => page.locator('body').ariaSnapshot()).toContain('Thread locked and closed.');
    await lifecycle('Unlock thread (leaves closed)');
    await lifecycle('Reopen thread');
    await expect(input()).toBeEnabled();
    expect(writes.filter((r) => r.path.endsWith('/lifecycle'))).toHaveLength(5);
    expect(writes.filter((r) => !r.path.endsWith('/draft')).every((r) => r.status >= 200 && r.status < 300)).toBe(true);
    expect((await call(page, 'status')).provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
  } finally {
    const path = info.outputPath('created-thread-evidence.json');
    await writeFile(path, JSON.stringify({ title, writes, events, semantics: await page.locator('body').ariaSnapshot(), exported: await call(page, 'export').catch((e) => ({ error: e.message })) }, null, 2));
    await info.attach('created-thread-evidence', { path, contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('created-thread.png') });
  }
});
