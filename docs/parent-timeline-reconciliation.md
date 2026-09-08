# Parent timeline reconciliation after summary replay

The failure reproduces against the current source, including the completed
atomic parent-stream reply-summary repair. The captured older campaign also
missed reply counts; fixing those counts alone does not eliminate normalization
failures.

The isolated browser trace identifies `_validateCanonicalMessage`, called by
`NormalizedSnapshotStore.hydrateMessageTimeline`, throwing:

```text
NormalizedSnapshotConflict: Message MessageId(message-root) has conflicting data at one revision.
```

Both versions of the observed root have content revision 1, identical content,
identity, reply count 2, participants, and last-reply timestamp. Only
`threadSummary.unreadCount` differs: accepted replay has 1, GET has 0. This field
is viewer enrichment, and the summary has no revision of its own. Consequently,
a tied content revision cannot establish that a GET summary supersedes the
accepted summary. The original campaign's zero-versus-two reply divergence also
hits this same whole-message equality check.

Timeline hydration now retains the accepted summary at a tied content revision,
in both canonical and projected messages, matching the TS cache's precedence.
Other message content still goes through the existing strict equality check.
Tenant, conversation, sequence, and established thread identity conflicts reject
the complete page without publishing staged rows, cursors, or observer changes.
Older content cannot overwrite newer state. Fresh stores still install snapshot
summaries; durable summary events and explicit thread reconciliation remain
summary update paths. Higher content revisions retain the existing merge rule.
No ordering is inferred from opaque replay cursor IDs or viewer unread counts.

The browser scenario requires canonical/projected reply counts of 1 live and 2
after disconnect/reconnect, no observer thread hydration or thread GET, and
successful explicit parent hydration (`ready`, null error). Each explicit
hydration must preserve the complete preceding summaries. Reconnect must preserve
message ordering and reply facts; full snapshot recovery may refresh viewer
unread enrichment, but canonical/projected summaries must still agree, including
unread counts. Duplicate event replay is additionally tested at store level for
complete state/cursor identity and no extra emissions.

## Evidence and provenance

Evidence is in [the focused evidence directory](evidence/parent-timeline-reconciliation/).
The original persisted campaign artifact remains at
`examples/drop-in-react/test-results/flutter-backend-dev/flutter-backend-lab-TS-and-2dc5b-read-state-across-reconnect-chromium/flutter-backend-evidence.json`.
Its SHA-256 is `885316b642f1ef46832a836b047aa4c53be6d81fc57cee8992592d50268295e1`.
It records `error` / `normalization` after explicit parent hydration.

Repository HEAD for every run: `d4371fb7366c437ebbb8626a0bb70413ef92d3d3`.
The checkout includes sibling changes; HEAD alone is not the source provenance.
[source-before.json](evidence/parent-timeline-reconciliation/source-before.json)
hashes the actual initial TS and Dart sources, including the atomic-summary
repair. [source-after.json](evidence/parent-timeline-reconciliation/source-after.json)
records the final changed hashes and additional compiled/test inputs. The only
production source changed during this task is `normalized_snapshot_state.dart`.

Flutter compiled source digest before the fix:
`b79fdfda6338190a7ddc8768dfc904747eff3a4328f1d707c282040da92878e9`.
After the fix:
`424e672dea99d61b29ebe201fb44c151103af460bd4461c00c4aa9605857ebf5`.
The temporary diagnostic build printed the conflicting rows and caught exception;
all diagnostic instrumentation was removed before the final build.

## Reproduction and validation

- `npx tsc --project tsconfig.json` rebuilt the backend from the actual checkout
  before browser reproduction; passed. This was needed because the isolated lab
  imports `dist`, including the atomic-summary repair.
- `flutter test --no-pub test/durable_message_event_reducer_test.dart --plain-name 'parent hydration' --reporter expanded`:
  before the fix, three new summary regressions fail with the exact normalization
  conflict; five identity/content rejection cases pass. See
  [the failing log](evidence/parent-timeline-reconciliation/dart-failing-before.log).
- `flutter test --no-pub test/durable_message_event_reducer_test.dart test/normalized_snapshot_state_test.dart test/durable_resource_event_reducer_test.dart --reporter expanded`:
  132 pass after the fix. See [the passing log](evidence/parent-timeline-reconciliation/dart-passing-after.log).
