# Reply and thread deployment capabilities

`contracts/realtime/handshake.json` reserves the following names in the existing
forward-compatible `enabledFeatures` boolean map. The handshake generator emits
`CHAT_REPLY_THREAD_FEATURES` / `ChatReplyThreadFeature` for TypeScript (exported
through the package contracts) and `ChatReplyThreadFeatures` for Dart (exported
through `core.dart`). No protocol version or negotiation changes are involved.
The existing saved-style descriptor/constant retains `reply_style_preference_v1`;
generation tests enforce agreement with the reserved map.

Every flag defaults to false. A true **configured** flag is an opt-in, while a
true **advertised** flag means the installed server and storage support it.
`runtime.config.features` describes configuration; HTTP, snapshot and WebSocket
metadata advertise effective readiness. Availability is never actor permission.

| Reserved flag | Effective prerequisites in addition to explicit opt-in | Gated action |
| --- | --- | --- |
| `inlineReplies` | Shared safe reads below; source-context route/query; same-conversation send validation and persisted reply identity; immutable identity carried by edit/delete; write storage and privileges | A send containing `replyTo` |
| `namedThreads` | Shared safe reads; named creation and one-thread-per-root reconciliation; attachment preparation/download parent access; names migration; write storage and privileges | Creation request containing `name` |
| `reply_style_preference_v1` | Existing saved-style migration readiness, writable preference/idempotency/audit/outbox storage and claim-function privileges | GET/PATCH `/preferences/reply-style` |
| `threadLifecycle` | Wired lifecycle command, parent access and send/reopen enforcement; conversation/member, lifecycle, idempotency and outbox storage; write/lock privileges | Explicit close/reopen/lock/unlock transitions |
| `threadDiscovery` | Wired authorized thread-list handler and shared safe read storage/privileges | GET `/conversations/:parentConversationId/threads` |
| `threadInactivity` | Effective discovery readiness **and** a wired explicit host `threadInactivityPolicy` function | Discovery's computed inactivity hiding |

The flags are independent except for inactivity's actual discovery dependency.
Lifecycle requires neither saved style nor reply columns. Inline replies do not
require named creation, saved style, discovery or lifecycle **opt-in**. Their
readers and send path do require lifecycle **storage**, because that code reads
shared lifecycle facts and enforces existing locks/reopen rules. Named creation
also needs reply storage for root hydration and unread projections. Enabling a
saved preference starts no lifecycle or inactivity policy.

## Implementation prerequisites

The shared safe-read implementation is installed as part of this SDK server:

- `thread-access.ts`, conversation detail/list/timeline and thread snapshot
  queries, and `websocket-subscriptions.ts` retain parent access checks.
- `notification-dispatcher.ts` filters thread recipients through parent access
  and validates reply-ping source eligibility. `unread-mention-sql.ts` supplies
  reply-aware unread projections. No notification delivery adapter, push-token
  protector, audit adapter or external realtime adapter is required merely to
  enable reply/thread availability.
- `message-context-query.ts` and its HTTP route resolve authorized sources;
  `send-message-command.ts` validates and stores `replyTo` in the destination
  conversation. `edit-message-command.ts` and `soft-delete-message-command.ts`
  carry its immutable identity in reconciliation/event results.
- `create-thread-command.ts` persists names with canonical root reconciliation;
  `prepare-attachment-command.ts` and `attachment-download-query.ts` call
  `authorizeThreadAccess` for parent-safe attachment access.

`reply-thread-readiness.ts` lists the precise canonical migration objects for
those storage paths, rather than accepting the highest schema version or task
ledger status. Shared reads require migrations 1, 2, 4, 8, 9, 15–18, 23, 32, 39
and 43. Inline/named writes additionally require 5, 6, 10 and 11; named creation
also requires 40. Lifecycle independently requires 1, 5, 6, 15 and 43. Saved
style retains its existing prerequisite check through migration 41.

Checks are read-only and uncached. They verify migration compatibility and
required IDs, schema usage, per-table SELECT/write/row-lock privileges, claim
function execution for writes, and writable transaction state for writes.
Column probes catch missing reply/lifecycle columns even with a stale migration
ledger. Read-only deployments may still advertise discovery. These checks cannot
guarantee that a later transaction succeeds after a database or privilege change;
the command/query paths retain their existing sanitized availability errors.

## Compatibility and errors

Current mode still opens the separate root thread. Inline Reply posts in the
current conversation with a source reference; it does not call thread creation
or choose a new destination. Ordinary sends and unnamed legacy `openThread`
requests bypass the optional write gates. Existing authorized reply references,
named thread reads, IDs, histories and root reconciliation remain available with
all optional flags off. The flags never authorize a user or bypass the existing
trusted actor, capability, membership or entity checks.

Valid new actions with an absent/false flag return HTTP 501 and one of
`chat_inline_replies_disabled`, `chat_named_threads_disabled`,
`chat_reply_style_preference_disabled`, `chat_thread_lifecycle_disabled`, or
`chat_thread_discovery_disabled`. Enabled actions whose prerequisites are
unavailable return HTTP 503 with the existing route's unavailable code/message
(including uppercase `CHAT_MESSAGE_SEND_UNAVAILABLE` and
`CHAT_THREAD_CREATION_UNAVAILABLE`). Normal malformed-request validation remains
in force. No error silently redirects a reply to a thread.

Inactivity is discovery-only, never a background archive mutation. Its resolver
runs after trusted tenant/parent authorization. An invalid, throwing or false
policy result disables hiding for that request; metadata advertises the wired
policy integration, not a per-conversation promise to hide anything. Discovery's
`lifecycleSupported` is the effective lifecycle capability and remains false
when lifecycle is disabled or unavailable.

Verification commands and results: [focused validation](validation/reply-thread-capabilities.md).
