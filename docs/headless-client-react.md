# Headless browser and React integration

Use `@handrail/chat/client` for the long-lived browser state engine and
`@handrail/chat/react` for `ChatProvider`, query hooks, selectors, and actions.
This is the fully custom-UI boundary: the host application owns every rendered
element while Handrail Chat owns snapshots, normalized state, optimistic work,
realtime ordering and replay, and ephemeral signals.

> Browser integrations must not subscribe to raw WebSocket events and must not
> import cache, runtime, `src/`, or `dist/` files by path. Import only the public
> `@handrail/chat/client` and `@handrail/chat/react` subpaths. Raw events and
> internal cache shapes are not application contracts; bypassing the client
> loses ordering, replay, reconciliation, identity isolation, and cross-tab
> behavior.

The [fully headless React example](../examples/headless-react/README.md) is a
complete Vite application using the same boundary. For the server-side host
contract, see the separate [server embedding guide](server-embedding.md).

<!-- headless-api-contract
{
  "hooks": [
    "useChatSelector",
    "useChat",
    "useConversations",
    "useConversation",
    "useMessages",
    "useDirectoryUsers",
    "useDirectoryUser",
    "useDirectorySearch",
    "useSavedMessages",
    "useThread",
    "useMembers",
    "useReadState",
    "useDirectMessageReceipt",
    "usePresence",
    "useTyping",
    "useDraft",
    "useAttachmentUpload",
    "useHuddle"
  ],
  "actions": [
    "sendMessage",
    "retryMessage",
    "forwardMessage",
    "editMessage",
    "deleteMessage",
    "setReaction",
    "createChannel",
    "createDirect",
    "createGroupDirect",
    "archiveConversation",
    "restoreConversation",
    "joinConversation",
    "leaveConversation",
    "addConversationMember",
    "removeConversationMember",
    "changeConversationMemberRole",
    "markRead",
    "markUnread",
    "openThread",
    "openConversationDraft",
    "replaceConversationDraft",
    "clearConversationDraft",
    "flushConversationDraft",
    "retryConversationDraft",
    "closeConversationDraft",
    "updateConversationPreference",
    "setThreadFollow",
    "followThread",
    "unfollowThread",
    "saveMessage",
    "unsaveMessage",
    "retrySavedMessage",
    "uploadAttachment",
    "startTyping",
    "stopTyping",
    "setPresence",
    "notifyActivity",
    "hydrateHuddle",
    "startHuddle",
    "joinHuddle",
    "leaveHuddle",
    "setHuddleScreenShare",
    "clearHuddleScreenShare",
    "endHuddle",
    "retryHuddle",
    "rejoinHuddle"
  ]
}
-->

## Configure a provider-owned client

`endpoint` is the mounted chat HTTP base. `getAccessToken` is called whenever
the client needs credentials; return only the short-lived access token from the
trusted host session endpoint. Do not put tokens in module constants, URLs,
logs, local storage, or cross-tab identifiers.

`features` declares client support. At startup the client requests `/_meta`,
validates package/protocol/schema metadata, and exposes the intersection of the
requested and server-advertised flags as `state.enabledFeatures`. Omitting
`features` accepts the advertised set; it does not bypass server feature gates.
Supplying `realtime: {}` enables the owned WebSocket reconnect/replay runtime.

<!-- headless-example:provider-owned:start -->
```tsx
import type { CreateChatClientConfig } from "@handrail/chat/client";
import { ChatProvider } from "@handrail/chat/react";
import type { ReactNode } from "react";

type ChatFeature = "huddles" | "presence" | "typing";

interface HostChatSession {
  readonly accessToken: string;
  // Opaque and stable for one signed-in account, but explicitly not a secret.
  readonly sessionFingerprint: string;
}

async function getHostChatSession(): Promise<HostChatSession> {
  const response = await fetch("/api/chat/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Chat session is unavailable.");
  return response.json() as Promise<HostChatSession>;
}

const config = {
  endpoint: "/api/chat",
  getAccessToken: async () => (await getHostChatSession()).accessToken,
  features: { huddles: true, presence: true, typing: true },
  realtime: {},
  crossTab: {
    getSessionFingerprint: async () =>
      (await getHostChatSession()).sessionFingerprint,
  },
} satisfies CreateChatClientConfig<ChatFeature>;

export function ChatRoot({ children }: { readonly children: ReactNode }) {
  return <ChatProvider config={config}>{children}</ChatProvider>;
}
```
<!-- headless-example:provider-owned:end -->