- `flutter analyze --no-pub lib/src/core/normalized_snapshot_state.dart test/durable_message_event_reducer_test.dart`:
  no issues. JavaScript syntax and focused `git diff --check` also pass.
- `npm --prefix examples/drop-in-react run build:flutter:lab`: final release web
  build passes, compiling the changed production path.
- Browser command, from `examples/drop-in-react`:
  `npx playwright test e2e/flutter-backend-lab.spec.mjs --project=chromium --repeat-each=3 --retries=0 --output=test-results/parent-reconciliation-passing`.
  Six checks pass (three repetitions, retries disabled). See
  [the passing log](evidence/parent-timeline-reconciliation/browser-passing.log),
  [exported state](evidence/parent-timeline-reconciliation/browser-passing-after.json),
  and [all three runs](evidence/parent-timeline-reconciliation/result.json).

Browser runs use the existing real PostgreSQL Chat Lab harness, an isolated
schema per harness, and its teardown. No shared dev service, runtime configuration,
queue, or database rows were changed outside those disposable test schemas.
A writable temporary copy of the installed Flutter SDK and a temporary Playwright
browser cache were used because the worker's installed SDK/cache is read-only or
missing. Handrail MCP tools were unavailable. Shared dev campaign confirmation
remains a separate Owner Goal QA action; this task did not launch it.

## Viewer unread ownership contract (design prerequisite, 2026-09-06)

The preceding sections are preserved historical evidence of the normalization
repair, including its test results and environment limitations. This addition
defines future implementation work; it changes no runtime behavior and claims
no new runtime tests passed. Preserving an entire summary at tied content
revision prevented the recorded conflict, but also preserved unread enrichment
whose viewer ownership was not established. That repair did not fix ownership.
The future merge must preserve accepted shared facts while reconciling unread
separately under the rules below. Strict identity/content validation and atomic
page rejection remain prerequisites.

### Verified current sources and authority

Paths below are relative to the SDK repository. Symbols were inspected in the
shared dirty checkout; line numbers and HEAD alone are not stable provenance.

