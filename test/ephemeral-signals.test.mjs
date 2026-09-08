import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatEventParseError,
  EphemeralSignalParseError,
  MAX_PRESENCE_SIGNAL_TTL_MS,
  MAX_TYPING_SIGNAL_TTL_MS,
  parseEphemeralSignalEvent,
} from "../dist/index.js";
import {
  EMPTY_EPHEMERAL_SIGNAL_STATE,
  expireEphemeralSignals,
  presenceSignalKey,
  reduceEphemeralSignal,
  typingSignalKey,
} from "../dist/client/index.js";
import {
  enabledEphemeralFeatures,
  presenceOnlineEvent,
  tenantId,
  typingStartEvent,
} from "./fixtures/ephemeral-signals.mjs";

const now = Date.parse("2026-08-25T20:00:01.000Z");
const parse = (event, overrides = {}) =>
  parseEphemeralSignalEvent(event, {
    expectedTenantId: tenantId,
    enabledFeatures: enabledEphemeralFeatures,
    now,
    ...overrides,
  });

test("parses typing start/stop and presence online/away/offline fixtures", () => {
  for (const state of ["start", "stop"]) {
    const event = {
      ...typingStartEvent,
      eventId: `typing-${state}`,
      payload: { ...typingStartEvent.payload, state },
    };
    assert.deepEqual(parse(event), event);
  }

  for (const state of ["online", "away", "offline"]) {
    const event = {
      ...presenceOnlineEvent,
      eventId: `presence-${state}`,
      payload: { ...presenceOnlineEvent.payload, state },
    };
    assert.deepEqual(parse(event), event);
  }
});

test("accepts restricted public typing scope", () => {
  const event = {
    ...typingStartEvent,
    payload: {
      ...typingStartEvent.payload,
      scope: {
        ...typingStartEvent.payload.scope,
        visibility: "public",
        audience: "active_participants",
      },
    },
  };
  assert.deepEqual(parse(event), event);
});

test("rejects malformed signal input and unknown fields", () => {
  const malformed = [
    { ...typingStartEvent, type: "typing.started" },
    {
      ...typingStartEvent,
      occurredAt: "2026-08-25T20:00:00.001Z",
    },
    {
      ...typingStartEvent,
      payload: {
        ...typingStartEvent.payload,
        sentAt: "2026-02-30T20:00:00.000Z",
      },
    },
    {
      ...typingStartEvent,
      payload: { ...typingStartEvent.payload, durability: "durable" },
    },
    {
      ...typingStartEvent,
      payload: { ...typingStartEvent.payload, unexpected: true },
    },
    { ...typingStartEvent, unexpected: true },
    {
      ...typingStartEvent,
      payload: { ...typingStartEvent.payload, sessionId: "" },
    },
  ];

  for (const event of malformed) {
    assert.throws(
      () => parse(event),
      (error) =>
        error instanceof EphemeralSignalParseError &&
        error.code === "malformed_signal",
    );
  }
});

test("rejects a signal from outside the trusted tenant", () => {
  assert.throws(
    () => parse({ ...typingStartEvent, tenantId: "tenant-2" }),
    (error) =>
      error instanceof ChatEventParseError && error.code === "tenant_mismatch",
  );
});

test("rejects invalid, expired, and overlong TTLs", () => {
  const cases = [
    {
      ...typingStartEvent,
      payload: {
        ...typingStartEvent.payload,
        expiresAt: typingStartEvent.payload.sentAt,
      },
    },
    {
      ...typingStartEvent,
      payload: {
        ...typingStartEvent.payload,
        expiresAt: new Date(
          Date.parse(typingStartEvent.payload.sentAt) - 1,
        ).toISOString(),
      },
    },
    {
      ...typingStartEvent,
      payload: {
        ...typingStartEvent.payload,
        expiresAt: new Date(
          Date.parse(typingStartEvent.payload.sentAt) +
            MAX_TYPING_SIGNAL_TTL_MS +
            1,
        ).toISOString(),
      },
    },
    {
      ...presenceOnlineEvent,
      payload: {
        ...presenceOnlineEvent.payload,
        expiresAt: new Date(
          Date.parse(presenceOnlineEvent.payload.sentAt) +
            MAX_PRESENCE_SIGNAL_TTL_MS +
            1,
        ).toISOString(),
      },
    },
  ];

  for (const event of cases) {
    assert.throws(
      () => parse(event),
      (error) =>
        error instanceof EphemeralSignalParseError &&
        error.code === "malformed_signal",
    );
  }

  assert.throws(
    () =>
      parse(typingStartEvent, {
        now: Date.parse(typingStartEvent.payload.expiresAt),
      }),
    (error) =>
      error instanceof EphemeralSignalParseError && error.code === "expired_signal",
  );
});