With `config`, `ChatProvider` creates exactly one client for the mount, starts it
after mounting, and closes it during cleanup. Remount the provider to replace
its binding. Do not call `close()` on a provider-owned client.

## Own the lifecycle and snapshot recovery

Create the client yourself when it must outlive a provider, when startup must
finish before rendering, or when realtime snapshot recovery needs to call back
through that same client. With the `client` prop, `ChatProvider` neither calls
`start()` nor `close()`; the owner must do both. Concurrent `start()` calls share
one attempt. `close()` aborts active work, resets the lifecycle to `idle`, and is
idempotent. A later `start()` obtains a fresh token and starts a new attempt.

When replay cannot continue, realtime enters `hydrating_snapshot`, discards the
expired cursor, and calls `realtime.hydrateSnapshot`. Re-read the authoritative
conversation and timeline snapshots needed by the application. Resolve with a
server-provided boundary cursor when the host exposes one, or `null` to reconnect
without the expired cursor. Rejecting is safe: the realtime runtime retries
instead of applying events over a known-incomplete cache.

<!-- headless-example:external-lifecycle:start -->
```tsx
import {
  createChatClient,
  type ChatClient,
  type ChatClientLifecycleState,
} from "@handrail/chat/client";
import { ChatProvider } from "@handrail/chat/react";
import { useEffect, useState, type ReactNode } from "react";

async function getAccessToken() {
  const response = await fetch("/api/chat/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Chat session is unavailable.");
  return response.text();
}

let chat!: ChatClient;
chat = createChatClient({
  endpoint: "/api/chat",
  getAccessToken,
  realtime: {
    async hydrateSnapshot({ signal }) {
      const list = await chat.listConversations(
        { scope: { type: "organization" }, limit: 50 },
        { signal },
      );
      if (list.status !== "success") throw new Error("Snapshot recovery failed.");
      await Promise.all(list.value.items.flatMap((conversation) => [
        chat.getConversation({ conversationId: conversation.id }, { signal }),
        chat.getMessageTimeline(
          { conversationId: conversation.id, direction: "backward", limit: 50 },
          { signal },
        ),
      ]));
      return null;
    },
  },
});

export function ExternallyOwnedChatRoot(
  { children }: { readonly children: ReactNode },
) {
  const [state, setState] = useState<ChatClientLifecycleState>(chat.state);
  useEffect(() => {
    const unsubscribeLifecycle = chat.subscribeLifecycle(setState);
    void chat.start();
    return () => {
      unsubscribeLifecycle();
      chat.close();
    };
  }, []);

  if (state.state === "error") return <p role="alert">{state.diagnostic.message}</p>;
  if (state.state === "refresh_required") return <p>Refresh this page to continue.</p>;
  if (state.state !== "ready") return <p>Connecting to chat…</p>;
  return <ChatProvider client={chat}>{children}</ChatProvider>;
}
```
<!-- headless-example:external-lifecycle:end -->

Startup `error` diagnostics are deliberately safe and limited to
`access_token_failed`, `metadata_request_failed`, or `malformed_metadata` plus
an optional HTTP status. Retry by calling `start()` again. `refresh_required`
means the negotiated protocol range is incompatible; stop rendering chat and
ask the user to reload/update the application. Repeated `start()` calls remain
in that state until the client is closed and a compatible application version
starts.

## Persist normalized state and retained sends

`normalizedCachePersistence` is opt-in. Omitting `normalizedCachePersistence`
keeps normalized state and pending sends memory-only, so a page/process restart
cannot recover them. The SDK supplies validation and lifecycle behavior, not a
built-in IndexedDB or `localStorage` provider; the host owns the durable store.

Every adapter operation must address exactly one
`tenantId + userId + deviceId + record kind` key. `replace` must atomically
replace the whole encoded record at that key—never patch or merge it—while
`remove` deletes only that key. `clearForLogout` must atomically remove every
record kind for one exact trusted identity without clearing another account or
device. When persisted clients may run across tabs, whole-record `replace`
alone is insufficient: the store must also provide `compareExchange` as one
exact-key atomic transaction. That transaction reads and compares the current
encoded value with the expected value, returns `false` without writing on a
mismatch, and on a match either writes the replacement or removes the key when
the replacement is `null`.

