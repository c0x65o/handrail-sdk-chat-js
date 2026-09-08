# Thread participation and lifecycle policy

Accepted Handrail Round 4 policy, documented 2026-09-06. This is an implementation contract, not proof of runtime implementation or exact Discord parity. It applies to the same thread conversations across both saved reply styles (Current and Discord-style). The style changes a user's reply actions and presentation; it does not change shared lifecycle, authorization, history or another user's settings.

## Observed implementation versus target

Source inspection on 2026-09-06 used the SDK working tree at HEAD `d4371fb`, including concurrent sibling changes. References below identify files and symbols rather than treating older line numbers as stable.

| Area | Observed source | Accepted target / implementation gap |
| --- | --- | --- |
| Thread identity | [Thread creation contract](../src/contracts/thread-creation.ts), `ThreadCreationInput`, requires a parent and root message. [Creation command](../src/server/create-thread-command.ts), `lockLogicalThread` and `findThreadForRoot`, reconciles a root to a separate canonical conversation. | Reuse these streams, IDs and one-thread-per-root guarantees. No replacement conversation or duplicate on reopen. |
| Follow persistence | [Follow command](../src/server/set-thread-follow-command.ts) checks tenant, parent visibility/membership, parent entity authorization and parent/thread archive eligibility, then writes `chat_thread_follows` with revisions and idempotency. Eligibility SQL was at lines 309–332 during inspection. | Follow is private subscription participation. Its existence is not access authority. Extend authorized-write setup where storage prerequisites are missing; do not add setup to reads. |
| Retained private state | [Creation command](../src/server/create-thread-command.ts), `seedCreatorState`, activates a participant and inserts missing cursors, preferences and follows with `ON CONFLICT ... DO NOTHING`. [Schema migrations](../src/server/postgres-schema-migrations.ts) include private-state foreign keys to participant rows. | Reuse/extract retained setup for authorized writes; preserve private state on re-entry. These internal storage rows must not become the read-access rule. |
| Read access | [Detail query](../src/server/conversation-detail-query.ts) currently admits a public channel or an active current child member; it does not establish the required current-parent rule for threads. | Thread reads, lists and realtime delivery must consistently enforce current parent access, including tenant/entity and private-channel checks. Child membership alone is insufficient. |
| Notifications | [Preference contract](../contracts/http/conversation-preference.json) defines `all`, `mentions`, `none`, and separate unmuted, indefinite and timed mute states. [Notification dispatcher](../src/server/notification-dispatcher.ts) materializes recipients from active conversation members and filters preferences/mentions/mute; that SQL does not consult thread follows. | Implement the follow-aware recipient mapping below and recheck current eligibility at delivery. Existing preference support does not prove this behavior. |
| Automatic follow | [Follow contract](../contracts/http/thread-follow.json) and [generated follow types](../src/contracts/thread-follow-mutation.ts), `ServerDerivedThreadParticipationAutoFollow`, distinguish server-derived reply/mention sources from manual intent. Schema validation protects explicit manual unfollow. | Preserve existing automatic reply/mention-follow trigger rules and manual-unfollow protection. Contract/constraint inspection does not prove every trigger executes at runtime. |
| Archive and lifecycle | [Creation command](../src/server/create-thread-command.ts) rejects an archived existing thread before normal reconciliation (line 605 during this inspection, replacing the earlier line-669 reference). [Send command](../src/server/send-message-command.ts) checks `message.send`, active membership and archive eligibility. | Administrative archive remains authoritative. Computed hiding, shared close/lock transitions, parent-based send checks and atomic send-to-reopen require separate implementation and verification. Audit replay paths as well as first execution. |

The fundamental change is to separate who can read a thread from who follows it, then add explicit shared lifecycle and optional discovery suppression. Separate timelines, follows, private preferences and read cursors already exist and must be reused. This document changes none of the production paths above.

## Access and retained participation

Current parent access is the authority for reading a thread: trusted tenant identity, applicable host entity authorization, and current parent visibility/membership must all pass. Public means public within that authorized scope. Threads under private channels remain available only through current private-parent access. A stale child participant row, owner/moderator role, follow, mention or cached thread ID never grants visibility after parent access is lost.

