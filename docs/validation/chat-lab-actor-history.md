# Actor selection parent-history hydration

Work request `aac1961f-ed18-46f1-b92c-cc90872889f7`, campaign
`2f092552-e76f-48fb-bd55-8b4ee0e6e849`. Verified 2026-09-07.

## Failure boundary

This is Chat Lab client hydration, not message loss or an environment mismatch.
Handrail MCP confirmed the active work request and a healthy supervised `chat-lab`
service on port 4167. Its instance endpoint reported the configured `reply-styles`
seed profile and campaign instance `a76c8ed1e87191f2f8bc7668eb2d629a`.

A read-only request to the campaign parent history endpoint using Alice's lab
session returned HTTP 200 with exactly the root and Bob's Friday. Friday retained
the parent conversation ID and `replyTo.messageId` identifying Alice's root.
The supplied attachment filesystem paths were unavailable; the provided images,
live HTTP response, source inspection and independent browser reproduction were
used instead.

The fixture restores actor-specific sessionStorage caches. `useMessages` skips
its initial fetch when a timeline already exists. `ReplyScenarioSubscription`
previously subscribed to the parent without fetching missed history. The fix
loads the selected parent's latest authorized timeline on client readiness or
selection change, retaining the existing subscription and cancelling the read on
cleanup. It uses the SDK snapshot reader and normal cache merge; it does not
copy Bob's cache into Alice's session or change persistence or thread routing.

## Verification

- New `chat-lab.actor-history.spec.mjs`: failed before the source fix because
  Alice rendered zero Friday messages; passed afterward. The test preserves
  Bob's uninterrupted Reply -> Create Thread flow, checks SQL destination/source
  and one canonical thread, then verifies Alice's automatic return, channel
  reselect, second actor switch and reload. Each history check requires exactly
  one root and Friday with its source reference. Current Reply opens the same ID.
- Existing `chat-lab.reply-styles.spec.mjs`: passed, including live mixed styles,
  drafts, queued sends, named threads, lifecycle and retained history.
- Both browser tests used the existing real PostgreSQL schema-per-fixture harness
  with teardown, Chromium, one worker and zero retries. They ran separately so
  each received a fresh fixture. No mock database or shared fixture reset was used.
- `node examples/drop-in-react/node_modules/typescript/bin/tsc -p
  examples/drop-in-react/tsconfig.reply-styles.json --noEmit`: passed.
- `git diff --check`: passed. No Flutter source changed; the suggested Flutter
  reducer test does not exercise this React host hydration path.

Browser command from the SDK root (run separately for each spec):

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/build/playwright-browsers" node --env-file=.env examples/drop-in-react/node_modules/@playwright/test/cli.js test --config examples/drop-in-react/playwright.config.ts e2e/chat-lab.actor-history.spec.mjs --project=chromium --workers=1 --retries=0
```

No runtime configuration, Handrail database/queue state, commits, pushes or PRs
were changed. The supervised Vite service serves the edited frontend source;
no backend restart or reseed was required.