<!-- headless-example:normalized-persistence:start -->
```tsx
import {
  createApplicationChatStorage,
  createChatClient,
  type ApplicationChatStorageAdapter,
  type ApplicationChatStorageIdentity,
  type ApplicationChatStorageRecordKind,
  type CreateChatClientConfig,
} from "@handrail/chat/client";

type HostRecordKey = readonly [
  tenantId: string,
  userId: string,
  deviceId: string,
  kind: ApplicationChatStorageRecordKind,
];
type HostIdentityKey = readonly [tenantId: string, userId: string, deviceId: string];

interface HostRecordTransaction {
  read(): Promise<string | null>;
  replace(value: string): Promise<void>;
  remove(): Promise<void>;
}

interface HostRecordDatabase {
  read(key: HostRecordKey): Promise<string | null>;
  replaceWholeAtomically(key: HostRecordKey, value: string): Promise<void>;
  remove(key: HostRecordKey): Promise<void>;
  withExactKeyTransaction<Result>(
    key: HostRecordKey,
    operation: (transaction: HostRecordTransaction) => Promise<Result>,
  ): Promise<Result>;
  clearExactIdentityAtomically(identity: HostIdentityKey): Promise<void>;
}

class HostRecordStore {
  constructor(private readonly database: HostRecordDatabase) {}

  read(key: HostRecordKey) {
    return this.database.read(key);
  }

  replaceWholeAtomically(key: HostRecordKey, value: string) {
    return this.database.replaceWholeAtomically(key, value);
  }

  remove(key: HostRecordKey) {
    return this.database.remove(key);
  }

  compareExchangeAtomically(
    key: HostRecordKey,
    expectedValue: string | null,
    replacementValue: string | null,
  ): Promise<boolean> {
    return this.database.withExactKeyTransaction(key, async (transaction) => {
      const currentValue = await transaction.read();
      if (currentValue !== expectedValue) return false;
      if (replacementValue === null) await transaction.remove();
      else await transaction.replace(replacementValue);
      return true;
    });
  }

  clearExactIdentityAtomically(identity: HostIdentityKey) {
    return this.database.clearExactIdentityAtomically(identity);
  }
}

declare const hostRecordDatabase: HostRecordDatabase;
const hostRecords = new HostRecordStore(hostRecordDatabase);
declare function reportStorageDiagnostic(code: string, message: string): void;

const recordKey = (
  identity: ApplicationChatStorageIdentity,
  kind: ApplicationChatStorageRecordKind,
): HostRecordKey => [identity.tenantId, identity.userId, identity.deviceId, kind];

const adapter: ApplicationChatStorageAdapter = {
  read: (identity, kind) => hostRecords.read(recordKey(identity, kind)),
  replace: (identity, kind, value) =>
    hostRecords.replaceWholeAtomically(recordKey(identity, kind), value),
  remove: (identity, kind) => hostRecords.remove(recordKey(identity, kind)),
  compareExchange: (identity, kind, expectedValue, replacementValue) =>
    hostRecords.compareExchangeAtomically(
      recordKey(identity, kind),
      expectedValue,
      replacementValue,
    ),
  clearForLogout: ({ tenantId, userId, deviceId }) =>
    hostRecords.clearExactIdentityAtomically([tenantId, userId, deviceId]),
};

export const chatStorage = createApplicationChatStorage(adapter);

interface TrustedHostChatSession {
  readonly accessToken: string;
  readonly persistenceIdentity: ApplicationChatStorageIdentity;
  // Opaque and stable for one signed-in account, but explicitly not a secret.
  readonly sessionFingerprint: string;
}

async function getTrustedHostChatSession(): Promise<TrustedHostChatSession> {
  const response = await fetch("/api/chat/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Chat session is unavailable.");
  return response.json() as Promise<TrustedHostChatSession>;
}

const config = {
  endpoint: "/api/chat",
  getAccessToken: async () => (await getTrustedHostChatSession()).accessToken,
  normalizedCachePersistence: {
    storage: chatStorage,
    resolveIdentity: async () =>
      (await getTrustedHostChatSession()).persistenceIdentity,
    onDiagnostic: ({ code, message }) => reportStorageDiagnostic(code, message),
  },
  crossTab: {
    getSessionFingerprint: async () =>
      (await getTrustedHostChatSession()).sessionFingerprint,
  },
} satisfies CreateChatClientConfig;

export const persistentChat = createChatClient(config);

export const inspectRetainedSends = () =>
  persistentChat.getSendMessageQueueState();
export const subscribeRetainedSends = () =>
  persistentChat.subscribeSendMessageQueue((state) => {
    console.info("Retained sends", state.intents.length);
  });
export const cancelRetainedSend = (clientMessageId: string) =>
  persistentChat.cancelQueuedMessage(clientMessageId);
```
<!-- headless-example:normalized-persistence:end -->