Read/open/list operations are side-effect free. Opening an existing thread means viewing its history, not joining, creating storage rows, changing follows, marking it read, refreshing activity or reopening shared state. Use a separate authorized read-cursor write when actual read acknowledgement is intended. The create/reconcile command is an authorized write and must not serve as an implicit setup step for ordinary reads.

Existing FK-backed child participant rows are internal storage prerequisites. Initialize or reactivate them through retained setup only after an authorized write passes its access and operation checks, within that write's transaction. Insert missing defaults only; retain existing role authority, preferences, mute, follows, follow revisions, last-read cursor and manual unread markers. Following never grants access or resets cursors. Returning after access is restored must not reseed an existing user's private state. Access loss must prevent reads and delivery without destroying retained history or private state.

## Follow, notification and unread mapping

Join/Leave means explicit follow/unfollow, stored in the existing `chat_thread_follows` system. Leave records an explicit manual `is_following=false`; deleting the row would incorrectly restore the legacy no-row fallback. It does not leave the parent, revoke access, close the thread or mark history read. Automatic reply/mention-follow remains server-derived under existing trigger rules and must not overwrite an explicit manual unfollow. Read/open/list is never an automatic-follow trigger.

The explicit [follow command](../src/server/set-thread-follow-command.ts) now uses
[`ensureThreadParticipant`](../src/server/thread-participant.ts) on its own
transaction after current parent/entity authorization and a matching follow
revision. It locks the stored parent, child and parent membership in that order.
Both a newly applied follow and a fresh matching `already_requested_state` follow
initialize missing private rows or reactivate retained membership, preserving its
role and join time, cursors/manual unread markers, notification/mute settings and
draft contents/revisions. Unfollow performs no participant setup or private-state
cleanup, even for missing or inactive membership. Revision conflicts perform no
setup. Completed idempotency replays recheck current access and return the stored
outcome without setup, so an old follow key cannot undo a later unfollow or
membership change. Setup and follow/audit/outbox/idempotency effects roll back
together on failure. These rules apply equally to both reply styles.

Source inspection for this integration found **no automatic reply/mention-follow
writer or message/mention trigger** in the current send command, notification
dispatcher or canonical migrations. The existing contract allows server-derived
`reply` and `mention` sources; callers cannot supply them to explicit follow.
The `chat_thread_follows_validate_write` trigger validates tenant-scoped thread
identity and current parent access (public parent channel or active parent
membership). Its explicit-unfollow guard rejects an update from manual
`is_following=false` to `is_following=true` with either automatic source. This is
a constraint on a follow write, not a trigger that follows someone when a reply
or mention is posted. Creation/reconciliation seeds only a missing **manual**
follow row and preserves an existing row. This change adds no automatic source
writer or trigger; it preserves that contract and SQL protection without claiming
reply/mention autofollow currently executes.

The following table is **Handrail target policy**, not a description of Discord membership. Every notification candidate must still pass current recipient eligibility, preference and mute checks.

| Private participation state | Access | General message notifications | Eligible direct mentions | Unread state |
| --- | --- | --- | --- | --- |
| Following, manually or through an existing automatic trigger | Current parent access only | Candidate when preference is `all` and not effectively muted | Candidate under `all` or `mentions`, unless effectively muted | Existing cursors/markers retained; following does not acknowledge messages |
| Explicit manual unfollow (`false`) | Unchanged | Suppressed, including for an active child participant | May still notify under `all` or `mentions`, unless effectively muted | Retained; unfollow is not mark-read |
| No follow row, legacy active child participant | Current parent access only | Retain existing general-notification behavior: `all`, unmuted | May notify under `all` or `mentions`, unmuted | Retain existing cursor behavior |
| No follow row and no legacy active child participation | Current parent access permits reading | No general notifications merely because the user can read the parent | A valid direct mention may be a candidate under existing mention eligibility/trigger rules, then preference/mute filtering | Reading visibility does not create or reset a cursor |
| Any state with current parent access denied | Denied | No delivery | No delivery; mention never grants access | Stored state retained, not exposed through an unauthorized read |