test("rejects invalid sequences and mismatched trusted accepted-session provenance", () => {
  for (const sequence of [0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    assert.throws(
      () => parse({
        ...typingStartEvent,
        payload: { ...typingStartEvent.payload, sequence },
      }),
      (error) =>
        error instanceof EphemeralSignalParseError &&
        error.code === "malformed_signal",
    );
  }

  const trustedAcceptedSessionIdentity = {
    actorUserId: typingStartEvent.payload.actorUserId,
    deviceId: typingStartEvent.payload.deviceId,
    sessionId: typingStartEvent.payload.sessionId,
  };
  assert.deepEqual(
    parse(typingStartEvent, { trustedAcceptedSessionIdentity }),
    typingStartEvent,
  );
  for (const mismatch of [
    { actorUserId: "user-other" },
    { deviceId: "device-other" },
    { sessionId: "session-other" },
  ]) {
    assert.throws(
      () => parse(typingStartEvent, {
        trustedAcceptedSessionIdentity: {
          ...trustedAcceptedSessionIdentity,
          ...mismatch,
        },
      }),
      (error) =>
        error instanceof EphemeralSignalParseError &&
        error.code === "identity_mismatch",
    );
  }
});

test("validates stream scope, privacy rules, and advertised capabilities", () => {
  const invalidScopes = [
    { ...typingStartEvent, streamId: "conversation-other" },
    {
      ...typingStartEvent,
      payload: {
        ...typingStartEvent.payload,
        scope: {
          ...typingStartEvent.payload.scope,
          visibility: "public",
          audience: "members",
        },
      },
    },
    {
      ...presenceOnlineEvent,
      streamId: "user:user-other",
    },
    {
      ...presenceOnlineEvent,
      payload: {
        ...presenceOnlineEvent.payload,
        scope: { type: "conversation", conversationId: "conversation-9" },
      },
    },
  ];

  for (const event of invalidScopes) {
    assert.throws(
      () => parse(event),
      (error) =>
        error instanceof EphemeralSignalParseError &&
        error.code === "malformed_signal",
    );
  }

  assert.throws(
    () =>
      parse(typingStartEvent, {
        enabledFeatures: { typing: false, presence: true },
      }),
    (error) =>
      error instanceof EphemeralSignalParseError &&
      error.code === "unsupported_capability",
  );

  assert.throws(
    () =>
      parse(presenceOnlineEvent, {
        enabledFeatures: { typing: true, presence: false },
      }),
    (error) =>
      error instanceof EphemeralSignalParseError &&
      error.code === "unsupported_capability",
  );
});

test("the reducer expires stale signals using the injected timestamp", () => {
  const typing = parse(typingStartEvent);
  const presence = parse(presenceOnlineEvent);
  let state = reduceEphemeralSignal(EMPTY_EPHEMERAL_SIGNAL_STATE, typing, now);
  state = reduceEphemeralSignal(state, presence, now);

  const afterTypingExpiry = expireEphemeralSignals(
    state,
    Date.parse(typing.payload.expiresAt),
  );
  assert.equal(afterTypingExpiry.typing[typingSignalKey(typing)], undefined);
  assert.equal(afterTypingExpiry.presence[presenceSignalKey(presence)], presence);

  const afterAllExpiry = expireEphemeralSignals(
    afterTypingExpiry,
    Date.parse(presence.payload.expiresAt),
  );
  assert.deepEqual(afterAllExpiry, EMPTY_EPHEMERAL_SIGNAL_STATE);
});

test("an older update cannot replace accepted actor/device/session state", () => {
  const accepted = parse({
    ...typingStartEvent,
    eventId: "newer-start",
    occurredAt: "2026-08-25T20:00:05.000Z",
    payload: {
      ...typingStartEvent.payload,
      sentAt: "2026-08-25T20:00:05.000Z",
      expiresAt: "2026-08-25T20:00:15.000Z",
    },
  });
  const older = parse({
    ...typingStartEvent,
    eventId: "older-stop",
    occurredAt: "2026-08-25T20:00:04.000Z",
    payload: {
      ...typingStartEvent.payload,
      state: "stop",
      sentAt: "2026-08-25T20:00:04.000Z",
      expiresAt: "2026-08-25T20:00:14.000Z",
    },
  });
  const state = reduceEphemeralSignal(EMPTY_EPHEMERAL_SIGNAL_STATE, accepted, now);
  const reduced = reduceEphemeralSignal(state, older, now);

  assert.equal(reduced.typing[typingSignalKey(accepted)], accepted);
});

test("presence ordering uses the same actor/device/session rule", () => {
  const accepted = parse({
    ...presenceOnlineEvent,
    eventId: "newer-away",
    occurredAt: "2026-08-25T20:00:05.000Z",
    payload: {
      ...presenceOnlineEvent.payload,
      state: "away",
      sentAt: "2026-08-25T20:00:05.000Z",
      expiresAt: "2026-08-25T20:01:05.000Z",
    },
  });
  const older = parse({
    ...presenceOnlineEvent,
    eventId: "older-offline",
    occurredAt: "2026-08-25T20:00:04.000Z",
    payload: {
      ...presenceOnlineEvent.payload,
      state: "offline",
      sentAt: "2026-08-25T20:00:04.000Z",
      expiresAt: "2026-08-25T20:01:04.000Z",
    },
  });
  const state = reduceEphemeralSignal(
    EMPTY_EPHEMERAL_SIGNAL_STATE,
    accepted,
    now,
  );
  const reduced = reduceEphemeralSignal(state, older, now);

  assert.equal(reduced.presence[presenceSignalKey(accepted)], accepted);
});

test("an already-expired reducer input is discarded", () => {
  const event = parse(typingStartEvent);
  assert.deepEqual(
    reduceEphemeralSignal(
      EMPTY_EPHEMERAL_SIGNAL_STATE,
      event,
      Date.parse(event.payload.expiresAt),
    ),
    EMPTY_EPHEMERAL_SIGNAL_STATE,
  );
});