Resolve `ApplicationChatStorageIdentity` from a trusted host/session boundary as
shown above. Never decode or trust an access-token payload to choose a storage
scope. The SDK re-resolves identity across every `close()`/`start()` cycle, and
a provider remount creates a newly resolved lifecycle. If the trusted identity
switches, do not migrate, reuse, or expose another identity's scope. On logout,
close or unmount the client, call `chatStorage.clearForLogout(exactTrustedIdentity)`,
and wait for it to finish before discarding that trusted identity.

`getSendMessageQueueState()` inspects retained sends,
`subscribeSendMessageQueue()` observes hydration and durable changes, and
`cancelQueuedMessage(clientMessageId)` durably removes one retained send without
dispatching it. Treat adapter durability as a host responsibility: handle and
monitor transaction, quota, and disk failures rather than assuming a diagnostic
made a failed write durable. Hosts must handle adapter durability failures.

Online startup remains usable when persistence fails. Persistence diagnostics
contain only a safe code and static redacted message; they exclude identities,
record contents, and thrown values. A normalized snapshot rejected during
validation or hydration is removed/quarantined, and a failed quarantine is
reported safely so the host can repair its adapter.

Persisted records must exclude access and refresh credentials, cookies,
attachment bytes or byte sources, upload URLs or temporary preview resources,
and provider descriptors or credentials. Browser persistence is not a shared
cross-device source of truth: server snapshots and canonical realtime events
remain authoritative for synchronization and reconciliation.

## Query hooks and view models

Every public query hook returns `ChatQueryResult<T>`:

| Status | Meaning |
| --- | --- |
| `loading` | Work or hydration is pending. `data` may contain a stale projection that is safe to render. |
| `ready` | `data` is present and usable. |
| `empty` | The read succeeded but has no row/items/value. `data` can still contain pagination or an empty collection. |
| `error` | `error` is a renderer-safe `{ code, message, retryable, httpStatus? }`; `data` may retain the last usable projection. |

Query errors never include access tokens, response bodies, URLs, or thrown
values. A missing provider returns `provider_missing`; a protocol mismatch
returns `refresh_required`. Keep stale `data` visible when appropriate, offer a
retry only when `error.retryable` is true, and never display caught transport
objects directly.

`useConversations()` defaults to organization scope. Entity scope uses the
host-owned opaque `{ type, id }` reference; authorization still comes from the
trusted server session. `loadMore`, `loadOlder`, and `loadNewer` consume opaque
cursors and safely no-op when no page is available.