`all` permits general messages for subscription/legacy candidates and eligible direct mentions; `mentions` permits only eligible direct mentions; `none` suppresses both. Effective mute suppresses both until its expiry, or indefinitely when no expiry exists. Preserve existing sender exclusion and other delivery filters. Do not notify every parent reader. Materializing or queuing a candidate is insufficient authorization: delivery, including retries, must recheck current recipient eligibility and applicable private delivery controls.

Notification suppression and unread accounting are separate. Muting, unfollowing, hiding, closing or locking must not zero unread counts or advance cursors. Unread results continue to derive from authorized message history and retained read state; ordinary new messages and explicit cursor writes retain their normal effects.

## Shared lifecycle and discovery

| Term | Handrail meaning |
| --- | --- |
| Open | Shared thread state that permits an otherwise authorized send when unlocked and not administratively archived. |
| Active discovery | The ordinary active thread list; visibility here is a discovery decision, not an access grant. |
| Hidden | Computed suppression from active discovery after message inactivity. It is not closure, administrative archive, deletion or access revocation. Authorized history/deep-link lookup remains possible. |
| Closed | Explicit shared, reopenable thread state. Viewing history does not reopen it. |
| Locked | Shared restriction preventing all new sends and reopening until authorized unlock. Lock atomically closes; unlock leaves closed. |
| Archived | Existing administrative archive with its separate authority. Neither UI opening, creation reconciliation nor send-to-reopen can clear or bypass it. |

Only an explicit host policy for the parent may set optional `hideAfterMs`. The default is disabled. A saved user reply-style selection cannot enable it or start hiding/archiving threads for everyone. Compute hiding from elapsed time since last actual persisted message activity, not general `updated_at`. A persisted thread message refreshes that activity; reads, follows, preference changes, renames, reactions, unrelated edits, close/unlock/reopen and policy edits do not count as new message activity. Failed sends and replay of an already persisted send do not refresh it. Do not substitute a general modification timestamp when actual message activity is unavailable.

Hiding is an independent discovery calculation. Explicit reopen alone need not make an inactive thread appear in the active list, because it does not create message activity. A successful new send makes an open/hidden thread active again under the configured timer. Closed/locked/archived status remains separately represented even when discovery filters omit the thread. History, IDs, follows, preferences and unread cursors survive inactivity and lifecycle transitions.

## Host inactivity configuration

`CreateChatServerConfig` (the existing public API name) accepts optional
`threadInactivityPolicy: false | ChatThreadInactivityPolicyResolver`. The callback
receives only readonly `tenantId` and `parentConversationId`, and returns `false`
or `{ hideAfterMs: number }`, synchronously or asynchronously. The host must base
this shared policy on those identifiers, never on a current user or saved reply
style, including through captured request state.

```ts
import { createChatServer, type CreateChatServerConfig } from "@handrail/chat/server";

// Supply your existing database, auth, directory and permissions adapters.
declare const baseConfig: CreateChatServerConfig;

const legacyServer = createChatServer(baseConfig); // absent: disabled
const disabledServer = createChatServer({
  ...baseConfig,
  threadInactivityPolicy: false,
});
const server = createChatServer({
  ...baseConfig,
  threadInactivityPolicy: ({ tenantId, parentConversationId }) => {
    if (tenantId === "tenant-a" && parentConversationId === "launch") {
      return { hideAfterMs: 24 * 60 * 60 * 1000 };
    }
    if (tenantId === "tenant-b" && parentConversationId === "launch") {
      return { hideAfterMs: 7 * 24 * 60 * 60 * 1000 };
    }
    return false; // all other tenant/parent pairs retain legacy discovery
  },
});
```

No callback runs at server construction. For each future authorized list request,
`server.threadListHandlerOptions.resolveInactivityPolicy({ tenantId,
parentConversationId })` resolves a fresh policy. An async callback is supported
for host-owned policy lookup. Only the two shared identifiers are copied into a
frozen callback scope; no actor, request, reply style or private preference is
forwarded. Successful results are copied and frozen as well.

Enabled results must be objects with exactly the enumerable key `hideAfterMs`,
whose value is a finite number greater than zero (fractional milliseconds are
accepted). There is no string coercion or rounding. Missing configuration,
explicit `false`, malformed non-function configuration, missing/null/malformed
results, extra result keys, zero, negative values, `NaN`, infinities, synchronous
throws and rejected callbacks all resolve to `false`. Failures do not retain a
previous enabled result; the next request resolves again and may recover. These
failures do not fail server construction or the policy-resolution promise.

