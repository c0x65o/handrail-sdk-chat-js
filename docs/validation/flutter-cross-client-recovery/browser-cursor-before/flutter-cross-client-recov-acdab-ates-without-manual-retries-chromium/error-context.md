# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: flutter-cross-client-recovery.spec.mjs >> Flutter recovers an open thread during React Bob updates without manual retries
- Location: e2e/flutter-cross-client-recovery.spec.mjs:11:1

# Error details

```
Error: expect(received).not.toContain(expected) // indexOf

Expected value: not "snapshot_hydration_failed"
Received array:     ["conversation.list:completed", "reply.style.preference:completed", "message.timeline:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "message.context:aborted", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.draft:completed", "message.context:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "durable_event_recovery", "recovery:ordering_gap:conversation.preference.updated", "message_reminder.list:completed", "conversation.list:completed", "conversation.detail:completed", "message.timeline:completed", "conversation.detail:completed", "message.timeline:completed", "snapshot_hydration_failed", "message.context:aborted", "message.context:completed", "reply.style.preference:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "durable_event_recovery", "recovery:ordering_gap:thread.follow.updated", "conversation.detail:completed", "message_reminder.list:completed", "message.timeline:completed", "message.timeline:completed", "conversation.list:completed", "message.timeline:completed", "conversation.detail:completed", "conversation.detail:completed", "message.timeline:completed", "conversation.draft:completed", "conversation.detail:completed", "message.timeline:completed", "snapshot_hydration_failed", "message.context:aborted", "reply.style.preference:completed", "message.context:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:aborted", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "message.context:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed", "conversation.detail:completed"]
```

# Page snapshot

