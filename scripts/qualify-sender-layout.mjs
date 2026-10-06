// Public SDK UI + packaged CSS, without consumer overrides or live services.
// Run after npm run build; install the drop-in example's locked Playwright first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../examples/drop-in-react/node_modules/@playwright/test/index.mjs';

const output = resolve(process.argv[2] ?? 'test-results/sender-layout');
// Preserve every previous run, including failures.
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const bundled = await build({
  entryPoints: ['test/fixtures/sender-layout-browser.mjs'], bundle: true, write: false,
  format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
});
// A read-only historical CSS control runs the same assertions and must fail.
const baseline = process.env.SENDER_LAYOUT_BASELINE;
const css = baseline
  ? execFileSync('git', ['show', `${baseline}:src/ui/styles.css`], { encoding: 'utf8' })
  : await readFile(fileURLToPath(import.meta.resolve('@handrail/chat/ui/styles.css')), 'utf8');
const browser = await chromium.launch({ headless: true });
const results = [];
const failures = [];
try {
  for (const coarse of [false, true]) for (const width of [320, 390, 1440]) for (const mode of ['timeline', 'thread']) {
    const label = `${mode}-${width}-${coarse ? 'coarse' : 'fine'}`;
    const context = await browser.newContext({ viewport: { width, height: 1100 }, hasTouch: coarse, isMobile: coarse, timezoneId: 'UTC', locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.abort());
    // The consumer provides an available pane; all inner layout comes from SDK CSS.
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:16px}#fixture{display:grid;height:calc(100vh - 32px)}</style><main class="handrail-chat" id="fixture"></main>`);
    await page.evaluate(mode => { window.senderLayoutMode = mode; }, mode);
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.locator('.handrail-chat__timeline-author strong').first().waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const measured = await page.evaluate(() => {
      const rect = element => element.getBoundingClientRect().toJSON();
      const textRects = element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const boxes = [];
        while (walker.nextNode()) {
          const range = document.createRange(); range.selectNodeContents(walker.currentNode);
          boxes.push(...Array.from(range.getClientRects(), box => box.toJSON()));
        }
        return boxes;
      };
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const rows = [...document.querySelectorAll('.handrail-chat__timeline-author, .handrail-chat__thread-root-meta')].map(row => {
        const name = row.querySelector('strong');
        const time = row.querySelector('time');
        const bounds = rect(row);
        const nameRects = textRects(name);
        const timeRects = textRects(time);
        const boxes = [...nameRects, ...timeRects];
        const ancestors = [];
        for (let ancestor = row; ancestor; ancestor = ancestor.parentElement) ancestors.push(rect(ancestor));
        return {
          kind: row.className, name: name.textContent, time: time.textContent, dateTime: time.dateTime,
          bounds, nameRects, timeRects, nameStyle: { overflow: getComputedStyle(name).overflow, textOverflow: getComputedStyle(name).textOverflow },
          clipped: boxes.some(box => ancestors.some(parent => box.left < parent.left - 1 || box.right > parent.right + 1)),
          overlap: nameRects.some(a => timeRects.some(b => intersects(a, b))),
        };
      });
      const messages = [...document.querySelectorAll('.handrail-chat__timeline-message')].map(message => ({
        text: message.textContent,
        overflow: message.scrollWidth > message.clientWidth + 1,
      }));
      const overflow = [...document.querySelectorAll('.handrail-chat__timeline-viewport, .handrail-chat__thread-panel')]
        .some(element => element.scrollWidth > element.clientWidth + 1);
      return { rows, messages, names: window.senderLayoutNames, overflow: overflow || document.documentElement.scrollWidth > innerWidth, coarse: matchMedia('(pointer: coarse)').matches };
    });
    await page.screenshot({ path: resolve(output, `${label}.png`), fullPage: true });
    const accessible = await page.locator('#fixture').ariaSnapshot();
    // Thread history scrolls independently; retain both ends for visual review.
    if (mode === 'thread') {
      for (const index of [0, 2]) {
        await page.locator('.handrail-chat__timeline-author').nth(index).scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(output, `${label}-author-${index}.png`), fullPage: true });
      }
    }
    // Hover/focus every message action and prove the controls remain reachable.
    const actions = [];
    for (const row of await page.locator('.handrail-chat__timeline-item').all()) {
      await row.hover();
      for (const button of await row.locator('.handrail-chat__timeline-actions > button:not(:disabled), .handrail-chat__timeline-actions-overflow > button:not(:disabled)').all()) {
        await button.scrollIntoViewIfNeeded();
        await button.focus();
        // Wait for browser scrolling and SDK hover transitions, without invoking commands.
        await button.click({ trial: true });
        actions.push(await button.evaluate(button => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { label: button.getAttribute('aria-label') ?? button.textContent, reachable: hit === button || button.contains(hit), fits: box.left >= 0 && box.right <= innerWidth };
        }));
      }
    }
    results.push({ label, ...measured, actions, errors });
    try {
      assert.deepEqual(errors, [], `${label}: browser errors`);
      assert.equal(measured.coarse, coarse);
      assert.equal(measured.rows.length, mode === 'thread' ? 4 : 3, `${label}: missing authors`);
      assert.deepEqual(measured.rows.filter(row => row.kind.includes('timeline-author')).map(row => row.name), measured.names);
      for (const name of measured.names) assert.ok(accessible.includes(name), `${label}: missing accessible identity ${name}`);
      assert.equal(measured.overflow, false, `${label}: horizontal overflow`);
      for (const row of measured.rows) {
        assert.equal(row.clipped, false, `${label}: clipped sender/timestamp ${row.name}`);
        assert.equal(row.overlap, false, `${label}: sender/timestamp overlap`);
        assert.ok(row.time.length > 0 && row.dateTime, `${label}: missing timestamp`);
        assert.equal(row.nameStyle.overflow, 'visible', `${label}: sender is hidden`);
        assert.notEqual(row.nameStyle.textOverflow, 'ellipsis', `${label}: sender is truncated`);
      }
      assert.equal(measured.messages.length, 3);
      assert.ok(measured.messages.every(message => !message.overflow && message.text.includes('Readable')), `${label}: message overflow`);
      assert.ok(actions.length > 0 && actions.every(action => action.reachable && action.fits), `${label}: unreachable actions`);
    } catch (error) { failures.push(error.message); }
    await context.close();
  }
} finally {
  await writeFile(resolve(output, 'geometry.json'), JSON.stringify({ browser: browser.version(), baseline: baseline ?? null, results, failures }, null, 2) + '\n');
  await browser.close();
}
assert.deepEqual(failures, [], 'Sender layout regression');
console.log(`Passed ${results.length} public SDK timeline/thread cases; evidence: ${output}`);