The server-only `ChatThreadListHandlerOptions` boundary is reserved for the future
thread-list handler. It is not a client/HTTP contract, handshake capability,
normalized configuration field or generic access/lifecycle policy. The routing
implementation must first establish trusted tenant and parent access, resolve
once for that list request, and pass the resolved value to discovery filtering.
This patch introduces no thread-list route or query and does not yet suppress any
threads. Discovery SQL belongs to item `626832b7-fcf5-4e40-817a-4775abedc309`;
routing belongs to item `1ce553fa-0d13-4ea0-aa57-e83b748aa6d7`.

For that integration, activity is the latest actual persisted thread message
`created_at`, falling back to the thread's `created_at` only when it has no
messages. Never use `conversation.updated_at`. Reads, follows, preferences,
renames, reactions, message edits, lifecycle operations, policy changes, failed
sends and idempotent retries do not refresh activity. At elapsed inactivity
`>= hideAfterMs`, suppress the thread from active discovery while preserving
history and existing access rules. Do not run a scheduler or mutate archive,
closed, locked, follow, unread or preference state.

## Permission and transition table

This table is **accepted Handrail policy**. It specifies implementation behavior, not currently verified runtime coverage or Discord permission parity.

“Access” below means current tenant, parent and entity authorization. “Send authority” means existing authorized send policy (`message.send` is the legacy capability), narrowed only by explicit host thread policy; do not require a new thread-send permission by default. “Manage authority” means thread owner/moderator or explicit host `thread.manage`, alongside access checks. Manage authority does not bypass archive or lock for sending. All guards and shared-state transitions are server-authoritative.

| Operation | Prerequisites and actor authority | Resulting shared / private state | Preservation and denial guarantees |
| --- | --- | --- | --- |
| Create / reconcile | Access; existing create capability/entity policy; eligible non-thread parent and existing, non-deleted root in that parent; parent unarchived; existing canonical thread unarchived | Create one open/unlocked separate conversation when absent; otherwise return the same canonical thread without reopening or unlocking. Authorized retained setup may initialize missing private rows. | Preserve canonical ID, history and existing private state on retries/re-entry. Reconciliation cannot bypass lifecycle checks; an archived existing thread is denied. |
| Read / open / list | Access; applicable existing archive read/list policy | Return authorized history/metadata; apply discovery filtering for the requested list; no shared or private write | No participant setup, follow, cursor advance, activity refresh or shared reopen. Hidden/closed/locked alone do not revoke history access. |
| Follow / unfollow (Join / Leave) | Access; existing follow authorization; parent and thread unarchived | Change only the actor's explicit follow state/revision using retained setup if needed; no lifecycle change | Preserve preferences and cursors; do not reopen, unlock or refresh activity. Closed/locked alone do not forbid this private subscription write. |
| Inactivity hiding | Explicit host per-parent `hideAfterMs`; elapsed actual message inactivity meets threshold; evaluated server-side for authorized discovery | Compute active-list suppression; no stored close/archive or private-state mutation | Disabled when policy absent; preserve all history and private state. |
| Send to open / hidden thread | Access and send authority; parent/thread unarchived; thread unlocked; valid accepted message | Persist message and actual activity; remain open, cease inactivity suppression under timer; apply only existing eligible automatic follow rules | No cursor/preference reset or duplicate thread. Rejected sends leave lifecycle/activity unchanged. |
| Send-to-reopen closed / unlocked thread | Same authorized send checks, validated in the transaction that persists the message | Atomically persist message, set open and refresh actual activity; normal eligible automatic follow rules apply | Commit both reopen and message or neither. Validation failure, denied permission or persistence rollback must not reopen. |
| Explicit reopen | Access and send authority; parent/thread unarchived; thread unlocked | Set closed to open through an explicit write; no message, activity refresh or implicit follow | Preserve private state/history; inactivity hiding may still apply. Ordinary UI opening is not this command. |
| Close | Access and manage authority; parent/thread unarchived | Set closed; retain current lock state; no private mutation | Reopen remains available through send authority only while unlocked. Preserve activity/history/private state. |
| Lock | Access and manage authority; parent/thread unarchived | Atomically set locked and closed | No intermediate sendable state; preserve history/private state. Even a manager must unlock before sending/reopening. |
| Unlock | Access and manage authority; parent/thread unarchived | Clear lock, leave closed | Does not send, reopen, refresh activity or alter private state. A later authorized reopen/send is separate. |
| Archived denial | Parent or thread administratively archived | Deny creation reconciliation, sends, reopening and lifecycle/follow writes that require unarchived eligibility | No implicit administrative unarchive. Retain existing archive read/list authority and administrative recovery path; no history/private-state deletion. |
| Parent-access denial | Any required current parent/tenant/entity/private-channel check fails, regardless of child membership, subscription or management role | Deny reads/open, writes and delivery; omit inaccessible threads from lists/events | Do not disclose history or mutate thread/private state to manufacture access. |

