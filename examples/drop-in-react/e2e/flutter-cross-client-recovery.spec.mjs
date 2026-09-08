import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';

// Only the dedicated entry point may supply this test's disposable runtime.
test.use({ chatLabSeedProfile: 'reply-styles', chatLabFlutterAcceptance: true });
const call = (page, operation) => page.evaluate(async operation =>
  JSON.parse(await window.handrailBackendLab(JSON.stringify({ operation }))), operation);

test('Flutter recovers an open thread during React Bob updates without manual retries', async ({ page, browser, chatLabOrigin, chatLab }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const flutter = await context.newPage();
  const name = `QA thread recovery ${Date.now()}`;
  const errors = [];
  const navigations = [];
  const screenshots = [info.outputPath('recovered-thread-390x844.png'), info.outputPath('recovery-390x844.png')];
  let provenance, instance, thread;
  // Flutter uses same-document history updates for panels; count document loads only.
  flutter.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === flutter.mainFrame()) navigations.push(request.url());
  });
  flutter.on('pageerror', error => errors.push(error.message));
  try {
    await flutter.goto(`${chatLabOrigin}/__flutter-chat-lab/?actor=bob`);
    await flutter.waitForFunction(() => typeof window.handrailBackendLab === 'function');
    await flutter.locator('flt-semantics-placeholder').evaluate(e => e.click());
    await expect.poll(async () => (await call(flutter, 'status')).realtime).toBe('connected');
    provenance = (await call(flutter, 'status')).provenance;
    expect(provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
    instance = await (await page.request.get(`${chatLabOrigin}/__chat-lab/instance`)).json();
    expect(instance.instanceId).toBe(chatLab.instanceId);
    expect(instance.seedProfile).toBe('reply-styles');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${chatLabOrigin}/chat-lab.html?actor=bob`);
    await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /^Launch planning/ }).click();
    const settings = page.locator('.chat-lab__reply-settings');
    await settings.locator('summary').click();
    await settings.getByRole('combobox', { name: 'Reply and thread style', exact: true }).selectOption('discord');
    await expect(settings).toContainText('Effective style: Discord-style');
    await settings.locator('summary').click();
    const composer = page.getByLabel('Conversation composer', { exact: true });
    await composer.getByRole('textbox').fill(name);
    await composer.getByRole('button', { name: 'Send message', exact: true }).click();
    const root = page.getByRole('region', { name: 'Conversation timeline', exact: true })
      .getByRole('article').filter({ hasText: name }).first();
    await root.hover();
    await root.getByRole('button', { name: 'Create Thread', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create Thread', exact: true });
    await creation.getByLabel('Thread name').fill(name);
    await creation.getByRole('button', { name: 'Create Thread', exact: true }).click();
    const panel = page.getByRole('complementary', { name, exact: true });
    const input = panel.getByRole('textbox');
    await input.fill(`${name} history`);
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    const flutterRoot = flutter.getByRole('group', { name: new RegExp(`^Message \\d+ from bob ${name}$`) });
    await flutterRoot.getByRole('button', { name: 'Open Thread', exact: true }).click();
    await expect(flutter.getByRole('banner', { name, exact: true })).toBeVisible();
    await expect(flutter.getByRole('group', { name: new RegExp(`^Message 1 from bob ${name} history`) })).toBeVisible();
    thread = (await chatLab.harness.pool.query(
      "SELECT id, root_message_id FROM chat_conversations WHERE type='thread' AND name=$1", [name],
    )).rows[0];
    expect(thread?.id).toBeTruthy();
    await panel.getByRole('button', { name: /^Thread notification preferences:/ }).click();
    const preferences = panel.getByRole('dialog', { name: 'Notification preferences', exact: true });
    await preferences.getByRole('combobox').selectOption('mentions');
    await preferences.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(preferences.getByRole('status')).toContainText('Notification preferences saved');
    await panel.getByRole('button', { name: /^Thread notification preferences:/ }).click();

    await panel.getByRole('button', { name: 'Leave', exact: true }).click();
    const history = panel.getByRole('article').filter({ hasText: `${name} history` }).first();
    await history.hover();
    await history.getByRole('button', { name: 'Reply', exact: true }).click();
    await input.fill(`${name} inline after Leave`);
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await panel.getByRole('button', { name: 'Close thread', exact: true }).click();
    await expect.poll(() => flutter.locator('body').ariaSnapshot()).toContain('Thread closed.');
    await panel.getByRole('button', { name: 'Reopen thread', exact: true }).click();
    await expect.poll(() => flutter.locator('body').ariaSnapshot()).not.toContain('Thread closed.');
    await panel.getByRole('button', { name: 'Join', exact: true }).click();
    await panel.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Join', exact: true })).toBeEnabled();
    await composer.getByRole('textbox').fill(`${name} retained channel draft`);
    await expect(flutter.getByRole('banner', { name, exact: true })).toBeVisible();
    await expect(flutter.getByRole('group', { name: new RegExp(`^Message 1 from bob ${name} history`) })).toBeVisible();
    await expect(flutter.getByRole('group', { name: new RegExp(`^Message 2 from bob.*${name} inline after Leave`) })).toBeVisible();
    await expect(flutter.getByRole('textbox', { name: 'Write a message', exact: true }).last()).toBeEnabled();
    await expect(flutter.getByRole('button', { name: 'Shared thread controls', exact: true })).toBeEnabled();
    await expect.poll(() => flutter.locator('body').ariaSnapshot()).toContain('Not following. Notifications: mentions.');
    await flutter.screenshot({ path: screenshots[0] });
    await flutter.getByRole('button', { name: 'Thread subscriptions', exact: true }).click();
    await expect(flutter.getByRole('menuitem', { name: 'Join', exact: true })).toBeEnabled();
    await expect(flutter.getByRole('menuitem', { name: 'Notifications: all', exact: true })).toBeEnabled();
    expect(await flutter.getByRole('menuitem', { name: 'Retry loading subscriptions', exact: true }).count()).toBe(0);
    await flutter.keyboard.press('Escape');
    const flutterComposer = flutter.getByRole('textbox', { name: 'Write a message', exact: true }).last();
    await flutterComposer.click();
    await flutterComposer.fill('');
    await flutterComposer.pressSequentially(`${name} composed after recovery`);
    await flutter.getByRole('button', { name: 'Send message', exact: true }).last().click();
    await expect(panel.getByRole('article').filter({ hasText: `${name} composed after recovery` })).toBeVisible();

    const status = await call(flutter, 'status');
    expect(status.provenance).toEqual(provenance);
    expect(status.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
    expect(navigations).toHaveLength(1);
    expect(flutter.viewportSize()).toEqual({ width: 390, height: 844 });
    expect(status.diagnostics).not.toContain('snapshot_hydration_failed');
    expect(errors).toEqual([]);
    await composer.getByRole('textbox').clear();
  } finally {
    try {
      const evidence = { name, thread, errors, navigations, provenance, instance, screenshots,
        viewport: flutter.viewportSize(),
        semantics: await flutter.locator('body').ariaSnapshot().catch(error => error.message),
        exported: await call(flutter, 'export').catch(error => ({ error: error.message })) };
      const evidencePath = info.outputPath('recovery.json');
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      await writeFile(path.join(process.env.CHAT_LAB_RECOVERY_ACCEPTANCE_DIR, 'recovery.json'), JSON.stringify(evidence, null, 2));
      await info.attach('cross-client-recovery', { path: evidencePath, contentType: 'application/json' });
      await flutter.screenshot({ path: screenshots[1] });
    } finally {
      await context.close();
    }
  }
});
