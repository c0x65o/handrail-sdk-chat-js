# Fully headless React browser example

This Vite app owns every rendered element—the header, timeline, reactions, read control, attachment picker, huddle button, and composer. Handrail Chat supplies state and behavior through `ChatProvider` and public headless hooks.

The manifest installs one Handrail package and one version:

Consume `@handrail/chat` from the public HTTPS Git URL
`https://github.com/c0x65o/handrail-sdk-chat-js.git`, pinned to a full SDK commit
SHA with a matching `package-lock.json`. The inherited example manifest is
awaiting this cutover; follow [migration status](../../docs/sdk-repository-split.md)
before running an install. Do not use a local SDK dependency.

Browser code then uses only two public subpaths:

```ts
import type { CreateChatClientConfig } from "@handrail/chat/client";
import { ChatProvider, useMessages } from "@handrail/chat/react";
```

`ChatProvider` owns the long-lived browser client. The host application supplies `/api/chat` and a same-origin `/api/chat/session` access-token endpoint; the custom UI never opens a socket or imports an SDK cache implementation directly. The shipped `useConversation`, `useReadState`, and `setReaction` APIs are locally named after the goal's `useChannel`, `useUnreadState`, and `toggleReaction` prose without adding a second SDK surface.

Run the example against a compatible host:

```sh
npm install
VITE_CHAT_CONVERSATION_ID=your-conversation-id npm run dev
```

Run all focused acceptance checks with one command:

```sh
npm run check
```

That command runs the TypeScript check, Vite production build, emitted browser-module-graph assertion, component smoke test, and static import/socket/cache boundary inspection.