Serialize lifecycle changes with sends so a concurrent close, lock, archive or access change cannot be bypassed by stale client state. Recheck authoritative eligibility on retry/reconciliation; idempotency is not an access grant. Publish authoritative lifecycle results only for committed state to currently eligible recipients. These are implementation obligations; this document does not establish their runtime completion.

For message sends, hosts may explicitly narrow authority through optional
`ChatPermissionAdapter.authorizeThreadSend({ actor, threadId, parentConversationId, capabilities })`.
Capabilities come from the existing `getCapabilities` adapter. For example, a
host may return `capabilities.includes("thread.send")` for selected parents.
Absent this callback, `message.send` remains sufficient; a missing `thread.send`
capability alone never denies a send. The callback cannot grant parent access,
override archive/lock restrictions, or substitute following for authorization.
It is also checked on completed send retries, which return the original sanitized
message without participation, lifecycle, activity or event side effects.

For this feature, **lock restricts new sends and reopening only**. Edit and
reaction authorization remains governed by its existing rules.

## Safe legacy defaults and scope

Absent host inactivity policy means no inactivity hiding and no automatic close/archive. Existing threads without new lifecycle metadata are treated as open/unlocked while preserving any existing administrative archive. Existing send permission remains the fallback unless an explicit host thread policy narrows it. Existing users retain Current reply style when their style preference is absent; switching either way changes no shared lifecycle facts. Missing private preference rows retain the existing `all`/unmuted default, and missing follow rows retain the legacy active-child recipient fallback above. Initialize only missing storage on authorized writes; never bulk-reset preferences, follows or cursors.

Message-less creation, invitation-only threads, forums, slow mode and Discord subscription tiers/limits are excluded. Existing private-channel threads remain secured by current parent access; excluding invitation-only threads does not remove that security. This policy does not import Discord edit, reaction or slow-mode restrictions, nor replace existing edit/delete/archive authorization. Implementation gaps identified above belong to separate lifecycle, access, participation and delivery work; completing this document does not complete the wider Convergence goal.

## Official research, verified 2026-09-06

The [Discord Threads developer overview](https://docs.discord.com/developers/topics/threads) says `auto_archive_duration` was repurposed to control channel-list visibility. The same page also retains active/archive terminology and describes sends unarchiving unlocked threads. Treat the list timer and explicit archive metadata as distinct concepts when interpreting that page.

The [Discord Threads FAQ](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ) uses closing language for inactivity cleanup, states that closing preserves history, and describes typing or an explicit action to reopen, with moderation restrictions for locked threads. That user-facing terminology does not establish that Handrail hidden, closed and administratively archived states are equivalent. Handrail deliberately defines them separately above.

The [developer overview](https://docs.discord.com/developers/topics/threads) says public threads originate from existing messages. The [Channels Resource](https://docs.discord.com/developers/resources/channel), under “Start Thread from Message,” documents one thread per source message; it separately documents “Start Thread without Message,” with an optional type currently defaulting to `PRIVATE_THREAD`. The endpoint reference therefore describes a broader creation surface than the overview wording alone suggests. This documentation discrepancy does not expand Handrail scope: retain message-rooted canonical creation, without adding message-less or invitation-only creation.
