# Channel thread discovery contract

The canonical source is [thread-list.json](../contracts/http/thread-list.json).
Generate the public TypeScript and pure-Dart contracts with
`npm run generate:thread-list`; verify drift with `npm run check:thread-list`.
The generator renders both templates, checks the supported descriptor hash, and
gets allowed summary fields from the canonical conversation and snapshot
schemas. Change the descriptor and templates together; generated files are not
editable sources. The existing snapshot runtime supplies summary validation,
and the existing thread-follow parser supplies follow-state validation.

`GET /conversations/:parentConversationId/threads` defaults to `view=active` and
`limit=50` (1–100). The parent must be an authorized, unarchived channel in the
trusted tenant. Unknown request fields, injected session identity, repeated query
values, invalid IDs and invalid pagination inputs fail. HTTP adapters accept
canonical decimal limit strings; the typed request accepts integer limits.

Each item contains a canonical thread summary, independent `currentThreadFollow`
authority, `lastActivityAt`, and `hideAt`. The summary retains optional names,
parent/root IDs, optional canonical `ThreadLifecycle`, membership, read state and
notification preferences. An unfollowed/unread thread remains discoverable.
Neither following nor child membership is an access grant or a discovery
prerequisite. Private parent authorization still applies. The later query must
project the existing default private state without writing missing rows on reads.

Active discovery excludes closed threads and time-hidden threads. All includes
that authorized history, but both views exclude parent/thread administrative
archive and obey current access/entity policy. `lifecycleSupported=false` preserves
legacy eligibility and prohibits emitting lifecycle metadata; lifecycle-dependent
controls and filtering must only be advertised once shared persistence,
hydration and enforcement support them. Absence of lifecycle means open/unlocked.
The per-user Current / Discord-style setting does not enable this shared policy.

Resolve the existing server `ChatThreadListHandlerOptions.resolveInactivityPolicy`
only after trusted tenant and parent authorization. Invalid configuration,
invalid results and resolver exceptions resolve to disabled (`false`). The wire
uses the same `false | { hideAfterMs: positive finite number }` shape; omission
also disables time filtering. A malformed wire policy is a parse error, since
configuration fallback is the server's responsibility.

Activity is the latest actual persisted thread message `created_at`, or thread
`created_at` for an empty thread. Set summary `activityAt` to this same value.
Never use conversation `updated_at`. Reads, follows, preferences, renames,
reactions, edits, lifecycle operations, failed sends and idempotent retries do not
refresh activity. `hideAt` is null when disabled; otherwise it is Unix milliseconds
computed as activity plus the resolved duration. Compare elapsed inactivity
against `hideAfterMs` with `>=`, using the response's server `evaluatedAt`. This
also handles positive durations too small to survive addition to an epoch value
without prematurely hiding at zero elapsed time. No hidden flag, worker,
lifecycle transition or write is introduced.

Pagination uses immutable creation time (normalized/truncated to milliseconds)
descending, then thread ID ascending by UTF-8 bytes/C collation. Apply identical
normalization to the later SQL order and exclusive cursor predicate. Activity
changes cannot reorder entries. Cursor v1 is canonical unpadded base64url UTF-8
JSON, scoped to parent and view; limit may change. The cursor is a selector, never
an access credential: reauthorize the session on every page. These are live
pages, not a frozen snapshot; policy/access/archive/lifecycle changes can remove
entries between pages. Return `nextCursor` only for a full nonempty page with
more eligible results, using exactly its last item's position. Parsers reject
scope mismatches, duplicate/unordered/non-advancing entries and incoherent expiry.

This patch defines and validates the contract. SQL listing, routing, capability
advertisement, client state and UI integration remain their separate task items.
