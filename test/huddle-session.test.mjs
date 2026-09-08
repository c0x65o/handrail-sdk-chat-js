import assert from "node:assert/strict";
import test from "node:test";

import {
  HuddleContractError,
  MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES,
  isAllowedHuddleLifecycleTransition,
  parseHuddleCommandInput,
  parseHuddleCommandResult,
  parseHuddleMediaJoinDescriptor,
  parseHuddleSessionState,
  validateHuddleStateTransition,
} from "../dist/index.js";
import {
  activeAliceHuddle,
  activeBothHuddle,
  bobLeftHuddle,
  clearShareInput,
  endInput,
  endedAt,
  endedHuddle,
  fixtureNow,
  inactiveHuddle,
  joinInput,
  leaveInput,
  mediaJoin,
  setShareInput,
  sharingHuddle,
  startInput,
  startedAt,
  startingHuddle,
  successfulResult,
} from "./fixtures/huddle-sessions.mjs";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const parseError = (code) =>
  (error) => error instanceof HuddleContractError && error.code === code;

test("all retry-safe command fixtures survive strict JSON parsing", () => {
  for (const input of [
    startInput,
    joinInput,
    leaveInput,
    setShareInput,
    clearShareInput,
    endInput,
  ]) {
    assert.deepEqual(parseHuddleCommandInput(roundTrip(input)), input);
  }
});

test("commands require bounded nonblank idempotency keys and exact fields", () => {
  const { idempotencyKey: _key, ...missingKey } = startInput;
  for (const input of [
    missingKey,
    { ...startInput, idempotencyKey: " \n" },
    {
      ...startInput,
      idempotencyKey: "x".repeat(MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES + 1),
    },
    { ...startInput, unexpected: true },
    { ...setShareInput, intent: "toggle" },
    { ...joinInput, operation: "start_huddle" },
  ]) {
    assert.throws(() => parseHuddleCommandInput(input), parseError("malformed_input"));
  }
});

