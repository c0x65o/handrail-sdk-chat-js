# Recent thread navigation

Work request `ba8c4c5f-fd0f-4cef-8684-dc4f670d08b7`, campaign
`2f092552-e76f-48fb-bd55-8b4ee0e6e849`. Repository verification, 2026-09-07.

The failure boundary is SDK application code. The PostgreSQL conversation-list
query deliberately excludes threads, while React navigation previously rendered
only that list's IDs. Canonical thread creation/opening and incoming durable
events populate normalized conversation entities without adding top-level list
IDs. The creation regression reproduced the reported sidebar count of zero
against the previous build. No environment or provider configuration change is
needed.

React navigation now includes canonical threads encountered during the session
when their parent is visible in the current conversation-list scope. The section
is labelled **Recent threads**, with an explanatory tooltip and an empty state
directing users to channel discovery. Discovery remains the complete authorized
channel listing; the sidebar is not a workspace-wide count of followed threads.
An unopened thread returned only by discovery need not appear in recent threads
until opened. Reloading starts from the available session cache. No follow,
membership, notification, lifecycle, or server-list semantics change.

Canonical IDs prevent duplicates. A thread-free list refresh retains recent
entries; parent removal, administrative archive, and cache reset remove them.
Entity-scoped navigation cannot acquire threads from another cached parent.
Existing navigation selection, search, keyboard behavior, and host list entries
are reused.

Regression coverage uses the existing React DOM fixtures, real normalized cache
and durable reducer, and the real thread-discovery runtime with an HTTP-reader
boundary fixture. It proves creation immediately changes the sidebar from zero
to one, Active and All discovery return the same canonical named thread, incoming
events update navigation, repeated hydration does not duplicate it, and parent
scope/archive/reset cleanup works. The modified creation test also updates its
outdated dismiss selector from `Close thread` to the current `Close panel` label.
No SQL persistence behavior is changed or claimed by these tests.

Checks:

- `npm run build`: passed, including TypeScript compilation. Its incidental
  generated version update was reverted; the worker owns version changes.
- `./node_modules/.bin/tsc --project tsconfig.json`: passed after restoring the
  generated version source. Final runtime tests used the normal build pipeline's
  output, matching `package.json`, while the version source was left unchanged.
- `node --test --test-concurrency=1 --test-name-pattern='recent thread navigation|named thread dialog creates a discussion' test/chat-workspace.test.mjs test/chat-workspace-default.test.mjs`:
  all three regression tests passed.
- `flutter test --no-pub --concurrency=1 test/durable_resource_event_reducer_test.dart`:
  all 43 tests passed, using the installed SDK's `flutter_tools.snapshot` entry
  point with `FLUTTER_ALREADY_LOCKED=true`, `--no-version-check`, and
  `--suppress-analytics`. The SDK emitted nonfatal read-only stamp warnings.
- `git diff --check`: passed.

The broader workspace/thread-panel/browser-graph set has existing failures.
A baseline comparison using the unchanged HEAD workspace implementation and
unchanged test files confirmed 16 failures: old panel-close selectors, navigation
and participant expectations, unavailable-creation fallback, preference fixtures,
and the UI import allowlist. The final patched run completed **240 tests: 225
passed, 15 failed**. Comparing failure names found no new failures; the corrected
creation test now passes. Logs `sidebar-baseline-tests.log` and
`sidebar-patched-tests.log` are retained in the worker's temporary directory.
The initial nested baseline launch stalled and was interrupted; the direct,
time-bounded baseline run completed normally. A later broad run was interrupted
after stalling in a Forward test; the final normal-build run completed in 20
seconds with 328 MiB peak memory, no swap, and no OOM kills.

No deployed browser rerun was performed. Existing unrelated Chat Lab changes
were preserved. No database/queue edits, deployment, dependency changes, commits,
pushes, or PRs were performed.
