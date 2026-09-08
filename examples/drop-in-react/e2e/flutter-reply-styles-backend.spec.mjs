import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';

// Use the existing isolated PostgreSQL harness unless verifying the served lab.
test.use({ chatLabSeedProfile: 'reply-styles' });
if (process.env.FLUTTER_CHAT_LAB_ORIGIN) {
  test.use({ chatLabOrigin: process.env.FLUTTER_CHAT_LAB_ORIGIN });
}

const call = (page, operation) => page.evaluate(async (operation) =>
  JSON.parse(await window.handrailBackendLab(JSON.stringify({ operation }))), operation);

const enableSemantics = async (page) => {
  const placeholder = page.locator('flt-semantics-placeholder');
  if (await placeholder.count()) await placeholder.evaluate((element) => element.click());
};

test('shared Flutter opens Launch planning as Alice and switches to Bob', async ({ page, chatLabOrigin }, info) => {
  const instance = await (await page.request.get(`${chatLabOrigin}/__chat-lab/instance`)).json();
  expect(instance.seedProfile).toBe('reply-styles');
  const failures = [];
  page.on('pageerror', (error) => failures.push(String(error)));
  page.on('response', (response) => {
    if (response.status() >= 400 && /\/(__chat-lab|api\/chat)\//.test(new URL(response.url()).pathname)) {
      failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  const captures = [];
  const checkActor = async (actor) => {
    await page.waitForFunction(() => typeof window.handrailBackendLab === 'function', null, { timeout: 90_000 });
    let state;
    await expect.poll(async () => {
      state = await call(page, 'status');
      return { actor: state.identity?.userId, lifecycle: state.clientLifecycle, realtime: state.realtime };
    }).toEqual({ actor, lifecycle: 'ready', realtime: 'connected' });
    await expect.poll(async () => (await call(page, 'status')).hydratedTimelineIds).toContain(state.selectedConversationId);
    await enableSemantics(page);
    await expect(page.getByRole('heading', { name: 'Launch planning', exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Message 1 from alice Which launch date?', exact: true })).toBeVisible();
    expect(state.seedProfile).toBe('reply-styles');
    expect(state.instanceId).toBe(instance.instanceId);
    expect(state.availableActors).toEqual({ alice: 'Alice', bob: 'Bob' });
    expect(state.error).toBeNull();
    expect(state.clientDiagnostic).toBeNull();
    expect(state.provenance.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    const capture = await call(page, 'capture');
    captures.push(capture);
    await page.screenshot({ path: info.outputPath(`${actor}-${captures.length}.png`) });
    return capture;
  };
  try {
    await page.goto(`${chatLabOrigin}/__flutter-chat-lab/`);
    const alice = await checkActor('alice');
    await page.getByRole('button', { name: 'Alice', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Bob', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('actor-options.png') });
    await page.getByRole('menuitem', { name: 'Bob', exact: true }).click();
    await page.waitForURL(/actor=bob/);
    const bob = await checkActor('bob');
    expect(bob.selectedConversationId).toBe(alice.selectedConversationId);
    expect(bob.messages.map((message) => message.id)).toEqual(alice.messages.map((message) => message.id));
    await page.goto(`${chatLabOrigin}/__flutter-chat-lab/?actor=alice`);
    await checkActor('alice');
    expect(failures).toEqual([]);
  } finally {
    const evidence = { instance, captures, failures, current: await call(page, 'export').catch(() => null) };
    const evidencePath = info.outputPath('flutter-reply-styles-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await info.attach('flutter-reply-styles-evidence', { path: evidencePath, contentType: 'application/json' });
  }
});