```yaml
- main [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: H
      - generic [ref=e7]:
        - heading "Handrail Chat Lab" [level=1] [ref=e8]
        - generic [ref=e9]: Development workspace
    - generic [ref=e10]:
      - status [ref=e11]: Managed realtime connected
      - group [ref=e12]:
        - generic "About this lab and local media" [ref=e13] [cursor=pointer]: About
    - generic [ref=e14]: "Current actor: Bob"
  - region "Interactive chat lab" [ref=e15]:
    - generic [ref=e17]:
      - region "Mixed reply styles scenario" [ref=e18]:
        - strong [ref=e19]: Alice + Bob · Launch planning
        - paragraph [ref=e20]: Current Reply opens a separate thread. Discord-style Reply stays in the current conversation with a source reference. Explicit named threads remain separate discussions. Switching style does not convert history.
        - paragraph [ref=e21]: Closing/reopening is shared lifecycle state. Join/Leave changes your subscription and retains authorized history. Notification preferences remain separate. Use Reply settings to change only your choice.
      - region "Handrail Chat Lab workspace" [ref=e22]:
        - navigation "Conversations" [ref=e24]:
          - generic [ref=e25]:
            - heading "Development workspace" [level=2] [ref=e26]
            - generic [ref=e27]:
              - generic [ref=e28]:
                - 'button "Set your status: Online" [ref=e30] [cursor=pointer]':
                  - generic [ref=e35]: Online
                - 'button "Development fixture identity: Bob" [ref=e37] [cursor=pointer]':
                  - generic [ref=e38]: B
              - button "Open theme settings" [ref=e42] [cursor=pointer]
              - group [ref=e46]:
                - generic "Reply settings" [ref=e47] [cursor=pointer]
                - option "Current"
                - option "Discord-style" [selected]
              - button "Add conversation" [ref=e49] [cursor=pointer]
          - generic [ref=e51]:
            - generic [ref=e52]:
              - generic [ref=e53]: Search conversations
              - searchbox "Search conversations" [ref=e54]
            - generic:
              - generic: "Keyboard shortcut:"
              - text: /
          - generic [ref=e55]:
            - region [ref=e56]:
              - heading [level=3] [ref=e57]:
                - button "Direct messages 1" [expanded] [ref=e58] [cursor=pointer]:
                  - generic [ref=e61]: Direct messages
                  - generic [ref=e62]: "1"
                - group "Direct messages actions" [ref=e63]:
                  - button "Create a direct conversation" [ref=e64] [cursor=pointer]
              - list "Direct messages 1" [ref=e68]:
                - listitem [ref=e69]:
                  - 'button "Alice, Notifications: All messages; Unmuted" [ref=e70] [cursor=pointer]':
                    - generic [ref=e71]: A
                    - generic [ref=e74]: Alice
                  - button "Star Alice" [ref=e75] [cursor=pointer]
            - region [ref=e76]:
              - heading [level=3] [ref=e77]:
                - button "Public channels 1" [expanded] [ref=e78] [cursor=pointer]:
                  - generic [ref=e81]: Public channels
                  - generic [ref=e82]: "1"
                - group "Public channels actions" [ref=e83]:
                  - button "Create public channel" [ref=e84] [cursor=pointer]
              - list "Public channels 1" [ref=e86]:
                - listitem [ref=e87]:
                  - 'button "Launch planning, Notifications: All messages; Unmuted" [ref=e88] [cursor=pointer]':
                    - generic [ref=e93]: Launch planning
                  - button "Star Launch planning" [ref=e94] [cursor=pointer]
            - region [ref=e95]:
              - heading [level=3] [ref=e96]:
                - button "Private channels 0" [expanded] [ref=e97] [cursor=pointer]:
                  - generic [ref=e100]: Private channels
                  - generic [ref=e101]: "0"
                - group "Private channels actions" [ref=e102]:
                  - button "Create private channel" [ref=e103] [cursor=pointer]
              - list "Private channels 0" [ref=e105]:
                - listitem [ref=e106]: No private channels yet.
            - region [ref=e107]:
              - heading [level=3] [ref=e108]:
                - button "Group conversations 1" [expanded] [ref=e109] [cursor=pointer]:
                  - generic [ref=e112]: Group conversations
                  - generic [ref=e113]: "1"
                - group "Group conversations actions" [ref=e114]:
                  - button "Create a group conversation" [ref=e115] [cursor=pointer]
              - list "Group conversations 1" [ref=e121]:
                - listitem [ref=e122]:
                  - 'button "Alice, Carol, Notifications: All messages; Unmuted" [ref=e123] [cursor=pointer]':
                    - generic [ref=e124]:
                      - generic [ref=e125]: A
                      - generic [ref=e128]: C
                    - generic [ref=e131]: Alice, Carol
                  - button "Star Alice, Carol" [ref=e132] [cursor=pointer]
            - region [ref=e133]:
              - heading [level=3] [ref=e134]:
                - button "Recent threads 1" [expanded] [ref=e135] [cursor=pointer]:
                  - generic [ref=e138]: Recent threads
                  - generic [ref=e139]: "1"
              - list "Recent threads 1" [ref=e140]:
                - listitem [ref=e141]:
                  - 'button "QA thread recovery 1788818260967, Notifications: Mentions only; Unmuted" [ref=e142] [cursor=pointer]':
                    - generic [ref=e148]: QA thread recovery 1788818260967
                  - button "Star QA thread recovery 1788818260967" [ref=e149] [cursor=pointer]
        - generic [ref=e151]:
          - generic [ref=e152]:
            - 'button "More actions for #Launch planning" [ref=e154] [cursor=pointer]'
            - generic [ref=e156]:
              - img "Public channel" [ref=e157]
              - heading "Launch planning" [level=2] [ref=e161]
            - group "Conversation actions" [ref=e162]:
              - button "Browse channel threads" [ref=e163] [cursor=pointer]: Threads
              - button "Search messages" [ref=e164] [cursor=pointer]
              - button "Open conversation members (4 members)" [ref=e165] [cursor=pointer]:
                - generic: "4"
              - 'button "Notification preferences: All messages; Unmuted" [ref=e167] [cursor=pointer]'
          - main "Public channel Launch planning" [ref=e168]:
            - generic [ref=e169]:
              - region "Conversation timeline" [ref=e170]:
                - region "Message timeline" [ref=e171]:
                  - feed "Message timeline" [ref=e173]:
                    - separator "Today, September 7, 2026" [ref=e174]:
                      - time [ref=e175]: Today
                    - article "Message from Alice" [ref=e176]:
                      - generic "Alice" [ref=e177]: A
                      - generic [ref=e179]:
                        - generic [ref=e180]:
                          - strong [ref=e181]: Alice
                          - time [ref=e182]: 4:11 PM
                        - generic [ref=e183]:
                          - paragraph [ref=e184]: Which launch date?
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e185]:
                            - button "Add reaction"
                        - button "Open thread with 3 replies" [ref=e186] [cursor=pointer]: 3 replies
                    - article "Message from Bob" [ref=e187]:
                      - generic "Bob" [ref=e188]: B
                      - generic [ref=e190]:
                        - generic [ref=e191]:
                          - strong [ref=e192]: Bob
                          - time [ref=e193]: 4:19 PM
                        - generic [ref=e194]:
                          - 'button "Jump to original message. Reply to Alice: Which launch date?" [ref=e196]': "Reply to Alice: Which launch date?"
                          - paragraph [ref=e197]: Friday
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e198]:
                            - button "Add reaction"
                        - button "Open thread with 1 reply" [ref=e199] [cursor=pointer]: 1 reply
                    - article "Message from Alice" [ref=e200]:
                      - generic "Alice" [ref=e201]: A
                      - generic [ref=e203]:
                        - generic [ref=e204]:
                          - strong [ref=e205]: Alice
                          - time [ref=e206]: 4:28 PM
                        - generic [ref=e207]:
                          - paragraph [ref=e208]: Archived launch notes
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e209]:
                            - button "Add reaction"
                        - button "Open thread with 1 reply" [ref=e210] [cursor=pointer]: 1 reply
                    - article "Message from Bob" [ref=e211]:
                      - generic "Bob" [ref=e212]: B
                      - generic [ref=e214]:
                        - generic [ref=e215]:
                          - strong [ref=e216]: Bob
                          - time [ref=e217]: 4:53 PM
                        - generic [ref=e218]:
                          - paragraph [ref=e219]: QA thread recovery 1788818024266
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e220]:
                            - button "Add reaction"
                        - button "Open thread with 2 replies" [ref=e221] [cursor=pointer]: 2 replies
                    - article "Message from Bob" [ref=e222]:
                      - generic [ref=e223]:
                        - generic [ref=e224]:
                          - paragraph [ref=e225]: QA thread recovery 1788818074258
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e226]:
                            - button "Add reaction"
                        - button "Open thread with 2 replies" [ref=e227] [cursor=pointer]: 2 replies
                    - article "Message from Bob" [ref=e228]:
                      - generic [ref=e229]:
                        - generic [ref=e230]:
                          - paragraph [ref=e231]: QA thread recovery 1788818141724
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e232]:
                            - button "Add reaction"
                        - button "Open thread with 2 replies" [ref=e233] [cursor=pointer]: 2 replies
                    - article "Message from Bob" [ref=e234]:
                      - generic [ref=e235]:
                        - generic [ref=e236]:
                          - paragraph [ref=e237]: QA thread recovery 1788818260967
                          - toolbar "Message actions":
                            - button "Reply"
                            - button "Open Thread"
                            - button "Save"
                            - button "Copy"
                            - generic:
                              - button "More message actions"
                        - group "Reactions":
                          - generic [ref=e238]:
                            - button "Add reaction"
                        - button "Open thread QA thread recovery 1788818260967 with 2 replies" [ref=e239] [cursor=pointer]: QA thread recovery 1788818260967 · 2 replies
                  - status [ref=e240]
              - region "Conversation thread" [ref=e241]:
                - complementary "QA thread recovery 1788818260967" [ref=e242]:
                  - generic [ref=e243]:
                    - heading "QA thread recovery 1788818260967" [level=2] [ref=e244]
                    - button "Close panel" [ref=e245] [cursor=pointer]
                  - article "Thread root message" [ref=e246]:
                    - generic [ref=e247]:
                      - strong [ref=e248]: Bob
                      - time [ref=e249]: 9/7/2026, 4:57:44 PM
                      - generic [ref=e250]: In Launch planning
                    - paragraph [ref=e251]: QA thread recovery 1788818260967
                  - generic [ref=e252]:
                    - generic [ref=e253]:
                      - generic [ref=e254]:
                        - generic [ref=e255]: 2 replies
                        - generic [ref=e256]: 0 unread
                        - generic [ref=e257]: 1 participant
                      - generic [ref=e258]:
                        - group "Thread controls" [ref=e259]:
                          - button "Join" [ref=e260] [cursor=pointer]
                          - 'button "Thread notification preferences: Mentions only; Unmuted" [ref=e263] [cursor=pointer]'
                          - button "Mark read" [disabled] [ref=e264]
                        - generic [ref=e265]:
                          - status [ref=e266]: Thread open.
                          - group "Shared thread lifecycle" [ref=e267]:
                            - button "Close thread" [ref=e268] [cursor=pointer]
                            - button "Lock thread" [ref=e269] [cursor=pointer]
                      - region "Thread replies" [ref=e270]:
                        - feed "Thread replies" [ref=e272]:
                          - separator "Today, September 7, 2026" [ref=e273]:
                            - time [ref=e274]: Today
                          - article "Message from Bob" [ref=e275]:
                            - generic "Bob" [ref=e276]: B
                            - generic [ref=e278]:
                              - generic [ref=e279]:
                                - strong [ref=e280]: Bob
                                - time [ref=e281]: 4:57 PM
                              - generic [ref=e282]:
                                - paragraph [ref=e283]: QA thread recovery 1788818260967 history
                                - toolbar "Message actions":
                                  - button "Reply"
                                  - button "Save"
                                  - button "Copy"
                                  - generic:
                                    - button "More message actions"
                              - group "Reactions":
                                - generic [ref=e284]:
                                  - button "Add reaction"
                          - article "Message from Bob" [ref=e285]:
                            - generic [ref=e286]:
                              - generic [ref=e287]:
                                - 'button "Jump to original message. Reply to Bob: QA thread recovery 1788818260967 history" [ref=e289]': "Reply to Bob: QA thread recovery 1788818260967 history"
                                - paragraph [ref=e290]: QA thread recovery 1788818260967 inline after Leave
                                - toolbar "Message actions":
                                  - button "Reply"
                                  - button "Save"
                                  - button "Copy"
                                  - generic:
                                    - button "More message actions"
                              - group "Reactions":
                                - generic [ref=e291]:
                                  - button "Add reaction"
                        - status [ref=e292]
                    - generic [ref=e293]:
                      - generic [ref=e294]: Reply to thread
                      - toolbar "Text formatting" [ref=e295]:
                        - button "Bold" [ref=e296] [cursor=pointer]
                        - button "Italic" [ref=e299] [cursor=pointer]
                        - button "Strikethrough" [ref=e302] [cursor=pointer]
                        - button "Insert link" [ref=e305] [cursor=pointer]
                        - button "Ordered list" [ref=e308] [cursor=pointer]
                        - button "Bulleted list" [ref=e311] [cursor=pointer]
                        - button "Inline code" [ref=e315] [cursor=pointer]
                        - button "Code block" [ref=e318] [cursor=pointer]
                      - textbox "Reply to thread" [ref=e322]
                      - generic [ref=e324]:
                        - toolbar "Message tools" [ref=e325]:
                          - generic "Attach files" [ref=e326] [cursor=pointer]:
                            - button "Attach files" [ref=e330]
                          - button "Choose emoji" [ref=e332] [cursor=pointer]
                          - button "Mention a participant" [ref=e337] [cursor=pointer]
                        - status [ref=e342]: Message sent.
                        - button "Send message" [disabled] [ref=e343]: Send
                    - status [ref=e344]: Thread left. History and preferences are retained.
          - generic "Conversation composer" [ref=e345]:
            - generic [ref=e346]:
              - status
            - generic [ref=e347]:
              - generic [ref=e348]: "Message #Launch planning"
              - toolbar "Text formatting" [ref=e349]:
                - button "Bold" [ref=e350] [cursor=pointer]
                - button "Italic" [ref=e353] [cursor=pointer]
                - button "Strikethrough" [ref=e356] [cursor=pointer]
                - button "Insert link" [ref=e359] [cursor=pointer]
                - button "Ordered list" [ref=e362] [cursor=pointer]
                - button "Bulleted list" [ref=e365] [cursor=pointer]
                - button "Inline code" [ref=e369] [cursor=pointer]
                - button "Code block" [ref=e372] [cursor=pointer]
              - 'textbox "Message #Launch planning" [active] [ref=e376]':
                - generic [ref=e377]: QA thread recovery 1788818260967 retained channel draft
              - generic [ref=e378]:
                - toolbar "Message tools" [ref=e379]:
                  - generic "Attach files" [ref=e380] [cursor=pointer]:
                    - button "Attach files" [ref=e384]
                  - button "Choose emoji" [ref=e386] [cursor=pointer]
                  - button "Mention a participant" [ref=e391] [cursor=pointer]
                - button "Send message" [ref=e395] [cursor=pointer]: Send
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
  62 |     await expect(panel.getByRole('button', { name: 'Join', exact: true })).toBeEnabled();
  63 |     await composer.getByRole('textbox').fill(`${name} retained channel draft`);
  64 |     await expect(flutter.getByRole('banner', { name, exact: true })).toBeVisible();
  65 |     await expect(flutter.getByRole('group', { name: new RegExp(`^Message 1 from bob ${name} history`) })).toBeVisible();
  66 |     await expect(flutter.getByRole('group', { name: new RegExp(`^Message 2 from bob.*${name} inline after Leave`) })).toBeVisible();
  67 |     await expect(flutter.getByRole('textbox', { name: 'Write a message', exact: true }).last()).toBeEnabled();
  68 |     await expect(flutter.getByRole('button', { name: 'Shared thread controls', exact: true })).toBeEnabled();
  69 |     await expect.poll(() => flutter.locator('body').ariaSnapshot()).toContain('Not following. Notifications: mentions.');
  70 |     await flutter.screenshot({ path: info.outputPath('recovered-thread-390x844.png') });
  71 |     await flutter.getByRole('button', { name: 'Thread subscriptions', exact: true }).click();
  72 |     await expect(flutter.getByRole('menuitem', { name: 'Join', exact: true })).toBeEnabled();
  73 |     await expect(flutter.getByRole('menuitem', { name: 'Notifications: all', exact: true })).toBeEnabled();
  74 |     expect(await flutter.getByRole('menuitem', { name: 'Retry loading subscriptions', exact: true }).count()).toBe(0);
  75 |     const status = await call(flutter, 'status');
  76 |     expect(status.provenance.sourceDigest).toBe(flutterLabProvenance().sourceDigest);
> 77 |     expect(status.diagnostics).not.toContain('snapshot_hydration_failed');
     |                                    ^ Error: expect(received).not.toContain(expected) // indexOf
  78 |     expect(errors).toEqual([]);
  79 |     await composer.getByRole('textbox').clear();
  80 |   } finally {
  81 |     await writeFile(info.outputPath('recovery.json'), JSON.stringify({ name, errors,
  82 |       semantics: await flutter.locator('body').ariaSnapshot(),
  83 |       exported: await call(flutter, 'export').catch(error => ({ error: error.message })) }, null, 2));
  84 |     await flutter.screenshot({ path: info.outputPath('recovery-390x844.png') });
  85 |     await context.close();
  86 |   }
  87 | });
  88 | 
```