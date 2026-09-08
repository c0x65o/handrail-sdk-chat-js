# First-project pilot integration

This is the supported path for the first text-chat pilot. Neither the npm nor
Flutter package is published yet. Consume the distribution needed by the host
from its exact public Git commit; the TypeScript and Flutter packages have
independent versions. Do not publish or apply migrations implicitly from
application startup.

## React/Vite client

Vite is the build tool, not the UI framework. The supplied drop-in UI is React.
A React/Vite host can copy the executable
[drop-in example](../examples/drop-in-react/README.md), install the workspace
package from the public `handrail-sdk-chat-js` HTTPS Git URL at a full commit SHA with a matching lockfile, and use only:

```tsx
import { createChatClient } from "@handrail/chat/client";
import { ChatProvider } from "@handrail/chat/react";
import { ChatWorkspace } from "@handrail/chat/ui";
import "@handrail/chat/ui/styles.css";

const client = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: async () => {
    const response = await fetch("/api/chat/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Chat session is unavailable");
    return (await response.json() as { accessToken: string }).accessToken;
  },
});

export const Chat = () => (
  <ChatProvider client={client}>
    <ChatWorkspace scope={{ type: "organization" }} mode="full-screen" />
  </ChatProvider>
);
```

The host session route authenticates with the application's existing secure,
HTTP-only session and returns a short-lived chat token. It must never accept a
tenant or user ID from browser input. `ChatProvider` owns start, lifecycle
subscription, replay/recovery, and disposal for its mounted client.

For a non-React Vite application, use `@handrail/chat/client` directly and
render its public normalized state, or mount the React workspace as an isolated
React island. No standards-based custom element/Web Component is shipped.
Never import `src`, `dist`, server, or testing entry points into a browser graph.

## Node host and PostgreSQL

Use the executable [embedded-server fixture](../examples/embedded-server/README.md)
and the complete [server embedding contract](server-embedding.md). A production
host must provide trusted adapters for auth, directory, permissions, and any
enabled provider feature. Identity comes only from the authenticated server
session, including WebSocket upgrades; directory and entity access remain
host-authorized. Storage includes `verifyObject` after upload, before attachment
metadata is trusted.

Provision a dedicated PostgreSQL database/user or a host-owned pool and schema.
Before the server starts, inspect and then explicitly apply migrations:

```sh
handrail-chat migrate status --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
handrail-chat migrate apply --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
handrail-chat migrate status --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
```

Startup never applies migrations. Mount `chat.router` at `/api/chat`, attach
`chat.attachWebSocket(httpServer)` with `/api/chat/_realtime`, and keep the
browser token endpoint in the authenticated host router. On shutdown, stop
accepting traffic, await `chat.close()`, close the HTTP listener, and close a
borrowed pool only after every borrower finishes. The compiled server guide
contains the exact idempotent implementation.

The PostgreSQL-backed [integration harness](integration-testing.md) includes an
executable same-tenant, two-actor direct-message flow. It applies every shipped
migration in an isolated schema, starts both clients, creates the direct
conversation, sends text as actor one, reads it as actor two, authenticates the
second actor's socket, and tears down safely.

## Composition and ownership

`ChatWorkspace` supports `full-screen`, `side-panel`, `modal`, and `record`
layouts. All selectors and theme tokens are scoped below `.handrail-chat`.
Hosts may replace ten slots, replace the navigation/timeline/composer/thread
bodies, or use the [headless React API](headless-client-react.md). See the
[customization contract](chat-workspace-customization.md) for executable types
and the complete token list.

Modal mode supplies dialog semantics. The host owns the portal, backdrop, and
open state, and responds to `ChatWorkspace`'s close-request callback by changing
mode or unmounting. `ChatWorkspace` owns root-local initial focus,
Tab/Shift+Tab containment, requests dismissal through that callback for an
unhandled Escape, and restores captured opener focus only when the opener
remains connected and focus still belongs to the workspace. A pop-out is a
host-created browser window: the host owns blocked-popup handling, sizing,
authentication bootstrap, cross-window lifecycle, and close cleanup, while one
`ChatProvider` in that window owns its SDK client.

## Text-pilot feature boundary

The machine-checked
[cross-client capability manifest](../contracts/cross-client-capabilities.v1.json)
is the authoritative inventory for shipped server, TypeScript, React/UI, and
Flutter surfaces. Adding a capability or changing any surface status is an
explicit reviewed contract change; generated wire contracts alone do not count
as client or widget support.

| Capability | Pilot composition |
| --- | --- |
| Channels, direct/group messages, membership | Public client/actions are supported; creation and member-management controls are host-composed or supplied through `User`/body replacements. |
| Archive and conversation preferences | Public actions and `ChannelHeader` slot controls are supported. |
| Timeline, send/edit/delete, reads and drafts | Supplied workspace bodies and headless hooks are supported. |
| Saved messages | Public action/query support; a dedicated saved-items page is host-composed. |
| Typing and presence | Realtime state/hooks are supported; a visible treatment is host-composed. |
| Reactions and threads | Default message/thread surfaces plus replacement APIs are supported. |
| Attachments | UI/upload lifecycle is supported with a real host storage adapter and picker. |
| Directory lookup | Supported through trusted directory adapters and headless hooks. |
| Message/content search | Authorized PostgreSQL-backed `POST /messages/search` is supported through the headless TypeScript `searchMessages` API, the supplied React `useMessageSearch` hook and `ChatWorkspace`, and the Flutter client/workspace search surfaces. See [Message search and result routing](chat-workspace-customization.md#message-search-and-result-routing). |

Search requests require normalized, nonblank queries, accept page sizes from 1
through 100, and use opaque cursors bounded to 2,048 characters. The host
remains responsible for trusted authentication, permission-adapter
authorization for entity-backed conversations, and any host-controlled feature
gating.

This is a text-chat pilot, not broad Slack parity. Production push delivery,
OS notifications, provider object storage, voice/video/screen sharing, a media
provider, retention/eDiscovery, moderation, malware scanning, analytics,
federation, and operational scale/SLO validation remain host work or later SDK
milestones.

## Flutter pilot

The authoritative Flutter SDK is [`handrail-sdk-chat-flutter`](https://github.com/c0x65o/handrail-sdk-chat-flutter),
installed from its public HTTPS Git URL at a full commit SHA with a matching lockfile. The [Flutter ERP example](https://github.com/c0x65o/handrail-sdk-chat-flutter/blob/main/examples/flutter-erp/README.md)
provides authentication, `dart:io` HTTP and WebSocket transports, connectivity
and stable-device-ID adapters, cursor/session recovery, app lifecycle ownership,
drop-in widgets, and a custom controller-driven screen. Push, native
notifications, file/media selection, secure preferences, connectivity plugins,
and provider storage remain host-selected boundaries.

## Pilot acceptance

Run the non-publishing release checks, focused drop-in/headless/embedded checks,
Flutter ERP analyze/widgets, npm pack dry-run, Dart pub dry-run, and the
two-actor PostgreSQL smoke. Record exact results in the versioned validation
report; do not substitute mocks for PostgreSQL persistence.
