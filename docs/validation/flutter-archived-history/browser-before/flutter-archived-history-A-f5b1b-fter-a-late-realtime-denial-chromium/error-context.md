# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: flutter-archived-history.spec.mjs >> Alice retains archived Flutter history after a late realtime denial
- Location: e2e/flutter-archived-history.spec.mjs:7:1

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 2
Received:   2

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [active] [ref=e4]:
  - generic:
    - generic:
      - generic:
        - generic:
          - generic:
            - generic:
              - heading "Flutter Chat Lab · shared backend" [level=2]
            - button "Alice" [ref=e5]
            - generic: "Managed realtime: connected"
            - button "Disconnect" [ref=e6]
            - button "Capture state" [ref=e7]
            - button "Export evidence" [ref=e8]
            - generic:
              - generic: Thread
              - button "Open workspace settings" [ref=e9]
              - button "Close panel" [ref=e10]
              - banner "Archived launch history":
                - button "Thread subscriptions" [ref=e11]
                - button "Close panel" [ref=e12]
                - generic: "Following. Notifications: all. Unmuted."
              - generic: Thread or parent administratively archived. Sending is disabled; your draft is retained. Thread lifecycle access denied. Your draft is retained.
              - generic: Thread root message In Launch planning Archived launch notes
              - generic: Conversation access revoked Conversation realtime access was rejected.
              - group "Message composer You no longer have access to this conversation.":
                - generic [ref=e13]:
                  - textbox "Message input" [disabled] [ref=e14]
                  - textbox "You no longer have access to this conversation." [disabled] [ref=e16]
                - button "Add attachment" [disabled] [ref=e17]
                - group:
                  - button "Bold" [ref=e18]:
                    - button "Bold" [disabled] [ref=e19]
                  - button "Italic" [ref=e20]:
                    - button "Italic" [disabled] [ref=e21]
                  - button "Link" [ref=e22]:
                    - button "Link" [disabled] [ref=e23]
                  - button "Bulleted list" [ref=e24]:
                    - button "Bulleted list" [disabled] [ref=e25]
                  - button "Numbered list" [ref=e26]:
                    - button "Numbered list" [disabled] [ref=e27]
                  - button "Inline code" [ref=e28]:
                    - button "Inline code" [disabled] [ref=e29]
                  - button "Code block" [ref=e30]:
                    - button "Code block" [disabled] [ref=e31]
                - button "Send message" [disabled] [ref=e32]
```

# Test source

```ts
  1  | import { writeFile } from 'node:fs/promises';
  2  | import { expect, test } from './chat-lab.fixture.mjs';
  3  | import { flutterLabProvenance } from '../scripts/build-flutter-chat-lab.mjs';
  4  | 
  5  | test.use({ chatLabSeedProfile: 'reply-styles' });
  6  | 
  7  | test('Alice retains archived Flutter history after a late realtime denial', async ({ chatLab, page }, info) => {
  8  |   const control = await page.request.post(`${chatLab.origin}/__chat-lab/reply-styles`, {
  9  |     data: { operation: 'create_archived_thread' },
  10 |   });
  11 |   expect(control.ok()).toBe(true);
  12 |   const fixture = await control.json();
  13 |   const detailPath = `/api/chat/conversations/${fixture.threadId}`;
  14 |   const responses = [];
  15 |   const errors = [];
  16 |   let releaseDenial;
  17 |   page.on('pageerror', error => errors.push(error.message));
  18 |   page.on('response', response => {
  19 |     const path = new URL(response.url()).pathname;
  20 |     if (path.startsWith(detailPath)) responses.push({
  21 |       path, method: response.request().method(), status: response.status(),
  22 |     });
  23 |   });
  24 |   // Hold the real server rejection until authorized HTTP history is rendered.
  25 |   // This selects the failing response order without changing access policy.
  26 |   await page.routeWebSocket('**/api/chat/**', socket => {
  27 |     const server = socket.connectToServer();
  28 |     const threadRequests = new Set();
  29 |     socket.onMessage(message => {
  30 |       const frame = JSON.parse(message.toString());
  31 |       if (frame.type === 'chat.subscribe' && frame.streamId === fixture.threadId) {
  32 |         threadRequests.add(frame.requestId);
  33 |       }
  34 |       server.send(message);
  35 |     });
  36 |     server.onMessage(message => {
  37 |       const frame = JSON.parse(message.toString());
  38 |       if (frame.type === 'chat.subscription.rejected' && threadRequests.has(frame.requestId)) {
  39 |         expect(frame.code).toBe('access_denied');
  40 |         releaseDenial = () => socket.send(message);
  41 |       } else socket.send(message);
  42 |     });
  43 |   });
  44 |   await page.setViewportSize({ width: 390, height: 844 });
  45 |   try {
  46 |     await page.goto(`${chatLab.origin}/__flutter-chat-lab/?actor=alice`);
  47 |     await page.waitForFunction(() => typeof window.handrailBackendLab === 'function');
  48 |     await page.locator('flt-semantics-placeholder').evaluate(element => element.click());
  49 |     const root = page.getByRole('group', { name: /^Message \d+ from alice Archived launch notes$/ });
  50 |     await root.getByRole('button', { name: 'Open Thread', exact: true }).click();
  51 |     const history = page.getByRole('group', { name: /^Message 1 from alice Retained archived launch history$/ });
  52 |     await expect(history).toBeVisible();
  53 |     await expect.poll(() => typeof releaseDenial).toBe('function');
  54 |     const historyReads = () => responses.filter(response => response.path === `${detailPath}/messages` && response.status === 200).length;
  55 |     const readsBeforeDenial = historyReads();
  56 |     releaseDenial();
> 57 |     await expect.poll(historyReads).toBeGreaterThan(readsBeforeDenial);
     |                                     ^ Error: expect(received).toBeGreaterThan(expected)
  58 |     // Let automatic cursor writes and their bounded retry settle as well.
  59 |     await expect.poll(() => responses.filter(response => response.path.endsWith('/read-cursor') && response.status === 403).length).toBeGreaterThan(0);
  60 |     await expect(history).toBeVisible();
  61 |     await expect(page.getByRole('textbox', { name: 'Message composer disabled.', exact: true })).toBeDisabled();
  62 |     expect(await page.locator('body').ariaSnapshot()).not.toContain('Conversation access revoked');
  63 |     const status = await page.evaluate(async () => JSON.parse(await window.handrailBackendLab(JSON.stringify({ operation: 'status' }))));
  64 |     expect(status.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
  65 |     expect(errors).toEqual([]);
  66 |   } finally {
  67 |     await page.screenshot({ path: info.outputPath('archived-thread-390x844.png') });
  68 |     await writeFile(info.outputPath('archived-history.json'), JSON.stringify({
  69 |       backendKind: chatLab.harness.backendKind, fixture, responses, errors,
  70 |       semantics: await page.locator('body').ariaSnapshot(),
  71 |     }, null, 2));
  72 |   }
  73 | });
  74 | 
```