| Path and symbol | Current behavior and implementation implication |
| --- | --- |
| `src/server/thread-summary-query.ts`, `selectRootThreadSummary` | Counts reply rows and distinct authors, including soft-deleted rows, and takes maximum reply creation time. Its inner cursor join uses `actor.userId`; unread uses `last_read_sequence` and `manual_unread_from_sequence`. Missing actor cursor makes the query fail, not return an authoritative viewer zero. |
| `src/server/send-message-command.ts`, `sendMessage` | Persists that actor-enriched `rootThreadSummary` in `message.thread_summary.updated` on the parent conversation stream after `message.created`, within the reply transaction. |
| `src/server/create-thread-command.ts`, `createThread` | Uses the same selector in its command result and in both `conversation.created` and the parent `message.thread_summary.updated` payload. All shared envelopes must lose actor unread ownership, including creation. |
| `src/server/forward-message-command.ts`, `forwardMessage` | The inspected sibling implementation calls the selector for a thread destination and persists the parent summary after the forwarded `message.created`. Preserve its transaction, destination lock, and idempotency work. |
| `src/server/message-timeline-query.ts`, `queryMessageTimeline` | Parent timeline SQL computes unread for the requesting actor using `chat_conversation_members.state = 'active' OR chat_thread_follows.is_following IS TRUE`, joined by tenant, thread and user. A left-joined absent database cursor has effective read sequence zero via `COALESCE`. This is the authoritative parent-only fallback. |
| `src/server/outbox-publisher.ts`, `createChatOutboxPublisher`, `toChatEvent` | Publishes the stored `chat_outbox_events.payload` without per-recipient enrichment. Claims serialize a tenant/stream's unpublished events; delivery retries are possible. |
| `src/server/websocket-replay.ts`, `readChatWebSocketReplay`, `toPositionedEvent`, `resolveBufferedReplayEvents` | Authorizes streams and returns stored payloads in database replay-position order, including the buffered live/replay boundary. Authorization does not recalculate unread. |
| `src/server/update-read-cursor-command.ts`, `updateReadCursor` | Mutates `chat_read_cursors` atomically; `createReadCursorUpdatedEvent` in `src/contracts/read-cursor-mutation.ts` addresses `user:<actorUserId>`. `updatedAt` orders equal-sequence manual-marker changes. |
| `src/server/set-thread-follow-command.ts`, `setThreadFollow` | Mutates `chat_thread_follows`, checks/increments `follow_revision`, and publishes `thread.follow.updated` to the actor's user stream. Unfollowing alone does not negate active membership. |
| `src/client/durable-event-reducer.ts`, `reduceThreadSummary`, `parseThreadSummary` | Validates identities, then installs the whole parsed summary when reply progress advances. The sibling ordering repair rejects equal/lower reply counts; it does not establish the numeric unread field's owner. |
| `../handrail-sdk-chat-flutter/lib/src/core/durable_message_event_reducer.dart`, `_reduceDurableThreadSummary` | Equivalent reply-progress guard and whole-summary replacement in canonical and projected messages. |
| `src/client/normalized-cache.ts`, `hydrateMessageTimeline`, `reconcileThreadOpening` | Existing normalization/reconciliation boundary. Viewer inputs live in `currentUser.readStates`, `currentUser.memberships`, `currentUser.threadFollows`; thread progress is in `metadata.conversations[threadId].latestSequence`. |
| `src/client/read-state.ts`, `selectConversationUnreadCount`, `createChatReadStateRuntime` | The selector already returns `undefined` when read state or latest sequence is missing. The runtime manages authoritative cursor reconciliation and pending read intents; a thread-summary fix must reuse it. |
| `../handrail-sdk-chat-flutter/lib/src/core/normalized_snapshot_state.dart`, `NormalizedSnapshotStore.hydrateMessageTimeline`, `reconcileThreadOpening` | Owns `canonicalMessages` and `messages`, `currentUserReadStates` / `authoritativeCurrentUserReadStates`, `membersByConversation`, and `currentUserThreadFollows` / `authoritativeCurrentUserThreadFollows`, with conversation metadata and membership/follow revisions. |
| `../handrail-sdk-chat-flutter/lib/src/core/normalized_snapshot_serialization.dart`, `NormalizedSnapshotStateStorageCodec` | Closed-schema persistence of canonical and projected messages; persists authoritative read/follow state. Cache migration must handle both message representations atomically. |

Server authority remains the existing tenant-scoped `chat_messages`,
`chat_conversations`, `chat_read_cursors`, `chat_conversation_members` and
`chat_thread_follows` rows. The parent summary is a projection of these rows,
not a second read-state ledger. User-stream cursor/follow events, membership
reconciliation and viewer-authenticated snapshots supply client authority.

### Chosen ownership and missing-state policy

Shared durable summaries own only `threadId`, `replyCount`, `participantIds`
and `lastReplyAt`. They must contain no viewer unread count, cursor, eligibility,
or sender-private enrichment. This applies equally to live delivery, replay and
creation payloads. An authenticated HTTP query/command response may return an
unread count for its requesting viewer, subject to the same eligibility policy
as `queryMessageTimeline`; a shared event may never supply that authority.
Upgraded readers must ignore even a valid numeric unread count in a legacy
shared payload, including when the viewer happens to be the sender.

Use the existing normalized message summary for the derived viewer value:
`unreadCount: number | null` in the future TS model and `int?` in Dart, with the
key required for normalized serialization. A nonnegative number means an exact
count at the accepted viewer basis; `null` means unknown or invalidated/stale.
Do not retain a stale number as if exact, silently substitute zero, or add a
parallel per-thread unread store. Pending read/follow intent stays in existing
optimistic state. UI consumers must represent null as unavailable/pending,
without converting it to a zero badge. Shared wire facts use a distinct payload
shape omitting unread, not a made-up numeric placeholder.

Eligibility is three-valued: known active member OR known following establishes
eligible; authoritative non-active/absent membership AND authoritative false/
absent follow establishes ineligible; otherwise it is unknown. A missing map
entry, partial member page, or unhydrated thread proves neither absence nor
ineligibility. An authorized parent observer need not belong to or hydrate the
thread. Known ineligible means exact zero even without a cursor. Unknown
eligibility means unknown unread even if a cursor is present.

