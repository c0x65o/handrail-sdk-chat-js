# ChatWorkspace customization contract

`ChatWorkspace` is the optional, drop-in React shell. Hosts can adopt it as-is,
replace its ten component slots, replace its four body regions, or remove it
entirely and build on the same public headless React API. The runnable
[drop-in React example](../examples/drop-in-react/README.md) and its
[typechecked customization fixture](../examples/drop-in-react/src/customization-contract.tsx)
are the executable counterparts to this guide.

Use only the published entry points:

```tsx
import { ChatProvider } from "@handrail/chat/react";
import { ChatWorkspace } from "@handrail/chat/ui";
import "@handrail/chat/ui/styles.css";
```

There is no iframe integration, global stylesheet contract, hidden UI-only
state API, or private transport shortcut. Custom UIs consume provider hooks and
actions rather than sockets, transport responses, or cache internals. Never
import package-relative `src` or `dist` files.

## Root and themes

The stylesheet import is opt-in. No JavaScript entry point imports CSS. Every
provided selector is rooted at the host-owned `.handrail-chat` element, which
`ChatWorkspace`, `MessageTimeline`, `MessageComposer`, `ThreadPanel`, and
`HuddleControls` add to their own roots. A host may pass `className`, `style`,
and `theme="light" | "dark"` to `ChatWorkspace`; `theme` becomes the root-local
`data-handrail-theme` attribute.

Override variables on that root or a more specific root class loaded after the
package stylesheet. Keep custom descendants under the same root:

```css
.handrail-chat.company-chat-theme {
  --hr-chat-color-accent: #4f46e5;
  --hr-chat-color-on-accent: #ffffff;
  --hr-chat-focus-color: #6366f1;
  --hr-chat-radius-md: 0.75rem;
}

.handrail-chat.company-chat-theme .company-message {
  color: var(--hr-chat-color-text);
}
```

Do not use `:root`, `html`, `body`, a universal selector, or another global
selector for chat customization. The package preserves forced-color focus and
reduces its motion durations for the corresponding user preferences.

### Complete token reference

These are all custom properties exposed by
[`src/ui/styles.css`](../src/ui/styles.css). Defaults shown are the light root
values; dark and accessibility media rules may replace color or duration roles.

| Category | Token | Default |
| --- | --- | --- |
| Typography | `--hr-chat-font-family` | `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| Typography | `--hr-chat-font-size-sm` | `0.875rem` |
| Typography | `--hr-chat-font-size-md` | `1rem` |
| Typography | `--hr-chat-font-size-lg` | `1.125rem` |
| Typography | `--hr-chat-line-height` | `1.5` |
| Typography | `--hr-chat-font-weight-medium` | `500` |
| Typography | `--hr-chat-font-weight-strong` | `600` |
| Spacing | `--hr-chat-space-1` | `0.25rem` |
| Spacing | `--hr-chat-space-2` | `0.5rem` |
| Spacing | `--hr-chat-space-3` | `0.75rem` |
| Spacing | `--hr-chat-space-4` | `1rem` |
| Spacing | `--hr-chat-space-5` | `1.5rem` |
| Spacing | `--hr-chat-space-6` | `2rem` |
| Color | `--hr-chat-color-canvas` | `#ffffff` |
| Color | `--hr-chat-color-surface` | `#ffffff` |
| Color | `--hr-chat-color-surface-muted` | `#f4f6f8` |
| Color | `--hr-chat-color-text` | `#17202a` |
| Color | `--hr-chat-color-text-muted` | `#52606d` |
| Color | `--hr-chat-color-accent` | `#075985` |
| Color | `--hr-chat-color-on-accent` | `#ffffff` |
| Color | `--hr-chat-color-border` | `#cbd2d9` |
| Color | `--hr-chat-color-danger` | `#b42318` |
| Border | `--hr-chat-border-width` | `1px` |
| Border | `--hr-chat-radius-sm` | `0.25rem` |
| Border | `--hr-chat-radius-md` | `0.5rem` |
| Border | `--hr-chat-radius-lg` | `0.75rem` |
| Focus | `--hr-chat-focus-color` | `#0369a1` |
| Focus | `--hr-chat-focus-width` | `3px` |
| Focus | `--hr-chat-focus-offset` | `2px` |
| Motion | `--hr-chat-motion-duration-fast` | `120ms` |
| Motion | `--hr-chat-motion-duration-normal` | `200ms` |
| Motion | `--hr-chat-motion-easing` | `cubic-bezier(0.2, 0, 0, 1)` |
| Layer | `--hr-chat-layer-base` | `0` |
| Layer | `--hr-chat-layer-dropdown` | `100` |
| Layer | `--hr-chat-layer-overlay` | `200` |

