import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_REFRESH_REQUIRED_MESSAGE,
  ChatEventParseError,
  createServerHandshakeMetadata,
  decideRealtimeHandshake,
  parseChatEvent,
} from "../dist/index.js";

const tenantId = "tenant-1";
const validEvent = {
  eventId: "event-42",
  protocolVersion: 4,
  tenantId,
  streamId: "conversation-9",
  type: "message.created",
  occurredAt: "2026-08-25T20:00:00.000Z",
  payload: { messageId: "message-12" },
};

const metadata = createServerHandshakeMetadata({
  packageVersion: "1.1.3",
  protocolVersion: 4,
  schemaVersion: 9,
  enabledFeatures: {
    threads: true,
    reactions: true,
    huddles: false,
  },
});

test("parses a valid generic event envelope", () => {
  assert.deepEqual(parseChatEvent(validEvent, tenantId), validEvent);
});

test("rejects malformed event envelopes", () => {
  const malformedEvents = [
    null,
    [],
    { ...validEvent, eventId: "" },
    { ...validEvent, protocolVersion: 0 },
    { ...validEvent, occurredAt: "yesterday" },
    { ...validEvent, occurredAt: "2026-02-30T20:00:00.000Z" },
    { ...validEvent, occurredAt: "2026-08-25T24:00:00.000Z" },
    Object.fromEntries(
      Object.entries(validEvent).filter(([field]) => field !== "payload"),
    ),
  ];

  for (const malformedEvent of malformedEvents) {
    assert.throws(
      () => parseChatEvent(malformedEvent, tenantId),
      (error) =>
        error instanceof ChatEventParseError &&
        error.code === "malformed_event",
    );
  }
});

test("rejects an otherwise valid event from another tenant", () => {
  assert.throws(
    () =>
      parseChatEvent(
        { ...validEvent, tenantId: "tenant-from-untrusted-envelope" },
        tenantId,
      ),
    (error) =>
      error instanceof ChatEventParseError && error.code === "tenant_mismatch",
  );
});

test("accepts current and immediately previous protocol handshakes", () => {
  assert.deepEqual(metadata.supportedProtocolRange, {
    minimumVersion: 3,
    maximumVersion: 4,
  });

  for (const protocolVersion of [3, 4]) {
    assert.deepEqual(
      decideRealtimeHandshake(
        { clientPackageVersion: "1.1.2", protocolVersion },
        metadata,
      ),
      { state: "accepted", metadata },
    );
  }
});

test("requires refresh for protocols below and above the supported range", () => {
  for (const protocolVersion of [2, 5]) {
    assert.deepEqual(
      decideRealtimeHandshake(
        { clientPackageVersion: "1.0.0", protocolVersion },
        metadata,
      ),
      {
        state: "refresh_required",
        reason: "unsupported_protocol",
        message: CHAT_REFRESH_REQUIRED_MESSAGE,
        requestedProtocolVersion: protocolVersion,
        metadata,
      },
    );
  }
});

test("requires a snapshot when a compatible client's replay cursor expired", () => {
  const resumeFrom = { eventId: "event-12" };

  assert.deepEqual(
    decideRealtimeHandshake(
      { clientPackageVersion: "1.1.2", protocolVersion: 3, resumeFrom },
      metadata,
      "expired",
    ),
    {
      state: "snapshot_required",
      reason: "replay_expired",
      metadata,
      expiredCursor: resumeFrom,
    },
  );
});

test("uses typed snapshot reasons for unusable and overflowing cursors", () => {
  const handshake = {
    clientPackageVersion: "1.1.2",
    protocolVersion: 4,
    resumeFrom: { eventId: "opaque-cursor" },
  };

  for (const [status, reason] of [
    ["unavailable", "replay_unavailable"],
    ["incompatible", "replay_incompatible"],
    ["overflow", "replay_overflow"],
  ]) {
    assert.equal(
      decideRealtimeHandshake(handshake, metadata, status).reason,
      reason,
    );
  }
});

test("protocol incompatibility takes precedence over an expired replay cursor", () => {
  const decision = decideRealtimeHandshake(
    {
      clientPackageVersion: "1.0.0",
      protocolVersion: 2,
      resumeFrom: { eventId: "expired-event" },
    },
    metadata,
    "expired",
  );

  assert.equal(decision.state, "refresh_required");
});
