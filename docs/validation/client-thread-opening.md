# TypeScript named creation and existing-thread opening

Validated 2026-09-06 on SDK HEAD `183fb79`, for Owner Task item
`a2fad124-debd-4340-92c0-379efa89c0ec`.

## Behavior and changed files

- `src/client/create-chat-client.ts`: adds `createThread({rootMessageId,name?})`
  through the legacy root-opening machinery. The first validated name and
  idempotency key survive explicit retries. Competing named/legacy calls share
  one opening; returned conversation IDs/names remain canonical. Known nested
  creation fails before dispatch, with server validation retained for unknown roots.
- The same file adds `openExistingThread(threadId)`,
  `getExistingThreadOpeningState`, and `subscribeExistingThreadOpening`.
  These use authorized detail/timeline reads and the existing retained realtime
  subscription mechanism. They do not dispatch creation, join, follow, or read
  writes. Existing-thread state has no creation reconciliation outcome; the
  legacy state and listeners keep their types and semantics.
- `src/client/normalized-cache.ts`: atomically publishes authorized thread
  detail/history with fresh root context; removes unavailable source content;
  preserves newer message revisions; discards cached thread history and detail
  after authorization rejection. Drafts and participation authority are preserved.
- `test/client-thread-opening.test.mjs`: focused legacy/named/read-only coverage.
- `type-tests/client-thread-opening.test.ts`: public APIs, branded IDs, name
  input, and compatibility checks. Existing `src/client/index.ts` wildcard exports
  expose the additive types without an export-file change.
- `tsconfig.client-thread-opening.json` and
  `tsconfig.client-thread-opening-type-tests.json`: scoped production emission
  and type verification.

This enables named separate discussions and reading them by canonical ID while
preserving current root-based opening. It does not implement inline replies,
settings, UI, discovery, or lifecycle transitions.

## Exact verification

Run sequentially from the SDK repository:

```sh
node node_modules/typescript/bin/tsc --project tsconfig.client-thread-opening.json
node node_modules/typescript/bin/tsc --project tsconfig.client-thread-opening-type-tests.json
node --test --test-concurrency=1 test/client-thread-opening.test.mjs
git diff --check
```

All passed. The production compile freshly emitted the client and dependencies
into ignored `dist`; the opening tests import that emitted code. Opening suite:
**33 passed, 0 failed, 0 skipped**. Coverage includes named creation and canonical
existing-for-root names, competing calls, stable key/name across command/detail/
timeline retries, deleted/missing roots, unfollowed read-only access, archived
history without lifecycle changes, 401/403/404 access loss, cancellation,
eviction, reconnect, subscription release, stale-source suppression, atomic
hydration failure, and canonical conversation/message search link IDs.

Additional adjacent checks:

```sh
node --test --test-concurrency=1 test/client-thread-opening.test.mjs test/normalized-cache.test.mjs test/client-thread-follows.test.mjs
```

Result: **54 passed, 2 failed**. Both failures reproduce with the two changed
production files replaced by their `git show HEAD:<path>` versions in a separate
scratch source tree (the workspace patch was never reverted):

- `client-thread-follows.test.mjs:360`: expected `authentication`, got `rejected`
  for the existing explicit follow request's 403 response.
- `normalized-cache.test.mjs:668`: existing optimistic preference fixture omits
  required `isStarred`; the canonical input parser rejects it.

The isolated baseline was compiled with client/root entry points and executed:

```sh
node --test --test-concurrency=1 --test-name-pattern='conflict adopts canonical state|stale list preferences' test/client-thread-follows.test.mjs test/normalized-cache.test.mjs
```

Both failed identically. These existing failures are outside the selected item;
no preference/follow implementation or fixtures were changed.

## Limits and workspace boundary

Root context lookup is bounded to its known sequence or the latest 50 parent
messages. An older uncached root may therefore be `unavailable` while accessible
thread history opens. Every explicit existing-thread open revalidates access;
reconnect uses the settled realtime subscription authorization path.

Tests use the existing HTTP/socket/clock boundaries, not a persistence fake.
No database testing was necessary. No production Dart or generated contracts
changed, so Dart analysis/generation was not required. No UI/browser, provider,
preview-repository, deployment, or global project checks were run.

Sibling server send/reopen, edit, and attachment changes were preserved.
The patch remains uncommitted. The work-request publication flags were verified
disabled; no commit, push, PR, deployment, or end-trigger publication was invoked.