## Layout, scope, and selection

`scope` is required and is either `{ type: "organization" }` or
`{ type: "entity", entity: { type, id } }`. The entity is an opaque,
host-authorized ERP reference; the UI never grants entity access.

| Mode | Root-local behavior |
| --- | --- |
| `full-screen` | Navigation and detail fill the host's available surface. |
| `side-panel` | A compact navigation/detail arrangement for a host-owned panel. |
| `modal` | Adds dialog semantics and a root-local keyboard/focus lifecycle: initial focus, contained Tab navigation, an optional close request, and conditional opener-focus restoration. |
| `record` | An entity-oriented embedded layout intended to share a host record page. |

The host chooses the containing geometry for every mode. In particular, modal
mode remains inside the rendered React tree and the `.handrail-chat` root. The
SDK does not create a portal or backdrop, hide unrelated document content, lock
scrolling, or provide a visible close affordance.

Pass `onModalCloseRequest` when the host wants unhandled Escape presses to
request dismissal. The callback is a request only: the host must change `mode`
or unmount `ChatWorkspace` to close it. On entry, the SDK captures the connected
focused element and moves focus to the conversation filter, the first available
workspace control, or the focusable dialog root. Tab and Shift+Tab then cycle
inside the root. Nested Handrail dialogs, menus, and pickers keep their own
keyboard handling and focus restoration because prevented or consumed events
do not trigger the workspace handler.

When the host unmounts the modal or changes it to a non-modal mode, the SDK
returns focus to the captured element only if that element is still connected
and focus still belongs to the workspace. If the host or user intentionally
moved focus elsewhere first, the SDK leaves it there.

```tsx
const [chatOpen, setChatOpen] = useState(false);

{chatOpen ? (
  <ChatWorkspace
    mode="modal"
    onModalCloseRequest={() => setChatOpen(false)}
    scope={{ type: "organization" }}
  />
) : null}
```

Selection is uncontrolled when `conversationId` is omitted.
`defaultConversationId` is the initial preference; if it is absent or no longer
in scope, the first scoped conversation is selected. Supplying
`conversationId` makes selection controlled. Pass `null` to intentionally show
no selected conversation, and update the value in `onConversationChange`.

```tsx
const [conversationId, setConversationId] = useState<
  Parameters<typeof useConversation>[0] | null
>(null);

<ChatWorkspace
  conversationId={conversationId}
  mode="record"
  onConversationChange={setConversationId}
  scope={{
    type: "entity",
    entity: { type: "sales-order", id: "SO-1042" },
  }}
/>;
```

The typechecked fixture renders all four mode literals and both scope shapes.

### Message search and result routing

`ChatWorkspace` includes a narrow message-search panel in its conversation
navigation. Search text is debounced by the public `useMessageSearch` hook, and
the optional conversation, author user ID, sent-after, and sent-before controls
map directly to `MessageSearchFilters`. Results remain transient authorized
search data: the workspace does not inspect or hydrate the normalized cache to
produce them, and snippets are rendered as plain text rather than markup.

By default, activating a result selects its conversation through the same
controlled or uncontrolled selection contract described above. The workspace
then waits for that conversation's timeline to render, locates the exact
focusable `data-message-id` row, scrolls it into view, and focuses it. A bounded
alert and retry control are shown if the conversation or message was deleted,
is unavailable, or does not hydrate in time.

Hosts with custom routers can override activation with
`onMessageSearchResultActivate`. The callback owns routing when present; call
the provided `navigateDefault()` function to compose host routing with the
standard selection, hydration, scroll, and focus behavior:

```tsx
<ChatWorkspace
  onMessageSearchResultActivate={async ({ result, navigateDefault }) => {
    analytics.track("chat_search_result_opened", {
      conversationId: result.conversationId,
    });
    await navigateDefault();
  }}
  scope={{ type: "organization" }}
/>
```

