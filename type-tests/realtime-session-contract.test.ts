import {
  parseChatEvent,
  parseChatRealtimeControlMessage,
  parseChatRealtimeSubscriptionRequest,
  parseChatRealtimeSubscriptionServerMessage,
  parseClientHandshakeInput,
  parseEventCursor,
  type ChatEvent,
  type ChatRealtimeControlMessage,
  type ChatRealtimeSubscriptionRequest,
  type ChatRealtimeSubscriptionServerMessage,
  type ClientHandshakeInput,
  type EventCursor,
  type TenantId,
} from "../src/contracts/index.js";

const tenantId = "tenant-1" as TenantId;
const cursor: EventCursor = parseEventCursor({ eventId: "event-1" });
const handshake: ClientHandshakeInput = parseClientHandshakeInput({
  clientPackageVersion: "0.1.3",
  protocolVersion: 4,
  resumeFrom: cursor,
});
const control: ChatRealtimeControlMessage = parseChatRealtimeControlMessage({
  type: "chat.session.snapshot_required",
  state: "snapshot_required",
  reason: "replay_expired",
  metadata: {
    packageVersion: "0.1.3",
    protocolVersion: 4,
    schemaVersion: 1,
    enabledFeatures: {},
    supportedProtocolRange: { minimumVersion: 3, maximumVersion: 4 },
  },
  resumeFrom: cursor,
});
const request: ChatRealtimeSubscriptionRequest =
  parseChatRealtimeSubscriptionRequest({
    type: "chat.subscribe",
    requestId: "request-1",
    streamId: "conversation-1",
  });
const subscription: ChatRealtimeSubscriptionServerMessage =
  parseChatRealtimeSubscriptionServerMessage({
    type: "chat.subscription.accepted",
    requestId: "request-1",
    streamId: "conversation-1",
  });
const event: ChatEvent<{ readonly opaque: true }> = parseChatEvent(
  {
    eventId: "event-2",
    protocolVersion: 4,
    tenantId,
    streamId: "conversation-1",
    type: "feature.owned",
    occurredAt: "2026-08-26T12:00:00.000Z",
    payload: { opaque: true },
  },
  tenantId,
  (payload) => payload as { readonly opaque: true },
);

void [handshake, control, request, subscription, event];
