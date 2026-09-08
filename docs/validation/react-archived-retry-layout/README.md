# Archived-thread Retry layout

Work request: `23102786-a102-48ac-b4b6-c8380cdedad3`.
Campaign: `e86154cb-28b8-4a74-85be-3140ec99a04f`.
Validated 2026-09-07.

## Failure boundary and fix

Handrail MCP confirmed the current work request and a healthy supervised Chat
Lab service. This is an application layout failure. Before changing product
source, the new browser regression reproduced a failed Retry center hit-test
at 1280×720 using real HTTP 401 responses from the existing lab backend.
Authorization was removed only from the archived detail/messages GETs;
directory lookups retained normal credentials. No HTTP responses were fabricated.
The attachment image was available in the request; its resolved JSON attachment
path was absent in this worker, so that JSON was not independently inspected.

The panel had three explicit grid rows, but a retained thread binding causes it
to render four children: header, root, recovery alert, and conversation. The
alert occupied the shrinking third row while controls occupied an implicit
fourth row, covering Retry. Named grid areas now reserve an intrinsic-height
recovery row above the remaining conversation area. Loading and initial-error
states still use the body area. Existing controls, history, and composer
scrolling remain intact.

- [Before at 1280×720](before-1280x720.png)
- [After at 1280×720](retry-1280x720.png)
- [1280×720 hit-test and HTTP evidence](retry-reads-1280x720.json)
- [1440×1000 evidence](retry-reads-1440x1000.json)
- [390×844 evidence](retry-reads-390x844.json)

At 1280×720, the recovery alert ends at y=484.98 and thread controls start at
y=509.17. The Retry center hits the button itself. After restoring credentials,
a normal Playwright click starts both detail and messages GETs, each returning
200, and removes the failed-read alert. All three viewport sizes pass.

## Verification

- `npm run build`: passed, including full TypeScript compilation.
- `node --test --test-concurrency=1 test/thread-panel.test.mjs test/thread-panel-import-guard.test.mjs test/ui-styles.test.mjs`: 90 passed.
- New `chat-lab.archived-retry-layout.spec.mjs`: passed in Chromium at all three
  sizes. The test failed its center hit-test before the source fix.
- Existing `chat-lab.thread-controls-layout.spec.mjs` and
  `chat-lab.thread-notification-layout.spec.mjs`: both passed.
- `git diff --check`: passed.

Browser commands ran from `examples/drop-in-react` with
`PLAYWRIGHT_BROWSERS_PATH` pointing to `build/playwright-browsers`,
`--project=chromium --workers=1 --retries=0 --reporter=list`.
The existing Chat Lab fixture used URL-backed real PostgreSQL with production
migrations/routes and a disposable schema, including its documented archived
thread setup control. No new database harness was introduced. This verifies
real authorization denial and subsequent successful reads, not a persistence
change. The managed campaign service was not re-seeded. Vite logged socket
EPIPE/ECONNRESET during browser navigation; tests completed successfully. MCP
service diagnostics showed prior socket resets and no matches for authorization
or 401 in the available managed-service log tail.

## Separate follow-up observed

After the real 401 is followed by successful Retry reads, the existing lifecycle
state can remain `access_revoked`: the panel still says “Thread lifecycle change
denied. Your draft is retained.” and hides the history. An exploratory assertion
requiring restored history failed for this reason, after both requested reads
returned 200. The new regression covers this work request's layout and read
dispatch acceptance checks; it does not claim full lifecycle recovery. A separate
client recovery change should clear/reconcile stale lifecycle denial following
an authorized snapshot, with a browser assertion that history is restored.

Existing sibling workspace changes were preserved. No commit, push, PR, or
Handrail database/queue mutation was performed.