`navigateDefault()` resolves to `true` when the target was focused and `false`
when the bounded fallback was used. A host can omit that call when its router
fully owns result navigation.

### Host-authorized channel creation

The default navigation renders channel creation only when the host explicitly
passes `channelCreationAvailability={{ canCreate: true }}`. Omitting the prop,
passing `canCreate: false`, or setting `readOnly` renders no creation control.
This is a fail-closed availability contract: `ChatWorkspace` never derives
authorization from `currentMember.role` or another role string.

```tsx
<ChatWorkspace
  channelCreationAvailability={{ canCreate: chatCapabilities.canCreateChannel }}
  scope={{ type: "organization" }}
/>
```

The form requires the user to choose Public or Private and sends the trimmed,
Unicode-NFC channel name to the public `createChannel` action. For an entity
scope, the same opaque host-authorized entity reference is included in the
creation input. A successful result selects the authoritative conversation ID;
controlled hosts receive it through `onConversationChange`. Non-success results
remain in the dialog so the user can review the details and retry.

### Host-authorized group-direct creation

The default navigation renders group conversation creation only when the host
passes `groupDirectCreationAvailability={{ canCreate: true }}`. As with the
other creation controls, omission, denial, or `readOnly` keeps the affordance
hidden. Pass `currentUserId` when available so the trusted actor is excluded
from the directory choices and creation input.

```tsx
<ChatWorkspace
  currentUserId={session.userId}
  groupDirectCreationAvailability={{
    canCreate: chatCapabilities.canCreateGroupDirect,
  }}
  scope={{ type: "organization" }}
/>
```

The dialog retains selected people while searching, requires at least two
distinct non-actor users, and sends their IDs in deterministic order through
`createGroupDirect`. Successful created, equivalent, and replayed results all
select the authoritative conversation ID. Failed requests retain the selection
for an actionable retry.

## Conversation-filter keyboard shortcut

The default workspace handles an unmodified `/` only when the key event starts
inside that `ChatWorkspace` root from its canonical navigation or timeline
controls. An accepted shortcut reveals the navigation in compact layouts,
focuses the conversation filter, preserves its current query, and selects the
whole query so the next edit predictably replaces it. Escape in a nonempty
filter clears the query and keeps focus in the field.

This is an embeddable, root-local contract: `ChatWorkspace` does not register a
document- or window-level shortcut. It ignores modified keys and events from
editable controls, the composer, message search, creation UI, menus, dialogs,
outside hosts, and the `WorkspaceHeader` slot. A custom `WorkspaceHeader` must
spread its supplied `hostProps` onto its outer element to preserve that
host-owned exclusion boundary, along with the slot's other keyboard and
accessibility behavior.

## Component slots

Pass `workspaceIdentity={{ id?, name, description? }}` to replace the default
`Conversations` navigation title with renderer-safe workspace identity. The
identity is supplied by the host and is never derived from scope, tenant,
actor, client, transport, provider, credential, or token state.

`workspaceMenuContent` and `workspaceSettingsContent` accept host-owned
affordances. When paired with `onWorkspaceMenuOpen` or
`onWorkspaceSettingsOpen`, `ChatWorkspace` wraps the supplied content (or a
default compact icon) in a wired button. Content supplied without a callback is
passed through as an already-wired host node. Omit both content and callback to
render no corresponding affordance.

Pass a partial `ChatWorkspaceSlotOverrides` map through `components`; omitted
entries retain their defaults. Every slot receives normalized, renderer-safe
data. Trusted tenant/actor identity, credentials, provider descriptors,
transport state, raw realtime events, and client internals are intentionally
absent.

Every slot also receives `hostProps` for its outer host element. Spread those
props onto that element, preserve its `ref`, event handlers, WAI-ARIA and data
attributes, and merge rather than replace `hostProps.className`. `children` and
`dangerouslySetInnerHTML` are intentionally not forwarded; the renderer owns
its children. Moving `hostProps` to a nested element can break focus,
measurement, submission, keyboard, and accessibility behavior.