test("caller identity, authorization, capabilities, and provider material are rejected recursively", () => {
  const trustedFields = [
    ["tenant-id", "tenant-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["roles", ["admin"]],
    ["capabilities", ["huddle.start"]],
    ["authorization", "Bearer spoof"],
  ];
  const providerFields = [
    ["provider", "vendor"],
    ["media-provider-id", "provider-room"],
    ["credentials", { password: "secret" }],
    ["roomToken", "raw-room-token"],
    ["api_key", "raw-api-key"],
    ["providerConfiguration", { host: "internal" }],
  ];
  for (const [field, value] of trustedFields) {
    assert.throws(
      () => parseHuddleCommandInput({ ...startInput, nested: { [field]: value } }),
      parseError("trusted_context_field"),
      field,
    );
  }
  for (const [field, value] of providerFields) {
    assert.throws(
      () => parseHuddleCommandInput({ ...startInput, nested: { [field]: value } }),
      parseError("provider_field"),
      field,
    );
  }
});

test("inactive, starting, active, participant-left, and ended states round trip", () => {
  for (const state of [
    inactiveHuddle,
    startingHuddle,
    activeAliceHuddle,
    bobLeftHuddle,
    endedHuddle,
  ]) {
    assert.deepEqual(parseHuddleSessionState(roundTrip(state)), state);
  }
});

test("lifecycle transition table allows only canonical forward and in-state edges", () => {
  const statuses = ["inactive", "starting", "active", "ended"];
  const allowed = new Set([
    "inactive:inactive",
    "inactive:starting",
    "starting:starting",
    "starting:active",
    "starting:ended",
    "active:active",
    "active:ended",
    "ended:ended",
  ]);
  for (const from of statuses) {
    for (const to of statuses) {
      assert.equal(
        isAllowedHuddleLifecycleTransition(from, to),
        allowed.has(`${from}:${to}`),
        `${from} -> ${to}`,
      );
    }
  }
});

test("validates start, join, rejoin, leave, share set/clear, and end deltas", () => {
  assert.deepEqual(
    validateHuddleStateTransition(inactiveHuddle, startingHuddle, startInput),
    startingHuddle,
  );
  assert.deepEqual(
    validateHuddleStateTransition(startingHuddle, activeAliceHuddle, joinInput),
    activeAliceHuddle,
  );
  assert.deepEqual(
    validateHuddleStateTransition(activeAliceHuddle, activeBothHuddle, joinInput),
    activeBothHuddle,
  );
  assert.deepEqual(
    validateHuddleStateTransition(activeBothHuddle, sharingHuddle, setShareInput),
    sharingHuddle,
  );
  assert.deepEqual(
    validateHuddleStateTransition(sharingHuddle, activeBothHuddle, clearShareInput),
    activeBothHuddle,
  );
  assert.deepEqual(
    validateHuddleStateTransition(sharingHuddle, bobLeftHuddle, leaveInput),
    bobLeftHuddle,
  );
  assert.deepEqual(
    validateHuddleStateTransition(activeBothHuddle, endedHuddle, endInput),
    endedHuddle,
  );
  const endedBeforeActivation = {
    ...endedHuddle,
    participants: [],
    endedAt: "2026-08-25T20:00:15.000Z",
  };
  assert.deepEqual(
    validateHuddleStateTransition(startingHuddle, endedBeforeActivation, endInput),
    endedBeforeActivation,
  );
});

test("rejects incoherent participant timestamps, duplicates, ended metadata, and screen ownership", () => {
  const joinedAlice = activeAliceHuddle.participants[0];
  for (const state of [
    { ...activeAliceHuddle, endedAt },
    { ...endedHuddle, screenShareOwnerUserId: "user-alice" },
    { ...endedHuddle, participants: [joinedAlice] },
    { ...activeAliceHuddle, screenShareOwnerUserId: "user-bob" },
    { ...activeAliceHuddle, participants: [joinedAlice, joinedAlice] },
    {
      ...bobLeftHuddle,
      participants: [{ ...bobLeftHuddle.participants[1], leftAt: startedAt }],
    },
    {
      ...activeAliceHuddle,
      participants: [{ ...joinedAlice, joinedAt: "2026-08-25T19:59:59.000Z" }],
    },
    {
      ...endedHuddle,
      participants: [
        {
          ...endedHuddle.participants[0],
          joinedAt: "2026-08-25T19:59:59.000Z",
        },
      ],
    },
  ]) {
    assert.throws(
      () => parseHuddleSessionState(state),
      (error) =>
        error instanceof HuddleContractError &&
        (error.code === "malformed_state" || error.code === "incoherent_state"),
    );
  }
});

test("rejects invalid participant and ownership transitions", () => {
  for (const [before, after, input] of [
    [startingHuddle, activeBothHuddle, joinInput],
    [activeBothHuddle, activeAliceHuddle, leaveInput],
    [activeBothHuddle, sharingHuddle, clearShareInput],
    [sharingHuddle, bobLeftHuddle, setShareInput],
    [
      activeAliceHuddle,
      { ...activeBothHuddle, screenShareOwnerUserId: "user-bob" },
      joinInput,
    ],
    [
      activeBothHuddle,
      { ...endedHuddle, participants: endedHuddle.participants.slice(0, 1) },
      endInput,
    ],
    [endedHuddle, startingHuddle, startInput],
  ]) {
    assert.throws(
      () => validateHuddleStateTransition(before, after, input),
      parseError("invalid_transition"),
    );
  }
});

test("opaque media descriptors enforce exact public shape and short expiry", () => {
  assert.deepEqual(
    parseHuddleMediaJoinDescriptor(roundTrip(mediaJoin), { now: fixtureNow }),
    mediaJoin,
  );
  for (const [descriptor, code] of [
    [{ ...mediaJoin, expiresAt: fixtureNow }, "expired_descriptor"],
    [
      { ...mediaJoin, expiresAt: "2026-08-25T20:05:00.001Z" },
      "malformed_descriptor",
    ],
    [{ ...mediaJoin, provider: "vendor" }, "malformed_descriptor"],
    [{ ...mediaJoin, roomToken: "raw-provider-token" }, "malformed_descriptor"],
    [{ ...mediaJoin, descriptor: " " }, "malformed_descriptor"],
  ]) {
    assert.throws(
      () => parseHuddleMediaJoinDescriptor(descriptor, { now: fixtureNow }),
      parseError(code),
    );
  }
});

test("canonical active-session start and join results round trip", () => {
  const startResult = successfulResult(startInput, startingHuddle, { mediaJoin });
  const joinResult = successfulResult(joinInput, activeAliceHuddle, { mediaJoin });
  assert.deepEqual(
    parseHuddleCommandResult(roundTrip(startResult), startInput, {
      now: fixtureNow,
      previousState: inactiveHuddle,
    }),
    startResult,
  );
  assert.deepEqual(
    parseHuddleCommandResult(roundTrip(joinResult), joinInput, {
      now: fixtureNow,
      previousState: startingHuddle,
    }),
    joinResult,
  );
});

test("leave, screen-share set/clear, and end results match their operation transitions", () => {
  const cases = [
    [leaveInput, sharingHuddle, bobLeftHuddle],
    [setShareInput, activeBothHuddle, sharingHuddle],
    [clearShareInput, sharingHuddle, activeBothHuddle],
    [endInput, activeBothHuddle, endedHuddle],
  ];
  for (const [input, previousState, state] of cases) {
    const result = successfulResult(input, state);
    assert.deepEqual(
      parseHuddleCommandResult(roundTrip(result), input, { previousState }),
      result,
    );
  }
});

test("feature-disabled results are typed, state-preserving, and round trip", () => {
  const disabled = {
    operation: "start_huddle",
    outcome: "feature_disabled",
    reconciliationStatus: "applied",
    feature: "huddles",
    reason: "media_unavailable",
    state: inactiveHuddle,
  };
  assert.deepEqual(
    parseHuddleCommandResult(roundTrip(disabled), startInput, {
      previousState: inactiveHuddle,
    }),
    disabled,
  );
  assert.throws(
    () => parseHuddleCommandResult({ ...disabled, operation: "end_huddle" }, endInput),
    parseError("incoherent_result"),
  );
});

test("result operation and state discriminants must match the command", () => {
  const startResult = successfulResult(startInput, startingHuddle, { mediaJoin });
  for (const invalid of [
    { ...startResult, operation: "join_huddle" },
    { ...startResult, state: activeAliceHuddle },
    { ...startResult, state: { ...startingHuddle, conversationId: "other" } },
    { ...startResult, providerConfiguration: { apiKey: "secret" } },
  ]) {
    assert.throws(
      () => parseHuddleCommandResult(invalid, startInput, { now: fixtureNow }),
      (error) => error instanceof HuddleContractError,
    );
  }
});

test("idempotent replay validation preserves the original canonical state", () => {
  const original = successfulResult(joinInput, activeAliceHuddle, { mediaJoin });
  const replayed = { ...original, reconciliationStatus: "replayed" };
  assert.deepEqual(
    parseHuddleCommandResult(replayed, joinInput, {
      now: fixtureNow,
      replayOf: original,
    }),
    replayed,
  );
  assert.throws(
    () =>
      parseHuddleCommandResult(
        { ...replayed, state: { ...activeAliceHuddle, screenShareOwnerUserId: "user-alice" } },
        joinInput,
        { now: fixtureNow, replayOf: original },
      ),
    parseError("replay_mismatch"),
  );
  assert.throws(
    () => validateHuddleStateTransition(startingHuddle, activeAliceHuddle, joinInput, "replayed"),
    parseError("replay_mismatch"),
  );
});
