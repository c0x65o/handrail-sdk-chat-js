# Optional UI styles

Handrail Chat's styling foundation is opt-in. Import it explicitly alongside the
UI JavaScript entry point:

```ts
import "@handrail/chat/ui/styles.css";
import * as chatUi from "@handrail/chat/ui";
```

No JavaScript entry point imports CSS, so applications using `@handrail/chat`,
`/client`, `/react`, or `/ui` do not receive styles unless they request this
subpath.

## Root scope

Place the `handrail-chat` class on the element that owns a chat surface. Every
provided selector begins beneath that root; the stylesheet does not select
`html`, `body`, `:root`, or unscoped host elements.

```html
<section
  class="handrail-chat"
  style="--hr-chat-color-accent: rebeccapurple"
>
  <button class="handrail-chat__button">Send</button>
</section>
```

Set token overrides inline on that root or with a more specific root selector
loaded after the stylesheet. Because primitives include fallback values, they
remain robust if a token declaration is removed or replaced during host
theming.

## Token categories

The `--hr-chat-*` custom properties cover:

- typography: font family, three sizes, line height, and medium/strong weights;
- spacing: six steps from `--hr-chat-space-1` through `--hr-chat-space-6`;
- color: canvas, surfaces, text, accent, border, and semantic status roles;
- borders: width and small, medium, and large radii;
- focus: accessible ring color, width, and offset;
- motion: fast/normal durations and easing; and
- layers: base, dropdown, and overlay z-index values.

Lightweight classes provide surface, stack, cluster, text, muted text, control,
button, divider, and focus-ring foundations. `data-handrail-focus` opts a custom
host control into the same `:focus-visible` ring without styling every focusable
element in the host application.

### Semantic status colors

The public status customization variables are:

- `--hr-chat-color-success` and `--hr-chat-color-success-background`;
- `--hr-chat-color-warning` and `--hr-chat-color-warning-background`; and
- `--hr-chat-color-danger-background`, paired with the existing
  `--hr-chat-color-danger` foreground.

Each default foreground/background pair meets the WCAG AA 4.5:1 contrast target
for ordinary text in both light and dark themes. These roles are intended for
status text and its corresponding tinted surface; status meaning should also be
communicated through text or another non-color cue.

## Theme and accessibility behavior

The default theme is light. Set `data-handrail-theme="dark"` on the root for an
explicit dark appearance or `data-handrail-theme="light"` to pin light mode.
Without an explicit light value, the tokens respond to
`prefers-color-scheme: dark`.

In forced-colors mode, color roles use system foreground/background pairs:
success uses `CanvasText` on `Canvas`, while warning and danger use `MarkText`
on `Mark`. Focus remains visible with `Highlight`. Under
`prefers-reduced-motion: reduce`, duration tokens become effectively
instantaneous. Hosts can override any of these tokens at the chat root while
keeping the accessibility media rules intact.

## ReactionPicker popover

`ReactionPicker` is a standalone, host-positioned popover exported from
`@handrail/chat/ui`. Its built-in catalog is local and deterministic; each
entry has a stable category, canonical reaction key, accessible name, and
search terms. The component owns search, category filtering, roving grid
focus, and dismissal behavior. The host owns whether it is mounted and all
reaction mutations.

Render it beneath a positioned element inside the `handrail-chat` root. Pass a
focus-restoration callback for the control that opened it, close it from
`onDismiss`, and send the catalog-backed key from `onSelect` through the
host's existing reaction mutation path:

```tsx
import { ReactionPicker } from "@handrail/chat/ui";

const triggerRef = useRef<HTMLButtonElement>(null);
const [pickerOpen, setPickerOpen] = useState(false);

<span style={{ position: "relative" }}>
  <button ref={triggerRef} onClick={() => setPickerOpen(true)}>
    Add reaction
  </button>
  {pickerOpen ? (
    <ReactionPicker
      onSelect={(reactionKey) => toggleReaction(reactionKey)}
      onDismiss={() => setPickerOpen(false)}
      restoreFocus={() => triggerRef.current?.focus()}
    />
  ) : null}
</span>;
```

The search field receives initial focus. `Escape`, an outside pointer press,
the close button, and selection all call `onDismiss` with a reason and restore
focus through `restoreFocus`. Arrow keys plus Home and End move within the
emoji grid. `REACTION_PICKER_CATALOG`, `REACTION_PICKER_CATEGORIES`, the
catalog/key/category types, and `isReactionPickerReactionKey` are exported for
hosts that need to inspect or validate the same canonical values. No catalog
entry is rendered as a message reaction chip until the caller chooses to do
so.

## ChatWorkspace shell

`ChatWorkspace` must be rendered beneath `ChatProvider`. It loads the supplied
organization or host-entity scope through the public React query hooks, renders
conversation navigation, hydrates the selected conversation, and composes the
default `MessageTimeline`, `MessageComposer`, `ThreadPanel`, and
`HuddleControls` surfaces inside accessible navigation, header, main, and
composer landmarks.

```tsx
import { ChatProvider } from "@handrail/chat/react";
import { ChatWorkspace } from "@handrail/chat/ui";
import "@handrail/chat/ui/styles.css";

<ChatProvider client={chatClient}>
  <ChatWorkspace
    scope={{
      type: "entity",
      entity: { type: "sales-order", id: "SO-1042" },
    }}
    mode="record"
    currentUserId={session.user.id}
    huddlePermissions={chatCapabilities.huddles}
  />
</ChatProvider>;
```

The four layout modes are `full-screen`, `side-panel`, `modal`, and `record`.
All are root-local CSS layouts. In particular, `modal` gives the component root
dialog semantics but never creates a portal, backdrop, or host-level modal.

Selection is uncontrolled by default: `defaultConversationId` supplies the
initial preference and the first scoped conversation is used as a fallback.
Supplying `conversationId` makes selection controlled; use `null` for an
intentionally empty selection and update the value from
`onConversationChange`.

Use the `components` prop to replace `WorkspaceHeader`, `Avatar`, `Message`,
`ChannelHeader`, `Composer`, `EmptyState`, `Attachment`, `SystemEvent`, `User`,
and `EntityReference`. The resolved slots flow through the default surfaces and
are also available to body renderers. `renderTimeline`, `renderComposer`,
`renderThread`, and `renderHuddle` replace their corresponding default body;
`children` remains a convenient static timeline replacement. Each renderer
receives only the renderer-safe conversation projection, public chat actions,
and public slots.

The host must pass `currentUserId` and `huddlePermissions` before the default
huddle controls render. `readOnly`, `composerAvailability`, and
`huddleDisabled` are also explicit host-authoritative inputs; the UI never
derives authorization from conversation roles.

For the exhaustive token table, normalized props and action subsets for all
ten slots, body-renderer composition, replacement accessibility duties, and a
public-hook-only headless example, see the focused
[ChatWorkspace customization contract](chat-workspace-customization.md).