| Slot | Normalized props | Actions or controls |
| --- | --- | --- |
| `WorkspaceHeader` | optional `identity: ChatWorkspaceIdentityViewModel`, div `hostProps` | Already-wired `messageSearch`, `createConversation`, optional host `menu`, and optional host `settings` nodes. |
| `Avatar` | `user: HostDirectoryUserSummary`, `size: "small" \| "medium" \| "large"`, span `hostProps` | None. |
| `Message` | `message: ChatMessageViewModel`, element `hostProps` | `retryMessage`, `editMessage`, `deleteMessage`, `setReaction`, `openThread`, `saveMessage`, `unsaveMessage`. |
| `ChannelHeader` | `conversation: ChatConversationViewModel`, element `hostProps` | `archiveConversation`, `restoreConversation`, `updateConversationPreference`, `startHuddle`, `joinHuddle`, `leaveHuddle`, `endHuddle`. |
| `Composer` | `conversation`, `draft`, `state`, form `hostProps` | Scoped composer `actions` plus UI-level `controls`, detailed below. |
| `EmptyState` | `kind`, `title`, optional `description`, element `hostProps` | None. |
| `Attachment` | `attachment: ChatAttachmentViewModel`, element `hostProps` | None. |
| `LinkPreview` | `linkPreview: ChatLinkPreviewViewModel`, element `hostProps` | None. |
| `SystemEvent` | `event: ChatSystemEventViewModel`, element `hostProps` | None. |
| `User` | `user: HostDirectoryUserSummary`, element `hostProps` | `createDirect`, `createGroupDirect`, `addConversationMember`, `removeConversationMember`. |
| `EntityReference` | `entityReference: ChatEntityReferenceViewModel`, element `hostProps` | None. |

The view models have these public fields:

- `ChatWorkspaceIdentityViewModel` carries optional host workspace `id`, a
  display `name`, and optional `description`. It explicitly excludes trusted
  tenant, actor, client, provider, transport, credential, and token fields.
- `ChatConversationViewModel` is the `Conversation` discriminated union without
  `tenantId`: common `id`, `type`, timestamps and archive state, plus the
  channel/direct/group/thread fields appropriate to that `type`.
- `HostDirectoryUserSummary` is `active`, `redacted`, or `unavailable`. Only an
  active user carries `displayName`, renderer-safe `avatar`, and optional
  status. Never invent hidden directory details for the other variants.
- `ChatMessageViewModel` carries `id`, `conversationId`, `sequence`, timestamps,
  revision, nullable content/deletion fields, reactions, attachment metadata,
  thread fields, optional normalized `author`, and reduced `delivery`,
  `editState`, and `deleteState` UI states. It excludes optimistic retry and
  idempotency internals.
- `ChatComposerDraftViewModel` carries `status`, `dirty`, `conflict`, `message`,
  and optional renderer-safe `content`. `ChatComposerState` carries label,
  placeholder, text/format, attachment display states, disabled/read-only state
  and reason, submission/error state, and an announcement `status`.
- `ChatAttachmentViewModel` carries public `attachment` metadata plus optional
  `uploadStatus` and `uploadProgress`; it never carries a storage provider key.
- `ChatLinkPreviewViewModel` carries normalized absolute HTTP(S) `url` and
  `title` strings plus optional non-empty `description`, `siteName`, and
  absolute HTTP(S) `imageUrl` strings. It never exposes the raw message block.
  The exact `link_preview` block falls back to unsupported content when a
  required field is absent or empty, an optional supplied field is empty, or a
  destination/image URL is malformed or uses any scheme other than HTTP(S).
  The default renderer uses React text nodes and never evaluates block fields
  as raw HTML.
- `ChatSystemEventViewModel` carries `id`, `conversationId`, `kind`,
  `occurredAt`, `summary`, optional safe `actorUser`, and optional scalar/null
  `details`. It is not a raw realtime event.
- `ChatEntityReferenceViewModel` carries the opaque `{ type, id }` entity,
  `label`, and optional `description`.

The composer action subset is `sendMessage`, `replaceConversationDraft`,
`clearConversationDraft`, `flushConversationDraft`, `retryConversationDraft`,
`uploadAttachment`, `startTyping`, and `stopTyping`. Prefer its UI-level
`controls` inside a replacement: `setText`, `setFormat`, `send`, `retrySend`,
`retryDraft`, `addAttachments`, `cancelAttachment`, `removeAttachment`, and
`blur`. Those controls preserve the default composition behavior and expose
only transient `File` values to `addAttachments`.

