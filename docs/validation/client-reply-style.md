# TypeScript reply-style runtime validation

Owner Task `06a9a03e-d57f-4009-80ae-0dfc2213081f`, Owner Goal
`0175981e-9e78-4a38-900a-e1148040c0a2`. Repository implementation and deterministic
local checks only; no QA campaign, database operation, external send, deployment,
commit, push or PR.

## Implemented behavior

`client.replyStyle` exposes `load()`, `getState()` / `select()`, `subscribe()`,
`update("current" | "discord")`, `retry()` and `configure()`.
`createChatClient({ replyStyle: { hostDefault, enforcedOverride }, ... })`
configures initial host policy. `configure()` replaces that policy; omitting an
option removes it. Host policy never persists a user preference.

The immutable snapshot separates effective style/origin/value-fallback reason,
confirmed saved state (including authoritative absence), requested unsaved choice,
read state/error, save state/error, capability, edit availability and disabled
reason. Precedence is override > confirmed saved value > host default > Current.
Unknown first-present values safely use Current without discarding the raw saved
string or falling through to a Discord default. A saved Current beats that default.

GET uses the shared snapshot reader, and PATCH uses the command dispatcher with
canonical request/result parsers, exact header/body idempotency keys and CAS
base revisions. HTTP 409 preference conflicts expose authoritative state and
retain explicit retry intent. Retry after a settled conflict creates a new key
and uses the latest confirmed revision. Transport/malformed/aborted outcomes keep
the exact request: explicit retry first GETs authority, then replays that request.
It does not replace a concurrent saved choice. Older replay results cannot regress
confirmed state or falsely mark a superseded choice saved. A different choice
cannot replace an unresolved request; settle it with `retry()` first. Reconnect
rehydrates without automatically resending a failed preference write.

Validated actor-private events use revision ordering on both socket and follower
cross-tab delivery paths. Only an exact pending mutation can acknowledge a save.
Foreign tenant/actor/stream, malformed, equal and older revisions are rejected.
Identity/session boundaries and cancellation generations exclude late reads and
writes, including switch-away-and-back. Events are disabled across a private-state
boundary until the connection is established for the new lifetime. The common
reducer validates this event and tracks delivery metadata; the focused runtime
owns preference state and never dispatches message/draft/thread/send mutations.

Current still means Reply opens a separate thread. Discord-style means future UI
Reply actions compose a referenced message in the current conversation, with
Create/Open Thread separate. This patch implements selection and synchronization
of that preference; changing action routing and adding controls remain separate
items. It does not convert history or change shared thread identity/lifecycle.

## Changed files

- `src/client/reply-style-runtime.ts`: focused runtime and public API types.
- `src/client/create-chat-client.ts`: configuration/API, startup/reconnect,
  socket/cross-tab event delivery and cleanup wiring.
- `src/client/snapshot-reader.ts`: canonical actor-private preference GET.
- `src/client/durable-event-reducer.ts`: strict event admission and revision-based
  delivery, with private-stream diagnostics.
- `src/client/index.ts`: public runtime type exports.
- `test/client-reply-style.test.mjs`: runtime/HTTP-boundary/client regression tests.
- `type-tests/client-reply-style.test.ts`: supported public API and rejected inputs.
- `scripts/test-client-reply-style.mjs`: sequential fresh compilation and tests.
- `tsconfig.client-reply-style.json`: scoped production compilation.
- `tsconfig.client-reply-style-type-tests.json`: scoped public type checks.
- `test/durable-events-generation.test.mjs`: registry assertion now includes all
  registered event cases, including reply style and already-integrated lifecycle.
- `docs/validation/client-reply-style.md`: this evidence and API handoff.

## Exact verification commands and results

Run from the SDK root, sequentially:

```sh
node scripts/test-client-reply-style.mjs
node scripts/test-client-thread-list.mjs
node scripts/test-client-message-context.mjs
node --test --test-concurrency=1 --test-name-pattern='descriptor generates all live reducer durable types' test/durable-events-generation.test.mjs
git diff --check -- src/client/create-chat-client.ts src/client/durable-event-reducer.ts src/client/index.ts src/client/snapshot-reader.ts test/durable-events-generation.test.mjs
```

All exited 0. Final reply-style suite: **45 passed**, no failures or skips.
Thread/list/lifecycle/opening regression runner: **84 passed**. Message-context
runner: **42 passed**. Registry check: **1 passed**. Diff whitespace check passed.
Each focused client runner compiles into its own fresh temporary output directory
before importing JavaScript and removes that directory afterward. Tests use
`--test-concurrency=1`; compilation and public type checks run sequentially.
The new runner executes:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.client-reply-style.json --outDir <fresh-build-directory>
node node_modules/typescript/bin/tsc -p tsconfig.client-reply-style-type-tests.json
node --test --test-concurrency=1 test/client-reply-style.test.mjs
```

The test command receives `HANDRAIL_REPLY_STYLE_BUILD` pointing to that fresh
output. Initial compile/test findings were corrected before the final passing
run; no unresolved scoped or unrelated test failures were observed in these checks.

Coverage includes absence/unknown/loading/host precedence, explicit Current,
canonical no-op, successful reload, pending confirmed-vs-requested state,
unsupported persistence, socket/follower delivery, reconnect, revision ordering,
exact HTTP/event correlation, uncertain replay, failed reconciliation, conflicts,
explicit retries, key reuse prevention, identity/tenant/logout/switch-back races,
and reentrant logout before dispatch.

The public composition regression opens an existing thread, stores a draft with a
reply reference and `notifyAuthor: false`, and queues a send with the original
thread destination/reference/false ping. It asserts those populated objects,
open-thread state and message cache remain unchanged through preference conflict,
explicit retry, host override/removal and refresh. Its HTTP and storage adapter
boundaries follow existing client test patterns; this is not a database test.

## Scoped limitations and preserved work

Preference persistence itself is owned by the existing server/query/command
items. No database or SQL implementation was changed or tested here, and no fake
database was introduced. Full Discord capability gating, UI controls/action
routing, Flutter and preview integration remain separate items. Requested unsaved
choices and uncertain mutation tracking are in-memory for the active client;
reload restores authoritative server preference via GET.

No canonical or generated production output was authored by this item, so no
regeneration or Dart analysis was required for this patch. Concurrent Flutter,
handshake, contract, server and server-test changes were preserved. The initially
clean shared client/barrel paths received only the listed integration edits;
there was no concrete competing edit to those paths during this run. No global
project checks or QA campaigns were started. Temporary output created by this
run was removed without touching sibling artifacts.
