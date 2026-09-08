# React lifecycle recovery after inline thread send

Work request: `77a8e99c-5597-4fa1-90f4-f6f5e4b8411c` (2026-09-07).
Accepted finding: `cd3ecc15-2c77-491c-983a-2c11ffd6cc0f`.
Campaign: `298e20b4-4faf-4283-949d-3801cf437aa8`, dev.
Campaign work request: `8ff41fa4-8f28-4ee9-b884-7e87614c7db5`;
campaign run: `fee77ab0-0d2f-42ba-825f-82575519ddf8`.

## Failure boundary and change

Source inspection and failing regression tests establish an application-client
failure boundary: `src/client/thread-lifecycle.ts` cancels in-flight work and
clears lifecycle authority when cached thread or parent membership changes. It
previously left the entry `idle` without scheduling hydration. The mounted
`useThreadLifecycle` hook does not reload on that state change, and ThreadPanel
renders both `idle` and `loading` as “Loading thread lifecycle…”. Reopening the
panel runs the hook's mount effect, explaining the recovery mechanism.

The runtime now starts a fresh scoped lifecycle read after that invalidation.
It retains cancellation and authorization checks: old reads cannot restore
authority, and a denied refresh purges it. The change does not infer moderation
permission from a successful send or from subscription state.

This deterministically reproduces and repairs the stranded-state boundary. The
missing transport attachment prevents confirming which exact campaign event
changed membership. No claim is made that every thread send triggers it, or
that a runtime/configuration change is required.

## Preserved campaign evidence

All paths below are under `campaigns/298e20b4-4faf-4283-949d-3801cf437aa8/`.
The three screenshots were reviewed as supplied image inputs:

- [26-inline-reply-existing-thread.png](/api/pm/qa-campaign-artifacts/65e98721-5097-4684-a757-05610fdc525a/content): retained history and the sent inline reply are visible alongside lifecycle loading and the thread-left status.
- [34-react-lifecycle-loading.png](/api/pm/qa-campaign-artifacts/abd11d1f-f74f-4095-8c67-a5308e976422/content): the same loading state persists; the work request records observation at 17:56:29 after the 17:53 send, including after returning focus.
- [27-locked-thread.png](/api/pm/qa-campaign-artifacts/23f13da3-29a2-4b25-857a-f92c467e882c/content): recovered lifecycle controls show the locked state and Unlock action; the work request records recovery through discovery.

These JSON artifacts were referenced but **not readable**: their resolved
attachment files do not exist in this worker. Their references are preserved
without claiming transport inspection:

- [react-lifecycle-still-loading.json](/api/pm/qa-campaign-artifacts/2306ded9-68bd-4ed2-9b3e-19cc545352a3/content), supplied SHA-256 `c0d053d53bc5be3043dcfb724607ea4d57a9a65e1b88ab83238084cb93d93568`.
- [transport.json](/api/pm/qa-campaign-artifacts/3fcfe99d-4e30-4827-ba46-bde22082e558/content), supplied SHA-256 `91b5d299e6aec63b264b1b234c21b8a41e57fbc630a5ebae50ecb9412804516c`.

## Verification

- Before the production edit, the two focused membership-invalidation tests
  failed with `idle` instead of `loading`/`ready`.
- `node scripts/test-react-thread-lifecycle.mjs`: **92 passed, 0 failed**.
  This first compiles the production React/client/UI source using
  `tsconfig.react-reply-routing.json` into isolated output, then runs tests with
  `--test-concurrency=1`. Output: `build/react-inline-send-lifecycle.log`.
- Added DOM coverage performs Leave, selects inline Reply on retained history,
  sends within the thread while applying a membership snapshot refresh, then
  successfully locks the thread without remounting. Subscription remains left.
- Runtime coverage verifies automatic recovery after both ready-state and
  in-flight invalidation, stale-response rejection, and refresh denial.
- `git diff --check`: passed.

The existing normalized cache and lifecycle runtime are exercised with narrow
snapshot/command/client-method test boundaries. No database persistence or live
dev replay is claimed. Flutter is unchanged; its suggested reducer check was
not needed for this React/client fix. No deployment, database/queue mutation,
commit, push, or PR was performed. Existing sibling workspace changes were
preserved.
