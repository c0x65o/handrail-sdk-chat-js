# React ThreadPanel subscriptions and notification preferences

Implemented for Owner Task item `43a98fd4-f1b0-4eee-ab80-417122575312`.

`ThreadPanel` reads `useReplyStyle().effectiveStyle` from the public React API. Current (including the absent-runtime fallback) retains Follow/Unfollow; Discord-style displays Join/Leave. Both use the same conversation-bound `followThread`/`unfollowThread` actions. Leave changes the private subscription, retaining authorized history, the open panel and composer draft, notification/mute/star preferences, membership, read cursors and unread counts. It invokes no membership leave, mark-read, panel dismissal or shared lifecycle command.

The compact reusable notification control reads the thread's confirmed cache preference, including canonical values retained underneath optimistic updates. All/mentions/none and unmuted/indefinite/timed mute remain independent, and writes preserve the confirmed star value. Missing preferences have a loading/unavailable state and explicit thread-detail retry; they never acquire fabricated defaults. Pending writes are guarded against duplicates. Failures retain editable choices; conflicts show reconciled authority and allow another explicit save. Subscription failures have a visible live announcement and Retry subscription action.

Escape belongs to the notification dialog, including while saving. Successful dismissal restores its trigger focus without closing the thread. Explicit subscription retry restores focus to the subscription button. Existing lifecycle implementation and regression cases remain intact.

## Local verification

Command, run sequentially:

```sh
node scripts/test-react-thread-lifecycle.mjs > build/react-thread-subscriptions-results.log 2>&1
git diff --check
```

Result: fresh scoped TypeScript compilation passed; **90 tests passed, 0 failed, 0 skipped**. Whitespace check passed.

The harness runs `node node_modules/typescript/bin/tsc -p tsconfig.react-reply-routing.json --outDir <unique build/react-thread-lifecycle-* directory>`, rewrites the test imports into that fresh output, and runs Node with `--test --test-concurrency=1 --test-timeout=15000`. Coverage includes ThreadPanel DOM tests, reusable notification-preference DOM tests, the panel import-boundary guard, and client lifecycle tests. Temporary compiled output is removed afterward; it does not depend on existing `dist` output.

New DOM cases prove both styles' label/API mapping and retained state on Leave, subscription rejection/conflict retry and focus, independent notification/mute saves and star reconciliation, loading/read retry, pre-existing optimistic updates, duplicate suppression, and nested Escape at a 360px viewport. The first development run found incomplete new draft fixtures; those were corrected before the passing final run. No unrelated baseline failures appeared in the scoped checks.

This is deterministic React/Happy DOM and client/cache verification. It does not claim browser layout, PostgreSQL persistence, provider delivery, Flutter validation, or deployed QA. No SQL behavior or generated contracts changed. Existing unrelated Flutter edits were preserved. The patch remains uncommitted.
