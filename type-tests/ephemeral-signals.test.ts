import {
  parseEphemeralSignalEvent,
  type ConversationId,
  type DeviceId,
  type PresenceSignalEvent,
  type SessionId,
  type TenantId,
  type TypingSignalEvent,
  type UserId,
} from "../src/index.js";
import {
  reduceEphemeralSignal,
  type EphemeralSignalState,
} from "../src/client/index.js";

const tenantId = "tenant-1" as TenantId;
const conversationId = "conversation-1" as ConversationId;
const actorUserId = "user-2" as UserId;
const recipientUserId = "user-1" as UserId;
const deviceId = "device-1" as DeviceId;
const sessionId = "session-1" as SessionId;

const typing: TypingSignalEvent = {
  eventId: "event-1",
  protocolVersion: 4,
  tenantId,
  streamId: conversationId,
  type: "typing.signal",
  occurredAt: "2026-08-25T20:00:00.000Z",
  payload: {
    capability: "typing",
    durability: "ephemeral",
    actorUserId,
    deviceId,
    sessionId,
    sequence: 1,
    sentAt: "2026-08-25T20:00:00.000Z",
    expiresAt: "2026-08-25T20:00:10.000Z",
    state: "start",
    scope: {
      type: "conversation",
      conversationId,
      visibility: "public",
      audience: "active_participants",
    },
  },
};

const presence: PresenceSignalEvent = {
  ...typing,
  eventId: "event-2",
  streamId: `user:${recipientUserId}`,
  type: "presence.signal",
  payload: {
    ...typing.payload,
    capability: "presence",
    state: "away",
    scope: { type: "user_private", userId: recipientUserId },
  },
};

const parsed: TypingSignalEvent | PresenceSignalEvent =
  parseEphemeralSignalEvent(typing, {
    expectedTenantId: tenantId,
    enabledFeatures: { typing: true, presence: true },
    now: Date.parse("2026-08-25T20:00:01.000Z"),
  });

const initial: EphemeralSignalState = { typing: {}, presence: {} };
const reduced = reduceEphemeralSignal(initial, parsed, Date.now());

const invalidPublicTyping: TypingSignalEvent = {
  ...typing,
  payload: {
    ...typing.payload,
    // @ts-expect-error Public activity cannot target every channel member.
    scope: {
      type: "conversation",
      conversationId,
      visibility: "public",
      audience: "members",
    },
  },
};

const durableTyping: TypingSignalEvent = {
  ...typing,
  payload: {
    ...typing.payload,
    // @ts-expect-error Typing signals cannot be represented as durable events.
    durability: "durable",
  },
};

void [presence, reduced, invalidPublicTyping, durableTyping];
