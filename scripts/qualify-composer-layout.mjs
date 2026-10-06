// Actual SDK renderer + packaged CSS. Disposable browser fixture, no API or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, transform } from 'esbuild';
import { chromium } from '../examples/drop-in-react/node_modules/@playwright/test/index.mjs';

const output = resolve(process.argv[2] ?? 'docs/validation/workspace-repair-20261006');
await mkdir(output, { recursive: true });
const baseline = process.env.COMPOSER_BASELINE;
const bundled = await build({
  entryPoints: ['test/fixtures/composer-layout-browser.mjs'], bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: baseline ? [{ name: 'baseline-renderer', setup(builder) {
    builder.onLoad({ filter: /dist\/ui\/message-composer\.js$/ }, async () => ({
      contents: (await transform(execFileSync('git', ['show', `${baseline}:src/ui/message-composer.ts`], { encoding: 'utf8' }), { loader: 'ts' })).code,
      loader: 'js', resolveDir: resolve('dist/ui'),
    }));
  } }] : [],
});
const css = baseline ? execFileSync('git', ['show', `${baseline}:src/ui/styles.css`], { encoding: 'utf8' }) : await readFile('dist/ui/styles.css', 'utf8');
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const coarse of [false, true]) {
    for (const [name, width, pane] of [['320', 320, null], ['390', 390, null], ['1440', 1440, null], ['embedded', 1440, 284]]) {
      const context = await browser.newContext({ viewport: { width, height: 740 }, hasTouch: coarse, isMobile: coarse });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:18px;font:15px Arial,sans-serif}#host{width:${pane ? `${pane}px` : '100%'};max-width:100%}.handrail-chat{display:block;min-height:0;height:auto;font-size:15px}</style><main id="host"><div class="handrail-chat"><div class="handrail-chat__composer-region"><div id="fixture"></div></div></div></main>`);
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      for (const attachments of ['disabled', 'unavailable', 'enabled']) for (const draft of ['empty', 'short']) for (const feedback of ['none', 'sending', 'error']) {
        const options = { attachments, draft, feedback };
        await page.evaluate(options => window.renderComposer(options), options);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await page.evaluate(() => {
          const send = document.querySelector('.handrail-chat__composer-send');
          const footer = document.querySelector('.handrail-chat__composer-footer');
          const guidance = document.querySelector('[id$="-attachments-status"]');
          const rect = node => node.getBoundingClientRect().toJSON();
          const sendRect = rect(send);
          const intersect = r => r.left < sendRect.right && r.right > sendRect.left && r.top < sendRect.bottom && r.bottom > sendRect.top;
          const textRects = [];
          for (const node of footer.querySelectorAll('[role="status"], [role="alert"]')) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const range = document.createRange(); range.selectNodeContents(walker.currentNode);
              textRects.push(...Array.from(range.getClientRects(), rect => rect.toJSON()));
            }
          }
          const host = document.querySelector('#host').getBoundingClientRect();
          const file = document.querySelector('input[type="file"]');
          const hit = document.elementFromPoint(sendRect.x + sendRect.width / 2, sendRect.y + sendRect.height / 2);
          return {
            coarse: matchMedia('(pointer: coarse)').matches, send: sendRect, footer: rect(footer),
            guidance: guidance ? rect(guidance) : null, textRects,
            intersection: textRects.some(intersect),
            overflow: document.documentElement.scrollWidth > innerWidth || footer.scrollWidth > footer.clientWidth + 1 || textRects.some(r => r.left < host.left - 1 || r.right > host.right + 1),
            reachable: hit === send || send.contains(hit),
            sendDisabled: send.disabled, attachmentDisabled: file.disabled,
            described: !guidance || file.getAttribute('aria-describedby')?.split(' ').includes(guidance.id),
            status: !guidance || guidance.getAttribute('role') === 'status',
          };
        });
        results.push({ name, coarse, ...options, ...measured });
        const label = JSON.stringify({ name, coarse, ...options });
        if (!baseline) {
          assert.equal(measured.intersection, false, `text / Send overlap: ${label}`);
          assert.equal(measured.overflow, false, `overflow: ${label}`);
          assert.equal(measured.reachable, true, `Send not reachable: ${label}`);
          assert.equal(measured.coarse, coarse);
          assert.equal(measured.described, true); assert.equal(measured.status, true);
          assert.equal(measured.attachmentDisabled, attachments !== 'enabled');
          assert.equal(measured.sendDisabled, draft === 'empty' || feedback === 'sending');
          if (name !== '1440' && measured.guidance) assert.ok(measured.guidance.width > 180, `guidance too narrow: ${label}`);
          if (draft === 'short' && feedback === 'none') {
            await page.getByRole('button', { name: 'Send message', exact: true }).focus();
            await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
            const focus = await page.locator('.handrail-chat__composer-send').evaluate(node => ({ active: document.activeElement === node, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle }));
            assert.equal(focus.active, true); assert.equal(focus.visible, true); assert.notEqual(focus.outline, 'none');
          }
        }
        if (attachments === 'disabled' && draft === 'short' && ['none', 'error'].includes(feedback)) {
          await page.screenshot({ path: resolve(output, `${baseline ? 'before' : 'after'}-${name}-${coarse ? 'coarse' : 'fine'}-${feedback}.png`), fullPage: true });
        }
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  if (baseline) assert.ok(results.some(result => result.name === '320' && result.intersection), 'negative control must reproduce 320px overlap');
} finally {
  await writeFile(resolve(output, `${baseline ? 'before' : 'after'}-geometry.json`), JSON.stringify({ browser: browser.version(), baseline: baseline ?? null, results }, null, 2) + '\n');
  await browser.close();
}
console.log(`${baseline ? 'Baseline reproduced' : 'Passed'}: ${results.length} rendered cases; evidence: ${output}`);
