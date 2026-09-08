# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: flutter-cross-client-recovery.spec.mjs >> Flutter recovers an open thread during React Bob updates without manual retries
- Location: e2e/flutter-cross-client-recovery.spec.mjs:11:1

# Error details

```
Error: expect(locator).toBeEnabled() failed

Locator: getByRole('menuitem', { name: 'Join', exact: true })
Expected: enabled
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeEnabled" with timeout 15000ms
  - waiting for getByRole('menuitem', { name: 'Join', exact: true })

```

```yaml
- menu "Popup menu":
  - group:
    - menuitem "Leave"
    - 'menuitem "Notifications: all"'
    - 'menuitem "Notifications: mentions"'
    - 'menuitem "Notifications: none"'
    - menuitem "Unmute"
    - menuitem "Mute indefinitely"
    - menuitem "Mute for 1 hour"
```

# Test source

```ts
  1  | import { expect, test } from './chat-lab.fixture.mjs';
  2  | import { writeFile } from 'node:fs/promises';
  3  | import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';
  4  | 
  5  | const origin = process.env.FLUTTER_CHAT_LAB_ORIGIN;
  6  | test.skip(!origin, 'Requires the managed reply-styles backend and current Flutter build');
  7  | if (origin) test.use({ chatLabOrigin: origin });
  8  | const call = (page, operation) => page.evaluate(async operation =>
  9  |   JSON.parse(await window.handrailBackendLab(JSON.stringify({ operation }))), operation);
  10 | 
  11 | test('Flutter recovers an open thread during React Bob updates without manual retries', async ({ page, browser, chatLabOrigin }, info) => {
  12 |   const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  13 |   const flutter = await context.newPage();
  14 |   const name = `QA thread recovery ${Date.now()}`;
  15 |   const errors = [];
  16 |   flutter.on('pageerror', error => errors.push(error.message));
  17 |   try {
  18 |     await flutter.goto(`${chatLabOrigin}/__flutter-chat-lab/?actor=bob`);
  19 |     await flutter.waitForFunction(() => typeof window.handrailBackendLab === 'function');
  20 |     await flutter.locator('flt-semantics-placeholder').evaluate(e => e.click());
  21 |     await expect.poll(async () => (await call(flutter, 'status')).realtime).toBe('connected');
  22 |     await page.setViewportSize({ width: 1440, height: 1000 });
  23 |     await page.goto(`${chatLabOrigin}/chat-lab.html?actor=bob`);
  24 |     await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /^Launch planning/ }).click();
  25 |     const settings = page.locator('.chat-lab__reply-settings');
  26 |     await settings.locator('summary').click();
  27 |     await settings.getByRole('combobox', { name: 'Reply and thread style', exact: true }).selectOption('discord');
  28 |     await expect(settings).toContainText('Effective style: Discord-style');
  29 |     await settings.locator('summary').click();
  30 |     const composer = page.getByLabel('Conversation composer', { exact: true });
  31 |     await composer.getByRole('textbox').fill(name);
  32 |     await composer.getByRole('button', { name: 'Send message', exact: true }).click();
  33 |     const root = page.getByRole('region', { name: 'Conversation timeline', exact: true })
  34 |       .getByRole('article').filter({ hasText: name }).first();
  35 |     await root.hover();
  36 |     await root.getByRole('button', { name: 'Create Thread', exact: true }).click();
  37 |     const creation = page.getByRole('dialog', { name: 'Create Thread', exact: true });
  38 |     await creation.getByLabel('Thread name').fill(name);
  39 |     await creation.getByRole('button', { name: 'Create Thread', exact: true }).click();
  40 |     const panel = page.getByRole('complementary', { name, exact: true });
  41 |     await panel.getByRole('button', { name: /^Thread notification preferences:/ }).click();
  42 |     const preferences = panel.getByRole('dialog', { name: 'Notification preferences', exact: true });
  43 |     await preferences.getByRole('combobox').selectOption('mentions');
  44 |     await preferences.getByRole('button', { name: 'Save preferences', exact: true }).click();
  45 |     await expect(preferences.getByRole('status')).toContainText('Notification preferences saved');
  46 |     await panel.getByRole('button', { name: /^Thread notification preferences:/ }).click();
  47 |     const input = panel.getByRole('textbox');
  48 |     await input.fill(`${name} history`);
  49 |     await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  50 |     const flutterRoot = flutter.getByRole('group', { name: new RegExp(`^Message \\d+ from bob ${name}$`) });
  51 |     await flutterRoot.getByRole('button', { name: 'Open Thread', exact: true }).click();
  52 |     await panel.getByRole('button', { name: 'Leave', exact: true }).click();
  53 |     const history = panel.getByRole('article').filter({ hasText: `${name} history` }).first();
  54 |     await history.hover();
  55 |     await history.getByRole('button', { name: 'Reply', exact: true }).click();
  56 |     await input.fill(`${name} inline after Leave`);
  57 |     await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  58 |     await panel.getByRole('button', { name: 'Close thread', exact: true }).click();
  59 |     await panel.getByRole('button', { name: 'Reopen thread', exact: true }).click();
  60 |     await panel.getByRole('button', { name: 'Join', exact: true }).click();
  61 |     await panel.getByRole('button', { name: 'Leave', exact: true }).click();
  62 |     await composer.getByRole('textbox').fill(`${name} retained channel draft`);
  63 |     await expect(flutter.getByRole('banner', { name, exact: true })).toBeVisible();
  64 |     await expect(flutter.getByRole('group', { name: new RegExp(`^Message 1 from bob ${name} history`) })).toBeVisible();
  65 |     await expect(flutter.getByRole('group', { name: new RegExp(`^Message 2 from bob.*${name} inline after Leave`) })).toBeVisible();
  66 |     await expect(flutter.getByRole('textbox', { name: 'Write a message', exact: true }).last()).toBeEnabled();
  67 |     await expect(flutter.getByRole('button', { name: 'Shared thread controls', exact: true })).toBeEnabled();
  68 |     await flutter.getByRole('button', { name: 'Thread subscriptions', exact: true }).click();
> 69 |     await expect(flutter.getByRole('menuitem', { name: 'Join', exact: true })).toBeEnabled();
     |                                                                                ^ Error: expect(locator).toBeEnabled() failed
  70 |     await expect(flutter.getByRole('menuitem', { name: 'Notifications: all', exact: true })).toBeEnabled();
  71 |     expect(await flutter.getByRole('menuitem', { name: 'Retry loading subscriptions', exact: true }).count()).toBe(0);
  72 |     await flutter.keyboard.press('Escape');
  73 |     await expect(flutter.getByRole('menu', { name: 'Popup menu', exact: true })).toBeHidden();
  74 |     const status = await call(flutter, 'status');
  75 |     expect(status.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
  76 |     expect(status.diagnostics).not.toContain('snapshot_hydration_failed');
  77 |     expect(errors).toEqual([]);
  78 |     await composer.getByRole('textbox').clear();
  79 |   } finally {
  80 |     await writeFile(info.outputPath('recovery.json'), JSON.stringify({ name, errors,
  81 |       semantics: await flutter.locator('body').ariaSnapshot(),
  82 |       exported: await call(flutter, 'export').catch(error => ({ error: error.message })) }, null, 2));
  83 |     await flutter.screenshot({ path: info.outputPath('recovery-390x844.png') });
  84 |     await context.close();
  85 |   }
  86 | });
  87 | 
```