For an eligible viewer with authoritative cursor `R` and optional manual marker
`M`, the effective cursor is `E = R` without a marker, otherwise
`E = min(R, M - 1)`. Exact unread is the number of persisted thread reply rows
with sequence greater than `E`, matching the timeline SQL (including deleted
rows). With established contiguous sequence coverage `1..N`, this is
`max(0, N - E)`, as in `deriveUnreadCount` in
`src/contracts/member-read-state.ts`. A partial page, a reply-count delta, an
optimistic reply, or a cursor without current sequence coverage is insufficient
to infer that exact row count. Do not use replyCount as a cursor or assume it
equals latestSequence without establishing the allocation/coverage invariant.

An absent cursor established by the authoritative database left join is
different from one missing in memory: the former permits `E = 0` and an exact
count of all replies for an eligible viewer. The latter supplies no cursor fact
at all. A requesting-viewer parent query can return an exact number without
hydrating that cursor locally; do not fabricate a cursor row from the number.
If new shared facts later advance and local coverage is insufficient, invalidate
that number to null and refresh it. A known cursor alone does not rescue unknown
eligibility or an unknown latest thread sequence.

### Delivery, reconciliation and races

1. On live or replayed shared summary, validate parent/root/thread identity,
   then apply the sibling reply-progress rule only to shared facts. Never order
   unread by its numeric value, root content revision, opaque event/cursor ID,
   or envelope timestamp. Preserve current event deduplication, arrival cursor
   bookkeeping and stream high-water rules independently of summary no-ops.
2. On greater reply progress, recompute unread only if the accepted viewer
   inputs and complete sequence coverage establish the new basis. Otherwise
   set it to null in canonical and projected roots in the same publication.
   Equal/lower shared progress must neither overwrite a reconciled viewer count
   nor invalidate it repeatedly. Legacy payload unread is discarded before merge.
3. Parent-only observers accept reply facts immediately. Coalesce a refresh of
   the existing authenticated parent message-timeline query around the affected
   root; do not require thread detail/timeline hydration or a new private API.
   `getMessageTimeline` in `src/client/create-chat-client.ts` and
   `../handrail-sdk-chat-flutter/lib/src/handrail_chat_client.dart` provides the existing
   query surface. Feed the result through the normalization boundary. A page
   excluding the root cannot resolve its count. Offline/failure leaves null and
   uses existing reconnect/snapshot recovery to retry.
4. A fresh requesting-viewer response may establish unread independently of
   content revision and without local thread state. Extend the existing query
   request lifecycle with a scope/generation fence: bind to tenant/user and root,
   capture accepted shared progress and read/membership/follow state at request
   start, and reject its unread enrichment if any relevant input changed before
   response acceptance. An intervening invalidation must advance the fence even
   when inputs later return to the same values. Serialize/coalesce refreshes;
   ignore superseded responses. This is request bookkeeping, not a new durable
   summary clock or authority table. Preserve accepted shared facts if a late
   page has older reply progress, and schedule a fresh query for unread.
5. A late page at tied content revision must still pass identity/content checks.
   If its viewer fence is valid and its shared progress agrees, accept the
   viewer unread value while retaining accepted shared facts. This deliberately
   narrows the historical whole-summary-preservation rule. A higher content
   revision alone also grants no unread authority. Full snapshot recovery uses
   its existing atomic hydration boundary and the same viewer-scope rules.
6. A cursor update from another device, manual unread/clear, membership change,
   follow/unfollow, or scope/access change recomputes or invalidates affected
   root unread even if no reply arrives. Reuse existing cursor `updatedAt`,
   membership revisions and `followRevision` reconciliation; never resurrect a
   stale marker from duplicate events. If a parent-only client lacks the thread
   needed by a private event reducer, retain its existing gap/snapshot recovery
   behavior and refresh visible parent enrichment rather than fabricate thread
   state. After an offline/user-stream gap, persisted numbers cannot be assumed
   current before recovery. Access loss removes protected state through existing
   authorization recovery, rather than granting access via a summary.

Canonical/projected agreement means the same accepted viewer enrichment is
written atomically to both root representations. A deliberate optimistic read
intent may derive a temporary projection through the existing read runtime,
but must not be persisted as canonical or copied from a sender's shared event.
Once intents settle, both representations must agree on facts and number/null.

