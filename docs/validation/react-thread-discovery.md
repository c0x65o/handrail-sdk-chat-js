# React channel thread discovery — deterministic validation

Selected item: `4791d4a6-07dc-4d24-a7ad-936b628bb663`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`, task
`6ed34db0-9963-45d8-87b2-5635fb3b6a73`.
Implemented on `main`, HEAD `c41d76931ccbd48c5c1b5ff6dc0788d00530ddd8`.
The patch remains uncommitted.

## Behavior and changed files

Current retains its root-message thread entry points. Discord-style adds a
channel-header Threads entry for authorized discussions, including unfollowed
threads. Discovery and inline Reply remain separate actions. Both styles use the
same existing canonical thread streams; there is no history conversion, duplicate
creation, or change to another user's preference.

- `src/ui/thread-list.ts`: public focused component using `useThreadList` and the
  existing runtime's subscription, refresh, pagination, failed-page retry and
  revocation. Displays canonical names or “Unnamed thread,” independently labelled
  following and unread counts, loading/loading-more, empty, error and unavailable
  states. Active/All appears only when a backend result advertises lifecycle or
  inactivity policy support; the UI does no independent history filtering.
  Native row buttons support Arrow Up/Down, Home/End, Enter/Space activation and
  Escape return. Only one row is a tab stop. Hidden discovery stays subscribed
  while its selected history is visible, allowing focus restoration and prompt
  access invalidation.
- `src/ui/chat-workspace.ts`: effective reply-style header entry and scoped
  selection. Parent/client/tenant/user changes invalidate discovery selection and
  late opens; style changes retain the selected thread, composer and drafts.
  Back returns to the list row, then parent/header (or main when Current removes
  the trigger). Denied list refresh also dismisses an open cached history.
  Existing huddle, search, members, settings, root links, named creation and host
  rendering remain. When a host supplies `renderThread`, it retains ownership;
  built-in discovery is omitted, matching named-creation integration. Hosts may
  compose the exported `ThreadList` and canonical `ThreadPanel` themselves.
- `src/ui/thread-panel.ts`: optional `threadConversationId` together with
  `parentConversationId` selects the read-only canonical opening path; the existing
  required `rootMessageId` still identifies context even when its message is absent.
  Subscribes to existing opening state, validates parent/root/thread/tenant
  identities, and retries `openExistingThread`, never root-based reconciliation.
  Missing/deleted roots get safe context; missing or denied cached history is not
  rendered. The existing timeline, composer, explicit follow/read controls and
  normal viewed-message read tracking are reused. Legacy root-only callers keep
  their existing behavior.
- `src/ui/styles.css`: wrapping, reachable controls and a scrollable list within
  the existing responsive thread column.
- `src/ui/index.ts`: exports ThreadList and its props/selection types.
- `test/react-thread-discovery.cases.mjs`: 18 focused DOM cases, using the existing
  workspace fixture and the real discovery runtime with its service boundary
  replaced. Includes unfollowed/read independence, legacy names, 50-row failed-page
  retry without duplicates, loading/empty/unavailable/error recovery, backend
  capability controls, Current compatibility, style/draft preservation, simulated
  320px ResizeObserver layout, keyboard return/focus, custom host rendering,
  unavailable/deleted roots, canonical retry, late parent/client/identity changes,
  wrong identities, and access loss before and after opening.
- `scripts/test-react-thread-discovery.mjs`: compiles fresh production output and
  registers those cases with a temporary copy of the established workspace test
  fixture. No duplicate fixture or stale dist imports are introduced.

## Executed verification

Expensive checks ran sequentially with `--test-concurrency=1`; the discovery
runner's suites use a 15-second per-test timeout. Each runner compiles into a
fresh unique local build directory, rewrites imports to that output and removes
that directory in `finally`.

1. `node scripts/test-react-thread-discovery.mjs`: **124 passed, 0 failed**:
   18 discovery DOM, 6 timeline, 30 ThreadPanel, 33 client opening, 7 composer,
   1 panel import guard, and 29 client discovery/hook/canonical-opening cases.
   Includes `tsc -p tsconfig.react-reply-routing.json --outDir <fresh output>`
   and `tsc -p tsconfig.react-reply-routing-type-tests.json`, both passed.
2. `node scripts/test-react-named-threads.mjs`: **115 passed, 0 failed**:
   38 workspace/named-creation/routing/settings, 6 timeline, 30 ThreadPanel,
   33 client opening, 7 composer and 1 import guard. Both production and public
   type compilations passed again against the final integration.
3. Scoped `git diff --check`: passed. New runner and case module syntax checks
   passed with `node --check`.

The opening assertions use no viewed thread messages and observe no create,
root-open, follow/unfollow or mark-read calls. Separate client tests exercise the
actual canonical opening implementation at its transport boundary. Existing
regressions also cover inline reply metadata and queued send destinations.

Initial fixture failures were corrected: discovery properly preferred an equally
recent cached canonical name over a contradictory list fixture, and an omitted
legacy name must be absent rather than an explicitly undefined wire field.
Neither required a runtime change.

## Preservation and limits

The pre-existing named-thread edits in ChatWorkspace, ThreadPanel and styles were
retained. The lifecycle panel item's ledger was ready and its prior linked work
was no longer active when the shared file was inspected; this patch contains no
lifecycle controls. Sibling changes in action-hooks, message-timeline, slots,
workspace/panel tests, type tests and all Flutter files/deletions/untracked work
remain. The existing named-thread runner is unchanged.

Happy-dom plus a deterministic ResizeObserver boundary proves DOM state, focus
and scoped behavior, not real-browser pixel geometry, device interaction or live
server authorization. No QA campaign, backend/SQL change, database harness,
Flutter/example change, generated descriptor output, provider call, deployment,
commit, push or PR was needed or performed. This completes only React discovery;
it does not claim completion of the wider convergence goal.