### Practical slot renderers

This excerpt uses only the public UI entry point. The complete, typechecked
versions also cover `Avatar`, `ChannelHeader`, and `EmptyState` in
[`company-slots.tsx`](../examples/drop-in-react/src/company-slots.tsx).

```tsx
import type {
  ChatAttachmentSlotProps,
  ChatComposerSlotProps,
  ChatEntityReferenceSlotProps,
  ChatLinkPreviewSlotProps,
  ChatMessageSlotProps,
  ChatSystemEventSlotProps,
  ChatUserSlotProps,
  ChatWorkspaceSlotOverrides,
} from "@handrail/chat/ui";

const Message = ({ message, hostProps }: ChatMessageSlotProps) => (
  <article {...hostProps} className={`company-message ${hostProps.className ?? ""}`}>
    <p>{message.content?.text ?? "This message was removed."}</p>
  </article>
);

const Composer = ({ state, controls, hostProps }: ChatComposerSlotProps) => (
  <form {...hostProps} className={`company-composer ${hostProps.className ?? ""}`}>
    <label>
      {state.inputLabel}
      <textarea
        disabled={state.disabled}
        onBlur={controls.blur}
        onChange={(event) => controls.setText(event.currentTarget.value)}
        readOnly={state.readOnly}
        value={state.text}
      />
    </label>
    <button disabled={!state.canSubmit} type="submit">Send</button>
    <span aria-live="polite" role="status">{state.status.message}</span>
  </form>
);

const Attachment = ({ attachment, hostProps }: ChatAttachmentSlotProps) => (
  <article {...hostProps}>
    <a href={attachment.attachment.downloadUrl}>{attachment.attachment.fileName}</a>
  </article>
);

const LinkPreview = ({ linkPreview, hostProps }: ChatLinkPreviewSlotProps) => (
  <article {...hostProps}>
    <a href={linkPreview.url} rel="noopener noreferrer" target="_blank">
      {linkPreview.siteName && <small>{linkPreview.siteName}</small>}
      <strong>{linkPreview.title}</strong>
      {linkPreview.description && <span>{linkPreview.description}</span>}
      {linkPreview.imageUrl && (
        <img alt="" loading="lazy" referrerPolicy="no-referrer" src={linkPreview.imageUrl} />
      )}
    </a>
  </article>
);

const SystemEvent = ({ event, hostProps }: ChatSystemEventSlotProps) => (
  <p {...hostProps}><time dateTime={event.occurredAt}>{event.summary}</time></p>
);

const User = ({ user, hostProps }: ChatUserSlotProps) => (
  <span {...hostProps}>{user.kind === "active" ? user.displayName : "Chat user"}</span>
);

const EntityReference = ({ entityReference, hostProps }: ChatEntityReferenceSlotProps) => (
  <a {...hostProps} href={`/erp/${entityReference.entity.type}/${entityReference.entity.id}`}>
    {entityReference.label}
  </a>
);

const components = {
  Message,
  Composer,
  Attachment,
  LinkPreview,
  SystemEvent,
  User,
  EntityReference,
} satisfies ChatWorkspaceSlotOverrides;
```

The ERP link is host routing, not SDK authorization; validate access in the
host before resolving the linked record.

## Body renderers and collaboration surfaces

After a conversation is selected and hydrated, `renderTimeline`,
`renderComposer`, `renderThread`, and `renderHuddle` each receive the same
`ChatWorkspaceBodyProps`: renderer-safe `conversation`, public bound `actions`,
and the fully resolved `slots`. Each provided renderer replaces only that body
region.

If `renderTimeline` is absent, `children` is used as a static timeline body; if
both are absent, the default `MessageTimeline` renders. `children` does not
replace navigation, header, thread, huddle, or composer. The other three
regions have no `children` fallback.