### Compatible wire and cache transition

This is a breaking model change requiring staged readers and an explicit wire
gate, not deletion of a required field in place. Today
`contracts/models/message.json` describes required integer unread;
`scripts/generate-messages.mjs` validates that descriptor shape and emits
`src/contracts/message.ts` and `../handrail-sdk-chat-flutter/lib/src/generated/message.dart`.
Dart `ThreadSummary.fromJson` requires a nonnegative integer and rejects unknown
keys. TS also validates through `parseThreadSummary` in the durable reducer and
`src/contracts/thread-creation.ts`, the timeline checks in
`src/contracts/message-timeline-runtime.ts`, and the generated send parser in
`src/contracts/generated/send-message.ts` (source
`scripts/generate-send-message.mjs`). Update descriptor, generator assertions,
types, all parsers and serialization together; do not hand-edit generated Dart.
Audit embedding contracts/generators `scripts/generate-thread.mjs` and
`scripts/generate-message-timeline.mjs`, plus
`contracts/realtime/durable-events.json`, `scripts/generate-durable-events.mjs`,
`src/contracts/generated/durable-events.ts` and
`../handrail-sdk-chat-flutter/lib/src/generated/durable_events.dart`.
Protocol gate changes must likewise update `contracts/realtime/handshake.json`,
`contracts/realtime/session.json`, `scripts/generate-handshake.mjs` and
`scripts/generate-realtime-session.mjs` before regenerating their consumers.

The chosen transition is:

1. Ship upgraded readers first. They accept legacy numeric summaries in their
   documented old wire version, but discard unread on shared event ingress.
   They support required nullable unread in normalized state and new shared
   facts without unread in the new event version. Malformed legacy required
   fields still fail validation; omission is accepted only in the explicitly
   supported new shared shape. Viewer HTTP timeline responses remain numeric
   and viewer-scoped, so old query clients do not need a null wire fallback.
   Authenticated command summaries follow that same numeric response policy.
2. Before a cache is exposed, migrate legacy normalized message summaries to
   null unread (or recompute only with proven current viewer inputs), retaining
   shared facts and existing identity validation. Numeric legacy caches cannot
   reveal whether unread came from a query or another user's event. Treat all
   restored unread as stale until current-session authority is established,
   including caches written by upgraded readers before an offline interval.
   Apply this to TS normalization/restore in `src/client/normalized-cache.ts`
   and storage integration in `src/client/create-chat-client.ts` /
   `src/client/application-chat-storage.ts`, and to the Dart codec above and
   `../handrail-sdk-chat-flutter/lib/src/core/application_chat_storage.dart`.
   Version the existing canonical cache record schema/key so older readers
   cannot load nullable summaries; use the existing storage identity and
   validation/quarantine paths. In TS this is the existing `normalizedSnapshot`
   record and `hydrateCanonicalState` restore boundary. Both application storage
   modules currently use envelope schema version 1; a global envelope bump must
   not accidentally make retained intent records unreadable. Introduce a
   snapshot-specific version boundary with legacy snapshot decoding while
   retaining supported intent decoding. Migrate or invalidate only canonical cache data,
   preserving durable queued intents and their existing contract versions.
   Do not globally discard queued writes to accommodate a derived cache field.
3. Switch producers only after those readers and recovery paths are available.
   Select shared facts independently of actor cursors; calculate actor response
   enrichment separately under the timeline eligibility rule. Persist only
   shared facts in every summary-bearing outbox envelope. Keep transaction and
   replay semantics, including forward-summary persistence, intact.
4. Gate new shared shapes with an explicit supported protocol transition at
   `src/contracts/realtime.ts`, `src/server/websocket-upgrade.ts` and replay
   compatibility checks in `src/server/websocket-replay.ts`, with corresponding
   handshake/session descriptors and generated clients. The current protocol
   is 4 and normally permits the immediately previous version; simply bumping
   the constant is insufficient. At producer cutover, exclude clients that
   cannot parse the new summary shape and terminate/drain existing incompatible
   sessions before publishing it. Give them the existing explicit incompatible/
   upgrade outcome; do not send omitted/null unread to a legacy numeric parser.
   This design does not promise continued realtime service to unupgraded clients.
