import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  CHAT_REALTIME_REPLAY_CURSOR_STATUSES,
  CHAT_REALTIME_SESSION_MESSAGE_TYPES,
  CHAT_REALTIME_SESSION_STATES,
  CHAT_REALTIME_SNAPSHOT_REQUIRED_REASONS,
  CHAT_REALTIME_SUBPROTOCOL,
  CHAT_REALTIME_SUBSCRIPTION_ERROR_CODES,
  CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES,
  CHAT_REFRESH_REQUIRED_MESSAGE,
  ChatRealtimeSessionParseError,
  parseChatRealtimeControlMessage,
  parseChatRealtimeSubscriptionRequest,
  parseChatRealtimeSubscriptionServerMessage,
  parseClientHandshakeInput,
} from "../dist/index.js";

const metadata = {
  packageVersion: "0.1.3",
  protocolVersion: 4,
  schemaVersion: 1,
  enabledFeatures: { realtime: true },
  supportedProtocolRange: { minimumVersion: 3, maximumVersion: 4 },
};

test("exports every exact realtime session wire constant", () => {
  assert.equal(CHAT_REALTIME_SUBPROTOCOL, "handrail-chat.v1");
  assert.equal(
    CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX,
    "handrail-chat.bearer.",
  );
  assert.deepEqual(CHAT_REALTIME_SESSION_MESSAGE_TYPES, {
    accepted: "chat.session.accepted",
    refreshRequired: "chat.session.refresh_required",
    snapshotRequired: "chat.session.snapshot_required",
  });
  assert.deepEqual(CHAT_REALTIME_SESSION_STATES, {
    accepted: "accepted",
    refreshRequired: "refresh_required",
    snapshotRequired: "snapshot_required",
  });
  assert.deepEqual(CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES, {
    subscribe: "chat.subscribe",
    unsubscribe: "chat.unsubscribe",
    subscribed: "chat.subscription.accepted",
    unsubscribed: "chat.subscription.removed",
    rejected: "chat.subscription.rejected",
    revoked: "chat.subscription.revoked",
  });
  assert.deepEqual(CHAT_REALTIME_SUBSCRIPTION_ERROR_CODES, {
    malformedRequest: "malformed_request",
    identitySpoofing: "identity_spoofing",
    invalidStream: "invalid_stream",
    accessDenied: "access_denied",
    accessRevoked: "access_revoked",
  });
  assert.deepEqual(CHAT_REALTIME_SNAPSHOT_REQUIRED_REASONS, [
    "replay_expired",
    "replay_unavailable",
    "replay_incompatible",
    "replay_overflow",
  ]);
  assert.deepEqual(CHAT_REALTIME_REPLAY_CURSOR_STATUSES, [
    "available",
    "expired",
    "unavailable",
    "incompatible",
    "overflow",
  ]);
});

test("parses handshakes, controls, and subscription discriminants", () => {
  assert.deepEqual(
    parseClientHandshakeInput({
      clientPackageVersion: "0.1.3",
      protocolVersion: 4,
      resumeFrom: { eventId: "event-1" },
    }),
    {
      clientPackageVersion: "0.1.3",
      protocolVersion: 4,
      resumeFrom: { eventId: "event-1" },
    },
  );

  const controls = [
    {
      type: "chat.session.accepted",
      metadata,
      tenantId: "tenant-1",
      actorStreamId: "user:user-1",
      deviceId: "device-1",
      sessionId: "session-1",
      resumeFrom: { eventId: "event-1" },
    },
    {
      type: "chat.session.refresh_required",
      state: "refresh_required",
      reason: "unsupported_protocol",
      message: CHAT_REFRESH_REQUIRED_MESSAGE,
      requestedProtocolVersion: 5,
      metadata,
    },
    {
      type: "chat.session.snapshot_required",
      state: "snapshot_required",
      reason: "replay_overflow",
      metadata,
      resumeFrom: { eventId: "event-1" },
    },
  ];
  for (const control of controls) {
    assert.deepEqual(parseChatRealtimeControlMessage(control), control);
  }

  for (const type of ["chat.subscribe", "chat.unsubscribe"]) {
    const request = {
      type,
      requestId: "request-1",
      streamId: "conversation-1",
    };
    assert.deepEqual(parseChatRealtimeSubscriptionRequest(request), request);
  }

  const serverMessages = [
    {
      type: "chat.subscription.accepted",
      requestId: "request-1",
      streamId: "conversation-1",
    },
    {
      type: "chat.subscription.removed",
      requestId: "request-1",
      streamId: "conversation-1",
    },
    {
      type: "chat.subscription.rejected",
      code: "access_denied",
      requestId: "request-1",
    },
    {
      type: "chat.subscription.revoked",
      code: "access_revoked",
      streamId: "conversation-1",
    },
  ];
  for (const message of serverMessages) {
    assert.deepEqual(
      parseChatRealtimeSubscriptionServerMessage(message),
      message,
    );
  }
});

test("rejects malformed and unknown session frames", () => {
  for (const parse of [
    () => parseClientHandshakeInput("handshake"),
    () => parseChatRealtimeControlMessage({ type: "chat.session.unknown" }),
    () =>
      parseChatRealtimeSubscriptionRequest({
        type: "chat.subscribe",
        requestId: 1,
        streamId: "conversation-1",
      }),
    () =>
      parseChatRealtimeSubscriptionServerMessage({
        type: "chat.subscription.revoked",
        code: "access_denied",
        streamId: "conversation-1",
      }),
  ]) {
    assert.throws(parse, ChatRealtimeSessionParseError);
  }
});
