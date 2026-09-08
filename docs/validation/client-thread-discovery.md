# TypeScript channel thread discovery

Selected Owner Task item: `24180704-16cf-4afa-b039-c8f03db7eacd`.
Validated locally on 2026-09-06. Patch remains uncommitted.

## Behavior and public API

`client.threadList` and React `useThreadList({ parentConversationId, view?, limit? })`
provide headless authorized channel discovery. View defaults to `active`; page
size defaults to 50. State exposes items, initial loading, refreshing, loading more,
ready/empty, sanitized errors, unavailable access, and whether another page exists.
Actions are `refresh`, `loadMore`, and `retry`; retry retains the failed page cursor.
The first subscriber loads and retains the normal parent stream. The last release
cancels reads, expiry timers, and that stream retention. Hook parent/view switches
release the old observation; multiple independently observed queries are supported.

This adds a way to find authorized child conversations without first opening their
root message. Existing Reply-to-thread behavior, canonical IDs, and root-thread
opening remain intact. A host can explicitly call
`client.openExistingThread(item.thread.id)` after selection. Discovery never opens
or creates a thread, follows, joins, marks read, writes cache authority, or changes
a draft/send destination. Visible discovery UI and style settings are separate tasks.

The snapshot reader uses the canonical thread-list path, request/result parsers,
query serializer, authenticated transport, cancellation and sanitized diagnostics.
Lists merge by canonical ID and immutable creation-time/UTF-8 ordering. Refresh,
identity/session replacement, access loss and observer release invalidate obsolete
request generations. Parent revocation survives reconnect. Child removals and
revocations cannot be restored by later pages. Responses validate tenant and actor
private fields before admission. Newer normalized read, follow, preference,
summary and lifecycle facts take precedence over older HTTP facts; optimistic follow
projections are kept distinct from canonical follow authority.

Existing direct and cross-tab canonical-event forwarding connects discovery to
parent `thread.lifecycle.changed`, available child lifecycle events, creation,
summary, follow/read/preference/membership events, and reconnect. Lifecycle revision
tracking is actor/session-bound and keyed by parent and child. An invalidation
newer than available HTTP lifecycle authority yields retryable `stale_response`.
No extra realtime transport or child auto-subscription is introduced.

Observed active lists refresh at the nearest server `hideAt`, using `evaluatedAt`
to translate server time to the local clock. `CreateChatClientConfig.threadList`
accepts `now` and `schedule(callback, delayMs)`; scheduling returns a cancel
function. Elapsed deadlines retry no faster than once per second; future deadlines
use at least one millisecond, and long waits are capped/rearmed at the timer limit.
Disabled policy and `all` do not schedule hiding. Expiry refresh only changes list
rows: it does not close panels, delete history, or modify drafts/queued sends.

## Verification

Command: `node scripts/test-client-thread-list.mjs`

Result: **84 tests passed, 0 failed, 0 skipped**. The script runs these checks
sequentially and removes its temporary compiler output:

- Fresh production compilation of client and React public entry points with
  `tsconfig.client-thread-list.json`.
- Public API positive/negative type checks with
  `tsconfig.client-thread-list-type-tests.json`.
- Discovery runtime/client/hook tests, existing lifecycle tests, and existing
  thread-opening regressions, using the fresh output and `--test-concurrency=1`.

Focused coverage includes canonical pagination/order and concurrent-page dedup;
late page versus refresh; non-advancing/duplicate response rejection and page retry;
loading/empty/sanitized errors; creation and normalized read/follow changes;
parent-stream lifecycle invalidation for unopened children; duplicate/out-of-order
revisions; stale HTTP lifecycle rejection; missed events on reconnect;
parent/view/actor/tenant/session changes; denial/revocation and late responses;
normalized child removal; expiry offset, subsecond/elapsed/overflow scheduling,
release/account/disconnect/revocation/disposal cancellation and disabled/all behavior.
A public client WebSocket-boundary test proves parent subscription and invalidation
forwarding. A React hook test explicitly opens a canonical existing thread, retains
real cached history and a draft/pending send, hides its discovery row, and verifies
that opening state, history, draft and queued destination are unchanged.

`git diff --check -- src/client/create-chat-client.ts src/client/index.ts
src/client/snapshot-reader.ts src/react/index.ts` also passed.

## Scope and limits

No canonical descriptors/generated outputs, normalized-cache implementation, SQL,
Flutter, preview, or visible UI were changed by this item. Existing sibling changes
in shared files were preserved; integration additions are limited to the client,
snapshot reader, and public exports. No global project suite, database tests,
runtime deployment, external provider actions, QA campaign, commit, push or PR
was performed. Tests use deterministic HTTP/WebSocket/clock/storage boundaries,
not a simulated database. Cross-tab integration reuses the existing forwarding
path; a separate multi-tab browser campaign is outside this local implementation.