5. Retained old outbox rows are immutable legacy input, not a migration target.
   Upgraded readers use the legacy decoder and strip unread when the negotiated
   replay range permits it; when it does not, use existing `replay_incompatible`
   snapshot recovery. Live old rows still pending publication need the same
   compatibility handling. Never rewrite retained payloads, manufacture zero,
   reinterpret opaque replay IDs, or silently skip facts to advance a cursor.
   Old clients on old servers retain the known defect; upgraded clients on old
   servers can ignore sender counts and query viewer truth. Upgraded servers
   must reject incompatible old clients rather than claim ownership is repaired
   for them. Rolling producers/readers must honor this gate on every instance.

No additional per-viewer outbox summary stream, database unread table, or cache
authority ledger is introduced. Request fences use existing client lifecycle;
the generated nullable value is a projection, not an independent source of truth.

### Numeric regression scenarios and required outcomes

Use one tenant, one visible parent root and two viewers A and B. Unless a row
says otherwise, both are eligible, reply sequences are contiguous `1..10`,
A has `R=10`, B has `R=4`, and no manual marker exists. The shared facts say
`replyCount=10`; the sender A's legacy payload might contain `unreadCount=0`.
All expectations below apply to live delivery and replay of the same facts.

| Scenario | Exact expected result |
| --- | --- |
| Different cursors with known coverage | A gets 0, B gets 6; B never adopts A's 0. If A next sends sequence 11 and its cursor remains 10, counts are A=1 and B=7. If an independent cursor update advances A to 11, A becomes 0 through read-state reconciliation. |
| Manual unread | With A `R=10, M=8`, effective cursor is 7, so A=3 and B=6 at ten replies. Clearing A's marker makes A=0, even though replyCount and content revision do not change. Replaying the older marker must not restore 3. |
| Database cursor absent | An eligible B with no database cursor gets 10 from the parent query. A B cursor merely missing in client memory yields null before query, even if the true database cursor is 4 and the eventual result is 6. |
| Eligibility | B known non-active and not following gets 0; active OR following with `R=4` gets 6. Unfollow while active remains 6. Losing active membership while still following remains 6. Both false becomes 0; unknown membership plus unknown/false follow yields null until query. |
| Parent-only observer | B has root facts but no thread, cursor or eligibility hydration: replyCount becomes 10, unread is null. Parent GET restores 6 (or authoritative ineligible 0) with no thread GET. An eleventh reply invalidates to null until fresh authority gives 7. |
| Late snapshot | Start B's parent GET at ten replies; accept eleven-reply event before its ten-reply response. Preserve 11 shared replies, reject the response's unread 6, remain null without local coverage, then refresh to 7. At tied content revision and matching ten-reply basis, a fenced viewer GET may replace null/legacy enrichment with B=6 without normalization conflict. |
| Cross-device race | B starts a GET with `R=4`; another device advances B to `R=9`. With coverage, B becomes 1 at ten replies; the old GET's 6 cannot overwrite it. Without coverage, B stays null until a fresh GET gives 1. |
| Duplicate/stale shared event | At B=6 and ten accepted replies, duplicate ten-reply or stale nine-reply payloads containing A=0 preserve B=6 and shared facts. Duplicate event IDs cause no extra publication; distinct stale envelopes follow existing replay bookkeeping without replacing facts. |
| Reconnect replay | B disconnects at ten replies, then reconnects after sequence 11. Eleven shared replies must arrive without thread hydration; unknown local coverage means null then viewer GET=7. Replaying legacy ten-reply A=0 cannot regress either the 11 facts or B=7. |
| Legacy payload/cache | Legacy numeric shared A=0 decodes then loses its unread authority. Legacy cache root with unread 0 restores facts but unread null before exposure; B's fresh GET gives 6. Round-trip new cache null remains null. An old reader rejects the new cache/version or receives the protocol upgrade outcome, never a fabricated zero. |

### Ordered future changes and deterministic proof

These are bounded implementation boundaries, not work launched by this document.
Coordinate each subsequent change with the existing owners of overlapping files.

