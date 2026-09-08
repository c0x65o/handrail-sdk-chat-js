import { expect, test } from './chat-lab.fixture.mjs';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';
import { writeFile } from 'node:fs/promises';

test.use({ chatLabSeedProfile: 'reply-styles' });

const status = (page) => page.evaluate(async () => JSON.parse(
  await window.handrailBackendLab(JSON.stringify({ operation: 'status' })),
));

test('Flutter restores only the same actor and conversation draft after style changes and reload', async ({
  page, context, chatLabOrigin, chatLab,
}, info) => {
  const alice = chatLab.harness.createClient('chat-lab-alice');
  try {
    await alice.start();
    const created = await alice.createDirect({ intendedMemberUserIds: ['bob'] });
    expect(created.status).toBe('success');
  } finally {
    alice.close();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const open = async (target, actor = 'alice') => {
    await target.goto(new URL(`/__flutter-chat-lab/?actor=${actor}`, chatLabOrigin).href);
    await target.waitForFunction(() => typeof window.handrailBackendLab === 'function');
    await target.locator('flt-semantics-placeholder').evaluate((element) => element.click());
    await expect.poll(async () => (await status(target)).realtime).toBe('connected');
  };
  const dm = async (target) => {
    await target.getByRole('button', { name: 'Back to conversations', exact: true }).click();
    await target.getByRole('button', { name: /^Direct message, / }).click();
  };
  const input = (target) => target.locator('textarea');
  const snapshot = async (target, label) => {
    const path = info.outputPath(`${label}.txt`);
    await writeFile(path, await target.locator('body').ariaSnapshot());
    await info.attach(label, { path, contentType: 'text/plain' });
    await target.screenshot({ path: info.outputPath(`${label}.png`) });
  };
  await open(page);
  await dm(page);
  const conversationId = (await status(page)).selectedConversationId;
  const draft = 'QA 298e20b4 durable draft';
  const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' &&
    response.url().endsWith(`/conversations/${conversationId}/draft`));
  await input(page).click();
  await input(page).fill(draft);
  expect((await saved).ok()).toBe(true);
  const drafts = async () => (await chatLab.harness.pool.query(
    'SELECT user_id, content, revision FROM chat_drafts WHERE conversation_id = $1 ORDER BY user_id',
    [conversationId],
  )).rows;
  const stored = await drafts();
  expect(stored).toEqual([expect.objectContaining({ user_id: 'alice',
    content: expect.objectContaining({ text: draft }) })]);
  await info.attach('postgres-saved-draft', { body: JSON.stringify(stored), contentType: 'application/json' });
  await snapshot(page, 'before-reload');

  await page.getByRole('button', { name: 'Open workspace settings', exact: true }).click();
  await page.getByRole('radio', { name: 'Discord-style', exact: true }).click();
  await expect(page.getByLabel('Alert', { exact: true }).getByText(/Effective style: Discord-style/)).toBeVisible();
  await page.getByRole('radio', { name: 'Current', exact: true }).click();
  await expect(page.getByLabel('Alert', { exact: true }).getByText(/Effective style: Current/)).toBeVisible();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  // Flutter removes the DOM editing input when focus moves; refocus to inspect
  // the actual editor value, in addition to the rendered semantics evidence.
  await input(page).click();
  await expect(input(page)).toHaveValue(draft);

  await open(page);
  await input(page).click();
  await expect(input(page)).toHaveValue('');
  expect((await status(page)).selectedConversationId).not.toBe(conversationId);
  await dm(page);
  await input(page).click();
  await expect(input(page)).toHaveValue(draft);
  await snapshot(page, 'after-reload');
  expect((await status(page)).provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);

  const bob = await context.newPage();
  await bob.setViewportSize({ width: 390, height: 844 });
  await open(bob, 'bob');
  await dm(bob);
  await input(bob).click();
  await expect(input(bob)).toHaveValue('');
  expect((await status(bob)).selectedConversationId).toBe(conversationId);
  await snapshot(bob, 'bob-private-draft-isolation');
  await bob.close();

  const cleared = page.waitForResponse((response) => response.request().method() === 'PATCH' &&
    response.url().endsWith(`/conversations/${conversationId}/draft`));
  await input(page).fill('');
  expect((await cleared).ok()).toBe(true);
  await open(page);
  await dm(page);
  await input(page).click();
  await expect(input(page)).toHaveValue('');
  await snapshot(page, 'cleared-after-reload');
  const tombstone = await drafts();
  expect(tombstone).toEqual([expect.objectContaining({ user_id: 'alice', content: null })]);
  await info.attach('postgres-cleared-draft', { body: JSON.stringify(tombstone), contentType: 'application/json' });
  await writeFile(info.outputPath('draft-reload-evidence.json'), JSON.stringify({
    campaign: '298e20b4-4faf-4283-949d-3801cf437aa8',
    stored, tombstone, current: await status(page),
    checks: ['Current / Discord-style / Current', 'reload and reopen DM',
      'other conversation empty', 'Bob isolated', 'clear persists after reload'],
  }, null, 2));
});