<!-- headless-example:query-actions:start -->
```tsx
import {
  useAttachmentUpload,
  useChat,
  useChatActions,
  useConversation,
  useConversations,
  useDraft,
  useHuddle,
  useMessages,
  usePresence,
  useReadState,
  useTyping,
} from "@handrail/chat/react";
import { useState } from "react";

type ConversationId = Parameters<typeof useConversation>[0];

export function RecordChat(
  { conversationId, invoiceId }: {
    readonly conversationId: ConversationId;
    readonly invoiceId: string;
  },
) {
  const chat = useChat();
  const conversations = useConversations({
    scope: { type: "entity", entity: { type: "invoice", id: invoiceId } },
  });
  const conversation = useConversation(conversationId);
  const messages = useMessages(conversationId, { limit: 50 });
  const read = useReadState(conversationId);
  const draft = useDraft(conversationId);
  const typing = useTyping(conversationId);
  const presence = usePresence();
  const actions = useChatActions(conversationId);
  const huddlesEnabled =
    chat?.state.state === "ready" && chat.state.enabledFeatures.huddles === true;
  const huddle = useHuddle(conversationId, { enabled: huddlesEnabled });
  const [uploadId, setUploadId] = useState("no-active-upload");
  const upload = useAttachmentUpload(uploadId);

  async function send(text: string) {
    const result = await actions.sendMessage({ content: { format: "plain", text } });
    if (result.status !== "success") {
      // Keep the failed optimistic row visible; its delivery state says if retry is safe.
      return;
    }
    actions.clearConversationDraft();
  }

  function attach(file: File) {
    const handle = actions.uploadAttachment({
      metadata: {
        fileName: file.name,
        contentType: "image/png",
        sizeBytes: file.size,
      },
      source: file,
    });
    setUploadId(handle.uploadId);
    return () => handle.cancel();
  }

  return <section>
    <h2>{conversation.data?.type === "channel" ? conversation.data.name : "Chat"}</h2>
    <p>{conversations.data?.conversations.length ?? 0} chats for this invoice</p>
    <p>{read.data?.unreadCount ?? 0} unread; {typing.data?.length ?? 0} typing</p>
    <p>{presence.data?.length ?? 0} visible; draft {draft.data?.status ?? draft.status}</p>
    <p>Upload {upload.data?.status ?? upload.status}; huddle {huddle.status}</p>
    <button type="button" onClick={() => void send("Invoice reviewed")}>Send</button>
    <button type="button" disabled={!huddlesEnabled} onClick={() => void actions.startHuddle()}>
      Start huddle
    </button>
    <input type="file" onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      if (file !== undefined) attach(file);
    }} />
    <ol>{messages.data?.messages.map((message) => <li key={message.id}>{message.content?.text}</li>)}</ol>
  </section>;
}
```
<!-- headless-example:query-actions:end -->

### Public hook reference

| Hook | View model and loading behavior |
| --- | --- |
| `useChat` | Provider value: client, lifecycle state, readiness, refresh requirement, and safe startup diagnostic; `null` outside a provider. |
| `useChatSelector` | Low-level tearing-safe selector over normalized public cache state for a custom derived view model. |
| `useConversations` | Organization/entity conversation list, opaque next cursor, loading-more flag, and `loadMore`. |
| `useConversation` | One conversation detail, including the discriminated `channel`, `direct`, `group_direct`, or `thread` shape. |
| `useMessages` | Canonical plus optimistic timeline rows, pagination, loading flags, `loadOlder`, and `loadNewer`. |
| `useDirectoryUsers` | Deduplicated authorized host-directory projections in first-requested order, hydrated with one request for missing IDs. |
| `useDirectoryUser` | One authorized host-directory projection, optionally hydrated. |
| `useDirectorySearch` | Debounced member search result; a blank query is `empty` and cancels active search. |
| `useSavedMessages` | Actor-private saved items, opaque cursor, loading-more flag, and `loadMore`. |
| `useThread` | Root, summary, opening state, thread conversation, distinct parent/thread timelines, and follow state. |
| `useMembers` | Conversation member identities plus available directory projections. |
| `useReadState` | Current actor cursor and derived unread count for a conversation. |
| `useDirectMessageReceipt` | Boolean derived from an authorized other DM member's supplied read cursor and message sequence. |
| `usePresence` | Live presence projections, optionally filtered by user ID. |
| `useTyping` | Live typing projections for one subscribed conversation. |
| `useDraft` | Hydrated local/canonical draft synchronization state, including retry/conflict information. |
| `useAttachmentUpload` | Serializable progress and lifecycle for one upload ID. |
| `useHuddle` | Hydrated canonical huddle, pending operation, and ephemeral media status. |

Use `enabled: false` on hooks that support it to defer network/hydration work.
`useChatSelector` is the supported escape hatch for derived state; importing
`normalized-cache.ts` or another internal file is not.

## Commands and optimistic reconciliation

`useChatActions(conversationId)` returns stable callbacks. It throws outside a
provider. Conversation-bound callbacks validate that an ID was supplied when
invoked; global callbacks such as `createChannel` and `setPresence` do not need
one.

The complete shipped action surface is:

- Messages: `sendMessage`, `retryMessage`, `forwardMessage`, `editMessage`, `deleteMessage`, `setReaction`.
- Conversations: `createChannel`, `createDirect`, `createGroupDirect`, `archiveConversation`, `restoreConversation`.
- Membership: `joinConversation`, `leaveConversation`, `addConversationMember`, `removeConversationMember`, `changeConversationMemberRole`.
- Reads and threads: `markRead`, `markUnread`, `openThread`, `setThreadFollow`, `followThread`, `unfollowThread`.
- Drafts: `openConversationDraft`, `replaceConversationDraft`, `clearConversationDraft`, `flushConversationDraft`, `retryConversationDraft`, `closeConversationDraft`.
- Preferences and saved messages: `updateConversationPreference`, `saveMessage`, `unsaveMessage`, `retrySavedMessage`.
- Attachments: `uploadAttachment`.
- Ephemeral signals: `startTyping`, `stopTyping`, `setPresence`, `notifyActivity`.
- Huddles: `hydrateHuddle`, `startHuddle`, `joinHuddle`, `leaveHuddle`, `setHuddleScreenShare`, `clearHuddleScreenShare`, `endHuddle`, `retryHuddle`, `rejoinHuddle`.

There are deliberately no toggle commands. Read the projected reaction/follow/
saved state and send the explicit desired state. In particular, `setReaction`
requires `reacted: boolean`.

`sendMessage` synchronously inserts a renderer-compatible row with
`delivery.state === "sending"`, a generated `clientMessageId`, an idempotency
key, and an attempt count. A successful HTTP response or matching canonical
realtime event atomically replaces it with the canonical message; either may
arrive first without creating a duplicate. A failed row remains visible with
`delivery.state === "failed"` and `retryable`. Call `retryMessage` only with
that row's original `clientMessageId`; it reuses the original idempotency key.
`forwardMessage(sourceMessageId)` binds the hook's conversation as the
destination. Ambiguous retries retain one correlation/idempotency pair and the
authoritative destination message converges with its durable event.

All command promises resolve to discriminated results: `success`, `validation`,
`conflict`, `authentication`, `feature_disabled`, `unsupported`, `rejected`,
`malformed_response`, `transport`, `aborted`, or `closed`. Branch on `status`.
Do not assume a failed promise, roll your own non-idempotent retry, or replace a
canonical event with a locally invented object. Edits, deletes, reactions,
reads, preferences, follows, and saved-message changes also project immediately
and either reconcile or roll back according to their public state.

## Threads, reads, and receipts

A thread is an independent conversation stream attached to a root message.
`openThread(rootMessageId)` resolves or creates the thread, retains its realtime
subscription, hydrates its detail/timeline, and reports a safe opening state.
`useThread(rootMessageId, { open: true })` exposes the parent timeline and
`threadMessages` separately; send replies through
`useChatActions(thread.data.thread.id)`. Replies are not inserted into the
parent conversation timeline.

<!-- headless-example:thread-receipt:start -->
```tsx
import {
  useChatActions,
  useDirectMessageReceipt,
  useThread,
} from "@handrail/chat/react";

type RootMessageId = Parameters<typeof useThread>[0];
type ReceiptInput = Parameters<typeof useDirectMessageReceipt>[0];

export function ThreadAndReceipt(
  { rootMessageId, receipt }: {
    readonly rootMessageId: RootMessageId;
    readonly receipt: ReceiptInput;
  },
) {
  const thread = useThread(rootMessageId, { open: true });
  const actions = useChatActions(thread.data?.thread?.id);
  const wasRead = useDirectMessageReceipt(receipt);
  return <aside>
    <p>{thread.data?.threadMessages.length ?? 0} replies</p>
    <p>DM receipt: {wasRead.data === true ? "read" : "not read"}</p>
    <button
      type="button"
      disabled={thread.data?.thread === undefined}
      onClick={() => void actions.sendMessage({
        content: { format: "plain", text: "Thread reply" },
      })}
    >
      Reply
    </button>
  </aside>;
}
```
<!-- headless-example:thread-receipt:end -->

Unread state is derived from the latest conversation sequence, the current
actor's `lastReadSequence`, and any `manualUnreadFromSequence`. `markRead`
advances through an explicit sequence; `markUnread` sets an explicit unread
boundary. Read-cursor updates are optimistic, ordered, and reconciled across
devices by canonical events. A direct-message receipt is not a per-message row:
after the host has authorized and supplied the other member's cursor,
`useDirectMessageReceipt` is true when that cursor covers the message sequence.
It intentionally returns `empty` for channels, group DMs, threads, the current
actor's cursor, or mismatched conversations.