1. **Contract and generator slice:** own the message descriptor/generator,
   generated TS/Dart message types, embedding parsers and durable-event contract
   listed above. Define/validate nullable normalized enrichment and versioned
   shared facts, keeping viewer query responses numeric. Prove legacy/new/null/
   malformed fixtures in `test/message-generation.test.mjs`,
   `test/message-timeline.test.mjs` and
   `../handrail-sdk-chat-flutter/test/generated_message_test.dart`, plus relevant send/
   thread generation suites. Generated outputs must match sources deterministically.
2. **TS reader/reconciliation slice:** own `src/client/durable-event-reducer.ts`,
   `src/client/normalized-cache.ts`, `src/client/read-state.ts` and focused query
   orchestration in `src/client/create-chat-client.ts`. Split shared merge from
   viewer derivation, add request fences/invalidation and parent-only refresh.
   Depend on, rather than redo, sibling TS summary ordering item
   `f9293306-f6ee-4fc4-9fa3-df9d3f86989d` and its summary-clock test item
   `c7fc25ff-bbcd-4ff1-8208-a767d6b91804`.
3. **Flutter reader/reconciliation slice:** implement equivalent changes in the
   Dart reducer and normalized state paths above, with query orchestration in
   `../handrail-sdk-chat-flutter/lib/src/handrail_chat_client.dart`. Depend on sibling
   ordering item `6716b011-90d7-4d3b-8c0f-c171a08aff53` and its test item
   `080de6cd-55dd-45a6-90d5-ff3c118e26af`. Preserve atomic canonical/projected writes.
4. **Persistence slice:** update the TS storage/restore boundary and Dart codec/
   application storage named above. Prove old cache migration, nullable round
   trips, identity isolation, offline invalidation, and queued-intent retention
   in `test/client-canonical-state-persistence.test.mjs` and
   `../handrail-sdk-chat-flutter/test/normalized_snapshot_persistence_client_test.dart`.
   Complete this before shipping nullable cache writers.
5. **Producer slice:** separate shared selection in
   `src/server/thread-summary-query.ts` from viewer response enrichment, then
   update send/create-thread/forward producers and eligibility alignment.
   Depend on forward persistence item `bf189b91-432c-4490-96d4-59fc8990f96c` and
   forward test item `32373939-2bac-402d-bb6b-fb9e1b268548`; do not duplicate their
   atomicity repair. Include creation's shared envelope, not just the dedicated
   parent event. This slice must remain gated until both readers are ready.
6. **Compatibility and integration slice:** implement the protocol/cache rollout
   gate above and prove live, retained replay and mixed-version behavior in
   `test/postgres-thread-reply-summary.test.mjs`,
   `test/postgres-message-timeline-query.test.mjs`,
   `test/postgres-outbox-publisher.test.mjs` and
   `test/postgres-websocket-replay.test.mjs`. Assert stored new payloads contain
   no unread, while requesting A/B query responses contain their distinct exact
   counts. Assert idempotent command retries publish no additional summaries.

For reader slices, put the table's event permutations in
`test/durable-event-reducer.test.mjs`, `test/client-durable-read-state.test.mjs`,
`test/client-snapshot-hydration.test.mjs`, and Flutter
`../handrail-sdk-chat-flutter/test/durable_message_event_reducer_test.dart`,
`../handrail-sdk-chat-flutter/test/normalized_snapshot_state_test.dart`,
`../handrail-sdk-chat-flutter/test/read_cursor_runtime_test.dart` and
`../handrail-sdk-chat-flutter/test/durable_resource_event_reducer_test.dart`.
Use fixed IDs, sequences and cursor timestamps; explicitly hold/release query
responses and live/replay delivery, rather than make races depend on sleeps.
Assert both complete root representations, viewer cursor/marker preservation,
request counts (coalesced parent refresh, no thread GET), observer emissions,
and unchanged state after malformed/identity-conflicting input. Include a
read/follow change during a held snapshot even when reply progress is unchanged.

Database proof must use the repository's existing `createChatTestHarness` /
`createPostgresTestBackend` pattern, actual PostgreSQL and disposable schemas
with teardown. Control network/clock boundaries only; do not emulate SQL in a
new fake database. Run the focused suites sequentially, rebuild the package
outputs they import as needed, and include scoped TS compile and Dart analysis
for future typed changes. The historical browser evidence above remains useful
for normalization, but is not proof of this ownership policy. This documentation
task adds/runs no such runtime tests; runtime remediation and its regression
proof remain pending.
