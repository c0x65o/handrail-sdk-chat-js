# Current and Discord-style Reply behavior

Current Reply opens the source message's separate thread stream. The intended
Discord-style Reply instead composes and sends in the conversation already being
viewed, with a reference to the source message. Creating or opening a thread is
an independent action. This changes message behavior and data, not just styling.

This document records source observations at SDK HEAD `d4371fb` and the intended
Handrail contract. Source and external citations were validated on **2026-09-06**.
It does not establish completed implementation or runtime QA; concurrent workspace
changes are not part of the pinned baseline.

## Observed source baseline

These references describe `d4371fb`; line numbers refer to that revision, while
the relative links open the checkout's files.

- React [src/ui/message-timeline.ts](../src/ui/message-timeline.ts), lines
  780–783: the action labelled Reply calls `actions.openThread(message.id)`.
- Flutter [handrail_message_timeline.dart](https://github.com/c0x65o/handrail-sdk-chat-flutter/blob/main/lib/src/handrail_message_timeline.dart),
  lines 981–994: Reply calls `actions.openThread()` when no host callback is
  supplied, or delegates to `widget.onThreadRequested` with the message actions.
  This is a thread entry point, not a same-conversation reply composition.
- [src/contracts/conversation.ts](../src/contracts/conversation.ts),
  `ConversationBase` and `ThreadConversation`: threads already have their own
  conversation IDs, plus required `parentConversationId` and `rootMessageId`.
  The baseline forbids a thread `name`.
- [src/contracts/thread-creation.ts](../src/contracts/thread-creation.ts),
  `ThreadCreationInput` and `ThreadCreationReconciliationStatus`: creation requires
  a root message and reconciles to one canonical thread per root, including the
  `existing_for_root` result. The target reuses this model and existing stream IDs.
- [src/contracts/message.ts](../src/contracts/message.ts), `MessageBase`,
  `MessageComposition` and `ForwardedMessageSnapshot`: the baseline has
  `threadSummary` and forwarded-message attribution, but no first-class `replyTo`
  reference on messages or compositions.

## Discord comparison and intended behavior

Discord documents replies within the same channel, retaining the source context,
with a recipient ping that defaults on and can be switched off.
[Discord Replies FAQ](https://support.discord.com/hc/en-us/articles/360057382374-Replies-FAQ)
(validated 2026-09-06).

Discord separately documents Create Thread from a message and a dedicated space
for the discussion, with a thread title option.
[Discord Threads FAQ](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ)
(validated 2026-09-06).

The following behavior is Handrail's target contract. The SDK data, access and
recovery rules below are project requirements, not claims about Discord's API.

| Action or situation | Current mode to preserve | Discord-style mode target |
| --- | --- | --- |
| Reply to a root in the parent conversation | Open the root's separate thread stream; subsequent messages go there. | Compose and send in the current conversation with a visible source reference. Do not create a thread or change destination. |
| Supported inline reply destinations | Render incoming reply references even though Reply remains a thread entry point. | The current channel, DM, group DM or existing thread. |
| Create Thread / Open Thread | Preserve thread entry points and access to the canonical discussion. | Offer an explicit action independently of inline Reply; create the root's discussion if allowed, or open its existing canonical thread. |
| Reply while inside a thread | Keep discussion in that thread. | Send the inline reply in that same thread, referencing a message there. |
| Read messages containing new references | Render the reference and an accessible jump to its source. | Render the same reference and accessible jump. |

There are no nested threads. A thread's parent root context is not a source for
an inline reply sent inside the thread, because that root belongs to a different
conversation. There are no historical conversions: selecting a style never moves
old messages, turns thread messages into channel replies, changes IDs or creates
duplicate discussions. Both modes retain the same authorized messages and threads;
a preference does not grant or remove access.

## Alice and Bob with different preferences

Alice uses Current mode and posts **“Which launch date?”** in a channel. Bob uses
Discord-style mode, selects Reply on Alice's message and sends **“Friday”**.
“Friday” appears beside the ongoing messages in that same channel, referencing
Alice's question; no thread is created. Alice still sees Bob's reference in
Current mode and can jump to her question while it is accessible.

As the Current Reply alternative, if Bob chooses Current mode and selects Reply
on the question, it opens the root's separate stream. Sending “Friday” there puts
it in that thread, not in the parent channel. The root remains in the channel.

As the independent thread alternative, either user can select Create Thread on
the question to start a separate discussion, intended to support a name such as
“Launch date”. If a thread already exists for that root, Open Thread opens that
same canonical discussion. A thread reached through Current Reply is the same
one reached through Create/Open Thread; the two users' choices never fork it.
Alice and Bob can both read authorized channel messages and open authorized
threads regardless of preference. If Bob uses Discord-style Reply on “Friday”
inside the thread, his new message and its reference stay in that thread.

## Intended reply reference contract

Messages and compositions gain an optional, top-level `replyTo` object alongside
`content`, with this shape:

```ts
replyTo?: {
  readonly messageId: MessageId;
  readonly notifyAuthor: boolean;
};
```

When `replyTo` is present, **both fields are required**. `messageId` identifies
the source; `notifyAuthor` records the reply-author notification choice. Omitting
the entire object means there is no inline reply reference. This is a first-class
reference, never forwarded-message snapshot data or a field inside `content`.

The selected reference is an immutable value. Before sending, the user may
deliberately replace it, remove it or change the ping choice by composing a new
value. Once queued or sent, its presence, source ID and notification choice are
immutable metadata. Retries, message edits and preference switches must preserve
that metadata and the queued send's original destination.

Reply-author notification defaults on when composing a reply, so the initial
value is `notifyAuthor: true`. Turning it off suppresses the reply-derived author
ping only; explicit mentions remain intact and retain their normal notification
behavior. The required boolean records the choice even when it is the default.

References must target a source in the **same tenant and conversation** as the
reply. The server must validate the reference and authorization; a client-supplied
message ID cannot confer access or select a different destination.

Both modes resolve source context under the current viewer's access. Show source
context and enable jump-to-original only when accessible. Deleted or unavailable
sources use safe placeholders such as “Message deleted” or “Message unavailable”
and disabled jumps. Redact previously resolved context when access is lost; do
not expose inaccessible text, author details or other source content through a
preview, cached snapshot or error.

If the source becomes stale before send and validation fails, show a recoverable
failure while preserving the composition, its reference and its destination.
Never silently drop the reference, send an ordinary message instead, or retarget
the send to the source's thread or another conversation. The user can retry when
valid, or deliberately revise the composition before submitting a new send;
automatic retry must retain the original queued metadata.

## Scope boundary

This item is documentation only. Saved preference persistence, absence/default
handling and host precedence are defined in the
[saved reply-style policy](reply-style-settings.md). Thread participation and lifecycle policy belong to the separate
`docs/thread-participation-policy.md` item. This document does not define those
policies. Thread naming, contracts, storage, notifications, UI and runtime QA
remain implementation or verification work in their own items; no production
code, generated files, settings UI, lifecycle behavior or Flutter preview changes
are delivered here.
