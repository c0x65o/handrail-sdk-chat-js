# Saved reply and thread style policy

Intended Handrail policy, documented 2026-09-06. This document specifies future
behavior; it does not establish completed persistence, APIs, SDK UI or runtime QA.
The [Reply behavior guide](reply-thread-modes.md) defines the actions and reply
reference contract. The [thread participation policy](thread-participation-policy.md)
defines shared access, participation and lifecycle rules.

## Saved choice and effective style

Expose **Reply and thread style: Current / Discord-style** in both React and
Flutter SDK surfaces, with an obvious way to select either choice. Save one
private preference for the authenticated **tenant + user**, shared across that
user's conversations, devices and both SDK surfaces within that tenant. This is
not a per-conversation or device-only setting, and the same user in another tenant
has an independent choice.

The saved choice records the user's preference. The effective style controls
actions and presentation in the current host integration after applying host
configuration. These may differ: a host can enforce Current while the user's
saved choice remains Discord-style. Enforcing a style must not overwrite the
saved choice or propagate the enforced value as a user preference to other hosts.

Resolve the effective style in this order:

| Priority | Source | When present | When absent |
| --- | --- | --- | --- |
| 1 | Explicit host override | Enforce this style, regardless of saved preference or host default. | Consult saved preference. |
| 2 | Saved tenant + user preference | Use the user's saved style. | Consult host default. |
| 3 | Host default | Use this style until the user saves a choice. | Use Current. |
| 4 | SDK fallback | Current. | Current is always available as the fallback. |

Absence means no choice at that level; it falls through the table. An explicitly
saved Current is a choice and beats a Discord-style host default. A missing saved
preference with an explicit Discord-style host default uses that default. With
no host configuration and no saved choice, existing and new users use Current.

Unknown, malformed or unsupported style values are not opt-ins. At the first
present source in the precedence order, an unrecognized value resolves safely to
Current rather than falling through to a lower-priority Discord-style choice.
A valid higher-priority value still wins over an unknown lower-priority value.
Show that Current is being used because the value is unsupported; do not silently
rewrite a saved unknown value on read. Recognized Discord-style with missing
backend capabilities follows the action-gating rules below, not this value rule.

Display the effective style and its source clearly. When a host enforces a choice,
show, for example, **Current — enforced by this app**, disable the ordinary style
selector and explain why it cannot change here. If different, show **Saved choice:
Discord-style** separately. Removing the override reveals the saved choice, then
the host default or Current if no saved choice exists. A host default alone does
not lock the selector.

## Persistence, loading and migration

The existing [conversation preference contract](../contracts/http/conversation-preference.json)
is conversation-scoped notification, star and mute storage: it defines
`notificationPreference`, `isStarred` and mute fields. It is not global reply-style
storage. This policy does not add a storage table, endpoint, wire enum or client
method; those require their own implementation contracts.

On reload or reconnect, retrieve the authoritative saved preference for the
current tenant + user and reapply current host precedence. Confirmed changes from
React must be reflected in Flutter and vice versa after synchronization. A host
override can keep the effective style unchanged even when the saved choice changes
elsewhere. Reconciliation changes future actions without reinterpreting drafts,
open threads or queued sends.

While loading, show a loading state and do not mistake an unresolved read for an
authoritative absent value. A confirmed cache for the same tenant + user may be
used provisionally under host precedence. Without one, provisionally use the host
override, otherwise host default, otherwise Current, clearly marked as loading.
Keep preference editing disabled until the authoritative value or confirmed
absence is known. If a read fails, retain the provisional style, show the failure
and provide retry; never persist the fallback as if the user selected it.

When saving a new choice, show the requested choice as saving and retain the last
confirmed effective style until persistence succeeds. Do not claim the change is
saved or synchronized before confirmation. On write failure or offline unavailability,
retain the confirmed saved/effective state, keep the requested choice available
for explicit retry, and show an explanation. On uncertain write outcomes,
reconcile with the authoritative preference before retrying; stale loads or save
responses must not overwrite a newer confirmed choice. A style-save failure must
not discard or retry message sends as a side effect.

