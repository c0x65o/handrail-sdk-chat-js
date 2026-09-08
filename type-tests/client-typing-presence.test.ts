import {
  createChatClient,
  createChatRealtimeSession,
  createNormalizedChatCache,
  selectPresenceSignals,
  selectTypingSignals,
  type ChatClientEphemeralClock,
  type ChatClientVisibility,
  type ConversationTypingState,
  type CurrentUserPresenceState,
} from "../src/client/index.js";
import type {
  ConversationId,
  SessionId,
  TenantId,
  UserId,
} from "../src/contracts/identifiers.js";

declare const clock: ChatClientEphemeralClock;
declare const visibility: ChatClientVisibility;
declare const socket: {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

const session = createChatRealtimeSession<"typing" | "presence">({
  endpoint: "/api/chat",
  clientPackageVersion: "0.1.3",
  getAccessToken: () => "token",
  webSocketFactory: () => socket,
  ephemeralSignals: {
    clock,
    visibility,
    enabledFeatures: { typing: true, presence: true },
    typingHeartbeatMs: 5_000,
    presenceIdleMs: 60_000,
  },
});
const started: boolean = session.startTyping("conversation-1", "private");
session.stopTyping("conversation-1");
session.setPresence("away");
session.notifyActivity();

const client = createChatClient<"typing" | "presence">({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  features: { typing: true, presence: true },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  realtime: { webSocketFactory: () => socket, ephemeralSignals: { clock } },
});
const clientStarted: boolean = client.startTyping("conversation-1");
client.stopTyping("conversation-1");
client.setPresence("online");
client.notifyActivity();

const cache = createNormalizedChatCache({
  tenantId: "tenant" as TenantId,
  userId: "user" as UserId,
  sessionId: "session" as SessionId,
});
const conversationId = "conversation" as ConversationId;
const typing: readonly ConversationTypingState[] = selectTypingSignals(
  cache.getState(),
  conversationId,
);
const presence: readonly CurrentUserPresenceState[] = selectPresenceSignals(
  cache.getState(),
);

// @ts-expect-error Typing visibility is limited to protocol privacy values.
session.startTyping("conversation-1", "tenant");
// @ts-expect-error Presence transitions are protocol-defined.
client.setPresence("busy");
// @ts-expect-error The scoped typing selector requires a conversation.
selectTypingSignals(cache.getState());

void [started, clientStarted, typing, presence];