```tsx
import {
  ChatWorkspace,
  HuddleControls,
  MessageComposer,
  MessageTimeline,
  ThreadPanel,
  type ChatWorkspaceBodyProps,
} from "@handrail/chat/ui";

const renderTimeline = ({ conversation, slots }: ChatWorkspaceBodyProps) => (
  <MessageTimeline conversationId={conversation.id} slots={slots} />
);

const renderComposer = ({ conversation, slots }: ChatWorkspaceBodyProps) => (
  <MessageComposer
    components={{ Composer: slots.Composer }}
    conversation={conversation}
    conversationId={conversation.id}
  />
);

<ChatWorkspace
  renderTimeline={renderTimeline}
  renderComposer={renderComposer}
  renderThread={({ conversation }) => <HostThreadRegion conversationId={conversation.id} />}
  renderHuddle={({ conversation }) => <HostHuddleRegion conversationId={conversation.id} />}
  scope={{ type: "organization" }}
/>;

// A host-owned panel can compose these public surfaces directly:
<ThreadPanel rootMessageId={rootMessageId} />;
<HuddleControls
  conversationId={conversationId}
  currentUserId={currentUserId}
  permissions={huddlePermissions}
/>;
```

The default thread is opened from `MessageTimeline`, displayed with
`ThreadPanel`, and returns focus to the opener on close. When `renderThread` is
provided, the host owns open/close/root-message state and focus restoration.
The default timeline also offers Forward for canonical sent text/markdown
messages that have no attachment references or structured blocks. Its
workspace-owned picker uses the authorized `useConversations` list, omits the
source, archived, and thread conversations, confirms the message preview and
destination, then selects and focuses the canonical destination row returned by
`forwardMessage`. Standalone/custom timelines can compose the same safe
boundary with `MessageTimeline.onForwardMessage`; message slots receive only
the source message id request and never receive the client or authorization
state.
The default huddle body renders only when both `currentUserId` and
`huddlePermissions` are supplied. `huddlePermissions` includes explicit
microphone and device-selection grants; the UI never infers them from roles.
Pass a host-owned `huddleMediaSession` for the default connection, microphone,
device, speaker, and screen-share controls. `huddleMediaRenderer` remains the
custom descriptor-handoff override and takes precedence when both are present.
`huddleDisabled` and `composerAvailability`/`readOnly` are host-authoritative
restrictions, and `huddleParticipantLabel` maps canonical participants to
host-visible names.

## Accessibility ownership

The default shell supplies labeled navigation, roving arrow/Home/End keyboard
selection, loading status and error alert regions, an accessible channel form
with pending/error announcements, header/main/timeline/thread/huddle/composer
landmarks, thread focus restoration, composer labels and live announcements,
and huddle status/action semantics. In modal mode, the SDK owns root-local
dialog semantics, initial focus, Tab containment, unhandled-Escape close
requests, and conditional opener-focus restoration. The host owns the trigger,
the actual close state change or unmount, backdrop, document-level isolation,
close affordance, and scroll locking.

A slot renderer assumes responsibility for the semantics inside its own outer
element while still forwarding `hostProps`. A body renderer assumes the whole
replaced region's responsibilities: accessible name and landmarks, loading and
error announcements, keyboard operation, focus movement/restoration, disabled
and read-only communication, attachment progress, optimistic failure/retry
feedback, and non-color state cues. A fully headless UI assumes all of these.
Keep visible focus styles and reduced-motion/forced-color behavior when
replacing the package styles.

## Fully headless replacement

The optional UI has no privileged state or command path. A complete replacement
uses `ChatProvider`, public query hooks, and `useChatActions`; the client behind
the provider remains responsible for snapshots, normalized state, optimistic
reconciliation, reconnect/replay, and realtime ordering.

```tsx
import { useState, type FormEvent } from "react";
import {
  ChatProvider,
  useChatActions,
  useConversation,
  useMessages,
  useReadState,
} from "@handrail/chat/react";

type ConversationId = Parameters<typeof useConversation>[0];

function CompanyChat({ conversationId }: { conversationId: ConversationId }) {
  const conversation = useConversation(conversationId);
  const messages = useMessages(conversationId);
  const unread = useReadState(conversationId);
  const actions = useChatActions(conversationId);
  const [text, setText] = useState("");

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await actions.sendMessage({
      content: { format: "plain", text: text.trim() },
    });
    if (result.status === "success") setText("");
  };

  return (
    <section aria-labelledby="company-chat-title">
      <h1 id="company-chat-title">
        {conversation.data?.type === "channel" ? conversation.data.name : "Conversation"}
      </h1>
      <p>{unread.data?.unreadCount ?? 0} unread</p>
      {messages.status === "error" ? <p role="alert">{messages.error.message}</p> : null}
      <ol aria-label="Messages">
        {(messages.data?.messages ?? []).map((message) => (
          <li key={message.id}>{message.content?.text ?? "Message deleted"}</li>
        ))}
      </ol>
      <form onSubmit={(event) => void send(event)}>
        <label htmlFor="company-chat-message">Message</label>
        <textarea
          id="company-chat-message"
          onChange={(event) => setText(event.currentTarget.value)}
          value={text}
        />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}

<ChatProvider
  config={{
    endpoint: "/api/chat",
    async getAccessToken() {
      const response = await fetch("/api/chat/session", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Chat session unavailable");
      return response.text();
    },
  }}
>
  <CompanyChat conversationId={conversationId} />
</ChatProvider>;
```

