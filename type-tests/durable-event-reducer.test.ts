import {
  CHAT_DURABLE_EVENT_TYPES,
  createChatClient,
  type ChatClient,
  type CreateChatRealtimeSessionOptions,
  type DurableEventDiagnostic,
  type DurableEventRecoveryReason,
  type NormalizedChatCache,
} from "@handrail/chat/client";

type HasRawEventCallback = "onEvent" extends keyof CreateChatRealtimeSessionOptions
  ? true
  : false;

const noRawEventCallback: HasRawEventCallback = false;
const recoveryReason: DurableEventRecoveryReason = "event_gap";
const eventType: string = CHAT_DURABLE_EVENT_TYPES.messageCreated;

declare const cache: NormalizedChatCache;
declare const diagnostic: DurableEventDiagnostic;

const client: ChatClient = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  cache,
  realtime: {
    onRecoveryDiagnostic(value) {
      const sameDiagnostic: DurableEventDiagnostic = value;
      void sameDiagnostic;
    },
  },
});

const canonicalCache: NormalizedChatCache = client.cache;
void noRawEventCallback;
void recoveryReason;
void eventType;
void diagnostic;
void canonicalCache;
