// Verify the supplied supervised runtime, without creating a replacement lab.
// Requires the dedicated database configured for work request 927504f0.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium, expect } from '../examples/drop-in-react/node_modules/@playwright/test/index.mjs';

const origin = 'http://127.0.0.1:4167';
const prefix = new URL('./chat-lab-runtime-repair-', import.meta.url);
const artifact = name => new URL(prefix.href + name);
const db = new pg.Client({ connectionString: 'postgresql://127.0.0.1:34680/handrail_chat_reply_styles_fab4ec11' });
const proof = { origin, startedAt: new Date().toISOString(), checkpoints: [] };
await db.connect();
const schemas = (await db.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'handrail_chat_lab_%'")).rows;
assert.equal(schemas.length, 1);
proof.schema = schemas[0].nspname;
assert.match(proof.schema, /^handrail_chat_lab_[a-f0-9]+$/);
await db.query(`SET search_path TO ${proof.schema}`);
const rows = async sql => (await db.query(sql)).rows;
const threads = () => rows("SELECT id, name, root_message_id FROM chat_conversations WHERE type='thread'");
proof.before = {
  instance: await (await fetch(`${origin}/__chat-lab/instance`)).json(),
  preferences: await rows('SELECT user_id, style FROM chat_user_reply_style_preferences ORDER BY user_id'),
  conversations: await rows('SELECT id, type, name FROM chat_conversations'),
  messages: await rows('SELECT id, conversation_id, author_user_id, content FROM chat_messages'),
  threads: await threads(),
};
assert.equal(proof.before.instance.seedProfile, 'reply-styles');
assert.deepEqual(proof.before.preferences, [{ user_id: 'alice', style: 'current' }, { user_id: 'bob', style: 'discord' }]);
assert.deepEqual(proof.before.threads, []);
assert.equal(proof.before.messages.length, 1);
const rootId = proof.before.messages[0].id;
const channelId = proof.before.messages[0].conversation_id;
assert.equal(proof.before.messages[0].content.text, 'Which launch date?');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
page.on('response', response => { if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`); });
const timeline = page.getByRole('region', { name: 'Conversation timeline', exact: true });
const root = timeline.locator(`[data-message-id="${rootId}"]`);
const checkRoot = async () => {
  await expect(root).toHaveCount(1);
  await expect(root).toBeVisible();
  await expect(root).toContainText('Which launch date?');
};
try {
  await page.goto(`${origin}/chat-lab.html`);
  await expect(page.getByLabel('Mixed reply styles scenario')).toContainText('Switching style does not convert history');
  const chooser = page.getByRole('button', { name: 'Development fixture identity: Alice', exact: true });
  await chooser.click();
  await expect(page.getByRole('option', { name: /Alice/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Bob/ })).toBeVisible();
  await page.screenshot({ path: artifact('actor-chooser.png').pathname, fullPage: true });
  await page.getByRole('option', { name: /Bob/ }).click();
  await expect(page.getByRole('button', { name: 'Development fixture identity: Bob', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /^Launch planning/ }).click();
  await checkRoot();
  await page.locator('.chat-lab__reply-settings summary').click();
  await expect(page.getByRole('combobox', { name: 'Reply and thread style', exact: true })).toHaveValue('discord');
  await page.locator('.chat-lab__reply-settings summary').click();
  await page.screenshot({ path: artifact('initial.png').pathname, fullPage: true });
  proof.checkpoints.push('Natural instance metadata, actor chooser, channel/root, guidance, saved mixed styles, zero threads');

  // No navigation, reload, style change, or actor switch between Reply and Create Thread.
  await root.hover();
  await root.getByRole('button', { name: 'Reply', exact: true }).click();
  const composer = page.getByLabel('Conversation composer', { exact: true });
  await composer.getByRole('textbox').fill('Friday');
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  const friday = timeline.getByRole('article').filter({ hasText: 'Friday' });
  await expect(friday.getByRole('button', { name: /Jump to original message.*Alice.*Which launch date/ })).toBeVisible();
  await checkRoot();
  proof.afterReply = {
    messages: await rows("SELECT id, conversation_id, reply_to_message_id FROM chat_messages WHERE content->>'text'='Friday'"),
    threads: await threads(),
  };
  assert.equal(proof.afterReply.messages.length, 1);
  assert.equal(proof.afterReply.messages[0].conversation_id, channelId);
  assert.equal(proof.afterReply.messages[0].reply_to_message_id, rootId);
  assert.deepEqual(proof.afterReply.threads, []);
  await page.screenshot({ path: artifact('inline-reply.png').pathname, fullPage: true });
  proof.checkpoints.push('Bob Friday is a same-channel reply to Alice; root visible exactly once; zero threads');
  await root.hover();
  await root.getByRole('button', { name: 'Create Thread', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Thread', exact: true });
  await dialog.getByLabel('Thread name').fill('Launch date decision');
  await dialog.getByRole('button', { name: 'Create Thread', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Launch date decision', exact: true });
  await expect(panel).toBeVisible();
  await checkRoot();
  proof.afterCreation = await threads();
  assert.equal(proof.afterCreation.length, 1);
  assert.equal(proof.afterCreation[0].root_message_id, rootId);
  assert.equal(proof.afterCreation[0].name, 'Launch date decision');
  await expect(panel.locator('[data-thread-conversation-id]')).toHaveAttribute('data-thread-conversation-id', proof.afterCreation[0].id);
  await page.screenshot({ path: artifact('named-thread.png').pathname, fullPage: true });
  assert.deepEqual(failures, []);
  proof.checkpoints.push('Uninterrupted explicit named creation: one canonical thread, panel opens, parent root retained exactly once');
  proof.result = 'passed';
} catch (error) {
  proof.result = 'failed';
  proof.error = String(error);
  await page.screenshot({ path: artifact('failure.png').pathname, fullPage: true });
  throw error;
} finally {
  proof.finishedAt = new Date().toISOString();
  proof.browserErrors = failures;
  await writeFile(artifact('proof.json'), JSON.stringify(proof, null, 2) + '\n');
  await context.tracing.stop({ path: artifact('trace.zip').pathname });
  await browser.close();
  await db.end();
}
console.log(JSON.stringify(proof, null, 2));
