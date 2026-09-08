import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';
import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';

if (process.env.FLUTTER_CHAT_LAB_ORIGIN) {
  test.use({ chatLabOrigin: process.env.FLUTTER_CHAT_LAB_ORIGIN });
}

test('served Flutter implementation matches current build inputs', async ({
  page, chatLabOrigin,
}, info) => {
  const inputsBefore = flutterLabProvenance();
  const response = await page.goto(new URL('/__flutter-chat-lab/', chatLabOrigin).href);
  expect(response.status()).toBe(200);
  await page.waitForFunction(() => typeof window.handrailBackendLab === 'function', null, {
    timeout: 60_000,
  });
  let exported;
  await expect.poll(async () => {
    exported = await page.evaluate(async () => JSON.parse(
      await window.handrailBackendLab(JSON.stringify({ operation: 'export' })),
    ));
    return exported.current.provenance;
  }).toBeDefined();
  const inputsAfter = flutterLabProvenance();
  const evidencePath = info.outputPath('flutter-provenance.json');
  await writeFile(evidencePath, JSON.stringify({
    observedAt: new Date().toISOString(),
    url: page.url(),
    inputsBefore,
    inputsAfter,
    exported,
  }, null, 2));
  await info.attach('flutter-provenance', {
    path: evidencePath,
    contentType: 'application/json',
  });
  expect(inputsAfter.sourceDigest, 'Inputs changed while checking the runtime').toBe(inputsBefore.sourceDigest);
  expect(exported.current.mode).toBe('shared-backend');
  expect(exported.current.provenance.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
  expect(Number.isFinite(Date.parse(exported.current.provenance.builtAt))).toBe(true);
  // A different HEAD can contain identical Flutter inputs. Compare the digest
  // embedded in the executing Dart program, not just revisions or disk assets.
  expect(exported.current.provenance.sourceDigest,
    'Stale Flutter build: run npm run build:flutter:lab, then reload before QA',
  ).toBe(inputsBefore.sourceDigest);
});
