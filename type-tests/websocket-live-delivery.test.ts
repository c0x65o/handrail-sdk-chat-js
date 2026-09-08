import type {
  ChatRealtimeAdapter,
  ChatRealtimeListener,
  ChatRealtimeSubscriber,
  ChatWebSocketOptions,
  ChatWebSocketSession,
} from "../src/server/index.js";

const listener: ChatRealtimeListener = (_value: unknown) => undefined;

const subscriber: ChatRealtimeSubscriber = {
  subscribe(_receive) {
    return () => undefined;
  },
};

const bidirectionalAdapter: ChatRealtimeAdapter = {
  async publish(_event) {},
  subscribe: subscriber.subscribe,
};

// Existing external fanout integrations may remain publish-only.
const publishOnlyAdapter: ChatRealtimeAdapter = {
  async publish(_event) {},
};

const deliveryOptions = {
  maxPendingEvents: 32,
  onSession(_socket, session) {
    const cursor: string | undefined = session.lastDeliveredCursor?.eventId;
    void cursor;
  },
} satisfies ChatWebSocketOptions;

declare const session: ChatWebSocketSession;
const lastDeliveredEventId: string | undefined =
  session.lastDeliveredCursor?.eventId;

void [
  listener,
  bidirectionalAdapter,
  publishOnlyAdapter,
  deliveryOptions,
  lastDeliveredEventId,
];
