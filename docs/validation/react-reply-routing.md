# React Reply routing by saved style

Selected item: `5068e48e-f6ac-4337-814d-8397341787b6`.
Validated against SDK HEAD `39c194f15a5d0f51faa521ba9c94e3c321fbf282` plus existing uncommitted prerequisite changes, 2026-09-06 (America/Chicago).

## Behavior and scope

Current mode retains Reply-to-thread behavior and its existing source eligibility. In Discord mode, Reply selects a source in the current conversation's composer. Channel, direct, group-direct and existing-thread sends retain their conversation ID and add `replyTo`; selecting Reply does not execute an open/create-thread command. Existing Open Thread controls remain independent.

`MessageTimeline.onReplyRequested`, `ChatMessageActions.selectReply` and `replyDisabledReason` provide additive host/slot plumbing to `ChatComposerControls.selectReply`. ChatWorkspace and ThreadPanel each bind their own composer controls. ThreadPanel also accepts `composerAvailability`, which is passed to its composer and inline Reply checks. Custom Composer slots retain the default controller; a fully host-rendered composer requires host-owned timeline/controller wiring and the default timeline explains its unavailable connection.

The effective saved style comes from `useReplyStyle`. Inline reply support must be explicitly advertised as `inlineReplies: true`; missing/false support disables Discord Reply with an accessible explanation. Preference-persistence availability is independently tested. Read-only, host send/membership restrictions, unavailable/archived conversations and inactive access prevent inline selection. Deleted/unsent sources preserve their hidden Reply entry point. Row callbacks validate identity/eligibility and invalidate retained callbacks after scope/style/availability changes or unmount.

Selection uses the existing composer implementation, preserving text, mentions, attachments and draft reply context. Switching style preserves selected metadata and open-thread identity. Pending sends retain their submitted destination and reply metadata even when the next draft source, style or selected conversation changes.

This patch is limited to four production files: `src/ui/message-timeline.ts`, `src/ui/slots.ts`, `src/ui/chat-workspace.ts`, `src/ui/thread-panel.ts`. Existing settings and rendered reply-reference changes were preserved. No generated contracts, SQL, Flutter, preview, persistent navigation/header controls, named-thread creation, discovery or lifecycle changes were needed. Changes remain uncommitted.

## Deterministic local verification

`node scripts/test-react-reply-routing.mjs` — **PASS**, exit 0:

- Fresh isolated source/declaration compilation using `tsconfig.react-reply-routing.json`: pass.
- Additive public API positive/negative checks using `tsconfig.react-reply-routing-type-tests.json`: pass.
- Selected `chat-workspace-default.test.mjs` cases: **21/21** (17 new routing cases plus 4 existing action/settings regressions).
- Selected `message-timeline-ui.test.mjs` reply/thread cases: **6/6**.
- Complete `thread-panel.test.mjs`: **30/30**.
- Selected `message-composer.test.mjs` reply cases: **7/7**.
- `thread-panel-import-guard.test.mjs`: **1/1**.

Total: **65 passing tests**. Compilation and test processes run sequentially, with `--test-concurrency=1` and 15-second per-test timeouts. The runner compiles into a new `build/react-reply-routing-*` directory, redirects every tested SDK import to that output, and removes it afterward. Existing `dist` output is not used. The mounted harness uses real React components, normalized cache and reply-style runtime with local client/server boundaries; assertions inspect actual composer send payloads. These are UI/client checks, not proof of database persistence or live-provider behavior.

`git diff --check -- src/ui/message-timeline.ts src/ui/slots.ts src/ui/chat-workspace.ts src/ui/thread-panel.ts test/chat-workspace-default.test.mjs test/message-timeline-import-guard.test.mjs test/thread-panel-import-guard.test.mjs` — pass.

## Separate pre-existing failure

`node --test --test-concurrency=1 test/message-timeline-import-guard.test.mjs` — **FAIL**, exit 1, allowlist assertion. The allowlist omits `../client/index.js`, `./reaction-picker.js`, and `./timeline-window.js`. Read-only comparison with `git show HEAD:src/ui/message-timeline.ts` and `git show HEAD:test/message-timeline-import-guard.test.mjs` confirms all three omissions existed at HEAD. This patch adds only its new type-only `./message-composer.js` import to the expected set; it does not repair the unrelated stale allowlist. The failing supplemental check is separate from the focused runner. Resource guard reported 24 MiB peak, zero swap and zero OOM kills.

No database, deployed environment, provider call or QA campaign was needed. This completes only the selected React routing item, not the broader convergence goal.
