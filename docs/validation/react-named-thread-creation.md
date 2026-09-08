# React named-thread creation — local validation

Selected item: `d3d73060-e7d6-4e2f-997d-0bd2179bea9b` under Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`.
Inspected and left on `main`, HEAD `c41d76931ccbd48c5c1b5ff6dc0788d00530ddd8`.
Patch is uncommitted.

## Behavior and files

- `src/react/action-hooks.ts` exposes the typed public `createThread` bridge.
- `src/ui/message-timeline.ts` and `src/ui/slots.ts` add optional named-creation
  callbacks for host renderers. Discord-style Reply still composes in the current
  conversation; Create Thread independently requests an explicit name. Existing
  roots offer Open Thread and retain their reply-count links. Current Reply keeps
  its existing thread entry. Cached canonical names appear on root links in both
  styles. Stale row callbacks cannot navigate after their conversation unmounts.
- `src/ui/chat-workspace.ts` owns the dialog request and local name drafts, scoped
  to the client and tenant/user. `src/ui/thread-creation-dialog.ts` calls the existing
  canonical name validator (1–100 Unicode scalar values, trimmed, no unpaired
  surrogates) and client creation/reconciliation; it adds no persistence or
  transport implementation. Creation requires `namedThreads` support, readiness,
  a usable non-thread parent/root and applicable workspace restrictions. Server
  eligibility and authorization remain authoritative. Existing thread entry does
  not require the new named-creation capability.
- The dialog has initial input focus, Tab/Shift+Tab containment, Escape/Cancel,
  inert background content, accessible validation/status/error text, a synchronous
  submission latch and explicit retry. Its submitted name is retained and becomes
  read-only across failure/dismiss/reopen, matching the client's retained command
  identity. Canonical existing-thread results retain the canonical name. Late
  completion after dismiss, conversation/identity change or root unavailability
  cannot open the panel. The separate channel composer retains text, reply target
  and pending-send destination.
- `src/ui/thread-panel.ts` shows the canonical name (legacy fallback: Thread) and
  visible parent context (channel/group name or readable conversation-type fallback).
  Dismissal remains navigation; follow/unread controls and thread composer remain.
  `src/ui/styles.css` wraps long names and keeps the dismiss control reachable.

## Executed checks

All expensive checks ran sequentially. Test processes use `--test-concurrency=1`
and a 15-second per-test timeout. Each runner compiles production into a unique
local temporary directory and rewrites test imports to that output, removing it
on completion; no stale `dist` imports are used.

- `node scripts/test-react-reply-routing.mjs`: passed, 65 tests, during initial
  integration (includes production compile and public type tests).
- `node scripts/test-react-named-threads.mjs`: passed on the final patch, including
  `tsc -p tsconfig.react-reply-routing.json --outDir <temporary directory>` and
  `tsc -p tsconfig.react-reply-routing-type-tests.json`. 115 tests passed:
  38 workspace, 6 timeline, 30 panel, 33 client thread-opening, 7 composer and
  1 panel import guard.
- Scoped `git diff --check`: passed.

New cases cover valid Unicode names, invalid/empty/untrimmed names, duplicate
submit and pending state, safe thrown service errors, retry into an existing
canonical thread without rename, cancellation preserving both drafts, focus
containment/restoration, late completion after cancel/navigation, capability and
read-only restrictions, excluded deleted/unsent roots, nested creation exclusion,
Current compatibility, custom renderer callbacks, retained stale callback denial,
and a 320px viewport shell/wrapping check. Existing tests additionally exercise
client idempotency, canonical competing names, root links, follow/unread behavior,
inline replies and frozen send destinations across style/navigation changes.

During harness development a relocated dynamic import initially still pointed
to `../dist/contracts/message-search.js`; the new runner rewrites all such imports
and the complete client suite now passes. This was a harness path issue.

## Limits and workspace preservation

The responsive check uses happy-dom and CSS assertions; it does not establish
real-browser pixel geometry or device QA. Client/service boundaries are mocked
for deterministic UI tests; existing client tests exercise the real client with
its transport boundary replaced. No SQL behavior changed or DB harness was needed.
No generated descriptor/template output is affected. No deployment, external
provider calls, QA campaign, commit, push or PR was performed.

The pre-existing Flutter baseline deletions, untracked Flutter routing validation
document, and concurrent Flutter named-thread implementation/test changes were
preserved. React discovery, lifecycle controls, Flutter parity and examples remain
outside this selected item.