The fuller [typechecked headless fixture](../examples/drop-in-react/src/customization-contract.tsx)
also demonstrates typing state, read actions, thread opening, status regions,
and provider configuration. It deliberately contains no internal UI API, raw
socket subscription, direct transport/cache access, or package-relative import.

For headless lifecycle and recovery details, continue with the
[headless client and React guide](headless-client-react.md). For the lower-level
CSS primitives and preference behavior, see [optional UI styles](ui-styles.md).

## Additional semantic tokens

These defaults cover the navigation, presence, state, and compact controls. Override them on your scoped chat theme.

| Token | Default |
| --- | --- |
| `--hr-chat-font-size-xs` | `0.75rem` |
| `--hr-chat-color-surface-raised` | `#ffffff` |
| `--hr-chat-color-success` | `#067647` |
| `--hr-chat-color-success-background` | `#ecfdf3` |
| `--hr-chat-color-warning` | `#854d0e` |
| `--hr-chat-color-warning-background` | `#fffaeb` |
| `--hr-chat-color-danger-background` | `#fef3f2` |
| `--hr-chat-color-navigation-background` | `#1f2933` |
| `--hr-chat-color-navigation-text` | `#f0f4f8` |
| `--hr-chat-color-navigation-text-muted` | `#bcccdc` |
| `--hr-chat-color-navigation-hover-background` | `#334e5c` |
| `--hr-chat-color-navigation-error` | `#fecaca` |
| `--hr-chat-color-starred` | `#fbbf24` |
| `--hr-chat-color-starred-selected` | `#fde68a` |
| `--hr-chat-color-conversation-background` | `#f8fafc` |
| `--hr-chat-color-selected-background` | `#075985` |
| `--hr-chat-color-selected-text` | `#ffffff` |
| `--hr-chat-color-hover-background` | `#e8eef3` |
| `--hr-chat-color-surface-composer` | `#ffffff` |
| `--hr-chat-color-surface-menu` | `#ffffff` |
| `--hr-chat-color-surface-action` | `#ffffff` |
| `--hr-chat-color-border-subtle` | `#e4e9ed` |
| `--hr-chat-color-border-strong` | `#9aa5b1` |
| `--hr-chat-color-presence-online` | `#067647` |
| `--hr-chat-color-presence-away` | `#a15c07` |
| `--hr-chat-color-presence-offline` | `#7b8794` |
| `--hr-chat-color-unread-background` | `#075985` |
| `--hr-chat-color-unread-text` | `#ffffff` |
| `--hr-chat-color-mention-background` | `#c2410c` |
| `--hr-chat-color-mention-text` | `#ffffff` |
| `--hr-chat-color-muted-background` | `#edf1f4` |
| `--hr-chat-color-muted-text` | `#52606d` |
| `--hr-chat-color-error` | `var(--hr-chat-color-danger, #b42318)` |
| `--hr-chat-color-error-background` | `var(--hr-chat-color-danger-background, #fef3f2)` |
| `--hr-chat-control-size-compact` | `2rem` |
| `--hr-chat-icon-size-compact` | `1rem` |
| `--hr-chat-shadow-sm` | `0 1px 3px rgb(15 23 42 / 8%)` |
| `--hr-chat-shadow-lg` | `0 1rem 2rem rgb(15 23 42 / 18%)` |
| `--hr-chat-elevation-menu` | `0 0.5rem 1.5rem rgb(15 23 42 / 18%)` |
