import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';

// Reuse the accepted campaign's existing source/reply pairs without reseeding.
const origin = process.env.FLUTTER_CHAT_LAB_ORIGIN;
test.skip(!origin, 'Requires the reply-styles campaign runtime with channel and DM replies');
if (origin) test.use({ chatLabOrigin: origin });

const call = (page, operation) => page.evaluate(async (operation) => JSON.parse(
  await window.handrailBackendLab(JSON.stringify({ operation })),
), operation);

for (const actor of ['alice', 'bob']) {
  for (const conversation of ['channel', 'direct']) {
    test(`Flutter ${actor} resolves and jumps to ${conversation} reply sources`, async ({
      page, chatLabOrigin,
    }, info) => {
      await page.setViewportSize(actor === 'bob'
        ? { width: 390, height: 844 } : { width: 1280, height: 720 });
      const reads = [];
      page.on('response', (response) => {
        if (new URL(response.url()).pathname.endsWith('/context')) {
          reads.push({ url: response.url(), status: response.status() });
        }
      });
      try {
        await page.goto(new URL(`/__flutter-chat-lab/?actor=${actor}`, chatLabOrigin).href);
        await page.waitForFunction(() => typeof window.handrailBackendLab === 'function');
        await page.locator('flt-semantics-placeholder').evaluate((element) => element.click());
        await expect.poll(async () => (await call(page, 'status')).realtime).toBe('connected');
        if (conversation === 'direct') {
          if (actor === 'bob') await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
          await page.getByRole('button', { name: /^Direct message, / }).click();
        }
        const author = conversation === 'channel' ? 'alice' : 'bob';
        const jump = page.getByRole('button', { name: new RegExp(`^Jump to original message\\. Reply to ${author}:`) }).first();
        await expect(jump).toBeVisible();
        if (conversation === 'channel') await expect(jump).toHaveAccessibleName(/Which launch date\?/);
        expect(await page.locator('body').ariaSnapshot()).not.toContain('Original message unavailable');
        await jump.click();
        await expect.poll(async () => page.evaluate(() =>
          document.activeElement?.getAttribute('aria-label') ?? '',
        )).toMatch(new RegExp(`^Message 1 from ${author}`));
        await expect.poll(() => reads.filter((read) => read.status === 200).length).toBeGreaterThan(0);
        if (actor === 'bob') {
          const composer = page.getByRole('group', { name: 'Message composer', exact: true });
          const cancel = composer.getByRole('button', { name: 'Cancel reply', exact: true });
          if (await cancel.count()) await cancel.click();
          const root = page.getByRole('group', { name: new RegExp(`^Message 1 from ${author}`) });
          // Make retry observable with one deliberate transport failure; the
          // recovered request goes to the real, authorized backend.
          await page.route('**/context', (route) => route.abort(), { times: 1 });
          await root.getByRole('button', { name: 'Reply', exact: true }).click();
          await expect(composer.getByRole('group', { name: 'Inline reply Reply source could not be loaded.' })).toBeVisible();
          await composer.getByRole('button', { name: 'Retry reply source', exact: true }).click();
          await expect(composer.getByRole('group', { name: /^Inline reply Replying to:/ })).toBeVisible();
          expect(await composer.ariaSnapshot()).not.toContain('Reply source is unavailable.');
          await cancel.click();
        }
        const state = await call(page, 'status');
        expect(state.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
      } finally {
        const evidence = {
          actor, conversation, reads,
          semantics: await page.locator('body').ariaSnapshot(),
          exported: await call(page, 'export').catch(() => null),
        };
        const path = info.outputPath('reply-source-evidence.json');
        await writeFile(path, JSON.stringify(evidence, null, 2));
        await info.attach('reply-source-evidence', { path, contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath('reply-source.png') });
      }
    });
  }
}