Legacy users and integrations need no migration opt-in: absent preferences and
absent host configuration resolve to Current. Do not backfill Discord-style,
infer it from messages or follows, or copy conversation notification preferences
into this setting. Do not save a provisional default during upgrade, downgrade,
reload or reconnect. Unknown values use the safe handling above until an explicit
supported choice is saved or the integration understands them. The lifecycle
guide's legacy Current default assumes no explicit host override/default; the
precedence table here governs integrations that deliberately configure one.

## Account and tenant isolation

Derive tenant and user identity from trusted authentication. Persist, cache and
synchronize the choice only within that exact identity pair. Never reuse a
device-wide last choice for a different account or tenant. On logout or identity
switch, detach the old preference state and pending operations before resolving
the new identity's setting. Ignore late reads, save responses and synchronization
updates belonging to the previous identity; a retry must not save its choice into
the newly active account. Retained local drafts and queued sends stay isolated
under their original identity and must never submit using another user's session
or another tenant. Storage details remain separate implementation work.

## Capability and recovery boundaries

Current Reply retains the existing thread behavior. Discord-style Reply composes
in the current channel, DM, group DM or existing thread with a visible source
reference; it never creates a thread or changes conversation. Create Thread /
Open Thread remains a separate, explicit action using the same canonical thread.

When backend capabilities are unsupported or not yet known, disable the affected
new actions with an explanation, such as **Inline replies are unavailable on this
server**. Gate inline replies, named-thread creation and other new controls by
their actual capabilities; a preference is neither capability support nor
authorization. If preference persistence is unsupported, disable saving with an
explanation and apply the available host/default policy without claiming a saved
choice. **Discord Reply must never silently call `openThread`**, including after
a capability loss or a failed send. Explicit supported thread actions remain
available subject to authorization. Recheck capabilities on reconnect; retain
unsupported pending sends as recoverable failures without converting them.

Both styles render named threads and reply references intelligibly, including
thread names, parent context and accessible jumps to source messages. Missing
source access must produce a safe unavailable/deleted placeholder and disabled
jump; redact inaccessible source content from cached previews. Server validation
and authorization remain authoritative. Reference deletion, access revocation or
other validation failures preserve a recoverable composition/send with its
original destination, reference and ping choice. Never silently remove metadata,
send an ordinary message instead, or route to a thread. The user may retry when
valid or deliberately revise a composition and submit a new send.

## Switching with work in progress

A style switch, including one caused by synchronization or host configuration,
affects future Reply actions. Preserve draft text, attachments, selected reply
reference and ping choice, the draft's destination, open-thread identity and
parent/root context, and all pending sends. Keep that destination and reply
context visible even if the newly effective style would start a different Reply
action. Switching alone must not navigate away, clear the composer, turn an
inline draft into a thread send, or move a thread draft into its parent.

At queue time, each send freezes its original tenant/user, destination conversation
ID and reply metadata: whether a reference exists, its source `messageId` and its
explicit `notifyAuthor` value. Preserve these through offline persistence,
application reload, reconnect, reconciliation and retries. Never recompute them
from the current style or currently open conversation. The behavior guide's
initial reply ping default is `notifyAuthor: true`; switching must also preserve
an explicit `false`. The ping controls only reply-derived author notification;
explicit mentions retain their normal behavior. An immutable queued send can be
retried unchanged; deliberate edits belong to a new composition/send, not an
automatic mutation of the old intent.

These concrete examples are intended acceptance behavior, not executed runtime QA.
Assume the necessary capabilities, access and no enforced host override:

| Situation | Mixed-preference example and required result |
| --- | --- |
| Switch while composing | Alice uses Current and posts “Which launch date?” in channel C. Bob uses Discord-style, selects Reply, types “Friday”, attaches a schedule and turns the ping off. He successfully saves Current before sending. His draft still targets C, references Alice's message and retains the attachment and `notifyAuthor: false`. Sending posts the referenced message in C without creating a thread. Alice sees the reference in Current. Bob's next fresh Current Reply on the question opens its canonical thread. |
| Switch with a thread open | Alice stays in Current. Bob uses Current Reply on Alice's question to open thread T, named “Launch date”, and begins a draft there. He saves Discord-style. T remains open with the same parent/root context and draft; sending still goes to T. A new Discord-style Reply to a message inside T also stays in T. Alice can open the very same named T in Current. Switching back preserves T and does not move its history or draft into C. |
| Queue offline, then switch before reconnect | Bob uses Discord-style and queues “Friday” offline in C, referencing Alice's question with `notifyAuthor: false`. He requests Current while still offline; it is visibly unsaved and does not yet change his effective style. Meanwhile, he saves Current on another connected SDK surface for the same tenant + user, while Alice remains in Current. On reconnect, the offline surface loads Current. Its persisted send still targets C with the original reference and false ping, even if preference reconciliation finishes before send retry. Alice receives the referenced channel reply; no thread is created. If access or reference validation fails, retain that intent as a recoverable failure. |

## Shared state stays independent

Changing style never changes message/conversation IDs, permissions, shared
lifecycle facts, histories, links, follows, notification/mute preferences, read
cursors, unread markers or another user's preference. Both styles see the same
authorized messages and canonical threads. There is no conversion of historical
thread messages into channel replies and no duplicate thread per preference.
Ordinary authorized sends and explicit follow/read actions keep their normal
effects; the style change itself performs none of them.

Lifecycle and inactivity policy belongs to the host/conversation scope defined
in the [thread participation policy](thread-participation-policy.md). The default
inactivity policy is disabled. Choosing Discord-style never starts hiding,
closing or archiving old threads, reopens a shared thread, changes lock/archive
authority, deletes history or resets private participation state. Preference
implementation and lifecycle implementation remain separate work.

## React settings integration

`ChatWorkspace` now supplies an **Open workspace settings** button through
`WorkspaceHeader`'s `controls.settings` when neither host settings prop is set.
It opens the small reply-style dialog, contains keyboard focus, supports Escape
and Close, and restores focus to the trigger. The provider, conversation body,
composer and open thread remain mounted while settings open or change.

Existing host ownership is unchanged: `onWorkspaceSettingsOpen` still opens the
host's settings; `workspaceSettingsContent` still supplies the host affordance
(or its button label when the callback is present). A custom
`components.WorkspaceHeader` can render `controls.settings` in its usual place.
To include this control in host-owned settings, render it under the same provider:

```tsx
import { ReplyStyleSettings } from "@handrail/chat/ui";

function HostSettings() {
  return <ReplyStyleSettings />;
}
```

Use `useReplyStyle()` and `useReplyStyleActions()` from `@handrail/chat/react`
for a custom presentation. The subscription hook returns the runtime's immutable
`ChatReplyStyleState`, including `effectiveStyle`, `origin`,
`confirmedPreference`, `requestedStyle`, `editingAvailable`, `disabledReason`,
loading and save status. Actions expose `load()`, `update("current" | "discord")`
and reconciliation-aware `retry()`. The hook loads an idle preference when the
client is ready and unsubscribes when its context runtime changes or it unmounts.
The client owns reconnect/reload and authoritative event updates. Outside a
provider these hooks expose an unavailable, unconfirmed state; actions do not
save anything. `ChatProvider` retains its existing lifetime binding contract;
changing reply style does not require replacing or remounting it.

The native labelled select supports ordinary browser keyboard interaction. The
control separately announces effective style/source and requested unsaved choice,
shows enforced app policy and differing saved choices, and offers explicit retry
for failed reads/saves. It does not expose raw errors. Saving availability comes
from the preference runtime, independently of `inlineReplies` and `namedThreads`.
This settings integration does not implement message-action routing or thread
creation/discovery; those controls must enforce their own capabilities.
