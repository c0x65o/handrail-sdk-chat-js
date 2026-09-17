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
  const lifecycleRequests = [], lifecycleResponses = [], lifecycleEvents = [], lifecycleSql = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/lifecycle')) {
      lifecycleRequests.push({ url: request.url(), body: request.postDataJSON() });
    }
  });
  for (const [client, target] of [['react', page], ['flutter', flutter]]) {
    target.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const event = JSON.parse(String(frame.payload));
        if (event.type === 'thread.lifecycle.updated') lifecycleEvents.push({ client, event });
      } catch { /* Non-JSON transport frames are not lifecycle receipts. */ }
    }));
  }
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
    const lifecycleResponse = intent => page.waitForResponse(response =>
      response.request().method() === 'PATCH' &&
      new URL(response.url()).pathname === `/api/chat/conversations/${thread.id}/lifecycle` &&
      response.request().postDataJSON()?.intent === intent);
    const [closed] = await Promise.all([
      lifecycleResponse('close'),
      panel.getByRole('button', { name: 'Close thread', exact: true }).click(),
    ]);
    expect(closed.status()).toBe(200);
    lifecycleResponses.push(await closed.json());
    await expect(panel.getByText('Thread closed.', { exact: true })).toBeVisible();
    await expect.poll(() => flutter.locator('body').ariaSnapshot()).toContain('Thread closed.');
    const closedRow = (await chatLab.harness.pool.query(
      'SELECT lifecycle_revision, closed_at, closed_by_user_id, locked FROM chat_conversations WHERE id=$1', [thread.id],
    )).rows[0];
    expect(closedRow).toMatchObject({ lifecycle_revision: '2', closed_by_user_id: 'bob', locked: false });
    expect(closedRow.closed_at).not.toBeNull();
    lifecycleSql.push({ checkpoint: 'closed', ...closedRow });
    await page.screenshot({ path: info.outputPath('react-closed-1440x1000.png') });
    await flutter.screenshot({ path: info.outputPath('flutter-closed-390x844.png') });
    const [reopened] = await Promise.all([
      lifecycleResponse('reopen'),
      panel.getByRole('button', { name: 'Reopen thread', exact: true }).click(),
    ]);
    expect(reopened.status()).toBe(200);
    lifecycleResponses.push(await reopened.json());
    await expect(panel.getByText('Thread open.', { exact: true })).toBeVisible();
    await expect.poll(() => flutter.locator('body').ariaSnapshot()).not.toContain('Thread closed.');
    const reopenedRow = (await chatLab.harness.pool.query(
      'SELECT lifecycle_revision, closed_at, closed_by_user_id, locked FROM chat_conversations WHERE id=$1', [thread.id],
    )).rows[0];
    expect(reopenedRow).toEqual({ lifecycle_revision: '3', closed_at: null, closed_by_user_id: null, locked: false });
    lifecycleSql.push({ checkpoint: 'reopened', ...reopenedRow });
    for (const client of ['react', 'flutter']) {
      await expect.poll(() => lifecycleEvents.filter(receipt => receipt.client === client &&
        receipt.event.payload.threadId === thread.id).map(receipt => receipt.event.payload.threadLifecycle.revision)).toEqual([2, 3]);
    }
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
    // Dismiss the Flutter popup through its modal barrier before composing.
    await flutter.mouse.click(12, 24);
    await expect(flutter.getByRole('menuitem', { name: 'Notifications: all', exact: true })).toHaveCount(0);
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
    expect(lifecycleRequests.map(request => request.body.intent)).toEqual(['close', 'reopen']);
    await page.screenshot({ path: info.outputPath('react-recovered-1440x1000.png') });
  } finally {
    try {
      const evidence = { name, thread, errors, navigations, provenance, instance, screenshots,
        lifecycleRequests, lifecycleResponses, lifecycleEvents, lifecycleSql,
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
