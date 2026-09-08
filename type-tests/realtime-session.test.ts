import {
  createChatClient,
  createChatRealtimeSession,
  type ChatRealtimeSession,
  type ChatRealtimeSessionState,
  type ChatRealtimeSocket,
} from "../src/client/index.js";
import type {
  ChatRealtimeSessionAcceptedMessage,
  ChatRealtimeSubscriptionRequest,
  EventCursor,
} from "../src/index.js";

const socket = {} as ChatRealtimeSocket;
const session: ChatRealtimeSession<"realtime"> = createChatRealtimeSession({
  endpoint: "/api/chat",
  clientPackageVersion: "0.1.3",
  getAccessToken: () => "token",
  webSocketFactory(url, protocols) {
    const typedUrl: string = url;
    const typedProtocols: readonly string[] = protocols;
    void [typedUrl, typedProtocols];
    return socket;
  },
  async hydrateSnapshot({ expiredCursor, signal }) {
    const cursor: EventCursor = expiredCursor;
    const aborted: boolean = signal.aborted;
    void aborted;
    return cursor;
  },
});

const state: ChatRealtimeSessionState<"realtime"> = session.state;
const unsubscribe: () => void = session.subscribeConversation("conversation-1");
session.start();
session.restart();
unsubscribe();
session.close();

const client = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }),
  realtime: {
    retry: { initialDelayMs: 10, maximumDelayMs: 100, jitterRatio: 0 },
    webSocketFactory: () => socket,
  },
});
const ownedSession: ChatRealtimeSession | undefined = client.realtime;

declare const accepted: ChatRealtimeSessionAcceptedMessage;
const tenantId = accepted.tenantId;
const actorStreamId: `user:${string}` = accepted.actorStreamId;
declare const subscription: ChatRealtimeSubscriptionRequest;
const requestId: string = subscription.requestId;

void [state, ownedSession, tenantId, actorStreamId, requestId];