## Drafts, typing, and presence

`useDraft` opens and hydrates the actor-private draft lifecycle. Local
`replaceConversationDraft` and `clearConversationDraft` calls project
synchronously and persistence is debounced (750 ms by default). Flush before a
navigation boundary when needed. Closing defaults to `flush`; closing with
`{ policy: "abort" }` restores the last authoritative projection. A successful
send clears and flushes the conversation draft. `retryable` can be retried;
`conflict` preserves local content and exposes a safe conflict diagnostic for a
user decision.

Typing and presence are ephemeral, negotiated realtime features—not durable
cache rows. `startTyping` begins/refreshes a signal only for an accepted
conversation subscription, `stopTyping` ends it, and composer activity should
call `startTyping` again rather than creating timers. Default typing TTL,
heartbeat, and idle-stop are 10 s, 5 s, and 5 s. Default presence TTL,
heartbeat, and idle-away delay are 60 s, 30 s, and 60 s. The runtime expires
stale remote signals, rate-limits local signals, transitions on document
visibility/activity, and sends terminal signals when possible. Treat `empty`
presence/typing results as nobody currently visible/typing, not as durable
offline history.

## Attachments

`uploadAttachment` owns prepare, byte transfer, and finalize. It immediately
returns `{ uploadId, state, completion, cancel }`; keep the ID and render live
serializable state with `useAttachmentUpload(uploadId)`. Progress is
`uploadedBytes` over `totalBytes`; statuses are `preparing`, `pending`,
`uploading`, `finalizing`, `finalized`, `rejected`, `abandoned`, `failed`, or
`cancelled`. `completion` resolves to `finalized`, `rejected`, `cancelled`, or a
`failed` phase (`prepare`, `transfer`, `finalize`, or `abort`).

Cancellation aborts active work and performs the supported cleanup path. The
SDK retries byte transfer only when the configured transport explicitly marks
it safe. Do not persist byte sources, provider credentials, upload URLs, or
temporary preview resources in UI state; canonical upload state deliberately
excludes them.

## Huddles and feature gates

Read `useChat().state.enabledFeatures.huddles` only after lifecycle state is
`ready`. Disable the UI and pass `{ enabled: false }` to `useHuddle` when the
feature was not negotiated. `useHuddle` hydrates canonical session state;
actions return `success`, `feature_disabled`, or a safe `error` result. Media
join material is short-lived private memory and is never placed in normalized
or cross-tab state. On disconnect/expiry, render `media.state ===
"rejoin_required"` and call `rejoinHuddle`; use `retryHuddle` only for a
retryable action failure.

## Cross-tab and device behavior

Cross-tab coordination is opt-in and fail-open. Give it a stable, non-secret
session fingerprint scoped to the signed-in tenant/account. Never use an access
token, refresh token, cookie, email address, or other secret/PII as the
fingerprint. The coordinator elects one realtime leader, relays validated
canonical state/events, and deduplicates idempotent commands; followers do not
open competing sockets. If browser channel coordination is unavailable, each
tab remains usable in `fallback` mode.

The fingerprint is resolved again after `close()`/`start()`. When it changes,
the client closes the prior realtime scope, resets identity-scoped directory
state, and clears cache identity before joining the new scope. Cross-device
synchronization still comes from server snapshots and canonical realtime
events; cross-tab coordination is not an authentication or authorization
boundary.

## Failure-state checklist

- While provider readiness is `not_ready`, render loading/disabled controls and
  let query hooks retain any safe stale `data`.
- On startup `error`, show only the safe diagnostic and retry `start()` (or
  remount a provider-owned client). Never echo a caught token/fetch error.
- During `hydrating_snapshot`, keep the last projection read-only while the
  configured recovery callback refreshes authoritative snapshots.
- On query/action failure, branch on the discriminated status and retry only
  when the public view model says retry is safe.
- On `refresh_required`, stop commands and ask the user to reload/update; do not
  reconnect with a hand-written socket or attempt to downgrade the protocol.
- On logout or identity change, close the externally owned client before
  starting the next identity. Never reuse secret-derived cross-tab scope.
