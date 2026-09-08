import {
  createServerHandshakeMetadata,
  decideRealtimeHandshake,
  parseChatEvent,
  type ChatEvent,
  type EventCursor,
  type SnapshotRequiredReason,
  type TenantId,
} from "../src/index.js";

const tenantId = "tenant-1" as TenantId;
const cursor: EventCursor = { eventId: "event-1" };
const metadata = createServerHandshakeMetadata({
  packageVersion: "1.1.3",
  protocolVersion: 4,
  schemaVersion: 9,
  enabledFeatures: { threads: true, huddles: false },
});

const parsed: ChatEvent<{ readonly messageId: string }> = parseChatEvent(
  {
    eventId: "event-2",
    protocolVersion: 4,
    tenantId,
    streamId: "conversation-1",
    type: "message.created",
    occurredAt: "2026-08-25T20:00:00.000Z",
    payload: { messageId: "message-1" },
  },
  tenantId,
  (payload) => payload as { readonly messageId: string },
);

const decision = decideRealtimeHandshake(
  {
    clientPackageVersion: "1.1.2",
    protocolVersion: 3,
    resumeFrom: cursor,
  },
  metadata,
);

if (decision.state === "accepted") {
  const acceptedCursor: EventCursor | undefined = decision.resumeFrom;
  void acceptedCursor;
} else if (decision.state === "refresh_required") {
  const refreshMessage: "Chat was updated; refresh to continue." =
    decision.message;
  void refreshMessage;
} else {
  const reason: SnapshotRequiredReason = decision.reason;
  void reason;
}

void parsed;
